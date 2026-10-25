import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Delivery, DeliveryStatus, Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SequenceService } from '../sequences/sequence.service';
import { idempotent, userNames } from '../stock/common';
import { emptyToNull, trim, WRITE } from './lines';
import { CustomerOrdersService } from './orders';

const DRIVER = 'deliveries.manage';
const ACTIVE: DeliveryStatus[] = ['TO_PREPARE', 'READY', 'OUT'];

export class CreateDeliveryDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsOptional() @IsUUID() driverId?: string | null;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) address: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @IsDateString() scheduledAt?: string | null;
  /** Frais de livraison TTC (FCFA) : facturés plus tard, jamais de stock. */
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) fee?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(150) feeLabel?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

export class UpdateDeliveryDto {
  @IsOptional() @IsUUID() driverId?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) address?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @IsDateString() scheduledAt?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) fee?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(150) feeLabel?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

export class DeliveryStatusDto {
  @IsIn(['READY', 'OUT', 'DELIVERED', 'FAILED']) status: DeliveryStatus;
  /** Obligatoire pour un échec. */
  @ValidateIf((d) => d.status === 'FAILED') @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason?: string;
}

export class CancelDeliveryDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class DriversQuery {
  @IsUUID() establishmentId: string;
}

class DeliveryQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsEnum(DeliveryStatus) status?: DeliveryStatus;
  @IsOptional() @IsUUID() orderId?: string;
}

/** Circuit d'une livraison : à préparer → prête → en cours → livrée ou échouée. */
const NEXT: Partial<Record<DeliveryStatus, DeliveryStatus[]>> = {
  TO_PREPARE: ['READY'],
  READY: ['OUT'],
  OUT: ['DELIVERED', 'FAILED'],
};

/**
 * Livraisons des commandes clients. Le responsable (« Gérer les commandes
 * clients ») prévoit, prépare et annule ; le livreur (« Gérer les
 * livraisons ») ne voit et ne fait avancer que ses propres livraisons. La
 * livraison réussie fait l'unique sortie de stock de la commande.
 */
