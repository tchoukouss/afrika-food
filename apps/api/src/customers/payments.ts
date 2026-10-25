import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CustomerPayment, DepositStatus, PaymentMethod, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { METHOD_LABELS, providerFor } from '../sales/common';
import { customerCashMovement } from '../sales/sessions';
import { SequenceService } from '../sequences/sequence.service';
import { idempotent, userNames } from '../stock/common';
import { activeCustomer, emptyToNull, lockRowOf, trim } from './lines';

const MAX_AMOUNT = 1_000_000_000;
export const PAY = 'payments.manage';
const PAY_READ = ['payments.manage', 'receivables.view', 'invoices.view'];
/** Virement et chèque : enregistrés hors caisse (décision D1 c). Les autres moyens passent par la session de caisse. */
const OFF_REGISTER = new Set<PaymentMethod>(['BANK_TRANSFER', 'CHEQUE']);
const DEPOSIT_ORDER_STATUSES = ['DRAFT', 'CONFIRMED', 'IN_PREPARATION', 'READY'];
const AVAILABLE: DepositStatus[] = ['RECEIVED', 'CUSTOMER_CREDIT'];

/** Moyen de paiement : session de caisse ouverte de l'encaisseur, sauf virement et chèque. */
export class MoneyDto {
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsInt() @Min(1) @Max(MAX_AMOUNT) amount: number;
  /** Référence de la transaction (mobile money, carte, virement, chèque…). */
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(100) reference?: string | null;
  /** Session de caisse ouverte (obligatoire hors virement et chèque). */
  @IsOptional() @IsUUID() sessionId?: string;
}

export class CreatePaymentDto extends MoneyDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsUUID() customerId: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

export class FundingDto {
  @IsUUID() paymentId: string;
  @IsInt() @Min(1) @Max(MAX_AMOUNT) amount: number;
}

export class CreateDepositDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsUUID() customerId: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  /** Encaissement de l'acompte maintenant… */
  @IsOptional() @ValidateNested() @Type(() => MoneyDto) payment?: MoneyDto;
  /** …ou répartition de paiements déjà reçus (partie non répartie). */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => FundingDto) funding?: FundingDto[];
}

export class RefundDepositDto extends MoneyDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class ReasonDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class PaymentQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() customerId?: string;
}

class DepositQuery extends PaymentQuery {
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsEnum(DepositStatus) status?: DepositStatus;
}

const sumActive = (rows: { amount: bigint; releasedAt: Date | null }[]) => rows.filter((r) => !r.releasedAt).reduce((s, r) => s + r.amount, 0n);
/** Part d'un acompte déjà imputée sur des factures (répartitions « facture » issues de l'acompte). */
export const appliedOf = (rows: { target: string; amount: bigint; releasedAt: Date | null }[]) => sumActive(rows.filter((r) => r.target === 'INVOICE'));

/**
 * Paiements clients, répartitions et acomptes (module 7, étape 4).
 * Un paiement n'est jamais une vente : il n'entre pas dans le chiffre
 * d'affaires ni dans le stock. Les moyens « caisse » passent par la session
 * ouverte du module 5 (mouvements CUSTOMER_PAYMENT / CUSTOMER_REFUND, comptés
 * au rapport Z et à la clôture). La TVA d'un acompte n'est pas traitée :
 * À CONFIRMER AVEC LE COMPTABLE (décision D6).
 */
