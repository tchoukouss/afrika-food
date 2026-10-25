// Module 7 — Devis clients : types des réponses GET /quotes et GET /quotes/:id.
// Montants FCFA (BigInt) et décimaux (quantités, taux) reçus sous forme de chaînes.

import type { CustomerDocumentKind, CustomerOrderStatus, EventType } from './order-types';

type Tone = 'neutral' | 'blue' | 'orange' | 'green' | 'red';

/** Statuts enregistrés. « Expiré » n'en est pas un : le serveur le calcule (champ expired). */
export type QuoteStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REFUSED';
export const QUOTE_STATUS: Record<QuoteStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Brouillon', tone: 'neutral' },
  SENT: { label: 'Envoyé', tone: 'blue' },
  ACCEPTED: { label: 'Accepté', tone: 'green' },
  REFUSED: { label: 'Refusé', tone: 'red' },
};

/** Lecture des devis côté serveur : mêmes droits que les commandes clients. */
export { CUSTOMER_ORDER_READ as QUOTE_READ } from './order-types';
/** Écriture (création, modification, envoi, acceptation, refus) : « Gérer les commandes clients ». */
export const QUOTE_WRITE = 'customer_orders.manage';

/** Détails d'événement d'un devis (JSON enregistré tel que saisi : champs facultatifs absents ou null). */
export interface QuoteEvent {
  eventType: EventType;
  eventDate: string;
  venue?: string | null;
  guests?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
}

interface QuoteBase {
  id: string;
  companyId: string;
  establishmentId: string;
  customerId: string;
  number: string;
  clientRequestId: string | null;
  kind: CustomerDocumentKind;
  status: QuoteStatus;
  /** Date seule (minuit UTC). */
  validUntil: string;
  desiredAt: string | null;
  event: QuoteEvent | null;
  notes: string | null;
  total: string;
  taxTotal: string;
  createdById: string;
  sentAt: string | null;
  sentById: string | null;
  acceptedAt: string | null;
  acceptedById: string | null;
  refusedAt: string | null;
  refusedById: string | null;
  refuseReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Envoyé et date de validité dépassée (calculé par le serveur). */
  expired: boolean;
}

/** Ligne de GET /quotes (300 plus récents au plus, sans pagination serveur). */
export interface QuoteRow extends QuoteBase {
  customer: { id: string; name: string; phone: string | null } | null;
  order: { id: string; number: string } | null;
}

export interface QuoteLine {
  id: string;
  quoteId: string;
  position: number;
  kind: 'PRODUCT' | 'FEE';
  productId: string | null;
  productCode: string | null;
  label: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
  taxAmount: string;
  note: string | null;
  madeToOrder: boolean;
}

export interface QuoteHistory {
  id: string;
  quoteId: string;
  fromStatus: QuoteStatus | null;
  toStatus: QuoteStatus;
  reason: string | null;
  userId: string;
  createdAt: string;
  user: string | null;
}

/** GET /quotes/:id. */
export interface QuoteDetail extends QuoteBase {
  customer: { id: string; name: string; phone: string | null; type: string } | null;
  lines: QuoteLine[];
  history: QuoteHistory[];
  order: { id: string; number: string; status: CustomerOrderStatus } | null;
  createdBy: string | null;
  canManage: boolean;
}

/** Limite fixée par le serveur pour GET /quotes. */
export const QUOTE_LIST_LIMIT = 300;
