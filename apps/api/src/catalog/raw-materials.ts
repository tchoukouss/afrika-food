import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, RawMaterialKind } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
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
import { PrismaService, Tx } from '../prisma/prisma.service';
import { CODE_MESSAGE, CODE_RE, emptyToNull, lockRow, MAX_QUANTITY, pricePerBaseUnit, toDecimal, trim, upper } from './common';

export const BASE_UNITS = ['KG', 'L', 'U'] as const;

export class PackagingDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) name: string;
  /** Quantité dans l'unité de base de la matière (ex. 25 pour un sac de 25 kg). */
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(MAX_QUANTITY) quantity: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdatePackagingDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(MAX_QUANTITY) quantity?: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateRawMaterialDto {
  @Transform(upper) @Matches(CODE_RE, { message: CODE_MESSAGE }) code: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsOptional() @IsUUID() categoryId?: string | null;
  @IsOptional() @IsEnum(RawMaterialKind) kind?: RawMaterialKind;
  @IsIn(BASE_UNITS, { message: 'Unité de base : KG, L ou U' }) baseUnitCode: (typeof BASE_UNITS)[number];
  @IsOptional() @IsBoolean() isPerishable?: boolean;
  @IsOptional() @IsBoolean() trackLots?: boolean;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => PackagingDto) packagings?: PackagingDto[];
}

export class UpdateRawMaterialDto {
  @IsOptional() @Transform(upper) @Matches(CODE_RE, { message: CODE_MESSAGE }) code?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsUUID() categoryId?: string | null;
  @IsOptional() @IsEnum(RawMaterialKind) kind?: RawMaterialKind;
  @IsOptional() @IsIn(BASE_UNITS, { message: 'Unité de base : KG, L ou U' }) baseUnitCode?: (typeof BASE_UNITS)[number];
  @IsOptional() @IsBoolean() isPerishable?: boolean;
  @IsOptional() @IsBoolean() trackLots?: boolean;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class RawMaterialQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsEnum(RawMaterialKind) kind?: RawMaterialKind;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeInactive?: boolean;
}

const detailInclude = {
  category: { select: { id: true, name: true } },
  baseUnit: true,
  packagings: { orderBy: [{ isDefault: 'desc' }, { quantity: 'asc' }] },
  supplierProducts: {
    where: { isActive: true },
    orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
    include: { supplier: { select: { id: true, code: true, name: true, isActive: true } } },
  },
} satisfies Prisma.RawMaterialInclude;

type RawMaterialDetail = Prisma.RawMaterialGetPayload<{ include: typeof detailInclude }>;

/** Ajoute le prix par unité de base (ex. FCFA/kg) à chaque offre fournisseur. */
function present(m: RawMaterialDetail) {
  return {
    ...m,
    supplierProducts: m.supplierProducts.map((o) => ({ ...o, pricePerBaseUnit: pricePerBaseUnit(o.unitPrice, o.quantityPerPurchaseUnit) })),
  };
}

