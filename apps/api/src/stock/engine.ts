import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { LotOrigin, Prisma, StockLocation, StockLot, StockMovementType } from '@prisma/client';
import { Tx } from '../prisma/prisma.service';
import { D, isExpired, ItemRef, itemWhere, nextNumber } from './common';

export interface MovementContext {
  companyId: string;
  establishmentId: string;
  locationId: string;
  type: StockMovementType;
  originType: string;
  originId: string;
  reason?: string | null;
  userId: string;
}

export interface IssuedLot {
  lotId: string;
  lotNumber: string;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  value: Prisma.Decimal;
}

/**
 * Moteur de stock : seul point d'écriture des soldes et du journal des
 * mouvements. Toutes les méthodes s'exécutent dans la transaction de
 * l'opération métier (réception, perte, transfert…) : soit tout est écrit,
 * soit rien.
 *
 * Concurrence : les soldes sont verrouillés (SELECT … FOR UPDATE) avant
 * lecture ; l'emplacement est verrouillé en partage pour vérifier qu'aucun
 * inventaire ne l'a gelé. Une contrainte CHECK en base interdit en dernier
 * recours tout solde négatif.
 */
@Injectable()
export class StockEngine {
  /** Crée si besoin le « Magasin principal » de l'établissement et le retourne. */
  async ensureDefaultLocation(tx: Tx, companyId: string, establishmentId: string): Promise<StockLocation> {
    await tx.$executeRaw`
      INSERT INTO stock_locations (id, company_id, establishment_id, code, name, is_default, is_active, created_at, updated_at)
      VALUES (gen_random_uuid(), ${companyId}::uuid, ${establishmentId}::uuid, 'PRINCIPAL', 'Magasin principal', true, true, now(), now())
      ON CONFLICT DO NOTHING`;
    const loc = await tx.stockLocation.findFirst({ where: { establishmentId, isDefault: true } });
    if (!loc) throw new ConflictException('Emplacement par défaut introuvable');
    return loc;
  }

  /** Emplacement actif de l'établissement (celui demandé, sinon celui par défaut). */
  async resolveLocation(tx: Tx, companyId: string, establishmentId: string, locationId?: string | null): Promise<StockLocation> {
    if (!locationId) return this.ensureDefaultLocation(tx, companyId, establishmentId);
    const loc = await tx.stockLocation.findFirst({ where: { id: locationId, establishmentId, companyId } });
    if (!loc) throw new BadRequestException("Emplacement invalide pour cet établissement");
    if (!loc.isActive) throw new BadRequestException('Emplacement archivé');
    return loc;
  }

  /**
   * Refuse tout mouvement sur un emplacement gelé par un inventaire ouvert.
   * Verrou partagé : un inventaire ne peut pas s'ouvrir pendant le mouvement.
   */
  async assertNotFrozen(tx: Tx, locationId: string, exceptInventoryId?: string) {
    await tx.$queryRaw`SELECT id FROM stock_locations WHERE id = ${locationId}::uuid FOR SHARE`;
    const open = await tx.inventorySession.findFirst({
      where: { locationId, status: 'OPEN', ...(exceptInventoryId ? { id: { not: exceptInventoryId } } : {}) },
    });
    if (open) throw new ConflictException(`Emplacement gelé : l’inventaire ${open.number} est en cours`);
  }

  async createLot(
    tx: Tx,
    data: {
      companyId: string;
      item: ItemRef;
      origin: LotOrigin;
      unitCost: Prisma.Decimal;
      userId: string;
      supplierId?: string | null;
      brand?: string | null;
      supplierLotRef?: string | null;
      productionDate?: Date | null;
      expiryDate?: Date | null;
      receiptItemId?: string | null;
    },
  ): Promise<StockLot> {
    const lotNumber = await nextNumber(tx, data.companyId, 'LOT');
    return tx.stockLot.create({
      data: {
        companyId: data.companyId,
        lotNumber,
        ...data.item,
        origin: data.origin,
        unitCost: data.unitCost.toDecimalPlaces(4),
        supplierId: data.supplierId ?? null,
        brand: data.brand ?? null,
        supplierLotRef: data.supplierLotRef ?? null,
        productionDate: data.productionDate ?? null,
        expiryDate: data.expiryDate ?? null,
        receiptItemId: data.receiptItemId ?? null,
        createdById: data.userId,
      },
    });
  }

  /** Entrée en stock d'une quantité d'un lot dans un emplacement. */
  async addToLot(tx: Tx, ctx: MovementContext, lot: StockLot, quantity: Prisma.Decimal) {
    if (quantity.lte(0)) throw new BadRequestException('Quantité d’entrée invalide');
    await this.assertNotFrozen(tx, ctx.locationId);
    const rows = await tx.$queryRaw<{ quantity: Prisma.Decimal }[]>`
      INSERT INTO stock_balances (id, company_id, establishment_id, location_id, lot_id, raw_material_id, product_id, quantity, reserved_quantity, updated_at)
      VALUES (gen_random_uuid(), ${ctx.companyId}::uuid, ${ctx.establishmentId}::uuid, ${ctx.locationId}::uuid, ${lot.id}::uuid,
              ${lot.rawMaterialId}::uuid, ${lot.productId}::uuid, ${quantity}, 0, now())
      ON CONFLICT (location_id, lot_id) DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now()
      RETURNING quantity`;
    await this.writeMovement(tx, ctx, lot, quantity, D(rows[0].quantity));
  }

