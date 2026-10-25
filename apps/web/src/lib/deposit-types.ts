// Module 7 — Acomptes clients : types des réponses GET /deposits, GET /deposits/:id et
// GET /deposits/:id/receipt. Montants FCFA (BigInt) reçus sous forme de chaînes.

import type { CustomerOrderStatus } from './order-types';

type Tone = 'neutral' | 'blue' | 'orange' | 'green' | 'red';

export type DepositStatus = 'RECEIVED' | 'CUSTOMER_CREDIT' | 'REFUNDED' | 'CANCELLED';
export const DEPOSIT_STATUS: Record<DepositStatus, { label: string; tone: Tone }> = {
  RECEIVED: { label: 'Reçu', tone: 'green' },
  CUSTOMER_CREDIT: { label: 'Crédit client', tone: 'blue' },
  REFUNDED: { label: 'Remboursé', tone: 'neutral' },
  CANCELLED: { label: 'Annulé', tone: 'red' },
};

/** Lecture des acomptes côté serveur : un seul de ces droits suffit (mêmes droits que les paiements). */
export { PAYMENT_READ as DEPOSIT_READ } from './invoice-types';

interface DepositBase {
  id: string;
  companyId: string;
  establishmentId: string;
  customerId: string;
  orderId: string | null;
  /** Numéro ACP. */
  number: string;
  clientRequestId: string | null;
  status: DepositStatus;
  amount: string;
  refundedAmount: string;
  notes: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  creditedAt: string | null;
  creditReason: string | null;
  cancelledAt: string | null;
  cancelledById: string | null;
  cancelReason: string | null;
}

/**
 * Ligne de GET /deposits (300 plus récents au plus). Le serveur n'y renvoie ni la part imputée
 * ni le disponible (pas de répartitions dans la liste) : ils ne figurent que dans la fiche.
 */
export interface DepositRow extends DepositBase {
  customer: { id: string; name: string } | null;
  order: { id: string; number: string; status: CustomerOrderStatus } | null;
}

/**
 * Répartition liée à l'acompte : « DEPOSIT » = argent d'un paiement qui finance l'acompte ;
 * « INVOICE » = part de l'acompte imputée sur une facture (seul l'identifiant de la facture est renvoyé).
 */
export interface DepositAllocation {
  id: string;
  paymentId: string;
  target: 'DEPOSIT' | 'INVOICE';
  depositId: string | null;
  invoiceId: string | null;
  amount: string;
  createdById: string;
  createdAt: string;
  releasedAt: string | null;
  releasedById: string | null;
  releaseReason: string | null;
  payment: { id: string; number: string; method: string; reference: string | null; createdAt: string };
}

/** Remboursement d'un acompte (par la caisse, ou hors caisse sans session). */
export interface DepositRefund {
  id: string;
  companyId: string;
  establishmentId: string;
  customerId: string;
  depositId: string | null;
  creditNoteId: string | null;
  clientRequestId: string | null;
  method: string;
  amount: string;
  reference: string | null;
  provider: string;
  sessionId: string | null;
  cashMovementId: string | null;
  reason: string;
  createdById: string;
  createdAt: string;
  createdBy: string | null;
}

/** GET /deposits/:id. */
export interface DepositDetail extends DepositBase {
  customer: { id: string; name: string; phone: string | null } | null;
  order: { id: string; number: string; status: CustomerOrderStatus; total: string } | null;
  allocations: DepositAllocation[];
  refunds: DepositRefund[];
  /** Part imputée sur des factures (répartitions « facture » actives). */
  applied: string;
  /** Disponible : montant − remboursé − imputé, 0 si remboursé ou annulé (calcul du serveur). */
  available: string;
  createdBy: string | null;
  cancelledBy: string | null;
  canManage: boolean;
}

/** GET /deposits/:id/receipt : données du reçu d'acompte (ACP), qui ne vaut pas facture. */
export interface DepositReceipt {
  title: string;
  number: string;
  date: string;
  company: string;
  establishment: { code: string; name: string; address: string | null; phone: string | null };
  customer: { id: string; name: string; phone: string | null } | null;
  order: { number: string; total: string } | null;
  amount: string;
  refundedAmount: string;
  status: DepositStatus;
  /** Paiements qui financent encore l'acompte ; method est déjà le libellé (« Espèces »…). */
  payments: { number: string; method: string; reference: string | null; amount: string }[];
  applied: string;
  receivedBy: string | null;
  mention: string;
}

/** Limite fixée par le serveur pour GET /deposits. */
export const DEPOSIT_LIST_LIMIT = 300;
