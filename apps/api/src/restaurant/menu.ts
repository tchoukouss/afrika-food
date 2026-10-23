import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PreparationMode, PrinterType, StationKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { StockEngine } from '../stock/engine';
import { assertAny, currentPrices, emptyToNull, PRIVATE_IPV4, readableWith, restaurantEstablishment, trim } from './common';

const PRINTER_IP = { message: 'Adresse IP de l’imprimante : réseau local uniquement (ex. 192.168.1.60)' };

export class StationDto {
  @IsUUID() establishmentId: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) name: string;
  @IsEnum(StationKind) kind: StationKind;
  /** Emplacement de stock consommé (par défaut : Magasin principal). */
  @IsOptional() @IsUUID() stockLocationId?: string;
  @IsOptional() @IsEnum(PrinterType) printerType?: PrinterType;
  @IsOptional() @Transform(emptyToNull) @Matches(PRIVATE_IPV4, PRINTER_IP) printerHost?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(65535) printerPort?: number;
  @IsOptional() @IsIn([58, 80]) paperWidth?: number;
}

export class UpdateStationDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsUUID() stockLocationId?: string;
  @IsOptional() @IsEnum(PrinterType) printerType?: PrinterType;
  @IsOptional() @Transform(emptyToNull) @Matches(PRIVATE_IPV4, PRINTER_IP) printerHost?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(65535) printerPort?: number;
  @IsOptional() @IsIn([58, 80]) paperWidth?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class MenuItemDto {
  @IsUUID() establishmentId: string;
  @IsUUID() productId: string;
  @IsOptional() @IsEnum(PreparationMode) preparation?: PreparationMode;
  @IsOptional() @IsUUID() stationId?: string | null;
  @IsOptional() @IsBoolean() isSupplement?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class OptionDto {
  @IsUUID() establishmentId: string;
  @IsUUID() productId: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) label: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class UpdateOptionDto {
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

class EstQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
}

@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
  ) {}

  // --- Postes ---------------------------------------------------------------------

  listStations(me: AuthUser, q: EstQuery) {
    const ests = readableWith(me, ['restaurant.tables', 'restaurant.kitchen', 'restaurant.orders'], q.establishmentId);
    return this.prisma.restaurantStation.findMany({ where: { companyId: me.companyId, establishmentId: { in: ests } }, orderBy: { name: 'asc' } });
  }

  async createStation(me: AuthUser, dto: StationDto) {
    const est = await restaurantEstablishment(this.prisma, me, dto.establishmentId, 'restaurant.tables');
    if ((dto.printerType ?? 'NONE') === 'NETWORK' && !dto.printerHost) throw new BadRequestException('Adresse IP obligatoire pour une imprimante réseau');
    if (await this.prisma.restaurantStation.findFirst({ where: { establishmentId: est.id, name: dto.name } })) throw new ConflictException('Ce poste existe déjà');
    return this.prisma.$transaction(async (tx) => {
      const location = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.stockLocationId);
      const s = await tx.restaurantStation.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          name: dto.name,
          kind: dto.kind,
          stockLocationId: location.id,
          printerType: dto.printerType ?? 'NONE',
          printerHost: dto.printerHost ?? null,
          printerPort: dto.printerPort ?? 9100,
          paperWidth: dto.paperWidth ?? 80,
        },
      });
      await this.audit.record({ action: 'RESTAURANT_STATION_CREATED', entityType: 'RestaurantStation', entityId: s.id, establishmentId: est.id, newValues: s }, tx);
      return s;
    });
  }

  async updateStation(me: AuthUser, id: string, dto: UpdateStationDto) {
    const s = await this.prisma.restaurantStation.findFirst({ where: { id, companyId: me.companyId } });
    if (!s) throw new NotFoundException('Poste introuvable');
    assertAny(me, s.establishmentId, 'restaurant.tables');
    if ((dto.printerType ?? s.printerType) === 'NETWORK' && !(dto.printerHost === undefined ? s.printerHost : dto.printerHost)) {
      throw new BadRequestException('Adresse IP obligatoire pour une imprimante réseau');
    }
    return this.prisma.$transaction(async (tx) => {
      const data = { ...dto };
      if (dto.stockLocationId) data.stockLocationId = (await this.engine.resolveLocation(tx, me.companyId, s.establishmentId, dto.stockLocationId)).id;
      const { oldValues, newValues, changed } = diff(s as unknown as Record<string, unknown>, data);
      if (!changed) return s;
      const updated = await tx.restaurantStation.update({ where: { id }, data });
      await this.audit.record({ action: 'RESTAURANT_STATION_UPDATED', entityType: 'RestaurantStation', entityId: id, establishmentId: s.establishmentId, oldValues, newValues }, tx);
      return updated;
    });
  }

  // --- Carte ----------------------------------------------------------------------

  /** Ajoute ou met à jour un produit de la carte (décisions R5 et R6). */
  async upsertMenuItem(me: AuthUser, dto: MenuItemDto) {
    const est = await restaurantEstablishment(this.prisma, me, dto.establishmentId, 'restaurant.tables');
    const product = await this.prisma.product.findFirst({ where: { id: dto.productId, companyId: me.companyId } });
    if (!product) throw new NotFoundException('Produit introuvable');
    const preparation = product.type === 'MENU' ? 'FROM_STOCK' : dto.preparation ?? 'FROM_STOCK';
    if (preparation === 'TO_ORDER') {
      if (product.type !== 'MANUFACTURED') throw new BadRequestException('Seul un produit fabriqué se prépare à la commande');
      const recipe = await this.prisma.recipe.findUnique({ where: { productId: product.id } });
      if (!recipe?.activeVersionId) throw new ConflictException(`« ${product.name} » n’a pas de recette active : il ne peut pas être préparé à la commande`);
    }
    if (dto.stationId && !(await this.prisma.restaurantStation.findFirst({ where: { id: dto.stationId, establishmentId: est.id } }))) {
      throw new BadRequestException('Poste invalide pour cet établissement');
    }
    const data = {
      preparation: preparation as PreparationMode,
      stationId: dto.stationId === undefined ? undefined : dto.stationId,
      isSupplement: dto.isSupplement,
      sortOrder: dto.sortOrder,
      isActive: dto.isActive,
    };
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.restaurantMenuItem.findUnique({ where: { establishmentId_productId: { establishmentId: est.id, productId: product.id } } });
      if (!current) {
        const created = await tx.restaurantMenuItem.create({
          data: { companyId: me.companyId, establishmentId: est.id, productId: product.id, ...data, stationId: dto.stationId ?? null },
        });
        await this.audit.record({ action: 'RESTAURANT_MENU_ITEM_ADDED', entityType: 'RestaurantMenuItem', entityId: created.id, establishmentId: est.id, newValues: { product: product.name, ...data } }, tx);
        return created;
      }
      const { oldValues, newValues, changed } = diff(current as unknown as Record<string, unknown>, data);
      if (!changed) return current;
      const updated = await tx.restaurantMenuItem.update({ where: { id: current.id }, data });
      await this.audit.record({ action: 'RESTAURANT_MENU_ITEM_UPDATED', entityType: 'RestaurantMenuItem', entityId: current.id, establishmentId: est.id, oldValues, newValues }, tx);
      return updated;
    });
  }

  /** Carte de l'établissement : prix en vigueur, disponibilité, options, poste. */
  async menu(me: AuthUser, q: EstQuery) {
    const estId = q.establishmentId ?? me.establishmentId;
    if (!estId) throw new BadRequestException('Choisissez un établissement');
    await restaurantEstablishment(this.prisma, me, estId, 'restaurant.orders', 'restaurant.tables', 'restaurant.kitchen');
    const items = await this.prisma.restaurantMenuItem.findMany({ where: { establishmentId: estId }, orderBy: [{ sortOrder: 'asc' }] });
    const ids = items.map((i) => i.productId);
    const [products, prices, unavailable, options, stations] = await Promise.all([
      this.prisma.product.findMany({ where: { id: { in: ids } }, include: { category: { select: { id: true, name: true, color: true, sortOrder: true } } } }),
      currentPrices(this.prisma, ids, estId),
      this.prisma.productAvailability.findMany({ where: { productId: { in: ids }, establishmentId: estId, isAvailable: false } }),
      this.prisma.restaurantOption.findMany({ where: { establishmentId: estId, productId: { in: ids } }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] }),
      this.prisma.restaurantStation.findMany({ where: { establishmentId: estId } }),
    ]);
    return items.map((i) => {
      const p = products.find((x) => x.id === i.productId)!;
      return {
        ...i,
        product: { id: p.id, code: p.code, name: p.name, type: p.type, isActive: p.isActive, category: p.category, taxRate: p.taxRate },
        price: prices.get(p.id) ?? null,
        isAvailable: i.isActive && p.isActive && !unavailable.some((u) => u.productId === p.id) && prices.has(p.id),
        station: stations.find((s) => s.id === i.stationId) ?? null,
        options: options.filter((o) => o.productId === p.id),
      };
    });
  }

  // --- Options --------------------------------------------------------------------

  async createOption(me: AuthUser, dto: OptionDto) {
    const est = await restaurantEstablishment(this.prisma, me, dto.establishmentId, 'restaurant.tables');
    if (!(await this.prisma.restaurantMenuItem.findFirst({ where: { establishmentId: est.id, productId: dto.productId } }))) {
      throw new BadRequestException('Ajoutez d’abord ce produit à la carte');
    }
    if (await this.prisma.restaurantOption.findFirst({ where: { establishmentId: est.id, productId: dto.productId, label: dto.label } })) throw new ConflictException('Cette option existe déjà');
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.restaurantOption.create({ data: { companyId: me.companyId, establishmentId: est.id, productId: dto.productId, label: dto.label, sortOrder: dto.sortOrder ?? 0 } });
      await this.audit.record({ action: 'RESTAURANT_OPTION_CREATED', entityType: 'RestaurantOption', entityId: o.id, establishmentId: est.id, newValues: o }, tx);
      return o;
    });
  }

  async updateOption(me: AuthUser, id: string, dto: UpdateOptionDto) {
    const o = await this.prisma.restaurantOption.findFirst({ where: { id, companyId: me.companyId } });
    if (!o) throw new NotFoundException('Option introuvable');
    assertAny(me, o.establishmentId, 'restaurant.tables');
    const { oldValues, newValues, changed } = diff(o as unknown as Record<string, unknown>, { ...dto });
    if (!changed) return o;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.restaurantOption.update({ where: { id }, data: dto });
      await this.audit.record({ action: 'RESTAURANT_OPTION_UPDATED', entityType: 'RestaurantOption', entityId: id, establishmentId: o.establishmentId, oldValues, newValues }, tx);
      return updated;
    });
  }
}

