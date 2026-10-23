import { Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TableState } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { D, userNames } from '../stock/common';
import { assertAny, RESERVATION_AFTER_MS, RESERVATION_BEFORE_MS, readableWith, restaurantEstablishment, roundXof, tableStatus, trim } from './common';

const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class AreaDto {
  @IsUUID() establishmentId: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) name: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateAreaDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class TableDto {
  @IsUUID() areaId: string;
  @Transform(upper) @Matches(/^[A-Z0-9-]{1,10}$/, { message: 'Code de table : 1 à 10 caractères (lettres, chiffres, tiret)' }) code: string;
  @IsInt() @Min(1) @Max(100) capacity: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateTableDto {
  @IsOptional() @IsUUID() areaId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) capacity?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class TableStateDto {
  @IsEnum(TableState) state: TableState;
}

class FloorQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
}

@Injectable()
export class FloorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Plan de salle : zones, tables, statut calculé et commande en cours (décision R8). */
  async floor(me: AuthUser, q: FloorQuery) {
    const ests = readableWith(me, ['restaurant.orders', 'restaurant.tables'], q.establishmentId);
    const [areas, tables] = await Promise.all([
      this.prisma.restaurantArea.findMany({ where: { companyId: me.companyId, establishmentId: { in: ests } }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.restaurantTable.findMany({ where: { companyId: me.companyId, establishmentId: { in: ests } }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
    ]);
    const now = Date.now();
    const [orders, reservations] = await Promise.all([
      this.prisma.restaurantOrder.findMany({
        where: { tableId: { in: tables.map((t) => t.id) }, status: 'OPEN' },
        include: { items: { select: { status: true, unitPrice: true, quantity: true, cancelledQuantity: true } }, bills: { where: { status: 'OPEN' }, select: { id: true } } },
      }),
      this.prisma.restaurantReservation.findMany({
        where: {
          tableId: { in: tables.map((t) => t.id) },
          status: 'CONFIRMED',
          reservedAt: { gte: new Date(now - RESERVATION_AFTER_MS), lte: new Date(now + RESERVATION_BEFORE_MS) },
        },
        orderBy: { reservedAt: 'asc' },
      }),
    ]);
    const names = await userNames(this.prisma, me.companyId, orders.map((o) => o.waiterId));
    return areas.map((a) => ({
      ...a,
      tables: tables
        .filter((t) => t.areaId === a.id)
        .map((t) => {
          const o = orders.find((x) => x.tableId === t.id);
          const r = reservations.find((x) => x.tableId === t.id) ?? null;
          const sentCount = o?.items.filter((i) => !['DRAFT', 'REMOVED'].includes(i.status)).length ?? 0;
          return {
            ...t,
            status: tableStatus(t.state, o ? { sentCount, openBills: o.bills.length } : null, !!r),
            reservation: r && { id: r.id, name: r.name, covers: r.covers, reservedAt: r.reservedAt },
            order: o && {
              id: o.id,
              number: o.number,
              covers: o.covers,
              createdAt: o.createdAt,
              waiter: names.get(o.waiterId) ?? null,
              total: o.items
                .filter((i) => !['REMOVED', 'CANCELLED'].includes(i.status))
                .reduce((s, i) => s + roundXof(D(i.unitPrice.toString()).mul(D(i.quantity).sub(i.cancelledQuantity))), 0n),
            },
          };
        }),
    }));
  }

  async createArea(me: AuthUser, dto: AreaDto) {
    await restaurantEstablishment(this.prisma, me, dto.establishmentId, 'restaurant.tables');
    if (await this.prisma.restaurantArea.findFirst({ where: { establishmentId: dto.establishmentId, name: dto.name } })) throw new ConflictException('Cette zone existe déjà');
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.restaurantArea.create({ data: { companyId: me.companyId, establishmentId: dto.establishmentId, name: dto.name, sortOrder: dto.sortOrder ?? 0 } });
      await this.audit.record({ action: 'RESTAURANT_AREA_CREATED', entityType: 'RestaurantArea', entityId: a.id, establishmentId: a.establishmentId, newValues: a }, tx);
      return a;
    });
  }

  async updateArea(me: AuthUser, id: string, dto: UpdateAreaDto) {
    const a = await this.prisma.restaurantArea.findFirst({ where: { id, companyId: me.companyId } });
    if (!a) throw new NotFoundException('Zone introuvable');
    assertAny(me, a.establishmentId, 'restaurant.tables');
    const { oldValues, newValues, changed } = diff(a as unknown as Record<string, unknown>, { ...dto });
    if (!changed) return a;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.restaurantArea.update({ where: { id }, data: dto });
      await this.audit.record({ action: 'RESTAURANT_AREA_UPDATED', entityType: 'RestaurantArea', entityId: id, establishmentId: a.establishmentId, oldValues, newValues }, tx);
      return updated;
    });
  }

  async createTable(me: AuthUser, dto: TableDto) {
    const area = await this.prisma.restaurantArea.findFirst({ where: { id: dto.areaId, companyId: me.companyId } });
    if (!area) throw new NotFoundException('Zone introuvable');
    await restaurantEstablishment(this.prisma, me, area.establishmentId, 'restaurant.tables');
    if (await this.prisma.restaurantTable.findFirst({ where: { establishmentId: area.establishmentId, code: dto.code } })) throw new ConflictException(`La table « ${dto.code} » existe déjà`);
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.restaurantTable.create({
        data: { companyId: me.companyId, establishmentId: area.establishmentId, areaId: area.id, code: dto.code, capacity: dto.capacity, sortOrder: dto.sortOrder ?? 0 },
      });
      await this.audit.record({ action: 'RESTAURANT_TABLE_CREATED', entityType: 'RestaurantTable', entityId: t.id, establishmentId: t.establishmentId, newValues: t }, tx);
      return t;
    });
  }

  async updateTable(me: AuthUser, id: string, dto: UpdateTableDto) {
    const t = await this.prisma.restaurantTable.findFirst({ where: { id, companyId: me.companyId } });
    if (!t) throw new NotFoundException('Table introuvable');
    assertAny(me, t.establishmentId, 'restaurant.tables');
    if (dto.areaId) {
      const area = await this.prisma.restaurantArea.findFirst({ where: { id: dto.areaId, establishmentId: t.establishmentId } });
      if (!area) throw new NotFoundException('Zone introuvable');
    }
    if (dto.isActive === false && (await this.prisma.restaurantOrder.count({ where: { tableId: id, status: 'OPEN' } }))) {
      throw new ConflictException('Une commande est ouverte sur cette table');
    }
    const { oldValues, newValues, changed } = diff(t as unknown as Record<string, unknown>, { ...dto });
    if (!changed) return t;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.restaurantTable.update({ where: { id }, data: dto });
      await this.audit.record({ action: 'RESTAURANT_TABLE_UPDATED', entityType: 'RestaurantTable', entityId: id, establishmentId: t.establishmentId, oldValues, newValues }, tx);
      return updated;
    });
  }

  /**
   * État manuel : nettoyage et retour à « libre » par le personnel de salle ;
   * hors service (et sa levée) par le responsable des tables (décision R29).
   */
  async setState(me: AuthUser, id: string, dto: TableStateDto) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM restaurant_tables WHERE id = ${id}::uuid FOR UPDATE`;
      const t = await tx.restaurantTable.findFirst({ where: { id, companyId: me.companyId } });
      if (!t) throw new NotFoundException('Table introuvable');
      const outOfService = dto.state === 'OUT_OF_SERVICE' || t.state === 'OUT_OF_SERVICE';
      assertAny(me, t.establishmentId, ...(outOfService ? ['restaurant.tables'] : ['restaurant.orders', 'restaurant.tables']));
      if (t.state === dto.state) return t;
      if (dto.state === 'OUT_OF_SERVICE' && (await tx.restaurantOrder.count({ where: { tableId: id, status: 'OPEN' } }))) {
        throw new ConflictException('Une commande est ouverte sur cette table');
      }
      const updated = await tx.restaurantTable.update({ where: { id }, data: { state: dto.state } });
      await this.audit.record(
        { action: 'RESTAURANT_TABLE_STATE', entityType: 'RestaurantTable', entityId: id, establishmentId: t.establishmentId, oldValues: { state: t.state }, newValues: { state: dto.state } },
        tx,
      );
      return updated;
    });
  }
}

@ApiTags('Restaurant')
@ApiBearerAuth()
@Controller('restaurant')
export class FloorController {
  constructor(private readonly service: FloorService) {}

  @Get('floor')
  floor(@CurrentUser() me: AuthUser, @Query() q: FloorQuery) {
    return this.service.floor(me, q);
  }

  @Post('areas')
  @RequirePermissions('restaurant.tables')
  @AnyEstablishmentScope()
  createArea(@CurrentUser() me: AuthUser, @Body() dto: AreaDto) {
    return this.service.createArea(me, dto);
  }

  @Patch('areas/:id')
  @RequirePermissions('restaurant.tables')
  @AnyEstablishmentScope()
  updateArea(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAreaDto) {
    return this.service.updateArea(me, id, dto);
  }

  @Post('tables')
  @RequirePermissions('restaurant.tables')
  @AnyEstablishmentScope()
  createTable(@CurrentUser() me: AuthUser, @Body() dto: TableDto) {
    return this.service.createTable(me, dto);
  }

  @Patch('tables/:id')
  @RequirePermissions('restaurant.tables')
  @AnyEstablishmentScope()
  updateTable(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTableDto) {
    return this.service.updateTable(me, id, dto);
  }

  @Post('tables/:id/state')
  setState(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TableStateDto) {
    return this.service.setState(me, id, dto);
  }
}