  /**
   * Sortie de stock. Sans lot imposé : FEFO (le lot qui périme le plus tôt,
   * puis le plus ancien). Les lots périmés sont exclus sauf autorisation
   * explicite (perte « péremption », inventaire, retour fournisseur).
   * Le stock réservé n'est jamais entamé.
   */
  async issue(
    tx: Tx,
    ctx: MovementContext,
    item: ItemRef,
    quantity: Prisma.Decimal,
    opts: { lotId?: string | null; allowExpired?: boolean; itemName?: string } = {},
  ): Promise<IssuedLot[]> {
    if (quantity.lte(0)) throw new BadRequestException('Quantité de sortie invalide');
    await this.assertNotFrozen(tx, ctx.locationId);

    // Verrouillage des soldes concernés, dans un ordre stable (évite les interblocages).
    const itemFilter = item.rawMaterialId
      ? Prisma.sql`b.raw_material_id = ${item.rawMaterialId}::uuid`
      : Prisma.sql`b.product_id = ${item.productId}::uuid`;
    const lotFilter = opts.lotId ? Prisma.sql`AND b.lot_id = ${opts.lotId}::uuid` : Prisma.empty;
    await tx.$queryRaw`
      SELECT b.id FROM stock_balances b
      WHERE b.location_id = ${ctx.locationId}::uuid AND ${itemFilter} ${lotFilter}
      ORDER BY b.id FOR UPDATE`;

    const balances = await tx.stockBalance.findMany({
      where: { locationId: ctx.locationId, ...itemWhere(item), ...(opts.lotId ? { lotId: opts.lotId } : {}), quantity: { gt: 0 } },
      include: { lot: true },
    });
    if (opts.lotId && balances.length === 0) throw new ConflictException('Ce lot n’est pas disponible dans cet emplacement');

    const expired = balances.filter((b) => isExpired(b.lot.expiryDate));
    if (opts.lotId && expired.length && !opts.allowExpired) {
      throw new ConflictException(`Lot ${expired[0].lot.lotNumber} périmé : seule une perte « péremption » peut le sortir du stock`);
    }
    const usable = balances
      .filter((b) => opts.allowExpired || !isExpired(b.lot.expiryDate))
      .sort((a, b) => {
        const ea = a.lot.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const eb = b.lot.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return ea !== eb ? ea - eb : a.lot.createdAt.getTime() - b.lot.createdAt.getTime();
      });

    const available = usable.reduce((s, b) => s.add(D(b.quantity).sub(b.reservedQuantity)), D(0));
    if (available.lt(quantity)) {
      const name = opts.itemName ? ` pour « ${opts.itemName} »` : '';
      const blocked = !opts.allowExpired && expired.length ? ' (hors lots périmés)' : '';
      throw new ConflictException(`Stock insuffisant${name} : disponible ${available.toString()}${blocked}, demandé ${quantity.toString()}`);
    }

    const issued: IssuedLot[] = [];
    let remaining = quantity;
    for (const b of usable) {
      if (remaining.lte(0)) break;
      const free = D(b.quantity).sub(b.reservedQuantity);
      if (free.lte(0)) continue;
      const take = Prisma.Decimal.min(free, remaining);
      const rows = await tx.$queryRaw<{ quantity: Prisma.Decimal }[]>`
        UPDATE stock_balances SET quantity = quantity - ${take}, updated_at = now()
        WHERE id = ${b.id}::uuid RETURNING quantity`;
      await this.writeMovement(tx, ctx, b.lot, take.neg(), D(rows[0].quantity));
      issued.push({
        lotId: b.lot.id,
        lotNumber: b.lot.lotNumber,
        quantity: take,
        unitCost: D(b.lot.unitCost),
        value: take.mul(b.lot.unitCost).toDecimalPlaces(2),
      });
      remaining = remaining.sub(take);
    }
    return issued;
  }

  private async writeMovement(tx: Tx, ctx: MovementContext, lot: StockLot, signedQty: Prisma.Decimal, balanceAfter: Prisma.Decimal) {
    await tx.stockMovement.create({
      data: {
        companyId: ctx.companyId,
        establishmentId: ctx.establishmentId,
        locationId: ctx.locationId,
        lotId: lot.id,
        rawMaterialId: lot.rawMaterialId,
        productId: lot.productId,
        type: ctx.type,
        quantity: signedQty,
        unitCost: lot.unitCost,
        value: signedQty.mul(lot.unitCost).toDecimalPlaces(2),
        balanceAfter,
        originType: ctx.originType,
        originId: ctx.originId,
        reason: ctx.reason ?? null,
        userId: ctx.userId,
      },
    });
  }

  /** Coût unitaire proposé pour une entrée sans prix d'achat : dernier lot, sinon offre préférée. */
  async suggestedUnitCost(tx: Tx, companyId: string, item: ItemRef): Promise<Prisma.Decimal | null> {
    const last = await tx.stockLot.findFirst({ where: { companyId, ...itemWhere(item) }, orderBy: { createdAt: 'desc' } });
    if (last) return D(last.unitCost);
    const offer = await tx.supplierProduct.findFirst({
      where: { ...itemWhere(item), isActive: true, unitPrice: { not: null } },
      orderBy: [{ isPreferred: 'desc' }, { priceUpdatedAt: 'desc' }],
    });
    if (offer?.unitPrice != null) return D(offer.unitPrice.toString()).div(offer.quantityPerPurchaseUnit).toDecimalPlaces(4);
    return null;
  }
}
