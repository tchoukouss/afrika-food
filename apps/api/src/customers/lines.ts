import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DocumentLineKind, EventType, Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { AuthUser } from '../auth/decorators';
import { currentPrices } from '../restaurant/common';
import { Db, Tx } from '../prisma/prisma.service';
import { roundXof } from '../sales/common';
import { D } from '../stock/common';

export const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);
const MAX_AMOUNT = 1_000_000_000_000;

/** Ligne : produit du catalogue (prix figé au prix en vigueur) ou frais du module 7 (décision D8). */
export class DocumentLineDto {
  @IsEnum(DocumentLineKind) kind: DocumentLineKind;
  @ValidateIf((l) => l.kind === 'PRODUCT') @IsUUID() productId?: string;
  /** Produit fabriqué seulement : fabriqué à la demande (ordre de production du module 4) au lieu d'être pris en stock. */
  @IsOptional() @IsBoolean() madeToOrder?: boolean;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e6) quantity: number;
  /** Frais seulement : libellé, prix TTC et taux de TVA saisis. */
  @ValidateIf((l) => l.kind === 'FEE') @Transform(trim) @IsString() @MinLength(2) @MaxLength(150) label?: string;
  @ValidateIf((l) => l.kind === 'FEE') @IsInt() @Min(0) @Max(MAX_AMOUNT) unitPrice?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) taxRate?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) note?: string | null;
}

/** Détails d'une commande événementielle (décision D10). */
export class EventDto {
  @IsEnum(EventType) eventType: EventType;
  @IsDateString() eventDate: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(300) venue?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(100000) guests?: number | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(120) contactName?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(30) contactPhone?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

export interface PricedDocumentLine {
  position: number;
  kind: DocumentLineKind;
  productId: string | null;
  productCode: string | null;
  label: string;
  quantity: Prisma.Decimal;
  unitPrice: bigint;
  taxRate: Prisma.Decimal;
  lineTotal: bigint;
  taxAmount: bigint;
  note: string | null;
  madeToOrder: boolean;
}

/** TVA incluse dans un montant TTC (même calcul que la caisse du module 5). */
export const taxIncluded = (amount: bigint, rate: Prisma.Decimal) => (rate.gt(0) ? roundXof(D(amount.toString()).mul(rate).div(D(100).add(rate))) : 0n);

/**
 * Chiffre les lignes : prix TTC en vigueur dans l'établissement (exception
 * locale, sinon prix de base) et taux de TVA du produit, figés dans le
 * document ; frais au prix et au taux saisis, sans stock.
 */
export async function priceLines(db: Db, me: AuthUser, establishmentId: string, lines: DocumentLineDto[]) {
  const ids = [...new Set(lines.filter((l) => l.kind === 'PRODUCT').map((l) => l.productId!))];
  const [products, prices] = await Promise.all([
    db.product.findMany({ where: { id: { in: ids }, companyId: me.companyId } }),
    currentPrices(db, ids, establishmentId),
  ]);
  const priced: PricedDocumentLine[] = lines.map((l, position) => {
    const quantity = D(l.quantity);
    if (l.kind === 'FEE') {
      const unitPrice = BigInt(l.unitPrice!);
      const taxRate = D(l.taxRate ?? 0);
      const lineTotal = roundXof(D(unitPrice.toString()).mul(quantity));
      if (l.madeToOrder) throw new BadRequestException('Des frais ne se fabriquent pas');
      return { position, kind: l.kind, productId: null, productCode: null, label: l.label!, quantity, unitPrice, taxRate, lineTotal, taxAmount: taxIncluded(lineTotal, taxRate), note: l.note ?? null, madeToOrder: false };
    }
    if (l.unitPrice !== undefined || l.taxRate !== undefined || l.label !== undefined) {
      throw new BadRequestException('Prix, TVA et libellé d’un produit viennent du catalogue');
    }
    const p = products.find((x) => x.id === l.productId);
    if (!p) throw new BadRequestException('Produit invalide');
    if (!p.isActive) throw new BadRequestException(`« ${p.name} » est archivé`);
    if (l.madeToOrder && p.type !== 'MANUFACTURED') throw new BadRequestException(`« ${p.name} » n’est pas un produit fabriqué : il ne se fabrique pas à la demande`);
    const unitPrice = prices.get(p.id);
    if (unitPrice === undefined) throw new ConflictException(`« ${p.name} » n’a pas de prix de vente`);
    const taxRate = D(p.taxRate);
    const lineTotal = roundXof(D(unitPrice.toString()).mul(quantity));
    return { position, kind: l.kind, productId: p.id, productCode: p.code, label: p.name, quantity, unitPrice, taxRate, lineTotal, taxAmount: taxIncluded(lineTotal, taxRate), note: l.note ?? null, madeToOrder: !!l.madeToOrder };
  });
  return { lines: priced, total: priced.reduce((s, l) => s + l.lineTotal, 0n), taxTotal: priced.reduce((s, l) => s + l.taxAmount, 0n) };
}

/**
 * Catégorie actuelle des produits, à figer sur une ligne au moment de sa
 * création (historique des ventes, module 8) ; jamais relue ensuite.
 */
export async function categorySnapshots(db: Db, productIds: (string | null)[]) {
  const ids = [...new Set(productIds.filter((x): x is string => !!x))];
  const rows = ids.length ? await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, category: { select: { id: true, name: true } } } }) : [];
  const map = new Map(rows.map((r) => [r.id, { categoryId: r.category?.id ?? null, categoryName: r.category?.name ?? null }]));
  return (productId: string | null) => (productId ? map.get(productId) : undefined) ?? { categoryId: null, categoryName: null };
}

