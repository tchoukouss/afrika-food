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
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LossCause, Prisma, RestaurantOrder, RestaurantOrderItem, RestaurantOrderMode, RestaurantOrderStatus, RestaurantPrintJob } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { uniqueViolation } from '../sales/common';
import { SequenceService } from '../sequences/sequence.service';
import { D, idempotent, userNames } from '../stock/common';
import { StockEngine } from '../stock/engine';
import { assertAny, canAny, currentPrices, emptyToNull, lockOrders, nextRestaurantNumber, QTY, readableWith, restaurantEstablishment, roundXof, trim } from './common';
import { RestaurantConsumption } from './consumption';
import { RestaurantPrinting } from './printing';

export class CreateOrderDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsEnum(RestaurantOrderMode) mode: RestaurantOrderMode;
  @IsOptional() @IsUUID() tableId?: string;
  @IsOptional() @IsUUID() reservationId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(500) covers?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(120) customerName?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(30) customerPhone?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(300) deliveryAddress?: string | null;
  @IsOptional() @IsDateString() expectedAt?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) note?: string | null;
  @IsOptional() @IsBoolean() urgent?: boolean;
}

export class SupplementDto {
  @IsUUID() productId: string;
  @IsNumber(QTY) @Min(0.0001) @Max(1000) quantity: number;
}

export class NewItemDto {
  @IsUUID() productId: string;
  @IsNumber(QTY) @Min(0.0001) @Max(1000) quantity: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(300) note?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) options?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => SupplementDto) supplements?: SupplementDto[];
}

export class AddItemsDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => NewItemDto) items: NewItemDto[];
}

export class SendDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
}

export class CancelItemDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsNumber(QTY) @Min(0.0001) @Max(1000) quantity: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
  /** Obligatoire si l'article est déjà en préparation, prêt ou servi (perte). */
  @IsOptional() @IsEnum(LossCause) lossCause?: LossCause;
}

export class TransferDto {
  @IsUUID() tableId: string;
}

export class MoveItemsDto {
  @IsUUID() targetOrderId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) itemIds: string[];
}

export class MergeDto {
  @IsUUID() sourceOrderId: string;
}

export class CancelOrderDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class OrderQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsEnum(RestaurantOrderStatus) status?: RestaurantOrderStatus;
  @IsOptional() @IsEnum(RestaurantOrderMode) mode?: RestaurantOrderMode;
}

/** Montant TTC d'un article (quantité annulée déduite). */
export const itemAmount = (i: Pick<RestaurantOrderItem, 'unitPrice' | 'quantity' | 'cancelledQuantity'>) =>
  roundXof(D(i.unitPrice.toString()).mul(D(i.quantity).sub(i.cancelledQuantity)));

/** Article facturable : envoyé et pas entièrement annulé. */
export const isBillable = (i: Pick<RestaurantOrderItem, 'status'>) => ['NEW', 'IN_PREPARATION', 'READY', 'SERVED'].includes(i.status);

