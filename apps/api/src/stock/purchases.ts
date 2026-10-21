import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, PurchaseOrderStatus, PurchaseRequestStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { attachItems, D, dateOnly, establishmentFor, idempotent, ItemDto, itemOf, loadItem, lockRow, nextNumber, readableEstablishments, userNames } from './common';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);
const MAX_AMOUNT = 1_000_000_000_000;

// --- DTO ----------------------------------------------------------------------

export class RequestItemDto extends ItemDto {
  /** Quantité souhaitée, dans l'unité de base de l'article (kg, L, unité). */
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) quantity: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) note?: string | null;
}

export class CreateRequestDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsOptional() @IsDateString() neededBy?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RequestItemDto) items: RequestItemDto[];
}

export class DecisionDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class OrderItemDto extends ItemDto {
  /** Offre fournisseur : renseigne article, unité d'achat, contenu et prix par défaut. */
  @IsOptional() @IsUUID() supplierProductId?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) purchaseUnitLabel?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) quantityPerPurchaseUnit?: number;
  /** Quantité commandée en unités d'achat (ex. 100 sacs). */
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) orderedQuantity: number;
  /** Prix TTC par unité d'achat (FCFA). Par défaut : prix de l'offre fournisseur. */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) unitPrice?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) discountAmount?: number;
}

export class CreateOrderDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsUUID() supplierId: string;
  @IsOptional() @IsDateString() expectedDate?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) paymentTerms?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) discountAmount?: number;
  /** Demandes d'achat couvertes par cette commande. */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) requestIds?: string[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => OrderItemDto) items: OrderItemDto[];
}

export class UpdateOrderDto {
  @IsOptional() @IsDateString() expectedDate?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) paymentTerms?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) discountAmount?: number;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => OrderItemDto) items?: OrderItemDto[];
}

class RequestQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsEnum(PurchaseRequestStatus) status?: PurchaseRequestStatus;
}

class OrderQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsEnum(PurchaseOrderStatus) status?: PurchaseOrderStatus;
}

