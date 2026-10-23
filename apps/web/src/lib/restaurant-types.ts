// Module 6 — Restaurant & commandes : types et libellés de l'interface.

type Tone = 'neutral' | 'blue' | 'orange' | 'green' | 'red';

export type TableStatus = 'FREE' | 'RESERVED' | 'WAITING_ORDER' | 'OCCUPIED' | 'WAITING_BILL' | 'CLEANING' | 'OUT_OF_SERVICE';

/** Statuts de table (décision R8) et couleur de la carte sur le plan de salle. */
export const TABLE_STATUS: Record<TableStatus, { label: string; tone: Tone; card: string }> = {
  FREE: { label: 'Libre', tone: 'green', card: 'border-green-300 bg-green-50' },
  RESERVED: { label: 'Réservée', tone: 'blue', card: 'border-sky-300 bg-sky-50' },
  WAITING_ORDER: { label: 'Attente de commande', tone: 'orange', card: 'border-amber-300 bg-amber-50' },
  OCCUPIED: { label: 'Occupée', tone: 'orange', card: 'border-brand-400 bg-brand-50' },
  WAITING_BILL: { label: 'Attente d’addition', tone: 'red', card: 'border-red-300 bg-red-50' },
  CLEANING: { label: 'Nettoyage', tone: 'neutral', card: 'border-stone-300 bg-stone-100' },
  OUT_OF_SERVICE: { label: 'Hors service', tone: 'neutral', card: 'border-stone-300 bg-stone-200 opacity-70' },
};

export const ORDER_MODES: Record<string, string> = {
  TABLE: 'Sur place',
  COUNTER: 'Comptoir',
  TAKEAWAY: 'À emporter',
  PHONE: 'Téléphone',
  ONLINE: 'En ligne',
  DELIVERY: 'Livraison',
};

export const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  OPEN: { label: 'Ouverte', tone: 'green' },
  PAID: { label: 'Soldée', tone: 'neutral' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
  MERGED: { label: 'Regroupée', tone: 'neutral' },
};

/** Statuts d'un article (décision R13). */
export const ITEM_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'À envoyer', tone: 'blue' },
  REMOVED: { label: 'Retiré', tone: 'neutral' },
  NEW: { label: 'Nouvelle', tone: 'orange' },
  IN_PREPARATION: { label: 'En préparation', tone: 'orange' },
  READY: { label: 'Prête', tone: 'green' },
  SERVED: { label: 'Servie', tone: 'neutral' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
};

export const BILL_STATUS: Record<string, { label: string; tone: Tone }> = {
  OPEN: { label: 'À encaisser', tone: 'orange' },
  PAID: { label: 'Payée', tone: 'green' },
  CANCELLED: { label: 'Annulée', tone: 'neutral' },
};

export const RESERVATION_STATUS: Record<string, { label: string; tone: Tone }> = {
  CONFIRMED: { label: 'Confirmée', tone: 'blue' },
  SEATED: { label: 'Arrivée', tone: 'green' },
  NO_SHOW: { label: 'Non venue', tone: 'red' },
  CANCELLED: { label: 'Annulée', tone: 'neutral' },
};

export const LOSS_CAUSES_RESTAURANT: Record<string, string> = {
  QUALITY: 'Problème de qualité',
  PRODUCTION_ERROR: 'Erreur de préparation',
  CUSTOMER_RETURN: 'Retour client',
  BURNT: 'Brûlé',
  BROKEN: 'Casse',
  OTHER: 'Autre',
};

export interface Area {
  id: string;
  establishmentId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  tables: FloorTable[];
}

export interface FloorTable {
  id: string;
  areaId: string;
  code: string;
  capacity: number;
  state: 'AVAILABLE' | 'CLEANING' | 'OUT_OF_SERVICE';
  isActive: boolean;
  status: TableStatus;
  reservation: { id: string; name: string; covers: number; reservedAt: string } | null;
  order: { id: string; number: string; covers: number | null; createdAt: string; waiter: string | null; total: string } | null;
}

