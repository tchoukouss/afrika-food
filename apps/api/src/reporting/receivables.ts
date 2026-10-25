import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { advancesAt, DASHBOARD, invoiceBalancesAt, PeriodQuery, periodScope, Scope } from './positions';

const DETAIL = ['reports.view', 'receivables.view'];
const BUCKETS = ['NOT_DUE', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_61_90', 'OVER_90'] as const;
const TOP = 10;

type Totals = { count: number; billed: bigint; paid: bigint; credited: bigint; balance: bigint };
const zero = (): Totals => ({ count: 0, billed: 0n, paid: 0n, credited: 0n, balance: 0n });
const add = (a: Totals, b: Partial<Totals>) => ({
  count: a.count + Number(b.count ?? 0),
  billed: a.billed + BigInt(b.billed ?? 0),
  paid: a.paid + BigInt(b.paid ?? 0),
  credited: a.credited + BigInt(b.credited ?? 0),
  balance: a.balance + BigInt(b.balance ?? 0),
});
/** Part en pour cent, à une décimale (null si total nul). */
const share = (part: bigint, total: bigint) => (total > 0n ? Number((part * 1000n) / total) / 10 : null);

/**
 * Module 8 — Pilotage, étape 2 : créances, acomptes et clients. Lecture seule ;
 * situations reconstituées à la fin de la période (et à son début pour les
 * variations) par les calculs de position communs, même formule que le module 7.
 * Factures de tickets : en créance seulement pour leur part vendue à crédit
 * et restant due, jamais dans le CA facturé (le ticket est déjà compté) ;
 * tickets anonymes jamais rattachés à un client ; TVA des acomptes non calculée.
 */
@Injectable()
export class ReceivablesKpiService {
  constructor(private readonly prisma: PrismaService) {}

  private establishments(s: Scope) {
    return this.prisma.establishment.findMany({ where: { id: { in: s.ids }, companyId: s.companyId }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
  }

  // --- Créances ---------------------------------------------------------------------------

  async receivables(me: AuthUser, q: PeriodQuery) {
    return this.receivablesFor(periodScope(me, q, [DASHBOARD]));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async receivablesFor(s: Scope) {
    const t = s.end;
    const [open, issued, ests] = await Promise.all([
      this.prisma.$queryRaw<{ id: string; bucket: string; count: number; billed: bigint; paid: bigint; credited: bigint; balance: bigint }[]>`
        WITH ${invoiceBalancesAt(s.companyId, s.ids, t)}
        SELECT establishment_id::text AS id,
               CASE WHEN due_date >= ${s.to}::date THEN 'NOT_DUE'
                    WHEN ${s.to}::date - due_date <= 30 THEN 'DAYS_1_30'
                    WHEN ${s.to}::date - due_date <= 60 THEN 'DAYS_31_60'
                    WHEN ${s.to}::date - due_date <= 90 THEN 'DAYS_61_90'
                    ELSE 'OVER_90' END AS bucket,
               count(*)::int AS count, sum(total)::bigint AS billed, sum(pos_paid + allocated - cn_refunded)::bigint AS paid,
               sum(credited)::bigint AS credited, sum(balance)::bigint AS balance
        FROM ib WHERE balance > 0
        GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ id: string; count: number; billed: bigint; paid: bigint; credited: bigint; balance: bigint }[]>`
        WITH ${invoiceBalancesAt(s.companyId, s.ids, t)}
        SELECT establishment_id::text AS id, count(*)::int AS count, sum(total)::bigint AS billed, sum(pos_paid + allocated - cn_refunded)::bigint AS paid,
               sum(credited)::bigint AS credited, sum(greatest(balance, 0))::bigint AS balance
        FROM ib WHERE (source <> 'SALE' OR pos_paid < total) AND issued_at >= ${s.start}
        GROUP BY 1`,
      this.establishments(s),
    ]);
    const shape = (rows: typeof open, iss: typeof issued) => {
      const aging = BUCKETS.map((bucket) => ({ bucket, ...rows.filter((r) => r.bucket === bucket).reduce(add, zero()) }));
      const all = rows.reduce(add, zero());
      const overdue = rows.filter((r) => r.bucket !== 'NOT_DUE').reduce(add, zero());
      return {
        open: all,
        notDue: aging[0],
        overdue,
        aging,
        issuedInPeriod: iss.reduce(add, zero()),
      };
    };
    return {
      period: { from: s.from, to: s.to },
      asOf: s.to,
      currency: 'XOF',
      notes: ['Créances ouvertes à la fin du dernier jour de la période ; ancienneté selon l’échéance figée à l’émission. Factures de tickets : seulement la part vendue à crédit et restant due (un ticket réglé en caisse n’est pas une créance).'],
      total: shape(open, issued),
      byEstablishment: ests.map((e) => ({ establishment: e, ...shape(open.filter((r) => r.id === e.id), issued.filter((r) => r.id === e.id)) })),
    };
  }

  // --- Acomptes et avances -----------------------------------------------------------------

  private async advancesPosition(s: Scope, t: Date) {
    return this.prisma.$queryRaw<
      { id: string; count: number; amount: bigint; applied: bigint; refunded: bigint; available: bigint; available_received: bigint; available_credit: bigint; unapplied: bigint }[]
    >`
      WITH e AS (SELECT unnest(${s.ids}::uuid[]) AS id),
      ${advancesAt(s.companyId, s.ids, t)},
      d AS (
        SELECT establishment_id AS id, count(*)::int AS count, sum(amount)::bigint AS amount, sum(applied)::bigint AS applied, sum(refunded)::bigint AS refunded,
               sum(available)::bigint AS available,
               sum(CASE WHEN customer_credit THEN 0 ELSE available END)::bigint AS available_received,
               sum(CASE WHEN customer_credit THEN available ELSE 0 END)::bigint AS available_credit
        FROM dep GROUP BY 1),
      u AS (SELECT establishment_id AS id, sum(amount - allocated)::bigint AS v FROM pv GROUP BY 1)
      SELECT e.id::text AS id, coalesce(d.count, 0) AS count, coalesce(d.amount, 0)::bigint AS amount, coalesce(d.applied, 0)::bigint AS applied,
             coalesce(d.refunded, 0)::bigint AS refunded, coalesce(d.available, 0)::bigint AS available,
             coalesce(d.available_received, 0)::bigint AS available_received, coalesce(d.available_credit, 0)::bigint AS available_credit,
             coalesce(u.v, 0)::bigint AS unapplied
      FROM e LEFT JOIN d ON d.id = e.id LEFT JOIN u ON u.id = e.id`;
  }

  async advances(me: AuthUser, q: PeriodQuery) {
    return this.advancesFor(periodScope(me, q, [DASHBOARD]));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async advancesFor(s: Scope) {
    const [closing, opening, flows, ests] = await Promise.all([
      this.advancesPosition(s, s.end),
      this.advancesPosition(s, s.start),
      this.prisma.$queryRaw<{ id: string; received: bigint; received_count: number; cancelled: bigint; refunded: bigint }[]>`
        WITH e AS (SELECT unnest(${s.ids}::uuid[]) AS id),
        rc AS (SELECT establishment_id AS id, sum(amount)::bigint AS v, count(*)::int AS n FROM deposits
               WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND created_at >= ${s.start} AND created_at < ${s.end} GROUP BY 1),
        cc AS (SELECT establishment_id AS id, sum(amount)::bigint AS v FROM deposits
               WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND cancelled_at >= ${s.start} AND cancelled_at < ${s.end} GROUP BY 1),
        rf AS (SELECT establishment_id AS id, sum(amount)::bigint AS v FROM customer_refunds
               WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND deposit_id IS NOT NULL AND created_at >= ${s.start} AND created_at < ${s.end} GROUP BY 1)
        SELECT e.id::text AS id, coalesce(rc.v, 0)::bigint AS received, coalesce(rc.n, 0) AS received_count, coalesce(cc.v, 0)::bigint AS cancelled, coalesce(rf.v, 0)::bigint AS refunded
        FROM e LEFT JOIN rc ON rc.id = e.id LEFT JOIN cc ON cc.id = e.id LEFT JOIN rf ON rf.id = e.id`,
      this.establishments(s),
    ]);
    type P = (typeof closing)[number];
    const sumP = (rows: P[]) =>
      rows.reduce(
        (a, r) => ({
          count: a.count + r.count,
          amount: a.amount + r.amount,
          applied: a.applied + r.applied,
          refunded: a.refunded + r.refunded,
          available: a.available + r.available,
          availableReceived: a.availableReceived + r.available_received,
          availableCustomerCredit: a.availableCustomerCredit + r.available_credit,
          unappliedPayments: a.unappliedPayments + r.unapplied,
        }),
        { count: 0, amount: 0n, applied: 0n, refunded: 0n, available: 0n, availableReceived: 0n, availableCustomerCredit: 0n, unappliedPayments: 0n },
      );
    const position = (rows: P[]) => {
      const p = sumP(rows);
      return {
        deposits: { count: p.count, received: p.amount, applied: p.applied, refunded: p.refunded, available: p.available, availableOnOrders: p.availableReceived, convertedToCustomerCredit: p.availableCustomerCredit },
        unappliedPayments: p.unappliedPayments,
        customerCredit: p.availableCustomerCredit + p.unappliedPayments,
        totalAdvances: p.available + p.unappliedPayments,
      };
    };
    const shape = (id?: string) => {
      const pick = <T extends { id: string }>(rows: T[]) => (id ? rows.filter((r) => r.id === id) : rows);
      const close = position(pick(closing));
      const open = position(pick(opening));
      const f = pick(flows).reduce((a, r) => ({ received: a.received + r.received, count: a.count + r.received_count, cancelled: a.cancelled + r.cancelled, refunded: a.refunded + r.refunded }), { received: 0n, count: 0, cancelled: 0n, refunded: 0n });
      return {
        opening: open,
        closing: close,
        flows: {
          depositsReceived: f.received,
          depositsReceivedCount: f.count,
          depositsApplied: close.deposits.applied - open.deposits.applied,
          depositsRefunded: f.refunded,
          depositsCancelled: f.cancelled,
        },
      };
    };
    return {
      period: { from: s.from, to: s.to },
      asOf: s.to,
      currency: 'XOF',
      notes: [
        'Acomptes et paiements non répartis : avances des clients, jamais du chiffre d’affaires.',
        'TVA des acomptes : non calculée, en attente de confirmation par l’expert-comptable.',
        'Crédit client = acomptes convertis en crédit client encore disponibles + paiements non répartis.',
      ],
      total: shape(),
      byEstablishment: ests.map((e) => ({ establishment: e, ...shape(e.id) })),
    };
  }

  // --- Clients ------------------------------------------------------------------------------

  /** Encours et CA facturé par client, agrégés en base sur les établissements du périmètre. */
  private customerRows(s: Scope) {
    return this.prisma.$queryRaw<{ customer_id: string; balance: bigint; overdue: bigint; invoiced: bigint; credited: bigint }[]>`
      WITH ${invoiceBalancesAt(s.companyId, s.ids, s.end)},
      bal AS (
        SELECT customer_id, sum(balance)::bigint AS balance, sum(CASE WHEN due_date < ${s.to}::date THEN balance ELSE 0 END)::bigint AS overdue
        FROM ib WHERE balance > 0 GROUP BY 1),
      inv AS (
        SELECT customer_id, sum(total)::bigint AS v FROM invoices
        WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND number IS NOT NULL AND source <> 'SALE'
          AND issued_at >= ${s.start} AND issued_at < ${s.end} GROUP BY 1),
      crn AS (
        SELECT cn.customer_id, sum(cn.total)::bigint AS v FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id
        WHERE cn.company_id = ${s.companyId}::uuid AND cn.establishment_id = ANY(${s.ids}::uuid[]) AND i.source <> 'SALE'
          AND cn.created_at >= ${s.start} AND cn.created_at < ${s.end} GROUP BY 1)
      SELECT c.customer_id::text AS customer_id, coalesce(bal.balance, 0)::bigint AS balance, coalesce(bal.overdue, 0)::bigint AS overdue,
             coalesce(inv.v, 0)::bigint AS invoiced, coalesce(crn.v, 0)::bigint AS credited
      FROM (SELECT customer_id FROM bal UNION SELECT customer_id FROM inv UNION SELECT customer_id FROM crn) c
      LEFT JOIN bal ON bal.customer_id = c.customer_id LEFT JOIN inv ON inv.customer_id = c.customer_id LEFT JOIN crn ON crn.customer_id = c.customer_id`;
  }

  async customers(me: AuthUser, q: PeriodQuery) {
    return this.customersFor(periodScope(me, q, [DASHBOARD]));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async customersFor(s: Scope) {
    const [rows, byType] = await Promise.all([
      this.customerRows(s),
      this.prisma.customer.groupBy({ by: ['type', 'isActive'], where: { companyId: s.companyId }, _count: true }),
    ]);
    const receivables = rows.reduce((a, r) => a + r.balance, 0n);
    const overdue = rows.reduce((a, r) => a + r.overdue, 0n);
    const revenue = rows.map((r) => r.invoiced - r.credited);
    const invoicedRevenue = revenue.reduce((a, v) => a + v, 0n);
    const top = (values: bigint[], total: bigint) => share([...values].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)).slice(0, 5).reduce((a, v) => a + v, 0n), total);
    return {
      period: { from: s.from, to: s.to },
      asOf: s.to,
      currency: 'XOF',
      notes: [
        'Nombre et types de clients : fichier client actuel (le statut actif n’est pas historisé).',
        'CA facturé par client : factures hors tickets − leurs avoirs ; les tickets anonymes ne sont attribués à aucun client.',
      ],
      activeCustomers: byType.filter((g) => g.isActive).reduce((a, g) => a + g._count, 0),
      inactiveCustomers: byType.filter((g) => !g.isActive).reduce((a, g) => a + g._count, 0),
      activeByType: byType.filter((g) => g.isActive).map((g) => ({ type: g.type, count: g._count })).sort((a, b) => a.type.localeCompare(b.type)),
      customersWithReceivables: rows.filter((r) => r.balance > 0n).length,
      customersOverdue: rows.filter((r) => r.overdue > 0n).length,
      receivables,
      overdue,
      invoicedRevenue,
      concentration: { top5ReceivablesShare: top(rows.map((r) => r.balance), receivables), top5InvoicedRevenueShare: top(revenue, invoicedRevenue) },
    };
  }

  /** Détail nominatif : « Consulter les rapports » + « Consulter les créances ». */
  async customerDetails(me: AuthUser, q: PeriodQuery) {
    return this.customerDetailsFor(periodScope(me, q, DETAIL));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async customerDetailsFor(s: Scope) {
    const [rows, overdueInvoices] = await Promise.all([
      this.customerRows(s),
      this.prisma.$queryRaw<{ id: string; number: string; customer_id: string; establishment_id: string; due_date: Date; days: number; balance: bigint }[]>`
        WITH ${invoiceBalancesAt(s.companyId, s.ids, s.end)}
        SELECT id::text AS id, number, customer_id::text AS customer_id, establishment_id::text AS establishment_id, due_date, (${s.to}::date - due_date)::int AS days, balance
        FROM ib WHERE balance > 0 AND due_date < ${s.to}::date
        ORDER BY days DESC, number ASC LIMIT 100`,
    ]);
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: [...new Set([...rows.map((r) => r.customer_id), ...overdueInvoices.map((i) => i.customer_id)])] }, companyId: s.companyId },
      select: { id: true, name: true, type: true },
    });
    const ests = await this.establishments(s);
    const who = (id: string) => customers.find((c) => c.id === id) ?? null;
    const order = (f: (r: (typeof rows)[number]) => bigint) => [...rows].filter((r) => f(r) > 0n).sort((a, b) => (f(b) > f(a) ? 1 : f(b) < f(a) ? -1 : 0)).slice(0, TOP);
    return {
      period: { from: s.from, to: s.to },
      asOf: s.to,
      currency: 'XOF',
      topByReceivables: order((r) => r.balance).map((r) => ({ customer: who(r.customer_id), receivables: r.balance, overdue: r.overdue })),
      topByInvoicedRevenue: order((r) => r.invoiced - r.credited).map((r) => ({ customer: who(r.customer_id), invoiced: r.invoiced, credited: r.credited, revenue: r.invoiced - r.credited })),
      overdueInvoices: overdueInvoices.map((i) => ({
        invoiceId: i.id,
        number: i.number,
        customer: who(i.customer_id),
        establishment: ests.find((e) => e.id === i.establishment_id) ?? null,
        dueDate: i.due_date.toISOString().slice(0, 10),
        daysOverdue: i.days,
        balance: i.balance,
      })),
    };
  }
}

@ApiTags('Pilotage')
@ApiBearerAuth()
@Controller('pilotage')
export class ReceivablesKpiController {
  constructor(private readonly service: ReceivablesKpiService) {}

  @Get('receivables')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  receivables(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.receivables(me, q);
  }

  @Get('advances')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  advances(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.advances(me, q);
  }

  @Get('customers')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  customers(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.customers(me, q);
  }

  @Get('customers/details')
  @RequirePermissions(...DETAIL)
  @AnyEstablishmentScope()
  customerDetails(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.customerDetails(me, q);
  }
}