@Injectable()
export class RawMaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(me: AuthUser, q: RawMaterialQuery) {
    const items = await this.prisma.rawMaterial.findMany({
      where: {
        companyId: me.companyId,
        ...(q.includeInactive ? {} : { isActive: true }),
        categoryId: q.categoryId,
        kind: q.kind,
        ...(q.search
          ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }] }
          : {}),
      },
      orderBy: { name: 'asc' },
      include: { ...detailInclude, packagings: { where: { isActive: true }, orderBy: [{ isDefault: 'desc' }, { quantity: 'asc' }] } },
    });
    return items.map(present);
  }

  async get(me: AuthUser, id: string) {
    const m = await this.prisma.rawMaterial.findFirst({ where: { id, companyId: me.companyId }, include: detailInclude });
    if (!m) throw new NotFoundException('Matière première introuvable');
    return present(m);
  }

  private async assertCategory(tx: Tx, me: AuthUser, categoryId: string | null | undefined) {
    if (!categoryId) return;
    const c = await tx.rawMaterialCategory.findFirst({ where: { id: categoryId, companyId: me.companyId } });
    if (!c) throw new BadRequestException('Catégorie invalide');
  }

  private assertPackagings(list: PackagingDto[]) {
    const names = list.map((p) => p.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new BadRequestException('Deux conditionnements portent le même nom');
    if (list.filter((p) => p.isDefault).length > 1) throw new BadRequestException('Un seul conditionnement par défaut');
  }

  async create(me: AuthUser, dto: CreateRawMaterialDto) {
    const packagings = dto.packagings ?? [];
    this.assertPackagings(packagings);
    return this.prisma.$transaction(async (tx) => {
      await this.assertCategory(tx, me, dto.categoryId);
      const m = await tx.rawMaterial.create({
        data: {
          companyId: me.companyId,
          code: dto.code,
          name: dto.name,
          categoryId: dto.categoryId ?? null,
          kind: dto.kind ?? 'INGREDIENT',
          baseUnitCode: dto.baseUnitCode,
          isPerishable: dto.isPerishable ?? false,
          trackLots: dto.trackLots ?? true,
          description: dto.description ?? null,
          packagings: {
            create: packagings.map((p) => ({ name: p.name, quantity: toDecimal(p.quantity), isDefault: p.isDefault ?? false })),
          },
        },
        include: detailInclude,
      });
      await this.audit.record(
        { action: 'RAW_MATERIAL_CREATED', entityType: 'RawMaterial', entityId: m.id, establishmentId: null, newValues: { ...dto } },
        tx,
      );
      return present(m);
    });
  }

  async update(me: AuthUser, id: string, dto: UpdateRawMaterialDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'raw_materials', id);
      const before = await tx.rawMaterial.findFirst({
        where: { id, companyId: me.companyId },
        include: { _count: { select: { packagings: true, supplierProducts: true } } },
      });
      if (!before) throw new NotFoundException('Matière première introuvable');
      if (dto.categoryId !== undefined) await this.assertCategory(tx, me, dto.categoryId);
      // Les conditionnements et offres sont exprimés dans l'unité de base :
      // la changer fausserait toutes les quantités existantes.
      if (dto.baseUnitCode && dto.baseUnitCode !== before.baseUnitCode && (before._count.packagings > 0 || before._count.supplierProducts > 0)) {
        throw new ConflictException("Impossible de changer l'unité de base : des conditionnements ou des offres fournisseurs l'utilisent");
      }
      const { _count, ...current } = before;
      const { oldValues, newValues, changed } = diff(current, { ...dto });
      if (!changed) return this.get(me, id);
      await tx.rawMaterial.update({ where: { id }, data: newValues });
      await this.audit.record(
        {
          action: dto.isActive === false ? 'RAW_MATERIAL_ARCHIVED' : 'RAW_MATERIAL_UPDATED',
          entityType: 'RawMaterial',
          entityId: id,
          establishmentId: null,
          oldValues,
          newValues,
        },
        tx,
      );
      return present(await tx.rawMaterial.findUniqueOrThrow({ where: { id }, include: detailInclude }));
    });
  }

  /** Un seul conditionnement par défaut par matière. */
  private async clearDefault(tx: Tx, rawMaterialId: string, exceptId?: string) {
    await tx.rawMaterialPackaging.updateMany({
      where: { rawMaterialId, isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { isDefault: false },
    });
  }

  async addPackaging(me: AuthUser, rawMaterialId: string, dto: PackagingDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'raw_materials', rawMaterialId);
      const m = await tx.rawMaterial.findFirst({ where: { id: rawMaterialId, companyId: me.companyId } });
      if (!m) throw new NotFoundException('Matière première introuvable');
      if (dto.isDefault) await this.clearDefault(tx, rawMaterialId);
      const p = await tx.rawMaterialPackaging.create({
        data: { rawMaterialId, name: dto.name, quantity: toDecimal(dto.quantity), isDefault: dto.isDefault ?? false },
      });
      await this.audit.record(
        { action: 'PACKAGING_CREATED', entityType: 'RawMaterialPackaging', entityId: p.id, establishmentId: null, newValues: { rawMaterialId, ...dto } },
        tx,
      );
      return p;
    });
  }

  async updatePackaging(me: AuthUser, id: string, dto: UpdatePackagingDto) {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.rawMaterialPackaging.findFirst({ where: { id, rawMaterial: { companyId: me.companyId } } });
      if (!p) throw new NotFoundException('Conditionnement introuvable');
      await lockRow(tx, 'raw_materials', p.rawMaterialId);
      if (dto.isDefault) await this.clearDefault(tx, p.rawMaterialId, id);
      const next = { ...dto, quantity: dto.quantity !== undefined ? toDecimal(dto.quantity) : undefined };
      const { oldValues, newValues, changed } = diff(p, next);
      if (!changed) return p;
      const updated = await tx.rawMaterialPackaging.update({ where: { id }, data: newValues });
      await this.audit.record(
        { action: 'PACKAGING_UPDATED', entityType: 'RawMaterialPackaging', entityId: id, establishmentId: null, oldValues, newValues },
        tx,
      );
      return updated;
    });
  }
}

@ApiTags('Catalogue — matières premières')
@ApiBearerAuth()
@Controller()
export class RawMaterialsController {
  constructor(private readonly service: RawMaterialsService) {}

  @Get('raw-materials')
  @RequirePermissions('products.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser, @Query() q: RawMaterialQuery) {
    return this.service.list(me, q);
  }

  @Get('raw-materials/:id')
  @RequirePermissions('products.view')
  @AnyEstablishmentScope()
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post('raw-materials')
  @RequirePermissions('products.manage')
  @GroupScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateRawMaterialDto) {
    return this.service.create(me, dto);
  }

  @Patch('raw-materials/:id')
  @RequirePermissions('products.manage')
  @GroupScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRawMaterialDto) {
    return this.service.update(me, id, dto);
  }

  @Post('raw-materials/:id/packagings')
  @RequirePermissions('products.manage')
  @GroupScope()
  addPackaging(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PackagingDto) {
    return this.service.addPackaging(me, id, dto);
  }

  @Patch('raw-material-packagings/:id')
  @RequirePermissions('products.manage')
  @GroupScope()
  updatePackaging(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePackagingDto) {
    return this.service.updatePackaging(me, id, dto);
  }
}