export interface Station {
  id: string;
  name: string;
  kind: 'KITCHEN' | 'BAR';
  stockLocationId: string;
  printerType: 'NETWORK' | 'BROWSER' | 'NONE';
  printerHost: string | null;
  printerPort: number;
  paperWidth: number;
  isActive: boolean;
}

export interface MenuEntry {
  id: string;
  productId: string;
  preparation: 'TO_ORDER' | 'FROM_STOCK';
  stationId: string | null;
  isSupplement: boolean;
  sortOrder: number;
  isActive: boolean;
  product: { id: string; code: string; name: string; type: string; isActive: boolean; category: { id: string; name: string; color: string | null; sortOrder: number } | null; taxRate: string };
  price: string | null;
  isAvailable: boolean;
  station: Station | null;
  options: { id: string; label: string; isActive: boolean; sortOrder: number }[];
}

export interface OrderItem {
  id: string;
  position: number;
  productId: string;
  productName: string;
  isMenu: boolean;
  unitPrice: string;
  quantity: string;
  cancelledQuantity: string;
  amount: string;
  note: string | null;
  options: string[];
  parentItemId: string | null;
  preparation: 'TO_ORDER' | 'FROM_STOCK';
  status: string;
  kitchenTicketId: string | null;
  billId: string | null;
  paid: boolean;
  costTotal: string;
  station: { id: string; name: string; kind: string } | null;
  createdBy: string | null;
  sentBy: string | null;
  sentAt: string | null;
  statusChangedAt: string;
}

export interface OrderBill {
  id: string;
  number: string;
  status: 'OPEN' | 'PAID' | 'CANCELLED';
  total: string;
  printCount: number;
  saleId: string | null;
  sale: { id: string; number: string; status: string } | null;
  createdAt: string;
  cancelReason: string | null;
  items: { itemId: string; quantity: string; amount: string }[];
}

export interface OrderDetail {
  id: string;
  establishmentId: string;
  number: string;
  mode: string;
  status: string;
  tableId: string | null;
  table: { id: string; code: string; capacity: number } | null;
  covers: number | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  expectedAt: string | null;
  urgent: boolean;
  note: string | null;
  waiter: string | null;
  createdAt: string;
  cancelReason: string | null;
  items: OrderItem[];
  kitchenTickets: { id: string; number: string; createdAt: string; station: { name: string } | null }[];
  bills: OrderBill[];
  cancellations: { id: string; itemId: string; quantity: string; outcome: string; lossCause: string | null; reason: string; createdBy: string | null; createdAt: string }[];
  totals: { ordered: string; paid: string; toBill: string };
  rights: { edit: boolean; order: boolean; discount: boolean; pay: boolean };
}

export interface OrderRow {
  id: string;
  number: string;
  mode: string;
  status: string;
  table: { id: string; code: string } | null;
  customerName: string | null;
  covers: number | null;
  waiter: string | null;
  total: string;
  counts: { draft: number; inKitchen: number; ready: number };
  openBills: number;
  createdAt: string;
}

export interface KitchenTicket {
  id: string;
  number: string;
  createdAt: string;
  urgent: boolean;
  station: { id: string; name: string; kind: string } | null;
  order: { id: string; number: string; mode: string; table: string | null; customerName: string | null; covers: number | null; note: string | null };
  items: { id: string; productName: string; quantity: string; note: string | null; options: string[]; parentItemId: string | null; status: string; statusChangedAt: string }[];
}

export interface Reservation {
  id: string;
  reservedAt: string;
  covers: number;
  name: string;
  phone: string | null;
  note: string | null;
  status: string;
  table: { id: string; code: string } | null;
  tableId: string | null;
  createdBy: string | null;
}

/** Identifiant d'envoi (anti double envoi), y compris hors HTTPS où crypto.randomUUID n'existe pas. */
export function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
