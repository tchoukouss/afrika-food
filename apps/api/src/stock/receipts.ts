import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
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
import { PrismaService } from '../prisma/prisma.service';
import { attachItems, D, dateOnly, establishmentFor, idempotent, ItemDto, itemOf, loadItem, lockRow, nextNumber, readableEstablishments, todayISO, userNames } from './common';
import { StockEngine } from './engine';
import { refreshInvoiceStatus } from './supplier-finance';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);
const MAX_AMOUNT = 1_000_000_000_000;

export class ReceiptItemDto extends ItemDto {
  /** Ligne de la commande réceptionnée (obligatoire si la réception porte sur une commande). */
  @IsOptional() @IsUUID() orderItemId?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) purchaseUnitLabel?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) quantityPerPurchaseUnit?: number;
  /** Quantités en unités d'achat. */
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) receivedQuantity: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1e9) rejectedQuantity?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) rejectionReason?: string | null;
  /** Prix TTC réellement facturé par unité d'achat (FCFA). */
  @IsInt() @Min(0) @Max(MAX_AMOUNT) unitPrice: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) varianceReason?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(80) brand?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(80) supplierLotRef?: string | null;
  @IsOptional() @IsDateString() productionDate?: string | null;
  @IsOptional() @IsDateString() expiryDate?: string | null;
}

export class CreateReceiptDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsUUID() supplierId: string;
  /** Absent = réception directe (sans commande). */
  @IsOptional() @IsUUID() purchaseOrderId?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(60) supplierDocumentRef?: string | null;
  @IsOptional() @IsDateString() receivedAt?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ReceiptItemDto) items: ReceiptItemDto[];
}

export class ReturnItemDto {
  @IsUUID() lotId: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) quantity: number;
}

export class CreateReturnDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsUUID() supplierId: string;
  @IsOptional() @IsUUID() receiptId?: string;
  /** Facture à laquelle imputer l'avoir (facultatif). */
  @IsOptional() @IsUUID() invoiceId?: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ReturnItemDto) items: ReturnItemDto[];
}

class ReceiptQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) uninvoiced?: boolean;
}

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
  ) {}

  private scope(me: AuthUser, permission: string, requested?: string) {
    const ids = readableEstablishments(me, permission);
    if (requested && !ids.includes(requested)) throw new BadRequestException('Établissement non accessible');
    return requested ? [requested] : ids;
  }

  async list(me: AuthUser, q: ReceiptQuery) {
    const rows = await this.prisma.goodsReceipt.findMany({
      where: {
        companyId: me.companyId,
        establishmentId: { in: this.scope(me, 'purchases.view', q.establishmentId) },
        supplierId: q.supplierId,
        ...(q.uninvoiced ? { invoiceLinks: { none: { invoice: { status: { not: 'CANCELLED' } } } } } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      take: 200,
      include: {
        purchaseOrder: { select: { id: true, number: true } },
        invoiceLinks: { where: { invoice: { status: { not: 'CANCELLED' } } }, select: { invoice: { select: { id: true, number: true } } } },
        _count: { select: { items: true } },
      },
    });
    const suppliers = await this.prisma.supplier.findMany({ where: { id: { in: rows.map((r) => r.supplierId) } }, select: { id: true, code: true, name: true } });
    return rows.map(({ invoiceLinks, ...r }) => ({
      ...r,
      supplier: suppliers.find((s) => s.id === r.supplierId) ?? null,
      invoice: invoiceLinks[0]?.invoice ?? null,
    }));
  }

  async get(me: AuthUser, id: string) {
    const r = await this.prisma.goodsReceipt.findFirst({
      where: { id, companyId: me.companyId },
      include: {
        items: { include: { lot: { select: { id: true, lotNumber: true, unitCost: true } } } },
        purchaseOrder: { select: { id: true, number: true } },
        returns: { select: { id: true, number: true, totalValue: true, createdAt: true } },
        invoiceLinks: { select: { invoice: { select: { id: true, number: true, status: true } } } },
      },
    });
    if (!r || !this.scope(me, 'purchases.view').includes(r.establishmentId)) throw new NotFoundException('Réception introuvable');
    const [supplier, location, items, names] = await Promise.all([
      this.prisma.supplier.findUnique({ where: { id: r.supplierId }, select: { id: true, code: true, name: true } }),
      this.prisma.stockLocation.findUnique({ where: { id: r.locationId }, select: { id: true, name: true } }),
      attachItems(this.prisma, r.items),
      userNames(this.prisma, me.companyId, [r.receivedById]),
    ]);
    return { ...r, supplier, location, items, receivedBy: names.get(r.receivedById) ?? null };
  }

  /**
   * Réception (avec ou sans commande) : contrôle, création des lots au coût réel,
   * entrées en stock et mise à jour de la commande, dans une seule transaction.
   */
  create(me: AuthUser, dto: CreateReceiptDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.goodsReceipt
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((r) => r && { id: r.id, ownerId: r.receivedById }),
      () => this.doCreate(me, dto),
      (id) => this.get(me, id),
    );
  }

  private async doCreate(me: AuthUser, dto: CreateReceiptDto) {
    const id = await this.prisma.$transaction(async (tx) => {
      const est = await establishmentFor(tx, me, dto.establishmentId, 'purchases.receive');
      const location = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.locationId);
      const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, companyId: me.companyId } });
      if (!supplier) throw new BadRequestException('Fournisseur invalide');
      if (!supplier.isActive) throw new BadRequestException('Fournisseur archivé');
      const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
      if (receivedAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('Date de réception dans le futur');

      // Commande : verrouillée pour que deux réceptions simultanées cumulent correctement.
      let order: Prisma.PurchaseOrderGetPayload<{ include: { items: true } }> | null = null;
      if (dto.purchaseOrderId) {
        await lockRow(tx, 'purchase_orders', dto.purchaseOrderId);
        order = await tx.purchaseOrder.findFirst({ where: { id: dto.purchaseOrderId, companyId: me.companyId }, include: { items: true } });
        if (!order) throw new BadRequestException('Commande invalide');
        if (order.supplierId !== supplier.id || order.establishmentId !== est.id) {
          throw new BadRequestException('La commande ne correspond pas à ce fournisseur ou à cet établissement');
        }
        if (!['VALIDATED', 'PARTIALLY_RECEIVED'].includes(order.status)) {
          throw new ConflictException('Cette commande n’est pas réceptionnable (brouillon, annulée, clôturée ou déjà reçue)');
        }
      }

      const receipt = await tx.goodsReceipt.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          locationId: location.id,
          number: await nextNumber(tx, me.companyId, 'GOODS_RECEIPT', est),
          supplierId: supplier.id,
          purchaseOrderId: order?.id ?? null,
          supplierDocumentRef: dto.supplierDocumentRef ?? null,
          receivedAt,
          notes: dto.notes ?? null,
          totalValue: 0n,
          receivedById: me.userId,
          clientRequestId: dto.clientRequestId ?? null,
        },
      });

      let total = 0n;
      const seenOrderItems = new Set<string>();
      for (const line of dto.items) {
        const orderItem = line.orderItemId ? order?.items.find((i) => i.id === line.orderItemId) : undefined;
        if (order && !orderItem) throw new BadRequestException('Chaque ligne doit correspondre à une ligne de la commande');
        if (!order && line.orderItemId) throw new BadRequestException('Ligne de commande sans commande');
        if (orderItem) {
          if (seenOrderItems.has(orderItem.id)) throw new BadRequestException('Une ligne de commande apparaît deux fois');
          seenOrderItems.add(orderItem.id);
        }

        const item = orderItem ? { rawMaterialId: orderItem.rawMaterialId, productId: orderItem.productId } : itemOf(line);
        const info = await loadItem(tx, me.companyId, item, { purchasable: true });
        const label = orderItem?.purchaseUnitLabel ?? line.purchaseUnitLabel;
        const qpu = orderItem ? D(orderItem.quantityPerPurchaseUnit) : line.quantityPerPurchaseUnit !== undefined ? D(line.quantityPerPurchaseUnit) : null;
        if (!label || !qpu) throw new BadRequestException(`Unité d'achat et contenu requis pour « ${info.name} »`);

        // Contrôle : quantités refusées.
        const received = D(line.receivedQuantity);
        const rejected = D(line.rejectedQuantity ?? 0);
        if (rejected.gt(received)) throw new BadRequestException(`« ${info.name} » : refusé supérieur au reçu`);
        if (rejected.gt(0) && !line.rejectionReason) throw new BadRequestException(`« ${info.name} » : motif de refus obligatoire`);
        const accepted = received.sub(rejected);

        // Écarts avec la commande : motif obligatoire.
        if (orderItem) {
          const priceGap = BigInt(line.unitPrice) !== orderItem.unitPrice;
          const overQty = D(orderItem.receivedQuantity).add(accepted).gt(orderItem.orderedQuantity);
          if ((priceGap || overQty) && !line.varianceReason) {
            throw new BadRequestException(
              `« ${info.name} » : ${overQty ? 'quantité supérieure à la commande' : 'prix différent de la commande'} — motif obligatoire`,
            );
          }
        }

        // Péremption : obligatoire pour une matière périssable, jamais déjà dépassée.
        if (accepted.gt(0)) {
          if (info.isPerishable && !line.expiryDate) throw new BadRequestException(`« ${info.name} » est périssable : date d'expiration obligatoire`);
          if (line.expiryDate && line.expiryDate.slice(0, 10) < todayISO()) {
            throw new BadRequestException(`« ${info.name} » : produit déjà périmé, à refuser au contrôle`);
          }
        }

        const lineValue = BigInt(accepted.mul(line.unitPrice).toDecimalPlaces(0).toFixed(0));
        total += lineValue;
        const ri = await tx.goodsReceiptItem.create({
          data: {
            receiptId: receipt.id,
            orderItemId: orderItem?.id ?? null,
            ...item,
            purchaseUnitLabel: label,
            quantityPerPurchaseUnit: qpu,
            receivedQuantity: received,
            rejectedQuantity: rejected,
            acceptedQuantity: accepted,
            rejectionReason: line.rejectionReason ?? null,
            varianceReason: line.varianceReason ?? null,
            unitPrice: BigInt(line.unitPrice),
            orderedUnitPrice: orderItem?.unitPrice ?? null,
            lineValue,
            brand: line.brand ?? null,
            supplierLotRef: line.supplierLotRef ?? null,
            productionDate: line.productionDate ? dateOnly(line.productionDate) : null,
            expiryDate: line.expiryDate ? dateOnly(line.expiryDate) : null,
          },
        });

        if (accepted.gt(0)) {
          // Lot au coût réel : prix par unité d'achat ÷ contenu (ex. 18 500 / 25 kg = 740 FCFA/kg).
          const lot = await this.engine.createLot(tx, {
            companyId: me.companyId,
            item,
            origin: 'RECEIPT',
            unitCost: D(line.unitPrice).div(qpu),
            userId: me.userId,
            supplierId: supplier.id,
            brand: line.brand,
            supplierLotRef: line.supplierLotRef,
            productionDate: ri.productionDate,
            expiryDate: ri.expiryDate,
            receiptItemId: ri.id,
          });
          await this.engine.addToLot(
            tx,
            { companyId: me.companyId, establishmentId: est.id, locationId: location.id, type: 'RECEIPT', originType: 'GoodsReceipt', originId: receipt.id, userId: me.userId },
            lot,
            accepted.mul(qpu),
          );
        }
        if (orderItem && accepted.gt(0)) {
          await tx.purchaseOrderItem.update({ where: { id: orderItem.id }, data: { receivedQuantity: { increment: accepted } } });
        }
      }

      await tx.goodsReceipt.update({ where: { id: receipt.id }, data: { totalValue: total } });

      if (order) {
        const items = await tx.purchaseOrderItem.findMany({ where: { orderId: order.id } });
        const complete = items.every((i) => D(i.receivedQuantity).gte(i.orderedQuantity));
        await tx.purchaseOrder.update({ where: { id: order.id }, data: { status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED' } });
      }

      await this.audit.record(
        {
          action: order ? 'GOODS_RECEIVED' : 'GOODS_RECEIVED_DIRECT',
          entityType: 'GoodsReceipt',
          entityId: receipt.id,
          establishmentId: est.id,
          newValues: { number: receipt.number, supplierId: supplier.id, purchaseOrder: order?.number ?? null, totalValue: total, lines: dto.items.length },
        },
        tx,
      );
      return receipt.id;
    });
    return this.get(me, id);
  }

  // Retours fournisseurs -------------------------------------------------------

  async listReturns(me: AuthUser, q: ReceiptQuery) {
    const rows = await this.prisma.supplierReturn.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.scope(me, 'purchases.view', q.establishmentId) }, supplierId: q.supplierId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { items: true, creditNote: true, receipt: { select: { id: true, number: true } } },
    });
    const suppliers = await this.prisma.supplier.findMany({ where: { id: { in: rows.map((r) => r.supplierId) } }, select: { id: true, name: true } });
    return rows.map((r) => ({ ...r, supplier: suppliers.find((s) => s.id === r.supplierId) ?? null }));
  }

  /**
   * Retour au fournisseur : sortie des lots choisis (au coût du lot) et avoir
   * du même montant, éventuellement imputé sur une facture.
   */
  createReturn(me: AuthUser, dto: CreateReturnDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.supplierReturn
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((r) => r && { id: r.id, ownerId: r.createdById }),
      () => this.doCreateReturn(me, dto),
      (id) => this.prisma.supplierReturn.findUniqueOrThrow({ where: { id }, include: { creditNote: true } }),
    );
  }

  private async doCreateReturn(me: AuthUser, dto: CreateReturnDto) {
    return this.prisma.$transaction(async (tx) => {
      const est = await establishmentFor(tx, me, dto.establishmentId, 'purchases.receive');
      const location = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.locationId);
      const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, companyId: me.companyId } });
      if (!supplier) throw new BadRequestException('Fournisseur invalide');
      if (dto.receiptId) {
        const r = await tx.goodsReceipt.findFirst({ where: { id: dto.receiptId, companyId: me.companyId, supplierId: supplier.id } });
        if (!r) throw new BadRequestException('Réception invalide pour ce fournisseur');
      }
      const ret = await tx.supplierReturn.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          locationId: location.id,
          number: await nextNumber(tx, me.companyId, 'SUPPLIER_RETURN', est),
          supplierId: supplier.id,
          receiptId: dto.receiptId ?? null,
          reason: dto.reason,
          totalValue: 0n,
          createdById: me.userId,
          clientRequestId: dto.clientRequestId ?? null,
        },
      });
      let total = 0n;
      for (const line of dto.items) {
        const lot = await tx.stockLot.findFirst({ where: { id: line.lotId, companyId: me.companyId } });
        if (!lot) throw new BadRequestException('Lot invalide');
        if (lot.supplierId !== supplier.id) throw new BadRequestException(`Le lot ${lot.lotNumber} ne provient pas de ce fournisseur`);
        // Un retour n'est pas un « usage » : un lot périmé peut être rendu au fournisseur.
        const issued = await this.engine.issue(
          tx,
          { companyId: me.companyId, establishmentId: est.id, locationId: location.id, type: 'SUPPLIER_RETURN', originType: 'SupplierReturn', originId: ret.id, reason: dto.reason, userId: me.userId },
          { rawMaterialId: lot.rawMaterialId, productId: lot.productId },
          D(line.quantity),
          { lotId: lot.id, allowExpired: true },
        );
        for (const i of issued) {
          const value = BigInt(i.value.toDecimalPlaces(0).toFixed(0));
          total += value;
          await tx.supplierReturnItem.create({ data: { returnId: ret.id, lotId: i.lotId, quantity: i.quantity, unitCost: i.unitCost, value } });
        }
      }
      await tx.supplierReturn.update({ where: { id: ret.id }, data: { totalValue: total } });

      let invoiceId: string | null = null;
      if (dto.invoiceId) {
        await lockRow(tx, 'supplier_invoices', dto.invoiceId);
        const inv = await tx.supplierInvoice.findFirst({ where: { id: dto.invoiceId, companyId: me.companyId, supplierId: supplier.id } });
        if (!inv || inv.status === 'CANCELLED') throw new BadRequestException('Facture invalide pour ce fournisseur');
        if (inv.amount - inv.paidAmount < total) throw new BadRequestException('L’avoir dépasse le reste à payer de la facture');
        await tx.supplierInvoice.update({ where: { id: inv.id }, data: { paidAmount: { increment: total } } });
        await refreshInvoiceStatus(tx, inv.id);
        invoiceId = inv.id;
      }
      const credit = await tx.supplierCreditNote.create({
        data: {
          companyId: me.companyId,
          number: await nextNumber(tx, me.companyId, 'SUPPLIER_CREDIT_NOTE', est),
          supplierId: supplier.id,
          returnId: ret.id,
          invoiceId,
          amount: total,
        },
      });
      await this.audit.record(
        {
          action: 'SUPPLIER_RETURN_CREATED',
          entityType: 'SupplierReturn',
          entityId: ret.id,
          establishmentId: est.id,
          reason: dto.reason,
          newValues: { number: ret.number, supplierId: supplier.id, totalValue: total, creditNote: credit.number, invoiceId },
        },
        tx,
      );
      return { ...ret, totalValue: total, creditNote: credit };
    });
  }
}

@ApiTags('Réceptions')
@ApiBearerAuth()
@Controller()
export class ReceiptsController {
  constructor(private readonly service: ReceiptsService) {}

  @Get('goods-receipts')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser, @Query() q: ReceiptQuery) {
    return this.service.list(me, q);
  }

  @Get('goods-receipts/:id')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post('goods-receipts')
  @RequirePermissions('purchases.receive')
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateReceiptDto) {
    return this.service.create(me, dto);
  }

  @Get('supplier-returns')
  @RequirePermissions('purchases.view')
  @AnyEstablishmentScope()
  listReturns(@CurrentUser() me: AuthUser, @Query() q: ReceiptQuery) {
    return this.service.listReturns(me, q);
  }

  @Post('supplier-returns')
  @RequirePermissions('purchases.receive')
  @AnyEstablishmentScope()
  createReturn(@CurrentUser() me: AuthUser, @Body() dto: CreateReturnDto) {
    return this.service.createReturn(me, dto);
  }
}
