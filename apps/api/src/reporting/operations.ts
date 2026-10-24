import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { DASHBOARD, PeriodQuery, periodScope, Scope } from './positions';

const PURCHASES_DETAIL = ['reports.view', 'purchases.view'];
const STOCK_DETAIL = ['reports.view', 'stock.view'];
const PRODUCTION_DETAIL = ['reports.view', 'production.view'];
const STATUSES = ['PLANNED', 'VALIDATED', 'IN_PROGRESS', 'COMPLETED', 'CONTROLLED', 'CANCELLED'] as const;

const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
const pct = (part: Prisma.Decimal, base: Prisma.Decimal) => (base.isZero() ? null : part.mul(100).div(base).toDecimalPlaces(1).toNumber());
/** Date du jour UTC (Abidjan), même règle de péremption que le module 3. */
const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * Soldes de stock actuels par article et établissement, selon les définitions
 * du module 3 (StockViewService.items) : valeur = quantité × coût du lot ;
 * disponible = quantité − réservé − périmé ; statut d'un article à seuil :
 * CRITICAL si disponible ≤ minimum, ALERT si ≤ seuil d'alerte, sinon OK.
 * Articles à seuil sans stock inclus (disponible 0) ; jamais de statut sans seuil.
 */
function stockItems(s: Scope) {
  return Prisma.sql`
  bal AS (
    SELECT b.establishment_id, b.raw_material_id, b.product_id, b.quantity, b.reserved_quantity, l.unit_cost, l.origin,
           (l.expiry_date IS NOT NULL AND l.expiry_date < ${todayISO()}::date) AS expired
    FROM stock_balances b JOIN stock_lots l ON l.id = b.lot_id
    WHERE b.company_id = ${s.companyId}::uuid AND b.establishment_id = ANY(${s.ids}::uuid[]) AND b.quantity > 0),
  agg AS (
    SELECT establishment_id, raw_material_id, product_id, sum(quantity) AS q, sum(reserved_quantity) AS r,
           sum(CASE WHEN expired THEN quantity ELSE 0 END) AS x, sum(quantity * unit_cost) AS v
    FROM bal GROUP BY 1, 2, 3),
  thr AS (
    SELECT establishment_id, raw_material_id, product_id, min_quantity, alert_quantity
    FROM stock_thresholds WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[])),
  it AS (
    SELECT coalesce(a.establishment_id, t.establishment_id) AS est, coalesce(a.raw_material_id, t.raw_material_id) AS raw_id,
           coalesce(a.product_id, t.product_id) AS prod_id,
           coalesce(a.q, 0) AS q, coalesce(a.r, 0) AS r, coalesce(a.x, 0) AS x, coalesce(a.v, 0) AS v,
           (t.establishment_id IS NOT NULL) AS has_threshold, t.min_quantity, t.alert_quantity,
           coalesce(a.q, 0) - coalesce(a.r, 0) - coalesce(a.x, 0) AS available
    -- Un article est une matière OU un produit (jamais les deux) : son identifiant suffit à joindre.
    FROM agg a FULL JOIN thr t ON t.establishment_id = a.establishment_id
      AND coalesce(t.raw_material_id, t.product_id) = coalesce(a.raw_material_id, a.product_id)),
  st AS (
    SELECT it.*, CASE WHEN NOT has_threshold THEN 'NONE'
                      WHEN available <= min_quantity THEN 'CRITICAL'
                      WHEN available <= alert_quantity THEN 'ALERT' ELSE 'OK' END AS status,
           coalesce(rm.base_unit_code, p.sale_unit_code) AS unit, coalesce(rm.name, p.name) AS name, coalesce(rm.code, p.code) AS code
    FROM it LEFT JOIN raw_materials rm ON rm.id = it.raw_id LEFT JOIN products p ON p.id = it.prod_id)`;
}

