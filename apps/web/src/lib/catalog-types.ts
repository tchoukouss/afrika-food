// Types du module 2 — Catalogue.
// Les montants (FCFA) arrivent en texte (BigInt côté serveur), les quantités
// et taux aussi (Decimal) : toujours convertir avec Number() pour calculer.

export type UnitCode = 'KG' | 'G' | 'L' | 'CL' | 'ML' | 'U';

export interface Unit {
  code: UnitCode;
  name: string;
  symbol: string;
  dimension: 'MASS' | 'VOLUME' | 'COUNT';
  factorToBase: string;
  isBase: boolean;
}

export interface Category {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  sortOrder?: number;
  isActive: boolean;
  _count?: { rawMaterials?: number; products?: number };
}

export type RawMaterialKind = 'INGREDIENT' | 'PACKAGING' | 'CONSUMABLE';
export const RAW_MATERIAL_KINDS: Record<RawMaterialKind, string> = {
  INGREDIENT: 'Ingrédient',
  PACKAGING: 'Emballage',
  CONSUMABLE: 'Consommable',
};

export interface Packaging {
  id: string;
  name: string;
  quantity: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface SupplierOffer {
  id: string;
  supplierId: string;
  rawMaterialId: string | null;
  productId: string | null;
  brand: string | null;
  supplierRef: string | null;
  purchaseUnitLabel: string;
  quantityPerPurchaseUnit: string;
  unitPrice: string | null;
  priceUpdatedAt: string | null;
  pricePerBaseUnit: number | null;
  isPreferred: boolean;
  isActive: boolean;
  supplier?: { id: string; code: string; name: string };
  rawMaterial?: { id: string; code: string; name: string; baseUnitCode: UnitCode } | null;
  product?: { id: string; code: string; name: string; saleUnitCode: UnitCode } | null;
}

export interface RawMaterial {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  kind: RawMaterialKind;
  baseUnitCode: 'KG' | 'L' | 'U';
  baseUnit: Unit;
  isPerishable: boolean;
  trackLots: boolean;
  description: string | null;
  isActive: boolean;
  packagings: Packaging[];
  supplierProducts: SupplierOffer[];
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  phone2: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  taxId: string | null;
  paymentTermsDays: number;
  paymentTerms: string | null;
  creditLimit: string | null;
  notes: string | null;
  isActive: boolean;
  products?: SupplierOffer[];
  _count?: { products: number };
}

export type ProductType = 'MANUFACTURED' | 'RESOLD' | 'MENU';
export const PRODUCT_TYPES: Record<ProductType, string> = {
  MANUFACTURED: 'Fabriqué',
  RESOLD: 'Revendu',
  MENU: 'Menu / formule',
};

export interface Product {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  category: { id: string; name: string; color: string | null } | null;
  type: ProductType;
  saleUnitCode: UnitCode;
  saleUnit: Unit;
  barcode: string | null;
  description: string | null;
  imageUrl: string | null;
  taxRate: string;
  isActive: boolean;
  basePrice: string | null;
  localPrice?: string | null;
  price?: string | null;
  isAvailable?: boolean;
  _count: { menuComponents: number; supplierProducts: number };
}

export interface ProductDetail extends Product {
  basePriceSince: string | null;
  menuComponents: { id: string; quantity: string; component: { id: string; code: string; name: string; type: ProductType; isActive: boolean } }[];
  usedInMenus: { menu: { id: string; code: string; name: string } }[];
  supplierProducts: SupplierOffer[];
  establishments: {
    id: string;
    code: string;
    name: string;
    localPrice: string | null;
    localPriceSince: string | null;
    price: string | null;
    isAvailable: boolean;
  }[];
}

export interface PriceHistoryRow {
  id: string;
  price: string;
  validFrom: string;
  validTo: string | null;
  reason: string | null;
  establishment: { id: string; code: string; name: string } | null;
  createdBy: { id: string; fullName: string } | null;
}

/** Affichage d'une quantité Decimal sans zéros inutiles : "25.0000" → "25". */
export function qty(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4 }).format(Number(value));
}
