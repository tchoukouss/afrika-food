import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, ProductType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, GroupScope, RequirePermissions } from '../auth/decorators';
import { Db, PrismaService, Tx } from '../prisma/prisma.service';
import {
  assertEstablishmentPermission,
  CODE_MESSAGE,
  CODE_RE,
  emptyToNull,
  lockRow,
  MAX_AMOUNT,
  MAX_QUANTITY,
  pricePerBaseUnit,
  toDecimal,
  trim,
  upper,
} from './common';

export class ComponentDto {
  @IsUUID() productId: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(MAX_QUANTITY) quantity: number;
}

export class CreateProductDto {
  @Transform(upper) @Matches(CODE_RE, { message: CODE_MESSAGE }) code: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsOptional() @IsUUID() categoryId?: string | null;
  @IsEnum(ProductType) type: ProductType;
  /** Unité de vente : U (pièce), KG (au poids), L… */
  @IsOptional() @IsString() @MaxLength(4) saleUnitCode?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @Matches(/^[0-9A-Za-z-]{4,32}$/, { message: 'Code-barres invalide' }) barcode?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsUrl({}, { message: 'URL de photo invalide' }) imageUrl?: string | null;
  /** Taux de TVA inclus dans le prix TTC, en %. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) taxRate?: number;
  /** Prix de vente TTC de base (groupe), en FCFA. Exige la permission prices.manage au niveau groupe. */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) basePrice?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ComponentDto) components?: ComponentDto[];
}

export class UpdateProductDto {
  @IsOptional() @Transform(upper) @Matches(CODE_RE, { message: CODE_MESSAGE }) code?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsUUID() categoryId?: string | null;
  @IsOptional() @IsEnum(ProductType) type?: ProductType;
  @IsOptional() @IsString() @MaxLength(4) saleUnitCode?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @Matches(/^[0-9A-Za-z-]{4,32}$/, { message: 'Code-barres invalide' }) barcode?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsUrl({}, { message: 'URL de photo invalide' }) imageUrl?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) taxRate?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class SetPriceDto {
  @IsInt() @Min(0) @Max(MAX_AMOUNT) price: number;
  /** Absent ou null = prix de base du groupe. */
  @IsOptional() @IsUUID() establishmentId?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) reason?: string | null;
}

export class AvailabilityDto {
  @IsUUID() establishmentId: string;
  @IsBoolean() isAvailable: boolean;
}

export class SetComponentsDto {
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ComponentDto) components: ComponentDto[];
}

class ProductQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsEnum(ProductType) type?: ProductType;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeInactive?: boolean;
}

class HistoryQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
}

type CurrentPrices = Map<string, { base: bigint | null; local: bigint | null }>;

/** Prix en vigueur (base groupe + éventuelle exception de l'établissement) pour une liste de produits. */
async function currentPrices(db: Db, productIds: string[], establishmentId?: string): Promise<CurrentPrices> {
  const rows = await db.productPrice.findMany({
    where: {
      productId: { in: productIds },
      validTo: null,
      OR: [{ establishmentId: null }, ...(establishmentId ? [{ establishmentId }] : [])],
    },
  });
  const map: CurrentPrices = new Map(productIds.map((id) => [id, { base: null, local: null }]));
  for (const r of rows) {
    const entry = map.get(r.productId)!;
    if (r.establishmentId === null) entry.base = r.price;
    else entry.local = r.price;
  }
  return map;
}

