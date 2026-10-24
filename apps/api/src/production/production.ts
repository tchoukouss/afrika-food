import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LossCause, Prisma, ProductionOrder, ProductionStatus, StockLot } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { attachItems, D, dateOnly, establishmentFor, idempotent, isExpired, itemWhere, loadItem, nextNumber, readableEstablishments, userNames } from '../stock/common';
import { MovementContext, StockEngine } from '../stock/engine';
import { loadUnits, nextProductionNumber, requiredQuantity } from './common';
import { CostingService } from './costing';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);
const QTY = { maxDecimalPlaces: 4 };

export class CreateProductionDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsUUID() productId: string;
  /** Quantité à produire, dans l'unité de vente du produit. */
  @IsNumber(QTY) @Min(0.0001) @Max(1e9) plannedQuantity: number;
  @IsOptional() @IsDateString() plannedDate?: string | null;
  /** Emplacement des matières (par défaut : Magasin principal). */
  @IsOptional() @IsUUID() sourceLocationId?: string;
  /** Emplacement des produits finis (par défaut : Magasin principal). */
  @IsOptional() @IsUUID() destLocationId?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

export class UpdateProductionDto {
  @IsOptional() @IsNumber(QTY) @Min(0.0001) @Max(1e9) plannedQuantity?: number;
  @IsOptional() @IsDateString() plannedDate?: string | null;
  @IsOptional() @IsUUID() sourceLocationId?: string;
  @IsOptional() @IsUUID() destLocationId?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

export class AdjustmentLineDto {
  @IsUUID() itemId: string;
  /** Matière utilisée en plus de la recette (unité de stock). */
  @IsOptional() @IsNumber(QTY) @Min(0.0001) @Max(1e9) extraQuantity?: number;
  /** Reste non utilisé, rendu au stock (unité de stock). */
  @IsOptional() @IsNumber(QTY) @Min(0.0001) @Max(1e9) returnedQuantity?: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class CompleteProductionDto {
  /** Quantité réellement produite (bonne), unité de vente du produit. 0 = production ratée. */
  @IsNumber(QTY) @Min(0) @Max(1e9) producedQuantity: number;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => AdjustmentLineDto) adjustments?: AdjustmentLineDto[];
  /** Obligatoires si la quantité produite est inférieure à la prévue (décision J). */
  @IsOptional() @IsEnum(LossCause) lossCause?: LossCause;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) lossReason?: string | null;
  /** Obligatoire si la quantité produite dépasse la prévue. */
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) overReason?: string | null;
}

export class ControlProductionDto {
  /** Quantité non conforme constatée au contrôle (sortie en perte). */
  @IsOptional() @IsNumber(QTY) @Min(0.0001) @Max(1e9) nonConformQuantity?: number;
  @IsOptional() @IsEnum(LossCause) cause?: LossCause;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) reason?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) note?: string | null;
}

export class CancelProductionDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class ProductionQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsEnum(ProductionStatus) status?: ProductionStatus;
}

/** Lot fini que la fin de production vient de créer et de mettre en stock. */
export interface ProductionCompletion {
  orderId: string;
  establishmentId: string;
  productId: string;
  lot: StockLot;
  locationId: string;
  quantity: Prisma.Decimal;
}

/**
 * Appelé dans la transaction de la fin de production, juste après la mise en
 * stock du lot fini (ex. module 7 : réserver ce lot pour une commande client).
 * Une erreur annule toute la fin de production.
 */
export type ProductionCompletionHook = (tx: Tx, me: AuthUser, completion: ProductionCompletion) => Promise<void>;

// Registre commun à toutes les instances du service (chaque module Nest en crée une).
const completionHooks: ProductionCompletionHook[] = [];

/** Statuts visibles du magasinier (lecture des besoins à préparer, décision H). */
const STOREKEEPER_STATUSES: ProductionStatus[] = ['VALIDATED', 'IN_PROGRESS', 'COMPLETED', 'CONTROLLED'];

