import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, OnModuleInit, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Invoice, InvoiceSource, InvoiceStatus, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { Db, PrismaService, Tx } from '../prisma/prisma.service';
import { METHOD_LABELS, providerFor, roundXof } from '../sales/common';
import { customerCashMovement } from '../sales/sessions';
import { SequenceService } from '../sequences/sequence.service';
import { D, idempotent, userNames } from '../stock/common';
import { CustomerCreditService } from './credit';
import { activeCustomer, DocumentLineDto, emptyToNull, lockRowOf, priceLines, taxIncluded, todayISO, trim } from './lines';
import { MoneyDto, PAY, CustomerPaymentsService } from './payments';

const MANAGE = 'invoices.manage';
const READ = ['invoices.view', 'invoices.manage', 'receivables.view', 'payments.manage'];
const OFF_REGISTER = new Set(['BANK_TRANSFER', 'CHEQUE']);
/** Une commande se facture une fois confirmée (avant ou après la livraison), jamais annulée. */
const INVOICEABLE_ORDER = ['CONFIRMED', 'IN_PREPARATION', 'READY', 'DELIVERED', 'COMPLETED'];
const OPEN: InvoiceStatus[] = ['ISSUED', 'DISPUTED'];

export class CreateInvoiceDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsIn(['ORDER', 'SALE', 'MANUAL']) source: InvoiceSource;
  @IsUUID() establishmentId: string;
  /** Obligatoire pour un ticket ou une facture manuelle ; pour une commande, son client. */
  @IsOptional() @IsUUID() customerId?: string;
  @ValidateIf((d) => d.source === 'ORDER') @IsUUID() orderId?: string;
  @ValidateIf((d) => d.source === 'SALE') @IsUUID() saleId?: string;
  /** Facture manuelle : lignes « frais » du module 7 seulement (aucun produit sans sortie de stock). */
  @ValidateIf((d) => d.source === 'MANUAL') @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => DocumentLineDto) lines?: DocumentLineDto[];
  /** Taux de TVA des frais de livraison repris de la commande (frais du module 7 : taux saisi, 0 par défaut). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) deliveryFeeTaxRate?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(2000) notes?: string | null;
}

export class UpdateInvoiceDto {
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => DocumentLineDto) lines?: DocumentLineDto[];
}

export class InvoiceReasonDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class AllocateDto {
  @ValidateIf((d) => !d.depositId) @IsUUID() paymentId?: string;
  @ValidateIf((d) => !d.paymentId) @IsUUID() depositId?: string;
  @IsInt() @Min(1) @Max(1_000_000_000) amount: number;
}

export class PayInvoiceDto extends MoneyDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
}

export class CreditLineDto {
  @IsUUID() invoiceLineId: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e6) quantity?: number;
  @ValidateIf((l) => l.quantity === undefined) @IsInt() @Min(1) @Max(1_000_000_000) amount?: number;
}

export class SettlementDto {
  /** Part de l'avoir au-delà du reste dû : crédit du client (avance réutilisable) ou remboursement. */
  @IsIn(['CUSTOMER_CREDIT', 'REFUND']) mode: 'CUSTOMER_CREDIT' | 'REFUND';
  @ValidateIf((s) => s.mode === 'REFUND') @ValidateNested() @Type(() => MoneyDto) refund?: MoneyDto;
}

export class CreateCreditNoteDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
  /** Avoir total : tout le montant encore corrigeable de chaque ligne. */
  @IsOptional() @IsBoolean() full?: boolean;
  @ValidateIf((d) => !d.full) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CreditLineDto) lines?: CreditLineDto[];
  @IsOptional() @ValidateNested() @Type(() => SettlementDto) settlement?: SettlementDto;
}

class InvoiceQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsIn(['DRAFT', 'ISSUED', 'DISPUTED', 'CANCELLED']) status?: InvoiceStatus;
  @IsOptional() @IsIn(['true', 'false']) overdue?: string;
}

type Line = {
  position: number;
  kind: 'PRODUCT' | 'FEE';
  productId: string | null;
  productCode: string | null;
  label: string;
  quantity: Prisma.Decimal;
  unitPrice: bigint;
  taxRate: Prisma.Decimal;
  lineTotal: bigint;
  taxAmount: bigint;
  note: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  orderLineId?: string | null;
  saleItemId?: string | null;
  deliveryId?: string | null;
};

/** Soldes calculés à la lecture (décision D7) : rien de dérivé n'est enregistré. */
export interface InvoiceBalance {
  credited: bigint;
  paid: bigint;
  balance: bigint;
  paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | null;
  overdue: boolean;
}

/**
 * Montants d'un lot de factures : avoirs émis, payé net (caisse du ticket +
 * répartitions actives − remboursements d'avoirs), reste dû, statut de
 * paiement et retard (échéance dépassée avec un reste dû).
 */
