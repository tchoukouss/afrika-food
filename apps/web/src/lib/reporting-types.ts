// Module 8 — Pilotage : types des réponses GET /pilotage/*.
// Montants FCFA (BigInt) et valeurs décimales (coûts, stock) reçus sous forme
// de chaînes ; comptes, quantités et taux (%) sous forme de nombres.

/** Montant entier FCFA (BigInt sérialisé). */
type Money = string;
/** Décimal Prisma sérialisé (coûts, valeurs de stock). */
type Dec = string;

/** Paramètres communs : période AAAA-MM-JJ, bornes incluses, 366 jours au plus. */
export interface Period {
  from: string;
  to: string;
}

export interface EstRef {
  id: string;
  code: string;
  name: string;
}

/** Section de détail masquée faute de permission sur tout le périmètre. */
export interface Unavailable {
  available: false;
  requires: string[];
}

/** Rapport consolidé + détail par établissement (mêmes champs). */
interface ByEstablishment<T> {
  period: Period;
  currency: 'XOF';
  total: T;
  byEstablishment: ({ establishment: EstRef } & T)[];
}

// --- Chiffre d'affaires, encaissements, rapprochement (/revenue, /collections, /reconciliation)

export interface RevenueShape {
  tickets: { gross: Money; count: number; tax: Money; onCredit: Money };
  cancellations: { amount: Money; count: number; tax: Money };
  refunds: { amount: Money; count: number; tax: null };
  ticketsNet: Money;
  invoices: { amount: Money; count: number; tax: Money };
  creditNotes: { amount: Money; count: number; tax: Money; onTicketInvoices: Money };
  revenue: Money;
  /** null si des remboursements de tickets empêchent la ventilation de TVA. */
  tax: Money | null;
  revenueExcludingTax: Money | null;
  taxNote: string | null;
}
export interface RevenueReport extends ByEstablishment<RevenueShape> {
  basis: 'TTC';
}

export interface MethodAmount {
  method: string;
  amount: Money;
}

export interface CollectionsShape {
  total: Money;
  tickets: Money;
  customers: { register: Money; offRegister: Money; total: Money };
  byMethod: MethodAmount[];
  byType: { source: 'REGISTER' | 'OFF_REGISTER'; type: string; amount: Money; count: number }[];
  internalCashMovements: { type: string; amount: Money; count: number }[];
}
export type CollectionsReport = ByEstablishment<CollectionsShape>;

export interface ReconciliationShape {
  revenue: Money;
  collections: Money;
  gap: Money;
  explanation: {
    ticketsTiming: Money;
    ticketsOnCredit: Money;
    receivablesChange: Money;
    advancesChange: Money;
    advancesDetail: { deposits: Money; unappliedPayments: Money };
    residual: Money;
  };
  receivables: { opening: Money; closing: Money };
  advances: { opening: Money; closing: Money; depositsOpening: Money; depositsClosing: Money };
}
export interface ReconciliationReport extends ByEstablishment<ReconciliationShape> {
  notes: string[];
}

// --- Créances, avances, clients (/receivables, /advances, /customers, /customers/details)

export type AgingBucket = 'NOT_DUE' | 'DAYS_1_30' | 'DAYS_31_60' | 'DAYS_61_90' | 'OVER_90';
export const AGING_BUCKETS: Record<AgingBucket, string> = {
  NOT_DUE: 'Non échu',
  DAYS_1_30: '1 à 30 j',
  DAYS_31_60: '31 à 60 j',
  DAYS_61_90: '61 à 90 j',
  OVER_90: 'Plus de 90 j',
};

export interface ReceivableTotals {
  count: number;
  billed: Money;
  paid: Money;
  credited: Money;
  balance: Money;
}
export interface ReceivablesShape {
  open: ReceivableTotals;
  notDue: ReceivableTotals & { bucket: AgingBucket };
  overdue: ReceivableTotals;
  aging: (ReceivableTotals & { bucket: AgingBucket })[];
  issuedInPeriod: ReceivableTotals;
}
export interface ReceivablesReport extends ByEstablishment<ReceivablesShape> {
  asOf: string;
  notes: string[];
}

