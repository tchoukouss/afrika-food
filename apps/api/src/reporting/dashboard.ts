import { Controller, Get, Header, Injectable, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { OperationsKpiService } from './operations';
import { PilotageService } from './pilotage';
import { DASHBOARD, DAY, PeriodQuery, periodScope, Scope } from './positions';
import { ReceivablesKpiService } from './receivables';
import { SalesKpiService } from './sales';

const REPORTS = 'reports.view';
const TOP = 5;
const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);

/** Sous-périodes mensuelles (UTC) d'un périmètre, bornes de la période respectées. */
function monthSlices(s: Scope): Scope[] {
  const out: Scope[] = [];
  let cur = new Date(Date.UTC(s.start.getUTCFullYear(), s.start.getUTCMonth(), 1));
  while (cur < s.end) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const start = cur < s.start ? s.start : cur;
    const end = next > s.end ? s.end : next;
    out.push({ ...s, start, end, from: start.toISOString().slice(0, 10), to: new Date(end.getTime() - DAY).toISOString().slice(0, 10) });
    cur = next;
  }
  return out;
}

/**
 * Module 8 — Pilotage, étape 5 : tableau de bord consolidé, contrôles de
 * cohérence et exports. Aucun calcul propre : chaque chiffre vient des
 * services des étapes 1 à 4, appelés sur le même périmètre (période,
 * établissements). Seuls les deux contrôles de dates (achats ↔ stock,
 * production ↔ stock) lisent directement les écritures pour rendre visibles
 * les décalages, sans modifier aucun montant.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pilotage: PilotageService,
    private readonly receivables: ReceivablesKpiService,
    private readonly sales: SalesKpiService,
    private readonly operations: OperationsKpiService,
  ) {}

  /** Une section de détail n'est montrée que si toutes ses permissions sont détenues sur tout le périmètre. */
  private allowed(me: AuthUser, s: Scope, permissions: string[]) {
    return s.ids.every((id) => permissions.every((p) => me.access.can(p, id)));
  }

  private gated<T>(me: AuthUser, s: Scope, permissions: string[], load: () => Promise<T>) {
    return this.allowed(me, s, permissions) ? load() : Promise.resolve({ available: false as const, requires: permissions });
  }

  // --- Contrôles de dates ---------------------------------------------------------------------

  /**
   * Achats ↔ stock : achats datés par goods_receipts.received_at (date
   * déclarée), entrées en stock par stock_movements.created_at (date
   * d'enregistrement). Répartit les réceptions selon que l'une, l'autre ou
   * les deux dates tombent dans la période.
   */
  private async receiptDates(s: Scope) {
    const rows = await this.prisma.$queryRaw<{ bucket: string; count: number; receipt_amount: bigint; movement_value: Prisma.Decimal }[]>`
      WITH mv AS (
        SELECT origin_id, min(created_at) AS moved_at, sum(value) AS value
        FROM stock_movements
        WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND type = 'RECEIPT' AND origin_type = 'GoodsReceipt'
        GROUP BY 1),
      gr AS (
        SELECT r.id, r.total_value, (r.received_at >= ${s.start} AND r.received_at < ${s.end}) AS declared_in,
               (mv.moved_at >= ${s.start} AND mv.moved_at < ${s.end}) AS recorded_in, mv.moved_at, coalesce(mv.value, 0) AS value
        FROM goods_receipts r LEFT JOIN mv ON mv.origin_id = r.id
        WHERE r.company_id = ${s.companyId}::uuid AND r.establishment_id = ANY(${s.ids}::uuid[]))
      SELECT CASE WHEN declared_in AND moved_at IS NULL THEN 'DECLARED_IN_PERIOD_NO_STOCK_MOVEMENT'
                  WHEN declared_in AND recorded_in THEN 'BOTH_IN_PERIOD'
                  WHEN declared_in THEN 'DECLARED_IN_PERIOD_RECORDED_OUTSIDE'
                  ELSE 'RECORDED_IN_PERIOD_DECLARED_OUTSIDE' END AS bucket,
             count(*)::int AS count, sum(total_value)::bigint AS receipt_amount, sum(value) AS movement_value
      FROM gr WHERE declared_in OR recorded_in
      GROUP BY 1`;
    const pick = (b: string) => {
      const r = rows.find((x) => x.bucket === b);
      return { count: r?.count ?? 0, receiptAmount: r?.receipt_amount ?? 0n, stockMovementValue: D(r?.movement_value).toDecimalPlaces(2) };
    };
    return {
      bothInPeriod: pick('BOTH_IN_PERIOD'),
      declaredInPeriodRecordedOutside: pick('DECLARED_IN_PERIOD_RECORDED_OUTSIDE'),
      recordedInPeriodDeclaredOutside: pick('RECORDED_IN_PERIOD_DECLARED_OUTSIDE'),
      declaredInPeriodWithoutStockMovement: pick('DECLARED_IN_PERIOD_NO_STOCK_MOVEMENT'),
    };
  }

  /** Production ↔ stock : quantités produites des ordres, sorties de production et mouvements PRODUCTION. */
  private async productionStock(s: Scope) {
    const [orders] = await this.prisma.$queryRaw<{ orders: number; produced: Prisma.Decimal; outputs: Prisma.Decimal; movements: Prisma.Decimal; mismatched: number }[]>`
      WITH o AS (
        SELECT po.id, coalesce(po.produced_quantity, 0) AS produced,
               (SELECT coalesce(sum(x.quantity), 0) FROM production_outputs x WHERE x.order_id = po.id) AS outputs,
               (SELECT coalesce(sum(m.quantity), 0) FROM stock_movements m WHERE m.type = 'PRODUCTION' AND m.origin_type = 'ProductionOrder' AND m.origin_id = po.id) AS movements
        FROM production_orders po
        WHERE po.company_id = ${s.companyId}::uuid AND po.establishment_id = ANY(${s.ids}::uuid[]) AND po.completed_at >= ${s.start} AND po.completed_at < ${s.end})
      SELECT count(*)::int AS orders, coalesce(sum(produced), 0) AS produced, coalesce(sum(outputs), 0) AS outputs, coalesce(sum(movements), 0) AS movements,
             count(*) FILTER (WHERE produced <> outputs OR outputs <> movements)::int AS mismatched
      FROM o`;
    const [flows] = await this.prisma.$queryRaw<{ outputs: Prisma.Decimal; output_value: Prisma.Decimal; movements: Prisma.Decimal; movement_value: Prisma.Decimal }[]>`
      SELECT
        (SELECT coalesce(sum(x.quantity), 0) FROM production_outputs x JOIN production_orders po ON po.id = x.order_id
         WHERE po.company_id = ${s.companyId}::uuid AND po.establishment_id = ANY(${s.ids}::uuid[]) AND x.created_at >= ${s.start} AND x.created_at < ${s.end}) AS outputs,
        (SELECT coalesce(sum(x.quantity * x.unit_cost), 0) FROM production_outputs x JOIN production_orders po ON po.id = x.order_id
         WHERE po.company_id = ${s.companyId}::uuid AND po.establishment_id = ANY(${s.ids}::uuid[]) AND x.created_at >= ${s.start} AND x.created_at < ${s.end}) AS output_value,
        (SELECT coalesce(sum(quantity), 0) FROM stock_movements
         WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND type = 'PRODUCTION' AND created_at >= ${s.start} AND created_at < ${s.end}) AS movements,
        (SELECT coalesce(sum(value), 0) FROM stock_movements
         WHERE company_id = ${s.companyId}::uuid AND establishment_id = ANY(${s.ids}::uuid[]) AND type = 'PRODUCTION' AND created_at >= ${s.start} AND created_at < ${s.end}) AS movement_value`;
    const completed = { orders: orders.orders, producedQuantity: D(orders.produced).toNumber(), outputQuantity: D(orders.outputs).toNumber(), stockMovementQuantity: D(orders.movements).toNumber(), ordersWithMismatch: orders.mismatched };
    const period = {
      outputQuantity: D(flows.outputs).toNumber(),
      stockMovementQuantity: D(flows.movements).toNumber(),
      outputValue: D(flows.output_value).toDecimalPlaces(2),
      stockMovementValue: D(flows.movement_value).toDecimalPlaces(2),
    };
    return { completedOrders: completed, periodFlows: period, consistent: completed.ordersWithMismatch === 0 && D(flows.outputs).eq(D(flows.movements)) };
  }

  // --- Tableau de bord ------------------------------------------------------------------------

  async dashboard(me: AuthUser, q: PeriodQuery) {
    return this.dashboardFor(me, periodScope(me, q, [DASHBOARD]));
  }

  async dashboardFor(me: AuthUser, s: Scope) {
    const salesPerms = [REPORTS, 'sales.view'];
    const [revenue, sales, collections, reconciliation, receivables, advances, customers, purchases, stock, production, cash, receiptDates, productionStock] = await Promise.all([
      this.pilotage.revenueFor(s),
      this.sales.salesFor(s),
      this.pilotage.collectionsFor(s),
      this.pilotage.reconciliationFor(s),
      this.receivables.receivablesFor(s),
      this.receivables.advancesFor(s),
      this.receivables.customersFor(s),
      this.operations.purchasesFor(s),
      this.operations.stockFor(s),
      this.operations.productionFor(s),
      this.sales.cashFor(s),
      this.receiptDates(s),
      this.productionStock(s),
    ]);
    const [margin, categories, products, customerDetails, suppliers] = await Promise.all([
      this.gated(me, s, salesPerms, () => this.sales.marginFor(s)),
      this.gated(me, s, salesPerms, () => this.sales.categoriesFor(s)),
      this.gated(me, s, salesPerms, () => this.sales.productsFor(s, TOP)),
      this.gated(me, s, [REPORTS, 'receivables.view'], () => this.receivables.customerDetailsFor(s)),
      this.gated(me, s, [REPORTS, 'purchases.view'], () => this.operations.purchasesBySupplierFor(s)),
    ]);
    const trends = await this.trends(me, s, this.allowed(me, s, salesPerms), purchases.byMonth);
    const m = 'available' in margin ? null : margin.total;
    const rt = revenue.total;
    const rc = reconciliation.total;
    const purchasesReceipts = purchases.total.receipts.amount;
    const receiptMovements = stock.total.movements.byType.find((t) => t.type === 'RECEIPT')?.value ?? D(0);
    return {
      period: { from: s.from, to: s.to },
      currency: 'XOF',
      basis: 'TTC',
      establishments: sales.byEstablishment.map((e) => e.establishment),
      summary: {
        revenue: { ttc: sales.total.revenue, tax: sales.total.tax, excludingTax: sales.total.revenueExcludingTax, taxNote: sales.total.taxNote },
        collections: { total: collections.total.total, tickets: collections.total.tickets, customers: collections.total.customers.total, byMethod: collections.total.byMethod },
        revenueCollectionsGap: rc.gap,
        receivables: { balance: receivables.total.open.balance, overdue: receivables.total.overdue.balance, notDue: receivables.total.notDue.balance, aging: receivables.total.aging },
        advances: { total: advances.total.closing.totalAdvances, deposits: advances.total.closing.deposits.available, customerCredit: advances.total.closing.customerCredit, unappliedPayments: advances.total.closing.unappliedPayments },
        customers: { active: customers.activeCustomers, withReceivables: customers.customersWithReceivables, overdue: customers.customersOverdue },
        purchases: { net: purchases.total.netPurchases, receipts: purchases.total.receipts.amount, returns: purchases.total.returns.amount },
        stock: { value: stock.total.valuation.total, outOfStock: stock.total.items.outOfStock, belowThreshold: stock.total.items.belowThreshold, withReservedStock: stock.total.items.withReservedStock },
        production: {
          plannedQuantity: production.total.created.plannedQuantity,
          completedPlanned: production.total.completed.plannedQuantity,
          produced: production.total.completed.producedQuantity,
          realizationRate: production.total.completed.realizationRate,
          inProgressAtEnd: production.total.inProgressAtEnd,
        },
        margin: m ? { revenueWithCost: m.goods.revenue, cogs: m.goods.cogs, grossMargin: m.goods.grossMargin, rate: m.goods.rate, coverage: m.coverage, uncovered: m.uncovered.revenue } : margin,
        cash: { totalDifference: cash.total.closures.totalDifference, sessionsWithDifference: cash.total.closures.sessionsWithDifference, openAtEnd: cash.total.sessions.openAtEnd },
      },
      byEstablishment: sales.byEstablishment.map((e) => {
        const id = e.establishment.id;
        return {
          establishment: e.establishment,
          revenue: e.revenue,
          collections: collections.byEstablishment.find((x) => x.establishment.id === id)?.total ?? 0n,
          receivables: receivables.byEstablishment.find((x) => x.establishment.id === id)?.open.balance ?? 0n,
          netPurchases: purchases.byEstablishment.find((x) => x.establishment.id === id)?.netPurchases ?? 0n,
          stockValue: stock.byEstablishment.find((x) => x.establishment.id === id)?.valuation.total ?? D(0),
        };
      }),
      trends,
      top: {
        categories: 'available' in categories ? categories : categories.categories.slice(0, TOP),
        products: 'available' in products ? products : products.products,
        customersByReceivables: 'available' in customerDetails ? customerDetails : customerDetails.topByReceivables.slice(0, TOP),
        customersByInvoicedRevenue: 'available' in customerDetails ? customerDetails : customerDetails.topByInvoicedRevenue.slice(0, TOP),
        suppliers: 'available' in suppliers ? suppliers : suppliers.suppliers.slice(0, TOP),
      },
      controls: {
        revenueVsCollections: { residual: rc.explanation.residual, consistent: rc.explanation.residual === 0n, explanation: rc.explanation },
        revenueVsSales: {
          revenue: rt.revenue,
          sales: sales.total.revenue,
          categories: 'available' in categories ? null : categories.total,
          margin: m ? m.revenue : null,
          consistent: rt.revenue === sales.total.revenue && ('available' in categories || categories.total === rt.revenue) && (!m || m.revenue === rt.revenue),
        },
        receivablesAndAdvances: {
          receivables: receivables.total.open.balance,
          reconciliationReceivables: rc.receivables.closing,
          advances: advances.total.closing.totalAdvances,
          reconciliationAdvances: rc.advances.closing,
          consistent: receivables.total.open.balance === rc.receivables.closing && advances.total.closing.totalAdvances === rc.advances.closing,
        },
        purchasesVsStock: {
          convention: 'Achats datés par goods_receipts.received_at (date déclarée) ; entrées en stock par stock_movements.created_at (enregistrement).',
          purchasesReceipts,
          stockReceiptMovements: D(receiptMovements).toDecimalPlaces(2),
          ...receiptDates,
          // Les deux totaux se décomposent exactement par ces groupes : le décalage de dates est visible, rien n'est recalculé.
          consistent:
            purchasesReceipts === receiptDates.bothInPeriod.receiptAmount + receiptDates.declaredInPeriodRecordedOutside.receiptAmount + receiptDates.declaredInPeriodWithoutStockMovement.receiptAmount &&
            D(receiptMovements).toDecimalPlaces(2).eq(receiptDates.bothInPeriod.stockMovementValue.add(receiptDates.recordedInPeriodDeclaredOutside.stockMovementValue)),
        },
        productionVsStock: productionStock,
      },
    };
  }

  /** Évolutions mensuelles par les mêmes calculs, appliqués à chaque mois de la période. */
  private async trends(me: AuthUser, s: Scope, withMargin: boolean, purchases: { month: string; netPurchases: bigint }[]) {
    const months = monthSlices(s);
    const rows = await Promise.all(
      months.map(async (slice) => {
        const [rev, col, mar] = await Promise.all([
          this.pilotage.revenueFor(slice),
          this.pilotage.collectionsFor(slice),
          withMargin ? this.sales.marginFor(slice) : Promise.resolve(null),
        ]);
        const month = slice.from.slice(0, 7);
        return {
          month,
          revenue: rev.total.revenue,
          collections: col.total.total,
          netPurchases: purchases.find((p) => p.month === month)?.netPurchases ?? 0n,
          grossMargin: mar ? mar.total.goods.grossMargin : null,
          marginRate: mar ? mar.total.goods.rate : null,
        };
      }),
    );
    return { monthly: rows, marginAvailable: withMargin };
  }

  // --- Exports --------------------------------------------------------------------------------

  /** Document d'export : mêmes données et filtres que les rapports, sans fichier conservé. */
  private document(kind: string, s: Scope, data: object) {
    return { export: kind, format: 'json', generatedAt: new Date().toISOString(), filters: { from: s.from, to: s.to, establishmentIds: s.ids }, data };
  }

  async export(me: AuthUser, q: PeriodQuery, kind: 'dashboard' | 'sales' | 'purchases' | 'stock' | 'production') {
    const perms: Record<typeof kind, string[]> = {
      dashboard: [REPORTS, DASHBOARD],
      sales: [REPORTS, 'sales.view'],
      purchases: [REPORTS, 'purchases.view'],
      stock: [REPORTS, 'stock.view'],
      production: [REPORTS, 'production.view'],
    };
    const s = periodScope(me, q, perms[kind]);
    switch (kind) {
      case 'dashboard':
        return this.document(kind, s, await this.dashboardFor(me, s));
      case 'sales': {
        const [sales, categories, products, margin] = await Promise.all([this.sales.salesFor(s), this.sales.categoriesFor(s), this.sales.productsFor(s), this.sales.marginFor(s)]);
        return this.document(kind, s, { sales, categories, products, margin });
      }
      case 'purchases': {
        const [purchases, suppliers] = await Promise.all([this.operations.purchasesFor(s), this.operations.purchasesBySupplierFor(s)]);
        return this.document(kind, s, { purchases, suppliers, receiptDates: await this.receiptDates(s) });
      }
      case 'stock': {
        const [stock, alerts] = await Promise.all([this.operations.stockFor(s), this.operations.stockAlertsFor(s)]);
        return this.document(kind, s, { stock, alerts });
      }
      case 'production': {
        const [production, products] = await Promise.all([this.operations.productionFor(s), this.operations.productionByProductFor(s)]);
        return this.document(kind, s, { production, products, productionVsStock: await this.productionStock(s) });
      }
    }
  }
}