export async function invoiceBalances(db: Db, invoices: Pick<Invoice, 'id' | 'status' | 'total' | 'posPaidAmount' | 'dueDate'>[]) {
  const ids = invoices.map((i) => i.id);
  const [credits, allocations, refunds] = await Promise.all([
    db.creditNote.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: ids } }, _sum: { total: true } }),
    db.paymentAllocation.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: ids }, releasedAt: null }, _sum: { amount: true } }),
    db.customerRefund.findMany({ where: { creditNote: { invoiceId: { in: ids } } }, select: { amount: true, creditNote: { select: { invoiceId: true } } } }),
  ]);
  const today = todayISO();
  return new Map(
    invoices.map((i) => {
      const credited = credits.find((c) => c.invoiceId === i.id)?._sum.total ?? 0n;
      const allocated = allocations.find((a) => a.invoiceId === i.id)?._sum.amount ?? 0n;
      const refunded = refunds.filter((r) => r.creditNote?.invoiceId === i.id).reduce((s, r) => s + r.amount, 0n);
      const paid = i.posPaidAmount + allocated - refunded;
      const balance = i.total - credited - paid;
      const open = OPEN.includes(i.status);
      const b: InvoiceBalance = {
        credited,
        paid,
        balance,
        paymentStatus: open ? (balance <= 0n ? 'PAID' : paid > 0n ? 'PARTIALLY_PAID' : 'UNPAID') : null,
        overdue: open && balance > 0n && !!i.dueDate && i.dueDate.toISOString().slice(0, 10) < today,
      };
      return [i.id, b];
    }),
  );
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000);

/**
 * Factures et avoirs du module 7 (décisions D2, D3, D7). Une facture ne
 * touche jamais au stock ; celle d'un ticket du module 5 reprend ses lignes et
 * son règlement de caisse, sans seconde vente. Numéros FAC et AVR attribués
 * à l'émission, dans la transaction (numérotation du module 1, sans trou).
 */
