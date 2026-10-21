import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Db, PrismaService } from '../prisma/prisma.service';
import { D, isExpired, ItemInfo, ItemRef, itemWhere, loadItem } from '../stock/common';
import { loadUnits, priceExclTax, requiredQuantity, UnitMap } from './common';

export type CostSource = 'STOCK' | 'STOCK_AND_PRICE' | 'LAST_PURCHASE' | 'LAST_PRODUCTION' | 'SUB_RECIPE' | 'SUPPLIER_OFFER' | 'MISSING';

export interface CostLine {
  itemId: string;
  rawMaterialId: string | null;
  productId: string | null;
  code: string;
  name: string;
  quantity: Prisma.Decimal;
  unitCode: string;
  lossPercent: Prisma.Decimal;
  stockQuantity: Prisma.Decimal;
  stockUnit: string;
  unitCost: Prisma.Decimal | null;
  cost: Prisma.Decimal | null;
  source: CostSource;
}

export interface VersionCost {
  versionId: string;
  yieldQuantity: Prisma.Decimal;
  lines: CostLine[];
  totalCost: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  /** Faux si au moins un ingrédient n'a aucun prix connu. */
  complete: boolean;
}

const MAX_DEPTH = 10;

/**
 * Coût de revient (décision A) : pour chaque ingrédient, valeur des lots qui
 * seraient consommés en FEFO dans l'établissement (lots non périmés, hors
 * stock réservé) ; pour le reste, dernier prix d'achat (dernier lot reçu),
 * à défaut dernier coût de production ou coût de la sous-recette (décision B),
 * à défaut prix de l'offre fournisseur préférée.
 */
@Injectable()
export class CostingService {
  constructor(private readonly prisma: PrismaService) {}

  private async fallbackPrice(
    db: Db,
    companyId: string,
    item: ItemRef,
    info: ItemInfo,
    units: UnitMap,
    establishmentId: string | null,
    depth: number,
  ): Promise<{ unitCost: Prisma.Decimal; source: CostSource } | null> {
    const lastReceipt = await db.stockLot.findFirst({ where: { companyId, ...itemWhere(item), origin: 'RECEIPT' }, orderBy: { createdAt: 'desc' } });
    if (lastReceipt) return { unitCost: D(lastReceipt.unitCost), source: 'LAST_PURCHASE' };
    if (info.productType === 'MANUFACTURED') {
      const lastProduction = await db.stockLot.findFirst({ where: { companyId, productId: item.productId!, origin: 'PRODUCTION' }, orderBy: { createdAt: 'desc' } });
      if (lastProduction) return { unitCost: D(lastProduction.unitCost), source: 'LAST_PRODUCTION' };
      const recipe = await db.recipe.findUnique({ where: { productId: item.productId! } });
      if (recipe?.activeVersionId && depth < MAX_DEPTH) {
        const sub = await this.costVersion(db, companyId, recipe.activeVersionId, establishmentId, depth + 1, units);
        if (sub.unitCost && sub.complete) return { unitCost: sub.unitCost, source: 'SUB_RECIPE' };
      }
    }
    const offer = await db.supplierProduct.findFirst({
      where: { ...itemWhere(item), isActive: true, unitPrice: { not: null } },
      orderBy: [{ isPreferred: 'desc' }, { priceUpdatedAt: 'desc' }],
    });
    if (offer?.unitPrice != null) return { unitCost: D(offer.unitPrice.toString()).div(offer.quantityPerPurchaseUnit), source: 'SUPPLIER_OFFER' };
    return null;
  }

  /** Coût estimé d'une quantité (unité de stock) d'un article. */
  async estimate(db: Db, companyId: string, item: ItemRef, quantity: Prisma.Decimal, establishmentId: string | null, depth = 0, units?: UnitMap) {
    const info = await loadItem(db, companyId, item);
    units ??= await loadUnits(db);
    let remaining = quantity;
    let cost = D(0);
    let fromStock = false;
    if (establishmentId) {
      const balances = await db.stockBalance.findMany({
        where: { establishmentId, ...itemWhere(item), quantity: { gt: 0 } },
        include: { lot: true },
      });
      const usable = balances
        .filter((b) => !isExpired(b.lot.expiryDate))
        .sort((a, b) => {
          const ea = a.lot.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const eb = b.lot.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return ea !== eb ? ea - eb : a.lot.createdAt.getTime() - b.lot.createdAt.getTime();
        });
      for (const b of usable) {
        if (remaining.lte(0)) break;
        const free = D(b.quantity).sub(b.reservedQuantity);
        if (free.lte(0)) continue;
        const take = Prisma.Decimal.min(free, remaining);
        cost = cost.add(take.mul(b.lot.unitCost));
        remaining = remaining.sub(take);
        fromStock = true;
      }
    }
    let source: CostSource = 'STOCK';
    if (remaining.gt(0)) {
      const price = await this.fallbackPrice(db, companyId, item, info, units, establishmentId, depth);
      if (!price) return { info, unitCost: null, cost: null, source: 'MISSING' as CostSource };
      cost = cost.add(remaining.mul(price.unitCost));
      source = fromStock ? 'STOCK_AND_PRICE' : price.source;
    }
    return { info, unitCost: quantity.gt(0) ? cost.div(quantity) : D(0), cost: cost.toDecimalPlaces(2), source };
  }

