import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CustomerDocumentKind, CustomerOrderStatus, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SequenceService } from '../sequences/sequence.service';
import { idempotent, userNames } from '../stock/common';
import { CustomerOrderStock } from './stock';
import { activeCustomer, assertWrite, canRead, categorySnapshots, checkEvent, DocumentLineDto, emptyToNull, EventDto, lockRowOf, PricedDocumentLine, priceLines, readable, trim, WRITE } from './lines';

export class CreateCustomerOrderDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsUUID() customerId: string;
  @IsOptional() @IsEnum(CustomerDocumentKind) kind?: CustomerDocumentKind;
  @IsOptional() @IsDateString() dueAt?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @ValidateNested() @Type(() => EventDto) event?: EventDto | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => DocumentLineDto) lines: DocumentLineDto[];
}

export class UpdateCustomerOrderDto {
  @IsOptional() @IsDateString() dueAt?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @ValidateNested() @Type(() => EventDto) event?: EventDto;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => DocumentLineDto) lines?: DocumentLineDto[];
}

/** Étapes suivantes possibles, une à la fois (annulation : route dédiée). */
export class OrderStatusDto {
  @IsIn(['CONFIRMED', 'IN_PREPARATION', 'READY', 'DELIVERED', 'COMPLETED']) status: CustomerOrderStatus;
}

export class CancelOrderDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class OrderQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsEnum(CustomerOrderStatus) status?: CustomerOrderStatus;
  @IsOptional() @IsEnum(CustomerDocumentKind) kind?: CustomerDocumentKind;
}

/** Circuit d'une commande (décision D10 : identique pour un événement). */
const NEXT: Partial<Record<CustomerOrderStatus, CustomerOrderStatus>> = {
  DRAFT: 'CONFIRMED',
  CONFIRMED: 'IN_PREPARATION',
  IN_PREPARATION: 'READY',
  READY: 'DELIVERED',
  DELIVERED: 'COMPLETED',
};
const CANCELLABLE: CustomerOrderStatus[] = ['DRAFT', 'CONFIRMED', 'IN_PREPARATION', 'READY'];

const lineData = (l: PricedDocumentLine) => ({
  position: l.position,
  kind: l.kind,
  productId: l.productId,
  productCode: l.productCode,
  label: l.label,
  quantity: l.quantity,
  unitPrice: l.unitPrice,
  taxRate: l.taxRate,
  lineTotal: l.lineTotal,
  taxAmount: l.taxAmount,
  note: l.note,
  madeToOrder: l.madeToOrder,
});

const eventData = (e: EventDto) => ({
  eventType: e.eventType,
  eventDate: new Date(e.eventDate),
  venue: e.venue ?? null,
  guests: e.guests ?? null,
  contactName: e.contactName ?? null,
  contactPhone: e.contactPhone ?? null,
  notes: e.notes ?? null,
});

