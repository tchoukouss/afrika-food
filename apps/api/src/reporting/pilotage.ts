import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { advancesAt, DASHBOARD, invoiceBalancesAt, PeriodQuery, periodScope, Scope } from './positions';

const n = (v: bigint | number | null | undefined) => BigInt(v ?? 0);
const sum = <T>(rows: T[], f: (r: T) => bigint) => rows.reduce((s, r) => s + f(r), 0n);

/**
 * Module 8 — Pilotage, étape 1 : chiffre d'affaires, encaissements et
 * rapprochement. Lecture seule : agrégations PostgreSQL sur les écritures
 * sources des modules 5 et 7, sans table de cache ni écriture.
 *
 * Chiffre d'affaires (TTC) = tickets − annulations − remboursements de tickets
 * + factures émises hors tickets − avoirs, chaque correction à sa propre date.
 * Encaissements = mouvements de caisse des ventes et des clients (module 5) +
 * paiements et remboursements clients hors caisse (module 7), sans double.
 */
@Injectable()
export class PilotageService {
  constructor(private readonly prisma: PrismaService) {}

  /** Période validée et établissements accessibles avec « Tableau de bord direction » (socle commun). */
  scope(me: AuthUser, q: PeriodQuery): Scope {
    return periodScope(me, q, [DASHBOARD]);
  }

