import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, StockMovementType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { attachItems, D, establishmentFor, isExpired, ItemDto, itemOf, itemWhere, loadItem, lockRow, readableEstablishments, userNames } from './common';
import { StockEngine } from './engine';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const bool = ({ value }: { value: unknown }) => value === 'true' || value === true;

class EstablishmentQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
}

export class CreateLocationDto {
  @IsUUID() establishmentId: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9_-]{2,20}$/, { message: 'Code : 2 à 20 caractères (majuscules, chiffres, - ou _), ex. FROID' })
  code: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name: string;
}

export class UpdateLocationDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class StockQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(['RAW_MATERIAL', 'PRODUCT']) kind?: 'RAW_MATERIAL' | 'PRODUCT';
  @IsOptional() @Transform(bool) @IsBoolean() belowAlert?: boolean;
}

class ItemDetailQuery extends ItemDto {
  @IsOptional() @IsUUID() establishmentId?: string;
}

class MovementQuery extends ItemDto {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() lotId?: string;
  @IsOptional() @IsEnum(StockMovementType) type?: StockMovementType;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize = 50;
}

export class ThresholdDto extends ItemDto {
  @IsUUID() establishmentId: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1e9) minQuantity: number;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1e9) alertQuantity: number;
}

export type StockStatus = 'OK' | 'ALERT' | 'CRITICAL' | 'NONE';

