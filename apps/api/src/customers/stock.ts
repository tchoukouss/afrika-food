import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { ProductionCompletion, ProductionService } from '../production/production';
import { D, isExpired } from '../stock/common';
import { MovementContext, StockEngine } from '../stock/engine';
import { assertWrite, canRead, lockRowOf } from './lines';

/** Statuts où une commande garde ses réservations. */
const RESERVING = ['CONFIRMED', 'IN_PREPARATION', 'READY'];

/** Identifiant stable dérivé d'une ligne : relancer la production d'une ligne réutilise le même ordre (anti double envoi du module 4). */
const productionRequestId = (lineId: string) => {
  const h = createHash('sha1').update(`customer-order-line:${lineId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
};

/**
 * Stock des commandes clients (décision D5), sur les mécanismes existants :
 * - réservation à la confirmation selon la règle du module 4 (quantité
 *   réservée du solde, FEFO, lots périmés exclus, soldes verrouillés en une
 *   requête triée) : le moteur du module 3 ne sort jamais du réservé ;
 * - produit fabriqué à la demande : ordre de production du module 4, lot fini
 *   réservé dans la transaction de fin de production (crochet du module 4) ;
 * - une seule sortie à la remise ou à la livraison, par le moteur du module 3
 *   (mouvement CUSTOMER_DELIVERY), après libération de la réservation.
 */
@Injectable()
export class CustomerOrderStock implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
    private readonly production: ProductionService,
  ) {}

  onModuleInit() {
    this.production.registerCompletionHook((tx, me, completion) => this.reserveProducedLot(tx, me, completion));
  }

  /** Articles réellement stockés d'une ligne : le produit, ou les composants d'un menu. */
  private async parts(tx: Tx, line: { productId: string | null; quantity: Prisma.Decimal.Value }) {
    const product = await tx.product.findUniqueOrThrow({ where: { id: line.productId! } });
    if (product.type !== 'MENU') return [{ productId: product.id, name: product.name, quantity: D(line.quantity) }];
    const components = await tx.productComponent.findMany({ where: { menuProductId: product.id }, include: { component: { select: { name: true } } } });
    if (!components.length) throw new ConflictException(`Le menu « ${product.name} » n’a aucun composant`);
    return components.map((c) => ({ productId: c.componentProductId, name: c.component.name, quantity: D(line.quantity).mul(c.quantity).toDecimalPlaces(4, Prisma.Decimal.ROUND_UP) }));
  }

  /** Verrouille, en une requête triée, les soldes des produits à l'emplacement (même ordre que les modules 3 à 6). */
  private async lockBalances(tx: Tx, locationId: string, productIds: string[]) {
    if (!productIds.length) return;
    await tx.$queryRaw`
      SELECT id FROM stock_balances
      WHERE location_id = ${locationId}::uuid AND product_id IN (${Prisma.join([...new Set(productIds)].map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY id FOR UPDATE`;
  }

  private async lockBalanceIds(tx: Tx, ids: string[]) {
    if (!ids.length) return;
    await tx.$queryRaw`SELECT id FROM stock_balances WHERE id IN (${Prisma.join([...new Set(ids)].map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
  }

  /**
   * Réserve, à la confirmation, les lignes prises en stock (hors fabrication à
   * la demande et frais). Tout ou rien : un manque refuse la confirmation.
   */
  async reserveOrder(tx: Tx, me: AuthUser, order: { id: string; number: string; establishmentId: string }) {
    const lines = await tx.customerOrderLine.findMany({ where: { orderId: order.id, kind: 'PRODUCT', madeToOrder: false }, orderBy: { position: 'asc' } });
    if (!lines.length) return;
    const location = await this.engine.ensureDefaultLocation(tx, me.companyId, order.establishmentId);
    const needs = [];
    for (const line of lines) for (const part of await this.parts(tx, line)) needs.push({ line, ...part });
    await this.lockBalances(tx, location.id, needs.map((n) => n.productId));

    const plan: { lineId: string; balanceId: string; lotId: string; quantity: Prisma.Decimal }[] = [];
    const shortages: string[] = [];
    const used = new Map<string, Prisma.Decimal>(); // quantités déjà prévues par solde (même produit sur deux lignes)
    for (const n of needs) {
      const balances = await tx.stockBalance.findMany({ where: { locationId: location.id, productId: n.productId, quantity: { gt: 0 } }, include: { lot: true } });
      const usable = balances
        .filter((b) => !isExpired(b.lot.expiryDate))
        .sort((a, b) => {
          const ea = a.lot.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const eb = b.lot.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return ea !== eb ? ea - eb : a.lot.createdAt.getTime() - b.lot.createdAt.getTime();
        });
      let remaining = n.quantity;
      for (const b of usable) {
        if (remaining.lte(0)) break;
        const free = D(b.quantity).sub(b.reservedQuantity).sub(used.get(b.id) ?? 0);
        if (free.lte(0)) continue;
        const take = Prisma.Decimal.min(free, remaining);
        plan.push({ lineId: n.line.id, balanceId: b.id, lotId: b.lotId, quantity: take });
        used.set(b.id, (used.get(b.id) ?? D(0)).add(take));
        remaining = remaining.sub(take);
      }
      if (remaining.gt(0)) shortages.push(`« ${n.name} » : manque ${remaining.toString()}`);
    }
    if (shortages.length) throw new ConflictException(`Stock disponible insuffisant pour confirmer la commande ${order.number} — ${shortages.join(' ; ')}`);
    for (const p of plan) {
      await tx.$executeRaw`UPDATE stock_balances SET reserved_quantity = reserved_quantity + ${p.quantity}, updated_at = now() WHERE id = ${p.balanceId}::uuid`;
      await tx.orderReservation.create({ data: { orderLineId: p.lineId, balanceId: p.balanceId, lotId: p.lotId, quantity: p.quantity } });
    }
    await this.audit.record(
      { action: 'CUSTOMER_ORDER_RESERVED', entityType: 'CustomerOrder', entityId: order.id, establishmentId: order.establishmentId, newValues: { number: order.number, reservations: plan.length } },
      tx,
    );
  }

  /** Libère toutes les réservations actives d'une commande (annulation). */
  async releaseOrder(tx: Tx, order: { id: string }) {
    const active = await tx.orderReservation.findMany({ where: { line: { orderId: order.id }, releasedAt: null } });
    await this.lockBalanceIds(tx, active.map((r) => r.balanceId));
    for (const r of active) await this.release(tx, r);
    return active.length;
  }

  private async release(tx: Tx, r: { id: string; balanceId: string; quantity: Prisma.Decimal.Value }) {
    await tx.$executeRaw`UPDATE stock_balances SET reserved_quantity = reserved_quantity - ${D(r.quantity)}, updated_at = now() WHERE id = ${r.balanceId}::uuid`;
    await tx.orderReservation.update({ where: { id: r.id }, data: { releasedAt: new Date() } });
  }

  /**
   * Sortie unique à la remise ou à la livraison : chaque réservation est
   * libérée puis le même lot sort par le moteur du module 3 (FEFO déjà
   * appliqué à la réservation). La commande verrouillée et la quantité livrée
   * de chaque ligne empêchent toute seconde sortie.
   */
  async issueOrder(tx: Tx, me: AuthUser, order: { id: string; number: string; establishmentId: string }, deliveryId: string | null) {
    const lines = await tx.customerOrderLine.findMany({ where: { orderId: order.id, kind: 'PRODUCT' }, include: { reservations: { where: { releasedAt: null } } }, orderBy: { position: 'asc' } });
    const pending = lines.filter((l) => D(l.deliveredQuantity).lt(l.quantity));
    if (lines.length && !pending.length) throw new ConflictException(`Commande ${order.number} déjà sortie du stock`);
    // Chaque article de chaque ligne doit être entièrement réservé (production terminée pour la fabrication à la demande).
    const lots = await tx.stockLot.findMany({ where: { id: { in: pending.flatMap((l) => l.reservations.map((r) => r.lotId)) } } });
    for (const line of pending) {
      for (const part of await this.parts(tx, line)) {
        const reserved = line.reservations.filter((r) => lots.find((x) => x.id === r.lotId)?.productId === part.productId).reduce((s, r) => s.add(r.quantity), D(0));
        if (reserved.lt(part.quantity)) {
          throw new ConflictException(line.madeToOrder ? `« ${line.label} » : production pas encore terminée` : `« ${line.label} » : réservation incomplète`);
        }
      }
    }
    const reservations = pending.flatMap((l) => l.reservations.map((r) => ({ ...r, line: l })));
    const balances = await tx.stockBalance.findMany({ where: { id: { in: reservations.map((r) => r.balanceId) } } });
    for (const loc of [...new Set(balances.map((b) => b.locationId))].sort()) await this.engine.assertNotFrozen(tx, loc);
    await this.lockBalanceIds(tx, reservations.map((r) => r.balanceId));
    let value = D(0);
    for (const r of reservations) {
      const balance = balances.find((b) => b.id === r.balanceId)!;
      const lot = lots.find((x) => x.id === r.lotId)!;
      await this.release(tx, r);
      const ctx: MovementContext = {
        companyId: me.companyId,
        establishmentId: order.establishmentId,
        locationId: balance.locationId,
        type: 'CUSTOMER_DELIVERY',
        originType: 'CUSTOMER_ORDER',
        originId: order.id,
        userId: me.userId,
      };
      const issued = await this.engine.issue(tx, ctx, { rawMaterialId: null, productId: lot.productId }, D(r.quantity), { lotId: r.lotId, itemName: r.line.label });
      for (const i of issued) {
        await tx.customerOrderLineIssue.create({
          data: { lineId: r.line.id, deliveryId, productId: lot.productId!, lotId: i.lotId, locationId: balance.locationId, quantity: i.quantity, unitCost: i.unitCost, value: i.value, createdById: me.userId },
        });
        value = value.add(i.value);
      }
    }
    for (const line of pending) await tx.customerOrderLine.update({ where: { id: line.id }, data: { deliveredQuantity: line.quantity } });
    await this.audit.record(
      { action: 'CUSTOMER_ORDER_ISSUED', entityType: 'CustomerOrder', entityId: order.id, establishmentId: order.establishmentId, newValues: { number: order.number, deliveryId, lots: reservations.length, value } },
      tx,
    );
  }

  // --- Fabrication à la demande (module 4) -------------------------------------------------

  /**
   * Lance la production d'une ligne « fabriquée à la demande » par le service
   * du module 4 (mêmes règles : recette active, réservation des matières,
   * validation, lancement…), puis rattache l'ordre à la ligne.
   */
  async launchProduction(me: AuthUser, orderId: string, lineId: string) {
    const line = await this.prisma.customerOrderLine.findFirst({ where: { id: lineId, orderId }, include: { order: true } });
    if (!line || line.order.companyId !== me.companyId || !canRead(me, line.order.establishmentId)) throw new NotFoundException('Ligne de commande introuvable');
    assertWrite(me, line.order.establishmentId);
    if (!me.access.can('production.manage', line.order.establishmentId)) throw new ForbiddenException('Lancer une production exige « Gérer la production »');
    if (!line.madeToOrder) throw new BadRequestException('Cette ligne est prise en stock, pas fabriquée à la demande');
    if (!['CONFIRMED', 'IN_PREPARATION'].includes(line.order.status)) throw new ConflictException('La production se lance sur une commande confirmée ou en préparation');
    const production = (await this.production.create(me, {
      clientRequestId: productionRequestId(line.id),
      establishmentId: line.order.establishmentId,
      productId: line.productId!,
      plannedQuantity: Number(line.quantity),
      notes: `Commande client ${line.order.number}`,
    })) as { id: string; number: string };
    await this.prisma.$transaction(async (tx) => {
      await lockRowOf(tx, 'customer_orders', orderId);
      const fresh = await tx.customerOrderLine.findUniqueOrThrow({ where: { id: lineId } });
      if (fresh.productionOrderId === production.id) return;
      if (fresh.productionOrderId) throw new ConflictException('Une production est déjà rattachée à cette ligne');
      await tx.customerOrderLine.update({ where: { id: lineId }, data: { productionOrderId: production.id } });
      await this.audit.record(
        { action: 'CUSTOMER_ORDER_PRODUCTION_LINKED', entityType: 'CustomerOrder', entityId: orderId, establishmentId: line.order.establishmentId, newValues: { line: line.label, production: production.number } },
        tx,
      );
    });
    return production;
  }

  /**
   * Crochet du module 4, dans la transaction de fin de production : le lot fini
   * d'un ordre rattaché à une commande est réservé aussitôt, sans intervalle où
   * il serait vendable.
   */
  private async reserveProducedLot(tx: Tx, me: AuthUser, c: ProductionCompletion) {
    const line = await tx.customerOrderLine.findFirst({ where: { productionOrderId: c.orderId }, include: { reservations: { where: { releasedAt: null } } } });
    if (!line || line.productId !== c.productId) return;
    await lockRowOf(tx, 'customer_orders', line.orderId);
    const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: line.orderId } });
    if (!RESERVING.includes(order.status)) return; // commande annulée ou déjà livrée : le lot reste libre
    const reserved = line.reservations.reduce((s, r) => s.add(r.quantity), D(0));
    const needed = D(line.quantity).sub(line.deliveredQuantity).sub(reserved);
    const quantity = Prisma.Decimal.min(needed, c.quantity);
    if (quantity.lte(0)) return;
    const balance = await tx.stockBalance.findUniqueOrThrow({ where: { locationId_lotId: { locationId: c.locationId, lotId: c.lot.id } } });
    await this.lockBalanceIds(tx, [balance.id]);
    await tx.$executeRaw`UPDATE stock_balances SET reserved_quantity = reserved_quantity + ${quantity}, updated_at = now() WHERE id = ${balance.id}::uuid`;
    await tx.orderReservation.create({ data: { orderLineId: line.id, balanceId: balance.id, lotId: c.lot.id, quantity } });
    await this.audit.record(
      {
        action: 'CUSTOMER_ORDER_RESERVED',
        entityType: 'CustomerOrder',
        entityId: order.id,
        establishmentId: order.establishmentId,
        companyId: me.companyId,
        userId: me.userId,
        newValues: { number: order.number, line: line.label, lot: c.lot.lotNumber, quantity, productionOrderId: c.orderId },
      },
      tx,
    );
  }
}
