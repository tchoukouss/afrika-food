// Types du module 3 — Achats & stock. Quantités et coûts : texte (Decimal),
// montants FCFA : texte (BigInt). Toujours convertir avec Number().

export interface ItemRef {
  id: string;
  code: string;
  name: string;
  unit: string;
}

export interface StockLocation {
  id: string;
  establishmentId: string;
  code: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  openInventory: string | null;
}

export type StockStatus = 'OK' | 'ALERT' | 'CRITICAL' | 'NONE';

export interface StockRow {
  establishmentId: string;
  rawMaterialId: string | null;
  productId: string | null;
  item: ItemRef | null;
  quantity: string;
  reserved: string;
  expired: string;
  available: string;
  value: string;
  averageCost: string | null;
  lastPurchaseCost: string | null;
  lots: number;
  nextExpiry: string | null;
  packaging: { name: string; quantity: string; count: string } | null;
  minQuantity: string | null;
  alertQuantity: string | null;
  status: StockStatus;
}

export interface LotRow {
  balanceId: string;
  establishmentId: string;
  location: { id: string; code: string; name: string };
  lotId: string;
  lotNumber: string;
  origin: 'RECEIPT' | 'INVENTORY' | 'ADJUSTMENT';
  brand: string | null;
  supplier: { id: string; name: string } | null;
  supplierLotRef: string | null;
  productionDate: string | null;
  expiryDate: string | null;
  isExpired: boolean;
  unitCost: string;
  quantity: string;
  reserved: string;
  value: string;
  receivedAt: string;
}

export const MOVEMENT_TYPES: Record<string, string> = {
  RECEIPT: 'Réception',
  SUPPLIER_RETURN: 'Retour fournisseur',
  TRANSFER_OUT: 'Transfert sortant',
  TRANSFER_IN: 'Transfert entrant',
  LOCATION_OUT: 'Déplacement (sortie)',
  LOCATION_IN: 'Déplacement (entrée)',
  INVENTORY_GAIN: 'Inventaire (+)',
  INVENTORY_LOSS: 'Inventaire (−)',
  ADJUSTMENT_IN: 'Correction (+)',
  ADJUSTMENT_OUT: 'Correction (−)',
  LOSS: 'Perte',
  CONSUMPTION: 'Consommation (production)',
  PRODUCTION: 'Entrée de production',
};

export interface Movement {
  id: string;
  type: string;
  quantity: string;
  unitCost: string;
  value: string;
  balanceAfter: string;
  originType: string;
  reason: string | null;
  createdAt: string;
  item: ItemRef | null;
  lotNumber?: string;
  locationName?: string;
  userName: string | null;
}

export const LOSS_CAUSES: Record<string, string> = {
  EXPIRED: 'Péremption',
  BURNT: 'Brûlure',
  BROKEN: 'Casse',
  PRODUCTION_ERROR: 'Erreur de production',
  CUSTOMER_RETURN: 'Retour client',
  QUALITY: 'Problème de qualité',
  TRANSIT: 'Perte en transit',
  OTHER: 'Autre',
};

export const PO_STATUS: Record<string, { label: string; tone: 'neutral' | 'blue' | 'orange' | 'green' | 'red' }> = {
  DRAFT: { label: 'Brouillon', tone: 'neutral' },
  VALIDATED: { label: 'Validée', tone: 'blue' },
  PARTIALLY_RECEIVED: { label: 'Partiellement reçue', tone: 'orange' },
  RECEIVED: { label: 'Reçue', tone: 'green' },
  CLOSED: { label: 'Clôturée (reliquat)', tone: 'neutral' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
};

export const REQUEST_STATUS: Record<string, { label: string; tone: 'neutral' | 'blue' | 'orange' | 'green' | 'red' }> = {
  OPEN: { label: 'À traiter', tone: 'orange' },
  ORDERED: { label: 'Commandée', tone: 'green' },
  REJECTED: { label: 'Refusée', tone: 'red' },
  CANCELLED: { label: 'Annulée', tone: 'neutral' },
};

export const INVOICE_STATUS: Record<string, { label: string; tone: 'neutral' | 'blue' | 'orange' | 'green' | 'red' }> = {
  OPEN: { label: 'À payer', tone: 'orange' },
  PARTIALLY_PAID: { label: 'Partiellement payée', tone: 'blue' },
  PAID: { label: 'Payée', tone: 'green' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
};

export const TRANSFER_STATUS: Record<string, { label: string; tone: 'neutral' | 'blue' | 'orange' | 'green' | 'red' }> = {
  REQUESTED: { label: 'Demandé', tone: 'orange' },
  VALIDATED: { label: 'Validé', tone: 'blue' },
  PREPARED: { label: 'Préparé', tone: 'blue' },
  SHIPPED: { label: 'Expédié', tone: 'orange' },
  RECEIVED: { label: 'Réceptionné', tone: 'green' },
  CLOSED: { label: 'Clôturé', tone: 'neutral' },
  CANCELLED: { label: 'Annulé', tone: 'red' },
};

export const PAYMENT_METHODS: Record<string, string> = {
  CASH: 'Espèces',
  ORANGE_MONEY: 'Orange Money',
  MTN_MONEY: 'MTN Mobile Money',
  MOOV_MONEY: 'Moov Money',
  WAVE: 'Wave',
  CARD: 'Carte bancaire',
  BANK_TRANSFER: 'Virement',
  CHEQUE: 'Chèque',
  OTHER: 'Autre',
};

export const UNIT_LABEL: Record<string, string> = { KG: 'kg', G: 'g', L: 'L', CL: 'cL', ML: 'mL', U: 'u' };
export const unitLabel = (code?: string | null) => (code ? UNIT_LABEL[code] ?? code : '');