  private async establishments(s: Scope) {
    const rows = await this.prisma.establishment.findMany({ where: { id: { in: s.ids }, companyId: s.companyId }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
    return rows;
  }

  // --- Chiffre d'affaires -------------------------------------------------------------------

  /** Composantes du chiffre d'affaires par établissement (réutilisées par les ventes détaillées). */
  async revenueRows(s: Scope) {
    const ids = s.ids;
    return this.prisma.$queryRaw<
      {
        id: string;
        tickets: bigint; tickets_tax: bigint; tickets_count: number;
        cancels: bigint; cancels_tax: bigint; cancels_count: number;
        refunds: bigint; refunds_count: number;
        invoices: bigint; invoices_tax: bigint; invoices_count: number;
        credits: bigint; credits_tax: bigint; credits_count: number; credits_on_tickets: bigint;
      }[]
    >`
      WITH e AS (SELECT unnest(${ids}::uuid[]) AS id),
      t AS (
        SELECT establishment_id AS id, sum(total)::bigint AS ttc, sum(tax_total)::bigint AS tax, count(*)::int AS cnt
        FROM sales WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${ids}::uuid[]) AND created_at >= ${s.start} AND created_at < ${s.end}
        GROUP BY 1),
      c AS (
        -- Annulation : le ticket entier, TVA comprise (connue sur le ticket).
        SELECT r.establishment_id AS id, sum(r.total)::bigint AS ttc, sum(s.tax_total)::bigint AS tax, count(*)::int AS cnt
        FROM sale_returns r JOIN sales s ON s.id = r.sale_id
        WHERE r.company_id = ${s.companyId}::uuid AND r.establishment_id = ANY(${ids}::uuid[]) AND r.kind = 'CANCEL' AND r.created_at >= ${s.start} AND r.created_at < ${s.end}
        GROUP BY 1),
      r AS (
        -- Remboursement partiel ou total : montant TTC seulement (la TVA remboursée n'est pas enregistrée).
        SELECT establishment_id AS id, sum(total)::bigint AS ttc, count(*)::int AS cnt
        FROM sale_returns
        WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${ids}::uuid[]) AND kind = 'REFUND' AND created_at >= ${s.start} AND created_at < ${s.end}
        GROUP BY 1),
      i AS (
        -- Factures émises hors tickets (une facture de ticket ne compte jamais une seconde fois).
        SELECT establishment_id AS id, sum(total)::bigint AS ttc, sum(tax_total)::bigint AS tax, count(*)::int AS cnt
        FROM invoices
        WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${ids}::uuid[]) AND number IS NOT NULL AND source <> 'SALE' AND issued_at >= ${s.start} AND issued_at < ${s.end}
        GROUP BY 1),
      cn AS (
        -- Tous les avoirs, y compris ceux des factures de tickets.
        SELECT cn.establishment_id AS id, sum(cn.total)::bigint AS ttc, sum(cn.tax_total)::bigint AS tax, count(*)::int AS cnt,
               sum(CASE WHEN inv.source = 'SALE' THEN cn.total ELSE 0 END)::bigint AS on_tickets
        FROM credit_notes cn JOIN invoices inv ON inv.id = cn.invoice_id
        WHERE cn.company_id = ${s.companyId}::uuid AND cn.establishment_id = ANY(${ids}::uuid[]) AND cn.created_at >= ${s.start} AND cn.created_at < ${s.end}
        GROUP BY 1)
      SELECT e.id::text AS id,
        coalesce(t.ttc, 0)::bigint AS tickets, coalesce(t.tax, 0)::bigint AS tickets_tax, coalesce(t.cnt, 0) AS tickets_count,
        coalesce(c.ttc, 0)::bigint AS cancels, coalesce(c.tax, 0)::bigint AS cancels_tax, coalesce(c.cnt, 0) AS cancels_count,
        coalesce(r.ttc, 0)::bigint AS refunds, coalesce(r.cnt, 0) AS refunds_count,
        coalesce(i.ttc, 0)::bigint AS invoices, coalesce(i.tax, 0)::bigint AS invoices_tax, coalesce(i.cnt, 0) AS invoices_count,
        coalesce(cn.ttc, 0)::bigint AS credits, coalesce(cn.tax, 0)::bigint AS credits_tax, coalesce(cn.cnt, 0) AS credits_count, coalesce(cn.on_tickets, 0)::bigint AS credits_on_tickets
      FROM e LEFT JOIN t ON t.id = e.id LEFT JOIN c ON c.id = e.id LEFT JOIN r ON r.id = e.id LEFT JOIN i ON i.id = e.id LEFT JOIN cn ON cn.id = e.id`;
  }

  shapeRevenue(r: Awaited<ReturnType<PilotageService['revenueRows']>>[number]) {
    const ticketsNet = r.tickets - r.cancels - r.refunds;
    const revenue = ticketsNet + r.invoices - r.credits;
    // TVA exacte seulement si aucun remboursement de ticket (non ventilé en TVA dans le module 5).
    const tax = r.refunds === 0n ? r.tickets_tax - r.cancels_tax + r.invoices_tax - r.credits_tax : null;
    return {
      tickets: { gross: r.tickets, count: r.tickets_count, tax: r.tickets_tax },
      cancellations: { amount: r.cancels, count: r.cancels_count, tax: r.cancels_tax },
      refunds: { amount: r.refunds, count: r.refunds_count, tax: null },
      ticketsNet,
      invoices: { amount: r.invoices, count: r.invoices_count, tax: r.invoices_tax },
      creditNotes: { amount: r.credits, count: r.credits_count, tax: r.credits_tax, onTicketInvoices: r.credits_on_tickets },
      revenue,
      tax,
      revenueExcludingTax: tax === null ? null : revenue - tax,
      taxNote: tax === null ? 'TVA non disponible : les remboursements de tickets ne sont pas ventilés par taux' : null,
    };
  }

  async revenue(me: AuthUser, q: PeriodQuery) {
    return this.revenueFor(this.scope(me, q));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async revenueFor(s: Scope) {
    const [rows, ests] = await Promise.all([this.revenueRows(s), this.establishments(s)]);
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      basis: 'TTC',
      total: this.shapeRevenue(this.sumRows(rows)),
      byEstablishment: ests.map((e) => ({ establishment: e, ...this.shapeRevenue(rows.find((r) => r.id === e.id)!) })),
    };
  }

  sumRows<T extends { id: string }>(rows: T[]): T {
    const out = { id: '' } as Record<string, unknown>;
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        if (k === 'id') continue;
        out[k] = typeof v === 'bigint' ? ((out[k] as bigint | undefined) ?? 0n) + v : ((out[k] as number | undefined) ?? 0) + Number(v);
      }
    }
    return out as T;
  }

  // --- Encaissements ------------------------------------------------------------------------

