import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PaymentMethod, PrintJob, PrintJobKind, Prisma, ReturnDisposition, Sale, SaleStatus, StockLot } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { ProductionService } from '../production/production';
import { SequenceService } from '../sequences/sequence.service';
import { D, idempotent, nextNumber, readableEstablishments, userNames } from '../stock/common';
import { MovementContext, StockEngine } from '../stock/engine';
import { assertCan, big, emptyToNull, establishmentsWithAny, lockSalesRow, METHOD_LABELS, nextSalesNumber, providerFor, QTY, roundXof, trim } from './common';
import { columnsFor, escPos, NetworkPrinter, renderTicket, TicketData } from './printer';
import { expectedByMethod } from './sessions';

const MAX_AMOUNT = 1_000_000_000;

export class SaleLineDto {
  @IsUUID() productId: string;
  @IsNumber(QTY) @Min(0.0001) @Max(1e6) quantity: number;
  /** Remise sur la ligne : en pourcentage OU en montant (décision 8). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100) discountPercent?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_AMOUNT) discountAmount?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) discountReason?: string | null;
}

export class PaymentDto {
  @IsEnum(PaymentMethod) method: PaymentMethod;
  /** Montant remis avec ce moyen (espèces : avant rendu de monnaie). */
  @IsInt() @Min(1) @Max(MAX_AMOUNT) amount: number;
  /** Référence de la transaction (mobile money, virement, chèque…). */
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(100) reference?: string | null;
}

export class CreateSaleDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() sessionId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SaleLineDto) lines: SaleLineDto[];
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100) ticketDiscountPercent?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_AMOUNT) ticketDiscountAmount?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) ticketDiscountReason?: string | null;
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PaymentDto) payments: PaymentDto[];
}

export class CancelSaleDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class RefundLineDto {
  @IsUUID() saleItemId: string;
  @IsNumber(QTY) @Min(0.0001) @Max(1e6) quantity: number;
  /** Produit remis en stock (intact) ou sorti en perte « retour client ». */
  @IsEnum(ReturnDisposition) disposition: ReturnDisposition;
}

export class RefundPaymentDto {
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsInt() @Min(1) @Max(MAX_AMOUNT) amount: number;
}

export class RefundSaleDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  /** Session ouverte du caissier qui rend l'argent. */
  @IsUUID() sessionId: string;
  /** Moyen unique de remboursement (espèces par défaut)… */
  @IsOptional() @IsEnum(PaymentMethod) method?: PaymentMethod;
  /** …ou répartition entre plusieurs moyens, dont la somme égale le montant remboursé. */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => RefundPaymentDto) refunds?: RefundPaymentDto[];
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RefundLineDto) lines: RefundLineDto[];
}

class SaleQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() sessionId?: string;
  @IsOptional() @IsEnum(SaleStatus) status?: SaleStatus;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) number?: string;
}

class LotNumberQuery {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(40) lotNumber: string;
}

/** Ligne de vente calculée (prix TTC, remises, TVA incluse). */
interface PricedLine {
  productId: string;
  productCode: string;
  productName: string;
  isMenu: boolean;
  quantity: Prisma.Decimal;
  unitPrice: bigint;
  grossAmount: bigint;
  discountPercent: Prisma.Decimal | null;
  lineDiscount: bigint;
  discountReason: string | null;
  ticketDiscount: bigint;
  lineTotal: bigint;
  taxRate: Prisma.Decimal;
  taxAmount: bigint;
  /** Articles réellement sortis du stock : le produit, ou les composants d'un menu (décision 4). */
  parts: { productId: string; name: string; quantity: Prisma.Decimal }[];
  /** Coût réel déjà connu : articles sortis du stock avant l'encaissement (restaurant, module 6). */
  presetCost?: Prisma.Decimal;
}

type Priced = Awaited<ReturnType<SalesService['finishPricing']>>;

/**
 * Ligne d'une addition du restaurant (module 6) : prix figé à la commande et
 * stock déjà sorti à l'envoi en cuisine. Réservé à l'appel interne : le
 * formulaire de caisse ne peut jamais fournir un prix (décision 9).
 */
export interface PresetSaleLine {
  productId: string;
  productCode: string;
  productName: string;
  isMenu: boolean;
  quantity: Prisma.Decimal;
  unitPrice: bigint;
  taxRate: Prisma.Decimal;
  costTotal: Prisma.Decimal;
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string | null;
}

export interface PresetSaleInput {
  sessionId: string;
  clientRequestId?: string;
  lines: PresetSaleLine[];
  ticketDiscountPercent?: number;
  ticketDiscountAmount?: number;
  ticketDiscountReason?: string | null;
  payments: PaymentDto[];
  /** Mention imprimée sur le ticket, ex. « Commande PLT-RST-2026-000004 — Table 12 ». */
  reference: string;
  /** Exécuté dans la transaction de la vente (ex. marquer l'addition payée). */
  inTransaction: (tx: Tx, saleId: string) => Promise<void>;
}

/** Appelé dans la transaction d'annulation d'une vente (module 6 : rouvrir l'addition). */
export type SaleCancelHook = (tx: Tx, me: AuthUser, sale: Sale) => Promise<void>;