@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly orders: CustomerOrdersService,
  ) {}

  private isManager(me: AuthUser, establishmentId: string) {
    return me.access.canAccessEstablishment(establishmentId) && me.access.can(WRITE, establishmentId);
  }

  private isDriverOf(me: AuthUser, d: { establishmentId: string; driverId: string | null }) {
    return d.driverId === me.userId && me.access.canAccessEstablishment(d.establishmentId) && me.access.can(DRIVER, d.establishmentId);
  }

  private visible(me: AuthUser, d: { establishmentId: string; driverId: string | null }) {
    return this.isManager(me, d.establishmentId) || this.isDriverOf(me, d);
  }

  async list(me: AuthUser, q: DeliveryQuery) {
    const scope = q.establishmentId ?? me.establishmentId;
    const managed = me.access.establishmentsWith(WRITE).filter((id) => !scope || id === scope);
    const driving = me.access.establishmentsWith(DRIVER).filter((id) => !scope || id === scope);
    const rows = await this.prisma.delivery.findMany({
      where: {
        companyId: me.companyId,
        status: q.status,
        orderId: q.orderId,
        OR: [{ establishmentId: { in: managed } }, { establishmentId: { in: driving }, driverId: me.userId }],
      },
      include: { order: { select: { id: true, number: true, status: true, customer: { select: { id: true, name: true, phone: true } } } } },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
      take: 300,
    });
    const names = await userNames(this.prisma, me.companyId, rows.map((r) => r.driverId));
    return rows.map((r) => ({ ...r, driver: r.driverId ? names.get(r.driverId) ?? null : null }));
  }

  async get(me: AuthUser, id: string) {
    const d = await this.prisma.delivery.findFirst({
      where: { id, companyId: me.companyId },
      include: {
        order: { select: { id: true, number: true, status: true, total: true, customer: { select: { id: true, name: true, phone: true } }, lines: { orderBy: { position: 'asc' } } } },
        history: { orderBy: { createdAt: 'asc' } },
        issues: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!d || !this.visible(me, d)) throw new NotFoundException('Livraison introuvable');
    const names = await userNames(this.prisma, me.companyId, [d.driverId, d.createdById, ...d.history.map((h) => h.userId)]);
    return {
      ...d,
      driver: d.driverId ? names.get(d.driverId) ?? null : null,
      createdBy: names.get(d.createdById) ?? null,
      history: d.history.map((h) => ({ ...h, user: names.get(h.userId) ?? null })),
      canManage: this.isManager(me, d.establishmentId),
    };
  }

  /** Livreur : utilisateur actif de l'entreprise, détenant « Gérer les livraisons » dans l'établissement (ou au niveau groupe). */
  private async checkDriver(tx: Tx, me: AuthUser, establishmentId: string, driverId: string) {
    const ok = await tx.user.findFirst({
      where: {
        id: driverId,
        companyId: me.companyId,
        isActive: true,
        deletedAt: null,
        userRoles: { some: { OR: [{ establishmentId }, { establishmentId: null }], role: { deletedAt: null, permissions: { some: { permissionCode: DRIVER } } } } },
      },
    });
    if (!ok) throw new BadRequestException('Livreur invalide : il doit avoir « Gérer les livraisons » dans cet établissement');
  }

  /** Livreurs affectables dans un établissement : même filtre que checkDriver, sans rôles ni permissions exposés. */
  async drivers(me: AuthUser, establishmentId: string) {
    if (!this.isManager(me, establishmentId)) throw new ForbiddenException("Vous n'avez pas cette permission pour cet établissement");
    return this.prisma.user.findMany({
      where: {
        companyId: me.companyId,
        isActive: true,
        deletedAt: null,
        userRoles: { some: { OR: [{ establishmentId }, { establishmentId: null }], role: { deletedAt: null, permissions: { some: { permissionCode: DRIVER } } } } },
      },
      select: { id: true, fullName: true, phone: true },
      orderBy: { fullName: 'asc' },
    });
  }

  // --- Création et modification -------------------------------------------------------------

  create(me: AuthUser, orderId: string, dto: CreateDeliveryDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.delivery
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((d) => d && { id: d.id, ownerId: d.createdById }),
      () => this.doCreate(me, orderId, dto),
      (id) => this.get(me, id),
    );
  }

  private async doCreate(me: AuthUser, orderId: string, dto: CreateDeliveryDto) {
    const id = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockedOrder(tx, me, orderId);
      if (!this.isManager(me, order.establishmentId)) throw new ForbiddenException("Vous n'avez pas cette permission pour cet établissement");
      if (!['CONFIRMED', 'IN_PREPARATION', 'READY'].includes(order.status)) throw new ConflictException('Seule une commande confirmée, non livrée, se livre');
      if (await tx.delivery.count({ where: { orderId, status: { in: ACTIVE } } })) throw new ConflictException('Cette commande a déjà une livraison en cours');
      if (dto.driverId) await this.checkDriver(tx, me, order.establishmentId, dto.driverId);
      const est = await tx.establishment.findUniqueOrThrow({ where: { id: order.establishmentId } });
      const delivery = await tx.delivery.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          orderId,
          number: await this.sequences.next(tx, { companyId: me.companyId, docType: 'DELIVERY_NOTE', establishmentId: est.id, establishmentCode: est.code }),
          clientRequestId: dto.clientRequestId ?? null,
          driverId: dto.driverId ?? null,
          address: dto.address,
          phone: dto.phone ?? null,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
          fee: BigInt(dto.fee ?? 0),
          feeLabel: dto.feeLabel ?? null,
          notes: dto.notes ?? null,
          createdById: me.userId,
        },
      });
      await tx.deliveryStatusHistory.create({ data: { deliveryId: delivery.id, fromStatus: null, toStatus: 'TO_PREPARE', userId: me.userId } });
      await this.audit.record(
        { action: 'DELIVERY_CREATED', entityType: 'Delivery', entityId: delivery.id, establishmentId: est.id, newValues: { number: delivery.number, order: order.number, driverId: delivery.driverId, fee: delivery.fee } },
        tx,
      );
      return delivery.id;
    });
    return this.get(me, id);
  }

  async update(me: AuthUser, id: string, dto: UpdateDeliveryDto) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.locked(tx, me, id);
      if (!this.isManager(me, d.establishmentId)) throw new ForbiddenException('Seul le responsable modifie une livraison');
      if (!['TO_PREPARE', 'READY'].includes(d.status)) throw new ConflictException('Livraison partie ou terminée : elle ne se modifie plus');
      if (dto.driverId) await this.checkDriver(tx, me, d.establishmentId, dto.driverId);
      const data: Prisma.DeliveryUpdateInput = {};
      if (dto.driverId !== undefined) data.driverId = dto.driverId;
      if (dto.address !== undefined) data.address = dto.address;
      if (dto.phone !== undefined) data.phone = dto.phone;
      if (dto.scheduledAt !== undefined) data.scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
      if (dto.fee !== undefined) data.fee = BigInt(dto.fee);
      if (dto.feeLabel !== undefined) data.feeLabel = dto.feeLabel;
      if (dto.notes !== undefined) data.notes = dto.notes;
      const updated = await tx.delivery.update({ where: { id }, data });
      await this.audit.record(
        {
          action: 'DELIVERY_UPDATED',
          entityType: 'Delivery',
          entityId: id,
          establishmentId: d.establishmentId,
          oldValues: { driverId: d.driverId, address: d.address, scheduledAt: d.scheduledAt, fee: d.fee },
          newValues: { driverId: updated.driverId, address: updated.address, scheduledAt: updated.scheduledAt, fee: updated.fee },
        },
        tx,
      );
    });
    return this.get(me, id);
  }

  // --- Circuit ---------------------------------------------------------------------------

  async setStatus(me: AuthUser, id: string, dto: DeliveryStatusDto) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.locked(tx, me, id);
      if (!NEXT[d.status]?.includes(dto.status)) throw new ConflictException(`Passage impossible de « ${d.status} » à « ${dto.status} »`);
      const manager = this.isManager(me, d.establishmentId);
      // La préparation est l'affaire du responsable ; le départ et le retour, du livreur (ou du responsable).
      if (dto.status === 'READY' ? !manager : !manager && !this.isDriverOf(me, d)) throw new ForbiddenException('Action réservée au responsable ou au livreur de cette livraison');
      const order = await this.orderOf(tx, d);
      if (dto.status === 'READY' && order.status !== 'READY') throw new ConflictException(`La commande ${order.number} n’est pas encore prête`);
      if (dto.status === 'OUT' && !d.driverId) throw new ConflictException('Affectez un livreur avant le départ');
      const data: Prisma.DeliveryUpdateInput = { status: dto.status };
      if (dto.status === 'DELIVERED') {
        if (order.status !== 'READY') throw new ConflictException(`La commande ${order.number} n’est pas prête : livraison impossible`);
        // Sortie unique du stock, dans la même transaction que la livraison.
        await this.orders.deliver(tx, me, order, d.id, `Livraison ${d.number}`);
        data.deliveredAt = new Date();
      }
      if (dto.status === 'FAILED') data.failedReason = dto.reason!; // réservations conservées : une nouvelle livraison pourra repartir
      await tx.delivery.update({ where: { id }, data });
      await tx.deliveryStatusHistory.create({ data: { deliveryId: id, fromStatus: d.status, toStatus: dto.status, reason: dto.reason ?? null, userId: me.userId } });
      await this.audit.record(
        { action: 'DELIVERY_STATUS', entityType: 'Delivery', entityId: id, establishmentId: d.establishmentId, oldValues: { status: d.status }, newValues: { number: d.number, status: dto.status }, reason: dto.reason ?? null },
        tx,
      );
    });
    return this.get(me, id);
  }

  async cancel(me: AuthUser, id: string, dto: CancelDeliveryDto) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.locked(tx, me, id);
      if (!this.isManager(me, d.establishmentId)) throw new ForbiddenException('Seul le responsable annule une livraison');
      if (!['TO_PREPARE', 'READY'].includes(d.status)) throw new ConflictException(d.status === 'OUT' ? 'Livraison en cours : attendez son retour (livrée ou échouée)' : 'Livraison terminée : elle ne s’annule plus');
      await tx.delivery.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: dto.reason } });
      await tx.deliveryStatusHistory.create({ data: { deliveryId: id, fromStatus: d.status, toStatus: 'CANCELLED', reason: dto.reason, userId: me.userId } });
      await this.audit.record(
        { action: 'DELIVERY_CANCELLED', entityType: 'Delivery', entityId: id, establishmentId: d.establishmentId, oldValues: { status: d.status }, newValues: { number: d.number, status: 'CANCELLED' }, reason: dto.reason },
        tx,
      );
    });
    return this.get(me, id);
  }

  // --- Verrous (toujours la commande avant la livraison, comme l'annulation de commande) -------

  private async lockedOrder(tx: Tx, me: AuthUser, orderId: string) {
    await tx.$queryRaw`SELECT id FROM customer_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const o = await tx.customerOrder.findFirst({ where: { id: orderId, companyId: me.companyId } });
    if (!o || !me.access.canAccessEstablishment(o.establishmentId)) throw new NotFoundException('Commande introuvable');
    return o;
  }

  private async locked(tx: Tx, me: AuthUser, id: string): Promise<Delivery> {
    const found = await tx.delivery.findFirst({ where: { id, companyId: me.companyId } });
    if (!found || !this.visible(me, found)) throw new NotFoundException('Livraison introuvable');
    await tx.$queryRaw`SELECT id FROM customer_orders WHERE id = ${found.orderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM deliveries WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.delivery.findUniqueOrThrow({ where: { id } });
  }

  private orderOf(tx: Tx, d: Delivery) {
    return tx.customerOrder.findUniqueOrThrow({ where: { id: d.orderId } });
  }
}

@ApiTags('Clients')
@ApiBearerAuth()
@Controller()
export class DeliveriesController {
  constructor(private readonly service: DeliveriesService) {}

  @Post('customer-orders/:id/deliveries')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateDeliveryDto) {
    return this.service.create(me, id, dto);
  }

  @Get('deliveries')
  list(@CurrentUser() me: AuthUser, @Query() q: DeliveryQuery) {
    return this.service.list(me, q);
  }

  @Get('deliveries/drivers')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  drivers(@CurrentUser() me: AuthUser, @Query() q: DriversQuery) {
    return this.service.drivers(me, q.establishmentId);
  }

  @Get('deliveries/:id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Patch('deliveries/:id')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDeliveryDto) {
    return this.service.update(me, id, dto);
  }

  @Post('deliveries/:id/status')
  setStatus(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliveryStatusDto) {
    return this.service.setStatus(me, id, dto);
  }

  @Post('deliveries/:id/cancel')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDeliveryDto) {
    return this.service.cancel(me, id, dto);
  }
}
