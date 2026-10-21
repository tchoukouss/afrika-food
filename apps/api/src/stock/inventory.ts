import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InventoryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { attachItems, D, establishmentFor, ItemDto, itemOf, itemWhere, loadItem, lockRow, nextNumber, readableEstablishments, userNames } from './common';
import { StockEngine } from './engine';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);

export class OpenInventoryDto {
  @IsUUID() establishmentId: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

export class CountDto {
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1e9) countedQuantity: number;
  /** Coût unitaire des quantités en plus (proposé, modifiable). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1e12) unitCost?: number | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) justification?: string | null;
}

export class CancelInventoryDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class InventoryQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsEnum(InventoryStatus) status?: InventoryStatus;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
  ) {}

  private scope(me: AuthUser, requested?: string) {
    const ids = readableEstablishments(me, 'stock.view');
    if (requested && !ids.includes(requested)) throw new BadRequestException('Établissement non accessible');
    return requested ? [requested] : ids;
  }

  async list(me: AuthUser, q: InventoryQuery) {
    const rows = await this.prisma.inventorySession.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.scope(me, q.establishmentId) }, status: q.status },
      orderBy: { openedAt: 'desc' },
      take: 100,
      include: { _count: { select: { items: true } } },
    });
    const locations = await this.prisma.stockLocation.findMany({ where: { id: { in: rows.map((r) => r.locationId) } }, select: { id: true, name: true } });
    return rows.map((r) => ({ ...r, locationName: locations.find((l) => l.id === r.locationId)?.name }));
  }

  async get(me: AuthUser, id: string) {
    const s = await this.prisma.inventorySession.findFirst({ where: { id, companyId: me.companyId }, include: { items: true } });
    if (!s || !this.scope(me).includes(s.establishmentId)) throw new NotFoundException('Inventaire introuvable');
    const [items, location, names] = await Promise.all([
      attachItems(this.prisma, s.items),
      this.prisma.stockLocation.findUnique({ where: { id: s.locationId }, select: { id: true, name: true } }),
      userNames(this.prisma, me.companyId, [s.openedById, s.closedById]),
    ]);
    return {
      ...s,
      location,
      openedBy: names.get(s.openedById) ?? null,
      closedBy: s.closedById ? names.get(s.closedById) ?? null : null,
      items: items
        .map((i) => {
          const gap = i.countedQuantity === null ? null : D(i.countedQuantity).sub(i.theoreticalQuantity);
          return { ...i, gap, gapValue: gap !== null && i.unitCost !== null && gap.gt(0) ? gap.mul(i.unitCost).toDecimalPlaces(0) : null };
        })
        .sort((a, b) => (a.item?.name ?? '').localeCompare(b.item?.name ?? '', 'fr')),
    };
  }

  /**
   * Ouverture : verrou exclusif sur l'emplacement (attend la fin des mouvements
   * en cours), photo du stock théorique, puis gel de l'emplacement.
   */
  async open(me: AuthUser, dto: OpenInventoryDto) {
    const id = await this.prisma.$transaction(async (tx) => {
      const est = await establishmentFor(tx, me, dto.establishmentId, 'inventory.manage');
      const location = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.locationId);
      await lockRow(tx, 'stock_locations', location.id);
      const open = await tx.inventorySession.findFirst({ where: { locationId: location.id, status: 'OPEN' } });
      if (open) throw new ConflictException(`Un inventaire est déjà en cours sur cet emplacement (${open.number})`);

      const balances = await tx.stockBalance.groupBy({
        by: ['rawMaterialId', 'productId'],
        where: { locationId: location.id, quantity: { gt: 0 } },
        _sum: { quantity: true },
      });
      const session = await tx.inventorySession.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          locationId: location.id,
          number: await nextNumber(tx, me.companyId, 'INVENTORY', est),
          notes: dto.notes ?? null,
          openedById: me.userId,
        },
      });
      for (const b of balances) {
        const item = { rawMaterialId: b.rawMaterialId, productId: b.productId };
        await tx.inventoryItem.create({
          data: {
            sessionId: session.id,
            ...item,
            theoreticalQuantity: b._sum.quantity ?? D(0),
            unitCost: await this.engine.suggestedUnitCost(tx, me.companyId, item),
          },
        });
      }
      await this.audit.record({ action: 'INVENTORY_OPENED', entityType: 'InventorySession', entityId: session.id, establishmentId: est.id, newValues: { number: session.number, location: location.name, items: balances.length } }, tx);
      return session.id;
    });
    return this.get(me, id);
  }

  private async openSession(tx: Tx, me: AuthUser, id: string, permission: string) {
    await lockRow(tx, 'inventory_sessions', id);
    const s = await tx.inventorySession.findFirst({ where: { id, companyId: me.companyId } });
    if (!s) throw new NotFoundException('Inventaire introuvable');
    await establishmentFor(tx, me, s.establishmentId, permission);
    if (s.status !== 'OPEN') throw new ConflictException('Cet inventaire est clôturé');
    return s;
  }

  /** Ajoute un article absent du stock théorique (trouvé au comptage). */
  async addItem(me: AuthUser, id: string, dto: ItemDto) {
    const item = itemOf(dto);
    await this.prisma.$transaction(async (tx) => {
      const s = await this.openSession(tx, me, id, 'inventory.manage');
      await loadItem(tx, me.companyId, item);
      const exists = await tx.inventoryItem.findFirst({ where: { sessionId: id, ...itemWhere(item) } });
      if (exists) throw new ConflictException('Article déjà présent dans cet inventaire');
      const current = await tx.stockBalance.aggregate({ where: { locationId: s.locationId, ...itemWhere(item) }, _sum: { quantity: true } });
      await tx.inventoryItem.create({
        data: {
          sessionId: id,
          ...item,
          theoreticalQuantity: current._sum.quantity ?? D(0),
          unitCost: await this.engine.suggestedUnitCost(tx, me.companyId, item),
        },
      });
    });
    return this.get(me, id);
  }

  async count(me: AuthUser, id: string, itemId: string, dto: CountDto) {
    await this.prisma.$transaction(async (tx) => {
      await this.openSession(tx, me, id, 'inventory.manage');
      const line = await tx.inventoryItem.findFirst({ where: { id: itemId, sessionId: id } });
      if (!line) throw new NotFoundException('Ligne d’inventaire introuvable');
      await tx.inventoryItem.update({
        where: { id: itemId },
        data: {
          countedQuantity: D(dto.countedQuantity),
          unitCost: dto.unitCost === undefined ? undefined : dto.unitCost === null ? null : D(dto.unitCost),
          justification: dto.justification,
          countedById: me.userId,
          countedAt: new Date(),
        },
      });
    });
    return this.get(me, id);
  }

  /**
   * Validation : chaque ligne comptée, chaque écart justifié, chaque surplus
   * valorisé. Les écarts deviennent des mouvements d'inventaire (sorties FEFO,
   * lots périmés compris ; entrées dans un nouveau lot au coût indiqué).
   */
  async validate(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.openSession(tx, me, id, 'inventory.validate');
      const items = await attachItems(tx, await tx.inventoryItem.findMany({ where: { sessionId: id } }));
      const problems: string[] = [];
      for (const i of items) {
        const name = i.item?.name ?? '?';
        if (i.countedQuantity === null) problems.push(`${name} : non compté`);
        else {
          const gap = D(i.countedQuantity).sub(i.theoreticalQuantity);
          if (!gap.isZero() && !i.justification) problems.push(`${name} : écart à justifier`);
          if (gap.gt(0) && i.unitCost === null) problems.push(`${name} : coût unitaire manquant pour le surplus`);
        }
      }
      if (problems.length) throw new BadRequestException(`Inventaire incomplet — ${problems.join(' ; ')}`);

      // Dégel avant d'appliquer les écarts (même transaction : rien ne s'intercale).
      await tx.inventorySession.update({ where: { id }, data: { status: 'VALIDATED', closedById: me.userId, closedAt: new Date() } });
      const base = { companyId: me.companyId, establishmentId: s.establishmentId, locationId: s.locationId, originType: 'InventorySession', originId: s.id, userId: me.userId };
      let gainValue = D(0);
      let lossValue = D(0);
      for (const i of items) {
        const item = { rawMaterialId: i.rawMaterialId, productId: i.productId };
        // Contrôle de cohérence : l'emplacement était gelé, le théorique ne peut pas avoir bougé.
        const current = await tx.stockBalance.aggregate({ where: { locationId: s.locationId, ...itemWhere(item) }, _sum: { quantity: true } });
        if (!D(current._sum.quantity ?? 0).eq(i.theoreticalQuantity)) {
          throw new ConflictException(`Stock de « ${i.item?.name} » modifié pendant l’inventaire : annulez et recommencez`);
        }
        const gap = D(i.countedQuantity!).sub(i.theoreticalQuantity);
        if (gap.gt(0)) {
          const lot = await this.engine.createLot(tx, { companyId: me.companyId, item, origin: 'INVENTORY', unitCost: D(i.unitCost!), userId: me.userId });
          await this.engine.addToLot(tx, { ...base, type: 'INVENTORY_GAIN', reason: i.justification }, lot, gap);
          gainValue = gainValue.add(gap.mul(i.unitCost!));
        } else if (gap.lt(0)) {
          const issued = await this.engine.issue(tx, { ...base, type: 'INVENTORY_LOSS', reason: i.justification }, item, gap.neg(), { allowExpired: true, itemName: i.item?.name });
          lossValue = lossValue.add(issued.reduce((sum, x) => sum.add(x.value), D(0)));
        }
      }
      await this.audit.record(
        {
          action: 'INVENTORY_VALIDATED',
          entityType: 'InventorySession',
          entityId: id,
          establishmentId: s.establishmentId,
          newValues: { number: s.number, lines: items.length, gainValue: gainValue.toDecimalPlaces(0), lossValue: lossValue.toDecimalPlaces(0) },
        },
        tx,
      );
    });
    return this.get(me, id);
  }

  async cancel(me: AuthUser, id: string, dto: CancelInventoryDto) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.openSession(tx, me, id, 'inventory.validate');
      await tx.inventorySession.update({ where: { id }, data: { status: 'CANCELLED', closedById: me.userId, closedAt: new Date(), notes: [s.notes, `Annulé : ${dto.reason}`].filter(Boolean).join('\n') } });
      await this.audit.record({ action: 'INVENTORY_CANCELLED', entityType: 'InventorySession', entityId: id, establishmentId: s.establishmentId, reason: dto.reason }, tx);
    });
    return this.get(me, id);
  }
}

@ApiTags('Inventaires')
@ApiBearerAuth()
@Controller('inventories')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Get()
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser, @Query() q: InventoryQuery) {
    return this.service.list(me, q);
  }

  @Get(':id')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post()
  @RequirePermissions('inventory.manage')
  @AnyEstablishmentScope()
  open(@CurrentUser() me: AuthUser, @Body() dto: OpenInventoryDto) {
    return this.service.open(me, dto);
  }

  @Post(':id/items')
  @RequirePermissions('inventory.manage')
  @AnyEstablishmentScope()
  addItem(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ItemDto) {
    return this.service.addItem(me, id, dto);
  }

  @Put(':id/items/:itemId')
  @RequirePermissions('inventory.manage')
  @AnyEstablishmentScope()
  count(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: CountDto) {
    return this.service.count(me, id, itemId, dto);
  }

  @Post(':id/validate')
  @RequirePermissions('inventory.validate')
  @AnyEstablishmentScope()
  validate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.validate(me, id);
  }

  @Post(':id/cancel')
  @RequirePermissions('inventory.validate')
  @AnyEstablishmentScope()
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelInventoryDto) {
    return this.service.cancel(me, id, dto);
  }
}