  private async collectionRows(s: Scope) {
    const ids = s.ids;
    return this.prisma.$queryRaw<{ id: string; source: string; type: string; method: string; amount: bigint; count: number }[]>`
      SELECT establishment_id::text AS id, 'REGISTER' AS source, type::text AS type, method::text AS method, sum(amount)::bigint AS amount, count(*)::int AS count
      FROM cash_movements
      WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${ids}::uuid[]) AND created_at >= ${s.start} AND created_at < ${s.end}
        AND type IN ('SALE', 'SALE_CANCEL', 'REFUND', 'CUSTOMER_PAYMENT', 'CUSTOMER_REFUND')
      GROUP BY 1, 4, 3
      UNION ALL
      -- Hors caisse (virement, chèque) : sans mouvement de caisse, donc jamais compté deux fois.
      SELECT establishment_id::text, 'OFF_REGISTER', 'CUSTOMER_PAYMENT', method::text, sum(amount)::bigint, count(*)::int
      FROM customer_payments
      WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${ids}::uuid[]) AND session_id IS NULL AND created_at >= ${s.start} AND created_at < ${s.end}
      GROUP BY 1, 4
      UNION ALL
      SELECT establishment_id::text, 'OFF_REGISTER', 'CUSTOMER_PAYMENT_CANCEL', method::text, -sum(amount)::bigint, count(*)::int
      FROM customer_payments
      WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${ids}::uuid[]) AND session_id IS NULL AND status = 'CANCELLED' AND cancelled_at >= ${s.start} AND cancelled_at < ${s.end}
      GROUP BY 1, 4
      UNION ALL
      SELECT establishment_id::text, 'OFF_REGISTER', 'CUSTOMER_REFUND', method::text, -sum(amount)::bigint, count(*)::int
      FROM customer_refunds
      WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${ids}::uuid[]) AND session_id IS NULL AND created_at >= ${s.start} AND created_at < ${s.end}
      GROUP BY 1, 4`;
  }

  /** Mouvements internes de caisse (fond, entrées et sorties manuelles) : présentés à part, jamais des encaissements. */
  private async internalRows(s: Scope) {
    return this.prisma.$queryRaw<{ id: string; type: string; amount: bigint; count: number }[]>`
      SELECT establishment_id::text AS id, type::text AS type, sum(amount)::bigint AS amount, count(*)::int AS count
      FROM cash_movements
      WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND created_at >= ${s.start} AND created_at < ${s.end}
        AND type IN ('OPENING_FLOAT', 'MANUAL_IN', 'MANUAL_OUT')
      GROUP BY 1, 2`;
  }

  private shapeCollections(rows: Awaited<ReturnType<PilotageService['collectionRows']>>, internal: Awaited<ReturnType<PilotageService['internalRows']>>) {
    const reg = rows.filter((r) => r.source === 'REGISTER');
    const off = rows.filter((r) => r.source === 'OFF_REGISTER');
    const tickets = sum(reg.filter((r) => ['SALE', 'SALE_CANCEL', 'REFUND'].includes(r.type)), (r) => r.amount);
    const customersRegister = sum(reg.filter((r) => ['CUSTOMER_PAYMENT', 'CUSTOMER_REFUND'].includes(r.type)), (r) => r.amount);
    const customersOff = sum(off, (r) => r.amount);
    const byMethod = new Map<string, bigint>();
    for (const r of rows) byMethod.set(r.method, (byMethod.get(r.method) ?? 0n) + r.amount);
    const byType = new Map<string, { amount: bigint; count: number }>();
    for (const r of rows) {
      const k = `${r.source}:${r.type}`;
      const cur = byType.get(k) ?? { amount: 0n, count: 0 };
      byType.set(k, { amount: cur.amount + r.amount, count: cur.count + r.count });
    }
    return {
      total: tickets + customersRegister + customersOff,
      tickets,
      customers: { register: customersRegister, offRegister: customersOff, total: customersRegister + customersOff },
      byMethod: [...byMethod].map(([method, amount]) => ({ method, amount })).sort((a, b) => a.method.localeCompare(b.method)),
      byType: [...byType].map(([k, v]) => ({ source: k.split(':')[0], type: k.split(':')[1], ...v })).sort((a, b) => `${a.source}${a.type}`.localeCompare(`${b.source}${b.type}`)),
      internalCashMovements: internal.map(({ id: _id, ...r }) => r),
    };
  }

  async collections(me: AuthUser, q: PeriodQuery) {
    return this.collectionsFor(this.scope(me, q));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async collectionsFor(s: Scope) {
    const [rows, internal, ests] = await Promise.all([this.collectionRows(s), this.internalRows(s), this.establishments(s)]);
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      total: this.shapeCollections(rows, this.mergeInternal(internal)),
      byEstablishment: ests.map((e) => ({ establishment: e, ...this.shapeCollections(rows.filter((r) => r.id === e.id), internal.filter((r) => r.id === e.id)) })),
    };
  }

  private mergeInternal(rows: Awaited<ReturnType<PilotageService['internalRows']>>) {
    const m = new Map<string, { id: string; type: string; amount: bigint; count: number }>();
    for (const r of rows) {
      const cur = m.get(r.type) ?? { id: '', type: r.type, amount: 0n, count: 0 };
      m.set(r.type, { ...cur, amount: cur.amount + r.amount, count: cur.count + r.count });
    }
    return [...m.values()];
  }

  // --- Rapprochement ------------------------------------------------------------------------