const discountOf = (base: bigint, percent?: number, amount?: number) => {
  if (percent !== undefined && amount !== undefined) throw new BadRequestException('Remise : indiquer un pourcentage OU un montant');
  if (percent !== undefined) return { value: roundXof(big(base).mul(percent).div(100)), percent: D(percent) };
  if (amount !== undefined) return { value: BigInt(amount), percent: null };
  return { value: 0n, percent: null };
};

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
    private readonly sequences: SequenceService,
    private readonly printer: NetworkPrinter,
    private readonly production: ProductionService,
  ) {}

  private readonly ticketReferences: ((saleId: string) => Promise<string | null>)[] = [];
  private readonly cancelHooks: SaleCancelHook[] = [];

  /** Mention ajoutée au ticket d'une vente (ex. numéro de commande restaurant). */
  registerTicketReference(resolver: (saleId: string) => Promise<string | null>) {
    this.ticketReferences.push(resolver);
  }

  registerCancelHook(hook: SaleCancelHook) {
    this.cancelHooks.push(hook);
  }

  // --- Calcul du ticket --------------------------------------------------------------

  /**
   * Prix en vigueur (exception de l'établissement, sinon prix de base), remises
   * de ligne puis remise ticket répartie au prorata, TVA incluse par ligne.
   * Aucun prix n'est modifiable à la caisse (décision 9).
   */
  private async priceLines(me: AuthUser, establishmentId: string, dto: CreateSaleDto) {
    const ids = [...new Set(dto.lines.map((l) => l.productId))];
    const [products, prices, unavailable, components] = await Promise.all([
      this.prisma.product.findMany({ where: { id: { in: ids }, companyId: me.companyId } }),
      this.prisma.productPrice.findMany({ where: { productId: { in: ids }, validTo: null, OR: [{ establishmentId: null }, { establishmentId }] } }),
      this.prisma.productAvailability.findMany({ where: { productId: { in: ids }, establishmentId, isAvailable: false } }),
      this.prisma.productComponent.findMany({ where: { menuProductId: { in: ids } }, include: { component: { select: { id: true, name: true, type: true } } } }),
    ]);
    const lines: PricedLine[] = [];
    let anyDiscount = false;
    for (const l of dto.lines) {
      const p = products.find((x) => x.id === l.productId);
      if (!p) throw new BadRequestException('Produit invalide');
      if (!p.isActive) throw new BadRequestException(`« ${p.name} » est archivé`);
      if (unavailable.some((u) => u.productId === p.id)) throw new ConflictException(`« ${p.name} » n’est pas disponible dans cet établissement`);
      const local = prices.find((x) => x.productId === p.id && x.establishmentId === establishmentId);
      const base = prices.find((x) => x.productId === p.id && x.establishmentId === null);
      const unitPrice = local?.price ?? base?.price;
      if (unitPrice === undefined) throw new ConflictException(`« ${p.name} » n’a pas de prix de vente`);
      const quantity = D(l.quantity);
      const grossAmount = roundXof(big(unitPrice).mul(quantity));
      const disc = discountOf(grossAmount, l.discountPercent, l.discountAmount);
      if (disc.value > grossAmount) throw new BadRequestException(`Remise supérieure au montant de « ${p.name} »`);
      if (disc.value > 0n) {
        anyDiscount = true;
        if (!l.discountReason || l.discountReason.length < 3) throw new BadRequestException(`Motif de remise obligatoire pour « ${p.name} »`);
      }
      let parts: PricedLine['parts'];
      if (p.type === 'MENU') {
        const comps = components.filter((c) => c.menuProductId === p.id);
        if (!comps.length) throw new ConflictException(`Le menu « ${p.name} » n’a aucun composant`);
        parts = comps.map((c) => ({ productId: c.componentProductId, name: c.component.name, quantity: quantity.mul(c.quantity).toDecimalPlaces(4, Prisma.Decimal.ROUND_UP) }));
      } else parts = [{ productId: p.id, name: p.name, quantity }];
      lines.push({
        productId: p.id,
        productCode: p.code,
        productName: p.name,
        isMenu: p.type === 'MENU',
        quantity,
        unitPrice,
        grossAmount,
        discountPercent: disc.percent,
        lineDiscount: disc.value,
        discountReason: disc.value > 0n ? l.discountReason ?? null : null,
        ticketDiscount: 0n,
        lineTotal: 0n,
        taxRate: D(p.taxRate),
        taxAmount: 0n,
        parts,
      });
    }
    return this.finishPricing(lines, anyDiscount, dto);
  }

  /** Lignes d'une addition du restaurant : prix figés, remises soumises aux mêmes règles. */
  private presetLines(lines: PresetSaleLine[], dto: Pick<PresetSaleInput, 'ticketDiscountPercent' | 'ticketDiscountAmount' | 'ticketDiscountReason'>) {
    let anyDiscount = false;
    const priced: PricedLine[] = lines.map((l) => {
      const grossAmount = roundXof(big(l.unitPrice).mul(l.quantity));
      const disc = discountOf(grossAmount, l.discountPercent, l.discountAmount);
      if (disc.value > grossAmount) throw new BadRequestException(`Remise supérieure au montant de « ${l.productName} »`);
      if (disc.value > 0n) {
        anyDiscount = true;
        if (!l.discountReason || l.discountReason.length < 3) throw new BadRequestException(`Motif de remise obligatoire pour « ${l.productName} »`);
      }
      return {
        productId: l.productId,
        productCode: l.productCode,
        productName: l.productName,
        isMenu: l.isMenu,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        grossAmount,
        discountPercent: disc.percent,
        lineDiscount: disc.value,
        discountReason: disc.value > 0n ? l.discountReason ?? null : null,
        ticketDiscount: 0n,
        lineTotal: 0n,
        taxRate: l.taxRate,
        taxAmount: 0n,
        parts: [],
        presetCost: l.costTotal,
      };
    });
    return this.finishPricing(priced, anyDiscount, dto);
  }

  private finishPricing(
    lines: PricedLine[],
    lineDiscounts: boolean,
    dto: { ticketDiscountPercent?: number; ticketDiscountAmount?: number; ticketDiscountReason?: string | null },
  ) {
    let anyDiscount = lineDiscounts;
    // Remise ticket, répartie au prorata des lignes (reste d'arrondi sur les plus grosses).
    const subtotal = lines.reduce((s, l) => s + l.grossAmount - l.lineDiscount, 0n);
    const ticket = discountOf(subtotal, dto.ticketDiscountPercent, dto.ticketDiscountAmount);
    if (ticket.value > subtotal) throw new BadRequestException('Remise ticket supérieure au total');
    if (ticket.value > 0n) {
      anyDiscount = true;
      if (!dto.ticketDiscountReason || dto.ticketDiscountReason.length < 3) throw new BadRequestException('Motif de la remise ticket obligatoire');
      let allocated = 0n;
      for (const l of lines) {
        l.ticketDiscount = ((l.grossAmount - l.lineDiscount) * ticket.value) / subtotal;
        allocated += l.ticketDiscount;
      }
      const order = [...lines].sort((a, b) => Number(b.grossAmount - b.lineDiscount - (a.grossAmount - a.lineDiscount)));
      for (let i = 0; allocated < ticket.value; i = (i + 1) % order.length) {
        if (order[i].grossAmount - order[i].lineDiscount - order[i].ticketDiscount > 0n) {
          order[i].ticketDiscount += 1n;
          allocated += 1n;
        }
      }
    }
    for (const l of lines) {
      l.lineTotal = l.grossAmount - l.lineDiscount - l.ticketDiscount;
      l.taxAmount = l.taxRate.gt(0) ? roundXof(big(l.lineTotal).mul(l.taxRate).div(D(100).add(l.taxRate))) : 0n;
    }
    return {
      lines,
      anyDiscount,
      grossTotal: lines.reduce((s, l) => s + l.grossAmount, 0n),
      lineDiscountTotal: lines.reduce((s, l) => s + l.lineDiscount, 0n),
      ticketDiscountAmount: ticket.value,
      ticketDiscountReason: ticket.value > 0n ? dto.ticketDiscountReason ?? null : null,
      total: lines.reduce((s, l) => s + l.lineTotal, 0n),
      taxTotal: lines.reduce((s, l) => s + l.taxAmount, 0n),
    };
  }

  /** Paiements : plusieurs moyens possibles, monnaie rendue uniquement sur les espèces (décision 11). */
  private checkPayments(total: bigint, payments: PaymentDto[]) {
    if (total > 0n && payments.length === 0) throw new BadRequestException('Paiement manquant');
    const confirmed = payments.map((p) => {
      const amount = BigInt(p.amount);
      const provider = providerFor(p.method);
      return { method: p.method, amount, reference: provider.confirm({ method: p.method, amount, reference: p.reference ?? null }), provider: provider.code };
    });
    const cash = confirmed.filter((p) => p.method === 'CASH').reduce((s, p) => s + p.amount, 0n);
    const other = confirmed.filter((p) => p.method !== 'CASH').reduce((s, p) => s + p.amount, 0n);
    if (other > total) throw new BadRequestException('Les paiements hors espèces dépassent le total : la monnaie ne se rend qu’en espèces');
    const paid = cash + other;
    if (paid < total) throw new BadRequestException(`Paiement insuffisant : il manque ${total - paid} FCFA`);
    const change = paid - total;
    // Encaissé réellement par moyen (espèces : après rendu de monnaie).
    const kept = new Map<PaymentMethod, bigint>();
    for (const p of confirmed) kept.set(p.method, (kept.get(p.method) ?? 0n) + p.amount);
    if (cash > 0n) kept.set('CASH', cash - change);
    return { confirmed, paid, change, kept };
  }

  // --- Encaissement ---------------------------------------------------------------------

  create(me: AuthUser, dto: CreateSaleDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.sale
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((s) => s && { id: s.id, ownerId: s.cashierId }),
      () => this.recordSale(me, { sessionId: dto.sessionId, clientRequestId: dto.clientRequestId, payments: dto.payments, price: (estId) => this.priceLines(me, estId, dto) }),
      (id) => this.saleResult(me, id, null),
    );
  }

  /**
   * Encaissement d'une addition du restaurant (module 6) par le même circuit que
   * la caisse : session, paiements, remises, TVA, mouvements de caisse, ticket,
   * impression et audit. Aucune nouvelle sortie de stock (déjà faite à l'envoi
   * en cuisine) : le coût réel est fourni par le module 6.
   */
  createPresetSale(me: AuthUser, input: PresetSaleInput) {
    return idempotent(
      me,
      input.clientRequestId,
      () =>
        this.prisma.sale
          .findFirst({ where: { companyId: me.companyId, clientRequestId: input.clientRequestId } })
          .then((s) => s && { id: s.id, ownerId: s.cashierId }),
      () =>
        this.recordSale(me, {
          sessionId: input.sessionId,
          clientRequestId: input.clientRequestId,
          payments: input.payments,
          price: async () => this.presetLines(input.lines, input),
          reference: input.reference,
          inTransaction: input.inTransaction,
        }),
      (id) => this.saleResult(me, id, null),
    );
  }

  private async recordSale(
    me: AuthUser,
    dto: {
      sessionId: string;
      clientRequestId?: string;
      payments: PaymentDto[];
      price: (establishmentId: string) => Promise<Priced>;
      reference?: string;
      inTransaction?: (tx: Tx, saleId: string) => Promise<void>;
    },
  ) {
    // Contrôles préalables, avant d'attribuer un numéro de ticket.
    const session = await this.prisma.cashSession.findFirst({ where: { id: dto.sessionId, companyId: me.companyId }, include: { register: true } });
    if (!session) throw new NotFoundException('Session de caisse introuvable');
    assertCan(me, session.establishmentId, 'sales.create');
    if (session.cashierId !== me.userId) throw new ForbiddenException('Cette session de caisse appartient à un autre caissier');
    if (session.status !== 'OPEN') throw new ConflictException('Session de caisse clôturée');
    if (!session.register.isActive) throw new ConflictException('Caisse désactivée');
    const priced = await dto.price(session.establishmentId);
    if (priced.anyDiscount) assertCan(me, session.establishmentId, 'sales.discount');
    const pay = this.checkPayments(priced.total, dto.payments);
    const est = await this.prisma.establishment.findUniqueOrThrow({ where: { id: session.establishmentId } });

    // Numéro unique, jamais réutilisé, attribué hors transaction : la séquence
    // reste monotone ; un numéro attribué à une vente qui échoue ensuite est
    // tracé dans le journal (décision 13 corrigée).
    const number = await this.sequences.next(this.prisma, { companyId: me.companyId, docType: 'TICKET', establishmentId: est.id, establishmentCode: est.code });
    const saleId = randomUUID();
    let job: PrintJob | null;
    try {
      job = await this.prisma.$transaction(async (tx) => {
        await lockSalesRow(tx, 'cash_sessions', session.id);
        const s = await tx.cashSession.findUniqueOrThrow({ where: { id: session.id }, include: { register: true } });
        if (s.status !== 'OPEN') throw new ConflictException('Session de caisse clôturée');
        const locationId = s.register.stockLocationId;
        const ctx: MovementContext = { companyId: me.companyId, establishmentId: est.id, locationId, type: 'SALE', originType: 'SALE', originId: saleId, userId: me.userId };

        // Verrouillage de tous les soldes concernés en une requête, dans l'ordre des identifiants (pas d'interblocage).
        const productIds = [...new Set(priced.lines.flatMap((l) => l.parts.map((p) => p.productId)))];
        if (productIds.length) {
          await this.engine.assertNotFrozen(tx, locationId);
          await tx.$queryRaw`
            SELECT id FROM stock_balances
            WHERE location_id = ${locationId}::uuid AND product_id IN (${Prisma.join(productIds.map((id) => Prisma.sql`${id}::uuid`))})
            ORDER BY id FOR UPDATE`;
        }

        // Sortie du stock par le moteur du module 3 : FEFO, lots périmés exclus, réservations respectées (décision 2).
        const issued = [];
        for (const line of priced.lines) {
          const lots = [];
          for (const part of line.parts) {
            const out = await this.engine.issue(tx, ctx, { rawMaterialId: null, productId: part.productId }, part.quantity, { itemName: part.name });
            lots.push(...out.map((o) => ({ ...o, productId: part.productId })));
          }
          issued.push({ line, lots, cost: line.presetCost ?? lots.reduce((sum, o) => sum.add(o.value), D(0)) });
        }
        const costTotal = issued.reduce((sum, i) => sum.add(i.cost), D(0));

        await tx.sale.create({
          data: {
            id: saleId,
            companyId: me.companyId,
            establishmentId: est.id,
            registerId: s.registerId,
            sessionId: s.id,
            number,
            clientRequestId: dto.clientRequestId ?? null,
            cashierId: me.userId,
            grossTotal: priced.grossTotal,
            lineDiscountTotal: priced.lineDiscountTotal,
            ticketDiscountAmount: priced.ticketDiscountAmount,
            ticketDiscountReason: priced.ticketDiscountReason,
            total: priced.total,
            taxTotal: priced.taxTotal,
            paidTotal: pay.paid,
            changeGiven: pay.change,
            costTotal,
          },
        });
        for (const [position, { line, lots, cost }] of issued.entries()) {
          const { parts: _parts, presetCost: _cost, ...data } = line;
          const item = await tx.saleItem.create({ data: { ...data, saleId, position, costTotal: cost } });
          if (lots.length) {
            await tx.saleItemLot.createMany({
              data: lots.map((o) => ({ saleItemId: item.id, productId: o.productId, lotId: o.lotId, locationId, quantity: o.quantity, unitCost: o.unitCost })),
            });
          }
        }
        if (pay.confirmed.length) await tx.salePayment.createMany({ data: pay.confirmed.map((p) => ({ saleId, ...p })) });
        for (const [method, amount] of pay.kept) {
          if (amount === 0n) continue;
          await tx.cashMovement.create({
            data: { companyId: me.companyId, establishmentId: est.id, sessionId: s.id, type: 'SALE', method, amount, saleId, userId: me.userId },
          });
        }
        await this.audit.record(
          {
            action: 'SALE_CREATED',
            entityType: 'Sale',
            entityId: saleId,
            establishmentId: est.id,
            newValues: {
              number,
              total: priced.total,
              discounts: priced.lineDiscountTotal + priced.ticketDiscountAmount,
              payments: pay.confirmed.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })),
              change: pay.change,
              ...(dto.reference ? { reference: dto.reference } : {}),
            },
            reason: priced.ticketDiscountReason,
          },
          tx,
        );
        if (dto.inTransaction) await dto.inTransaction(tx, saleId);
        return this.createPrintJob(tx, me, { id: saleId, establishmentId: est.id, registerId: s.registerId }, s.register, 'TICKET', false);
      });
    } catch (e) {
      await this.audit
        .record({
          action: 'SALE_NUMBER_VOIDED',
          entityType: 'Sale',
          entityId: null,
          establishmentId: est.id,
          newValues: { number, sessionId: session.id },
          reason: String((e as Error).message ?? e).slice(0, 500),
        })
        .catch(() => undefined);
      throw e;
    }
    const print = job ? await this.deliver(job.id) : null;
    return this.saleResult(me, saleId, print);
  }

  // --- Impression -------------------------------------------------------------------------

  /**
   * Travail d'impression : imprimante réseau → en attente d'envoi ; navigateur →
   * rendu par le poste de caisse ; aucune impression automatique → rien.
   */
  private async createPrintJob(
    tx: Tx,
    me: AuthUser,
    sale: { id: string; establishmentId: string; registerId: string },
    register: { printerType: string; printerHost: string | null; autoPrint: boolean },
    kind: PrintJobKind,
    forced: boolean,
  ) {
    if (!forced && !register.autoPrint) return null;
    const network = register.printerType === 'NETWORK' && !!register.printerHost;
    if (!forced && register.printerType === 'NONE') return null;
    return tx.printJob.create({
      data: {
        companyId: me.companyId,
        establishmentId: sale.establishmentId,
        registerId: sale.registerId,
        saleId: sale.id,
        kind,
        status: network ? 'PENDING' : 'BROWSER',
        requestedById: me.userId,
      },
    });
  }

  /** Envoie un travail en attente à l'imprimante réseau de la caisse ; l'échec est conservé pour relance. */
  private async deliver(jobId: string) {
    const job = await this.prisma.printJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== 'PENDING' && job.status !== 'FAILED') return job;
    const register = job.registerId ? await this.prisma.cashRegister.findUnique({ where: { id: job.registerId } }) : null;
    if (!register || register.printerType !== 'NETWORK' || !register.printerHost) {
      return this.prisma.printJob.update({ where: { id: jobId }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: 'Aucune imprimante réseau configurée' } });
    }
    const { data } = await this.ticketData(job.saleId);
    const lines = renderTicket(data, { width: columnsFor(register.paperWidth), duplicate: job.kind === 'DUPLICATE' });
    try {
      await this.printer.send(register.printerHost, register.printerPort, escPos(lines));
      return this.prisma.printJob.update({ where: { id: jobId }, data: { status: 'PRINTED', attempts: { increment: 1 }, lastError: null, printedAt: new Date() } });
    } catch (e) {
      return this.prisma.printJob.update({ where: { id: jobId }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: (e as Error).message.slice(0, 300) } });
    }
  }

  private async ticketData(saleId: string): Promise<{ data: TicketData; paperWidth: number }> {
    const sale = await this.prisma.sale.findUniqueOrThrow({ where: { id: saleId }, include: { items: { orderBy: { position: 'asc' } }, payments: { orderBy: { createdAt: 'asc' } } } });
    const [company, est, register, cashier] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: sale.companyId } }),
      this.prisma.establishment.findUniqueOrThrow({ where: { id: sale.establishmentId } }),
      this.prisma.cashRegister.findUniqueOrThrow({ where: { id: sale.registerId } }),
      this.prisma.user.findUnique({ where: { id: sale.cashierId }, select: { fullName: true } }),
    ]);
    let reference: string | null = null;
    for (const resolve of this.ticketReferences) reference ??= await resolve(sale.id);
    return {
      paperWidth: register.paperWidth,
      data: {
        company,
        establishment: est,
        register,
        number: sale.number,
        reference,
        createdAt: sale.createdAt,
        cashier: cashier?.fullName ?? null,
        status: sale.status,
        items: sale.items.map((i) => ({ ...i, quantity: D(i.quantity), taxRate: D(i.taxRate) })),
        grossTotal: sale.grossTotal,
        lineDiscountTotal: sale.lineDiscountTotal,
        ticketDiscountAmount: sale.ticketDiscountAmount,
        total: sale.total,
        taxTotal: sale.taxTotal,
        payments: sale.payments,
        changeGiven: sale.changeGiven,
        refundedTotal: sale.refundedTotal,
      },
    };
  }

  private async ticketLines(saleId: string, duplicate: boolean) {
    const { data, paperWidth } = await this.ticketData(saleId);
    return { width: columnsFor(paperWidth), duplicate, lines: renderTicket(data, { width: columnsFor(paperWidth), duplicate }) };
  }

  private async saleResult(me: AuthUser, id: string, print: PrintJob | null) {
    const sale = await this.get(me, id);
    const job = print ?? (await this.prisma.printJob.findFirst({ where: { saleId: id, kind: 'TICKET' }, orderBy: { createdAt: 'desc' } }));
    return { sale, print: job, ticket: await this.ticketLines(id, false) };
  }

  /** Aperçu du ticket (marqué DUPLICATA s'il a déjà été imprimé). */
  async ticket(me: AuthUser, id: string) {
    await this.findVisible(me, id);
    const issued = await this.prisma.printJob.count({ where: { saleId: id, status: { in: ['PRINTED', 'BROWSER'] } } });
    return this.ticketLines(id, issued > 0);
  }

  /** Réimpression : un DUPLICATA, jamais une nouvelle vente. */
  async reprint(me: AuthUser, id: string) {
    const sale = await this.findVisible(me, id);
    assertCan(me, sale.establishmentId, 'tickets.reprint');
    const register = await this.prisma.cashRegister.findUniqueOrThrow({ where: { id: sale.registerId } });
    const job = await this.prisma.$transaction(async (tx) => {
      const j = (await this.createPrintJob(tx, me, sale, register, 'DUPLICATE', true))!;
      await this.audit.record({ action: 'TICKET_REPRINTED', entityType: 'Sale', entityId: id, establishmentId: sale.establishmentId, newValues: { number: sale.number, printJobId: j.id } }, tx);
      return j;
    });
    const print = job.status === 'PENDING' ? await this.deliver(job.id) : job;
    return { print, ticket: await this.ticketLines(id, true) };
  }

  /** Relance d'une impression en échec, ou repli sur l'impression navigateur (décision 12). */
  async retryPrint(me: AuthUser, jobId: string, toBrowser: boolean) {
    const job = await this.prisma.printJob.findFirst({ where: { id: jobId, companyId: me.companyId } });
    if (!job) throw new NotFoundException('Impression introuvable');
    assertCan(me, job.establishmentId, job.kind === 'DUPLICATE' ? 'tickets.reprint' : 'cash.operate');
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockSalesRow(tx, 'print_jobs', jobId);
      const j = await tx.printJob.findUniqueOrThrow({ where: { id: jobId } });
      if (j.status !== 'FAILED') throw new ConflictException('Seule une impression en échec peut être relancée');
      await this.audit.record(
        { action: toBrowser ? 'TICKET_PRINT_BROWSER' : 'TICKET_PRINT_RETRY', entityType: 'Sale', entityId: j.saleId, establishmentId: j.establishmentId, newValues: { printJobId: j.id, kind: j.kind } },
        tx,
      );
      return toBrowser ? tx.printJob.update({ where: { id: jobId }, data: { status: 'BROWSER', attempts: { increment: 1 } } }) : j;
    });
    const print = toBrowser ? updated : await this.deliver(jobId);
    return { print, ticket: await this.ticketLines(job.saleId, job.kind === 'DUPLICATE') };
  }

  // --- Consultation ---------------------------------------------------------------------

  private canSee(me: AuthUser, s: Pick<Sale, 'establishmentId' | 'cashierId'>) {
    return me.access.canAccessEstablishment(s.establishmentId) && (me.access.can('sales.view', s.establishmentId) || s.cashierId === me.userId);
  }

  private async findVisible(me: AuthUser, id: string) {
    const sale = await this.prisma.sale.findFirst({ where: { id, companyId: me.companyId } });
    if (!sale || !this.canSee(me, sale)) throw new NotFoundException('Vente introuvable');
    return sale;
  }

  async list(me: AuthUser, q: SaleQuery) {
    const ests = establishmentsWithAny(me, ['sales.view'], q.establishmentId);
    const rows = await this.prisma.sale.findMany({
      where: {
        companyId: me.companyId,
        establishmentId: { in: ests },
        sessionId: q.sessionId,
        status: q.status,
        number: q.number ? { contains: q.number.toUpperCase() } : undefined,
        createdAt: { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(`${q.to.slice(0, 10)}T23:59:59.999Z`) : undefined },
      },
      include: { payments: { select: { method: true, amount: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const [names, registers] = await Promise.all([
      userNames(this.prisma, me.companyId, rows.map((r) => r.cashierId)),
      this.prisma.cashRegister.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.registerId))] } }, select: { id: true, code: true, name: true } }),
    ]);
    return rows.map((r) => ({ ...r, cashier: names.get(r.cashierId) ?? null, register: registers.find((x) => x.id === r.registerId) ?? null }));
  }

  async get(me: AuthUser, id: string) {
    await this.findVisible(me, id);
    const sale = await this.prisma.sale.findUniqueOrThrow({
      where: { id },
      include: {
        items: { orderBy: { position: 'asc' }, include: { lots: true } },
        payments: { orderBy: { createdAt: 'asc' } },
        returns: { orderBy: { createdAt: 'asc' }, include: { items: { include: { lots: true } } } },
        printJobs: { orderBy: { createdAt: 'asc' } },
      },
    });
    const lotIds = sale.items.flatMap((i) => i.lots.map((l) => l.lotId));
    const productIds = sale.items.flatMap((i) => i.lots.map((l) => l.productId));
    const [lots, products, register, session, est, names] = await Promise.all([
      this.prisma.stockLot.findMany({ where: { id: { in: lotIds } }, select: { id: true, lotNumber: true, expiryDate: true, origin: true } }),
      this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, code: true, name: true, saleUnitCode: true } }),
      this.prisma.cashRegister.findUnique({ where: { id: sale.registerId }, select: { id: true, code: true, name: true, printerType: true } }),
      this.prisma.cashSession.findUnique({ where: { id: sale.sessionId }, select: { id: true, number: true, status: true } }),
      this.prisma.establishment.findUnique({ where: { id: sale.establishmentId }, select: { id: true, code: true, name: true } }),
      userNames(this.prisma, me.companyId, [sale.cashierId, sale.cancelledById, ...sale.returns.map((r) => r.createdById), ...sale.printJobs.map((j) => j.requestedById)]),
    ]);
    const name = (uid: string | null) => (uid ? names.get(uid) ?? null : null);
    return {
      ...sale,
      establishment: est,
      register,
      session,
      cashier: name(sale.cashierId),
      cancelledBy: name(sale.cancelledById),
      items: sale.items.map((i) => ({
        ...i,
        lots: i.lots.map((l) => ({ ...l, lot: lots.find((x) => x.id === l.lotId) ?? null, product: products.find((p) => p.id === l.productId) ?? null })),
      })),
      returns: sale.returns.map((r) => ({ ...r, createdBy: name(r.createdById) })),
      printJobs: sale.printJobs.map((j) => ({ ...j, requestedBy: name(j.requestedById) })),
      rights: {
        cancel: sale.status === 'COMPLETED' && session?.status === 'OPEN' && me.access.can('sales.cancel', sale.establishmentId),
        refund: (sale.status === 'COMPLETED' || sale.status === 'PARTIALLY_REFUNDED') && me.access.can('sales.refund', sale.establishmentId),
        reprint: me.access.can('tickets.reprint', sale.establishmentId),
      },
    };
  }

  // --- Annulation et remboursement ----------------------------------------------------

  private findReturn(me: AuthUser, key?: string) {
    return () =>
      this.prisma.saleReturn
        .findFirst({ where: { companyId: me.companyId, clientRequestId: key } })
        .then((r) => r && { id: r.saleId, ownerId: r.createdById });
  }

  /**
   * Verrouille les soldes des lots à remettre en stock, dans l'ordre des
   * identifiants (même ordre que les ventes : pas d'interblocage).
   */
  private async lockLotBalances(tx: Tx, lots: { locationId: string; lotId: string }[]) {
    if (!lots.length) return;
    for (const loc of new Set(lots.map((l) => l.locationId))) await this.engine.assertNotFrozen(tx, loc);
    await tx.$queryRaw`
      SELECT id FROM stock_balances
      WHERE (location_id, lot_id) IN (${Prisma.join(lots.map((l) => Prisma.sql`(${l.locationId}::uuid, ${l.lotId}::uuid)`))})
      ORDER BY id FOR UPDATE`;
  }

  /** Annulation complète dans la session encore ouverte : stock remis, argent rendu, rien n'est supprimé (décision 7). */
  cancel(me: AuthUser, id: string, dto: CancelSaleDto) {
    return idempotent(me, dto.clientRequestId, this.findReturn(me, dto.clientRequestId), () => this.doCancel(me, id, dto), (saleId) => this.get(me, saleId));
  }

  private async doCancel(me: AuthUser, id: string, dto: CancelSaleDto) {
    await this.prisma.$transaction(async (tx) => {
      await lockSalesRow(tx, 'sales', id);
      const sale = await tx.sale.findFirst({ where: { id, companyId: me.companyId }, include: { items: { include: { lots: true } } } });
      if (!sale || !this.canSee(me, sale)) throw new NotFoundException('Vente introuvable');
      assertCan(me, sale.establishmentId, 'sales.cancel');
      if (sale.status === 'CANCELLED') throw new ConflictException('Vente déjà annulée');
      if (sale.status !== 'COMPLETED') throw new ConflictException('Vente déjà remboursée en partie : utilisez un remboursement');
      await lockSalesRow(tx, 'cash_sessions', sale.sessionId);
      const session = await tx.cashSession.findUniqueOrThrow({ where: { id: sale.sessionId } });
      if (session.status !== 'OPEN') throw new ConflictException('La session de cette vente est clôturée : utilisez un remboursement');

      const received = await tx.cashMovement.groupBy({ by: ['method'], where: { saleId: id, type: 'SALE' }, _sum: { amount: true } });
      const cashBack = received.find((r) => r.method === 'CASH')?._sum.amount ?? 0n;
      const cashInDrawer = (await expectedByMethod(tx, session.id)).get('CASH') ?? 0n;
      if (cashBack > cashInDrawer) throw new ConflictException(`Espèces insuffisantes dans la caisse pour annuler (${cashInDrawer} FCFA disponibles)`);

      const est = await tx.establishment.findUniqueOrThrow({ where: { id: sale.establishmentId } });
      const ret = await tx.saleReturn.create({
        data: {
          companyId: me.companyId,
          establishmentId: sale.establishmentId,
          saleId: id,
          sessionId: sale.sessionId,
          number: await nextNumberForReturn(tx, me.companyId, est),
          clientRequestId: dto.clientRequestId ?? null,
          kind: 'CANCEL',
          total: sale.total,
          reason: dto.reason,
          createdById: me.userId,
        },
      });
      const allLots = sale.items.flatMap((i) => i.lots);
      await this.lockLotBalances(tx, allLots);
      const lotRows = await tx.stockLot.findMany({ where: { id: { in: allLots.map((l) => l.lotId) } } });
      for (const item of sale.items) {
        const ri = await tx.saleReturnItem.create({ data: { returnId: ret.id, saleItemId: item.id, quantity: item.quantity, amount: item.lineTotal, disposition: 'RESTOCK' } });
        for (const l of item.lots) {
          const qty = D(l.quantity).sub(l.returnedQuantity);
          if (qty.lte(0)) continue;
          await this.restock(tx, me, sale.establishmentId, ret.id, dto.reason, l, lotRows, qty, ri.id);
        }
      }
      for (const r of received) {
        await tx.cashMovement.create({
          data: { companyId: me.companyId, establishmentId: sale.establishmentId, sessionId: sale.sessionId, type: 'SALE_CANCEL', method: r.method, amount: -(r._sum.amount ?? 0n), saleId: id, returnId: ret.id, reason: dto.reason, userId: me.userId },
        });
      }
      await tx.sale.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: me.userId, cancelReason: dto.reason } });
      for (const hook of this.cancelHooks) await hook(tx, me, sale);
      await this.audit.record(
        { action: 'SALE_CANCELLED', entityType: 'Sale', entityId: id, establishmentId: sale.establishmentId, oldValues: { status: sale.status }, newValues: { status: 'CANCELLED', number: sale.number, returnNumber: ret.number, total: sale.total }, reason: dto.reason },
        tx,
      );
    });
    return this.get(me, id);
  }

  /** Remise en stock d'un lot vendu par le moteur du module 3 (mouvement SALE_RETURN). */
  private async restock(
    tx: Tx,
    me: AuthUser,
    establishmentId: string,
    returnId: string,
    reason: string,
    l: { id: string; lotId: string; locationId: string; productId: string },
    lotRows: StockLot[],
    qty: Prisma.Decimal,
    returnItemId: string,
  ) {
    const lot = lotRows.find((x) => x.id === l.lotId)!;
    const ctx: MovementContext = { companyId: me.companyId, establishmentId, locationId: l.locationId, type: 'SALE_RETURN', originType: 'SALE_RETURN', originId: returnId, reason, userId: me.userId };
    await this.engine.addToLot(tx, ctx, lot, qty);
    await tx.saleItemLot.update({ where: { id: l.id }, data: { returnedQuantity: { increment: qty } } });
    await tx.saleReturnLot.create({ data: { returnItemId, saleItemLotId: l.id, productId: l.productId, lotId: l.lotId, locationId: l.locationId, quantity: qty, disposition: 'RESTOCK' } });
  }

  /** Remboursement partiel ou total, depuis la session ouverte de celui qui rend l'argent (décision 7). */
  refund(me: AuthUser, id: string, dto: RefundSaleDto) {
    return idempotent(me, dto.clientRequestId, this.findReturn(me, dto.clientRequestId), () => this.doRefund(me, id, dto), (saleId) => this.get(me, saleId));
  }

  private async doRefund(me: AuthUser, id: string, dto: RefundSaleDto) {
    if (dto.method && dto.refunds?.length) throw new BadRequestException('Indiquer un moyen de remboursement OU une répartition');
    if (dto.refunds && new Set(dto.refunds.map((r) => r.method)).size !== dto.refunds.length) throw new BadRequestException('Moyen de remboursement en double');
    if (new Set(dto.lines.map((l) => l.saleItemId)).size !== dto.lines.length) throw new BadRequestException('Ligne de vente en double dans le remboursement');
    await this.prisma.$transaction(async (tx) => {
      await lockSalesRow(tx, 'sales', id);
      const sale = await tx.sale.findFirst({
        where: { id, companyId: me.companyId },
        include: { items: { include: { lots: { orderBy: { id: 'asc' } } } }, payments: true, returns: { include: { items: true } } },
      });
      if (!sale || !this.canSee(me, sale)) throw new NotFoundException('Vente introuvable');
      assertCan(me, sale.establishmentId, 'sales.refund');
      if (sale.status === 'CANCELLED') throw new ConflictException('Vente annulée : rien à rembourser');
      if (sale.status === 'REFUNDED') throw new ConflictException('Vente déjà entièrement remboursée');

      await lockSalesRow(tx, 'cash_sessions', dto.sessionId);
      const session = await tx.cashSession.findFirst({ where: { id: dto.sessionId, companyId: me.companyId } });
      if (!session || session.cashierId !== me.userId || session.status !== 'OPEN') throw new ConflictException('Ouvrez votre propre session de caisse pour rembourser');
      if (session.establishmentId !== sale.establishmentId) throw new ConflictException('Le remboursement se fait dans l’établissement de la vente');

      // Montant par ligne au prorata ; la dernière unité solde exactement la ligne.
      const refundedByItem = new Map<string, bigint>();
      for (const r of sale.returns) for (const ri of r.items) refundedByItem.set(ri.saleItemId, (refundedByItem.get(ri.saleItemId) ?? 0n) + ri.amount);
      const plan = dto.lines.map((l) => {
        const item = sale.items.find((i) => i.id === l.saleItemId);
        if (!item) throw new BadRequestException('Ligne de vente invalide');
        const q = D(l.quantity);
        const remaining = D(item.quantity).sub(item.refundedQuantity);
        if (q.gt(remaining)) throw new ConflictException(`« ${item.productName} » : ${remaining.toString()} au plus peut encore être remboursé`);
        const left = item.lineTotal - (refundedByItem.get(item.id) ?? 0n);
        const amount = q.eq(remaining) ? left : (() => {
          const prorata = roundXof(big(item.lineTotal).mul(q).div(item.quantity));
          return prorata > left ? left : prorata;
        })();
        return { item, q, last: q.eq(remaining), amount, disposition: l.disposition };
      });
      const total = plan.reduce((s, p) => s + p.amount, 0n);

      // Moyens de remboursement : ceux de la vente, chacun dans la limite de ce qu'il a encaissé
      // (pas de remboursement en espèces d'un paiement mobile money, par exemple).
      const split = dto.refunds?.length ? dto.refunds.map((r) => ({ method: r.method, amount: BigInt(r.amount) })) : [{ method: dto.method ?? 'CASH', amount: total }];
      const splitTotal = split.reduce((s, r) => s + r.amount, 0n);
      if (splitTotal !== total) throw new BadRequestException(`La répartition doit totaliser ${total} FCFA (reçu ${splitTotal})`);
      const refundedBefore = await tx.cashMovement.groupBy({ by: ['method'], where: { saleId: id, type: 'REFUND' }, _sum: { amount: true } });
      for (const r of split.filter((x) => x.amount > 0n)) {
        const paidWith = sale.payments.filter((p) => p.method === r.method).reduce((s, p) => s + p.amount, 0n) - (r.method === 'CASH' ? sale.changeGiven : 0n);
        if (paidWith <= 0n) throw new BadRequestException(`La vente n’a pas été payée par ${METHOD_LABELS[r.method]}`);
        const already = -(refundedBefore.find((x) => x.method === r.method)?._sum.amount ?? 0n);
        if (already + r.amount > paidWith) throw new ConflictException(`Remboursement par ${METHOD_LABELS[r.method]} limité à ${paidWith - already} FCFA`);
        if (r.method === 'CASH') {
          const cash = (await expectedByMethod(tx, session.id)).get('CASH') ?? 0n;
          if (r.amount > cash) throw new ConflictException(`Espèces insuffisantes dans la caisse (${cash} FCFA disponibles)`);
        }
      }

      const est = await tx.establishment.findUniqueOrThrow({ where: { id: sale.establishmentId } });
      const ret = await tx.saleReturn.create({
        data: {
          companyId: me.companyId,
          establishmentId: sale.establishmentId,
          saleId: id,
          sessionId: session.id,
          number: await nextNumberForReturn(tx, me.companyId, est),
          clientRequestId: dto.clientRequestId ?? null,
          kind: 'REFUND',
          method: split.length === 1 ? split[0].method : null,
          total,
          reason: dto.reason,
          createdById: me.userId,
        },
      });

      // Lots concernés : pour chaque article sorti (produit ou composant de menu), au prorata de la quantité rendue.
      const takes: { p: (typeof plan)[number]; l: (typeof sale.items)[number]['lots'][number]; qty: Prisma.Decimal }[] = [];
      for (const p of plan) {
        for (const productId of new Set(p.item.lots.map((l) => l.productId))) {
          const group = p.item.lots.filter((l) => l.productId === productId);
          const open = group.reduce((s, l) => s.add(D(l.quantity).sub(l.returnedQuantity)), D(0));
          const sold = group.reduce((s, l) => s.add(l.quantity), D(0));
          let rest = p.last ? open : Prisma.Decimal.min(open, sold.mul(p.q).div(p.item.quantity).toDecimalPlaces(4));
          for (const l of group) {
            if (rest.lte(0)) break;
            const free = D(l.quantity).sub(l.returnedQuantity);
            if (free.lte(0)) continue;
            const qty = Prisma.Decimal.min(free, rest);
            takes.push({ p, l, qty });
            rest = rest.sub(qty);
          }
        }
      }
      await this.lockLotBalances(tx, takes.filter((t) => t.p.disposition === 'RESTOCK').map((t) => t.l));
      const lotRows = await tx.stockLot.findMany({ where: { id: { in: takes.map((t) => t.l.lotId) } } });
      for (const p of plan) {
        const ri = await tx.saleReturnItem.create({ data: { returnId: ret.id, saleItemId: p.item.id, quantity: p.q, amount: p.amount, disposition: p.disposition } });
        for (const t of takes.filter((x) => x.p === p)) {
          if (p.disposition === 'RESTOCK') {
            await this.restock(tx, me, sale.establishmentId, ret.id, dto.reason, t.l, lotRows, t.qty, ri.id);
          } else {
            // Produit rendu inutilisable : perte « retour client », sans nouveau mouvement (il a déjà quitté le stock).
            const loss = await tx.stockLoss.create({
              data: {
                companyId: me.companyId,
                establishmentId: sale.establishmentId,
                locationId: t.l.locationId,
                number: await nextNumber(tx, me.companyId, 'STOCK_LOSS', est),
                productId: t.l.productId,
                lotId: t.l.lotId,
                quantity: t.qty,
                cause: 'CUSTOMER_RETURN',
                comment: `Retour client ${ret.number} — ticket ${sale.number} — ${dto.reason}`.slice(0, 1000),
                estimatedValue: roundXof(t.qty.mul(t.l.unitCost)),
                declaredById: me.userId,
              },
            });
            await tx.saleItemLot.update({ where: { id: t.l.id }, data: { returnedQuantity: { increment: t.qty } } });
            await tx.saleReturnLot.create({
              data: { returnItemId: ri.id, saleItemLotId: t.l.id, productId: t.l.productId, lotId: t.l.lotId, locationId: t.l.locationId, quantity: t.qty, disposition: 'LOSS', stockLossId: loss.id },
            });
          }
        }
        await tx.saleItem.update({ where: { id: p.item.id }, data: { refundedQuantity: { increment: p.q } } });
      }
      for (const r of split.filter((x) => x.amount > 0n)) {
        await tx.cashMovement.create({
          data: { companyId: me.companyId, establishmentId: sale.establishmentId, sessionId: session.id, type: 'REFUND', method: r.method, amount: -r.amount, saleId: id, returnId: ret.id, reason: dto.reason, userId: me.userId },
        });
      }
      const items = await tx.saleItem.findMany({ where: { saleId: id } });
      const full = items.every((i) => D(i.refundedQuantity).gte(i.quantity));
      const status: SaleStatus = full ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      await tx.sale.update({ where: { id }, data: { status, refundedTotal: { increment: total } } });
      await this.audit.record(
        {
          action: 'SALE_REFUNDED',
          entityType: 'Sale',
          entityId: id,
          establishmentId: sale.establishmentId,
          oldValues: { status: sale.status, refundedTotal: sale.refundedTotal },
          newValues: { status, number: sale.number, returnNumber: ret.number, refunds: split, total, lines: plan.map((p) => ({ product: p.item.productName, quantity: p.q, amount: p.amount, disposition: p.disposition })) },
          reason: dto.reason,
        },
        tx,
      );
    });
    return this.get(me, id);
  }

  // --- Traçabilité -------------------------------------------------------------------------

  /** Vente → lots vendus → production éventuelle → matières et fournisseurs (traçabilité du module 4). */
  async trace(me: AuthUser, id: string) {
    const sale = await this.get(me, id);
    const canTrace = me.access.global.has('stock.view') || me.access.can('stock.view', sale.establishmentId);
    const items = [];
    for (const i of sale.items) {
      const lots = [];
      for (const l of i.lots) lots.push({ ...l, upstream: canTrace ? (await this.production.trace(me, l.lotId)).upstream : null });
      items.push({ id: i.id, productName: i.productName, quantity: i.quantity, isMenu: i.isMenu, lots });
    }
    return { sale: { id: sale.id, number: sale.number, createdAt: sale.createdAt, status: sale.status, establishment: sale.establishment }, canTrace, items };
  }

  /**
   * Lot → ventes : ventes du lot lui-même et des produits finis fabriqués avec
   * lui (récursivement, via les productions du module 4).
   */
  async lotSales(me: AuthUser, lotId: string) {
    const root = await this.prisma.stockLot.findFirst({ where: { id: lotId, companyId: me.companyId } });
    if (!root) throw new NotFoundException('Lot introuvable');
    const readable = [...new Set([...readableEstablishments(me, 'stock.view'), ...readableEstablishments(me, 'sales.view')])];
    if (!readable.length && !me.access.global.has('stock.view')) throw new ForbiddenException('Accès refusé');

    // Lots descendants (produits finis issus de ce lot), avec l'ordre de production qui les relie.
    const chain = new Map<string, { via: string | null; depth: number }>([[lotId, { via: null, depth: 0 }]]);
    let frontier = [lotId];
    for (let depth = 1; depth <= 6 && frontier.length; depth++) {
      const uses = await this.prisma.productionConsumption.findMany({ where: { lotId: { in: frontier }, quantity: { gt: 0 } }, select: { orderId: true } });
      const orderIds = [...new Set(uses.map((u) => u.orderId))];
      const outputs = await this.prisma.productionOutput.findMany({ where: { orderId: { in: orderIds } }, include: { order: { select: { number: true } } } });
      frontier = [];
      for (const o of outputs) {
        if (chain.has(o.lotId)) continue;
        chain.set(o.lotId, { via: o.order.number, depth });
        frontier.push(o.lotId);
      }
    }
    const lotIds = [...chain.keys()];
    const [lots, sold] = await Promise.all([
      this.prisma.stockLot.findMany({ where: { id: { in: lotIds } }, select: { id: true, lotNumber: true, productId: true, rawMaterialId: true, expiryDate: true } }),
      this.prisma.saleItemLot.findMany({
        where: { lotId: { in: lotIds }, saleItem: { sale: { companyId: me.companyId, establishmentId: { in: readable } } } },
        include: { saleItem: { include: { sale: { select: { id: true, number: true, createdAt: true, status: true, establishmentId: true } } } } },
        orderBy: { id: 'asc' },
      }),
    ]);
    const products = await this.prisma.product.findMany({ where: { id: { in: [...lots.map((l) => l.productId), ...sold.map((s) => s.productId)].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const ests = await this.prisma.establishment.findMany({ where: { id: { in: [...new Set(sold.map((s) => s.saleItem.sale.establishmentId))] } }, select: { id: true, code: true, name: true } });
    const pname = (pid: string | null) => products.find((p) => p.id === pid)?.name ?? null;
    return {
      lot: { id: root.id, lotNumber: root.lotNumber },
      lots: lots.map((l) => ({ ...l, product: pname(l.productId), via: chain.get(l.id)!.via, depth: chain.get(l.id)!.depth })).sort((a, b) => a.depth - b.depth),
      sales: sold.map((s) => ({
        saleId: s.saleItem.sale.id,
        number: s.saleItem.sale.number,
        createdAt: s.saleItem.sale.createdAt,
        status: s.saleItem.sale.status,
        establishment: ests.find((e) => e.id === s.saleItem.sale.establishmentId) ?? null,
        lotNumber: lots.find((l) => l.id === s.lotId)?.lotNumber ?? null,
        product: pname(s.productId),
        soldAs: s.saleItem.productName,
        quantity: s.quantity,
        returnedQuantity: s.returnedQuantity,
      })),
    };
  }

  async lotSalesByNumber(me: AuthUser, lotNumber: string) {
    const lot = await this.prisma.stockLot.findFirst({ where: { companyId: me.companyId, lotNumber: lotNumber.trim().toUpperCase() } });
    if (!lot) throw new NotFoundException('Lot introuvable');
    return this.lotSales(me, lot.id);
  }
}

/** Numéro de retour / remboursement, ex. « PLT-RMB-2026-000002 ». */
const nextNumberForReturn = (tx: Tx, companyId: string, est: { id: string; code: string }) => nextSalesNumber(tx, companyId, 'SALE_RETURN', est);

@ApiTags('Ventes')
@ApiBearerAuth()
@Controller()
export class SalesController {
  constructor(private readonly service: SalesService) {}

  @Get('sales')
  @RequirePermissions('sales.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser, @Query() q: SaleQuery) {
    return this.service.list(me, q);
  }

  @Get('sales/:id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post('sales')
  @RequirePermissions('sales.create')
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateSaleDto) {
    return this.service.create(me, dto);
  }

  @Post('sales/:id/cancel')
  @RequirePermissions('sales.cancel')
  @AnyEstablishmentScope()
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelSaleDto) {
    return this.service.cancel(me, id, dto);
  }

  @Post('sales/:id/refund')
  @RequirePermissions('sales.refund')
  @AnyEstablishmentScope()
  refund(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundSaleDto) {
    return this.service.refund(me, id, dto);
  }

  @Get('sales/:id/ticket')
  ticket(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.ticket(me, id);
  }

  @Post('sales/:id/reprint')
  @RequirePermissions('tickets.reprint')
  @AnyEstablishmentScope()
  reprint(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.reprint(me, id);
  }

  @Post('print-jobs/:id/retry')
  retry(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.retryPrint(me, id, false);
  }

  @Post('print-jobs/:id/browser')
  browser(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.retryPrint(me, id, true);
  }

  @Get('sales/:id/trace')
  trace(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.trace(me, id);
  }

  @Get('traceability/lots/:id/sales')
  lotSales(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.lotSales(me, id);
  }

  @Get('traceability/sales')
  lotSalesByNumber(@CurrentUser() me: AuthUser, @Query() q: LotNumberQuery) {
    return this.service.lotSalesByNumber(me, q.lotNumber);
  }
}