@Injectable()
export class CustomerPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
  ) {}

  // --- Droits ---------------------------------------------------------------------------

  private canRead(me: AuthUser, establishmentId: string) {
    return me.access.canAccessEstablishment(establishmentId) && PAY_READ.some((p) => me.access.can(p, establishmentId));
  }

  private assertCan(me: AuthUser, establishmentId: string, ...permissions: string[]) {
    if (!me.access.canAccessEstablishment(establishmentId) || permissions.some((p) => !me.access.can(p, establishmentId))) {
      throw new ForbiddenException("Vous n'avez pas cette permission pour cet établissement");
    }
  }

  private readable(me: AuthUser, requested?: string) {
    const ids = new Set<string>();
    for (const p of PAY_READ) me.access.establishmentsWith(p).forEach((x) => ids.add(x));
    const scope = requested ?? me.establishmentId;
    if (scope) return ids.has(scope) ? [scope] : [];
    return [...ids];
  }

  private async establishment(tx: Tx, me: AuthUser, id: string) {
    const est = await tx.establishment.findFirst({ where: { id, companyId: me.companyId, deletedAt: null } });
    if (!est) throw new BadRequestException('Établissement invalide');
    return est;
  }

  // --- Lecture --------------------------------------------------------------------------

  async listPayments(me: AuthUser, q: PaymentQuery) {
    const rows = await this.prisma.customerPayment.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.readable(me, q.establishmentId) }, customerId: q.customerId },
      include: { customer: { select: { id: true, name: true } }, allocations: true },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return rows.map(({ allocations, ...p }) => ({ ...p, allocated: sumActive(allocations), unallocated: p.status === 'RECORDED' ? p.amount - sumActive(allocations) : 0n }));
  }

  async getPayment(me: AuthUser, id: string) {
    const p = await this.prisma.customerPayment.findFirst({
      where: { id, companyId: me.companyId },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        allocations: { include: { deposit: { select: { id: true, number: true, status: true } }, invoice: { select: { id: true, number: true, status: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!p || !this.canRead(me, p.establishmentId)) throw new NotFoundException('Paiement introuvable');
    const names = await userNames(this.prisma, me.companyId, [p.createdById, p.cancelledById]);
    const allocated = sumActive(p.allocations);
    return {
      ...p,
      methodLabel: METHOD_LABELS[p.method],
      allocated,
      unallocated: p.status === 'RECORDED' ? p.amount - allocated : 0n,
      createdBy: names.get(p.createdById) ?? null,
      cancelledBy: p.cancelledById ? names.get(p.cancelledById) ?? null : null,
      canManage: me.access.can(PAY, p.establishmentId),
    };
  }

  /**
   * Reçu de paiement : données d'impression (lecture seule, sans écriture ni audit). Même contrôle
   * d'accès que la fiche ; un paiement annulé reste imprimable, avec son annulation.
   */
  async paymentReceipt(me: AuthUser, id: string) {
    const p = await this.getPayment(me, id);
    const [company, est] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: me.companyId }, select: { name: true, legalName: true, taxId: true } }),
      this.prisma.establishment.findUniqueOrThrow({
        where: { id: p.establishmentId },
        select: { code: true, name: true, address: true, city: true, phone: true, receiptHeader: true, receiptFooter: true },
      }),
    ]);
    const mention = ['Reçu de paiement. Ce reçu ne vaut pas facture.'];
    if (p.unallocated > 0n) mention.push(`Montant non réparti (${p.unallocated} FCFA) : il reste au crédit du client.`);
    return {
      title: 'Reçu de paiement',
      number: p.number,
      date: p.createdAt,
      status: p.status,
      cancelled: p.status === 'CANCELLED' ? { at: p.cancelledAt, by: p.cancelledBy, reason: p.cancelReason } : null,
      company,
      establishment: est,
      customer: p.customer,
      amount: p.amount,
      method: p.method,
      methodLabel: p.methodLabel,
      reference: p.reference,
      // Session et mouvements de caisse jamais exposés : seulement « en caisse » ou « hors caisse ».
      register: p.sessionId ? 'En caisse' : 'Hors caisse',
      allocations: p.allocations
        .filter((a) => !a.releasedAt)
        .map((a) => ({ target: a.target, number: a.target === 'INVOICE' ? a.invoice?.number ?? null : a.deposit?.number ?? null, amount: a.amount })),
      allocated: p.allocated,
      unallocated: p.unallocated,
      receivedBy: p.createdBy,
      mention: mention.join(' '),
    };
  }

  async listDeposits(me: AuthUser, q: DepositQuery) {
    return this.prisma.deposit.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.readable(me, q.establishmentId) }, customerId: q.customerId, orderId: q.orderId, status: q.status },
      include: { customer: { select: { id: true, name: true } }, order: { select: { id: true, number: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
  }

  async getDeposit(me: AuthUser, id: string) {
    const d = await this.prisma.deposit.findFirst({
      where: { id, companyId: me.companyId },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        order: { select: { id: true, number: true, status: true, total: true } },
        allocations: { include: { payment: { select: { id: true, number: true, method: true, reference: true, createdAt: true } } }, orderBy: { createdAt: 'asc' } },
        refunds: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!d || !this.canRead(me, d.establishmentId)) throw new NotFoundException('Acompte introuvable');
    const names = await userNames(this.prisma, me.companyId, [d.createdById, d.cancelledById, ...d.refunds.map((r) => r.createdById)]);
    const applied = appliedOf(d.allocations);
    return {
      ...d,
      applied,
      available: AVAILABLE.includes(d.status) ? d.amount - d.refundedAmount - applied : 0n,
      createdBy: names.get(d.createdById) ?? null,
      cancelledBy: d.cancelledById ? names.get(d.cancelledById) ?? null : null,
      refunds: d.refunds.map((r) => ({ ...r, createdBy: names.get(r.createdById) ?? null })),
      canManage: me.access.can(PAY, d.establishmentId),
    };
  }

  /** Reçu d'acompte ACP : données d'impression (avance du client, sans facture). */
  async receipt(me: AuthUser, id: string) {
    const d = await this.getDeposit(me, id);
    const [company, est] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: me.companyId }, select: { name: true } }),
      this.prisma.establishment.findUniqueOrThrow({ where: { id: d.establishmentId }, select: { code: true, name: true, address: true, phone: true } }),
    ]);
    return {
      title: 'Reçu d’acompte',
      number: d.number,
      date: d.createdAt,
      company: company.name,
      establishment: est,
      customer: d.customer,
      order: d.order ? { number: d.order.number, total: d.order.total } : null,
      amount: d.amount,
      refundedAmount: d.refundedAmount,
      status: d.status,
      payments: [...new Set(d.allocations.filter((a) => !a.releasedAt).map((a) => a.payment.id))].map((pid) => {
        const rows = d.allocations.filter((a) => !a.releasedAt && a.payment.id === pid);
        return { number: rows[0].payment.number, method: METHOD_LABELS[rows[0].payment.method], reference: rows[0].payment.reference, amount: sumActive(rows) };
      }),
      applied: d.applied,
      receivedBy: d.createdBy,
      mention: 'Avance du client, à déduire de la facture finale. Ce reçu ne vaut pas facture.',
    };
  }

  // --- Encaissement -----------------------------------------------------------------------

  /**
   * Enregistre l'argent reçu dans la transaction de l'opération : contrôle du
   * moyen (même prestataire que la caisse du module 5), mouvement de caisse
   * dans la session ouverte de l'encaisseur, numéro PAY, audit.
   */
  async insertPayment(tx: Tx, me: AuthUser, est: { id: string; code: string }, customerId: string, money: MoneyDto, extra: { clientRequestId: string | null; notes: string | null }) {
    const amount = BigInt(money.amount);
    const provider = providerFor(money.method);
    const reference = provider.confirm({ method: money.method, amount, reference: money.reference ?? null });
    const offRegister = OFF_REGISTER.has(money.method);
    if (offRegister && money.sessionId) throw new BadRequestException(`${METHOD_LABELS[money.method]} : paiement enregistré hors caisse, sans session`);
    if (!offRegister && !money.sessionId) throw new BadRequestException(`${METHOD_LABELS[money.method]} : une session de caisse ouverte est obligatoire`);
    const number = await this.sequences.next(tx, { companyId: me.companyId, docType: 'PAYMENT', establishmentId: est.id, establishmentCode: est.code });
    const movement = offRegister
      ? null
      : await customerCashMovement(tx, me, { sessionId: money.sessionId!, establishmentId: est.id, type: 'CUSTOMER_PAYMENT', method: money.method, amount, reason: `Paiement client ${number}`, ownSession: true });
    const payment = await tx.customerPayment.create({
      data: {
        companyId: me.companyId,
        establishmentId: est.id,
        customerId,
        number,
        clientRequestId: extra.clientRequestId,
        method: money.method,
        amount,
        reference,
        provider: provider.code,
        sessionId: movement?.sessionId ?? null,
        cashMovementId: movement?.id ?? null,
        notes: extra.notes,
        createdById: me.userId,
      },
    });
    await this.audit.record(
      {
        action: 'CUSTOMER_PAYMENT_RECORDED',
        entityType: 'CustomerPayment',
        entityId: payment.id,
        establishmentId: est.id,
        newValues: { number, customerId, method: payment.method, amount, reference, sessionId: payment.sessionId, cashMovementId: payment.cashMovementId },
      },
      tx,
    );
    return payment;
  }

  createPayment(me: AuthUser, dto: CreatePaymentDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.customerPayment
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((p) => p && { id: p.id, ownerId: p.createdById }),
      async () => {
        this.assertCan(me, dto.establishmentId, PAY);
        const id = await this.prisma.$transaction(async (tx) => {
          const est = await this.establishment(tx, me, dto.establishmentId);
          const customer = await activeCustomer(tx, me, dto.customerId);
          return (await this.insertPayment(tx, me, est, customer.id, dto, { clientRequestId: dto.clientRequestId ?? null, notes: dto.notes ?? null })).id;
        });
        return this.getPayment(me, id);
      },
      (id) => this.getPayment(me, id),
    );
  }

  /**
   * Correction d'une erreur d'encaissement : paiement non réparti seulement ;
   * mouvement inverse dans sa session, qui doit être encore ouverte.
   */
  async cancelPayment(me: AuthUser, id: string, dto: ReasonDto) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.lockedPayments(tx, me, [id]).then((rows) => rows[0]);
      this.assertCan(me, p.establishmentId, PAY, 'sales.cancel');
      if (p.status !== 'RECORDED') throw new ConflictException('Paiement déjà annulé');
      if (await tx.paymentAllocation.count({ where: { paymentId: id, releasedAt: null } })) {
        throw new ConflictException('Paiement réparti : annulez d’abord l’acompte qu’il finance');
      }
      const reversal = p.sessionId
        ? await customerCashMovement(tx, me, {
            sessionId: p.sessionId,
            establishmentId: p.establishmentId,
            type: 'CUSTOMER_REFUND',
            method: p.method,
            amount: p.amount,
            reason: `Annulation du paiement ${p.number} : ${dto.reason}`,
            ownSession: false,
          }).catch((e) => {
            if (e instanceof ConflictException && /clôturée/.test(e.message)) throw new ConflictException('Session de caisse clôturée : le paiement ne s’annule plus, il se rembourse');
            throw e;
          })
        : null;
      await tx.customerPayment.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: me.userId, cancelReason: dto.reason, reversalMovementId: reversal?.id ?? null } });
      await this.audit.record(
        { action: 'CUSTOMER_PAYMENT_CANCELLED', entityType: 'CustomerPayment', entityId: id, establishmentId: p.establishmentId, oldValues: { status: p.status }, newValues: { number: p.number, status: 'CANCELLED', amount: p.amount, reversalMovementId: reversal?.id ?? null }, reason: dto.reason },
        tx,
      );
    });
    return this.getPayment(me, id);
  }

  /** Verrouille des paiements dans l'ordre des identifiants (pas d'interblocage entre répartitions simultanées). */
  private async lockedPayments(tx: Tx, me: AuthUser, ids: string[]) {
    const sorted = [...new Set(ids)].sort();
    await tx.$queryRaw`SELECT id FROM customer_payments WHERE id IN (${Prisma.join(sorted.map((x) => Prisma.sql`${x}::uuid`))}) ORDER BY id FOR UPDATE`;
    const rows = await tx.customerPayment.findMany({ where: { id: { in: sorted }, companyId: me.companyId } });
    if (rows.length !== sorted.length) throw new NotFoundException('Paiement introuvable');
    return ids.map((x) => rows.find((r) => r.id === x)!);
  }

  // --- Acomptes ------------------------------------------------------------------------------

  createDeposit(me: AuthUser, dto: CreateDepositDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.deposit
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((d) => d && { id: d.id, ownerId: d.createdById }),
      async () => {
        this.assertCan(me, dto.establishmentId, PAY);
        if (!!dto.payment === !!dto.funding) throw new BadRequestException('Indiquer soit un encaissement, soit des paiements déjà reçus à répartir');
        const id = await this.prisma.$transaction((tx) => this.doCreateDeposit(tx, me, dto));
        return this.getDeposit(me, id);
      },
      (id) => this.getDeposit(me, id),
    );
  }

  private async doCreateDeposit(tx: Tx, me: AuthUser, dto: CreateDepositDto) {
    const est = await this.establishment(tx, me, dto.establishmentId);
    const customer = await activeCustomer(tx, me, dto.customerId);
    if (dto.orderId) {
      await lockRowOf(tx, 'customer_orders', dto.orderId);
      const order = await tx.customerOrder.findFirst({ where: { id: dto.orderId, companyId: me.companyId } });
      if (!order || order.establishmentId !== est.id) throw new BadRequestException('Commande invalide pour cet établissement');
      if (order.customerId !== customer.id) throw new BadRequestException('La commande appartient à un autre client');
      if (!DEPOSIT_ORDER_STATUSES.includes(order.status)) throw new ConflictException('Un acompte se verse sur une commande en cours (ni livrée, ni annulée)');
    }

    // Origine de l'argent : encaissement immédiat, ou partie non répartie de paiements reçus.
    let funding: { payment: CustomerPayment; amount: bigint }[];
    if (dto.payment) {
      const payment = await this.insertPayment(tx, me, est, customer.id, dto.payment, { clientRequestId: null, notes: dto.notes ?? null });
      funding = [{ payment, amount: payment.amount }];
    } else {
      const wanted = new Map<string, bigint>();
      for (const f of dto.funding!) wanted.set(f.paymentId, (wanted.get(f.paymentId) ?? 0n) + BigInt(f.amount));
      const payments = await this.lockedPayments(tx, me, [...wanted.keys()]);
      const used = await tx.paymentAllocation.groupBy({ by: ['paymentId'], where: { paymentId: { in: [...wanted.keys()] }, releasedAt: null }, _sum: { amount: true } });
      funding = payments.map((payment) => {
        if (payment.status !== 'RECORDED') throw new ConflictException(`Paiement ${payment.number} annulé`);
        if (payment.establishmentId !== est.id || payment.customerId !== customer.id) throw new BadRequestException(`Paiement ${payment.number} : autre client ou autre établissement`);
        const free = payment.amount - (used.find((u) => u.paymentId === payment.id)?._sum.amount ?? 0n);
        const amount = wanted.get(payment.id)!;
        if (amount > free) throw new ConflictException(`Paiement ${payment.number} : il ne reste que ${free} FCFA à répartir`);
        return { payment, amount };
      });
    }
    const amount = funding.reduce((s, f) => s + f.amount, 0n);
    const deposit = await tx.deposit.create({
      data: {
        companyId: me.companyId,
        establishmentId: est.id,
        customerId: customer.id,
        orderId: dto.orderId ?? null,
        number: await this.sequences.next(tx, { companyId: me.companyId, docType: 'DEPOSIT', establishmentId: est.id, establishmentCode: est.code }),
        clientRequestId: dto.clientRequestId ?? null,
        amount,
        notes: dto.notes ?? null,
        createdById: me.userId,
      },
    });
    for (const f of funding) {
      await tx.paymentAllocation.create({ data: { paymentId: f.payment.id, target: 'DEPOSIT', depositId: deposit.id, amount: f.amount, createdById: me.userId } });
    }
    await this.audit.record(
      {
        action: 'DEPOSIT_RECEIVED',
        entityType: 'Deposit',
        entityId: deposit.id,
        establishmentId: est.id,
        newValues: { number: deposit.number, customerId: customer.id, orderId: deposit.orderId, amount, allocations: funding.map((f) => ({ payment: f.payment.number, amount: f.amount })) },
      },
      tx,
    );
    return deposit.id;
  }

  private async lockedDeposit(tx: Tx, me: AuthUser, id: string) {
    const found = await tx.deposit.findFirst({ where: { id, companyId: me.companyId } });
    if (!found || !this.canRead(me, found.establishmentId)) throw new NotFoundException('Acompte introuvable');
    // Toujours la commande avant l'acompte (même ordre que la création).
    if (found.orderId) await lockRowOf(tx, 'customer_orders', found.orderId);
    await tx.$queryRaw`SELECT id FROM deposits WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.deposit.findUniqueOrThrow({ where: { id } });
  }

  /** Remboursement (total ou partiel) : par la caisse de celui qui rembourse, ou hors caisse. */
  refundDeposit(me: AuthUser, id: string, dto: RefundDepositDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.customerRefund
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId, depositId: { not: null } } })
          .then((r) => r && { id: r.depositId!, ownerId: r.createdById }),
      async () => {
        await this.prisma.$transaction(async (tx) => {
          const d = await this.lockedDeposit(tx, me, id);
          this.assertCan(me, d.establishmentId, PAY, 'sales.refund');
          if (!AVAILABLE.includes(d.status)) throw new ConflictException(d.status === 'REFUNDED' ? 'Acompte déjà remboursé' : 'Acompte annulé');
          const amount = BigInt(dto.amount);
          const applied = appliedOf(await tx.paymentAllocation.findMany({ where: { depositId: d.id } }));
          const left = d.amount - d.refundedAmount - applied;
          if (amount > left) throw new ConflictException(`Il ne reste que ${left} FCFA à rembourser sur l’acompte ${d.number}`);
          const provider = providerFor(dto.method);
          const reference = provider.confirm({ method: dto.method, amount, reference: dto.reference ?? null });
          const offRegister = OFF_REGISTER.has(dto.method);
          if (offRegister && dto.sessionId) throw new BadRequestException(`${METHOD_LABELS[dto.method]} : remboursement hors caisse, sans session`);
          if (!offRegister && !dto.sessionId) throw new BadRequestException(`${METHOD_LABELS[dto.method]} : une session de caisse ouverte est obligatoire`);
          const movement = offRegister
            ? null
            : await customerCashMovement(tx, me, { sessionId: dto.sessionId!, establishmentId: d.establishmentId, type: 'CUSTOMER_REFUND', method: dto.method, amount, reason: `Remboursement acompte ${d.number} : ${dto.reason}`, ownSession: true });
          const refund = await tx.customerRefund.create({
            data: {
              companyId: me.companyId,
              establishmentId: d.establishmentId,
              customerId: d.customerId,
              depositId: d.id,
              clientRequestId: dto.clientRequestId ?? null,
              method: dto.method,
              amount,
              reference,
              provider: provider.code,
              sessionId: movement?.sessionId ?? null,
              cashMovementId: movement?.id ?? null,
              reason: dto.reason,
              createdById: me.userId,
            },
          });
          const refundedAmount = d.refundedAmount + amount;
          const status: DepositStatus = refundedAmount === d.amount ? 'REFUNDED' : d.status;
          await tx.deposit.update({ where: { id }, data: { refundedAmount, status } });
          await this.audit.record(
            {
              action: 'DEPOSIT_REFUNDED',
              entityType: 'Deposit',
              entityId: id,
              establishmentId: d.establishmentId,
              oldValues: { status: d.status, refundedAmount: d.refundedAmount },
              newValues: { number: d.number, status, refundedAmount, refundId: refund.id, method: dto.method, amount, reference, cashMovementId: refund.cashMovementId },
              reason: dto.reason,
            },
            tx,
          );
        });
        return this.getDeposit(me, id);
      },
      (depositId) => this.getDeposit(me, depositId),
    );
  }

  /** Conservation en crédit du client (par exemple après l'annulation de la commande). */
  async creditDeposit(me: AuthUser, id: string, dto: ReasonDto) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.lockedDeposit(tx, me, id);
      this.assertCan(me, d.establishmentId, PAY);
      if (d.status !== 'RECEIVED') throw new ConflictException('Seul un acompte reçu passe en crédit client');
      await tx.deposit.update({ where: { id }, data: { status: 'CUSTOMER_CREDIT', creditedAt: new Date(), creditReason: dto.reason } });
      await this.audit.record(
        { action: 'DEPOSIT_TO_CUSTOMER_CREDIT', entityType: 'Deposit', entityId: id, establishmentId: d.establishmentId, oldValues: { status: d.status }, newValues: { number: d.number, status: 'CUSTOMER_CREDIT', available: d.amount - d.refundedAmount }, reason: dto.reason },
        tx,
      );
    });
    return this.getDeposit(me, id);
  }

  /** Annulation d'une saisie erronée : répartitions libérées, l'argent redevient non réparti sur ses paiements. */
  async cancelDeposit(me: AuthUser, id: string, dto: ReasonDto) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.lockedDeposit(tx, me, id);
      this.assertCan(me, d.establishmentId, PAY, 'sales.cancel');
      if (!AVAILABLE.includes(d.status)) throw new ConflictException(d.status === 'CANCELLED' ? 'Acompte déjà annulé' : 'Acompte remboursé : il ne s’annule plus');
      if (d.refundedAmount > 0n) throw new ConflictException('Acompte en partie remboursé : il ne s’annule plus');
      if (appliedOf(await tx.paymentAllocation.findMany({ where: { depositId: id } })) > 0n) throw new ConflictException('Acompte imputé sur une facture : il ne s’annule plus (avoir sur la facture)');
      const allocations = await tx.paymentAllocation.findMany({ where: { depositId: id, target: 'DEPOSIT', releasedAt: null } });
      if (allocations.length) await this.lockedPayments(tx, me, allocations.map((a) => a.paymentId));
      for (const a of allocations) await tx.paymentAllocation.update({ where: { id: a.id }, data: { releasedAt: new Date(), releasedById: me.userId, releaseReason: dto.reason } });
      await tx.deposit.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: me.userId, cancelReason: dto.reason } });
      await this.audit.record(
        { action: 'DEPOSIT_CANCELLED', entityType: 'Deposit', entityId: id, establishmentId: d.establishmentId, oldValues: { status: d.status }, newValues: { number: d.number, status: 'CANCELLED', releasedAllocations: allocations.length }, reason: dto.reason },
        tx,
      );
    });
    return this.getDeposit(me, id);
  }
}

@ApiTags('Clients')
@ApiBearerAuth()
@Controller()
export class CustomerPaymentsController {
  constructor(private readonly service: CustomerPaymentsService) {}

  @Get('customer-payments')
  listPayments(@CurrentUser() me: AuthUser, @Query() q: PaymentQuery) {
    return this.service.listPayments(me, q);
  }

  @Get('customer-payments/:id')
  getPayment(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getPayment(me, id);
  }

  @Get('customer-payments/:id/receipt')
  paymentReceipt(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.paymentReceipt(me, id);
  }

  @Post('customer-payments')
  @RequirePermissions(PAY)
  @AnyEstablishmentScope()
  createPayment(@CurrentUser() me: AuthUser, @Body() dto: CreatePaymentDto) {
    return this.service.createPayment(me, dto);
  }

  @Post('customer-payments/:id/cancel')
  @RequirePermissions(PAY, 'sales.cancel')
  @AnyEstablishmentScope()
  cancelPayment(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.service.cancelPayment(me, id, dto);
  }

  @Get('deposits')
  listDeposits(@CurrentUser() me: AuthUser, @Query() q: DepositQuery) {
    return this.service.listDeposits(me, q);
  }

  @Get('deposits/:id')
  getDeposit(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getDeposit(me, id);
  }

  @Get('deposits/:id/receipt')
  receipt(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.receipt(me, id);
  }

  @Post('deposits')
  @RequirePermissions(PAY)
  @AnyEstablishmentScope()
  createDeposit(@CurrentUser() me: AuthUser, @Body() dto: CreateDepositDto) {
    return this.service.createDeposit(me, dto);
  }

  @Post('deposits/:id/refund')
  @RequirePermissions(PAY, 'sales.refund')
  @AnyEstablishmentScope()
  refundDeposit(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDepositDto) {
    return this.service.refundDeposit(me, id, dto);
  }

  @Post('deposits/:id/credit')
  @RequirePermissions(PAY)
  @AnyEstablishmentScope()
  creditDeposit(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.service.creditDeposit(me, id, dto);
  }

  @Post('deposits/:id/cancel')
  @RequirePermissions(PAY, 'sales.cancel')
  @AnyEstablishmentScope()
  cancelDeposit(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.service.cancelDeposit(me, id, dto);
  }
}
