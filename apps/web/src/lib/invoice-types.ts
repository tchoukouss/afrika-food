// Module 7 — Facturation clients : types des réponses GET /invoices et GET /invoices/:id.
// Montants FCFA (BigInt côté API) et décimaux (quantités, taux) reçus sous forme de chaînes.

type Tone = 'neutral' | 'blue' | 'orange' | 'green' | 'red';

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'DISPUTED' | 'CANCELLED';
export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Brouillon', tone: 'neutral' },
  ISSUED: { label: 'Émise', tone: 'blue' },
  DISPUTED: { label: 'En litige', tone: 'orange' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
};

/** Règlement d'une facture ouverte (émise ou en litige) ; null pour un brouillon ou une facture annulée. */
export type InvoicePaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
export const INVOICE_PAYMENT_STATUS: Record<InvoicePaymentStatus, { label: string; tone: Tone }> = {
  UNPAID: { label: 'Non payée', tone: 'red' },
  PARTIALLY_PAID: { label: 'Payée en partie', tone: 'orange' },
  PAID: { label: 'Payée', tone: 'green' },
};

export type InvoiceSource = 'ORDER' | 'SALE' | 'MANUAL';
export const INVOICE_SOURCES: Record<InvoiceSource, string> = {
  ORDER: 'Commande client',
  SALE: 'Ticket de caisse (vente à crédit)',
  MANUAL: 'Facture manuelle (prestations)',
};

export type DocumentLineKind = 'PRODUCT' | 'FEE';

/** Soldes calculés par le serveur (même formule que l'encours client). */
export interface InvoiceBalance {
  /** Total des avoirs. */
  credited: string;
  /** Réglé en caisse + répartitions actives − remboursements d'avoirs. */
  paid: string;
  /** Reste dû = total − avoirs − payé (négatif : trop-perçu). */
  balance: string;
  paymentStatus: InvoicePaymentStatus | null;
  overdue: boolean;
}

interface InvoiceBase {
  id: string;
  establishmentId: string;
  customerId: string;
  /** Numéro FAC attribué à l'émission ; null pour un brouillon. */
  number: string | null;
  source: InvoiceSource;
  orderId: string | null;
  saleId: string | null;
  status: InvoiceStatus;
  total: string;
  taxTotal: string;
  /** Part déjà réglée au ticket (facture d'une vente à crédit). */
  posPaidAmount: string;
  paymentTermDays: number | null;
  issuedAt: string | null;
  dueDate: string | null;
  notes: string | null;
  disputedAt: string | null;
  disputeReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Ligne de GET /invoices (300 dernières factures au plus, sans pagination serveur). */
export interface InvoiceRow extends InvoiceBase, InvoiceBalance {
  customer: { id: string; name: string } | null;
}

export interface InvoiceLine {
  id: string;
  position: number;
  kind: DocumentLineKind;
  productId: string | null;
  productCode: string | null;
  categoryName: string | null;
  label: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
  taxAmount: string;
  note: string | null;
  /** Montant déjà corrigé par des avoirs. */
  credited: string;
}

/** Répartition d'un paiement ou d'un acompte sur la facture (libérée si releasedAt). */
export interface InvoiceAllocation {
  id: string;
  paymentId: string;
  depositId: string | null;
  amount: string;
  createdAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  payment: { id: string; number: string; method: string; reference: string | null };
  deposit: { id: string; number: string } | null;
  methodLabel: string;
}

export interface CreditNoteLineSummary {
  id: string;
  invoiceLineId: string;
  label: string;
  quantity: string | null;
  amount: string;
  taxRate: string;
  taxAmount: string;
}

export interface CreditNoteRefund {
  id: string;
  method: string;
  amount: string;
  reference: string | null;
  reason: string;
  createdAt: string;
}

/** Avoir tel que renvoyé dans la fiche facture. */
export interface CreditNoteSummary {
  id: string;
  number: string;
  total: string;
  taxTotal: string;
  reason: string;
  /** Part de l'avoir qui réduit le reste dû. */
  reducedDue: string;
  /** Part conservée en crédit client. */
  customerCredit: string;
  /** Part remboursée au client. */
  refundAmount: string;
  createdAt: string;
  lines: CreditNoteLineSummary[];
  refunds: CreditNoteRefund[];
}

/** GET /invoices/:id. */
export interface InvoiceDetail extends InvoiceBase, InvoiceBalance {
  customer: { id: string; name: string; phone: string | null; address: string | null; taxId: string | null } | null;
  order: { id: string; number: string; status: string } | null;
  sale: { id: string; number: string } | null;
  lines: InvoiceLine[];
  creditNotes: CreditNoteSummary[];
  allocations: InvoiceAllocation[];
  /** Montant encore corrigeable par avoir (0 si la facture n'est plus ouverte). */
  correctable: string;
  createdBy: string | null;
  issuedBy: string | null;
  cancelledBy: string | null;
  canManage: boolean;
}

/** Accès à la facturation clients côté interface (le serveur reste seul juge). */
export const INVOICE_READ = ['invoices.view', 'invoices.manage', 'receivables.view', 'payments.manage'];

// --- Paiements clients (GET /customer-payments, GET /customer-payments/:id) -------------------

export type CustomerPaymentStatus = 'RECORDED' | 'CANCELLED';
export const CUSTOMER_PAYMENT_STATUS: Record<CustomerPaymentStatus, { label: string; tone: Tone }> = {
  RECORDED: { label: 'Enregistré', tone: 'green' },
  CANCELLED: { label: 'Annulé', tone: 'red' },
};

/** Lecture des paiements clients côté serveur : un seul de ces droits suffit. */
export const PAYMENT_READ = ['payments.manage', 'receivables.view', 'invoices.view'];

interface CustomerPaymentBase {
  id: string;
  establishmentId: string;
  customerId: string;
  /** Numéro PAY. */
  number: string;
  status: CustomerPaymentStatus;
  method: string;
  amount: string;
  reference: string | null;
  provider: string;
  /** Session de caisse (null = virement ou chèque, hors caisse). Le numéro de session n'est pas renvoyé. */
  sessionId: string | null;
  cashMovementId: string | null;
  reversalMovementId: string | null;
  notes: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** Somme des répartitions actives (factures, acomptes). */
  allocated: string;
  /** Reste à répartir (0 pour un paiement annulé). */
  unallocated: string;
}

/** Ligne de GET /customer-payments (300 plus récents au plus, filtres serveur : établissement, client). */
export interface CustomerPaymentRow extends CustomerPaymentBase {
  customer: { id: string; name: string } | null;
}

export interface PaymentAllocationDetail {
  id: string;
  target: 'DEPOSIT' | 'INVOICE';
  amount: string;
  createdAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  invoice: { id: string; number: string | null; status: InvoiceStatus } | null;
  deposit: { id: string; number: string; status: string } | null;
}

export interface CustomerPaymentDetail extends CustomerPaymentBase {
  customer: { id: string; name: string; phone: string | null } | null;
  methodLabel: string;
  allocations: PaymentAllocationDetail[];
  createdBy: string | null;
  cancelledBy: string | null;
  canManage: boolean;
}

/** Limite fixée par le serveur pour GET /invoices et GET /customer-payments. */
export const INVOICE_LIST_LIMIT = 300;
