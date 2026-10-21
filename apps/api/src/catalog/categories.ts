import { Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, GroupScope, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { emptyToNull, lockRow, trim } from './common';

export class CreateCategoryDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) description?: string | null;
  /** Couleur d'affichage (boutons de caisse), ex. #C2410C. Catégories produits uniquement. */
  @IsOptional() @Transform(emptyToNull) @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Couleur au format #RRGGBB' }) color?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(9999) sortOrder?: number;
}

export class UpdateCategoryDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) description?: string | null;
  @IsOptional() @Transform(emptyToNull) @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Couleur au format #RRGGBB' }) color?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(9999) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ListQuery {
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeInactive?: boolean;
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  units() {
    return this.prisma.unit.findMany({ orderBy: [{ dimension: 'asc' }, { factorToBase: 'desc' }] });
  }

  // --- Catégories de matières premières -----------------------------------

  listRaw(me: AuthUser, q: ListQuery) {
    return this.prisma.rawMaterialCategory.findMany({
      where: { companyId: me.companyId, ...(q.includeInactive ? {} : { isActive: true }) },
      orderBy: { name: 'asc' },
      include: { _count: { select: { rawMaterials: true } } },
    });
  }

  createRaw(me: AuthUser, dto: CreateCategoryDto) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.rawMaterialCategory.create({ data: { companyId: me.companyId, name: dto.name, description: dto.description } });
      await this.audit.record({ action: 'RAW_MATERIAL_CATEGORY_CREATED', entityType: 'RawMaterialCategory', entityId: c.id, establishmentId: null, newValues: c }, tx);
      return c;
    });
  }

  updateRaw(me: AuthUser, id: string, dto: UpdateCategoryDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'raw_material_categories', id);
      const before = await tx.rawMaterialCategory.findFirst({ where: { id, companyId: me.companyId } });
      if (!before) throw new NotFoundException('Catégorie introuvable');
      const { oldValues, newValues, changed } = diff(before, { name: dto.name, description: dto.description, isActive: dto.isActive });
      if (!changed) return before;
      const updated = await tx.rawMaterialCategory.update({ where: { id }, data: newValues });
      await this.audit.record({ action: 'RAW_MATERIAL_CATEGORY_UPDATED', entityType: 'RawMaterialCategory', entityId: id, establishmentId: null, oldValues, newValues }, tx);
      return updated;
    });
  }

  // --- Catégories de produits ----------------------------------------------

  listProduct(me: AuthUser, q: ListQuery) {
    return this.prisma.productCategory.findMany({
      where: { companyId: me.companyId, ...(q.includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
  }

  createProduct(me: AuthUser, dto: CreateCategoryDto) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.productCategory.create({
        data: { companyId: me.companyId, name: dto.name, color: dto.color, sortOrder: dto.sortOrder ?? 0 },
      });
      await this.audit.record({ action: 'PRODUCT_CATEGORY_CREATED', entityType: 'ProductCategory', entityId: c.id, establishmentId: null, newValues: c }, tx);
      return c;
    });
  }

  updateProduct(me: AuthUser, id: string, dto: UpdateCategoryDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'product_categories', id);
      const before = await tx.productCategory.findFirst({ where: { id, companyId: me.companyId } });
      if (!before) throw new NotFoundException('Catégorie introuvable');
      const { oldValues, newValues, changed } = diff(before, { name: dto.name, color: dto.color, sortOrder: dto.sortOrder, isActive: dto.isActive });
      if (!changed) return before;
      const updated = await tx.productCategory.update({ where: { id }, data: newValues });
      await this.audit.record({ action: 'PRODUCT_CATEGORY_UPDATED', entityType: 'ProductCategory', entityId: id, establishmentId: null, oldValues, newValues }, tx);
      return updated;
    });
  }
}

@ApiTags('Catalogue — référentiels')
@ApiBearerAuth()
@Controller()
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  @Get('units')
  units() {
    return this.service.units();
  }

  @Get('raw-material-categories')
  @RequirePermissions('products.view')
  @AnyEstablishmentScope()
  listRaw(@CurrentUser() me: AuthUser, @Query() q: ListQuery) {
    return this.service.listRaw(me, q);
  }

  @Post('raw-material-categories')
  @RequirePermissions('products.manage')
  @GroupScope()
  createRaw(@CurrentUser() me: AuthUser, @Body() dto: CreateCategoryDto) {
    return this.service.createRaw(me, dto);
  }

  @Patch('raw-material-categories/:id')
  @RequirePermissions('products.manage')
  @GroupScope()
  updateRaw(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.service.updateRaw(me, id, dto);
  }

  @Get('product-categories')
  @RequirePermissions('products.view')
  @AnyEstablishmentScope()
  listProduct(@CurrentUser() me: AuthUser, @Query() q: ListQuery) {
    return this.service.listProduct(me, q);
  }

  @Post('product-categories')
  @RequirePermissions('products.manage')
  @GroupScope()
  createProduct(@CurrentUser() me: AuthUser, @Body() dto: CreateCategoryDto) {
    return this.service.createProduct(me, dto);
  }

  @Patch('product-categories/:id')
  @RequirePermissions('products.manage')
  @GroupScope()
  updateProduct(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.service.updateProduct(me, id, dto);
  }
}
