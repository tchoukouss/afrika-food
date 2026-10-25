// Module 7 — Livraisons : types des réponses GET /deliveries et GET /deliveries/:id.
// Montants FCFA (BigInt) et décimaux (quantités) reçus sous forme de chaînes.

import type { CustomerOrderLine, CustomerOrderStatus, DeliveryStatus } from './order-types';

export { DELIVERY_STATUS } from './order-types';
export type { DeliveryStatus } from './order-types';

/** Livreur : voit et fait avancer ses propres livraisons. */
export const DELIVERY_DRIVER = 'deliveries.manage';
/** Responsable : voit, prépare, modifie et annule les livraisons de ses établissements. */
export const DELIVERY_MANAGER = 'customer_orders.manage';
/** Livraisons en cours (ni livrées, ni échouées, ni annulées). */
export const DELIVERY_ACTIVE: DeliveryStatus[] = ['TO_PREPARE', 'READY', 'OUT'];

interface DeliveryBase {
  id: string;
  companyId: string;
  establishmentId: string;
  orderId: string;
  /** Numéro BL. */
  number: string;
  clientRequestId: string | null;
  status: DeliveryStatus;
  driverId: string | null;
  address: string;
  phone: string | null;
  scheduledAt: string | null;
  fee: string;
  feeLabel: string | null;
  notes: string | null;
  failedReason: string | null;
  cancelReason: string | null;
  deliveredAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  /** Nom du livreur affecté. */
  driver: string | null;
}

/**
 * Ligne de GET /deliveries (300 au plus, triées par date prévue) : livraisons des établissements où
 * l'on gère les commandes clients, et livraisons qui nous sont affectées comme livreur.
 */
export interface DeliveryRow extends DeliveryBase {
  order: { id: string; number: string; status: CustomerOrderStatus; customer: { id: string; name: string; phone: string | null } | null };
}

export interface DeliveryHistory {
  id: string;
  deliveryId: string;
  fromStatus: DeliveryStatus | null;
  toStatus: DeliveryStatus;
  reason: string | null;
  userId: string;
  createdAt: string;
  user: string | null;
}

/** GET /deliveries/:id. */
export interface DeliveryDetail extends DeliveryBase {
  order: {
    id: string;
    number: string;
    status: CustomerOrderStatus;
    total: string;
    customer: { id: string; name: string; phone: string | null } | null;
    lines: Pick<CustomerOrderLine, 'id' | 'position' | 'kind' | 'productCode' | 'label' | 'quantity' | 'lineTotal' | 'note' | 'deliveredQuantity'>[];
  };
  history: DeliveryHistory[];
  /** Sorties de stock faites à la livraison. */
  issues: { id: string; lineId: string; quantity: string; createdAt: string }[];
  createdBy: string | null;
  /** Responsable de l'établissement (préparer, modifier, annuler). */
  canManage: boolean;
}

/** Limite fixée par le serveur pour GET /deliveries. */
export const DELIVERY_LIST_LIMIT = 300;
