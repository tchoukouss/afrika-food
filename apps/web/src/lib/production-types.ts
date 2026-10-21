// Types du module 4 — Recettes & production. Quantités, coûts : texte (Decimal).

import type { ItemRef } from './stock-types';

export type RecipeVersionStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export interface RecipeItemRec {
  id: string;
  rawMaterialId: string | null;
  productId: string | null;
  quantity: string;
  unitCode: string;
  lossPercent: string;
  note: string | null;
  sortOrder: number;
  item: ItemRef | null;
}

export interface RecipeVersionRec {
  id: string;
  version: number;
  status: RecipeVersionStatus;
  yieldQuantity: string;
  shelfLifeDays: number | null;
  instructions: string | null;
  notes: string | null;
  createdAt: string;
  activatedAt: string | null;
  archivedAt: string | null;
  createdBy: string | null;
  activatedBy: string | null;
  items: RecipeItemRec[];
}

export interface RecipeRec {
  id: string;
  productId: string;
  activeVersionId: string | null;
  product: { id: string; code: string; name: string; saleUnitCode: string; taxRate?: string } | null;
  versions: RecipeVersionRec[];
}

export interface RecipeListRow {
  id: string;
  product: { id: string; code: string; name: string; saleUnitCode: string; isActive: boolean } | null;
  activeVersion: { id: string; version: number; yieldQuantity: string; items: number } | null;
  hasDraft: boolean;
  versions: number;
}

export const COST_SOURCES: Record<string, string> = {
  STOCK: 'lots en stock',
  STOCK_AND_PRICE: 'stock + dernier prix',
  LAST_PURCHASE: 'dernier prix d’achat',
  LAST_PRODUCTION: 'dernière production',
  SUB_RECIPE: 'coût de la sous-recette',
  SUPPLIER_OFFER: 'offre fournisseur',
  MISSING: 'aucun prix connu',
};

export interface CostLine {
  itemId: string;
  code: string;
  name: string;
  quantity: string;
  unitCode: string;
  lossPercent: string;
  stockQuantity: string;
  stockUnit: string;
  unitCost: string | null;
  cost: string | null;
  source: string;
}

export interface VersionCost {
  versionId: string;
  yieldQuantity: string;
  lines: CostLine[];
  totalCost: string;
  unitCost: string | null;
  complete: boolean;
  priceTtc: string | null;
  priceHt: string | null;
  margin: string | null;
  marginRate: string | null;
}

export interface CostingRow {
  productId: string;
  code: string;
  name: string;
  saleUnitCode: string;
  taxRate: string;
  recipeId: string | null;
  hasActiveRecipe: boolean;
  costComplete: boolean;
  priceTtc: string | null;
  priceHt: string | null;
  unitCost: string | null;
  margin: string | null;
  marginRate: string | null;
}

export type ProductionStatus = 'PLANNED' | 'VALIDATED' | 'IN_PROGRESS' | 'COMPLETED' | 'CONTROLLED' | 'CANCELLED';

export const PRODUCTION_STATUS: Record<ProductionStatus, { label: string; tone: 'neutral' | 'blue' | 'orange' | 'green' | 'red' }> = {
  PLANNED: { label: 'Planifiée', tone: 'neutral' },
  VALIDATED: { label: 'Validée (matières réservées)', tone: 'blue' },
  IN_PROGRESS: { label: 'En production', tone: 'orange' },
  COMPLETED: { label: 'Terminée', tone: 'green' },
  CONTROLLED: { label: 'Contrôlée', tone: 'green' },
  CANCELLED: { label: 'Annulée', tone: 'red' },
};

export interface ProductionItemRec {
  id: string;
  rawMaterialId: string | null;
  productId: string | null;
  recipeQuantity: string;
  recipeUnitCode: string;
  lossPercent: string;
  theoreticalQuantity: string;
  consumedQuantity: string;
  reserved: string;
  item: ItemRef | null;
}

export interface ProductionOrderRec {
  id: string;
  number: string;
  status: ProductionStatus;
  establishmentId: string;
  productId: string;
  product: { id: string; code: string; name: string; saleUnitCode: string } | null;
  plannedQuantity: string;
  producedQuantity: string | null;
  plannedDate: string | null;
  notes: string | null;
  theoreticalCost: string | null;
  realCost: string | null;
  unitCost: string | null;
  overReason: string | null;
  controlNote: string | null;
  cancelReason: string | null;
  createdAt: string;
  completedById?: string | null;
  version?: { id: string; version: number; recipeId: string; yieldQuantity: string; shelfLifeDays: number | null } | null;
  sourceLocation?: { id: string; name: string } | null;
  destLocation?: { id: string; name: string } | null;
  items?: ProductionItemRec[];
  consumptions?: { id: string; itemId: string; lotId: string; lotNumber?: string; kind: 'THEORETICAL' | 'EXTRA' | 'RETURN'; quantity: string; unitCost: string; value: string; reason: string | null }[];
  outputs?: { id: string; lotId: string; lotNumber?: string; quantity: string; unitCost: string; expiryDate: string | null }[];
  losses?: { id: string; stage: 'COMPLETION' | 'CONTROL'; quantity: string; cause: string; reason: string; value: string; createdBy: string | null }[];
  people?: Record<string, string | null>;
}

export interface TraceLot {
  lotId: string;
  lotNumber: string;
  origin: string;
  item: ItemRef | null;
  brand: string | null;
  supplierLotRef: string | null;
  expiryDate: string | null;
  unitCost: string;
  supplier: { id: string; name: string } | null;
  receipt: { id: string; number: string; receivedAt: string } | null;
}

export interface TraceUp extends TraceLot {
  production: { id: string; number: string; completedAt: string | null } | null;
  inputs: { quantity: string; lot: TraceUp }[];
}

export interface TraceDown {
  production: { id: string; number: string; status: string; completedAt: string | null };
  quantityUsed: string;
  outputs: (TraceLot & { usedBy: TraceDown[] })[];
}

export interface TraceResult {
  lot: TraceLot;
  upstream: TraceUp;
  downstream: TraceDown[];
}