@ApiTags('Pilotage')
@ApiBearerAuth()
@Controller('pilotage')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('dashboard')
  @RequirePermissions(DASHBOARD)
  @AnyEstablishmentScope()
  dashboard(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery) {
    return this.service.dashboard(me, q);
  }

  private async send(res: Response, me: AuthUser, q: PeriodQuery, kind: 'dashboard' | 'sales' | 'purchases' | 'stock' | 'production') {
    const doc = await this.service.export(me, q, kind);
    res.setHeader('Content-Disposition', `attachment; filename="pilotage-${kind}-${q.from}_${q.to}.json"`);
    return doc;
  }

  @Get('export/dashboard')
  @RequirePermissions(REPORTS, DASHBOARD)
  @AnyEstablishmentScope()
  @Header('Cache-Control', 'no-store')
  exportDashboard(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery, @Res({ passthrough: true }) res: Response) {
    return this.send(res, me, q, 'dashboard');
  }

  @Get('export/sales')
  @RequirePermissions(REPORTS, 'sales.view')
  @AnyEstablishmentScope()
  @Header('Cache-Control', 'no-store')
  exportSales(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery, @Res({ passthrough: true }) res: Response) {
    return this.send(res, me, q, 'sales');
  }

  @Get('export/purchases')
  @RequirePermissions(REPORTS, 'purchases.view')
  @AnyEstablishmentScope()
  @Header('Cache-Control', 'no-store')
  exportPurchases(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery, @Res({ passthrough: true }) res: Response) {
    return this.send(res, me, q, 'purchases');
  }

  @Get('export/stock')
  @RequirePermissions(REPORTS, 'stock.view')
  @AnyEstablishmentScope()
  @Header('Cache-Control', 'no-store')
  exportStock(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery, @Res({ passthrough: true }) res: Response) {
    return this.send(res, me, q, 'stock');
  }

  @Get('export/production')
  @RequirePermissions(REPORTS, 'production.view')
  @AnyEstablishmentScope()
  @Header('Cache-Control', 'no-store')
  exportProduction(@CurrentUser() me: AuthUser, @Query() q: PeriodQuery, @Res({ passthrough: true }) res: Response) {
    return this.send(res, me, q, 'production');
  }
}