@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
    private readonly costing: CostingService,
  ) {}

  /** Enregistre un crochet de fin de production ; renvoie la fonction qui le retire. */
  registerCompletionHook(hook: ProductionCompletionHook): () => void {
    completionHooks.push(hook);
    return () => {
      const i = completionHooks.indexOf(hook);
      if (i >= 0) completionHooks.splice(i, 1);
    };
  }

  // --- Visibilité ---------------------------------------------------------------

  /**
   * « Voir la production » : tous les ordres de l'établissement.
   * « Voir les stocks » seulement : ordres validés et suivants (décision H).
   */
  private visibility(me: AuthUser, requested?: string) {
    const full = readableEstablishments(me, 'production.view');
    const readOnly = readableEstablishments(me, 'stock.view').filter((id) => !full.includes(id));
    const keep = (ids: string[]) => (requested ? ids.filter((id) => id === requested) : ids);
    if (!full.length && !readOnly.length) throw new ForbiddenException("Vous n'avez pas accès à la production");
    if (requested && !keep([...full, ...readOnly]).length) throw new ForbiddenException('Établissement non accessible');
    return {
      where: { OR: [{ establishmentId: { in: keep(full) } }, { establishmentId: { in: keep(readOnly) }, status: { in: STOREKEEPER_STATUSES } }] } satisfies Prisma.ProductionOrderWhereInput,
    };
  }

  async list(me: AuthUser, q: ProductionQuery) {
    const rows = await this.prisma.productionOrder.findMany({
      where: { companyId: me.companyId, status: q.status, ...this.visibility(me, q.establishmentId).where },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const products = await this.prisma.product.findMany({ where: { id: { in: rows.map((r) => r.productId) } }, select: { id: true, code: true, name: true, saleUnitCode: true } });
    return rows.map((r) => ({ ...r, product: products.find((p) => p.id === r.productId) ?? null }));
  }

  async get(me: AuthUser, id: string) {
    const o = await this.prisma.productionOrder.findFirst({
      where: { id, companyId: me.companyId, ...this.visibility(me).where },
      include: { items: true, reservations: true, consumptions: { orderBy: { createdAt: 'asc' } }, outputs: true, losses: { orderBy: { createdAt: 'asc' } } },
    });
    if (!o) throw new NotFoundException('Ordre de production introuvable');
    const lotIds = [...o.consumptions.map((c) => c.lotId), ...o.outputs.map((x) => x.lotId)];
    const [product, version, items, lots, locations, names] = await Promise.all([
      this.prisma.product.findUnique({ where: { id: o.productId }, select: { id: true, code: true, name: true, saleUnitCode: true } }),
      this.prisma.recipeVersion.findUnique({ where: { id: o.recipeVersionId }, select: { id: true, version: true, recipeId: true, yieldQuantity: true, shelfLifeDays: true } }),
      attachItems(this.prisma, o.items),
      this.prisma.stockLot.findMany({ where: { id: { in: lotIds } }, select: { id: true, lotNumber: true, expiryDate: true, supplierId: true } }),
      this.prisma.stockLocation.findMany({ where: { id: { in: [o.sourceLocationId, o.destLocationId] } }, select: { id: true, name: true } }),
      userNames(this.prisma, me.companyId, [o.createdById, o.validatedById, o.startedById, o.completedById, o.controlledById, o.cancelledById, ...o.losses.map((l) => l.createdById)]),
    ]);
    const lotNumber = (lotId: string) => lots.find((l) => l.id === lotId)?.lotNumber;
    const name = (uid: string | null) => (uid ? names.get(uid) ?? null : null);
    return {
      ...o,
      product,
      version,
      sourceLocation: locations.find((l) => l.id === o.sourceLocationId) ?? null,
      destLocation: locations.find((l) => l.id === o.destLocationId) ?? null,
      items: items.map((i) => ({
        ...i,
        reserved: o.reservations.filter((r) => r.itemId === i.id && !r.releasedAt).reduce((s, r) => s.add(r.quantity), D(0)),
      })),
      consumptions: o.consumptions.map((c) => ({ ...c, lotNumber: lotNumber(c.lotId) })),
      outputs: o.outputs.map((x) => ({ ...x, lotNumber: lotNumber(x.lotId), expiryDate: lots.find((l) => l.id === x.lotId)?.expiryDate ?? null })),
      losses: o.losses.map((l) => ({ ...l, createdBy: name(l.createdById) })),
      people: {
        createdBy: name(o.createdById),
        validatedBy: name(o.validatedById),
        startedBy: name(o.startedById),
        completedBy: name(o.completedById),
        controlledBy: name(o.controlledById),
        cancelledBy: name(o.cancelledById),
      },
    };
  }

  // --- Création -------------------------------------------------------------------

  /** Besoins théoriques : recette × (prévu ÷ rendement), perte incluse, en unité de stock. */
  private async buildItems(tx: Tx, me: AuthUser, versionId: string, plannedQuantity: Prisma.Decimal) {
    const units = await loadUnits(tx);
    const version = await tx.recipeVersion.findUniqueOrThrow({ where: { id: versionId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
    const scale = plannedQuantity.div(version.yieldQuantity);
    const rows = [];
    for (const it of version.items) {
      const item = { rawMaterialId: it.rawMaterialId, productId: it.productId };
      const info = await loadItem(tx, me.companyId, item);
      rows.push({
        ...item,
        recipeQuantity: D(it.quantity),
        recipeUnitCode: it.unitCode,
        lossPercent: D(it.lossPercent),
        theoreticalQuantity: requiredQuantity(units, it, scale, info),
      });
    }
    return rows;
  }

  private async estimateCost(tx: Tx, me: AuthUser, establishmentId: string, items: { rawMaterialId: string | null; productId: string | null; theoreticalQuantity: Prisma.Decimal }[]) {
    let total = D(0);
    for (const i of items) {
      const est = await this.costing.estimate(tx, me.companyId, i, i.theoreticalQuantity, establishmentId);
      if (est.cost === null) return null;
      total = total.add(est.cost);
    }
    return total.toDecimalPlaces(2);
  }

  create(me: AuthUser, dto: CreateProductionDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.productionOrder
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((o) => o && { id: o.id, ownerId: o.createdById }),
      () => this.doCreate(me, dto),
      (id) => this.get(me, id),
    );
  }

  private async doCreate(me: AuthUser, dto: CreateProductionDto) {
    const id = await this.prisma.$transaction(async (tx) => {
      const est = await establishmentFor(tx, me, dto.establishmentId, 'production.manage');
      const product = await tx.product.findFirst({ where: { id: dto.productId, companyId: me.companyId } });
      if (!product || product.type !== 'MANUFACTURED') throw new BadRequestException('Seul un produit « fabriqué » se produit');
      if (!product.isActive) throw new BadRequestException('Produit archivé');
      const recipe = await tx.recipe.findUnique({ where: { productId: product.id } });
      if (!recipe?.activeVersionId) throw new ConflictException(`« ${product.name} » n’a pas de recette active`);
      const source = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.sourceLocationId);
      const dest = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.destLocationId);
      const planned = D(dto.plannedQuantity);
      const items = await this.buildItems(tx, me, recipe.activeVersionId, planned);
      const order = await tx.productionOrder.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          number: await nextProductionNumber(tx, me.companyId, est),
          clientRequestId: dto.clientRequestId ?? null,
          productId: product.id,
          recipeVersionId: recipe.activeVersionId,
          plannedQuantity: planned,
          plannedDate: dto.plannedDate ? dateOnly(dto.plannedDate) : null,
          sourceLocationId: source.id,
          destLocationId: dest.id,
          notes: dto.notes ?? null,
          theoreticalCost: await this.estimateCost(tx, me, est.id, items),
          createdById: me.userId,
          items: { create: items },
        },
      });
      await this.audit.record(
        { action: 'PRODUCTION_PLANNED', entityType: 'ProductionOrder', entityId: order.id, establishmentId: est.id, newValues: { number: order.number, product: product.code, plannedQuantity: dto.plannedQuantity } },
        tx,
      );
      return order.id;
    });
    return this.get(me, id);
  }

  /** Verrouille l'ordre, contrôle le statut et la permission dans son établissement. */
  private async locked(tx: Tx, me: AuthUser, id: string, expected: ProductionStatus[], permission = 'production.manage') {
    await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${id}::uuid FOR UPDATE`;
    const o = await tx.productionOrder.findFirst({ where: { id, companyId: me.companyId }, include: { items: true } });
    if (!o) throw new NotFoundException('Ordre de production introuvable');
    const est = await establishmentFor(tx, me, o.establishmentId, permission);
    if (!expected.includes(o.status)) throw new ConflictException(`Action impossible : l’ordre ${o.number} est au statut ${o.status}`);
    return { order: o, est };
  }

  async update(me: AuthUser, id: string, dto: UpdateProductionDto) {
    await this.prisma.$transaction(async (tx) => {
      const { order, est } = await this.locked(tx, me, id, ['PLANNED']);
      const source = dto.sourceLocationId ? await this.engine.resolveLocation(tx, me.companyId, est.id, dto.sourceLocationId) : null;
      const dest = dto.destLocationId ? await this.engine.resolveLocation(tx, me.companyId, est.id, dto.destLocationId) : null;
      let theoreticalCost: Prisma.Decimal | null | undefined;
      if (dto.plannedQuantity !== undefined) {
        // Ordre planifié : rien n'est réservé ni consommé, les besoins sont recalculés.
        const items = await this.buildItems(tx, me, order.recipeVersionId, D(dto.plannedQuantity));
        await tx.productionItem.deleteMany({ where: { orderId: id } });
        await tx.productionItem.createMany({ data: items.map((i) => ({ ...i, orderId: id })) });
        theoreticalCost = await this.estimateCost(tx, me, est.id, items);
      }
      await tx.productionOrder.update({
        where: { id },
        data: {
          plannedQuantity: dto.plannedQuantity !== undefined ? D(dto.plannedQuantity) : undefined,
          plannedDate: dto.plannedDate === undefined ? undefined : dto.plannedDate ? dateOnly(dto.plannedDate) : null,
          sourceLocationId: source?.id,
          destLocationId: dest?.id,
          notes: dto.notes,
          theoreticalCost,
        },
      });
      await this.audit.record(
        { action: 'PRODUCTION_UPDATED', entityType: 'ProductionOrder', entityId: id, establishmentId: order.establishmentId, oldValues: { plannedQuantity: order.plannedQuantity }, newValues: { ...dto } },
        tx,
      );
    });
    return this.get(me, id);
  }

  // --- Réservations (décision D) ---------------------------------------------------

  /**
   * Verrouille en une seule requête, dans l'ordre des identifiants, tous les
   * soldes des ingrédients de l'ordre (et ses soldes réservés). Toutes les
   * opérations de production verrouillent ainsi dans le même ordre : deux
   * validations ou lancements simultanés ne peuvent pas s'interbloquer.
   */
  private async lockBalances(tx: Tx, orderId: string, locationId: string, items: { rawMaterialId: string | null; productId: string | null }[]) {
    const raw = items.map((i) => i.rawMaterialId).filter((x): x is string => !!x);
    const prods = items.map((i) => i.productId).filter((x): x is string => !!x);
    const rawIn = raw.length ? Prisma.sql`raw_material_id IN (${Prisma.join(raw.map((r) => Prisma.sql`${r}::uuid`))})` : Prisma.sql`FALSE`;
    const prodIn = prods.length ? Prisma.sql`product_id IN (${Prisma.join(prods.map((p) => Prisma.sql`${p}::uuid`))})` : Prisma.sql`FALSE`;
    await tx.$queryRaw`
      SELECT id FROM stock_balances
      WHERE (location_id = ${locationId}::uuid AND (${rawIn} OR ${prodIn}))
         OR id IN (SELECT balance_id FROM production_reservations WHERE order_id = ${orderId}::uuid AND released_at IS NULL)
      ORDER BY id FOR UPDATE`;
  }

  /** Réserve en FEFO, à l'emplacement des matières, les lots non périmés et libres. */
  private async reserve(tx: Tx, order: ProductionOrder & { items: { id: string; rawMaterialId: string | null; productId: string | null; theoreticalQuantity: Prisma.Decimal }[] }) {
    const shortages: string[] = [];
    const plan: { itemId: string; balanceId: string; quantity: Prisma.Decimal }[] = [];
    await this.lockBalances(tx, order.id, order.sourceLocationId, order.items);
    for (const it of order.items) {
      const item = { rawMaterialId: it.rawMaterialId, productId: it.productId };
      const balances = await tx.stockBalance.findMany({ where: { locationId: order.sourceLocationId, ...itemWhere(item), quantity: { gt: 0 } }, include: { lot: true } });
      const usable = balances
        .filter((b) => !isExpired(b.lot.expiryDate))
        .sort((a, b) => {
          const ea = a.lot.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
          const eb = b.lot.expiryDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
          return ea !== eb ? ea - eb : a.lot.createdAt.getTime() - b.lot.createdAt.getTime();
        });
      let remaining = D(it.theoreticalQuantity);
      for (const b of usable) {
        if (remaining.lte(0)) break;
        const free = D(b.quantity).sub(b.reservedQuantity);
        if (free.lte(0)) continue;
        const take = Prisma.Decimal.min(free, remaining);
        plan.push({ itemId: it.id, balanceId: b.id, quantity: take });
        remaining = remaining.sub(take);
      }
      if (remaining.gt(0)) {
        const info = await loadItem(tx, order.companyId, item);
        shortages.push(`« ${info.name} » : manque ${remaining.toString()} ${info.unit}`);
      }
    }
    if (shortages.length) throw new ConflictException(`Stock disponible insuffisant pour réserver les matières — ${shortages.join(' ; ')}`);
    for (const p of plan) {
      await tx.$executeRaw`UPDATE stock_balances SET reserved_quantity = reserved_quantity + ${p.quantity}, updated_at = now() WHERE id = ${p.balanceId}::uuid`;
      await tx.productionReservation.create({ data: { orderId: order.id, itemId: p.itemId, balanceId: p.balanceId, quantity: p.quantity } });
    }
  }

  /** Libère les réservations encore actives de l'ordre. */
  private async release(tx: Tx, orderId: string) {
    const active = await tx.productionReservation.findMany({ where: { orderId, releasedAt: null }, orderBy: { balanceId: 'asc' } });
    for (const r of active) {
      await tx.$executeRaw`UPDATE stock_balances SET reserved_quantity = reserved_quantity - ${r.quantity}, updated_at = now() WHERE id = ${r.balanceId}::uuid`;
      await tx.productionReservation.update({ where: { id: r.id }, data: { releasedAt: new Date() } });
    }
    return active.length;
  }

  async validate(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const { order } = await this.locked(tx, me, id, ['PLANNED']);
      await this.reserve(tx, order);
      await tx.productionOrder.update({ where: { id }, data: { status: 'VALIDATED', validatedById: me.userId, validatedAt: new Date() } });
      await this.audit.record({ action: 'PRODUCTION_VALIDATED', entityType: 'ProductionOrder', entityId: id, establishmentId: order.establishmentId, newValues: { reservedItems: order.items.length } }, tx);
    });
    return this.get(me, id);
  }

  // --- Lancement (décision C) ------------------------------------------------------

  private ctx(me: AuthUser, order: ProductionOrder, locationId: string, type: MovementContext['type'], reason?: string | null): MovementContext {
    return { companyId: me.companyId, establishmentId: order.establishmentId, locationId, type, originType: 'ProductionOrder', originId: order.id, reason: reason ?? order.number, userId: me.userId };
  }

  /** Lancement : les réservations sont libérées puis les quantités théoriques sortent du stock (FEFO). */
  async start(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const { order } = await this.locked(tx, me, id, ['VALIDATED']);
      await this.lockBalances(tx, id, order.sourceLocationId, order.items);
      await this.release(tx, id);
      for (const it of order.items) {
        const item = { rawMaterialId: it.rawMaterialId, productId: it.productId };
        const info = await loadItem(tx, me.companyId, item);
        const issued = await this.engine.issue(tx, this.ctx(me, order, order.sourceLocationId, 'CONSUMPTION'), item, D(it.theoreticalQuantity), { itemName: info.name });
        for (const i of issued) {
          await tx.productionConsumption.create({
            data: { orderId: id, itemId: it.id, lotId: i.lotId, locationId: order.sourceLocationId, kind: 'THEORETICAL', quantity: i.quantity, unitCost: i.unitCost, value: i.value },
          });
        }
        await tx.productionItem.update({ where: { id: it.id }, data: { consumedQuantity: it.theoreticalQuantity } });
      }
      await tx.productionOrder.update({ where: { id }, data: { status: 'IN_PROGRESS', startedById: me.userId, startedAt: new Date() } });
      await this.audit.record({ action: 'PRODUCTION_STARTED', entityType: 'ProductionOrder', entityId: id, establishmentId: order.establishmentId }, tx);
    });
    return this.get(me, id);
  }

  // --- Fin de production (décisions C, F, J) ---------------------------------------

  async complete(me: AuthUser, id: string, dto: CompleteProductionDto) {
    await this.prisma.$transaction(async (tx) => {
      const { order } = await this.locked(tx, me, id, ['IN_PROGRESS']);
      const planned = D(order.plannedQuantity);
      const produced = D(dto.producedQuantity);
      if (produced.lt(planned)) {
        if (!dto.lossCause || !dto.lossReason) throw new BadRequestException('Quantité produite inférieure à la prévue : cause et motif de la perte obligatoires');
        if (dto.lossCause === 'TRANSIT') throw new BadRequestException('Cause « transit » réservée aux transferts');
      }
      if (produced.gt(planned) && !dto.overReason) throw new BadRequestException('Quantité produite supérieure à la prévue : motif obligatoire');
      if (dto.adjustments?.length) await this.lockBalances(tx, id, order.sourceLocationId, order.items);

      // Écarts de consommation : supplément sorti du stock ou reste rendu (avec motif).
      const seen = new Set<string>();
      for (const adj of dto.adjustments ?? []) {
        const it = order.items.find((x) => x.id === adj.itemId);
        if (!it) throw new BadRequestException('Ligne de production invalide');
        if (seen.has(it.id)) throw new BadRequestException('Un ingrédient apparaît deux fois dans les écarts');
        seen.add(it.id);
        if (!!adj.extraQuantity === !!adj.returnedQuantity) throw new BadRequestException('Indiquer soit un supplément, soit un reste rendu');
        const item = { rawMaterialId: it.rawMaterialId, productId: it.productId };
        const info = await loadItem(tx, me.companyId, item);
        if (adj.extraQuantity) {
          const extra = D(adj.extraQuantity);
          const issued = await this.engine.issue(tx, this.ctx(me, order, order.sourceLocationId, 'CONSUMPTION', adj.reason), item, extra, { itemName: info.name });
          for (const i of issued) {
            await tx.productionConsumption.create({
              data: { orderId: id, itemId: it.id, lotId: i.lotId, locationId: order.sourceLocationId, kind: 'EXTRA', quantity: i.quantity, unitCost: i.unitCost, value: i.value, reason: adj.reason },
            });
          }
          await tx.productionItem.update({ where: { id: it.id }, data: { consumedQuantity: { increment: extra } } });
        } else {
          let toReturn = D(adj.returnedQuantity!);
          if (toReturn.gt(it.consumedQuantity)) throw new BadRequestException(`« ${info.name} » : reste rendu supérieur à la quantité consommée`);
          await tx.productionItem.update({ where: { id: it.id }, data: { consumedQuantity: { decrement: toReturn } } });
          // Le reste retourne dans les lots consommés, du dernier sorti au premier.
          const consumptions = await tx.productionConsumption.findMany({ where: { orderId: id, itemId: it.id }, orderBy: { createdAt: 'desc' } });
          const netByLot = new Map<string, { net: Prisma.Decimal; unitCost: Prisma.Decimal; locationId: string }>();
          for (const c of [...consumptions].reverse()) {
            const e = netByLot.get(c.lotId) ?? { net: D(0), unitCost: D(c.unitCost), locationId: c.locationId };
            e.net = e.net.add(c.quantity);
            netByLot.set(c.lotId, e);
          }
          for (const lotId of [...new Set(consumptions.map((c) => c.lotId))]) {
            if (toReturn.lte(0)) break;
            const e = netByLot.get(lotId)!;
            if (e.net.lte(0)) continue;
            const back = Prisma.Decimal.min(e.net, toReturn);
            const lot = await tx.stockLot.findUniqueOrThrow({ where: { id: lotId } });
            await this.engine.addToLot(tx, this.ctx(me, order, e.locationId, 'CONSUMPTION', adj.reason), lot, back);
            await tx.productionConsumption.create({
              data: { orderId: id, itemId: it.id, lotId, locationId: e.locationId, kind: 'RETURN', quantity: back.neg(), unitCost: e.unitCost, value: back.mul(e.unitCost).neg().toDecimalPlaces(2), reason: adj.reason },
            });
            toReturn = toReturn.sub(back);
          }
        }
      }

      // Coût réel = valeur nette des lots consommés ; coût unitaire sur la quantité bonne (décision J).
      const agg = await tx.productionConsumption.aggregate({ where: { orderId: id }, _sum: { value: true } });
      const realCost = D(agg._sum.value ?? 0).toDecimalPlaces(2);
      const unitCost = produced.gt(0) ? realCost.div(produced).toDecimalPlaces(4) : null;
      const now = new Date();

      if (produced.gt(0)) {
        const version = await tx.recipeVersion.findUniqueOrThrow({ where: { id: order.recipeVersionId } });
        // Péremption du produit fini = date de fin + durée de conservation de la recette (décision F).
        const expiry = version.shelfLifeDays !== null ? dateOnly(new Date(now.getTime() + version.shelfLifeDays * 86_400_000).toISOString()) : null;
        const lot = await this.engine.createLot(tx, {
          companyId: me.companyId,
          item: { rawMaterialId: null, productId: order.productId },
          origin: 'PRODUCTION',
          unitCost: unitCost!,
          userId: me.userId,
          productionDate: dateOnly(now.toISOString()),
          expiryDate: expiry,
        });
        await this.engine.addToLot(tx, this.ctx(me, order, order.destLocationId, 'PRODUCTION'), lot, produced);
        await tx.productionOutput.create({ data: { orderId: id, lotId: lot.id, locationId: order.destLocationId, quantity: produced, unitCost: unitCost! } });
        for (const hook of completionHooks) {
          await hook(tx, me, { orderId: id, establishmentId: order.establishmentId, productId: order.productId, lot, locationId: order.destLocationId, quantity: produced });
        }
      }
      if (produced.lt(planned)) {
        const gap = planned.sub(produced);
        await tx.productionLoss.create({
          data: {
            orderId: id,
            stage: 'COMPLETION',
            quantity: gap,
            cause: dto.lossCause!,
            reason: dto.lossReason!,
            // Valeur indicative : le coût est déjà absorbé par les produits bons.
            value: unitCost ? gap.mul(unitCost).toDecimalPlaces(2) : realCost,
            createdById: me.userId,
          },
        });
      }
      await tx.productionOrder.update({
        where: { id },
        data: { status: 'COMPLETED', producedQuantity: produced, realCost, unitCost, overReason: dto.overReason ?? null, completedById: me.userId, completedAt: now },
      });
      await this.audit.record(
        {
          action: 'PRODUCTION_COMPLETED',
          entityType: 'ProductionOrder',
          entityId: id,
          establishmentId: order.establishmentId,
          newValues: { planned: order.plannedQuantity, produced: dto.producedQuantity, realCost, unitCost, adjustments: dto.adjustments?.length ?? 0, lossCause: dto.lossCause ?? null },
        },
        tx,
      );
    });
    return this.get(me, id);
  }

  // --- Contrôle qualité (décision E) -------------------------------------------------

  async control(me: AuthUser, id: string, dto: ControlProductionDto) {
    await this.prisma.$transaction(async (tx) => {
      const { order, est } = await this.locked(tx, me, id, ['COMPLETED'], 'inventory.validate');
      if (order.completedById === me.userId) throw new ForbiddenException('Le contrôle doit être fait par une autre personne que celle qui a terminé la production');
      if (dto.nonConformQuantity) {
        if (!dto.cause || !dto.reason) throw new BadRequestException('Non-conformité : cause et motif obligatoires');
        if (dto.cause === 'TRANSIT') throw new BadRequestException('Cause « transit » réservée aux transferts');
        const output = await tx.productionOutput.findFirst({ where: { orderId: id } });
        if (!output) throw new BadRequestException('Aucun produit fini à contrôler');
        const qty = D(dto.nonConformQuantity);
        if (qty.gt(output.quantity)) throw new BadRequestException('Quantité non conforme supérieure à la quantité produite');
        const loss = await tx.stockLoss.create({
          data: {
            companyId: me.companyId,
            establishmentId: order.establishmentId,
            locationId: output.locationId,
            number: await nextNumber(tx, me.companyId, 'STOCK_LOSS', est),
            productId: order.productId,
            lotId: output.lotId,
            quantity: qty,
            cause: dto.cause,
            comment: `${order.number} — contrôle : ${dto.reason}`,
            estimatedValue: 0n,
            declaredById: me.userId,
          },
        });
        const issued = await this.engine.issue(
          tx,
          { companyId: me.companyId, establishmentId: order.establishmentId, locationId: output.locationId, type: 'LOSS', originType: 'StockLoss', originId: loss.id, reason: dto.reason, userId: me.userId },
          { rawMaterialId: null, productId: order.productId },
          qty,
          { lotId: output.lotId, allowExpired: true },
        );
        const value = issued.reduce((s, i) => s.add(i.value), D(0)).toDecimalPlaces(2);
        await tx.stockLoss.update({ where: { id: loss.id }, data: { estimatedValue: BigInt(value.toDecimalPlaces(0).toFixed(0)) } });
        await tx.productionLoss.create({
          data: { orderId: id, stage: 'CONTROL', quantity: qty, cause: dto.cause, reason: dto.reason, value, stockLossId: loss.id, createdById: me.userId },
        });
      }
      await tx.productionOrder.update({ where: { id }, data: { status: 'CONTROLLED', controlledById: me.userId, controlledAt: new Date(), controlNote: dto.note ?? null } });
      await this.audit.record(
        { action: 'PRODUCTION_CONTROLLED', entityType: 'ProductionOrder', entityId: id, establishmentId: order.establishmentId, newValues: { nonConform: dto.nonConformQuantity ?? 0, cause: dto.cause ?? null } },
        tx,
      );
    });
    return this.get(me, id);
  }

  /** Annulation tant que rien n'est consommé ; les réservations sont libérées. */
  async cancel(me: AuthUser, id: string, dto: CancelProductionDto) {
    await this.prisma.$transaction(async (tx) => {
      const { order } = await this.locked(tx, me, id, ['PLANNED', 'VALIDATED']);
      await this.lockBalances(tx, id, order.sourceLocationId, order.items);
      const released = await this.release(tx, id);
      await tx.productionOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: me.userId, cancelledAt: new Date(), cancelReason: dto.reason } });
      await this.audit.record(
        { action: 'PRODUCTION_CANCELLED', entityType: 'ProductionOrder', entityId: id, establishmentId: order.establishmentId, reason: dto.reason, newValues: { reservationsReleased: released } },
        tx,
      );
    });
    return this.get(me, id);
  }

  // --- Traçabilité ---------------------------------------------------------------------

  /**
   * Traçabilité d'un lot : en amont (fournisseur et réception, ou production et
   * lots de matières consommés, récursivement) et en aval (productions qui l'ont
   * consommé et lots produits, récursivement).
   */
  async trace(me: AuthUser, lotId: string) {
    const lot = await this.prisma.stockLot.findFirst({ where: { id: lotId, companyId: me.companyId } });
    if (!lot) throw new NotFoundException('Lot introuvable');
    const readable = readableEstablishments(me, 'stock.view');
    const present = await this.prisma.stockBalance.count({ where: { lotId, establishmentId: { in: readable } } });
    const producedHere = await this.prisma.productionOutput.count({ where: { lotId, order: { establishmentId: { in: readable } } } });
    if (!present && !producedHere && !me.access.global.has('stock.view')) throw new ForbiddenException('Ce lot n’est pas passé par vos établissements');

    const describe = async (id: string) => {
      const l = await this.prisma.stockLot.findUniqueOrThrow({ where: { id } });
      const [withItem] = await attachItems(this.prisma, [l]);
      const supplier = l.supplierId ? await this.prisma.supplier.findUnique({ where: { id: l.supplierId }, select: { id: true, name: true } }) : null;
      const receipt = l.receiptItemId
        ? await this.prisma.goodsReceiptItem.findUnique({ where: { id: l.receiptItemId }, select: { receipt: { select: { id: true, number: true, receivedAt: true } } } })
        : null;
      return {
        lotId: l.id,
        lotNumber: l.lotNumber,
        origin: l.origin,
        item: withItem.item,
        brand: l.brand,
        supplierLotRef: l.supplierLotRef,
        expiryDate: l.expiryDate,
        unitCost: l.unitCost,
        supplier,
        receipt: receipt?.receipt ?? null,
      };
    };

    const upstream = async (id: string, depth: number): Promise<unknown> => {
      const node = await describe(id);
      if (depth >= 6) return { ...node, inputs: [] };
      const output = await this.prisma.productionOutput.findUnique({ where: { lotId: id }, include: { order: { select: { id: true, number: true, completedAt: true } } } });
      if (!output) return { ...node, production: null, inputs: [] };
      const consumed = await this.prisma.productionConsumption.groupBy({ by: ['lotId'], where: { orderId: output.orderId }, _sum: { quantity: true } });
      const inputs = [];
      for (const c of consumed.filter((x) => D(x._sum.quantity ?? 0).gt(0))) {
        inputs.push({ quantity: c._sum.quantity, lot: await upstream(c.lotId, depth + 1) });
      }
      return { ...node, production: output.order, inputs };
    };

    const downstream = async (id: string, depth: number): Promise<unknown[]> => {
      if (depth >= 6) return [];
      const uses = await this.prisma.productionConsumption.groupBy({ by: ['orderId'], where: { lotId: id }, _sum: { quantity: true } });
      const result = [];
      for (const u of uses.filter((x) => D(x._sum.quantity ?? 0).gt(0))) {
        const order = await this.prisma.productionOrder.findUniqueOrThrow({ where: { id: u.orderId }, select: { id: true, number: true, status: true, completedAt: true } });
        const outputs = await this.prisma.productionOutput.findMany({ where: { orderId: u.orderId } });
        const lots = [];
        for (const o of outputs) lots.push({ ...(await describe(o.lotId)), usedBy: await downstream(o.lotId, depth + 1) });
        result.push({ production: order, quantityUsed: u._sum.quantity, outputs: lots });
      }
      return result;
    };

    return { lot: await describe(lotId), upstream: await upstream(lotId, 0), downstream: await downstream(lotId, 0) };
  }

  async findLot(me: AuthUser, lotNumber: string) {
    const lot = await this.prisma.stockLot.findFirst({ where: { companyId: me.companyId, lotNumber: lotNumber.trim().toUpperCase() } });
    if (!lot) throw new NotFoundException('Lot introuvable');
    return this.trace(me, lot.id);
  }
}

class LotQuery {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(40) lotNumber: string;
}

@ApiTags('Production')
@ApiBearerAuth()
@Controller()
export class ProductionController {
  constructor(private readonly service: ProductionService) {}

  // « Voir la production » (tous les ordres) OU « Voir les stocks » (ordres validés et suivants) :
  // contrôle « l'un ou l'autre » fait par le service (décision H).
  @Get('production-orders')
  list(@CurrentUser() me: AuthUser, @Query() q: ProductionQuery) {
    return this.service.list(me, q);
  }

  @Get('production-orders/:id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post('production-orders')
  @RequirePermissions('production.manage')
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateProductionDto) {
    return this.service.create(me, dto);
  }

  @Patch('production-orders/:id')
  @RequirePermissions('production.manage')
  @AnyEstablishmentScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductionDto) {
    return this.service.update(me, id, dto);
  }

  @Post('production-orders/:id/validate')
  @RequirePermissions('production.manage')
  @AnyEstablishmentScope()
  validate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.validate(me, id);
  }

  @Post('production-orders/:id/start')
  @RequirePermissions('production.manage')
  @AnyEstablishmentScope()
  start(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.start(me, id);
  }

  @Post('production-orders/:id/complete')
  @RequirePermissions('production.manage')
  @AnyEstablishmentScope()
  complete(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteProductionDto) {
    return this.service.complete(me, id, dto);
  }

  // Contrôle qualité par un responsable (« Valider un inventaire »), autre que le producteur (décision E).
  @Post('production-orders/:id/control')
  @RequirePermissions('inventory.validate')
  @AnyEstablishmentScope()
  control(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ControlProductionDto) {
    return this.service.control(me, id, dto);
  }

  @Post('production-orders/:id/cancel')
  @RequirePermissions('production.manage')
  @AnyEstablishmentScope()
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelProductionDto) {
    return this.service.cancel(me, id, dto);
  }

  @Get('traceability/lots/:id')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  trace(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.trace(me, id);
  }

  @Get('traceability')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  findLot(@CurrentUser() me: AuthUser, @Query() q: LotQuery) {
    return this.service.findLot(me, q.lotNumber);
  }
}
