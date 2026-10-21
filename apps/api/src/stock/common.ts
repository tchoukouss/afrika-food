import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsOptional, IsUUID } from 'class-validator';
import { AuthUser } from '../auth/decorators';
import { Db, Tx } from '../prisma/prisma.service';

export const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
export const ZERO = D(0);

/** Date du jour (AAAA-MM-JJ) à Abidjan (UTC+0). */
export const todayISO = () => new Date().toISOString().slice(0, 10);
export const dateOnly = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
export const isExpired = (expiry: Date | null) => !!expiry && expiry.toISOString().slice(0, 10) < todayISO();

/** Article de stock : matière première OU produit (jamais les deux). */
export interface ItemRef {
  rawMaterialId: string | null;
  productId: string | null;
}

export class ItemDto {
  @IsOptional() @IsUUID() rawMaterialId?: string | null;
  @IsOptional() @IsUUID() productId?: string | null;
}

export function itemOf(dto: { rawMaterialId?: string | null; productId?: string | null }): ItemRef {
  if (!!dto.rawMaterialId === !!dto.productId) {
    throw new BadRequestException('Indiquer soit une matière première, soit un produit');
  }
  return { rawMaterialId: dto.rawMaterialId ?? null, productId: dto.productId ?? null };
}

export const itemWhere = (item: ItemRef) => (item.rawMaterialId ? { rawMaterialId: item.rawMaterialId } : { productId: item.productId! });
export const itemKey = (item: ItemRef) => item.rawMaterialId ?? item.productId!;

export interface ItemInfo {
  id: string;
  kind: 'RAW_MATERIAL' | 'PRODUCT';
  code: string;
  name: string;
  unit: string;
  isPerishable: boolean;
  isActive: boolean;
  productType?: string;
}

/**
 * Charge un article stockable de l'entreprise : matière première, ou produit
 * revendu / fabriqué (un menu n'a pas de stock propre).
 */
export async function loadItem(db: Db, companyId: string, item: ItemRef, opts: { purchasable?: boolean } = {}): Promise<ItemInfo> {
  if (item.rawMaterialId) {
    const m = await db.rawMaterial.findFirst({ where: { id: item.rawMaterialId, companyId } });
    if (!m) throw new BadRequestException('Matière première invalide');
    return { id: m.id, kind: 'RAW_MATERIAL', code: m.code, name: m.name, unit: m.baseUnitCode, isPerishable: m.isPerishable, isActive: m.isActive };
  }
  const p = await db.product.findFirst({ where: { id: item.productId!, companyId } });
  if (!p) throw new BadRequestException('Produit invalide');
  if (p.type === 'MENU') throw new BadRequestException('Un menu n’a pas de stock propre');
  if (opts.purchasable && p.type !== 'RESOLD') throw new BadRequestException(`« ${p.name} » n’est pas un produit revendu : il ne s’achète pas`);
  return { id: p.id, kind: 'PRODUCT', code: p.code, name: p.name, unit: p.saleUnitCode, isPerishable: false, isActive: p.isActive, productType: p.type };
}

/** Ajoute `item` (code, nom, unité) à chaque ligne portant rawMaterialId / productId. */
export async function attachItems<T extends { rawMaterialId: string | null; productId: string | null }>(db: Db, rows: T[]) {
  const rawIds = [...new Set(rows.map((r) => r.rawMaterialId).filter((x): x is string => !!x))];
  const productIds = [...new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))];
  const [raws, products] = await Promise.all([
    rawIds.length ? db.rawMaterial.findMany({ where: { id: { in: rawIds } }, select: { id: true, code: true, name: true, baseUnitCode: true } }) : [],
    productIds.length ? db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, code: true, name: true, saleUnitCode: true } }) : [],
  ]);
  const map = new Map<string, { id: string; code: string; name: string; unit: string }>();
  raws.forEach((r) => map.set(r.id, { id: r.id, code: r.code, name: r.name, unit: r.baseUnitCode }));
  products.forEach((p) => map.set(p.id, { id: p.id, code: p.code, name: p.name, unit: p.saleUnitCode }));
  return rows.map((r) => ({ ...r, item: map.get(r.rawMaterialId ?? r.productId ?? '') ?? null }));
}

/** Noms des utilisateurs (sans exposer d'autres données). */
export async function userNames(db: Db, companyId: string, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, string>();
  const users = await db.user.findMany({ where: { id: { in: unique }, companyId }, select: { id: true, fullName: true } });
  return new Map(users.map((u) => [u.id, u.fullName]));
}

