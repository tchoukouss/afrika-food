// Module 7 — Clients & crédit : types des réponses API et libellés de l'interface.
// Montants FCFA (BigInt côté API) reçus sous forme de chaînes.

type Tone = 'neutral' | 'blue' | 'orange' | 'green' | 'red';

export type CustomerType = 'INDIVIDUAL' | 'BUSINESS' | 'WHOLESALER' | 'EVENT';
export const CUSTOMER_TYPES: Record<CustomerType, string> = {
  INDIVIDUAL: 'Particulier',
  BUSINESS: 'Entreprise',
  WHOLESALER: 'Grossiste',
  EVENT: 'Événementiel',
};

/** Ligne de GET /customers. */
export interface Customer {
  id: string;
  type: CustomerType;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxId: string | null;
  /** Limite de crédit ; null = aucun crédit sans autorisation. */
  creditLimit: string | null;
  paymentTermDays: number;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /customers/:id (aussi renvoyé par POST et PATCH). */
export interface CustomerDetail extends Customer {
  createdBy: string | null;
  credit: { limit: string | null; outstanding: string; available: string };
}

/** GET /customers/:id/credit?establishmentId=… : situation de crédit au niveau du groupe. */
export interface CreditSummary {
  customerId: string;
  isActive: boolean;
  creditLimit: string | null;
  paymentTermDays: number;
  outstanding: string;
  available: string;
  amount: string;
  withinLimit: boolean;
  /** Pré-autorisations actives dans l'établissement demandé. */
  activeOverrides: number;
}

export type OverrideStatus = 'ACTIVE' | 'USED' | 'CANCELLED' | 'EXPIRED';
export const OVERRIDE_STATUS: Record<OverrideStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'green' },
  USED: { label: 'Utilisée', tone: 'blue' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
  EXPIRED: { label: 'Expirée', tone: 'neutral' },
};

/** Pré-autorisation de dépassement (1 heure, un établissement, usage unique). */
export interface CreditOverride {
  id: string;
  establishmentId: string;
  customerId: string;
  maxAmount: string;
  reason: string;
  expiresAt: string;
  usedAt: string | null;
  usedAmount: string | null;
  usedReference: string | null;
  cancelledAt: string | null;
  createdAt: string;
  status: OverrideStatus;
  /** Noms présents dans la liste (GET /customers/:id/credit-overrides), absents des réponses de création et d'annulation. */
  approvedBy?: string | null;
  usedBy?: string | null;
  cancelledBy?: string | null;
}

/** Corps d'une erreur 409 de crédit (ApiError.body). */
export interface CreditLimitExceeded {
  code: 'CREDIT_LIMIT_EXCEEDED';
  message: string;
  outstanding: string;
  limit: string;
  available: string;
}

export type CreditErrorCode = 'CREDIT_LIMIT_EXCEEDED' | 'CREDIT_OVERRIDE_INVALID' | 'CUSTOMER_INACTIVE';