@Injectable()
export class CustomerOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly stock: CustomerOrderStock,
  ) {}

  async list(me: AuthUser, q: OrderQuery) {
    const rows = await this.prisma.customerOrder.findMany({
      where: { companyId: me.companyId, establishmentId: { in: readable(me, q.establishmentId) }, customerId: q.customerId, status: q.status, kind: q.kind },
      include: { customer: { select: { id: true, name: true, phone: true } }, event: true },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return rows;
  }

  async get(me: AuthUser, id: string) {
    const o = await this.prisma.customerOrder.findFirst({
      where: { id, companyId: me.companyId },
      include: {
        customer: { select: { id: true, name: true, phone: true, type: true } },
        lines: { orderBy: { position: 'asc' }, include: { reservations: { where: { releasedAt: null }, select: { lotId: true, quantity: true } } } },
        event: true,
        deliveries: { orderBy: { createdAt: 'asc' } },
        deposits: { orderBy: { createdAt: 'asc' }, select: { id: true, number: true, status: true, amount: true, refundedAmount: true, createdAt: true } },
        history: { orderBy: { createdAt: 'asc' } },
        quote: { select: { id: true, number: true } },
      },
    });
    if (!o || !canRead(me, o.establishmentId)) throw new NotFoundException('Commande introuvable');
    const names = await userNames(this.prisma, me.companyId, [o.createdById, o.cancelledById, ...o.history.map((h) => h.userId)]);
    return {
      ...o,
      createdBy: names.get(o.createdById) ?? null,
      cancelledBy: o.cancelledById ? names.get(o.cancelledById) ?? null : null,
      history: o.history.map((h) => ({ ...h, user: names.get(h.userId) ?? null })),
      canManage: me.access.can(WRITE, o.establishmentId),
    };
  }

  // --- Création ------------------------------------------------------------------------

  create(me: AuthUser, dto: CreateCustomerOrderDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.customerOrder
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((o) => o && { id: o.id, ownerId: o.createdById }),
      () => this.doCreate(me, dto),
      (id) => this.get(me, id),
    );
  }

  private async doCreate(me: AuthUser, dto: CreateCustomerOrderDto) {
    assertWrite(me, dto.establishmentId);
    const kind = dto.kind ?? 'STANDARD';
    checkEvent(kind, dto.event);
    const id = await this.prisma.$transaction(async (tx) => {
      const est = await tx.establishment.findFirst({ where: { id: dto.establishmentId, companyId: me.companyId, deletedAt: null } });
      if (!est) throw new BadRequestException('Établissement invalide');
      const customer = await activeCustomer(tx, me, dto.customerId);
      const priced = await priceLines(tx, me, est.id, dto.lines);
      return this.insert(tx, me, est, customer.id, {
        clientRequestId: dto.clientRequestId ?? null,
        kind,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        notes: dto.notes ?? null,
        priced,
        event: dto.event ? eventData(dto.event) : null,
        quoteId: null,
      });
    });
    return this.get(me, id);
  }

  /** Insère une commande en brouillon (lignes, événement, historique, audit). Utilisé aussi par l'acceptation d'un devis. */
  async insert(
    tx: Tx,
    me: AuthUser,
    est: { id: string; code: string },
    customerId: string,
    data: {
      clientRequestId: string | null;
      kind: CustomerDocumentKind;
      dueAt: Date | null;
      notes: string | null;
      priced: { lines: PricedDocumentLine[]; total: bigint; taxTotal: bigint };
      event: ReturnType<typeof eventData> | null;
      quoteId: string | null;
    },
  ) {
    const order = await tx.customerOrder.create({
      data: {
        companyId: me.companyId,
        establishmentId: est.id,
        customerId,
        number: await this.sequences.next(tx, { companyId: me.companyId, docType: 'CUSTOMER_ORDER', establishmentId: est.id, establishmentCode: est.code }),
        clientRequestId: data.clientRequestId,
        kind: data.kind,
        quoteId: data.quoteId,
        dueAt: data.dueAt,
        notes: data.notes,
        total: data.priced.total,
        taxTotal: data.priced.taxTotal,
        createdById: me.userId,
      },
    });
    const category = await categorySnapshots(tx, data.priced.lines.map((l) => l.productId));
    await tx.customerOrderLine.createMany({ data: data.priced.lines.map((l) => ({ ...lineData(l), ...category(l.productId), orderId: order.id })) });
    if (data.event) await tx.customerOrderEvent.create({ data: { ...data.event, orderId: order.id } });
    await tx.customerOrderStatusHistory.create({ data: { orderId: order.id, fromStatus: null, toStatus: 'DRAFT', userId: me.userId } });
    await this.audit.record(
      {
        action: 'CUSTOMER_ORDER_CREATED',
        entityType: 'CustomerOrder',
        entityId: order.id,
        establishmentId: est.id,
        newValues: { number: order.number, kind: order.kind, customerId, total: order.total, lines: data.priced.lines.length, quoteId: data.quoteId },
      },
      tx,
    );
    return order.id;
  }

  /** Modification d'une commande en brouillon : lignes remplacées et prix recalculés. */
  async update(me: AuthUser, id: string, dto: UpdateCustomerOrderDto) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.locked(tx, me, id);
      if (o.status !== 'DRAFT') throw new ConflictException('Commande confirmée : elle ne se modifie plus (annulez-la puis recréez-la)');
      if (dto.event !== undefined) checkEvent(o.kind, dto.event);
      const data: Prisma.CustomerOrderUpdateInput = {};
      if (dto.dueAt !== undefined) data.dueAt = dto.dueAt ? new Date(dto.dueAt) : null;
      if (dto.notes !== undefined) data.notes = dto.notes;
      const old = { total: o.total, lines: await tx.customerOrderLine.count({ where: { orderId: id } }) };
      if (dto.lines) {
        const priced = await priceLines(tx, me, o.establishmentId, dto.lines);
        await tx.customerOrderLine.deleteMany({ where: { orderId: id } });
        const category = await categorySnapshots(tx, priced.lines.map((l) => l.productId));
        await tx.customerOrderLine.createMany({ data: priced.lines.map((l) => ({ ...lineData(l), ...category(l.productId), orderId: id })) });
        data.total = priced.total;
        data.taxTotal = priced.taxTotal;
      }
      if (dto.event) await tx.customerOrderEvent.update({ where: { orderId: id }, data: eventData(dto.event) });
      const updated = await tx.customerOrder.update({ where: { id }, data });
      await this.audit.record(
        { action: 'CUSTOMER_ORDER_UPDATED', entityType: 'CustomerOrder', entityId: id, establishmentId: o.establishmentId, oldValues: old, newValues: { total: updated.total, lines: dto.lines?.length ?? old.lines, event: dto.event ?? undefined } },
        tx,
      );
    });
    return this.get(me, id);
  }

  private async locked(tx: Tx, me: AuthUser, id: string) {
    await lockRowOf(tx, 'customer_orders', id);
    const o = await tx.customerOrder.findFirst({ where: { id, companyId: me.companyId } });
    if (!o || !canRead(me, o.establishmentId)) throw new NotFoundException('Commande introuvable');
    assertWrite(me, o.establishmentId);
    return o;
  }

  // --- Circuit ---------------------------------------------------------------------------

  async setStatus(me: AuthUser, id: string, dto: OrderStatusDto) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.locked(tx, me, id);
      if (dto.status === 'DELIVERED') throw new ConflictException('La commande passe « livrée » par la remise au client ou par sa livraison (sortie de stock)');
      await this.transition(tx, me, o, dto.status, null);
    });
    return this.get(me, id);
  }

  /** Passage à l'étape suivante (une seule à la fois), tracé dans l'historique et l'audit. */
  async transition(tx: Tx, me: AuthUser, o: { id: string; number: string; status: CustomerOrderStatus; establishmentId: string; customerId: string }, to: CustomerOrderStatus, reason: string | null) {
    if (NEXT[o.status] !== to) throw new ConflictException(`Passage impossible de « ${o.status} » à « ${to} »`);
    if (to === 'CONFIRMED') {
      await activeCustomer(tx, me, o.customerId);
      if (!(await tx.customerOrderLine.count({ where: { orderId: o.id } }))) throw new BadRequestException('Commande sans ligne');
      await this.stock.reserveOrder(tx, me, o);
    }
    await tx.customerOrder.update({ where: { id: o.id }, data: { status: to, ...(to === 'CONFIRMED' ? { confirmedAt: new Date() } : {}) } });
    await tx.customerOrderStatusHistory.create({ data: { orderId: o.id, fromStatus: o.status, toStatus: to, reason, userId: me.userId } });
    await this.audit.record(
      { action: 'CUSTOMER_ORDER_STATUS', entityType: 'CustomerOrder', entityId: o.id, establishmentId: o.establishmentId, oldValues: { status: o.status }, newValues: { number: o.number, status: to }, reason },
      tx,
    );
  }

  /** Annulation possible avant « livrée », toujours motivée ; rien n'est supprimé. */
  async cancel(me: AuthUser, id: string, dto: CancelOrderDto) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.locked(tx, me, id);
      if (!CANCELLABLE.includes(o.status)) throw new ConflictException(o.status === 'CANCELLED' ? 'Commande déjà annulée' : 'Commande déjà livrée : elle ne s’annule plus');
      const delivery = await tx.delivery.findFirst({ where: { orderId: id, status: { in: ['TO_PREPARE', 'READY', 'OUT'] } } });
      if (delivery?.status === 'OUT') throw new ConflictException(`Livraison ${delivery.number} en cours : attendez son retour (livrée ou échouée)`);
      if (delivery) {
        await tx.delivery.update({ where: { id: delivery.id }, data: { status: 'CANCELLED', cancelReason: `Commande annulée : ${dto.reason}` } });
        await tx.deliveryStatusHistory.create({ data: { deliveryId: delivery.id, fromStatus: delivery.status, toStatus: 'CANCELLED', reason: dto.reason, userId: me.userId } });
      }
      const released = await this.stock.releaseOrder(tx, o);
      await tx.customerOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: me.userId, cancelReason: dto.reason } });
      await tx.customerOrderStatusHistory.create({ data: { orderId: id, fromStatus: o.status, toStatus: 'CANCELLED', reason: dto.reason, userId: me.userId } });
      await this.audit.record(
        { action: 'CUSTOMER_ORDER_CANCELLED', entityType: 'CustomerOrder', entityId: id, establishmentId: o.establishmentId, oldValues: { status: o.status }, newValues: { number: o.number, status: 'CANCELLED', releasedReservations: released, cancelledDelivery: delivery?.number }, reason: dto.reason },
        tx,
      );
    });
    return this.get(me, id);
  }

  /** Remise au client sur place : commande prête, sans livraison active ; sortie de stock unique. */
  async handOver(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.locked(tx, me, id);
      if (o.status !== 'READY') throw new ConflictException('Seule une commande prête se remet au client');
      if (await tx.delivery.count({ where: { orderId: id, status: { in: ['TO_PREPARE', 'READY', 'OUT'] } } })) {
        throw new ConflictException('Une livraison est prévue : la commande sort à sa livraison');
      }
      await this.deliver(tx, me, o, null, 'Remise au client');
    });
    return this.get(me, id);
  }

  /** Sortie de stock puis passage « livrée », dans la transaction de la remise ou de la livraison. */
  async deliver(tx: Tx, me: AuthUser, o: { id: string; number: string; status: CustomerOrderStatus; establishmentId: string; customerId: string }, deliveryId: string | null, reason: string) {
    await this.stock.issueOrder(tx, me, o, deliveryId);
    await this.transition(tx, me, o, 'DELIVERED', reason);
  }
}

@ApiTags('Clients')
@ApiBearerAuth()
@Controller('customer-orders')
export class CustomerOrdersController {
  constructor(
    private readonly service: CustomerOrdersService,
    private readonly stock: CustomerOrderStock,
  ) {}

  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: OrderQuery) {
    return this.service.list(me, q);
  }

  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post()
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateCustomerOrderDto) {
    return this.service.create(me, dto);
  }

  @Patch(':id')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerOrderDto) {
    return this.service.update(me, id, dto);
  }

  @Post(':id/status')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  setStatus(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderStatusDto) {
    return this.service.setStatus(me, id, dto);
  }

  @Post(':id/hand-over')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  handOver(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.handOver(me, id);
  }

  /** Fabrication à la demande : ordre de production du module 4 rattaché à la ligne. */
  @Post(':id/lines/:lineId/production')
  @RequirePermissions(WRITE, 'production.manage')
  @AnyEstablishmentScope()
  launchProduction(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string) {
    return this.stock.launchProduction(me, id, lineId);
  }

  @Post(':id/cancel')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOrderDto) {
    return this.service.cancel(me, id, dto);
  }
}