/** Établissement de l'entreprise, accessible, où l'utilisateur détient la permission. */
export async function establishmentFor(db: Db, me: AuthUser, establishmentId: string, permission: string) {
  const est = await db.establishment.findFirst({ where: { id: establishmentId, companyId: me.companyId, deletedAt: null } });
  if (!est) throw new BadRequestException('Établissement invalide');
  if (!me.access.canAccessEstablishment(establishmentId) || !me.access.can(permission, establishmentId)) {
    throw new ForbiddenException("Vous n'avez pas cette permission pour cet établissement");
  }
  return est;
}

/**
 * Établissements consultables pour une permission : celui de l'en-tête
 * X-Establishment-Id, sinon tous ceux où l'utilisateur la détient.
 */
export function readableEstablishments(me: AuthUser, permission: string): string[] {
  if (me.establishmentId) return me.access.can(permission, me.establishmentId) ? [me.establishmentId] : [];
  return me.access.establishmentsWith(permission);
}

type LockableTable =
  | 'stock_locations'
  | 'purchase_requests'
  | 'purchase_orders'
  | 'goods_receipts'
  | 'supplier_invoices'
  | 'supplier_payments'
  | 'suppliers'
  | 'inventory_sessions'
  | 'stock_adjustments'
  | 'stock_transfers'
  | 'stock_lots';

export async function lockRow(tx: Tx, table: LockableTable, id: string) {
  await tx.$queryRaw`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}::uuid FOR UPDATE`;
}

/** Préfixes des documents du module 3 (même table de compteurs que le module 1). */
export const DOC = {
  PURCHASE_REQUEST: 'DA',
  PURCHASE_ORDER: 'BCF',
  GOODS_RECEIPT: 'REC',
  SUPPLIER_INVOICE: 'FF',
  SUPPLIER_PAYMENT: 'PF',
  SUPPLIER_RETURN: 'RTF',
  SUPPLIER_CREDIT_NOTE: 'AVF',
  INVENTORY: 'INV',
  STOCK_ADJUSTMENT: 'COR',
  STOCK_LOSS: 'PER',
  LOCATION_MOVE: 'DEP',
  TRANSFER: 'TRF',
  LOT: 'LOT',
} as const;

/**
 * Numéro de document unique, ex. « PLT-BCF-2026-000012 » (ou « LOT-2026-000431 »
 * pour une numérotation entreprise). Incrément atomique dans la transaction :
 * pas de doublon entre postes, pas de trou en cas d'annulation.
 */
export async function nextNumber(tx: Tx, companyId: string, docType: keyof typeof DOC, establishment?: { id: string; code: string }) {
  const year = new Date().getUTCFullYear();
  const scope = establishment?.id ?? 'GLOBAL';
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO document_sequences (company_id, scope_key, doc_type, year, last_value, updated_at)
    VALUES (${companyId}::uuid, ${scope}, ${docType}, ${year}, 1, now())
    ON CONFLICT (company_id, scope_key, doc_type, year)
    DO UPDATE SET last_value = document_sequences.last_value + 1, updated_at = now()
    RETURNING last_value`;
  return [establishment?.code, DOC[docType], String(year), String(rows[0].last_value).padStart(6, '0')].filter(Boolean).join('-');
}

/** Champ commun aux créations : identifiant unique généré par le formulaire. */
export class IdempotentDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
}

/**
 * Création idempotente (double clic, renvoi après coupure réseau) :
 * - si un document a déjà été créé avec cet identifiant, il est renvoyé tel quel ;
 * - si deux envois identiques arrivent en même temps, l'index unique
 *   (company_id, client_request_id) n'en laisse passer qu'un : l'autre échoue,
 *   puis renvoie le document créé par le premier.
 * Un identifiant ne peut être rejoué que par l'utilisateur qui l'a utilisé.
 */
export async function idempotent<T>(
  me: AuthUser,
  key: string | undefined,
  findExisting: () => Promise<{ id: string; ownerId: string } | null>,
  create: () => Promise<T>,
  replay: (id: string) => Promise<unknown>,
): Promise<T | unknown> {
  const replayIfExists = async () => {
    const existing = await findExisting();
    if (!existing) return null;
    if (existing.ownerId !== me.userId) throw new ConflictException('Identifiant de requête déjà utilisé');
    return { value: await replay(existing.id) };
  };
  if (key) {
    const done = await replayIfExists();
    if (done) return done.value;
  }
  try {
    return await create();
  } catch (e) {
    if (key) {
      const done = await replayIfExists();
      if (done) return done.value;
    }
    throw e;
  }
}