// --- Service ------------------------------------------------------------------

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private scope(me: AuthUser, requested?: string) {
    const ids = readableEstablishments(me, 'purchases.view');
    if (requested && !ids.includes(requested)) throw new BadRequestException('Établissement non accessible');
    return requested ? [requested] : ids;
  }

  // Demandes d'achat ---------------------------------------------------------

  async listRequests(me: AuthUser, q: RequestQuery) {
    const rows = await this.prisma.purchaseRequest.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.scope(me, q.establishmentId) }, status: q.status },
      orderBy: { createdAt: 'desc' },
      include: { items: true, purchaseOrder: { select: { id: true, number: true } } },
      take: 200,
    });
    const names = await userNames(this.prisma, me.companyId, rows.flatMap((r) => [r.requestedById, r.decidedById]));
    return Promise.all(
      rows.map(async (r) => ({
        ...r,
        items: await attachItems(this.prisma, r.items),
        requestedBy: names.get(r.requestedById) ?? null,
        decidedBy: r.decidedById ? names.get(r.decidedById) ?? null : null,
      })),
    );
  }

  createRequest(me: AuthUser, dto: CreateRequestDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.purchaseRequest
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((r) => r && { id: r.id, ownerId: r.requestedById }),
      () => this.doCreateRequest(me, dto),
      (id) => this.prisma.purchaseRequest.findUniqueOrThrow({ where: { id }, include: { items: true } }),
    );
  }

  private doCreateRequest(me: AuthUser, dto: CreateRequestDto) {
    return this.prisma.$transaction(async (tx) => {
      const est = await establishmentFor(tx, me, dto.establishmentId, 'purchases.view');
      for (const i of dto.items) {
        const info = await loadItem(tx, me.companyId, itemOf(i), { purchasable: true });
        if (!info.isActive) throw new BadRequestException(`« ${info.name} » est archivé`);
      }
      const r = await tx.purchaseRequest.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          number: await nextNumber(tx, me.companyId, 'PURCHASE_REQUEST', est),
          neededBy: dto.neededBy ? dateOnly(dto.neededBy) : null,
          notes: dto.notes ?? null,
          requestedById: me.userId,
          clientRequestId: dto.clientRequestId ?? null,
          items: { create: dto.items.map((i) => ({ ...itemOf(i), quantity: D(i.quantity), note: i.note ?? null })) },
        },
        include: { items: true },
      });
      await this.audit.record({ action: 'PURCHASE_REQUEST_CREATED', entityType: 'PurchaseRequest', entityId: r.id, establishmentId: est.id, newValues: { number: r.number, items: dto.items } }, tx);
      return r;
    });
  }

  async decideRequest(me: AuthUser, id: string, action: 'reject' | 'cancel', dto: DecisionDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'purchase_requests', id);
      const r = await tx.purchaseRequest.findFirst({ where: { id, companyId: me.companyId } });
      if (!r) throw new NotFoundException('Demande introuvable');
      if (r.status !== 'OPEN') throw new ConflictException('Cette demande a déjà été traitée');
      // Refus : par les achats. Annulation : par son auteur ou par les achats.
      const isBuyer = me.access.can('purchases.manage', r.establishmentId);
      if (action === 'reject' ? !isBuyer : !(isBuyer || r.requestedById === me.userId)) {
        throw new ForbiddenException("Vous n'avez pas la permission de traiter cette demande");
      }
      const updated = await tx.purchaseRequest.update({
        where: { id },
        data: { status: action === 'reject' ? 'REJECTED' : 'CANCELLED', decidedById: me.userId, decidedAt: new Date(), decisionNote: dto.reason },
      });
      await this.audit.record(
        { action: action === 'reject' ? 'PURCHASE_REQUEST_REJECTED' : 'PURCHASE_REQUEST_CANCELLED', entityType: 'PurchaseRequest', entityId: id, establishmentId: r.establishmentId, reason: dto.reason },
        tx,
      );
      return updated;
    });
  }

  // Commandes fournisseurs ---------------------------------------------------

  async listOrders(me: AuthUser, q: OrderQuery) {
    const rows = await this.prisma.purchaseOrder.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.scope(me, q.establishmentId) }, supplierId: q.supplierId, status: q.status },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { _count: { select: { items: true, receipts: true } } },
    });
    const suppliers = await this.prisma.supplier.findMany({ where: { id: { in: rows.map((r) => r.supplierId) } }, select: { id: true, code: true, name: true } });
    return rows.map((r) => ({ ...r, supplier: suppliers.find((s) => s.id === r.supplierId) ?? null }));
  }

  async getOrder(me: AuthUser, id: string) {
    const o = await this.prisma.purchaseOrder.findFirst({
      where: { id, companyId: me.companyId },
      include: {
        items: { orderBy: { id: 'asc' } },
        requests: { select: { id: true, number: true } },
        receipts: { select: { id: true, number: true, receivedAt: true, totalValue: true }, orderBy: { receivedAt: 'asc' } },
      },
    });
    if (!o || !this.scope(me).includes(o.establishmentId)) throw new NotFoundException('Commande introuvable');
    const [supplier, items, names] = await Promise.all([
      this.prisma.supplier.findUnique({ where: { id: o.supplierId }, select: { id: true, code: true, name: true, phone: true } }),
      attachItems(this.prisma, o.items),
      userNames(this.prisma, me.companyId, [o.createdById, o.validatedById, o.closedById]),
    ]);
    return {
      ...o,
      supplier,
      items: items.map((i) => ({
        ...i,
        remainingQuantity: Prisma.Decimal.max(D(i.orderedQuantity).sub(i.receivedQuantity), 0),
        baseQuantity: D(i.orderedQuantity).mul(i.quantityPerPurchaseUnit),
      })),
      createdBy: names.get(o.createdById) ?? null,
      validatedBy: o.validatedById ? names.get(o.validatedById) ?? null : null,
    };
  }

  /** Construit les lignes d'une commande à partir des offres ou d'une saisie libre. */
  private async buildItems(tx: Tx, me: AuthUser, supplierId: string, items: OrderItemDto[]) {
    const lines: Prisma.PurchaseOrderItemCreateManyOrderInput[] = [];
    for (const i of items) {
      let item;
      let label = i.purchaseUnitLabel;
      let qpu = i.quantityPerPurchaseUnit !== undefined ? D(i.quantityPerPurchaseUnit) : undefined;
      let price = i.unitPrice !== undefined ? BigInt(i.unitPrice) : undefined;
      if (i.supplierProductId) {
        const offer = await tx.supplierProduct.findFirst({ where: { id: i.supplierProductId, supplierId, isActive: true } });
        if (!offer) throw new BadRequestException('Offre fournisseur invalide pour ce fournisseur');
        item = { rawMaterialId: offer.rawMaterialId, productId: offer.productId };
        label ??= offer.purchaseUnitLabel;
        qpu ??= D(offer.quantityPerPurchaseUnit);
        price ??= offer.unitPrice ?? undefined;
      } else {
        item = itemOf(i);
      }
      const info = await loadItem(tx, me.companyId, item, { purchasable: true });
      if (!info.isActive) throw new BadRequestException(`« ${info.name} » est archivé`);
      if (!label || !qpu) throw new BadRequestException(`Unité d'achat et contenu requis pour « ${info.name} »`);
      if (price === undefined) throw new BadRequestException(`Prix requis pour « ${info.name} »`);
      const gross = BigInt(D(i.orderedQuantity).mul(price.toString()).toDecimalPlaces(0).toFixed(0));
      const discount = BigInt(i.discountAmount ?? 0);
      if (discount > gross) throw new BadRequestException(`Remise supérieure au montant de la ligne « ${info.name} »`);
      lines.push({
        ...item,
        supplierProductId: i.supplierProductId ?? null,
        purchaseUnitLabel: label,
        quantityPerPurchaseUnit: qpu,
        orderedQuantity: D(i.orderedQuantity),
        unitPrice: price,
        discountAmount: discount,
        lineTotal: gross - discount,
      });
    }
    const subtotal = lines.reduce((s, l) => s + (l.lineTotal as bigint), 0n);
    return { lines, subtotal };
  }

  createOrder(me: AuthUser, dto: CreateOrderDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.purchaseOrder
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((o) => o && { id: o.id, ownerId: o.createdById }),
      () => this.doCreateOrder(me, dto),
      (id) => this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id } }),
    );
  }

  private doCreateOrder(me: AuthUser, dto: CreateOrderDto) {
    return this.prisma.$transaction(async (tx) => {
      const est = await establishmentFor(tx, me, dto.establishmentId, 'purchases.manage');
      const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, companyId: me.companyId } });
      if (!supplier) throw new BadRequestException('Fournisseur invalide');
      if (!supplier.isActive) throw new BadRequestException('Fournisseur archivé');
      const { lines, subtotal } = await this.buildItems(tx, me, supplier.id, dto.items);
      const discount = BigInt(dto.discountAmount ?? 0);
      if (discount > subtotal) throw new BadRequestException('Remise supérieure au montant de la commande');

      for (const rid of dto.requestIds ?? []) await lockRow(tx, 'purchase_requests', rid);
      const requests = await tx.purchaseRequest.findMany({ where: { id: { in: dto.requestIds ?? [] }, companyId: me.companyId } });
      if (requests.length !== (dto.requestIds?.length ?? 0)) throw new BadRequestException('Demande d’achat invalide');
      if (requests.some((r) => r.status !== 'OPEN' || r.establishmentId !== est.id)) {
        throw new ConflictException('Une demande d’achat est déjà traitée ou appartient à un autre établissement');
      }

      const order = await tx.purchaseOrder.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          number: await nextNumber(tx, me.companyId, 'PURCHASE_ORDER', est),
          supplierId: supplier.id,
          expectedDate: dto.expectedDate ? dateOnly(dto.expectedDate) : null,
          paymentTerms: dto.paymentTerms ?? supplier.paymentTerms ?? null,
          notes: dto.notes ?? null,
          discountAmount: discount,
          subtotal,
          total: subtotal - discount,
          createdById: me.userId,
          clientRequestId: dto.clientRequestId ?? null,
          items: { createMany: { data: lines } },
        },
      });
      if (requests.length) {
        await tx.purchaseRequest.updateMany({
          where: { id: { in: requests.map((r) => r.id) } },
          data: { status: 'ORDERED', purchaseOrderId: order.id, decidedById: me.userId, decidedAt: new Date() },
        });
      }
      await this.audit.record(
        { action: 'PURCHASE_ORDER_CREATED', entityType: 'PurchaseOrder', entityId: order.id, establishmentId: est.id, newValues: { number: order.number, supplierId: supplier.id, total: order.total, requests: requests.map((r) => r.number) } },
        tx,
      );
      return order;
    });
  }

  private async lockedOrder(tx: Tx, me: AuthUser, id: string) {
    await lockRow(tx, 'purchase_orders', id);
    const o = await tx.purchaseOrder.findFirst({ where: { id, companyId: me.companyId }, include: { items: true } });
    if (!o) throw new NotFoundException('Commande introuvable');
    await establishmentFor(tx, me, o.establishmentId, 'purchases.manage');
    return o;
  }

  async updateOrder(me: AuthUser, id: string, dto: UpdateOrderDto) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lockedOrder(tx, me, id);
      if (o.status !== 'DRAFT') throw new ConflictException('Seule une commande en brouillon peut être modifiée');
      let subtotal = o.subtotal;
      if (dto.items) {
        const built = await this.buildItems(tx, me, o.supplierId, dto.items);
        // Brouillon : les lignes sont remplacées (rien n'a encore été reçu ni validé).
        await tx.purchaseOrderItem.deleteMany({ where: { orderId: id } });
        await tx.purchaseOrderItem.createMany({ data: built.lines.map((l) => ({ ...l, orderId: id })) });
        subtotal = built.subtotal;
      }
      const discount = dto.discountAmount !== undefined ? BigInt(dto.discountAmount) : o.discountAmount;
      if (discount > subtotal) throw new BadRequestException('Remise supérieure au montant de la commande');
      const updated = await tx.purchaseOrder.update({
        where: { id },
        data: {
          expectedDate: dto.expectedDate === undefined ? undefined : dto.expectedDate ? dateOnly(dto.expectedDate) : null,
          paymentTerms: dto.paymentTerms,
          notes: dto.notes,
          discountAmount: discount,
          subtotal,
          total: subtotal - discount,
        },
      });
      await this.audit.record(
        {
          action: 'PURCHASE_ORDER_UPDATED',
          entityType: 'PurchaseOrder',
          entityId: id,
          establishmentId: o.establishmentId,
          oldValues: { total: o.total, items: o.items.length },
          newValues: { total: updated.total, items: dto.items?.length ?? o.items.length },
        },
        tx,
      );
    });
    return this.getOrder(me, id);
  }

  async validateOrder(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lockedOrder(tx, me, id);
      if (o.status !== 'DRAFT') throw new ConflictException('Cette commande a déjà été validée ou annulée');
      if (o.items.length === 0) throw new BadRequestException('Commande sans ligne');
      const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: o.supplierId } });
      if (!supplier.isActive) throw new BadRequestException('Fournisseur archivé');
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'VALIDATED', validatedById: me.userId, validatedAt: new Date() } });
      await this.audit.record({ action: 'PURCHASE_ORDER_VALIDATED', entityType: 'PurchaseOrder', entityId: id, establishmentId: o.establishmentId, newValues: { total: o.total } }, tx);
    });
    return this.getOrder(me, id);
  }

  /** Annulation : uniquement tant que rien n'a été reçu. Les demandes liées redeviennent ouvertes. */
  async cancelOrder(me: AuthUser, id: string, dto: DecisionDto) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lockedOrder(tx, me, id);
      if (!['DRAFT', 'VALIDATED'].includes(o.status)) {
        throw new ConflictException('Une commande déjà (partiellement) reçue ne peut pas être annulée : clôturez-la');
      }
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED', closedById: me.userId, closedAt: new Date(), closeReason: dto.reason } });
      const reopened = await tx.purchaseRequest.updateMany({
        where: { purchaseOrderId: id, status: 'ORDERED' },
        data: { status: 'OPEN', purchaseOrderId: null, decidedById: null, decidedAt: null },
      });
      await this.audit.record(
        { action: 'PURCHASE_ORDER_CANCELLED', entityType: 'PurchaseOrder', entityId: id, establishmentId: o.establishmentId, reason: dto.reason, newValues: { requestsReopened: reopened.count } },
        tx,
      );
    });
    return this.getOrder(me, id);
  }

  /** Clôture d'une commande partiellement reçue : le reliquat ne sera pas livré. */
  async closeOrder(me: AuthUser, id: string, dto: DecisionDto) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lockedOrder(tx, me, id);
      if (o.status !== 'PARTIALLY_RECEIVED') throw new ConflictException('Seule une commande partiellement reçue peut être clôturée');
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CLOSED', closedById: me.userId, closedAt: new Date(), closeReason: dto.reason } });
      await this.audit.record({ action: 'PURCHASE_ORDER_CLOSED', entityType: 'PurchaseOrder', entityId: id, establishmentId: o.establishmentId, reason: dto.reason }, tx);
    });
    return this.getOrder(me, id);
  }
}