export interface AdvancesPosition {
  deposits: { count: number; received: Money; applied: Money; refunded: Money; available: Money; availableOnOrders: Money; convertedToCustomerCredit: Money };
  unappliedPayments: Money;
  customerCredit: Money;
  totalAdvances: Money;
}
export interface AdvancesShape {
  opening: AdvancesPosition;
  closing: AdvancesPosition;
  flows: { depositsReceived: Money; depositsReceivedCount: number; depositsApplied: Money; depositsRefunded: Money; depositsCancelled: Money };
}
export interface AdvancesReport extends ByEstablishment<AdvancesShape> {
  asOf: string;
  notes: string[];
}

export interface CustomersKpi {
  period: Period;
  asOf: string;
  currency: 'XOF';
  notes: string[];
  activeCustomers: number;
  inactiveCustomers: number;
  activeByType: { type: string; count: number }[];
  customersWithReceivables: number;
  customersOverdue: number;
  receivables: Money;
  overdue: Money;
  invoicedRevenue: Money;
  concentration: { top5ReceivablesShare: number | null; top5InvoicedRevenueShare: number | null };
}

export interface CustomerRef {
  id: string;
  name: string;
  type: string;
}
export interface TopByReceivables {
  customer: CustomerRef | null;
  receivables: Money;
  overdue: Money;
}
export interface TopByInvoicedRevenue {
  customer: CustomerRef | null;
  invoiced: Money;
  credited: Money;
  revenue: Money;
}
export interface CustomerDetailsReport {
  period: Period;
  asOf: string;
  currency: 'XOF';
  topByReceivables: TopByReceivables[];
  topByInvoicedRevenue: TopByInvoicedRevenue[];
  overdueInvoices: { invoiceId: string; number: string; customer: CustomerRef | null; establishment: EstRef | null; dueDate: string; daysOverdue: number; balance: Money }[];
}

// --- Ventes, catégories, produits, marge, caisse (/sales, /sales/categories, /sales/products, /margin, /cash)

export interface SalesShape extends RevenueShape {
  ticketCount: number;
  netTicketCount: number;
  invoiceCount: number;
  averageTicket: number | null;
  averageInvoice: number | null;
}
export interface SalesReport extends ByEstablishment<SalesShape> {
  basis: 'TTC';
}

export interface LineMargin {
  revenueWithCost: Money;
  cogs: Dec;
  grossMargin: Dec;
  rate: number | null;
}
export interface CategoryRow {
  categoryId: string | null;
  name: string | null;
  kind: 'CATEGORY' | 'UNCATEGORIZED' | 'FEES';
  revenue: Money;
  share: number | null;
  tax: Money | null;
  quantity: number | null;
  lines: number;
  margin: LineMargin | null;
}
export interface CategoriesReport {
  period: Period;
  currency: 'XOF';
  basis: 'TTC';
  notes: string[];
  total: Money;
  categories: CategoryRow[];
}

export interface ProductRow {
  productId: string;
  code: string | null;
  name: string;
  revenue: Money;
  quantity: number;
  lines: number;
  margin: LineMargin;
}
export interface ProductsReport {
  period: Period;
  currency: 'XOF';
  basis: 'TTC';
  notes: string[];
  products: ProductRow[];
}

export interface MarginShape {
  goods: { revenue: Money; cogs: Dec; grossMargin: Dec; rate: number | null };
  fees: { revenue: Money; note: string };
  uncovered: { revenue: Money; reasons: { reason: 'NOT_DELIVERED' | 'REFUND_WITHOUT_LOTS'; revenue: Money; lines: number }[] };
  revenue: Money;
  coverage: number | null;
}
export interface MarginReport extends ByEstablishment<MarginShape> {
  basis: 'TTC';
  notes: string[];
}