const listInclude = {
  category: { select: { id: true, name: true, color: true } },
  saleUnit: true,
  _count: { select: { menuComponents: true, supplierProducts: { where: { isActive: true } } } },
} satisfies Prisma.ProductInclude;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Liste des produits avec le prix applicable dans l'établissement de travail
   * (exception locale sinon prix de base) et la disponibilité locale.
   */
  async list(me: AuthUser, q: ProductQuery) {
    const products = await this.prisma.product.findMany({
      where: {
        companyId: me.companyId,
        ...(q.includeInactive ? {} : { isActive: true }),
        categoryId: q.categoryId,
        type: q.type,
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' } },
                { code: { contains: q.search, mode: 'insensitive' } },
                { barcode: q.search },
              ],
            }
          : {}),
      },
      orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
      include: listInclude,
    });
    const ids = products.map((p) => p.id);
    const prices = await currentPrices(this.prisma, ids, me.establishmentId);
    const unavailable = me.establishmentId
      ? new Set(
          (
            await this.prisma.productAvailability.findMany({
              where: { productId: { in: ids }, establishmentId: me.establishmentId, isAvailable: false },
              select: { productId: true },
            })
          ).map((a) => a.productId),
        )
      : new Set<string>();
    return products.map((p) => {
      const { base, local } = prices.get(p.id)!;
      return {
        ...p,
        basePrice: base,
        localPrice: local,
        price: local ?? base,
        isAvailable: !unavailable.has(p.id),
      };
    });
  }

  async get(me: AuthUser, id: string) {
    const p = await this.prisma.product.findFirst({
      where: { id, companyId: me.companyId },
      include: {
        ...listInclude,
        menuComponents: { include: { component: { select: { id: true, code: true, name: true, type: true, isActive: true } } } },
        usedInMenus: { include: { menu: { select: { id: true, code: true, name: true } } } },
        supplierProducts: {
          where: { isActive: true },
          orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
          include: { supplier: { select: { id: true, code: true, name: true } } },
        },
      },
    });
    if (!p) throw new NotFoundException('Produit introuvable');

    // Prix et disponibilité par établissement, limités aux établissements accessibles.
    const establishments = await this.prisma.establishment.findMany({
      where: { id: { in: me.access.establishmentIds } },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true },
    });
    const [current, availability] = await Promise.all([
      this.prisma.productPrice.findMany({ where: { productId: id, validTo: null } }),
      this.prisma.productAvailability.findMany({ where: { productId: id } }),
    ]);
    const base = current.find((c) => c.establishmentId === null) ?? null;
    return {
      ...p,
      supplierProducts: p.supplierProducts.map((o) => ({ ...o, pricePerBaseUnit: pricePerBaseUnit(o.unitPrice, o.quantityPerPurchaseUnit) })),
      basePrice: base?.price ?? null,
      basePriceSince: base?.validFrom ?? null,
      establishments: establishments.map((e) => {
        const local = current.find((c) => c.establishmentId === e.id);
        return {
          ...e,
          localPrice: local?.price ?? null,
          localPriceSince: local?.validFrom ?? null,
          price: local?.price ?? base?.price ?? null,
          isAvailable: availability.find((a) => a.establishmentId === e.id)?.isAvailable ?? true,
        };
      }),
    };
  }

  async priceHistory(me: AuthUser, id: string, q: HistoryQuery) {
    await this.ensureProduct(this.prisma, me, id);
    if (q.establishmentId && !me.access.canAccessEstablishment(q.establishmentId)) {
      throw new ForbiddenException('Accès refusé à cet établissement');
    }
    const rows = await this.prisma.productPrice.findMany({
      where: {
        productId: id,
        ...(q.establishmentId
          ? { establishmentId: q.establishmentId }
          : { OR: [{ establishmentId: null }, { establishmentId: { in: me.access.establishmentIds } }] }),
      },
      orderBy: { validFrom: 'desc' },
      include: { establishment: { select: { id: true, code: true, name: true } } },
    });
    // Nom de l'auteur de chaque changement (sans exposer les autres données utilisateur).
    const authorIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))];
    const authors = await this.prisma.user.findMany({ where: { id: { in: authorIds }, companyId: me.companyId }, select: { id: true, fullName: true } });
    return rows.map((r) => ({ ...r, createdBy: authors.find((a) => a.id === r.createdById) ?? null }));
  }

  private async ensureProduct(db: Db, me: AuthUser, id: string) {
    const p = await db.product.findFirst({ where: { id, companyId: me.companyId } });
    if (!p) throw new NotFoundException('Produit introuvable');
    return p;
  }

  private async assertRefs(tx: Tx, me: AuthUser, dto: { categoryId?: string | null; saleUnitCode?: string }) {
    if (dto.categoryId) {
      const c = await tx.productCategory.findFirst({ where: { id: dto.categoryId, companyId: me.companyId } });
      if (!c) throw new BadRequestException('Catégorie invalide');
    }
    if (dto.saleUnitCode) {
      const u = await tx.unit.findUnique({ where: { code: dto.saleUnitCode } });
      if (!u) throw new BadRequestException('Unité de vente invalide');
    }
  }

  /** Valide et enregistre la composition d'un menu (remplace l'existante). */
  private async writeComponents(tx: Tx, me: AuthUser, menuId: string, components: ComponentDto[]) {
    const ids = components.map((c) => c.productId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Un produit apparaît deux fois dans le menu');
    if (ids.includes(menuId)) throw new BadRequestException('Un menu ne peut pas se contenir lui-même');
    const found = await tx.product.findMany({ where: { id: { in: ids }, companyId: me.companyId } });
    if (found.length !== ids.length) throw new BadRequestException('Composant invalide');
    if (found.some((p) => p.type === 'MENU')) throw new BadRequestException('Un menu ne peut pas contenir un autre menu');
    if (found.some((p) => !p.isActive)) throw new BadRequestException('Un composant est archivé');
    await tx.productComponent.deleteMany({ where: { menuProductId: menuId } });
    if (components.length) {
      await tx.productComponent.createMany({
        data: components.map((c) => ({ menuProductId: menuId, componentProductId: c.productId, quantity: toDecimal(c.quantity) })),
      });
    }
  }

  async create(me: AuthUser, dto: CreateProductDto) {
    if (dto.basePrice !== undefined && !me.access.global.has('prices.manage')) {
      throw new ForbiddenException('Définir le prix de base demande la permission « Modifier les prix » au niveau groupe');
    }
    if (dto.components?.length && dto.type !== 'MENU') throw new BadRequestException('Seul un menu a des composants');
    const { basePrice, components, ...data } = dto;
    const created = await this.prisma.$transaction(async (tx) => {
      await this.assertRefs(tx, me, dto);
      const p = await tx.product.create({
        data: {
          ...data,
          companyId: me.companyId,
          saleUnitCode: dto.saleUnitCode ?? 'U',
          taxRate: toDecimal(dto.taxRate ?? 0),
        },
      });
      if (components?.length) await this.writeComponents(tx, me, p.id, components);
      if (basePrice !== undefined) {
        await tx.productPrice.create({
          data: { productId: p.id, establishmentId: null, price: BigInt(basePrice), createdById: me.userId, reason: 'Prix initial' },
        });
      }
      await this.audit.record(
        { action: 'PRODUCT_CREATED', entityType: 'Product', entityId: p.id, establishmentId: null, newValues: { ...dto } },
        tx,
      );
      return p;
    });
    return this.get(me, created.id);
  }

  async update(me: AuthUser, id: string, dto: UpdateProductDto) {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'products', id);
      const before = await tx.product.findFirst({
        where: { id, companyId: me.companyId },
        include: { _count: { select: { menuComponents: true, supplierProducts: { where: { isActive: true } }, usedInMenus: true } } },
      });
      if (!before) throw new NotFoundException('Produit introuvable');
      await this.assertRefs(tx, me, dto);
      if (dto.type && dto.type !== before.type) {
        if (before.type === 'MENU' && before._count.menuComponents > 0) {
          throw new ConflictException("Retirez d'abord les composants du menu avant d'en changer le type");
        }
        if (dto.type !== 'RESOLD' && before._count.supplierProducts > 0) {
          throw new ConflictException('Ce produit a des offres fournisseurs actives : il doit rester « revendu »');
        }
        if (dto.type === 'MENU' && before._count.usedInMenus > 0) {
          throw new ConflictException('Ce produit fait partie d’un menu : il ne peut pas devenir un menu');
        }
      }
      const { _count, ...current } = before;
      const next = { ...dto, taxRate: dto.taxRate !== undefined ? toDecimal(dto.taxRate) : undefined };
      const { oldValues, newValues, changed } = diff(current, next);
      if (!changed) return;
      await tx.product.update({ where: { id }, data: newValues });
      await this.audit.record(
        { action: dto.isActive === false ? 'PRODUCT_ARCHIVED' : 'PRODUCT_UPDATED', entityType: 'Product', entityId: id, establishmentId: null, oldValues, newValues },
        tx,
      );
    });
    return this.get(me, id);
  }

  /** Contrôle le droit de modifier le prix dans le périmètre demandé (groupe ou établissement). */
  private async assertPriceScope(tx: Tx, me: AuthUser, establishmentId: string | null) {
    if (establishmentId === null) {
      if (!me.access.global.has('prices.manage')) {
        throw new ForbiddenException('Le prix de base ne peut être modifié qu’au niveau groupe');
      }
      return;
    }
    await assertEstablishmentPermission(tx, me, establishmentId, 'prices.manage');
  }

  /**
   * Change un prix : clôture le prix en vigueur et en ouvre un nouveau, dans une
   * transaction avec verrou sur le produit. L'historique n'est jamais écrasé.
   */
  async setPrice(me: AuthUser, id: string, dto: SetPriceDto) {
    const establishmentId = dto.establishmentId ?? null;
    await this.prisma.$transaction(async (tx) => {
      await this.assertPriceScope(tx, me, establishmentId);
      await lockRow(tx, 'products', id);
      await this.ensureProduct(tx, me, id);
      const current = await tx.productPrice.findFirst({ where: { productId: id, establishmentId, validTo: null } });
      const price = BigInt(dto.price);
      if (current && current.price === price) return;
      // Dates strictement croissantes, même pour deux changements dans la même milliseconde.
      const now = new Date(Math.max(Date.now(), (current?.validFrom.getTime() ?? 0) + 1));
      if (current) await tx.productPrice.update({ where: { id: current.id }, data: { validTo: now } });
      const created = await tx.productPrice.create({
        data: { productId: id, establishmentId, price, validFrom: now, createdById: me.userId, reason: dto.reason ?? null },
      });
      await this.audit.record(
        {
          action: 'PRICE_CHANGED',
          entityType: 'Product',
          entityId: id,
          establishmentId,
          oldValues: { price: current?.price ?? null, scope: establishmentId ?? 'GROUPE' },
          newValues: { price, scope: establishmentId ?? 'GROUPE', priceId: created.id },
          reason: dto.reason ?? null,
        },
        tx,
      );
    });
    return this.get(me, id);
  }

  /** Supprime l'exception d'un établissement : le prix de base s'applique à nouveau. */
  async removeLocalPrice(me: AuthUser, id: string, establishmentId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.assertPriceScope(tx, me, establishmentId);
      await lockRow(tx, 'products', id);
      await this.ensureProduct(tx, me, id);
      const current = await tx.productPrice.findFirst({ where: { productId: id, establishmentId, validTo: null } });
      if (!current) throw new NotFoundException('Aucun prix spécifique pour cet établissement');
      await tx.productPrice.update({ where: { id: current.id }, data: { validTo: new Date() } });
      await this.audit.record(
        { action: 'PRICE_OVERRIDE_REMOVED', entityType: 'Product', entityId: id, establishmentId, oldValues: { price: current.price } },
        tx,
      );
    });
    return this.get(me, id);
  }

  async setAvailability(me: AuthUser, id: string, dto: AvailabilityDto) {
    await this.prisma.$transaction(async (tx) => {
      await assertEstablishmentPermission(tx, me, dto.establishmentId, 'products.manage');
      await lockRow(tx, 'products', id);
      await this.ensureProduct(tx, me, id);
      const before = await tx.productAvailability.findUnique({
        where: { productId_establishmentId: { productId: id, establishmentId: dto.establishmentId } },
      });
      const wasAvailable = before?.isAvailable ?? true;
      if (wasAvailable === dto.isAvailable) return;
      await tx.productAvailability.upsert({
        where: { productId_establishmentId: { productId: id, establishmentId: dto.establishmentId } },
        create: { productId: id, establishmentId: dto.establishmentId, isAvailable: dto.isAvailable },
        update: { isAvailable: dto.isAvailable },
      });
      await this.audit.record(
        {
          action: 'PRODUCT_AVAILABILITY_CHANGED',
          entityType: 'Product',
          entityId: id,
          establishmentId: dto.establishmentId,
          oldValues: { isAvailable: wasAvailable },
          newValues: { isAvailable: dto.isAvailable },
        },
        tx,
      );
    });
    return this.get(me, id);
  }

  async setComponents(me: AuthUser, id: string, dto: SetComponentsDto) {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'products', id);
      const p = await tx.product.findFirst({ where: { id, companyId: me.companyId }, include: { menuComponents: true } });
      if (!p) throw new NotFoundException('Produit introuvable');
      if (p.type !== 'MENU') throw new BadRequestException('Seul un produit de type « menu » a des composants');
      await this.writeComponents(tx, me, id, dto.components);
      await this.audit.record(
        {
          action: 'MENU_COMPONENTS_CHANGED',
          entityType: 'Product',
          entityId: id,
          establishmentId: null,
          oldValues: { components: p.menuComponents.map((c) => ({ productId: c.componentProductId, quantity: c.quantity })) },
          newValues: { components: dto.components },
        },
        tx,
      );
    });
    return this.get(me, id);
  }
}