@ApiTags('Achats')
@ApiBearerAuth()
@Controller()
export class PurchasesController {
  constructor(private readonly service: PurchasesService) {}

  @Get('purchase-requests')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  listRequests(@CurrentUser() me: AuthUser, @Query() q: RequestQuery) {
    return this.service.listRequests(me, q);
  }

  @Post('purchase-requests')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  createRequest(@CurrentUser() me: AuthUser, @Body() dto: CreateRequestDto) {
    return this.service.createRequest(me, dto);
  }

  @Post('purchase-requests/:id/reject')
  @RequirePermissions('purchases.manage')
  @AnyEstablishmentScope()
  reject(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    return this.service.decideRequest(me, id, 'reject', dto);
  }

  @Post('purchase-requests/:id/cancel')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  cancelRequest(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    return this.service.decideRequest(me, id, 'cancel', dto);
  }

  @Get('purchase-orders')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  listOrders(@CurrentUser() me: AuthUser, @Query() q: OrderQuery) {
    return this.service.listOrders(me, q);
  }

  @Get('purchase-orders/:id')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  getOrder(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getOrder(me, id);
  }

  @Post('purchase-orders')
  @RequirePermissions('purchases.manage')
  @AnyEstablishmentScope()
  createOrder(@CurrentUser() me: AuthUser, @Body() dto: CreateOrderDto) {
    return this.service.createOrder(me, dto);
  }

  @Patch('purchase-orders/:id')
  @RequirePermissions('purchases.manage')
  @AnyEstablishmentScope()
  updateOrder(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderDto) {
    return this.service.updateOrder(me, id, dto);
  }

  @Post('purchase-orders/:id/validate')
  @RequirePermissions('purchases.manage')
  @AnyEstablishmentScope()
  validate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.validateOrder(me, id);
  }

  @Post('purchase-orders/:id/cancel')
  @RequirePermissions('purchases.manage')
  @AnyEstablishmentScope()
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    return this.service.cancelOrder(me, id, dto);
  }

  @Post('purchase-orders/:id/close')
  @RequirePermissions('purchases.manage')
  @AnyEstablishmentScope()
  close(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    return this.service.closeOrder(me, id, dto);
  }
}