@Injectable()
export class StockViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
  ) {}

  private establishments(me: AuthUser, permission: string, requested?: string) {
    const ids = readableEstablishments(me, permission);
    if (requested) {
      if (!ids.includes(requested)) throw new BadRequestException('Établissement non accessible');
      return [requested];
    }
    return ids;
  }

  // --- Emplacements -----------------------------------------------------------

  async locations(me: AuthUser, q: EstablishmentQuery) {
    const ids = this.establishments(me, 'stock.view', q.establishmentId);
    await this.prisma.$transaction(async (tx) => {
      for (const id of ids) await this.engine.ensureDefaultLocation(tx, me.companyId, id);
    });
    const locations = await this.prisma.stockLocation.findMany({
      where: { companyId: me.companyId, establishmentId: { in: ids } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    const open = await this.prisma.inventorySession.findMany({ where: { locationId: { in: locations.map((l) => l.id) }, status: 'OPEN' } });
    return locations.map((l) => ({ ...l, openInventory: open.find((s) => s.locationId === l.id)?.number ?? null }));
  }

  async createLocation(me: AuthUser, dto: CreateLocationDto) {
    return this.prisma.$transaction(async (tx) => {
      await establishmentFor(tx, me, dto.establishmentId, 'stock.adjust');
      await this.engine.ensureDefaultLocation(tx, me.companyId, dto.establishmentId);
      const loc = await tx.stockLocation.create({ data: { ...dto, companyId: me.companyId } });
      await this.audit.record({ action: 'STOCK_LOCATION_CREATED', entityType: 'StockLocation', entityId: loc.id, establishmentId: loc.establishmentId, newValues: loc }, tx);
      return loc;
    });
  }

  async updateLocation(me: AuthUser, id: string, dto: UpdateLocationDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'stock_locations', id);
      const before = await tx.stockLocation.findFirst({ where: { id, companyId: me.companyId } });
      if (!before) throw new NotFoundException('Emplacement introuvable');
      await establishmentFor(tx, me, before.establishmentId, 'stock.adjust');
      if (dto.isActive === false) {
        if (before.isDefault) throw new ConflictException('L’emplacement par défaut ne peut pas être archivé');
        const stock = await tx.stockBalance.count({ where: { locationId: id, quantity: { gt: 0 } } });
        if (stock > 0) throw new ConflictException('Cet emplacement contient encore du stock : déplacez-le avant d’archiver');
      }
      const { oldValues, newValues, changed } = diff(before, dto);
      if (!changed) return before;
      const updated = await tx.stockLocation.update({ where: { id }, data: newValues });
      await this.audit.record({ action: 'STOCK_LOCATION_UPDATED', entityType: 'StockLocation', entityId: id, establishmentId: before.establishmentId, oldValues, newValues }, tx);
      return updated;
    });
  }

  // --- État du stock ------------------------------------------------------------

  /**
   * Stock par article et par établissement : physique, réservé, disponible,
   * part périmée, valeur, coût moyen, dernier coût d'achat, seuils et statut.
   */
  async items(me: AuthUser, q: StockQuery) {
    const ids = this.establishments(me, 'stock.view', q.establishmentId);
    if (!ids.length) return [];
    const balances = await this.prisma.stockBalance.findMany({
      where: { companyId: me.companyId, establishmentId: { in: ids }, quantity: { gt: 0 } },
      include: { lot: { select: { unitCost: true, expiryDate: true } } },
    });
    const thresholds = await this.prisma.stockThreshold.findMany({ where: { establishmentId: { in: ids } } });

    type Row = {
      establishmentId: string;
      rawMaterialId: string | null;
      productId: string | null;
      quantity: Prisma.Decimal;
      reserved: Prisma.Decimal;
      expired: Prisma.Decimal;
      value: Prisma.Decimal;
      lots: number;
      nextExpiry: Date | null;
    };
    const rows = new Map<string, Row>();
    const keyOf = (est: string, raw: string | null, prod: string | null) => `${est}|${raw ?? ''}|${prod ?? ''}`;
    const rowFor = (est: string, raw: string | null, prod: string | null) => {
      const k = keyOf(est, raw, prod);
      if (!rows.has(k)) {
        rows.set(k, { establishmentId: est, rawMaterialId: raw, productId: prod, quantity: D(0), reserved: D(0), expired: D(0), value: D(0), lots: 0, nextExpiry: null });
      }
      return rows.get(k)!;
    };
    for (const b of balances) {
      const r = rowFor(b.establishmentId, b.rawMaterialId, b.productId);
      r.quantity = r.quantity.add(b.quantity);
      r.reserved = r.reserved.add(b.reservedQuantity);
      r.value = r.value.add(D(b.quantity).mul(b.lot.unitCost));
      r.lots += 1;
      if (isExpired(b.lot.expiryDate)) r.expired = r.expired.add(b.quantity);
      else if (b.lot.expiryDate && (!r.nextExpiry || b.lot.expiryDate < r.nextExpiry)) r.nextExpiry = b.lot.expiryDate;
    }
    for (const t of thresholds) rowFor(t.establishmentId, t.rawMaterialId, t.productId);

    let list = await attachItems(this.prisma, [...rows.values()]);
    // Conditionnement par défaut des matières (affichage « en sacs »).
    const rawIds = list.map((r) => r.rawMaterialId).filter((x): x is string => !!x);
    const packagings = await this.prisma.rawMaterialPackaging.findMany({
      where: { rawMaterialId: { in: rawIds }, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { quantity: 'desc' }],
    });
    // Dernier coût d'achat (dernier lot reçu) par article.
    const lastLots = await this.prisma.stockLot.findMany({
      where: { companyId: me.companyId, origin: 'RECEIPT', OR: [{ rawMaterialId: { in: rawIds } }, { productId: { in: list.map((r) => r.productId).filter((x): x is string => !!x) } }] },
      orderBy: { createdAt: 'desc' },
      select: { rawMaterialId: true, productId: true, unitCost: true, createdAt: true },
    });

    if (q.search) {
      const s = q.search.toLowerCase();
      list = list.filter((r) => r.item && (r.item.name.toLowerCase().includes(s) || r.item.code.toLowerCase().includes(s)));
    }
    if (q.kind) list = list.filter((r) => (q.kind === 'RAW_MATERIAL' ? !!r.rawMaterialId : !!r.productId));

    const result = list.map((r) => {
      const t = thresholds.find((x) => x.establishmentId === r.establishmentId && x.rawMaterialId === r.rawMaterialId && x.productId === r.productId);
      const available = r.quantity.sub(r.reserved).sub(r.expired);
      let status: StockStatus = 'NONE';
      if (t) status = available.lte(t.minQuantity) ? 'CRITICAL' : available.lte(t.alertQuantity) ? 'ALERT' : 'OK';
      const pack = r.rawMaterialId ? packagings.find((p) => p.rawMaterialId === r.rawMaterialId) : undefined;
      const last = lastLots.find((l) => l.rawMaterialId === r.rawMaterialId && l.productId === r.productId);
      return {
        establishmentId: r.establishmentId,
        rawMaterialId: r.rawMaterialId,
        productId: r.productId,
        item: r.item,
        quantity: r.quantity,
        reserved: r.reserved,
        expired: r.expired,
        available: Prisma.Decimal.max(available, 0),
        value: r.value.toDecimalPlaces(0),
        averageCost: r.quantity.gt(0) ? r.value.div(r.quantity).toDecimalPlaces(2) : null,
        lastPurchaseCost: last ? D(last.unitCost) : null,
        lots: r.lots,
        nextExpiry: r.nextExpiry,
        packaging: pack ? { name: pack.name, quantity: pack.quantity, count: r.quantity.div(pack.quantity).toDecimalPlaces(2) } : null,
        minQuantity: t?.minQuantity ?? null,
        alertQuantity: t?.alertQuantity ?? null,
        status,
      };
    });
    const filtered = q.belowAlert ? result.filter((r) => r.status === 'ALERT' || r.status === 'CRITICAL') : result;
    return filtered.sort((a, b) => (a.item?.name ?? '').localeCompare(b.item?.name ?? '', 'fr'));
  }

  /** Lots d'un article (par emplacement), avec fournisseur, marque et péremption. */
  async itemDetail(me: AuthUser, q: ItemDetailQuery) {
    const item = itemOf(q);
    const info = await loadItem(this.prisma, me.companyId, item);
    const ids = this.establishments(me, 'stock.view', q.establishmentId);
    const balances = await this.prisma.stockBalance.findMany({
      where: { companyId: me.companyId, establishmentId: { in: ids }, ...itemWhere(item), quantity: { gt: 0 } },
      include: { lot: true, location: { select: { id: true, code: true, name: true } } },
      orderBy: [{ lot: { expiryDate: 'asc' } }, { lot: { createdAt: 'asc' } }],
    });
    // Derniers prix d'achat réels (10 dernières réceptions de l'article).
    const purchases = await this.prisma.goodsReceiptItem.findMany({
      where: { ...itemWhere(item), acceptedQuantity: { gt: 0 }, receipt: { companyId: me.companyId, establishmentId: { in: ids } } },
      orderBy: { receipt: { receivedAt: 'desc' } },
      take: 10,
      include: { receipt: { select: { id: true, number: true, receivedAt: true, supplierId: true } } },
    });
    const supplierIds = [
      ...new Set([...balances.map((b) => b.lot.supplierId), ...purchases.map((p) => p.receipt.supplierId)].filter((x): x is string => !!x)),
    ];
    const suppliers = await this.prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } });
    return {
      item: info,
      purchaseHistory: purchases.map((p) => ({
        receiptId: p.receipt.id,
        receiptNumber: p.receipt.number,
        receivedAt: p.receipt.receivedAt,
        supplier: suppliers.find((s) => s.id === p.receipt.supplierId) ?? null,
        brand: p.brand,
        purchaseUnitLabel: p.purchaseUnitLabel,
        quantityPerPurchaseUnit: p.quantityPerPurchaseUnit,
        acceptedQuantity: p.acceptedQuantity,
        unitPrice: p.unitPrice,
        unitCost: D(p.unitPrice.toString()).div(p.quantityPerPurchaseUnit).toDecimalPlaces(2),
      })),
      lots: balances.map((b) => ({
        balanceId: b.id,
        establishmentId: b.establishmentId,
        location: b.location,
        lotId: b.lot.id,
        lotNumber: b.lot.lotNumber,
        origin: b.lot.origin,
        brand: b.lot.brand,
        supplier: suppliers.find((s) => s.id === b.lot.supplierId) ?? null,
        supplierLotRef: b.lot.supplierLotRef,
        productionDate: b.lot.productionDate,
        expiryDate: b.lot.expiryDate,
        isExpired: isExpired(b.lot.expiryDate),
        unitCost: b.lot.unitCost,
        quantity: b.quantity,
        reserved: b.reservedQuantity,
        value: D(b.quantity).mul(b.lot.unitCost).toDecimalPlaces(0),
        receivedAt: b.lot.createdAt,
      })),
    };
  }

  async movements(me: AuthUser, q: MovementQuery) {
    const ids = this.establishments(me, 'stock.view', q.establishmentId);
    const where: Prisma.StockMovementWhereInput = {
      companyId: me.companyId,
      establishmentId: { in: ids },
      ...(q.rawMaterialId ? { rawMaterialId: q.rawMaterialId } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
      lotId: q.lotId,
      type: q.type,
      createdAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockMovement.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.stockMovement.count({ where }),
    ]);
    const [withItems, names, lots, locations] = await Promise.all([
      attachItems(this.prisma, rows),
      userNames(this.prisma, me.companyId, rows.map((r) => r.userId)),
      this.prisma.stockLot.findMany({ where: { id: { in: rows.map((r) => r.lotId) } }, select: { id: true, lotNumber: true } }),
      this.prisma.stockLocation.findMany({ where: { id: { in: rows.map((r) => r.locationId) } }, select: { id: true, name: true } }),
    ]);
    return {
      items: withItems.map((r) => ({
        ...r,
        lotNumber: lots.find((l) => l.id === r.lotId)?.lotNumber,
        locationName: locations.find((l) => l.id === r.locationId)?.name,
        userName: r.userId ? names.get(r.userId) ?? null : null,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async setThreshold(me: AuthUser, dto: ThresholdDto) {
    const item = itemOf(dto);
    if (dto.alertQuantity < dto.minQuantity) throw new BadRequestException('Le seuil d’alerte doit être supérieur ou égal au stock minimum');
    return this.prisma.$transaction(async (tx) => {
      await establishmentFor(tx, me, dto.establishmentId, 'stock.adjust');
      await loadItem(tx, me.companyId, item);
      const where = item.rawMaterialId
        ? { establishmentId_rawMaterialId: { establishmentId: dto.establishmentId, rawMaterialId: item.rawMaterialId } }
        : { establishmentId_productId: { establishmentId: dto.establishmentId, productId: item.productId! } };
      const before = await tx.stockThreshold.findUnique({ where });
      const data = { minQuantity: D(dto.minQuantity), alertQuantity: D(dto.alertQuantity) };
      const t = before
        ? await tx.stockThreshold.update({ where: { id: before.id }, data })
        : await tx.stockThreshold.create({ data: { ...data, ...item, companyId: me.companyId, establishmentId: dto.establishmentId } });
      await this.audit.record(
        {
          action: 'STOCK_THRESHOLD_SET',
          entityType: 'StockThreshold',
          entityId: t.id,
          establishmentId: dto.establishmentId,
          oldValues: before ? { minQuantity: before.minQuantity, alertQuantity: before.alertQuantity } : null,
          newValues: { ...item, minQuantity: dto.minQuantity, alertQuantity: dto.alertQuantity },
        },
        tx,
      );
      return t;
    });
  }
}

@ApiTags('Stock')
@ApiBearerAuth()
@Controller()
export class StockViewController {
  constructor(private readonly service: StockViewService) {}

  @Get('stock-locations')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  locations(@CurrentUser() me: AuthUser, @Query() q: EstablishmentQuery) {
    return this.service.locations(me, q);
  }

  @Post('stock-locations')
  @RequirePermissions('stock.adjust')
  @AnyEstablishmentScope()
  createLocation(@CurrentUser() me: AuthUser, @Body() dto: CreateLocationDto) {
    return this.service.createLocation(me, dto);
  }

  @Patch('stock-locations/:id')
  @RequirePermissions('stock.adjust')
  @AnyEstablishmentScope()
  updateLocation(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto) {
    return this.service.updateLocation(me, id, dto);
  }

  @Get('stock/items')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  items(@CurrentUser() me: AuthUser, @Query() q: StockQuery) {
    return this.service.items(me, q);
  }

  @Get('stock/item')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  itemDetail(@CurrentUser() me: AuthUser, @Query() q: ItemDetailQuery) {
    return this.service.itemDetail(me, q);
  }

  @Get('stock/movements')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  movements(@CurrentUser() me: AuthUser, @Query() q: MovementQuery) {
    return this.service.movements(me, q);
  }

  @Put('stock/thresholds')
  @RequirePermissions('stock.adjust')
  @AnyEstablishmentScope()
  setThreshold(@CurrentUser() me: AuthUser, @Body() dto: ThresholdDto) {
    return this.service.setThreshold(me, dto);
  }
}