@ApiTags('Catalogue — produits')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  @Get()
  @RequirePermissions('products.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser, @Query() q: ProductQuery) {
    return this.service.list(me, q);
  }

  @Get(':id')
  @RequirePermissions('products.view')
  @AnyEstablishmentScope()
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Get(':id/price-history')
  @RequirePermissions('products.view')
  @AnyEstablishmentScope()
  priceHistory(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: HistoryQuery) {
    return this.service.priceHistory(me, id, q);
  }

  // Le catalogue est commun au groupe : création et modification au niveau groupe.
  @Post()
  @RequirePermissions('products.manage')
  @GroupScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateProductDto) {
    return this.service.create(me, dto);
  }

  @Patch(':id')
  @RequirePermissions('products.manage')
  @GroupScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.service.update(me, id, dto);
  }

  @Put(':id/components')
  @RequirePermissions('products.manage')
  @GroupScope()
  setComponents(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetComponentsDto) {
    return this.service.setComponents(me, id, dto);
  }

  // Prix : groupe (prix de base) ou établissement (exception) — périmètre vérifié par le service.
  @Put(':id/price')
  @RequirePermissions('prices.manage')
  @AnyEstablishmentScope()
  setPrice(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPriceDto) {
    return this.service.setPrice(me, id, dto);
  }

  @Delete(':id/price/:establishmentId')
  @RequirePermissions('prices.manage')
  @AnyEstablishmentScope()
  removeLocalPrice(
    @CurrentUser() me: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('establishmentId', ParseUUIDPipe) establishmentId: string,
  ) {
    return this.service.removeLocalPrice(me, id, establishmentId);
  }

  // Disponibilité : par établissement, permission vérifiée dans cet établissement.
  @Put(':id/availability')
  @RequirePermissions('products.manage')
  @AnyEstablishmentScope()
  setAvailability(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AvailabilityDto) {
    return this.service.setAvailability(me, id, dto);
  }
}