  /**
   * Situation clients à un instant t (exclu), par les calculs de position
   * communs du module 8 (même formule que le module 7) :
   * créances = reste dû des factures émises ; avances = acomptes disponibles
   * + paiements non répartis.
   */
  private async positionAt(s: Scope, t: Date) {
    return this.prisma.$queryRaw<{ id: string; receivables: bigint; advances: bigint; deposits: bigint }[]>`
      WITH e AS (SELECT unnest(${s.ids}::uuid[]) AS id),
      ${invoiceBalancesAt(s.companyId, s.ids, t)},
      ${advancesAt(s.companyId, s.ids, t)},
      r AS (SELECT establishment_id AS id, sum(balance)::bigint AS v FROM ib GROUP BY 1),
      d AS (SELECT establishment_id AS id, sum(available)::bigint AS v FROM dep GROUP BY 1),
      u AS (SELECT establishment_id AS id, sum(amount - allocated)::bigint AS v FROM pv GROUP BY 1)
      SELECT e.id::text AS id, coalesce(r.v, 0)::bigint AS receivables,
             (coalesce(d.v, 0) + coalesce(u.v, 0))::bigint AS advances, coalesce(d.v, 0)::bigint AS deposits
      FROM e LEFT JOIN r ON r.id = e.id LEFT JOIN d ON d.id = e.id LEFT JOIN u ON u.id = e.id`;
  }

  private bridge(
    rev: ReturnType<PilotageService['shapeRevenue']>,
    col: ReturnType<PilotageService['shapeCollections']>,
    open: { receivables: bigint; advances: bigint; deposits: bigint },
    close: { receivables: bigint; advances: bigint; deposits: bigint },
  ) {
    const gap = rev.revenue - col.total;
    const tickets = rev.ticketsNet - col.tickets;
    const receivablesChange = close.receivables - open.receivables;
    const advancesChange = close.advances - open.advances;
    const depositsChange = close.deposits - open.deposits;
    // Identité : CA − encaissements = écart tickets + variation des créances − variation des avances.
    const residual = gap - tickets - receivablesChange + advancesChange;
    return {
      revenue: rev.revenue,
      collections: col.total,
      gap,
      explanation: {
        ticketsTiming: tickets,
        receivablesChange,
        advancesChange,
        advancesDetail: { deposits: depositsChange, unappliedPayments: advancesChange - depositsChange },
        residual,
      },
      receivables: { opening: open.receivables, closing: close.receivables },
      advances: { opening: open.advances, closing: close.advances, depositsOpening: open.deposits, depositsClosing: close.deposits },
    };
  }

  async reconciliation(me: AuthUser, q: PeriodQuery) {
    return this.reconciliationFor(this.scope(me, q));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async reconciliationFor(s: Scope) {
    const [revRows, colRows, internal, opening, closing, ests] = await Promise.all([
      this.revenueRows(s),
      this.collectionRows(s),
      this.internalRows(s),
      this.positionAt(s, s.start),
      this.positionAt(s, s.end),
      this.establishments(s),
    ]);
    const pos = (rows: typeof opening, id?: string) => {
      const sel = id ? rows.filter((r) => r.id === id) : rows;
      return { receivables: sum(sel, (r) => r.receivables), advances: sum(sel, (r) => r.advances), deposits: sum(sel, (r) => r.deposits) };
    };
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      notes: [
        'Chiffre d’affaires TTC : tickets − annulations − remboursements + factures hors tickets − avoirs ; paiements et acomptes n’en font jamais partie.',
        'Variation des créances > 0 : ventes à crédit non encore encaissées ; variation des avances > 0 : sommes encaissées d’avance (acomptes, paiements non répartis).',
      ],
      total: this.bridge(this.shapeRevenue(this.sumRows(revRows)), this.shapeCollections(colRows, this.mergeInternal(internal)), pos(opening), pos(closing)),
      byEstablishment: ests.map((e) => ({
        establishment: e,
        ...this.bridge(
          this.shapeRevenue(revRows.find((r) => r.id === e.id)!),
          this.shapeCollections(colRows.filter((r) => r.id === e.id), internal.filter((r) => r.id === e.id)),
          pos(opening, e.id),
          pos(closing, e.id),
        ),
      })),
    };
  }
}

@ApiTags('Pilotage')
@ApiBearerAuth()
@Controller('pilotage')
export class PilotageController {
  constructor(private readonly service: PilotageService) {}

  @Get('revenue')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  revenue(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.revenue(me, q);
  }

  @Get('collections')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  collections(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.collections(me, q);
  }

  @Get('reconciliation')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  reconciliation(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.reconciliation(me, q);
  }
}
