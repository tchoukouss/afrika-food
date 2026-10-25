// Module 7 — Commandes clients (à ne pas confondre avec les commandes du restaurant, module 6) :
// types des réponses GET /customer-orders et GET /customer-orders/:id.
// Montants FCFA (BigInt) et décimaux (quantités, taux) reçus sous forme de chaînes.

type Tone = 'neutral' | 'blue' | 'orange' | 'green' | 'red';

export type CustomerOrderStatus = 'DRAFT' | 'CONFIRMED' | 'IN_PREPARATION' | 'READY' | 'DELIVERED' | 'COMPLETED' | 'CANCELLED';
export const CUSTOMER_ORDER_STATUS: Record<CustomerOrderStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Brouillon', tone: 'neutral' },
  CONFIRMED: { label: 'Confirmée', tone: 'blue' },
  IN_PREPARATION: { label: 'En préparation', tone: 'orange' },
  READY: { label: 'Prête', tone: 'orange' },
  DELIVERED: { label: 'Livrée', tone: 'green' },
  COMPLETED: { label: 'Terminée', tone: 'green' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
};

export type CustomerDocumentKind = 'STANDARD' | 'EVENT';
export const CUSTOMER_DOCUMENT_KINDS: Record<CustomerDocumentKind, string> = {
  STANDARD: 'Standard',
  EVENT: 'Événement',
};

export type EventType = 'WEDDING' | 'BAPTISM' | 'BIRTHDAY' | 'FUNERAL' | 'SEMINAR' | 'CORPORATE_MEAL' | 'BUFFET' | 'COCKTAIL' | 'OTHER';
export const EVENT_TYPES: Record<EventType, string> = {
  WEDDING: 'Mariage',
  BAPTISM: 'Baptême',
  BIRTHDAY: 'Anniversaire',
  FUNERAL: 'Funérailles',
  SEMINAR: 'Séminaire',
  CORPORATE_MEAL: 'Repas d’entreprise',
  BUFFET: 'Buffet',
  COCKTAIL: 'Cocktail',
  OTHER: 'Autre',
};

export type DeliveryStatus = 'TO_PREPARE' | 'READY' | 'OUT' | 'DELIVERED' | 'FAILED' | 'CANCELLED';
export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: Tone }> = {
  TO_PREPARE: { label: 'À préparer', tone: 'neutral' },
  READY: { label: 'Prête', tone: 'orange' },
  OUT: { label: 'En livraison', tone: 'blue' },
  DELIVERED: { label: 'Livrée', tone: 'green' },
  FAILED: { label: 'Échouée', tone: 'red' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
};

/** Lecture des commandes clients côté serveur : un seul de ces droits suffit. */
export const CUSTOMER_ORDER_READ = ['customer_orders.manage', 'customers.view'];

/** Détails d'une commande événementielle. */
export interface CustomerOrderEvent {
  orderId: string;
  eventType: EventType;
  eventDate: string;
  venue: string | null;
  guests: number | null;
  contactName: string | null;
  contactPhone: string | null;
  notes: string | null;
}

interface CustomerOrderBase {
  id: string;
  establishmentId: string;
  customerId: string;
  number: string;
  kind: CustomerDocumentKind;
  status: CustomerOrderStatus;
  /** Devis d'origine (commande créée par acceptation d'un devis). */
  quoteId: string | null;
  dueAt: string | null;
  notes: string | null;
  total: string;
  taxTotal: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  event: CustomerOrderEvent | null;
}

/** Ligne de GET /customer-orders (300 plus récentes au plus, sans pagination serveur). */
export interface CustomerOrderRow extends CustomerOrderBase {
  customer: { id: string; name: string; phone: string | null } | null;
}

export interface CustomerOrderLine {
  id: string;
  position: number;
  kind: 'PRODUCT' | 'FEE';
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
  /** Produit fabriqué à la demande (ordre de production du module 4) au lieu d'être pris en stock. */
  madeToOrder: boolean;
  productionOrderId: string | null;
  deliveredQuantity: string;
  /** Réservations de stock actives (lot, quantité). */
  reservations: { lotId: string; quantity: string }[];
}

export interface CustomerOrderDelivery {
  id: string;
  number: string;
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
  createdAt: string;
}

export interface CustomerOrderDeposit {
  id: string;
  number: string;
  status: string;
  amount: string;
  refundedAmount: string;
  createdAt: string;
}

export interface CustomerOrderHistory {
  id: string;
  fromStatus: CustomerOrderStatus | null;
  toStatus: CustomerOrderStatus;
  reason: string | null;
  createdAt: string;
  user: string | null;
}

/** GET /customer-orders/:id. */
export interface CustomerOrderDetail extends CustomerOrderBase {
  customer: { id: string; name: string; phone: string | null; type: string } | null;
  quote: { id: string; number: string } | null;
  lines: CustomerOrderLine[];
  deliveries: CustomerOrderDelivery[];
  deposits: CustomerOrderDeposit[];
  history: CustomerOrderHistory[];
  createdBy: string | null;
  cancelledBy: string | null;
  canManage: boolean;
}

/** Limite fixée par le serveur pour GET /customer-orders. */
export const CUSTOMER_ORDER_LIST_LIMIT = 300;