const ACTIVE_ITEM = { status: { notIn: ['REMOVED', 'CANCELLED'] } } satisfies Prisma.RestaurantOrderItemWhereInput;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
    private readonly sequences: SequenceService,
    private readonly consumption: RestaurantConsumption,
    private readonly printing: RestaurantPrinting,
  ) {}

  // --- Consultation ---------------------------------------------------------------

  async list(me: AuthUser, q: OrderQuery) {
    const ests = readableWith(me, ['restaurant.orders', 'restaurant.kitchen'], q.establishmentId);
    const rows = await this.prisma.restaurantOrder.findMany({
      where: { companyId: me.companyId, establishmentId: { in: ests }, status: q.status, mode: q.mode },
      include: { items: true, bills: { select: { status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const [tables, names] = await Promise.all([
      this.prisma.restaurantTable.findMany({ where: { id: { in: rows.map((r) => r.tableId).filter((x): x is string => !!x) } }, select: { id: true, code: true } }),
      userNames(this.prisma, me.companyId, rows.map((r) => r.waiterId)),
    ]);
    return rows.map(({ items, bills, ...o }) => ({
      ...o,
      table: tables.find((t) => t.id === o.tableId) ?? null,
      waiter: names.get(o.waiterId) ?? null,
      total: items.filter((i) => !['REMOVED', 'CANCELLED'].includes(i.status)).reduce((s, i) => s + itemAmount(i), 0n),
      counts: {
        draft: items.filter((i) => i.status === 'DRAFT').length,
        inKitchen: items.filter((i) => ['NEW', 'IN_PREPARATION'].includes(i.status)).length,
        ready: items.filter((i) => i.status === 'READY').length,
      },
      openBills: bills.filter((b) => b.status === 'OPEN').length,
    }));
  }

  private async findOrder(db: Tx | PrismaService, me: AuthUser, id: string) {
    const o = await db.restaurantOrder.findFirst({ where: { id, companyId: me.companyId } });
    if (!o || !canAny(me, o.establishmentId, ['restaurant.orders', 'restaurant.kitchen'])) throw new NotFoundException('Commande introuvable');
    return o;
  }

  async get(me: AuthUser, id: string) {
    await this.findOrder(this.prisma, me, id);
    const o = await this.prisma.restaurantOrder.findUniqueOrThrow({
      where: { id },
      include: {
        items: { orderBy: { position: 'asc' } },
        kitchenTickets: { orderBy: { createdAt: 'asc' } },
        bills: { orderBy: { createdAt: 'asc' }, include: { items: true } },
      },
    });
    const itemIds = o.items.map((i) => i.id);
    const [table, cancellations, stations, saleNumbers, printJobs] = await Promise.all([
      o.tableId ? this.prisma.restaurantTable.findUnique({ where: { id: o.tableId }, select: { id: true, code: true, capacity: true } }) : null,
      this.prisma.restaurantItemCancellation.findMany({ where: { itemId: { in: itemIds } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.restaurantStation.findMany({ where: { establishmentId: o.establishmentId }, select: { id: true, name: true, kind: true } }),
      this.prisma.sale.findMany({ where: { id: { in: o.bills.map((b) => b.saleId).filter((x): x is string => !!x) } }, select: { id: true, number: true, status: true } }),
      this.prisma.restaurantPrintJob.findMany({
        where: { OR: [{ kitchenTicketId: { in: o.kitchenTickets.map((t) => t.id) } }, { billId: { in: o.bills.map((b) => b.id) } }] },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const names = await userNames(this.prisma, me.companyId, [
      o.waiterId,
      o.cancelledById,
      ...o.items.flatMap((i) => [i.createdById, i.sentById, i.statusChangedById]),
      ...cancellations.map((c) => c.createdById),
    ]);
    const name = (uid: string | null) => (uid ? names.get(uid) ?? null : null);
    const active = o.items.filter((i) => !['REMOVED', 'CANCELLED'].includes(i.status));
    const paidBills = new Set(o.bills.filter((b) => b.status === 'PAID').map((b) => b.id));
    return {
      ...o,
      table,
      waiter: name(o.waiterId),
      cancelledBy: name(o.cancelledById),
      items: o.items.map((i) => ({
        ...i,
        amount: itemAmount(i),
        station: stations.find((s) => s.id === i.stationId) ?? null,
        createdBy: name(i.createdById),
        sentBy: name(i.sentById),
        statusChangedBy: name(i.statusChangedById),
        paid: !!i.billId && paidBills.has(i.billId),
      })),
      kitchenTickets: o.kitchenTickets.map((t) => ({ ...t, station: stations.find((s) => s.id === t.stationId) ?? null })),
      bills: o.bills.map((b) => ({ ...b, sale: saleNumbers.find((s) => s.id === b.saleId) ?? null })),
      cancellations: cancellations.map((c) => ({ ...c, createdBy: name(c.createdById) })),
      printJobs,
      totals: {
        ordered: active.reduce((s, i) => s + itemAmount(i), 0n),
        paid: active.filter((i) => i.billId && paidBills.has(i.billId)).reduce((s, i) => s + itemAmount(i), 0n),
        toBill: active.filter((i) => isBillable(i) && !i.billId).reduce((s, i) => s + itemAmount(i), 0n),
      },
      rights: {
        edit: me.access.can('restaurant.orders_edit', o.establishmentId),
        order: me.access.can('restaurant.orders', o.establishmentId),
        discount: me.access.can('sales.discount', o.establishmentId),
        pay: me.access.can('sales.create', o.establishmentId),
      },
    };
  }

  // --- Ouverture --------------------------------------------------------------------

  create(me: AuthUser, dto: CreateOrderDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.restaurantOrder
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((o) => o && { id: o.id, ownerId: o.waiterId }),
      () => this.doCreate(me, dto),
      (id) => this.get(me, id),
    );
  }

  private async doCreate(me: AuthUser, dto: CreateOrderDto) {
    const est = await restaurantEstablishment(this.prisma, me, dto.establishmentId, 'restaurant.orders');
    if ((dto.mode === 'TABLE') !== !!dto.tableId) throw new BadRequestException(dto.mode === 'TABLE' ? 'Choisissez une table' : 'Une table ne s’indique que pour une commande sur place');
    if ((dto.mode === 'PHONE' || dto.mode === 'DELIVERY') && !dto.customerPhone) throw new BadRequestException('Téléphone du client obligatoire');
    if (dto.mode === 'DELIVERY' && !dto.deliveryAddress) throw new BadRequestException('Adresse de livraison obligatoire');
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        if (dto.tableId) {
          await tx.$queryRaw`SELECT id FROM restaurant_tables WHERE id = ${dto.tableId}::uuid FOR UPDATE`;
          const table = await tx.restaurantTable.findFirst({ where: { id: dto.tableId, establishmentId: est.id, isActive: true } });
          if (!table) throw new BadRequestException('Table invalide pour cet établissement');
          if (table.state === 'OUT_OF_SERVICE') throw new ConflictException(`Table ${table.code} hors service`);
          if (table.state === 'CLEANING') throw new ConflictException(`Table ${table.code} en nettoyage : marquez-la libre avant de l’ouvrir`);
          if (await tx.restaurantOrder.findFirst({ where: { tableId: table.id, status: 'OPEN' } })) throw this.busyTable(table.code);
        }
        if (dto.reservationId) {
          const r = await tx.restaurantReservation.findFirst({ where: { id: dto.reservationId, establishmentId: est.id, status: 'CONFIRMED' } });
          if (!r) throw new BadRequestException('Réservation invalide ou déjà traitée');
          await tx.restaurantReservation.update({ where: { id: r.id }, data: { status: 'SEATED', statusChangedAt: new Date() } });
        }
        const order = await tx.restaurantOrder.create({
          data: {
            companyId: me.companyId,
            establishmentId: est.id,
            number: await this.sequences.next(tx, { companyId: me.companyId, docType: 'RESTAURANT_ORDER', establishmentId: est.id, establishmentCode: est.code }),
            clientRequestId: dto.clientRequestId ?? null,
            mode: dto.mode,
            tableId: dto.tableId ?? null,
            reservationId: dto.reservationId ?? null,
            covers: dto.covers ?? null,
            customerName: dto.customerName ?? null,
            customerPhone: dto.customerPhone ?? null,
            deliveryAddress: dto.deliveryAddress ?? null,
            expectedAt: dto.expectedAt ? new Date(dto.expectedAt) : null,
            note: dto.note ?? null,
            urgent: dto.urgent ?? false,
            waiterId: me.userId,
          },
        });
        await this.audit.record(
          { action: 'RESTAURANT_ORDER_OPENED', entityType: 'RestaurantOrder', entityId: order.id, establishmentId: est.id, newValues: { number: order.number, mode: order.mode, tableId: order.tableId, covers: order.covers } },
          tx,
        );
        return order.id;
      });
    } catch (e) {
      // Deux ouvertures simultanées de la même table : l'index unique partiel n'en laisse passer qu'une.
      if (uniqueViolation(e, 'one_open_per_table')) throw this.busyTable();
      throw e;
    }
    return this.get(me, id);
  }

  private busyTable(code?: string) {
    return new ConflictException(`Une commande est déjà ouverte sur ${code ? `la table ${code}` : 'cette table'}`);
  }

  /** Verrouille la commande et vérifie qu'elle est ouverte et accessible (décision R24). */
  private async lockOpen(tx: Tx, me: AuthUser, id: string, ...permissions: string[]) {
    await lockOrders(tx, [id]);
    const o = await this.findOrder(tx, me, id);
    assertAny(me, o.establishmentId, ...(permissions.length ? permissions : ['restaurant.orders']));
    if (o.status !== 'OPEN') throw new ConflictException(`Commande ${o.number} ${o.status === 'PAID' ? 'déjà soldée' : o.status === 'MERGED' ? 'regroupée dans une autre' : 'annulée'}`);
    return o;
  }

  // --- Saisie ---------------------------------------------------------------------------

  /** Ajoute des articles en brouillon, au prix en vigueur (figé, décision R7). */
  async addItems(me: AuthUser, id: string, dto: AddItemsDto) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpen(tx, me, id);
      if (dto.clientRequestId && (await tx.restaurantOrderItem.findFirst({ where: { orderId: id, requestId: dto.clientRequestId } }))) return; // double envoi
      const productIds = [...new Set(dto.items.flatMap((i) => [i.productId, ...(i.supplements ?? []).map((s) => s.productId)]))];
      const [carte, products, prices, unavailable, options] = await Promise.all([
        tx.restaurantMenuItem.findMany({ where: { establishmentId: order.establishmentId, productId: { in: productIds }, isActive: true } }),
        tx.product.findMany({ where: { id: { in: productIds }, companyId: me.companyId } }),
        currentPrices(tx, productIds, order.establishmentId),
        tx.productAvailability.findMany({ where: { productId: { in: productIds }, establishmentId: order.establishmentId, isAvailable: false } }),
        tx.restaurantOption.findMany({ where: { establishmentId: order.establishmentId, productId: { in: productIds }, isActive: true } }),
      ]);
      const check = (productId: string, supplement: boolean) => {
        const p = products.find((x) => x.id === productId);
        const entry = carte.find((m) => m.productId === productId);
        if (!p || !entry) throw new BadRequestException('Produit absent de la carte du restaurant');
        if (!p.isActive) throw new BadRequestException(`« ${p.name} » est archivé`);
        if (unavailable.some((u) => u.productId === p.id)) throw new ConflictException(`« ${p.name} » n’est pas disponible`);
        if (supplement && !entry.isSupplement) throw new BadRequestException(`« ${p.name} » n’est pas un supplément`);
        const price = prices.get(p.id);
        if (price === undefined) throw new ConflictException(`« ${p.name} » n’a pas de prix de vente`);
        return { p, entry, price };
      };
      const last = await tx.restaurantOrderItem.aggregate({ where: { orderId: id }, _max: { position: true } });
      let position = (last._max.position ?? -1) + 1;
      const base = (productId: string, quantity: number, supplement: boolean) => {
        const { p, entry, price } = check(productId, supplement);
        return {
          orderId: id,
          position: position++,
          requestId: dto.clientRequestId ?? null,
          productId: p.id,
          productCode: p.code,
          productName: p.name,
          isMenu: p.type === 'MENU',
          unitPrice: price,
          taxRate: p.taxRate,
          quantity: D(quantity),
          preparation: entry.preparation,
          stationId: entry.stationId,
          createdById: me.userId,
        };
      };
      for (const it of dto.items) {
        const chosen = [...new Set(it.options ?? [])];
        const allowed = options.filter((o) => o.productId === it.productId).map((o) => o.label);
        const bad = chosen.find((o) => !allowed.includes(o));
        if (bad) throw new BadRequestException(`Option « ${bad} » inconnue pour ce produit`);
        const parent = await tx.restaurantOrderItem.create({ data: { ...base(it.productId, it.quantity, false), note: it.note ?? null, options: chosen } });
        for (const s of it.supplements ?? []) {
          await tx.restaurantOrderItem.create({ data: { ...base(s.productId, s.quantity, true), parentItemId: parent.id } });
        }
      }
    });
    return this.get(me, id);
  }

  /** Retire un brouillon (et ses suppléments) : conservé avec le statut « retiré » (décision R13). */
  async removeItem(me: AuthUser, id: string, itemId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOpen(tx, me, id);
      const item = await tx.restaurantOrderItem.findFirst({ where: { id: itemId, orderId: id } });
      if (!item) throw new NotFoundException('Article introuvable');
      if (item.status === 'REMOVED') return;
      if (item.status !== 'DRAFT') throw new ConflictException('Article déjà envoyé : utilisez l’annulation (motif et droit requis)');
      await tx.restaurantOrderItem.updateMany({
        where: { OR: [{ id: itemId }, { parentItemId: itemId }], status: 'DRAFT' },
        data: { status: 'REMOVED', statusChangedAt: new Date(), statusChangedById: me.userId },
      });
    });
    return this.get(me, id);
  }

  // --- Envoi en cuisine / au bar ----------------------------------------------------------

  /**
   * Envoie tous les brouillons, en une transaction : un bon par poste, sortie
   * du stock (décision R11), statut « reçue » (ou « prête » sans poste).
   * Stock insuffisant : rien n'est envoyé.
   */
  async send(me: AuthUser, id: string, dto: SendDto) {
    const jobs = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpen(tx, me, id);
      if (dto.clientRequestId && (await tx.restaurantKitchenTicket.findFirst({ where: { orderId: id, requestId: dto.clientRequestId } }))) return []; // double envoi
      const drafts = await tx.restaurantOrderItem.findMany({ where: { orderId: id, status: 'DRAFT' }, orderBy: { position: 'asc' } });
      if (!drafts.length) throw new BadRequestException('Aucun article à envoyer');
      const est = await tx.establishment.findUniqueOrThrow({ where: { id: order.establishmentId } });
      const stations = await tx.restaurantStation.findMany({ where: { establishmentId: est.id } });
      // Un supplément suit le poste de son article quand ils partent ensemble.
      const stationOf = (i: RestaurantOrderItem) => (i.parentItemId ? drafts.find((d) => d.id === i.parentItemId)?.stationId ?? i.stationId : i.stationId);
      const defaultLocation = await this.engine.ensureDefaultLocation(tx, me.companyId, est.id);
      const locationOf = (stationId: string | null) => stations.find((s) => s.id === stationId)?.stockLocationId ?? defaultLocation.id;

      const costs = await this.consumption.consume(tx, me, est.id, drafts.map((item) => ({ item, locationId: locationOf(stationOf(item)) })));

      const now = new Date();
      const created: RestaurantPrintJob[] = [];
      const groups = [...new Set(drafts.map(stationOf))];
      const tickets: string[] = [];
      for (const stationId of groups) {
        const ticket = await tx.restaurantKitchenTicket.create({
          data: {
            companyId: me.companyId,
            establishmentId: est.id,
            orderId: id,
            stationId,
            number: await nextRestaurantNumber(tx, me.companyId, 'KITCHEN_TICKET', est),
            requestId: dto.clientRequestId ?? null,
            urgent: dto.urgent ?? order.urgent,
            sentById: me.userId,
          },
        });
        tickets.push(ticket.number);
        for (const item of drafts.filter((d) => stationOf(d) === stationId)) {
          await tx.restaurantOrderItem.update({
            where: { id: item.id },
            data: {
              status: stationId ? 'NEW' : 'READY',
              kitchenTicketId: ticket.id,
              sentAt: now,
              sentById: me.userId,
              statusChangedAt: now,
              statusChangedById: me.userId,
              costTotal: costs.get(item.id) ?? D(0),
            },
          });
        }
        const station = stations.find((s) => s.id === stationId) ?? null;
        const job = await this.printing.createJob(tx, me, { establishmentId: est.id, kind: 'KITCHEN', kitchenTicketId: ticket.id, stationId }, station);
        if (job) created.push(job);
      }
      await this.audit.record(
        {
          action: 'RESTAURANT_ORDER_SENT',
          entityType: 'RestaurantOrder',
          entityId: id,
          establishmentId: est.id,
          newValues: { number: order.number, tickets, items: drafts.map((d) => ({ product: d.productName, quantity: d.quantity, cost: costs.get(d.id) })) },
        },
        tx,
      );
      return created;
    });
    for (const job of jobs.filter((j) => j.status === 'PENDING')) await this.printing.deliver(job.id);
    return this.get(me, id);
  }

  // --- Annulation d'un article envoyé ---------------------------------------------------

  /** Avant préparation : ingrédients rendus ; après : perte déclarée (décision R14). */
  cancelItem(me: AuthUser, id: string, itemId: string, dto: CancelItemDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.restaurantItemCancellation
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((c) => c && { id: c.itemId, ownerId: c.createdById }),
      () => this.doCancelItem(me, id, itemId, dto),
      () => this.get(me, id),
    );
  }

  private async doCancelItem(me: AuthUser, id: string, itemId: string, dto: CancelItemDto) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpen(tx, me, id, 'restaurant.orders_edit');
      const item = await tx.restaurantOrderItem.findFirst({ where: { id: itemId, orderId: id } });
      if (!item) throw new NotFoundException('Article introuvable');
      if (item.status === 'DRAFT') throw new BadRequestException('Article pas encore envoyé : retirez-le simplement');
      if (item.status === 'REMOVED' || item.status === 'CANCELLED') throw new ConflictException('Article déjà retiré ou annulé');
      if (item.billId) {
        const bill = await tx.restaurantBill.findUniqueOrThrow({ where: { id: item.billId } });
        throw new ConflictException(
          bill.status === 'PAID' ? 'Article déjà payé : le remboursement se fait par la caisse' : `Article sur l’addition ${bill.number} : annulez d’abord l’addition`,
        );
      }
      const quantity = D(dto.quantity);
      const open = D(item.quantity).sub(item.cancelledQuantity);
      if (quantity.gt(open)) throw new ConflictException(`Au plus ${open.toString()} à annuler`);
      const outcome = item.status === 'NEW' ? 'RESTOCK' : 'LOSS';
      if (outcome === 'LOSS' && !dto.lossCause) throw new BadRequestException('Article déjà en préparation : indiquez la cause de la perte');
      const est = await tx.establishment.findUniqueOrThrow({ where: { id: order.establishmentId } });
      const cancellation = await tx.restaurantItemCancellation.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          clientRequestId: dto.clientRequestId ?? null,
          itemId,
          quantity,
          outcome,
          lossCause: outcome === 'LOSS' ? dto.lossCause! : null,
          reason: dto.reason,
          statusAtCancel: item.status,
          createdById: me.userId,
        },
      });
      const value = await this.consumption.cancel(tx, me, est, item, { ...cancellation, quantity, lossCause: cancellation.lossCause }, order.number);
      const full = quantity.eq(open);
      await tx.restaurantOrderItem.update({
        where: { id: itemId },
        data: {
          cancelledQuantity: { increment: quantity },
          costTotal: D(item.costTotal).sub(value).toDecimalPlaces(2),
          ...(full ? { status: 'CANCELLED', statusChangedAt: new Date(), statusChangedById: me.userId } : {}),
        },
      });
      await this.audit.record(
        {
          action: 'RESTAURANT_ITEM_CANCELLED',
          entityType: 'RestaurantOrder',
          entityId: id,
          establishmentId: est.id,
          newValues: { number: order.number, product: item.productName, quantity, status: item.status, outcome, lossCause: cancellation.lossCause, value },
          reason: dto.reason,
        },
        tx,
      );
    });
    return this.get(me, id);
  }

  // --- Transferts et regroupement ----------------------------------------------------

  /** Change la commande de table : table libre ou réservée uniquement (décision R15). */
  async transfer(me: AuthUser, id: string, dto: TransferDto) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const order = await this.lockOpen(tx, me, id);
        if (order.mode !== 'TABLE') throw new BadRequestException('Seule une commande sur place change de table');
        if (order.tableId === dto.tableId) return;
        await tx.$queryRaw`SELECT id FROM restaurant_tables WHERE id = ${dto.tableId}::uuid FOR UPDATE`;
        const table = await tx.restaurantTable.findFirst({ where: { id: dto.tableId, establishmentId: order.establishmentId, isActive: true } });
        if (!table) throw new BadRequestException('Table invalide pour cet établissement');
        if (table.state !== 'AVAILABLE') throw new ConflictException(`Table ${table.code} ${table.state === 'CLEANING' ? 'en nettoyage' : 'hors service'}`);
        if (await tx.restaurantOrder.findFirst({ where: { tableId: table.id, status: 'OPEN' } })) throw this.busyTable(table.code);
        const from = order.tableId ? await tx.restaurantTable.findUnique({ where: { id: order.tableId } }) : null;
        await tx.restaurantOrder.update({ where: { id }, data: { tableId: table.id } });
        await this.audit.record(
          { action: 'RESTAURANT_ORDER_TRANSFERRED', entityType: 'RestaurantOrder', entityId: id, establishmentId: order.establishmentId, oldValues: { table: from?.code }, newValues: { number: order.number, table: table.code } },
          tx,
        );
      });
    } catch (e) {
      if (uniqueViolation(e, 'one_open_per_table')) throw this.busyTable();
      throw e;
    }
    return this.get(me, id);
  }

  /** Déplace des articles non facturés vers une autre commande ouverte (avec leurs suppléments). */
  async moveItems(me: AuthUser, id: string, dto: MoveItemsDto) {
    if (dto.targetOrderId === id) throw new BadRequestException('Choisissez une autre commande');
    await this.prisma.$transaction(async (tx) => {
      await lockOrders(tx, [id, dto.targetOrderId]);
      const source = await this.lockOpen(tx, me, id);
      const target = await this.lockOpen(tx, me, dto.targetOrderId);
      if (target.establishmentId !== source.establishmentId) throw new BadRequestException('Les deux commandes doivent être du même établissement');
      const all = await tx.restaurantOrderItem.findMany({ where: { orderId: id, ...ACTIVE_ITEM } });
      const ids = new Set(dto.itemIds);
      all.filter((i) => i.parentItemId && ids.has(i.parentItemId)).forEach((i) => ids.add(i.id));
      const moving = all.filter((i) => ids.has(i.id));
      if (dto.itemIds.some((x) => !all.some((i) => i.id === x))) throw new BadRequestException('Article invalide, retiré ou annulé');
      if (moving.some((i) => i.billId)) throw new ConflictException('Un article figure sur une addition : annulez-la avant de le déplacer');
      await this.appendItems(tx, moving, target.id);
      await this.audit.record(
        {
          action: 'RESTAURANT_ITEMS_MOVED',
          entityType: 'RestaurantOrder',
          entityId: id,
          establishmentId: source.establishmentId,
          newValues: { from: source.number, to: target.number, items: moving.map((i) => ({ product: i.productName, quantity: i.quantity })) },
        },
        tx,
      );
    });
    return this.get(me, id);
  }

  /** Regroupe la commande source dans celle-ci (décision R16) ; la source reste tracée, statut « regroupée ». */
  async merge(me: AuthUser, id: string, dto: MergeDto) {
    if (dto.sourceOrderId === id) throw new BadRequestException('Choisissez une autre commande');
    await this.prisma.$transaction(async (tx) => {
      await lockOrders(tx, [id, dto.sourceOrderId]);
      const target = await this.lockOpen(tx, me, id);
      const source = await this.lockOpen(tx, me, dto.sourceOrderId);
      if (target.establishmentId !== source.establishmentId) throw new BadRequestException('Les deux commandes doivent être du même établissement');
      if (await tx.restaurantBill.count({ where: { orderId: source.id, status: { in: ['OPEN', 'PAID'] } } })) {
        throw new ConflictException(`La commande ${source.number} a déjà une addition : regroupement impossible`);
      }
      const moving = await tx.restaurantOrderItem.findMany({ where: { orderId: source.id, ...ACTIVE_ITEM }, orderBy: { position: 'asc' } });
      await this.appendItems(tx, moving, target.id);
      await tx.restaurantOrder.update({ where: { id: source.id }, data: { status: 'MERGED', mergedIntoId: target.id } });
      await this.audit.record(
        {
          action: 'RESTAURANT_ORDERS_MERGED',
          entityType: 'RestaurantOrder',
          entityId: target.id,
          establishmentId: target.establishmentId,
          newValues: { into: target.number, merged: source.number, items: moving.length },
        },
        tx,
      );
    });
    return this.get(me, id);
  }

  private async appendItems(tx: Tx, items: RestaurantOrderItem[], targetId: string) {
    const last = await tx.restaurantOrderItem.aggregate({ where: { orderId: targetId }, _max: { position: true } });
    let position = (last._max.position ?? -1) + 1;
    for (const i of [...items].sort((a, b) => a.position - b.position)) {
      // Seuls la commande et la position changent : l'article reste figé (trigger).
      await tx.restaurantOrderItem.update({ where: { id: i.id }, data: { orderId: targetId, position: position++ } });
    }
  }

  // --- Annulation de la commande ----------------------------------------------------------

  /**
   * Annule une commande sans addition. Si des articles ont été envoyés, ils
   * doivent d'abord être annulés (motif, droit « retirer un article envoyé »).
   */
  async cancel(me: AuthUser, id: string, dto: CancelOrderDto) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpen(tx, me, id);
      const items = await tx.restaurantOrderItem.findMany({ where: { orderId: id } });
      if (items.some((i) => isBillable(i))) throw new ConflictException('Des articles envoyés ne sont pas annulés : annulez-les d’abord');
      if (items.some((i) => i.status === 'CANCELLED')) assertAny(me, order.establishmentId, 'restaurant.orders_edit');
      if (await tx.restaurantBill.count({ where: { orderId: id, status: { in: ['OPEN', 'PAID'] } } })) throw new ConflictException('La commande a une addition');
      await tx.restaurantOrderItem.updateMany({ where: { orderId: id, status: 'DRAFT' }, data: { status: 'REMOVED', statusChangedAt: new Date(), statusChangedById: me.userId } });
      await tx.restaurantOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: me.userId, cancelReason: dto.reason } });
      await this.audit.record({ action: 'RESTAURANT_ORDER_CANCELLED', entityType: 'RestaurantOrder', entityId: id, establishmentId: order.establishmentId, newValues: { number: order.number }, reason: dto.reason }, tx);
    });
    return this.get(me, id);
  }
}

