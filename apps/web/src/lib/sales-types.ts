// Module 5 — Caisse & ventes : types et libellés de l'interface.

type Tone = 'neutral' | 'blue' | 'orange' | 'green' | 'red';

export type PrinterType = 'NETWORK' | 'BROWSER' | 'NONE';
export const PRINTER_TYPES: Record<PrinterType, string> = {
  NETWORK: 'Imprimante thermique réseau',
  BROWSER: 'Impression par le navigateur',
  NONE: 'Pas d’impression automatique',
};

export interface CashRegister {
  id: string;
  establishmentId: string;
  establishment: { id: string; code: string; name: string } | null;
  code: string;
  name: string;
  stockLocationId: string;
  stockLocation: { id: string; name: string } | null;
  printerType: PrinterType;
  printerHost: string | null;
  printerPort: number;
  paperWidth: number;
  autoPrint: boolean;
  isActive: boolean;
  openSession: { id: string; number: string; cashier: string | null; openedAt: string } | null;
  canManage: boolean;
}

export const SESSION_STATUS: Record<string, { label: string; tone: Tone }> = {
  OPEN: { label: 'Ouverte', tone: 'green' },
  CLOSED: { label: 'Clôturée — à valider', tone: 'orange' },
  VALIDATED: { label: 'Validée', tone: 'neutral' },
};

export const CASH_MOVEMENT_TYPES: Record<string, string> = {
  OPENING_FLOAT: 'Fond de caisse',
  SALE: 'Vente',
  SALE_CANCEL: 'Annulation',
  REFUND: 'Remboursement',
  MANUAL_IN: 'Entrée manuelle',
  MANUAL_OUT: 'Sortie manuelle',
  CUSTOMER_PAYMENT: 'Paiement client',
  CUSTOMER_REFUND: 'Remboursement client',
};

export interface CashMovement {
  id: string;
  type: string;
  method: string;
  amount: string;
  reason: string | null;
  saleId: string | null;
  saleNumber: string | null;
  user: string | null;
  createdAt: string;
}

export interface CashSessionRow {
  id: string;
  establishmentId: string;
  number: string;
  status: string;
  register: { id: string; code: string; name: string };
  cashierId: string;
  cashier: string | null;
  openingFloat: string;
  openedAt: string;
  closedAt: string | null;
  validatedBy: string | null;
  validatedAt: string | null;
  salesCount: number;
  salesTotal: string;
}

export interface CashSessionDetail extends Omit<CashSessionRow, 'register' | 'salesCount' | 'salesTotal'> {
  register: { id: string; code: string; name: string; stockLocationId: string; printerType: PrinterType };
  closingNote: string | null;
  validationNote: string | null;
  movements: CashMovement[];
  closures: { method: string; expected: string; counted: string; difference: string }[];
  expected: { method: string; amount: string }[];
  canValidate: boolean;
  canMoveCash: boolean;
}

export interface ZReport {
  session: CashSessionDetail;
  establishment: { code: string; name: string };
  salesByStatus: { status: string; count: number; total: string }[];
  totals: { gross: string; discounts: string; total: string; tax: string; cost: string };
  movements: { method: string; type: string; count: number; amount: string }[];
  returns: { kind: string; count: number; total: string }[];
}

export const SALE_STATUS: Record<string, { label: string; tone: Tone }> = {
  COMPLETED: { label: 'Encaissée', tone: 'green' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
  PARTIALLY_REFUNDED: { label: 'Remboursée en partie', tone: 'orange' },
  REFUNDED: { label: 'Remboursée', tone: 'neutral' },
};

export const PRINT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'En attente', tone: 'blue' },
  PRINTED: { label: 'Imprimé', tone: 'green' },
  BROWSER: { label: 'Navigateur', tone: 'neutral' },
  FAILED: { label: 'Échec', tone: 'red' },
};

/** Moyens dont la référence de transaction est obligatoire (décision 10). */
export const REFERENCE_REQUIRED = new Set(['ORANGE_MONEY', 'MTN_MONEY', 'MOOV_MONEY', 'WAVE', 'BANK_TRANSFER', 'CHEQUE']);

export interface PrintJob {
  id: string;
  kind: 'TICKET' | 'DUPLICATE';
  status: 'PENDING' | 'PRINTED' | 'BROWSER' | 'FAILED';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  requestedBy?: string | null;
}

export interface TicketText {
  width: number;
  duplicate: boolean;
  lines: string[];
}

export interface SaleItemLot {
  id: string;
  lotId: string;
  productId: string;
  quantity: string;
  returnedQuantity: string;
  unitCost: string;
  lot: { id: string; lotNumber: string; expiryDate: string | null; origin: string } | null;
  product: { id: string; code: string; name: string; saleUnitCode: string } | null;
}

export interface SaleItem {
  id: string;
  productId: string;
  productCode: string;
  productName: string;
  isMenu: boolean;
  quantity: string;
  unitPrice: string;
  grossAmount: string;
  lineDiscount: string;
  discountReason: string | null;
  ticketDiscount: string;
  lineTotal: string;
  taxRate: string;
  taxAmount: string;
  costTotal: string;
  refundedQuantity: string;
  lots: SaleItemLot[];
}

export interface SaleRow {
  id: string;
  number: string;
  status: string;
  establishmentId: string;
  total: string;
  refundedTotal: string;
  createdAt: string;
  cashier: string | null;
  register: { id: string; code: string; name: string } | null;
  payments: { method: string; amount: string }[];
}

export interface SaleDetail extends SaleRow {
  establishment: { id: string; code: string; name: string } | null;
  session: { id: string; number: string; status: string } | null;
  grossTotal: string;
  lineDiscountTotal: string;
  ticketDiscountAmount: string;
  ticketDiscountReason: string | null;
  taxTotal: string;
  paidTotal: string;
  changeGiven: string;
  costTotal: string;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  items: SaleItem[];
  payments: { id: string; method: string; amount: string; reference: string | null }[];
  returns: { id: string; number: string; kind: 'CANCEL' | 'REFUND'; method: string | null; total: string; reason: string; createdBy: string | null; createdAt: string }[];
  printJobs: PrintJob[];
  rights: { cancel: boolean; refund: boolean; reprint: boolean };
}

export interface SaleResult {
  sale: SaleDetail;
  print: PrintJob | null;
  ticket: TicketText;
}

export interface LotSales {
  lot: { id: string; lotNumber: string };
  lots: { id: string; lotNumber: string; product: string | null; via: string | null; depth: number; expiryDate: string | null }[];
  sales: {
    saleId: string;
    number: string;
    createdAt: string;
    status: string;
    establishment: { code: string; name: string } | null;
    lotNumber: string | null;
    product: string | null;
    soldAs: string;
    quantity: string;
    returnedQuantity: string;
  }[];
}