export interface CashShape {
  sessions: { opened: number; closed: number; validated: number; openAtEnd: number; closedNotValidatedAtEnd: number };
  movements: {
    ticketSales: Money;
    ticketCancellations: Money;
    ticketRefunds: Money;
    ticketsNet: Money;
    customerPayments: Money;
    customerRefunds: Money;
    openingFloats: Money;
    manualIn: Money;
    manualOut: Money;
    byMethod: MethodAmount[];
  };
  closures: {
    sessionsWithDifference: number;
    totalDifference: Money;
    byMethod: { method: string; expected: Money; counted: Money; difference: Money }[];
  };
}
export interface CashReport extends ByEstablishment<CashShape> {
  notes: string[];
}

// --- Achats, stock, production (/purchases, /purchases/suppliers, /stock, /stock/alerts, /production, /production/products)

export interface PurchasesShape {
  receipts: { amount: Money; count: number };
  returns: { amount: Money; count: number };
  netPurchases: Money;
}
export interface PurchasesReport extends ByEstablishment<PurchasesShape> {
  notes: string[];
  byMonth: { month: string; receipts: Money; returns: Money; netPurchases: Money }[];
}

export interface SupplierPurchasesRow extends PurchasesShape {
  supplier: { id: string; code: string; name: string };
}
export interface PurchasesBySupplierReport {
  period: Period;
  currency: 'XOF';
  suppliers: SupplierPurchasesRow[];
}

export interface StockShape {
  items: {
    inStock: number;
    withReservedStock: number;
    withThreshold: number;
    withoutThreshold: number;
    status: { ok: number; alert: number; critical: number };
    outOfStock: number;
    belowThreshold: number;
  };
  quantities: { kind: 'RAW_MATERIAL' | 'PRODUCT'; unit: string; quantity: number; reserved: number; expired: number; available: number }[];
  valuation: { total: Dec; realCost: Dec; declaredCost: Dec; notValued: { lots: number }; expired: Dec };
  movements: { byType: { type: string; value: Dec; count: number }[]; inValue: Dec; outValue: Dec };
}
export interface StockReport extends ByEstablishment<StockShape> {
  asOf: 'now';
  notes: string[];
}

export interface StockAlertRow {
  establishment: EstRef | null;
  kind: 'RAW_MATERIAL' | 'PRODUCT';
  id: string | null;
  code: string;
  name: string;
  unit: string;
  quantity: number;
  reserved: number;
  expired: number;
  available: number;
  minQuantity: number;
  alertQuantity: number;
  status: 'ALERT' | 'CRITICAL';
  outOfStock: boolean;
}
export interface StockAlertsReport {
  period: Period;
  asOf: 'now';
  items: StockAlertRow[];
}

export type ProductionStatusKey = 'PLANNED' | 'VALIDATED' | 'IN_PROGRESS' | 'COMPLETED' | 'CONTROLLED' | 'CANCELLED';
export interface ProductionShape {
  created: { count: number; plannedQuantity: number };
  completed: { count: number; plannedQuantity: number; producedQuantity: number; realizationRate: number | null };
  cancelled: number;
  inProgressAtEnd: number;
  statusAtEnd: Record<ProductionStatusKey, number>;
  outputs: { quantity: number; value: Dec };
  losses: { completion: { quantity: number; value: Dec }; control: { quantity: number; value: Dec } };
}
/** Pas de champ « currency » sur ce rapport. */
export interface ProductionReport {
  period: Period;
  notes: string[];
  total: ProductionShape;
  byEstablishment: ({ establishment: EstRef } & ProductionShape)[];
}
export interface ProductionByProductReport {
  period: Period;
  products: ({ product: { id: string; code: string; name: string; saleUnitCode: string } | null } & ProductionShape)[];
}

