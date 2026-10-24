import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { PilotageService } from './pilotage';
import { DASHBOARD, PeriodQuery, periodScope, Scope } from './positions';

const DETAIL = ['reports.view', 'sales.view'];
const UNCATEGORIZED = 'Non catégorisé';
const FEES = 'Frais et prestations';

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
/** Taux en pour cent à une décimale (null si base nulle). */
const rate = (part: Prisma.Decimal, base: Prisma.Decimal) => (base.isZero() ? null : part.mul(100).div(base).toDecimalPlaces(1).toNumber());

/**
 * Lignes de chiffre d'affaires de la période, à la maille de la ligne
 * commerciale, signées et datées selon les règles de l'étape 1 :
 * tickets (date du ticket), annulations et remboursements (leur date),
 * factures hors tickets (émission), avoirs (émission, toutes factures).
 * Catégorie et libellé produit : ceux figés sur la ligne (jamais le catalogue actuel).
 * Coût : lots réellement sortis (lignes de ticket, lots rendus, sorties
 * CUSTOMER_DELIVERY connues à la fin de la période) ; NULL quand il n'est pas
 * déterminable, avec la raison. Frais : aucun coût de stock.
 */
function revenueLines(s: Scope) {
  const { companyId: c, ids, start, end } = s;
  return Prisma.sql`
  iss AS (
    SELECT line_id, sum(value) AS v FROM customer_order_line_issues WHERE created_at < ${end} GROUP BY 1),
  rl AS (
    SELECT s.establishment_id AS est, 'TICKET' AS src, 'PRODUCT' AS kind, si.category_id, si.category_name, si.product_id, si.product_name AS product_label, s.created_at AS at,
           si.line_total::bigint AS revenue, si.tax_amount::bigint AS tax, si.quantity AS qty, si.cost_total AS cost, 1 AS lines, NULL::text AS reason
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE s.company_id = ${c}::uuid AND s.establishment_id = ANY(${ids}::uuid[]) AND s.created_at >= ${start} AND s.created_at < ${end}
    UNION ALL
    -- Annulation : tout le ticket repart (lots remis en stock), coût et TVA connus.
    SELECT r.establishment_id, 'CANCEL', 'PRODUCT', si.category_id, si.category_name, si.product_id, si.product_name, r.created_at,
           -si.line_total, -si.tax_amount, -si.quantity, -si.cost_total, 0, NULL
    FROM sale_returns r JOIN sale_items si ON si.sale_id = r.sale_id
    WHERE r.company_id = ${c}::uuid AND r.establishment_id = ANY(${ids}::uuid[]) AND r.kind = 'CANCEL' AND r.created_at >= ${start} AND r.created_at < ${end}
    UNION ALL
    -- Remboursement : coût des lots rendus ; sans lots tracés (addition du restaurant), coût non déterminable.
    SELECT r.establishment_id, 'REFUND', 'PRODUCT', si.category_id, si.category_name, si.product_id, si.product_name, r.created_at,
           -ri.amount, NULL::bigint, -ri.quantity,
           CASE WHEN EXISTS (SELECT 1 FROM sale_item_lots l WHERE l.sale_item_id = si.id)
                THEN -(SELECT coalesce(sum(x.quantity * l.unit_cost), 0) FROM sale_return_lots x JOIN sale_item_lots l ON l.id = x.sale_item_lot_id WHERE x.return_item_id = ri.id)
                END,
           0,
           CASE WHEN NOT EXISTS (SELECT 1 FROM sale_item_lots l WHERE l.sale_item_id = si.id) THEN 'REFUND_WITHOUT_LOTS' END
    FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id JOIN sale_items si ON si.id = ri.sale_item_id
    WHERE r.company_id = ${c}::uuid AND r.establishment_id = ANY(${ids}::uuid[]) AND r.kind = 'REFUND' AND r.created_at >= ${start} AND r.created_at < ${end}
    UNION ALL
    -- Factures hors tickets : coût des sorties de la commande connues à la fin de la période.
    SELECT i.establishment_id, 'INVOICE', il.kind::text, il.category_id, il.category_name, il.product_id, il.label, i.issued_at,
           il.line_total, il.tax_amount, il.quantity,
           CASE WHEN il.kind = 'FEE' THEN 0 ELSE iss.v END,
           1,
           CASE WHEN il.kind = 'PRODUCT' AND iss.v IS NULL THEN 'NOT_DELIVERED' END
    FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id LEFT JOIN iss ON iss.line_id = il.order_line_id
    WHERE i.company_id = ${c}::uuid AND i.establishment_id = ANY(${ids}::uuid[]) AND i.number IS NOT NULL AND i.source <> 'SALE'
      AND i.issued_at >= ${start} AND i.issued_at < ${end}
    UNION ALL
    -- Avoirs (toutes factures) : correction de prix sans retour de marchandise, coût inchangé.
    SELECT cn.establishment_id, 'CREDIT', il.kind::text, il.category_id, il.category_name, il.product_id, il.label, cn.created_at,
           -cl.amount, -cl.tax_amount, -coalesce(cl.quantity, 0),
           CASE WHEN il.kind = 'FEE' OR i.source = 'SALE' OR iss.v IS NOT NULL THEN 0 END,
           0,
           CASE WHEN il.kind = 'PRODUCT' AND i.source <> 'SALE' AND iss.v IS NULL THEN 'NOT_DELIVERED' END
    FROM credit_note_lines cl JOIN credit_notes cn ON cn.id = cl.credit_note_id
    JOIN invoice_lines il ON il.id = cl.invoice_line_id JOIN invoices i ON i.id = il.invoice_id
    LEFT JOIN iss ON iss.line_id = il.order_line_id
    WHERE cn.company_id = ${c}::uuid AND cn.establishment_id = ANY(${ids}::uuid[]) AND cn.created_at >= ${start} AND cn.created_at < ${end})`;
}