/** Un événement s'accompagne de ses détails, une commande normale n'en a pas. */
export function checkEvent(kind: string, event: EventDto | null | undefined) {
  if (kind === 'EVENT' && !event) throw new BadRequestException('Détails de l’événement obligatoires');
  if (kind !== 'EVENT' && event) throw new BadRequestException('Seule une commande événementielle a des détails d’événement');
}

// --- Droits ---------------------------------------------------------------------------

/** Lecture : « Gérer les commandes clients » ou « Voir les clients » dans l'établissement. */
export const READ = ['customer_orders.manage', 'customers.view'];
export const WRITE = 'customer_orders.manage';

export function canRead(me: AuthUser, establishmentId: string) {
  return me.access.canAccessEstablishment(establishmentId) && READ.some((p) => me.access.can(p, establishmentId));
}

export function assertWrite(me: AuthUser, establishmentId: string) {
  if (!me.access.canAccessEstablishment(establishmentId) || !me.access.can(WRITE, establishmentId)) {
    throw new ForbiddenException("Vous n'avez pas cette permission pour cet établissement");
  }
}

/** Établissements lisibles : celui de l'en-tête, sinon tous ceux où une permission de lecture est détenue. */
export function readable(me: AuthUser, requested?: string) {
  const ids = new Set<string>();
  for (const p of READ) me.access.establishmentsWith(p).forEach((x) => ids.add(x));
  const scope = requested ?? me.establishmentId;
  if (scope) return ids.has(scope) ? [scope] : [];
  return [...ids];
}

/** Client actif de l'entreprise (fichier commun au groupe, décision D9). */
export async function activeCustomer(db: Db, me: AuthUser, customerId: string) {
  const c = await db.customer.findFirst({ where: { id: customerId, companyId: me.companyId } });
  if (!c) throw new NotFoundException('Client introuvable');
  if (!c.isActive) throw new ConflictException(`Client « ${c.name} » désactivé`);
  return c;
}

export async function lockRowOf(tx: Tx, table: 'quotes' | 'customer_orders', id: string) {
  await tx.$queryRaw`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}::uuid FOR UPDATE`;
}

/** Date du jour (AAAA-MM-JJ) à Abidjan (UTC+0). */
export const todayISO = () => new Date().toISOString().slice(0, 10);