// --- Tableau de bord (/dashboard) -------------------------------------------------------------

export interface ReceiptDateBucket {
  count: number;
  receiptAmount: Money;
  stockMovementValue: Dec;
}

export interface Dashboard {
  period: Period;
  currency: 'XOF';
  basis: 'TTC';
  establishments: EstRef[];
  summary: {
    revenue: { ttc: Money; tax: Money | null; excludingTax: Money | null; taxNote: string | null };
    collections: { total: Money; tickets: Money; customers: Money; byMethod: MethodAmount[] };
    revenueCollectionsGap: Money;
    receivables: { balance: Money; overdue: Money; notDue: Money; aging: (ReceivableTotals & { bucket: AgingBucket })[] };
    advances: { total: Money; deposits: Money; customerCredit: Money; unappliedPayments: Money };
    customers: { active: number; withReceivables: number; overdue: number };
    purchases: { net: Money; receipts: Money; returns: Money };
    stock: { value: Dec; outOfStock: number; belowThreshold: number; withReservedStock: number };
    production: { plannedQuantity: number; completedPlanned: number; produced: number; realizationRate: number | null; inProgressAtEnd: number };
    margin: { revenueWithCost: Money; cogs: Dec; grossMargin: Dec; rate: number | null; coverage: number | null; uncovered: Money } | Unavailable;
    cash: { totalDifference: Money; sessionsWithDifference: number; openAtEnd: number };
  };
  byEstablishment: { establishment: EstRef; revenue: Money; collections: Money; receivables: Money; netPurchases: Money; stockValue: Dec }[];
  trends: {
    monthly: { month: string; revenue: Money; collections: Money; netPurchases: Money; grossMargin: Dec | null; marginRate: number | null }[];
    marginAvailable: boolean;
  };
  top: {
    categories: CategoryRow[] | Unavailable;
    products: ProductRow[] | Unavailable;
    customersByReceivables: TopByReceivables[] | Unavailable;
    customersByInvoicedRevenue: TopByInvoicedRevenue[] | Unavailable;
    suppliers: SupplierPurchasesRow[] | Unavailable;
  };
  controls: {
    revenueVsCollections: { residual: Money; consistent: boolean; explanation: ReconciliationShape['explanation'] };
    revenueVsSales: { revenue: Money; sales: Money; categories: Money | null; margin: Money | null; consistent: boolean };
    receivablesAndAdvances: { receivables: Money; reconciliationReceivables: Money; advances: Money; reconciliationAdvances: Money; consistent: boolean };
    purchasesVsStock: {
      convention: string;
      purchasesReceipts: Money;
      stockReceiptMovements: Dec;
      bothInPeriod: ReceiptDateBucket;
      declaredInPeriodRecordedOutside: ReceiptDateBucket;
      recordedInPeriodDeclaredOutside: ReceiptDateBucket;
      declaredInPeriodWithoutStockMovement: ReceiptDateBucket;
      consistent: boolean;
    };
    productionVsStock: {
      completedOrders: { orders: number; producedQuantity: number; outputQuantity: number; stockMovementQuantity: number; ordersWithMismatch: number };
      periodFlows: { outputQuantity: number; stockMovementQuantity: number; outputValue: Dec; stockMovementValue: Dec };
      consistent: boolean;
    };
  };
}

/** Section du tableau de bord masquée faute de permission. */
export const isUnavailable = (v: unknown): v is Unavailable => typeof v === 'object' && v !== null && 'available' in v && (v as Unavailable).available === false;

// --- Exports (/export/*) ----------------------------------------------------------------------

export type ExportKind = 'dashboard' | 'sales' | 'purchases' | 'stock' | 'production';

export interface ExportDocument<T> {
  export: ExportKind;
  format: 'json';
  generatedAt: string;
  filters: { from: string; to: string; establishmentIds: string[] };
  data: T;
}