@ApiTags('Restaurant')
@ApiBearerAuth()
@Controller('restaurant')
export class MenuController {
  constructor(private readonly service: MenuService) {}

  @Get('stations')
  listStations(@CurrentUser() me: AuthUser, @Query() q: EstQuery) {
    return this.service.listStations(me, q);
  }

  @Post('stations')
  @RequirePermissions('restaurant.tables')
  @AnyEstablishmentScope()
  createStation(@CurrentUser() me: AuthUser, @Body() dto: StationDto) {
    return this.service.createStation(me, dto);
  }

  @Patch('stations/:id')
  @RequirePermissions('restaurant.tables')
  @AnyEstablishmentScope()
  updateStation(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStationDto) {
    return this.service.updateStation(me, id, dto);
  }

  @Get('menu')
  menu(@CurrentUser() me: AuthUser, @Query() q: EstQuery) {
    return this.service.menu(me, q);
  }

  @Put('menu')
  @RequirePermissions('restaurant.tables')
  @AnyEstablishmentScope()
  upsertMenuItem(@CurrentUser() me: AuthUser, @Body() dto: MenuItemDto) {
    return this.service.upsertMenuItem(me, dto);
  }

  @Post('options')
  @RequirePermissions('restaurant.tables')
  @AnyEstablishmentScope()
  createOption(@CurrentUser() me: AuthUser, @Body() dto: OptionDto) {
    return this.service.createOption(me, dto);
  }

  @Patch('options/:id')
  @RequirePermissions('restaurant.tables')
  @AnyEstablishmentScope()
  updateOption(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOptionDto) {
    return this.service.updateOption(me, id, dto);
  }
}