/**
 * Module 8 — Pilotage, étape 4 : achats, stock et production. Lecture seule ;
 * données des modules 3 et 4 telles qu'enregistrées (réceptions et retours
 * fournisseurs, soldes et mouvements de stock, ordres et sorties de production).
 */
@Injectable()
export class OperationsKpiService {
  constructor(private readonly prisma: PrismaService) {}

  private establishments(s: Scope) {
    return this.prisma.establishment.findMany({ where: { id: { in: s.ids }, companyId: s.companyId }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
  }

  // --- Achats ---------------------------------------------------------------------------------

  async purchases(me: AuthUser, q: PeriodQuery) {
    return this.purchasesFor(periodScope(me, q, [DASHBOARD]));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async purchasesFor(s: Scope) {
    const [rows, months, ests] = await Promise.all([
      this.prisma.$queryRaw<{ id: string; receipts: bigint; receipts_count: number; returns: bigint; returns_count: number }[]>`
        WITH e AS (SELECT unnest(${s.ids}::uuid[]) AS id),
        r AS (SELECT establishment_id AS id, sum(total_value)::bigint AS v, count(*)::int AS n FROM goods_receipts
              WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND received_at >= ${s.start} AND received_at < ${s.end} GROUP BY 1),
        t AS (SELECT establishment_id AS id, sum(total_value)::bigint AS v, count(*)::int AS n FROM supplier_returns
              WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND created_at >= ${s.start} AND created_at < ${s.end} GROUP BY 1)
        SELECT e.id::text AS id, coalesce(r.v, 0)::bigint AS receipts, coalesce(r.n, 0) AS receipts_count, coalesce(t.v, 0)::bigint AS returns, coalesce(t.n, 0) AS returns_count
        FROM e LEFT JOIN r ON r.id = e.id LEFT JOIN t ON t.id = e.id`,
      this.prisma.$queryRaw<{ month: string; receipts: bigint; returns: bigint }[]>`
        SELECT to_char(m, 'YYYY-MM') AS month, sum(receipts)::bigint AS receipts, sum(returns)::bigint AS returns FROM (
          SELECT date_trunc('month', received_at AT TIME ZONE 'UTC') AS m, total_value AS receipts, 0 AS returns FROM goods_receipts
          WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND received_at >= ${s.start} AND received_at < ${s.end}
          UNION ALL
          SELECT date_trunc('month', created_at AT TIME ZONE 'UTC'), 0, total_value FROM supplier_returns
          WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND created_at >= ${s.start} AND created_at < ${s.end}) x
        GROUP BY 1 ORDER BY 1`,
      this.establishments(s),
    ]);
    const shape = (sel: typeof rows) => {
      const receipts = sel.reduce((a, r) => a + r.receipts, 0n);
      const returns = sel.reduce((a, r) => a + r.returns, 0n);
      return {
        receipts: { amount: receipts, count: sel.reduce((a, r) => a + r.receipts_count, 0) },
        returns: { amount: returns, count: sel.reduce((a, r) => a + r.returns_count, 0) },
        netPurchases: receipts - returns,
      };
    };
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      notes: [
        'Achats = réceptions acceptées (date de réception) − retours fournisseurs (date du retour), aux prix de réception ; les factures fournisseurs ne servent pas de base.',
        'Les sorties de stock (ventes, livraisons de commandes, production) ne sont jamais des achats.',
      ],
      total: shape(rows),
      byMonth: months.map((m) => ({ month: m.month, receipts: m.receipts, returns: m.returns, netPurchases: m.receipts - m.returns })),
      byEstablishment: ests.map((e) => ({ establishment: e, ...shape(rows.filter((r) => r.id === e.id)) })),
    };
  }

  /** Détail par fournisseur : « Consulter les rapports » + « Voir les achats ». */
  async purchasesBySupplier(me: AuthUser, q: PeriodQuery) {
    return this.purchasesBySupplierFor(periodScope(me, q, PURCHASES_DETAIL));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async purchasesBySupplierFor(s: Scope) {
    const rows = await this.prisma.$queryRaw<{ supplier_id: string; code: string; name: string; receipts: bigint; receipts_count: number; returns: bigint; returns_count: number }[]>`
      WITH r AS (SELECT supplier_id, sum(total_value)::bigint AS v, count(*)::int AS n FROM goods_receipts
                 WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND received_at >= ${s.start} AND received_at < ${s.end} GROUP BY 1),
           t AS (SELECT supplier_id, sum(total_value)::bigint AS v, count(*)::int AS n FROM supplier_returns
                 WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND created_at >= ${s.start} AND created_at < ${s.end} GROUP BY 1)
      SELECT sp.id::text AS supplier_id, sp.code, sp.name, coalesce(r.v, 0)::bigint AS receipts, coalesce(r.n, 0) AS receipts_count,
             coalesce(t.v, 0)::bigint AS returns, coalesce(t.n, 0) AS returns_count
      FROM suppliers sp JOIN (SELECT supplier_id FROM r UNION SELECT supplier_id FROM t) u ON u.supplier_id = sp.id
      LEFT JOIN r ON r.supplier_id = sp.id LEFT JOIN t ON t.supplier_id = sp.id
      ORDER BY coalesce(r.v, 0) - coalesce(t.v, 0) DESC, sp.code`;
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      suppliers: rows.map((r) => ({
        supplier: { id: r.supplier_id, code: r.code, name: r.name },
        receipts: { amount: r.receipts, count: r.receipts_count },
        returns: { amount: r.returns, count: r.returns_count },
        netPurchases: r.receipts - r.returns,
      })),
    };
  }

  // --- Stock ----------------------------------------------------------------------------------

  async stock(me: AuthUser, q: PeriodQuery) {
    return this.stockFor(periodScope(me, q, [DASHBOARD]));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async stockFor(s: Scope) {
    const [items, units, valuation, movements, ests] = await Promise.all([
      this.prisma.$queryRaw<
        { est: string; in_stock: number; with_reserved: number; with_threshold: number; ok: number; alert: number; critical: number; out_of_stock: number; without_threshold: number; value: Prisma.Decimal; expired_value: Prisma.Decimal }[]
      >`
        WITH ${stockItems(s)},
        ev AS (SELECT establishment_id AS est, sum(quantity * unit_cost) AS v FROM bal WHERE expired GROUP BY 1)
        SELECT st.est::text AS est,
               count(*) FILTER (WHERE q > 0)::int AS in_stock,
               count(*) FILTER (WHERE r > 0)::int AS with_reserved,
               count(*) FILTER (WHERE has_threshold)::int AS with_threshold,
               count(*) FILTER (WHERE status = 'OK')::int AS ok,
               count(*) FILTER (WHERE status = 'ALERT')::int AS alert,
               count(*) FILTER (WHERE status = 'CRITICAL')::int AS critical,
               count(*) FILTER (WHERE has_threshold AND available <= 0)::int AS out_of_stock,
               count(*) FILTER (WHERE NOT has_threshold AND q > 0)::int AS without_threshold,
               coalesce(sum(st.v), 0) AS value,
               coalesce(max(ev.v), 0) AS expired_value
        FROM st LEFT JOIN ev ON ev.est = st.est GROUP BY 1`,
      this.prisma.$queryRaw<{ est: string; kind: string; unit: string; quantity: Prisma.Decimal; reserved: Prisma.Decimal; expired: Prisma.Decimal; available: Prisma.Decimal }[]>`
        WITH ${stockItems(s)}
        SELECT est::text AS est, CASE WHEN raw_id IS NOT NULL THEN 'RAW_MATERIAL' ELSE 'PRODUCT' END AS kind, unit,
               sum(q) AS quantity, sum(r) AS reserved, sum(x) AS expired, sum(greatest(available, 0)) AS available
        FROM st WHERE q > 0 GROUP BY 1, 2, 3`,
      // Valorisation selon l'origine du coût des lots : réel (achat, production), déclaré (inventaire, correction), nul.
      this.prisma.$queryRaw<{ est: string; basis: string; value: Prisma.Decimal; lots: number }[]>`
        WITH ${stockItems(s)}
        SELECT establishment_id::text AS est,
               CASE WHEN unit_cost = 0 THEN 'NOT_VALUED' WHEN origin IN ('RECEIPT', 'PRODUCTION') THEN 'REAL_COST' ELSE 'DECLARED_COST' END AS basis,
               sum(quantity * unit_cost) AS value, count(*)::int AS lots
        FROM bal GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ est: string; type: string; value: Prisma.Decimal; count: number }[]>`
        SELECT establishment_id::text AS est, type::text AS type, sum(value) AS value, count(*)::int AS count
        FROM stock_movements
        WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND created_at >= ${s.start} AND created_at < ${s.end}
        GROUP BY 1, 2`,
      this.establishments(s),
    ]);
    const shape = (id?: string) => {
      const pick = <T extends { est: string }>(rows: T[]) => (id ? rows.filter((r) => r.est === id) : rows);
      const it = pick(items);
      const n = (k: keyof (typeof items)[number]) => it.reduce((a, r) => a + Number(r[k]), 0);
      const val = pick(valuation);
      const byBasis = (b: string) => val.filter((v) => v.basis === b).reduce((a, v) => ({ value: a.value.add(D(v.value)), lots: a.lots + v.lots }), { value: D(0), lots: 0 });
      const mv = pick(movements);
      const types = [...new Set(mv.map((m) => m.type))].sort();
      const unitRows = pick(units);
      const unitKeys = [...new Set(unitRows.map((u) => `${u.kind}|${u.unit}`))].sort();
      return {
        items: {
          inStock: n('in_stock'),
          withReservedStock: n('with_reserved'),
          withThreshold: n('with_threshold'),
          withoutThreshold: n('without_threshold'),
          status: { ok: n('ok'), alert: n('alert'), critical: n('critical') },
          outOfStock: n('out_of_stock'),
          belowThreshold: n('alert') + n('critical'),
        },
        quantities: unitKeys.map((k) => {
          const sel = unitRows.filter((u) => `${u.kind}|${u.unit}` === k);
          const sum = (f: (u: (typeof unitRows)[number]) => Prisma.Decimal) => sel.reduce((a, u) => a.add(D(f(u))), D(0)).toNumber();
          return { kind: sel[0].kind, unit: sel[0].unit, quantity: sum((u) => u.quantity), reserved: sum((u) => u.reserved), expired: sum((u) => u.expired), available: sum((u) => u.available) };
        }),
        valuation: {
          total: it.reduce((a, r) => a.add(D(r.value)), D(0)).toDecimalPlaces(0),
          realCost: byBasis('REAL_COST').value.toDecimalPlaces(0),
          declaredCost: byBasis('DECLARED_COST').value.toDecimalPlaces(0),
          notValued: { lots: byBasis('NOT_VALUED').lots },
          expired: it.reduce((a, r) => a.add(D(r.expired_value)), D(0)).toDecimalPlaces(0),
        },
        movements: {
          byType: types.map((type) => ({ type, value: mv.filter((m) => m.type === type).reduce((a, m) => a.add(D(m.value)), D(0)).toDecimalPlaces(2), count: mv.filter((m) => m.type === type).reduce((a, m) => a + m.count, 0) })),
          inValue: mv.filter((m) => D(m.value).gt(0)).reduce((a, m) => a.add(D(m.value)), D(0)).toDecimalPlaces(2),
          outValue: mv.filter((m) => D(m.value).lt(0)).reduce((a, m) => a.add(D(m.value)), D(0)).toDecimalPlaces(2),
        },
      };
    };
    return {
      period: { from: s.from, to: s.to },
      asOf: 'now',
      currency: 'XOF',
      notes: [
        'Stock, réservations et valeur : situation actuelle du module 3 ; mouvements : ceux de la période.',
        'Rupture et sous-seuil seulement pour les articles ayant un seuil ; un article sans seuil n’a pas de statut.',
        'Valorisation au coût des lots : réel (réception, production), déclaré (inventaire, correction) ; lots à coût nul non valorisés.',
        'Le stock réservé reste en stock tant qu’il n’est pas sorti (livraison, vente).',
      ],
      total: shape(),
      byEstablishment: ests.map((e) => ({ establishment: e, ...shape(e.id) })),
    };
  }

  /** Articles sous seuil ou en rupture, nominatifs : « Consulter les rapports » + « Voir les stocks ». */
  async stockAlerts(me: AuthUser, q: PeriodQuery) {
    return this.stockAlertsFor(periodScope(me, q, STOCK_DETAIL));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async stockAlertsFor(s: Scope) {
    const rows = await this.prisma.$queryRaw<
      { est: string; raw_id: string | null; prod_id: string | null; code: string; name: string; unit: string; q: Prisma.Decimal; r: Prisma.Decimal; x: Prisma.Decimal; available: Prisma.Decimal; min_quantity: Prisma.Decimal; alert_quantity: Prisma.Decimal; status: string }[]
    >`
      WITH ${stockItems(s)}
      SELECT est::text AS est, raw_id::text AS raw_id, prod_id::text AS prod_id, code, name, unit, q, r, x, available, min_quantity, alert_quantity, status
      FROM st WHERE status IN ('ALERT', 'CRITICAL')
      ORDER BY (status = 'CRITICAL') DESC, available ASC, code LIMIT 200`;
    const ests = await this.establishments(s);
    return {
      period: { from: s.from, to: s.to },
      asOf: 'now',
      items: rows.map((r) => ({
        establishment: ests.find((e) => e.id === r.est) ?? null,
        kind: r.raw_id ? 'RAW_MATERIAL' : 'PRODUCT',
        id: r.raw_id ?? r.prod_id,
        code: r.code,
        name: r.name,
        unit: r.unit,
        quantity: D(r.q).toNumber(),
        reserved: D(r.r).toNumber(),
        expired: D(r.x).toNumber(),
        available: Prisma.Decimal.max(D(r.available), 0).toNumber(),
        minQuantity: D(r.min_quantity).toNumber(),
        alertQuantity: D(r.alert_quantity).toNumber(),
        status: r.status,
        outOfStock: D(r.available).lte(0),
      })),
    };
  }

  // --- Production -----------------------------------------------------------------------------

  /**
   * Ordres de production : statut à la fin de la période reconstitué par les
   * horodatages du module 4 (validation, lancement, fin, contrôle, annulation).
   */
  private productionSql(s: Scope, detail: boolean) {
    const group = detail ? Prisma.sql`product_id` : Prisma.sql`establishment_id`;
    return Prisma.sql`
      WITH po AS (
        SELECT o.*, CASE WHEN cancelled_at < ${s.end} THEN 'CANCELLED' WHEN controlled_at < ${s.end} THEN 'CONTROLLED'
                         WHEN completed_at < ${s.end} THEN 'COMPLETED' WHEN started_at < ${s.end} THEN 'IN_PROGRESS'
                         WHEN validated_at < ${s.end} THEN 'VALIDATED' ELSE 'PLANNED' END AS status_at
        FROM production_orders o
        WHERE o.company_id = ${s.companyId}::uuid AND o.establishment_id = ANY(${s.ids}::uuid[]) AND o.created_at < ${s.end}),
      outp AS (
        SELECT po.${group} AS k, sum(x.quantity) AS qty, sum(x.quantity * x.unit_cost) AS value
        FROM production_outputs x JOIN po ON po.id = x.order_id WHERE x.created_at >= ${s.start} AND x.created_at < ${s.end} GROUP BY 1),
      loss AS (
        SELECT po.${group} AS k,
               sum(l.quantity) FILTER (WHERE l.stage = 'COMPLETION') AS completion_qty, sum(l.value) FILTER (WHERE l.stage = 'COMPLETION') AS completion_value,
               sum(l.quantity) FILTER (WHERE l.stage = 'CONTROL') AS control_qty, sum(l.value) FILTER (WHERE l.stage = 'CONTROL') AS control_value
        FROM production_losses l JOIN po ON po.id = l.order_id WHERE l.created_at >= ${s.start} AND l.created_at < ${s.end} GROUP BY 1),
      agg AS (
        SELECT ${group} AS k,
               count(*) FILTER (WHERE created_at >= ${s.start}) AS created, sum(planned_quantity) FILTER (WHERE created_at >= ${s.start}) AS created_planned,
               count(*) FILTER (WHERE completed_at >= ${s.start} AND completed_at < ${s.end}) AS completed,
               sum(planned_quantity) FILTER (WHERE completed_at >= ${s.start} AND completed_at < ${s.end}) AS completed_planned,
               sum(produced_quantity) FILTER (WHERE completed_at >= ${s.start} AND completed_at < ${s.end}) AS completed_produced,
               count(*) FILTER (WHERE cancelled_at >= ${s.start} AND cancelled_at < ${s.end}) AS cancelled,
               count(*) FILTER (WHERE status_at IN ('PLANNED', 'VALIDATED', 'IN_PROGRESS')) AS in_progress_at_end,
               count(*) FILTER (WHERE status_at = 'PLANNED') AS st_planned, count(*) FILTER (WHERE status_at = 'VALIDATED') AS st_validated,
               count(*) FILTER (WHERE status_at = 'IN_PROGRESS') AS st_in_progress, count(*) FILTER (WHERE status_at = 'COMPLETED') AS st_completed,
               count(*) FILTER (WHERE status_at = 'CONTROLLED') AS st_controlled, count(*) FILTER (WHERE status_at = 'CANCELLED') AS st_cancelled
        FROM po GROUP BY 1)
      SELECT a.k::text AS k, a.created::int, coalesce(a.created_planned, 0) AS created_planned, a.completed::int, coalesce(a.completed_planned, 0) AS completed_planned,
             coalesce(a.completed_produced, 0) AS completed_produced, a.cancelled::int, a.in_progress_at_end::int,
             a.st_planned::int, a.st_validated::int, a.st_in_progress::int, a.st_completed::int, a.st_controlled::int, a.st_cancelled::int,
             coalesce(outp.qty, 0) AS output_qty, coalesce(outp.value, 0) AS output_value,
             coalesce(loss.completion_qty, 0) AS completion_loss_qty, coalesce(loss.completion_value, 0) AS completion_loss_value,
             coalesce(loss.control_qty, 0) AS control_loss_qty, coalesce(loss.control_value, 0) AS control_loss_value
      FROM agg a LEFT JOIN outp ON outp.k = a.k LEFT JOIN loss ON loss.k = a.k`;
  }

  private shapeProduction(rows: ProductionRow[]) {
    const n = (k: keyof ProductionRow) => rows.reduce((a, r) => a + Number(r[k]), 0);
    const dsum = (k: keyof ProductionRow) => rows.reduce((a, r) => a.add(D(r[k] as Prisma.Decimal)), D(0));
    const planned = dsum('completed_planned');
    const produced = dsum('completed_produced');
    return {
      created: { count: n('created'), plannedQuantity: dsum('created_planned').toNumber() },
      completed: { count: n('completed'), plannedQuantity: planned.toNumber(), producedQuantity: produced.toNumber(), realizationRate: pct(produced, planned) },
      cancelled: n('cancelled'),
      inProgressAtEnd: n('in_progress_at_end'),
      statusAtEnd: Object.fromEntries(STATUSES.map((st) => [st, n(`st_${st.toLowerCase()}` as keyof ProductionRow)])),
      outputs: { quantity: dsum('output_qty').toNumber(), value: dsum('output_value').toDecimalPlaces(2) },
      losses: {
        completion: { quantity: dsum('completion_loss_qty').toNumber(), value: dsum('completion_loss_value').toDecimalPlaces(2) },
        control: { quantity: dsum('control_loss_qty').toNumber(), value: dsum('control_loss_value').toDecimalPlaces(2) },
      },
    };
  }

  async production(me: AuthUser, q: PeriodQuery) {
    return this.productionFor(periodScope(me, q, [DASHBOARD]));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async productionFor(s: Scope) {
    const [rows, ests] = await Promise.all([this.prisma.$queryRaw<ProductionRow[]>(this.productionSql(s, false)), this.establishments(s)]);
    return {
      period: { from: s.from, to: s.to },
      notes: [
        'Statuts à la fin de la période reconstitués par les dates du module 4 ; quantités dans l’unité de vente de chaque produit.',
        'Pertes : écart à la fin de production (prévu − produit) et non-conformités au contrôle.',
      ],
      total: this.shapeProduction(rows),
      byEstablishment: ests.map((e) => ({ establishment: e, ...this.shapeProduction(rows.filter((r) => r.k === e.id)) })),
    };
  }

  /** Détail par produit : « Consulter les rapports » + « Voir la production ». */
  async productionByProduct(me: AuthUser, q: PeriodQuery) {
    return this.productionByProductFor(periodScope(me, q, PRODUCTION_DETAIL));
  }

  /** Même indicateur sur un périmètre déjà validé (tableau de bord, exports). */
  async productionByProductFor(s: Scope) {
    const rows = await this.prisma.$queryRaw<ProductionRow[]>(this.productionSql(s, true));
    const products = await this.prisma.product.findMany({ where: { id: { in: rows.map((r) => r.k) }, companyId: s.companyId }, select: { id: true, code: true, name: true, saleUnitCode: true } });
    return {
      period: { from: s.from, to: s.to },
      products: rows
        .map((r) => ({ product: products.find((p) => p.id === r.k) ?? null, ...this.shapeProduction([r]) }))
        .sort((a, b) => b.outputs.quantity - a.outputs.quantity || (a.product?.code ?? '').localeCompare(b.product?.code ?? '')),
    };
  }
}

type ProductionRow = {
  k: string;
  created: number;
  created_planned: Prisma.Decimal;
  completed: number;
  completed_planned: Prisma.Decimal;
  completed_produced: Prisma.Decimal;
  cancelled: number;
  in_progress_at_end: number;
  st_planned: number;
  st_validated: number;
  st_in_progress: number;
  st_completed: number;
  st_controlled: number;
  st_cancelled: number;
  output_qty: Prisma.Decimal;
  output_value: Prisma.Decimal;
  completion_loss_qty: Prisma.Decimal;
  completion_loss_value: Prisma.Decimal;
  control_loss_qty: Prisma.Decimal;
  control_loss_value: Prisma.Decimal;
};

@ApiTags('Pilotage')
@ApiBearerAuth()
@Controller('pilotage')
export class OperationsKpiController {
  constructor(private readonly service: OperationsKpiService) {}

  @Get('purchases')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  purchases(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.purchases(me, q);
  }

  @Get('purchases/suppliers')
  @RequirePermissions(...PURCHASES_DETAIL)
  @AnyEstablishmentScope()
  purchasesBySupplier(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.purchasesBySupplier(me, q);
  }

  @Get('stock')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  stock(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.stock(me, q);
  }

  @Get('stock/alerts')
  @RequirePermissions(...STOCK_DETAIL)
  @AnyEstablishmentScope()
  stockAlerts(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.stockAlerts(me, q);
  }

  @Get('production')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  production(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.production(me, q);
  }

  @Get('production/products')
  @RequirePermissions(...PRODUCTION_DETAIL)
  @AnyEstablishmentScope()
  productionByProduct(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.productionByProduct(me, q);
  }
}