/** Accès en lecture d'une commande pour un autre service du module. */
export function assertOrderAccess(me: AuthUser, o: Pick<RestaurantOrder, 'establishmentId'>) {
  if (!canAny(me, o.establishmentId, ['restaurant.orders', 'restaurant.kitchen'])) throw new ForbiddenException('Commande non accessible');
}

@ApiTags('Restaurant')
@ApiBearerAuth()
@Controller('restaurant/orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: OrderQuery) {
    return this.service.list(me, q);
  }

  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post()
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateOrderDto) {
    return this.service.create(me, dto);
  }

  @Post(':id/items')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  addItems(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddItemsDto) {
    return this.service.addItems(me, id, dto);
  }

  @Post(':id/items/:itemId/remove')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  removeItem(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.service.removeItem(me, id, itemId);
  }

  @Post(':id/send')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  send(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendDto) {
    return this.service.send(me, id, dto);
  }

  @Post(':id/items/:itemId/cancel')
  @RequirePermissions('restaurant.orders_edit')
  @AnyEstablishmentScope()
  cancelItem(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: CancelItemDto) {
    return this.service.cancelItem(me, id, itemId, dto);
  }

  @Post(':id/transfer')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  transfer(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferDto) {
    return this.service.transfer(me, id, dto);
  }

  @Post(':id/move-items')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  moveItems(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveItemsDto) {
    return this.service.moveItems(me, id, dto);
  }

  @Post(':id/merge')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  merge(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MergeDto) {
    return this.service.merge(me, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOrderDto) {
    return this.service.cancel(me, id, dto);
  }
}
