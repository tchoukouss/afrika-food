import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PaymentMethod, SupplierInvoiceStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
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
import { dateOnly, establishmentFor, idempotent, lockRow, nextNumber, readableEstablishments, todayISO, userNames } from './common';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);
const MAX_AMOUNT = 1_000_000_000_000;

/** Statut d'une facture recalculé à partir du montant réglé (paiements + avoirs imputés). */
export async function refreshInvoiceStatus(tx: Tx, invoiceId: string) {
  const inv = await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (inv.status === 'CANCELLED') return;
  const status: SupplierInvoiceStatus = inv.paidAmount === 0n ? 'OPEN' : inv.paidAmount >= inv.amount ? 'PAID' : 'PARTIALLY_PAID';
  if (status !== inv.status) await tx.supplierInvoice.update({ where: { id: invoiceId }, data: { status } });
}

export class CreateInvoiceDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsUUID() supplierId: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) supplierRef: string;
  @IsDateString() invoiceDate: string;
  /** Par défaut : date de facture + délai de paiement du fournisseur. */
  @IsOptional() @IsDateString() dueDate?: string;
  @IsInt() @Min(1) @Max(MAX_AMOUNT) amount: number;
  @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) receiptIds: string[];
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

export class CancelDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class AllocationDto {
  @IsUUID() invoiceId: string;
  @IsInt() @Min(1) @Max(MAX_AMOUNT) amount: number;
}

export class CreatePaymentDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsUUID() supplierId: string;
  @IsInt() @Min(1) @Max(MAX_AMOUNT) amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(80) reference?: string | null;
  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  /** Répartition sur les factures ; le reste éventuel constitue une avance. */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AllocationDto) allocations?: AllocationDto[];
}

class FinanceQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsEnum(SupplierInvoiceStatus) status?: SupplierInvoiceStatus;
}