/**
 * Module 8 — Pilotage, étape 3 : ventes détaillées, catégories historiques,
 * marge brute et caisse. Lecture seule ; totaux de chiffre d'affaires repris
 * de l'étape 1 (PilotageService), jamais recalculés autrement.
 */
@Injectable()
export class SalesKpiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pilotage: PilotageService,
  ) {}

  private establishments(s: Scope) {
    return this.prisma.establishment.findMany({ where: { id: { in: s.ids }, companyId: s.companyId }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
  }

  // --- Ventes détaillées ----------------------------------------------------------------------

  async sales(me: AuthUser, q: PeriodQuery) {
    return this.salesFor(periodScope(me, q, [DASHBOARD]));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async salesFor(s: Scope) {
    const [rows, ests] = await Promise.all([this.pilotage.revenueRows(s), this.establishments(s)]);
    const shape = (r: (typeof rows)[number]) => {
      const rev = this.pilotage.shapeRevenue(r);
      const netTickets = r.tickets_count - r.cancels_count;
      return {
        ...rev,
        ticketCount: r.tickets_count,
        netTicketCount: netTickets,
        invoiceCount: r.invoices_count,
        // Panier moyen : tickets nets (annulations et remboursements déduits) par ticket non annulé.
        averageTicket: netTickets > 0 ? D(rev.ticketsNet.toString()).div(netTickets).toDecimalPlaces(0).toNumber() : null,
        averageInvoice: r.invoices_count > 0 ? D(r.invoices.toString()).div(r.invoices_count).toDecimalPlaces(0).toNumber() : null,
      };
    };
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      basis: 'TTC',
      total: shape(this.pilotage.sumRows(rows)),
      byEstablishment: ests.map((e) => ({ establishment: e, ...shape(rows.find((r) => r.id === e.id)!) })),
    };
  }

  // --- Catégories -------------------------------------------------------------------------------

  async categories(me: AuthUser, q: PeriodQuery) {
    return this.categoriesFor(periodScope(me, q, DETAIL));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async categoriesFor(s: Scope) {
    const rows = await this.prisma.$queryRaw<
      { category_id: string | null; name: string | null; fees: boolean; revenue: bigint; tax: bigint | null; quantity: Prisma.Decimal; lines: number; cogs: Prisma.Decimal; covered: bigint }[]
    >`
      WITH ${revenueLines(s)}
      SELECT category_id::text AS category_id,
             (array_agg(category_name ORDER BY at DESC))[1] AS name,
             (kind = 'FEE') AS fees,
             sum(revenue)::bigint AS revenue,
             CASE WHEN bool_or(tax IS NULL) THEN NULL ELSE sum(tax)::bigint END AS tax,
             sum(CASE WHEN kind = 'PRODUCT' THEN qty ELSE 0 END) AS quantity,
             sum(lines)::int AS lines,
             coalesce(sum(cost) FILTER (WHERE kind = 'PRODUCT' AND cost IS NOT NULL), 0) AS cogs,
             coalesce(sum(revenue) FILTER (WHERE kind = 'PRODUCT' AND cost IS NOT NULL), 0)::bigint AS covered
      FROM rl
      GROUP BY category_id, (kind = 'FEE')
      ORDER BY sum(revenue) DESC`;
    const total = rows.reduce((a, r) => a + r.revenue, 0n);
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      basis: 'TTC',
      notes: ['Catégorie figée sur chaque ligne au moment de la vente, de la commande ou de la facture ; le catalogue actuel n’est pas relu.'],
      total,
      categories: rows.map((r) => {
        const cogs = D(r.cogs);
        const covered = D(r.covered.toString());
        return {
          categoryId: r.fees ? null : r.category_id,
          name: r.fees ? FEES : r.category_id ? r.name : UNCATEGORIZED,
          kind: r.fees ? 'FEES' : r.category_id ? 'CATEGORY' : 'UNCATEGORIZED',
          revenue: r.revenue,
          share: rate(D(r.revenue.toString()), D(total.toString())),
          tax: r.tax,
          quantity: r.fees ? null : D(r.quantity).toNumber(),
          lines: r.lines,
          margin: r.fees ? null : { revenueWithCost: r.covered, cogs: cogs.toDecimalPlaces(2), grossMargin: covered.sub(cogs).toDecimalPlaces(2), rate: rate(covered.sub(cogs), covered) },
        };
      }),
    };
  }

  // --- Produits ---------------------------------------------------------------------------------

  /** Classement des produits (lignes produit seulement), mêmes lignes que les catégories et la marge. */
  async products(me: AuthUser, q: PeriodQuery) {
    return this.productsFor(periodScope(me, q, DETAIL));
  }

  async productsFor(s: Scope, limit = 50) {
    const rows = await this.prisma.$queryRaw<{ product_id: string; name: string; code: string | null; revenue: bigint; quantity: Prisma.Decimal; lines: number; cogs: Prisma.Decimal; covered: bigint }[]>`
      WITH ${revenueLines(s)}
      SELECT rl.product_id::text AS product_id, (array_agg(rl.product_label ORDER BY rl.at DESC))[1] AS name, max(p.code) AS code,
             sum(rl.revenue)::bigint AS revenue, sum(rl.qty) AS quantity, sum(rl.lines)::int AS lines,
             coalesce(sum(rl.cost) FILTER (WHERE rl.cost IS NOT NULL), 0) AS cogs,
             coalesce(sum(rl.revenue) FILTER (WHERE rl.cost IS NOT NULL), 0)::bigint AS covered
      FROM rl LEFT JOIN products p ON p.id = rl.product_id
      WHERE rl.kind = 'PRODUCT' AND rl.product_id IS NOT NULL
      GROUP BY rl.product_id
      ORDER BY sum(rl.revenue) DESC, max(p.code) LIMIT ${limit}`;
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      basis: 'TTC',
      notes: ['Libellé figé sur les lignes de vente et de facture ; frais exclus.'],
      products: rows.map((r) => {
        const cogs = D(r.cogs);
        const covered = D(r.covered.toString());
        return {
          productId: r.product_id,
          code: r.code,
          name: r.name,
          revenue: r.revenue,
          quantity: D(r.quantity).toNumber(),
          lines: r.lines,
          margin: { revenueWithCost: r.covered, cogs: cogs.toDecimalPlaces(2), grossMargin: covered.sub(cogs).toDecimalPlaces(2), rate: rate(covered.sub(cogs), covered) },
        };
      }),
    };
  }

  // --- Marge brute ----------------------------------------------------------------------------

  async margin(me: AuthUser, q: PeriodQuery) {
    return this.marginFor(periodScope(me, q, DETAIL));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async marginFor(s: Scope) {
    const [rows, ests] = await Promise.all([
      this.prisma.$queryRaw<{ est: string; part: string; reason: string | null; revenue: bigint; cogs: Prisma.Decimal | null; lines: number }[]>`
        WITH ${revenueLines(s)}
        SELECT est::text AS est,
               CASE WHEN kind = 'FEE' THEN 'FEES' WHEN cost IS NULL THEN 'UNCOVERED' ELSE 'GOODS' END AS part,
               reason, sum(revenue)::bigint AS revenue, sum(cost) AS cogs, count(*)::int AS lines
        FROM rl GROUP BY 1, 2, 3`,
      this.establishments(s),
    ]);
    const shape = (sel: typeof rows) => {
      const goods = sel.filter((r) => r.part === 'GOODS');
      const revenue = goods.reduce((a, r) => a + r.revenue, 0n);
      const cogs = goods.reduce((a, r) => a.add(D(r.cogs)), D(0));
      const gross = D(revenue.toString()).sub(cogs);
      const uncovered = sel.filter((r) => r.part === 'UNCOVERED');
      const fees = sel.filter((r) => r.part === 'FEES').reduce((a, r) => a + r.revenue, 0n);
      const unc = uncovered.reduce((a, r) => a + r.revenue, 0n);
      return {
        goods: { revenue, cogs: cogs.toDecimalPlaces(2), grossMargin: gross.toDecimalPlaces(2), rate: rate(gross, D(revenue.toString())) },
        fees: { revenue: fees, note: 'Frais et prestations : aucun coût de stock, hors marge' },
        uncovered: {
          revenue: unc,
          reasons: ['NOT_DELIVERED', 'REFUND_WITHOUT_LOTS']
            .map((reason) => ({ reason, revenue: uncovered.filter((r) => r.reason === reason).reduce((a, r) => a + r.revenue, 0n), lines: uncovered.filter((r) => r.reason === reason).reduce((a, r) => a + r.lines, 0) }))
            .filter((r) => r.lines > 0),
        },
        revenue: revenue + fees + unc,
        coverage: rate(D(revenue.toString()), D((revenue + fees + unc).toString())),
      };
    };
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      basis: 'TTC',
      notes: [
        'Marge brute calculée seulement sur les ventes dont le coût réel est connu (lots sortis, lots rendus, sorties CUSTOMER_DELIVERY).',
        'NOT_DELIVERED : produit facturé non encore livré à la fin de la période ; REFUND_WITHOUT_LOTS : remboursement d’une addition du restaurant (lots non tracés au ticket).',
        'Les montants de vente sont TTC ; les coûts sont ceux des lots (achat ou production).',
      ],
      total: shape(rows),
      byEstablishment: ests.map((e) => ({ establishment: e, ...shape(rows.filter((r) => r.est === e.id)) })),
    };
  }

  // --- Caisse ---------------------------------------------------------------------------------

  async cash(me: AuthUser, q: PeriodQuery) {
    return this.cashFor(periodScope(me, q, [DASHBOARD]));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async cashFor(s: Scope) {
    const [movements, sessions, closures, ests] = await Promise.all([
      this.prisma.$queryRaw<{ est: string; type: string; method: string; amount: bigint; count: number }[]>`
        SELECT establishment_id::text AS est, type::text AS type, method::text AS method, sum(amount)::bigint AS amount, count(*)::int AS count
        FROM cash_movements
        WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND created_at >= ${s.start} AND created_at < ${s.end}
        GROUP BY 1, 2, 3`,
      this.prisma.$queryRaw<{ est: string; opened: number; closed: number; validated: number; open_at_end: number; closed_unvalidated_at_end: number; with_difference: number }[]>`
        SELECT establishment_id::text AS est,
               count(*) FILTER (WHERE opened_at >= ${s.start} AND opened_at < ${s.end})::int AS opened,
               count(*) FILTER (WHERE closed_at >= ${s.start} AND closed_at < ${s.end})::int AS closed,
               count(*) FILTER (WHERE validated_at >= ${s.start} AND validated_at < ${s.end})::int AS validated,
               count(*) FILTER (WHERE opened_at < ${s.end} AND (closed_at IS NULL OR closed_at >= ${s.end}))::int AS open_at_end,
               count(*) FILTER (WHERE closed_at < ${s.end} AND (validated_at IS NULL OR validated_at >= ${s.end}))::int AS closed_unvalidated_at_end,
               count(*) FILTER (WHERE closed_at >= ${s.start} AND closed_at < ${s.end}
                                  AND EXISTS (SELECT 1 FROM cash_closures c WHERE c.session_id = cash_sessions.id AND c.difference <> 0))::int AS with_difference
        FROM cash_sessions
        WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND opened_at < ${s.end}
        GROUP BY 1`,
      this.prisma.$queryRaw<{ est: string; method: string; expected: bigint; counted: bigint; difference: bigint }[]>`
        SELECT cs.establishment_id::text AS est, c.method::text AS method, sum(c.expected)::bigint AS expected, sum(c.counted)::bigint AS counted,
               sum(c.difference)::bigint AS difference
        FROM cash_closures c JOIN cash_sessions cs ON cs.id = c.session_id
        WHERE cs.company_id = ${s.companyId}::uuid AND cs.establishment_id = ANY(${s.ids}::uuid[]) AND cs.closed_at >= ${s.start} AND cs.closed_at < ${s.end}
        GROUP BY 1, 2`,
      this.establishments(s),
    ]);
    const shape = (id?: string) => {
      const pick = <T extends { est: string }>(rows: T[]) => (id ? rows.filter((r) => r.est === id) : rows);
      const mv = pick(movements);
      const of = (...types: string[]) => mv.filter((m) => types.includes(m.type)).reduce((a, m) => a + m.amount, 0n);
      const ss = pick(sessions);
      const cl = pick(closures);
      const sumS = (k: keyof (typeof sessions)[number]) => ss.reduce((a, r) => a + Number(r[k]), 0);
      const differenceByMethod = new Map<string, { expected: bigint; counted: bigint; difference: bigint }>();
      for (const c of cl) {
        const cur = differenceByMethod.get(c.method) ?? { expected: 0n, counted: 0n, difference: 0n };
        differenceByMethod.set(c.method, { expected: cur.expected + c.expected, counted: cur.counted + c.counted, difference: cur.difference + c.difference });
      }
      return {
        sessions: { opened: sumS('opened'), closed: sumS('closed'), validated: sumS('validated'), openAtEnd: sumS('open_at_end'), closedNotValidatedAtEnd: sumS('closed_unvalidated_at_end') },
        movements: {
          ticketSales: of('SALE'),
          ticketCancellations: of('SALE_CANCEL'),
          ticketRefunds: of('REFUND'),
          ticketsNet: of('SALE', 'SALE_CANCEL', 'REFUND'),
          customerPayments: of('CUSTOMER_PAYMENT'),
          customerRefunds: of('CUSTOMER_REFUND'),
          openingFloats: of('OPENING_FLOAT'),
          manualIn: of('MANUAL_IN'),
          manualOut: of('MANUAL_OUT'),
          byMethod: [...new Set(mv.map((m) => m.method))].sort().map((method) => ({ method, amount: mv.filter((m) => m.method === method).reduce((a, m) => a + m.amount, 0n) })),
        },
        closures: {
          sessionsWithDifference: sumS('with_difference'),
          totalDifference: cl.reduce((a, c) => a + c.difference, 0n),
          byMethod: [...differenceByMethod].map(([method, v]) => ({ method, ...v })).sort((a, b) => a.method.localeCompare(b.method)),
        },
      };
    };
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      notes: [
        'Mouvements de caisse du module 5 : les ventes et paiements clients en caisse sont les mêmes montants que les encaissements « caisse » (ne pas les additionner) ; le fond de caisse et les entrées et sorties manuelles ne sont ni du chiffre d’affaires ni des encaissements.',
        'Écarts : clôtures des sessions fermées dans la période (compté − attendu).',
      ],
      total: shape(),
      byEstablishment: ests.map((e) => ({ establishment: e, ...shape(e.id) })),
    };
  }
}

@ApiTags('Pilotage')
@ApiBearerAuth()
@Controller('pilotage')
export class SalesKpiController {
  constructor(private readonly service: SalesKpiService) {}

  @Get('sales')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  sales(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.sales(me, q);
  }

  @Get('sales/categories')
  @RequirePermissions(...DETAIL)
  @AnyEstablishmentScope()
  categories(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.categories(me, q);
  }

  @Get('sales/products')
  @RequirePermissions(...DETAIL)
  @AnyEstablishmentScope()
  products(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.products(me, q);
  }

  @Get('margin')
  @RequirePermissions(...DETAIL)
  @AnyEstablishmentScope()
  margin(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.margin(me, q);
  }

  @Get('cash')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  cash(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.cash(me, q);
  }
}