@Injectable()
export class InvoicesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly credit: CustomerCreditService,
    private readonly payments: CustomerPaymentsService,
  ) {}

  /** Encours du client : reste dû des factures émises ou en litige (base du contrôle de crédit). */
  onModuleInit() {
    this.credit.registerOutstandingSource(async (db, customerId) => {
      const open = await db.invoice.findMany({ where: { customerId, status: { in: OPEN } }, select: { id: true, status: true, total: true, posPaidAmount: true, dueDate: true } });
      if (!open.length) return 0n;
      return [...(await invoiceBalances(db, open)).values()].reduce((s, b) => s + (b.balance > 0n ? b.balance : 0n), 0n);
    });
  }

  // --- Droits ---------------------------------------------------------------------------

  private canRead(me: AuthUser, establishmentId: string) {
    return me.access.canAccessEstablishment(establishmentId) && READ.some((p) => me.access.can(p, establishmentId));
  }

  private assertCan(me: AuthUser, establishmentId: string, ...permissions: string[]) {
    if (!me.access.canAccessEstablishment(establishmentId) || permissions.some((p) => !me.access.can(p, establishmentId))) {
      throw new ForbiddenException("Vous n'avez pas cette permission pour cet établissement");
    }
  }

  private readable(me: AuthUser, requested?: string) {
    const ids = new Set<string>();
    for (const p of READ) me.access.establishmentsWith(p).forEach((x) => ids.add(x));
    const scope = requested ?? me.establishmentId;
    if (scope) return ids.has(scope) ? [scope] : [];
    return [...ids];
  }

  // --- Lecture --------------------------------------------------------------------------

  async list(me: AuthUser, q: InvoiceQuery) {
    const rows = await this.prisma.invoice.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.readable(me, q.establishmentId) }, customerId: q.customerId, orderId: q.orderId, status: q.status },
      include: { customer: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const balances = await invoiceBalances(this.prisma, rows);
    const out = rows.map((r) => ({ ...r, ...balances.get(r.id)! }));
    return q.overdue === undefined ? out : out.filter((r) => r.overdue === (q.overdue === 'true'));
  }

  async get(me: AuthUser, id: string) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, companyId: me.companyId },
      include: {
        customer: { select: { id: true, name: true, phone: true, address: true, taxId: true } },
        order: { select: { id: true, number: true, status: true } },
        lines: { orderBy: { position: 'asc' } },
        creditNotes: { orderBy: { createdAt: 'asc' }, include: { lines: true, refunds: true } },
        allocations: { orderBy: { createdAt: 'asc' }, include: { payment: { select: { id: true, number: true, method: true, reference: true } }, deposit: { select: { id: true, number: true } } } },
      },
    });
    if (!inv || !this.canRead(me, inv.establishmentId)) throw new NotFoundException('Facture introuvable');
    const sale = inv.saleId ? await this.prisma.sale.findUnique({ where: { id: inv.saleId }, select: { id: true, number: true } }) : null;
    const names = await userNames(this.prisma, me.companyId, [inv.createdById, inv.issuedById, inv.cancelledById]);
    const credited = new Map<string, bigint>();
    for (const cn of inv.creditNotes) for (const l of cn.lines) credited.set(l.invoiceLineId, (credited.get(l.invoiceLineId) ?? 0n) + l.amount);
    return {
      ...inv,
      ...(await invoiceBalances(this.prisma, [inv])).get(inv.id)!,
      sale,
      correctable: OPEN.includes(inv.status) ? inv.total - inv.creditNotes.reduce((s, c) => s + c.total, 0n) : 0n,
      lines: inv.lines.map((l) => ({ ...l, credited: credited.get(l.id) ?? 0n })),
      allocations: inv.allocations.map((a) => ({ ...a, methodLabel: METHOD_LABELS[a.payment.method] })),
      createdBy: names.get(inv.createdById) ?? null,
      issuedBy: inv.issuedById ? names.get(inv.issuedById) ?? null : null,
      cancelledBy: inv.cancelledById ? names.get(inv.cancelledById) ?? null : null,
      canManage: me.access.can(MANAGE, inv.establishmentId),
    };
  }

  async getCreditNote(me: AuthUser, id: string) {
    const cn = await this.prisma.creditNote.findFirst({ where: { id, companyId: me.companyId }, include: { lines: true, refunds: true, invoice: { select: { id: true, number: true } } } });
    if (!cn || !this.canRead(me, cn.establishmentId)) throw new NotFoundException('Avoir introuvable');
    return cn;
  }

  // --- Brouillon ----------------------------------------------------------------------------

  create(me: AuthUser, dto: CreateInvoiceDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.invoice
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((i) => i && { id: i.id, ownerId: i.createdById }),
      async () => {
        this.assertCan(me, dto.establishmentId, MANAGE);
        const id = await this.prisma.$transaction((tx) => this.doCreate(tx, me, dto));
        return this.get(me, id);
      },
      (id) => this.get(me, id),
    );
  }

  private async doCreate(tx: Tx, me: AuthUser, dto: CreateInvoiceDto) {
    const est = await tx.establishment.findFirst({ where: { id: dto.establishmentId, companyId: me.companyId, deletedAt: null } });
    if (!est) throw new BadRequestException('Établissement invalide');
    let customerId: string;
    let lines: Line[];
    let posPaidAmount = 0n;
    if (dto.source === 'ORDER') {
      await lockRowOf(tx, 'customer_orders', dto.orderId!);
      const order = await tx.customerOrder.findFirst({ where: { id: dto.orderId, companyId: me.companyId }, include: { lines: { orderBy: { position: 'asc' } }, deliveries: { orderBy: { createdAt: 'asc' } } } });
      if (!order || order.establishmentId !== est.id) throw new BadRequestException('Commande invalide pour cet établissement');
      if (dto.customerId && dto.customerId !== order.customerId) throw new BadRequestException('La facture d’une commande va à son client');
      if (!INVOICEABLE_ORDER.includes(order.status)) throw new ConflictException('Seule une commande confirmée, non annulée, se facture');
      if (await tx.invoice.count({ where: { orderId: order.id, status: { in: ['DRAFT', ...OPEN] } } })) throw new ConflictException('Cette commande a déjà une facture en cours');
      customerId = (await activeCustomer(tx, me, order.customerId)).id;
      lines = order.lines.map((l) => ({
        position: l.position,
        kind: l.kind,
        productId: l.productId,
        productCode: l.productCode,
        label: l.label,
        quantity: D(l.quantity),
        unitPrice: l.unitPrice,
        taxRate: D(l.taxRate),
        lineTotal: l.lineTotal,
        taxAmount: l.taxAmount,
        note: l.note,
        categoryId: l.categoryId,
        categoryName: l.categoryName,
        orderLineId: l.id,
      }));
      // Frais de livraison (frais du module 7, sans stock) des livraisons non annulées ni échouées.
      const feeRate = D(dto.deliveryFeeTaxRate ?? 0);
      for (const d of order.deliveries.filter((x) => x.fee > 0n && !['CANCELLED', 'FAILED'].includes(x.status))) {
        lines.push({
          position: lines.length,
          kind: 'FEE',
          productId: null,
          productCode: null,
          label: d.feeLabel ?? `Frais de livraison ${d.number}`,
          quantity: D(1),
          unitPrice: d.fee,
          taxRate: feeRate,
          lineTotal: d.fee,
          taxAmount: taxIncluded(d.fee, feeRate),
          note: null,
          deliveryId: d.id,
        });
      }
    } else if (dto.source === 'SALE') {
      if (!dto.customerId) throw new BadRequestException('Client obligatoire pour facturer un ticket');
      await tx.$queryRaw`SELECT id FROM sales WHERE id = ${dto.saleId}::uuid FOR UPDATE`;
      const sale = await tx.sale.findFirst({ where: { id: dto.saleId, companyId: me.companyId }, include: { items: { orderBy: { position: 'asc' } } } });
      if (!sale || sale.establishmentId !== est.id) throw new BadRequestException('Ticket invalide pour cet établissement');
      if (sale.status !== 'COMPLETED') throw new ConflictException('Un ticket annulé ou remboursé ne se facture pas');
      if (await tx.invoice.count({ where: { saleId: sale.id, OR: [{ status: { not: 'CANCELLED' } }, { number: { not: null } }] } })) {
        throw new ConflictException(`Le ticket ${sale.number} est déjà facturé`);
      }
      customerId = (await activeCustomer(tx, me, dto.customerId)).id;
      lines = sale.items.map((i) => ({
        position: i.position,
        kind: 'PRODUCT',
        productId: i.productId,
        productCode: i.productCode,
        label: i.productName,
        quantity: D(i.quantity),
        unitPrice: i.unitPrice,
        taxRate: D(i.taxRate),
        lineTotal: i.lineTotal,
        taxAmount: i.taxAmount,
        note: i.lineDiscount + i.ticketDiscount > 0n ? `Remise ${i.lineDiscount + i.ticketDiscount} FCFA` : null,
        categoryId: i.categoryId,
        categoryName: i.categoryName,
        saleItemId: i.id,
      }));
      // Déjà encaissé à la caisse : la facture ne crée ni vente ni encaissement.
      posPaidAmount = sale.total;
    } else {
      if (!dto.customerId) throw new BadRequestException('Client obligatoire');
      customerId = (await activeCustomer(tx, me, dto.customerId)).id;
      lines = await this.manualLines(tx, me, est.id, dto.lines!);
    }
    const totals = { total: lines.reduce((s, l) => s + l.lineTotal, 0n), taxTotal: lines.reduce((s, l) => s + l.taxAmount, 0n) };
    const inv = await tx.invoice.create({
      data: {
        companyId: me.companyId,
        establishmentId: est.id,
        customerId,
        clientRequestId: dto.clientRequestId ?? null,
        source: dto.source,
        orderId: dto.source === 'ORDER' ? dto.orderId! : null,
        saleId: dto.source === 'SALE' ? dto.saleId! : null,
        ...totals,
        posPaidAmount,
        notes: dto.notes ?? null,
        createdById: me.userId,
      },
    });
    await tx.invoiceLine.createMany({ data: lines.map((l) => ({ ...l, invoiceId: inv.id })) });
    await this.audit.record(
      { action: 'INVOICE_DRAFTED', entityType: 'Invoice', entityId: inv.id, establishmentId: est.id, newValues: { source: inv.source, orderId: inv.orderId, saleId: inv.saleId, customerId, total: inv.total, lines: lines.length } },
      tx,
    );
    return inv.id;
  }

  /** Lignes d'une facture manuelle : frais du module 7 au prix et au taux saisis (aucun produit : pas de vente sans sortie de stock). */
  private async manualLines(tx: Tx, me: AuthUser, establishmentId: string, dto: DocumentLineDto[]): Promise<Line[]> {
    if (dto.some((l) => l.kind !== 'FEE')) throw new BadRequestException('Une facture manuelle ne contient que des frais ; un produit se facture depuis sa commande ou son ticket');
    return (await priceLines(tx, me, establishmentId, dto)).lines.map(({ madeToOrder: _m, ...l }) => l);
  }

  async update(me: AuthUser, id: string, dto: UpdateInvoiceDto) {
    await this.prisma.$transaction(async (tx) => {
      const inv = await this.locked(tx, me, id);
      this.assertCan(me, inv.establishmentId, MANAGE);
      if (inv.status !== 'DRAFT') throw new ConflictException('Facture émise : elle ne se corrige que par un avoir');
      const data: Prisma.InvoiceUpdateInput = {};
      if (dto.notes !== undefined) data.notes = dto.notes;
      if (dto.lines) {
        if (inv.source !== 'MANUAL') throw new BadRequestException('Les lignes d’une facture de commande ou de ticket viennent de leur document');
        const lines = await this.manualLines(tx, me, inv.establishmentId, dto.lines);
        await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
        await tx.invoiceLine.createMany({ data: lines.map((l) => ({ ...l, invoiceId: id })) });
        data.total = lines.reduce((s, l) => s + l.lineTotal, 0n);
        data.taxTotal = lines.reduce((s, l) => s + l.taxAmount, 0n);
      }
      const updated = await tx.invoice.update({ where: { id }, data });
      await this.audit.record({ action: 'INVOICE_DRAFT_UPDATED', entityType: 'Invoice', entityId: id, establishmentId: inv.establishmentId, oldValues: { total: inv.total }, newValues: { total: updated.total } }, tx);
    });
    return this.get(me, id);
  }

  private async locked(tx: Tx, me: AuthUser, id: string) {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id}::uuid FOR UPDATE`;
    const inv = await tx.invoice.findFirst({ where: { id, companyId: me.companyId } });
    if (!inv || !this.canRead(me, inv.establishmentId)) throw new NotFoundException('Facture introuvable');
    return inv;
  }

  // --- Émission et états ----------------------------------------------------------------------

  /** Émission atomique : numéro FAC, échéance selon les conditions du client, audit (décision D2). */
  async issue(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const inv = await this.locked(tx, me, id);
      this.assertCan(me, inv.establishmentId, MANAGE);
      if (inv.status !== 'DRAFT') throw new ConflictException(inv.status === 'CANCELLED' ? 'Brouillon abandonné' : 'Facture déjà émise');
      if (inv.orderId) {
        await lockRowOf(tx, 'customer_orders', inv.orderId);
        const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: inv.orderId } });
        if (!INVOICEABLE_ORDER.includes(order.status)) throw new ConflictException(`Commande ${order.number} annulée : facture impossible`);
      }
      if (inv.saleId) {
        // Même verrou que l'annulation et le remboursement du ticket au module 5.
        await tx.$queryRaw`SELECT id FROM sales WHERE id = ${inv.saleId}::uuid FOR UPDATE`;
        const sale = await tx.sale.findUniqueOrThrow({ where: { id: inv.saleId } });
        if (sale.status !== 'COMPLETED') throw new ConflictException(`Ticket ${sale.number} annulé ou remboursé : facture impossible`);
      }
      const customer = await activeCustomer(tx, me, inv.customerId);
      const est = await tx.establishment.findUniqueOrThrow({ where: { id: inv.establishmentId } });
      const issuedAt = new Date();
      const paymentTermDays = inv.source === 'SALE' ? 0 : customer.paymentTermDays;
      const number = await this.sequences.next(tx, { companyId: me.companyId, docType: 'INVOICE', establishmentId: est.id, establishmentCode: est.code, date: issuedAt });
      const dueDate = addDays(issuedAt.toISOString().slice(0, 10), paymentTermDays);
      await tx.invoice.update({ where: { id }, data: { status: 'ISSUED', number, issuedAt, issuedById: me.userId, paymentTermDays, dueDate } });
      await this.audit.record(
        { action: 'INVOICE_ISSUED', entityType: 'Invoice', entityId: id, establishmentId: est.id, oldValues: { status: 'DRAFT' }, newValues: { number, total: inv.total, taxTotal: inv.taxTotal, dueDate: dueDate.toISOString().slice(0, 10), paymentTermDays } },
        tx,
      );
    });
    return this.get(me, id);
  }

  /** Abandon d'un brouillon (jamais numéroté, jamais supprimé). */
  async cancelDraft(me: AuthUser, id: string, dto: InvoiceReasonDto) {
    await this.prisma.$transaction(async (tx) => {
      const inv = await this.locked(tx, me, id);
      this.assertCan(me, inv.establishmentId, MANAGE);
      if (inv.status !== 'DRAFT') throw new ConflictException('Facture émise : elle s’annule par un avoir total');
      await tx.invoice.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: me.userId, cancelReason: dto.reason } });
      await this.audit.record({ action: 'INVOICE_DRAFT_CANCELLED', entityType: 'Invoice', entityId: id, establishmentId: inv.establishmentId, oldValues: { status: 'DRAFT' }, newValues: { status: 'CANCELLED' }, reason: dto.reason }, tx);
    });
    return this.get(me, id);
  }

  async dispute(me: AuthUser, id: string, dto: InvoiceReasonDto, open: boolean) {
    await this.prisma.$transaction(async (tx) => {
      const inv = await this.locked(tx, me, id);
      this.assertCan(me, inv.establishmentId, MANAGE);
      const [from, to]: InvoiceStatus[] = open ? ['ISSUED', 'DISPUTED'] : ['DISPUTED', 'ISSUED'];
      if (inv.status !== from) throw new ConflictException(open ? 'Seule une facture émise passe en litige' : 'Cette facture n’est pas en litige');
      await tx.invoice.update({ where: { id }, data: open ? { status: to, disputedAt: new Date(), disputeReason: dto.reason } : { status: to } });
      await this.audit.record(
        { action: open ? 'INVOICE_DISPUTED' : 'INVOICE_DISPUTE_RESOLVED', entityType: 'Invoice', entityId: id, establishmentId: inv.establishmentId, oldValues: { status: from }, newValues: { number: inv.number, status: to }, reason: dto.reason },
        tx,
      );
    });
    return this.get(me, id);
  }

  // --- Règlements ---------------------------------------------------------------------------

  /** Reste dû sous verrou de la facture. */
  private async dueOf(tx: Tx, inv: Invoice) {
    return (await invoiceBalances(tx, [inv])).get(inv.id)!.balance;
  }

  /**
   * Rapproche un paiement reçu (partie non répartie) ou un acompte disponible
   * de la facture. Verrous : facture, puis acompte, puis paiements (ordre fixe).
   */
  async allocate(me: AuthUser, id: string, dto: AllocateDto) {
    await this.prisma.$transaction((tx) => this.doAllocate(tx, me, id, dto));
    return this.get(me, id);
  }

  private async doAllocate(tx: Tx, me: AuthUser, id: string, dto: AllocateDto) {
    if (!!dto.paymentId === !!dto.depositId) throw new BadRequestException('Indiquer soit un paiement, soit un acompte');
    const inv = await this.locked(tx, me, id);
    this.assertCan(me, inv.establishmentId, PAY);
    if (!OPEN.includes(inv.status)) throw new ConflictException('Seule une facture émise reçoit des paiements');
    const amount = BigInt(dto.amount);
    const due = await this.dueOf(tx, inv);
    if (amount > due) throw new ConflictException(`Reste dû de la facture ${inv.number} : ${due > 0n ? due : 0n} FCFA`);
    if (dto.paymentId) {
      await tx.$queryRaw`SELECT id FROM customer_payments WHERE id = ${dto.paymentId}::uuid FOR UPDATE`;
      const p = await tx.customerPayment.findFirst({ where: { id: dto.paymentId, companyId: me.companyId } });
      if (!p) throw new NotFoundException('Paiement introuvable');
      if (p.status !== 'RECORDED') throw new ConflictException(`Paiement ${p.number} annulé`);
      if (p.customerId !== inv.customerId || p.establishmentId !== inv.establishmentId) throw new BadRequestException(`Paiement ${p.number} : autre client ou autre établissement`);
      const used = (await tx.paymentAllocation.aggregate({ where: { paymentId: p.id, releasedAt: null }, _sum: { amount: true } }))._sum.amount ?? 0n;
      if (amount > p.amount - used) throw new ConflictException(`Paiement ${p.number} : il ne reste que ${p.amount - used} FCFA à répartir`);
      await tx.paymentAllocation.create({ data: { paymentId: p.id, target: 'INVOICE', invoiceId: id, amount, createdById: me.userId } });
      await this.audit.record({ action: 'INVOICE_PAYMENT_ALLOCATED', entityType: 'Invoice', entityId: id, establishmentId: inv.establishmentId, newValues: { number: inv.number, payment: p.number, amount } }, tx);
      return;
    }
    // Acompte : sa part financée par chaque paiement passe de l'acompte à la facture.
    await tx.$queryRaw`SELECT id FROM deposits WHERE id = ${dto.depositId}::uuid FOR UPDATE`;
    const d = await tx.deposit.findFirst({ where: { id: dto.depositId, companyId: me.companyId } });
    if (!d) throw new NotFoundException('Acompte introuvable');
    if (d.customerId !== inv.customerId || d.establishmentId !== inv.establishmentId) throw new BadRequestException(`Acompte ${d.number} : autre client ou autre établissement`);
    if (!['RECEIVED', 'CUSTOMER_CREDIT'].includes(d.status)) throw new ConflictException(`Acompte ${d.number} remboursé ou annulé`);
    const rows = await tx.paymentAllocation.findMany({ where: { depositId: d.id, releasedAt: null }, orderBy: { createdAt: 'asc' } });
    const applied = rows.filter((r) => r.target === 'INVOICE').reduce((s, r) => s + r.amount, 0n);
    const available = d.amount - d.refundedAmount - applied;
    if (amount > available) throw new ConflictException(`Acompte ${d.number} : ${available} FCFA disponibles`);
    const funding = rows.filter((r) => r.target === 'DEPOSIT');
    await tx.$queryRaw`SELECT id FROM customer_payments WHERE id IN (${Prisma.join([...new Set(funding.map((r) => r.paymentId))].sort().map((x) => Prisma.sql`${x}::uuid`))}) ORDER BY id FOR UPDATE`;
    let rest = amount;
    for (const r of funding) {
      if (rest <= 0n) break;
      const take = r.amount < rest ? r.amount : rest;
      await tx.paymentAllocation.update({ where: { id: r.id }, data: { releasedAt: new Date(), releasedById: me.userId, releaseReason: `Imputation sur la facture ${inv.number}` } });
      if (r.amount > take) await tx.paymentAllocation.create({ data: { paymentId: r.paymentId, target: 'DEPOSIT', depositId: d.id, amount: r.amount - take, createdById: me.userId } });
      await tx.paymentAllocation.create({ data: { paymentId: r.paymentId, target: 'INVOICE', invoiceId: id, depositId: d.id, amount: take, createdById: me.userId } });
      rest -= take;
    }
    if (rest > 0n) throw new ConflictException(`Acompte ${d.number} : financement insuffisant`);
    await this.audit.record({ action: 'INVOICE_DEPOSIT_APPLIED', entityType: 'Invoice', entityId: id, establishmentId: inv.establishmentId, newValues: { number: inv.number, deposit: d.number, amount } }, tx);
  }

  /** Encaissement direct d'une facture : paiement de l'étape 4 (caisse ou hors caisse) puis répartition, dans une seule transaction. */
  pay(me: AuthUser, id: string, dto: PayInvoiceDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.customerPayment
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((p) => p && { id: p.id, ownerId: p.createdById }),
      async () => {
        await this.prisma.$transaction(async (tx) => {
          const inv = await this.locked(tx, me, id);
          this.assertCan(me, inv.establishmentId, PAY);
          if (!OPEN.includes(inv.status)) throw new ConflictException('Seule une facture émise reçoit des paiements');
          const due = await this.dueOf(tx, inv);
          if (BigInt(dto.amount) > due) throw new ConflictException(`Reste dû de la facture ${inv.number} : ${due > 0n ? due : 0n} FCFA`);
          const est = await tx.establishment.findUniqueOrThrow({ where: { id: inv.establishmentId } });
          const p = await this.payments.insertPayment(tx, me, est, inv.customerId, dto, { clientRequestId: dto.clientRequestId ?? null, notes: `Facture ${inv.number}` });
          await this.doAllocate(tx, me, id, { paymentId: p.id, amount: dto.amount });
        });
        return this.get(me, id);
      },
      () => this.get(me, id),
    );
  }

  // --- Avoirs ---------------------------------------------------------------------------------

  createCreditNote(me: AuthUser, id: string, dto: CreateCreditNoteDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.creditNote
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((c) => c && { id: c.id, ownerId: c.createdById }),
      async () => {
        const cnId = await this.prisma.$transaction((tx) => this.doCreditNote(tx, me, id, dto));
        return this.getCreditNote(me, cnId);
      },
      (cnId) => this.getCreditNote(me, cnId),
    );
  }

  /**
   * Avoir émis directement (numéro AVR dans la transaction), plafonné ligne par
   * ligne au montant encore corrigeable. Il réduit d'abord le reste dû ; la
   * part déjà payée devient un crédit du client (répartitions libérées : avance
   * réutilisable, ou retour à l'acompte d'origine) ou est remboursée par la
   * caisse ou hors caisse. Aucun stock ne bouge. Avoir total = facture annulée.
   */
  private async doCreditNote(tx: Tx, me: AuthUser, id: string, dto: CreateCreditNoteDto) {
    const inv = await this.locked(tx, me, id);
    this.assertCan(me, inv.establishmentId, MANAGE);
    if (!OPEN.includes(inv.status)) throw new ConflictException(inv.status === 'DRAFT' ? 'Brouillon : modifiez-le au lieu d’établir un avoir' : 'Facture annulée');
    const lines = await tx.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { position: 'asc' }, include: { creditLines: true } });
    const remaining = (l: (typeof lines)[number]) => l.lineTotal - l.creditLines.reduce((s, c) => s + c.amount, 0n);
    const plan: { line: (typeof lines)[number]; quantity: Prisma.Decimal | null; amount: bigint; taxAmount: bigint }[] = [];
    const wanted = dto.full ? lines.filter((l) => remaining(l) > 0n).map((l) => ({ invoiceLineId: l.id, amount: Number(remaining(l)), quantity: undefined })) : dto.lines!;
    for (const w of wanted) {
      const line = lines.find((l) => l.id === w.invoiceLineId);
      if (!line) throw new BadRequestException('Ligne de facture invalide');
      if (plan.some((p) => p.line.id === line.id)) throw new BadRequestException(`« ${line.label} » citée deux fois`);
      const left = remaining(line);
      let amount: bigint;
      let quantity: Prisma.Decimal | null = null;
      if (w.quantity !== undefined) {
        quantity = D(w.quantity);
        if (quantity.gt(line.quantity)) throw new BadRequestException(`« ${line.label} » : quantité supérieure à la quantité facturée`);
        amount = roundXof(D(line.lineTotal.toString()).mul(quantity).div(line.quantity));
      } else amount = BigInt(w.amount!);
      if (amount <= 0n) throw new BadRequestException(`« ${line.label} » : montant nul`);
      if (amount > left) throw new ConflictException(`« ${line.label} » : il ne reste que ${left} FCFA corrigeables`);
      // Le reliquat exact de TVA de la ligne pour un avoir qui la solde, sinon la TVA incluse au taux de la ligne.
      const taxAmount = amount === left ? line.taxAmount - line.creditLines.reduce((s, c) => s + c.taxAmount, 0n) : taxIncluded(amount, D(line.taxRate));
      plan.push({ line, quantity, amount, taxAmount });
    }
    if (!plan.length) throw new ConflictException('Plus rien à corriger sur cette facture');
    const total = plan.reduce((s, p) => s + p.amount, 0n);
    const before = (await invoiceBalances(tx, [inv])).get(inv.id)!;
    const correctable = inv.total - before.credited;
    if (total > correctable) throw new ConflictException(`Avoir supérieur au montant corrigeable (${correctable} FCFA)`);
    const due = before.balance > 0n ? before.balance : 0n;
    const reducedDue = total < due ? total : due;
    const excess = total - reducedDue;
    if (excess > 0n && !dto.settlement) throw new BadRequestException(`Facture déjà payée : indiquez le règlement des ${excess} FCFA (crédit client ou remboursement)`);
    if (excess === 0n && dto.settlement) throw new BadRequestException('Rien à rembourser : l’avoir réduit seulement le reste dû');
    const mode = excess > 0n ? dto.settlement!.mode : null;
    if (mode === 'REFUND') this.assertCan(me, inv.establishmentId, PAY, 'sales.refund');
    if (mode === 'CUSTOMER_CREDIT') this.assertCan(me, inv.establishmentId, PAY);

    const est = await tx.establishment.findUniqueOrThrow({ where: { id: inv.establishmentId } });
    const cn = await tx.creditNote.create({
      data: {
        companyId: me.companyId,
        establishmentId: inv.establishmentId,
        customerId: inv.customerId,
        invoiceId: id,
        number: await this.sequences.next(tx, { companyId: me.companyId, docType: 'CREDIT_NOTE', establishmentId: est.id, establishmentCode: est.code }),
        clientRequestId: dto.clientRequestId ?? null,
        total,
        taxTotal: plan.reduce((s, p) => s + p.taxAmount, 0n),
        reason: dto.reason,
        reducedDue,
        customerCredit: mode === 'CUSTOMER_CREDIT' ? excess : 0n,
        refundAmount: mode === 'REFUND' ? excess : 0n,
        createdById: me.userId,
      },
    });
    await tx.creditNoteLine.createMany({
      data: plan.map((p) => ({ creditNoteId: cn.id, invoiceLineId: p.line.id, label: p.line.label, quantity: p.quantity, amount: p.amount, taxRate: p.line.taxRate, taxAmount: p.taxAmount })),
    });
    if (mode === 'CUSTOMER_CREDIT') await this.releaseToCustomer(tx, me, inv, excess, `Avoir ${cn.number}`);
    let refundId: string | null = null;
    if (mode === 'REFUND') refundId = await this.refund(tx, me, inv, cn, excess, dto.settlement!.refund, dto.reason);
    const cancelled = total === correctable;
    if (cancelled) await tx.invoice.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: me.userId, cancelReason: `Avoir total ${cn.number} : ${dto.reason}` } });
    await this.audit.record(
      {
        action: 'CREDIT_NOTE_ISSUED',
        entityType: 'CreditNote',
        entityId: cn.id,
        establishmentId: inv.establishmentId,
        newValues: { number: cn.number, invoice: inv.number, total, reducedDue, customerCredit: cn.customerCredit, refundAmount: cn.refundAmount, refundId, invoiceCancelled: cancelled },
        reason: dto.reason,
      },
      tx,
    );
    return cn.id;
  }

  /**
   * Crédit client : libère des répartitions de la facture (les plus récentes
   * d'abord). L'argent redevient une avance non répartie du paiement, ou
   * retourne à l'acompte d'où il venait.
   */
  private async releaseToCustomer(tx: Tx, me: AuthUser, inv: Invoice, amount: bigint, reason: string) {
    const rows = await tx.paymentAllocation.findMany({ where: { invoiceId: inv.id, releasedAt: null }, orderBy: { createdAt: 'desc' } });
    if (rows.reduce((s, r) => s + r.amount, 0n) < amount) throw new ConflictException('Facture réglée à la caisse : la part payée se rembourse (règlement « remboursement »)');
    const depositIds = [...new Set(rows.map((r) => r.depositId).filter((x): x is string => !!x))].sort();
    if (depositIds.length) await tx.$queryRaw`SELECT id FROM deposits WHERE id IN (${Prisma.join(depositIds.map((x) => Prisma.sql`${x}::uuid`))}) ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM customer_payments WHERE id IN (${Prisma.join([...new Set(rows.map((r) => r.paymentId))].sort().map((x) => Prisma.sql`${x}::uuid`))}) ORDER BY id FOR UPDATE`;
    let rest = amount;
    for (const r of rows) {
      if (rest <= 0n) break;
      const take = r.amount < rest ? r.amount : rest;
      await tx.paymentAllocation.update({ where: { id: r.id }, data: { releasedAt: new Date(), releasedById: me.userId, releaseReason: reason } });
      if (r.amount > take) await tx.paymentAllocation.create({ data: { paymentId: r.paymentId, target: 'INVOICE', invoiceId: inv.id, depositId: r.depositId, amount: r.amount - take, createdById: me.userId } });
      if (r.depositId) await tx.paymentAllocation.create({ data: { paymentId: r.paymentId, target: 'DEPOSIT', depositId: r.depositId, amount: take, createdById: me.userId } });
      rest -= take;
    }
  }

  /** Remboursement de la part payée : caisse de celui qui rembourse (module 5) ou virement / chèque. */
  private async refund(tx: Tx, me: AuthUser, inv: Invoice, cn: { id: string; number: string }, amount: bigint, money: MoneyDto | undefined, reason: string) {
    if (!money) throw new BadRequestException('Moyen de remboursement obligatoire');
    if (BigInt(money.amount) !== amount) throw new BadRequestException(`Le remboursement doit être de ${amount} FCFA`);
    const provider = providerFor(money.method);
    const reference = provider.confirm({ method: money.method, amount, reference: money.reference ?? null });
    const offRegister = OFF_REGISTER.has(money.method);
    if (offRegister && money.sessionId) throw new BadRequestException(`${METHOD_LABELS[money.method]} : remboursement hors caisse, sans session`);
    if (!offRegister && !money.sessionId) throw new BadRequestException(`${METHOD_LABELS[money.method]} : une session de caisse ouverte est obligatoire`);
    const movement = offRegister
      ? null
      : await customerCashMovement(tx, me, { sessionId: money.sessionId!, establishmentId: inv.establishmentId, type: 'CUSTOMER_REFUND', method: money.method, amount, reason: `Remboursement avoir ${cn.number} : ${reason}`, ownSession: true });
    const r = await tx.customerRefund.create({
      data: {
        companyId: me.companyId,
        establishmentId: inv.establishmentId,
        customerId: inv.customerId,
        creditNoteId: cn.id,
        method: money.method,
        amount,
        reference,
        provider: provider.code,
        sessionId: movement?.sessionId ?? null,
        cashMovementId: movement?.id ?? null,
        reason,
        createdById: me.userId,
      },
    });
    return r.id;
  }
}

@ApiTags('Clients')
@ApiBearerAuth()
@Controller()
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  @Get('invoices')
  list(@CurrentUser() me: AuthUser, @Query() q: InvoiceQuery) {
    return this.service.list(me, q);
  }

  @Get('invoices/:id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post('invoices')
  @RequirePermissions(MANAGE)
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateInvoiceDto) {
    return this.service.create(me, dto);
  }

  @Patch('invoices/:id')
  @RequirePermissions(MANAGE)
  @AnyEstablishmentScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInvoiceDto) {
    return this.service.update(me, id, dto);
  }

  @Post('invoices/:id/issue')
  @RequirePermissions(MANAGE)
  @AnyEstablishmentScope()
  issue(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.issue(me, id);
  }

  @Post('invoices/:id/cancel')
  @RequirePermissions(MANAGE)
  @AnyEstablishmentScope()
  cancelDraft(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InvoiceReasonDto) {
    return this.service.cancelDraft(me, id, dto);
  }

  @Post('invoices/:id/dispute')
  @RequirePermissions(MANAGE)
  @AnyEstablishmentScope()
  dispute(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InvoiceReasonDto) {
    return this.service.dispute(me, id, dto, true);
  }

  @Post('invoices/:id/resolve-dispute')
  @RequirePermissions(MANAGE)
  @AnyEstablishmentScope()
  resolve(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InvoiceReasonDto) {
    return this.service.dispute(me, id, dto, false);
  }

  @Post('invoices/:id/allocations')
  @RequirePermissions(PAY)
  @AnyEstablishmentScope()
  allocate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AllocateDto) {
    return this.service.allocate(me, id, dto);
  }

  @Post('invoices/:id/payments')
  @RequirePermissions(PAY)
  @AnyEstablishmentScope()
  pay(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayInvoiceDto) {
    return this.service.pay(me, id, dto);
  }

  @Post('invoices/:id/credit-notes')
  @RequirePermissions(MANAGE)
  @AnyEstablishmentScope()
  createCreditNote(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCreditNoteDto) {
    return this.service.createCreditNote(me, id, dto);
  }

  @Get('credit-notes/:id')
  getCreditNote(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getCreditNote(me, id);
  }
}