@Injectable()
export class SupplierFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private scope(me: AuthUser, requested?: string) {
    const ids = readableEstablishments(me, 'purchases.view');
    const pay = readableEstablishments(me, 'supplier_payments.manage');
    const all = [...new Set([...ids, ...pay])];
    if (requested && !all.includes(requested)) throw new BadRequestException('Établissement non accessible');
    return requested ? [requested] : all;
  }

  // Factures ----------------------------------------------------------------

  async listInvoices(me: AuthUser, q: FinanceQuery) {
    const rows = await this.prisma.supplierInvoice.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.scope(me, q.establishmentId) }, supplierId: q.supplierId, status: q.status },
      orderBy: [{ dueDate: 'asc' }],
      take: 300,
      include: { receipts: { select: { receipt: { select: { id: true, number: true, totalValue: true } } } } },
    });
    const suppliers = await this.prisma.supplier.findMany({ where: { id: { in: rows.map((r) => r.supplierId) } }, select: { id: true, code: true, name: true } });
    const today = todayISO();
    return rows.map(({ receipts, ...r }) => ({
      ...r,
      supplier: suppliers.find((s) => s.id === r.supplierId) ?? null,
      receipts: receipts.map((x) => x.receipt),
      remaining: r.amount - r.paidAmount,
      variance: r.amount - r.receivedValue,
      isOverdue: ['OPEN', 'PARTIALLY_PAID'].includes(r.status) && r.dueDate.toISOString().slice(0, 10) < today,
    }));
  }

  createInvoice(me: AuthUser, dto: CreateInvoiceDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.supplierInvoice
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((r) => r && { id: r.id, ownerId: r.createdById }),
      () => this.doCreateInvoice(me, dto),
      (id) => this.prisma.supplierInvoice.findUniqueOrThrow({ where: { id } }).then((inv) => ({ ...inv, variance: inv.amount - inv.receivedValue })),
    );
  }

  private async doCreateInvoice(me: AuthUser, dto: CreateInvoiceDto) {
    return this.prisma.$transaction(async (tx) => {
      const est = await establishmentFor(tx, me, dto.establishmentId, 'supplier_payments.manage');
      await lockRow(tx, 'suppliers', dto.supplierId);
      const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, companyId: me.companyId } });
      if (!supplier) throw new BadRequestException('Fournisseur invalide');

      // Une même facture fournisseur ne peut pas être saisie deux fois.
      const dup = await tx.supplierInvoice.findFirst({ where: { supplierId: supplier.id, supplierRef: dto.supplierRef, status: { not: 'CANCELLED' } } });
      if (dup) throw new ConflictException(`La facture ${dto.supplierRef} de ce fournisseur est déjà enregistrée (${dup.number})`);

      // Réceptions : du même fournisseur, et pas déjà facturées.
      const receiptIds = [...new Set(dto.receiptIds)];
      for (const rid of receiptIds.sort()) await lockRow(tx, 'goods_receipts', rid);
      const receipts = await tx.goodsReceipt.findMany({
        where: { id: { in: receiptIds }, companyId: me.companyId },
        include: { invoiceLinks: { where: { invoice: { status: { not: 'CANCELLED' } } }, include: { invoice: { select: { number: true } } } } },
      });
      if (receipts.length !== receiptIds.length) throw new BadRequestException('Réception invalide');
      for (const r of receipts) {
        if (r.supplierId !== supplier.id) throw new BadRequestException(`La réception ${r.number} est d’un autre fournisseur`);
        if (r.invoiceLinks.length) throw new ConflictException(`La réception ${r.number} est déjà facturée (${r.invoiceLinks[0].invoice.number})`);
      }
      const receivedValue = receipts.reduce((s, r) => s + r.totalValue, 0n);

      const invoiceDate = dateOnly(dto.invoiceDate);
      const dueDate = dto.dueDate ? dateOnly(dto.dueDate) : new Date(invoiceDate.getTime() + supplier.paymentTermsDays * 86_400_000);
      if (dueDate < invoiceDate) throw new BadRequestException('L’échéance précède la date de facture');

      const inv = await tx.supplierInvoice.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          number: await nextNumber(tx, me.companyId, 'SUPPLIER_INVOICE', est),
          supplierId: supplier.id,
          supplierRef: dto.supplierRef,
          invoiceDate,
          dueDate,
          amount: BigInt(dto.amount),
          receivedValue,
          notes: dto.notes ?? null,
          createdById: me.userId,
          clientRequestId: dto.clientRequestId ?? null,
          receipts: { create: receipts.map((r) => ({ receiptId: r.id })) },
        },
      });
      await this.audit.record(
        {
          action: 'SUPPLIER_INVOICE_RECORDED',
          entityType: 'SupplierInvoice',
          entityId: inv.id,
          establishmentId: est.id,
          newValues: { number: inv.number, supplierRef: dto.supplierRef, amount: inv.amount, receivedValue, variance: inv.amount - receivedValue, receipts: receipts.map((r) => r.number) },
        },
        tx,
      );
      return { ...inv, variance: inv.amount - receivedValue };
    });
  }

  /** Annulation tracée, possible uniquement sans règlement ; les réceptions redeviennent facturables. */
  async cancelInvoice(me: AuthUser, id: string, dto: CancelDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'supplier_invoices', id);
      const inv = await tx.supplierInvoice.findFirst({ where: { id, companyId: me.companyId } });
      if (!inv) throw new NotFoundException('Facture introuvable');
      await establishmentFor(tx, me, inv.establishmentId, 'supplier_payments.manage');
      if (inv.status === 'CANCELLED') throw new ConflictException('Facture déjà annulée');
      if (inv.paidAmount > 0n) throw new ConflictException('Facture déjà (partiellement) réglée : annulez d’abord les paiements');
      const updated = await tx.supplierInvoice.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledById: me.userId, cancelledAt: new Date(), cancelReason: dto.reason },
      });
      await this.audit.record({ action: 'SUPPLIER_INVOICE_CANCELLED', entityType: 'SupplierInvoice', entityId: id, establishmentId: inv.establishmentId, reason: dto.reason, oldValues: { status: inv.status } }, tx);
      return updated;
    });
  }

  // Paiements ----------------------------------------------------------------

  /** Imputation d'un montant sur une facture (verrouillée) sans dépasser son reste à payer. */
  private async allocate(tx: Tx, me: AuthUser, paymentId: string, supplierId: string, a: AllocationDto) {
    await lockRow(tx, 'supplier_invoices', a.invoiceId);
    const inv = await tx.supplierInvoice.findFirst({ where: { id: a.invoiceId, companyId: me.companyId } });
    if (!inv || inv.supplierId !== supplierId) throw new BadRequestException('Facture invalide pour ce fournisseur');
    if (inv.status === 'CANCELLED') throw new ConflictException(`La facture ${inv.number} est annulée`);
    const remaining = inv.amount - inv.paidAmount;
    if (BigInt(a.amount) > remaining) {
      throw new BadRequestException(`Montant supérieur au reste à payer de la facture ${inv.number} (${remaining} FCFA)`);
    }
    await tx.supplierPaymentAllocation.create({ data: { paymentId, invoiceId: inv.id, amount: BigInt(a.amount) } });
    await tx.supplierInvoice.update({ where: { id: inv.id }, data: { paidAmount: { increment: BigInt(a.amount) } } });
    await refreshInvoiceStatus(tx, inv.id);
  }

  createPayment(me: AuthUser, dto: CreatePaymentDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.supplierPayment
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((r) => r && { id: r.id, ownerId: r.createdById }),
      () => this.doCreatePayment(me, dto),
      (id) => this.prisma.supplierPayment.findUniqueOrThrow({ where: { id } }),
    );
  }

  private async doCreatePayment(me: AuthUser, dto: CreatePaymentDto) {
    const allocations = dto.allocations ?? [];
    const ids = allocations.map((a) => a.invoiceId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Une facture apparaît deux fois');
    if (allocations.reduce((s, a) => s + a.amount, 0) > dto.amount) throw new BadRequestException('La répartition dépasse le montant payé');
    return this.prisma.$transaction(async (tx) => {
      const est = await establishmentFor(tx, me, dto.establishmentId, 'supplier_payments.manage');
      const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, companyId: me.companyId } });
      if (!supplier) throw new BadRequestException('Fournisseur invalide');
      const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
      if (paidAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('Date de paiement dans le futur');
      const payment = await tx.supplierPayment.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          number: await nextNumber(tx, me.companyId, 'SUPPLIER_PAYMENT', est),
          supplierId: supplier.id,
          amount: BigInt(dto.amount),
          method: dto.method,
          reference: dto.reference ?? null,
          paidAt,
          notes: dto.notes ?? null,
          createdById: me.userId,
          clientRequestId: dto.clientRequestId ?? null,
        },
      });
      // Ordre stable des verrous pour éviter les interblocages entre paiements simultanés.
      for (const a of [...allocations].sort((x, y) => x.invoiceId.localeCompare(y.invoiceId))) {
        await this.allocate(tx, me, payment.id, supplier.id, a);
      }
      await this.audit.record(
        {
          action: 'SUPPLIER_PAYMENT_RECORDED',
          entityType: 'SupplierPayment',
          entityId: payment.id,
          establishmentId: est.id,
          newValues: { number: payment.number, amount: payment.amount, method: dto.method, allocations, advance: dto.amount - allocations.reduce((s, a) => s + a.amount, 0) },
        },
        tx,
      );
      return payment;
    });
  }

  /** Affecte tout ou partie d'une avance à une facture. */
  async allocateAdvance(me: AuthUser, paymentId: string, dto: AllocationDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'supplier_payments', paymentId);
      const p = await tx.supplierPayment.findFirst({ where: { id: paymentId, companyId: me.companyId }, include: { allocations: true } });
      if (!p) throw new NotFoundException('Paiement introuvable');
      await establishmentFor(tx, me, p.establishmentId, 'supplier_payments.manage');
      if (p.cancelledAt) throw new ConflictException('Paiement annulé');
      const free = p.amount - p.allocations.reduce((s, a) => s + a.amount, 0n);
      if (BigInt(dto.amount) > free) throw new BadRequestException(`Avance disponible insuffisante (${free} FCFA)`);
      await this.allocate(tx, me, p.id, p.supplierId, dto);
      await this.audit.record({ action: 'SUPPLIER_ADVANCE_ALLOCATED', entityType: 'SupplierPayment', entityId: p.id, establishmentId: p.establishmentId, newValues: { ...dto } }, tx);
      return { ok: true };
    });
  }

  /** Annulation tracée d'un paiement : ses imputations sont retirées des factures. */
  async cancelPayment(me: AuthUser, id: string, dto: CancelDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'supplier_payments', id);
      const p = await tx.supplierPayment.findFirst({ where: { id, companyId: me.companyId }, include: { allocations: true } });
      if (!p) throw new NotFoundException('Paiement introuvable');
      await establishmentFor(tx, me, p.establishmentId, 'supplier_payments.manage');
      if (p.cancelledAt) throw new ConflictException('Paiement déjà annulé');
      for (const a of [...p.allocations].sort((x, y) => x.invoiceId.localeCompare(y.invoiceId))) {
        await lockRow(tx, 'supplier_invoices', a.invoiceId);
        await tx.supplierInvoice.update({ where: { id: a.invoiceId }, data: { paidAmount: { decrement: a.amount } } });
        await refreshInvoiceStatus(tx, a.invoiceId);
      }
      const updated = await tx.supplierPayment.update({ where: { id }, data: { cancelledById: me.userId, cancelledAt: new Date(), cancelReason: dto.reason } });
      await this.audit.record(
        { action: 'SUPPLIER_PAYMENT_CANCELLED', entityType: 'SupplierPayment', entityId: id, establishmentId: p.establishmentId, reason: dto.reason, oldValues: { amount: p.amount, allocations: p.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) } },
        tx,
      );
      return updated;
    });
  }

  async listPayments(me: AuthUser, q: FinanceQuery) {
    const rows = await this.prisma.supplierPayment.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.scope(me, q.establishmentId) }, supplierId: q.supplierId },
      orderBy: { paidAt: 'desc' },
      take: 300,
      include: { allocations: { include: { invoice: { select: { id: true, number: true, supplierRef: true } } } } },
    });
    const [suppliers, names] = await Promise.all([
      this.prisma.supplier.findMany({ where: { id: { in: rows.map((r) => r.supplierId) } }, select: { id: true, code: true, name: true } }),
      userNames(this.prisma, me.companyId, rows.map((r) => r.createdById)),
    ]);
    return rows.map((r) => ({
      ...r,
      supplier: suppliers.find((s) => s.id === r.supplierId) ?? null,
      createdBy: names.get(r.createdById) ?? null,
      unallocated: r.cancelledAt ? 0n : r.amount - r.allocations.reduce((s, a) => s + a.amount, 0n),
    }));
  }

  /**
   * Compte fournisseur (niveau groupe) : facturé − avoirs − paiements = solde dû.
   * Les avances (paiements non affectés) sont déjà déduites du solde.
   */
  async account(me: AuthUser, supplierId: string) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: supplierId, companyId: me.companyId } });
    if (!supplier) throw new NotFoundException('Fournisseur introuvable');
    // Historique des achats : dernières réceptions et retours, tous établissements.
    const [history, returns] = await Promise.all([
      this.prisma.goodsReceipt.findMany({
        where: { supplierId, companyId: me.companyId },
        orderBy: { receivedAt: 'desc' },
        take: 30,
        select: {
          id: true,
          number: true,
          receivedAt: true,
          totalValue: true,
          establishmentId: true,
          purchaseOrder: { select: { number: true } },
          invoiceLinks: { where: { invoice: { status: { not: 'CANCELLED' } } }, select: { invoice: { select: { number: true } } } },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.supplierReturn.findMany({
        where: { supplierId, companyId: me.companyId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, number: true, createdAt: true, reason: true, totalValue: true, creditNote: { select: { number: true } } },
      }),
    ]);
    const [invoices, payments, credits, uninvoiced] = await Promise.all([
      this.prisma.supplierInvoice.findMany({ where: { supplierId, status: { not: 'CANCELLED' } }, orderBy: { dueDate: 'asc' } }),
      this.prisma.supplierPayment.findMany({ where: { supplierId, cancelledAt: null }, include: { allocations: true } }),
      this.prisma.supplierCreditNote.findMany({ where: { supplierId } }),
      this.prisma.goodsReceipt.findMany({
        where: { supplierId, invoiceLinks: { none: { invoice: { status: { not: 'CANCELLED' } } } } },
        select: { id: true, number: true, receivedAt: true, totalValue: true, establishmentId: true },
        orderBy: { receivedAt: 'asc' },
      }),
    ]);
    const invoiced = invoices.reduce((s, i) => s + i.amount, 0n);
    const paid = payments.reduce((s, p) => s + p.amount, 0n);
    const credited = credits.reduce((s, c) => s + c.amount, 0n);
    const advances = payments.reduce((s, p) => s + p.amount - p.allocations.reduce((x, a) => x + a.amount, 0n), 0n);
    const unappliedCredits = credits.filter((c) => !c.invoiceId).reduce((s, c) => s + c.amount, 0n);
    const today = todayISO();
    const open = invoices.filter((i) => i.status !== 'PAID');
    return {
      supplier: { id: supplier.id, code: supplier.code, name: supplier.name, paymentTermsDays: supplier.paymentTermsDays, creditLimit: supplier.creditLimit },
      invoiced,
      paid,
      credited,
      balance: invoiced - paid - credited,
      advances,
      unappliedCredits,
      overdue: open.filter((i) => i.dueDate.toISOString().slice(0, 10) < today).reduce((s, i) => s + (i.amount - i.paidAmount), 0n),
      openInvoices: open.map((i) => ({ id: i.id, number: i.number, supplierRef: i.supplierRef, dueDate: i.dueDate, amount: i.amount, paidAmount: i.paidAmount, remaining: i.amount - i.paidAmount, status: i.status })),
      uninvoicedReceipts: uninvoiced,
      uninvoicedValue: uninvoiced.reduce((s, r) => s + r.totalValue, 0n),
      purchaseHistory: history.map(({ invoiceLinks, _count, ...r }) => ({ ...r, lines: _count.items, invoice: invoiceLinks[0]?.invoice.number ?? null })),
      returns,
    };
  }
}

@ApiTags('Factures et paiements fournisseurs')
@ApiBearerAuth()
@Controller()
export class SupplierFinanceController {
  constructor(private readonly service: SupplierFinanceService) {}

  @Get('supplier-invoices')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  listInvoices(@CurrentUser() me: AuthUser, @Query() q: FinanceQuery) {
    return this.service.listInvoices(me, q);
  }

  @Post('supplier-invoices')
  @RequirePermissions('supplier_payments.manage')
  @AnyEstablishmentScope()
  createInvoice(@CurrentUser() me: AuthUser, @Body() dto: CreateInvoiceDto) {
    return this.service.createInvoice(me, dto);
  }

  @Post('supplier-invoices/:id/cancel')
  @RequirePermissions('supplier_payments.manage')
  @AnyEstablishmentScope()
  cancelInvoice(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) {
    return this.service.cancelInvoice(me, id, dto);
  }

  @Get('supplier-payments')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  listPayments(@CurrentUser() me: AuthUser, @Query() q: FinanceQuery) {
    return this.service.listPayments(me, q);
  }

  @Post('supplier-payments')
  @RequirePermissions('supplier_payments.manage')
  @AnyEstablishmentScope()
  createPayment(@CurrentUser() me: AuthUser, @Body() dto: CreatePaymentDto) {
    return this.service.createPayment(me, dto);
  }

  @Post('supplier-payments/:id/allocations')
  @RequirePermissions('supplier_payments.manage')
  @AnyEstablishmentScope()
  allocate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AllocationDto) {
    return this.service.allocateAdvance(me, id, dto);
  }

  @Post('supplier-payments/:id/cancel')
  @RequirePermissions('supplier_payments.manage')
  @AnyEstablishmentScope()
  cancelPayment(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) {
    return this.service.cancelPayment(me, id, dto);
  }

  @Get('suppliers/:id/account')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  account(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.account(me, id);
  }
}