  /** Coût détaillé d'une version de recette pour son rendement. */
  async costVersion(db: Db, companyId: string, versionId: string, establishmentId: string | null, depth = 0, units?: UnitMap): Promise<VersionCost> {
    units ??= await loadUnits(db);
    const version = await db.recipeVersion.findFirst({
      where: { id: versionId, recipe: { companyId } },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!version) throw new NotFoundException('Version de recette introuvable');
    const lines: CostLine[] = [];
    let total = D(0);
    let complete = true;
    for (const it of version.items) {
      const item = { rawMaterialId: it.rawMaterialId, productId: it.productId };
      const info = await loadItem(db, companyId, item);
      const stockQuantity = requiredQuantity(units, it, D(1), info);
      const est = await this.estimate(db, companyId, item, stockQuantity, establishmentId, depth, units);
      if (est.cost === null) complete = false;
      else total = total.add(est.cost);
      lines.push({
        itemId: it.id,
        ...item,
        code: info.code,
        name: info.name,
        quantity: D(it.quantity),
        unitCode: it.unitCode,
        lossPercent: D(it.lossPercent),
        stockQuantity,
        stockUnit: info.unit,
        unitCost: est.unitCost ? est.unitCost.toDecimalPlaces(4) : null,
        cost: est.cost,
        source: est.source,
      });
    }
    const yieldQuantity = D(version.yieldQuantity);
    return {
      versionId,
      yieldQuantity,
      lines,
      totalCost: total.toDecimalPlaces(2),
      unitCost: complete ? total.div(yieldQuantity).toDecimalPlaces(4) : null,
      complete,
    };
  }

  /**
   * Coûts et marges de tous les produits fabriqués : prix TTC applicable dans
   * l'établissement (exception locale sinon prix de base), prix HT, coût de
   * revient unitaire, marge en FCFA et en % du prix HT (décision I).
   */
  async productCosting(companyId: string, establishmentId: string | null) {
    const units = await loadUnits(this.prisma);
    const products = await this.prisma.product.findMany({
      where: { companyId, type: 'MANUFACTURED', isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, saleUnitCode: true, taxRate: true },
    });
    const recipes = await this.prisma.recipe.findMany({ where: { productId: { in: products.map((p) => p.id) } } });
    const prices = await this.prisma.productPrice.findMany({
      where: { productId: { in: products.map((p) => p.id) }, validTo: null, OR: [{ establishmentId: null }, ...(establishmentId ? [{ establishmentId }] : [])] },
    });
    const rows = [];
    for (const p of products) {
      const recipe = recipes.find((r) => r.productId === p.id);
      const local = prices.find((x) => x.productId === p.id && x.establishmentId === establishmentId && establishmentId);
      const base = prices.find((x) => x.productId === p.id && x.establishmentId === null);
      const priceTtc = local?.price ?? base?.price ?? null;
      const priceHt = priceExclTax(priceTtc, p.taxRate);
      const cost = recipe?.activeVersionId ? await this.costVersion(this.prisma, companyId, recipe.activeVersionId, establishmentId, 0, units) : null;
      const unitCost = cost?.unitCost ?? null;
      const margin = priceHt !== null && unitCost !== null ? priceHt.sub(unitCost).toDecimalPlaces(2) : null;
      rows.push({
        productId: p.id,
        code: p.code,
        name: p.name,
        saleUnitCode: p.saleUnitCode,
        taxRate: p.taxRate,
        recipeId: recipe?.id ?? null,
        hasActiveRecipe: !!recipe?.activeVersionId,
        costComplete: cost?.complete ?? false,
        priceTtc,
        priceHt,
        unitCost,
        margin,
        marginRate: margin !== null && priceHt !== null && priceHt.gt(0) ? margin.div(priceHt).mul(100).toDecimalPlaces(1) : null,
      });
    }
    return rows;
  }
}
