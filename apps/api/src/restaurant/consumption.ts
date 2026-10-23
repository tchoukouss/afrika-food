import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { LossCause, Prisma, RestaurantOrderItem, ReturnDisposition } from '@prisma/client';
import { AuthUser } from '../auth/decorators';
import { Tx } from '../prisma/prisma.service';
import { loadUnits, requiredQuantity, UnitMap } from '../production/common';
import { D, ItemRef, loadItem, nextNumber } from '../stock/common';
import { MovementContext, StockEngine } from '../stock/engine';
import { roundXof } from './common';

interface Requirement {
  item: ItemRef;
  name: string;
  quantity: Prisma.Decimal;
}

/**
 * Stock du restaurant (décisions R11, R12 et R14) : à l'envoi en cuisine ou au
 * bar, la recette d'un plat « à la commande » ou le produit fini « depuis le
 * stock » sort par le moteur du module 3 (FEFO, lots périmés exclus, réservé
 * respecté, inventaire bloquant). Chaque lot consommé est enregistré pour la
 * traçabilité. À l'annulation : retour aux mêmes lots ou perte déclarée.
 */
@Injectable()
export class RestaurantConsumption {
  constructor(private readonly engine: StockEngine) {}

  /** Ce qu'un article fait sortir du stock, dans l'unité de stock de chaque article. */
  private async requirements(tx: Tx, companyId: string, establishmentId: string, item: RestaurantOrderItem, units: UnitMap, depth = 0): Promise<Requirement[]> {
    const quantity = D(item.quantity);
    if (item.isMenu) {
      if (depth > 0) throw new BadRequestException('Un menu ne peut pas contenir un autre menu');
      const components = await tx.productComponent.findMany({ where: { menuProductId: item.productId }, include: { component: true } });
      if (!components.length) throw new ConflictException(`Le menu « ${item.productName} » n’a aucun composant`);
      const carte = await tx.restaurantMenuItem.findMany({ where: { establishmentId, productId: { in: components.map((c) => c.componentProductId) } } });
      const out: Requirement[] = [];
      for (const c of components) {
        const preparation = carte.find((m) => m.productId === c.componentProductId)?.preparation ?? 'FROM_STOCK';
        const part = { ...item, productId: c.componentProductId, productName: c.component.name, isMenu: c.component.type === 'MENU', quantity: quantity.mul(c.quantity), preparation };
        out.push(...(await this.requirements(tx, companyId, establishmentId, part, units, depth + 1)));
      }
      return out;
    }
    if (item.preparation === 'FROM_STOCK') {
      return [{ item: { rawMaterialId: null, productId: item.productId }, name: item.productName, quantity: quantity.toDecimalPlaces(4, Prisma.Decimal.ROUND_UP) }];
    }
    // Préparé à la commande : recette active (module 4), rendement, perte prévue, conversion d'unités.
    const recipe = await tx.recipe.findUnique({ where: { productId: item.productId } });
    if (!recipe?.activeVersionId) throw new ConflictException(`« ${item.productName} » n’a pas de recette active`);
    const version = await tx.recipeVersion.findUniqueOrThrow({ where: { id: recipe.activeVersionId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
    const scale = quantity.div(version.yieldQuantity);
    const out: Requirement[] = [];
    for (const line of version.items) {
      const ref = { rawMaterialId: line.rawMaterialId, productId: line.productId };
      const info = await loadItem(tx, companyId, ref);
      out.push({ item: ref, name: info.name, quantity: requiredQuantity(units, line, scale, info) });
    }
    return out;
  }

  /**
   * Sort du stock les articles envoyés. Tous les soldes concernés sont
   * verrouillés en une requête triée (pas d'interblocage entre envois
   * simultanés) ; un manque refuse l'envoi entier. Retourne le coût par article.
   */
  async consume(tx: Tx, me: AuthUser, establishmentId: string, entries: { item: RestaurantOrderItem; locationId: string }[]) {
    const units = await loadUnits(tx);
    const plan: { item: RestaurantOrderItem; locationId: string; needs: Requirement[] }[] = [];
    for (const e of entries) plan.push({ ...e, needs: await this.requirements(tx, me.companyId, establishmentId, e.item, units) });

    const locations = [...new Set(plan.map((p) => p.locationId))].sort();
    for (const loc of locations) await this.engine.assertNotFrozen(tx, loc);
    const conditions = locations.map((loc) => {
      const needs = plan.filter((p) => p.locationId === loc).flatMap((p) => p.needs);
      const raw = [...new Set(needs.map((n) => n.item.rawMaterialId).filter((x): x is string => !!x))];
      const prods = [...new Set(needs.map((n) => n.item.productId).filter((x): x is string => !!x))];
      const rawIn = raw.length ? Prisma.sql`raw_material_id IN (${Prisma.join(raw.map((r) => Prisma.sql`${r}::uuid`))})` : Prisma.sql`FALSE`;
      const prodIn = prods.length ? Prisma.sql`product_id IN (${Prisma.join(prods.map((p) => Prisma.sql`${p}::uuid`))})` : Prisma.sql`FALSE`;
      return Prisma.sql`(location_id = ${loc}::uuid AND (${rawIn} OR ${prodIn}))`;
    });
    if (conditions.length) await tx.$queryRaw`SELECT id FROM stock_balances WHERE ${Prisma.join(conditions, ' OR ')} ORDER BY id FOR UPDATE`;

    const costs = new Map<string, Prisma.Decimal>();
    for (const p of plan) {
      const ctx: MovementContext = {
        companyId: me.companyId,
        establishmentId,
        locationId: p.locationId,
        type: 'ORDER_CONSUMPTION',
        originType: 'RESTAURANT_ORDER_ITEM',
        originId: p.item.id,
        userId: me.userId,
      };
      let cost = D(0);
      for (const need of p.needs) {
        if (need.quantity.lte(0)) continue;
        const issued = await this.engine.issue(tx, ctx, need.item, need.quantity, { itemName: need.name });
        await tx.restaurantConsumption.createMany({
          data: issued.map((o) => ({
            itemId: p.item.id,
            kind: 'CONSUMED' as const,
            rawMaterialId: need.item.rawMaterialId,
            productId: need.item.productId,
            lotId: o.lotId,
            locationId: p.locationId,
            quantity: o.quantity,
            unitCost: o.unitCost,
            value: o.value,
          })),
        });
        cost = cost.add(issued.reduce((s, o) => s.add(o.value), D(0)));
      }
      costs.set(p.item.id, cost);
    }
    return costs;
  }

  /**
   * Annulation de `quantity` d'un article envoyé : avant préparation, les
   * ingrédients reviennent aux mêmes lots (ORDER_RETURN) ; après, ils sont
   * déclarés en perte (sans nouveau mouvement : le stock est déjà sorti).
   * La dernière quantité annulée solde exactement les lots restants.
   */
  async cancel(
    tx: Tx,
    me: AuthUser,
    est: { id: string; code: string },
    item: RestaurantOrderItem,
    cancellation: { id: string; quantity: Prisma.Decimal; outcome: ReturnDisposition; lossCause: LossCause | null; reason: string },
    orderNumber: string,
  ) {
    const rows = await tx.restaurantConsumption.findMany({ where: { itemId: item.id }, orderBy: { createdAt: 'asc' } });
    const open = D(item.quantity).sub(item.cancelledQuantity);
    const last = cancellation.quantity.eq(open);
    // Par lot : consommé, et reste encore imputé à l'article.
    const lots = new Map<string, { row: (typeof rows)[number]; consumed: Prisma.Decimal; left: Prisma.Decimal }>();
    for (const r of rows) {
      const key = `${r.lotId}|${r.locationId}`;
      const cur = lots.get(key) ?? { row: r, consumed: D(0), left: D(0) };
      if (r.kind === 'CONSUMED') {
        cur.consumed = cur.consumed.add(r.quantity);
        cur.left = cur.left.add(r.quantity);
      } else cur.left = cur.left.sub(r.quantity);
      lots.set(key, cur);
    }
    const takes = [...lots.values()]
      .map((l) => ({ ...l, qty: last ? l.left : Prisma.Decimal.min(l.left, l.consumed.mul(cancellation.quantity).div(item.quantity).toDecimalPlaces(4)) }))
      .filter((l) => l.qty.gt(0));

    if (cancellation.outcome === 'RESTOCK' && takes.length) {
      const locs = [...new Set(takes.map((t) => t.row.locationId))].sort();
      for (const loc of locs) await this.engine.assertNotFrozen(tx, loc);
      await tx.$queryRaw`
        SELECT id FROM stock_balances
        WHERE (location_id, lot_id) IN (${Prisma.join(takes.map((t) => Prisma.sql`(${t.row.locationId}::uuid, ${t.row.lotId}::uuid)`))})
        ORDER BY id FOR UPDATE`;
    }
    const lotRows = await tx.stockLot.findMany({ where: { id: { in: takes.map((t) => t.row.lotId) } } });
    let value = D(0);
    for (const t of takes) {
      const v = t.qty.mul(t.row.unitCost).toDecimalPlaces(2);
      value = value.add(v);
      const base = { itemId: item.id, rawMaterialId: t.row.rawMaterialId, productId: t.row.productId, lotId: t.row.lotId, locationId: t.row.locationId, quantity: t.qty, unitCost: t.row.unitCost, value: v, cancellationId: cancellation.id };
      if (cancellation.outcome === 'RESTOCK') {
        const ctx: MovementContext = {
          companyId: me.companyId,
          establishmentId: est.id,
          locationId: t.row.locationId,
          type: 'ORDER_RETURN',
          originType: 'RESTAURANT_ITEM_CANCELLATION',
          originId: cancellation.id,
          reason: cancellation.reason,
          userId: me.userId,
        };
        await this.engine.addToLot(tx, ctx, lotRows.find((l) => l.id === t.row.lotId)!, t.qty);
        await tx.restaurantConsumption.create({ data: { ...base, kind: 'RETURNED' } });
      } else {
        const loss = await tx.stockLoss.create({
          data: {
            companyId: me.companyId,
            establishmentId: est.id,
            locationId: t.row.locationId,
            number: await nextNumber(tx, me.companyId, 'STOCK_LOSS', est),
            rawMaterialId: t.row.rawMaterialId,
            productId: t.row.productId,
            lotId: t.row.lotId,
            quantity: t.qty,
            cause: cancellation.lossCause!,
            comment: `Commande ${orderNumber} — ${item.productName} annulé — ${cancellation.reason}`.slice(0, 1000),
            estimatedValue: roundXof(v),
            declaredById: me.userId,
          },
        });
        await tx.restaurantConsumption.create({ data: { ...base, kind: 'LOST', stockLossId: loss.id } });
      }
    }
    return value;
  }
}
