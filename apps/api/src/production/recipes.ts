import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
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
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, GroupScope, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { attachItems, D, ItemDto, itemKey, itemOf, loadItem, userNames } from '../stock/common';
import { convert, loadUnits } from './common';
import { CostingService } from './costing';

const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);

export class RecipeItemDto extends ItemDto {
  /** Quantité pour le rendement de la recette, dans l'unité indiquée. */
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) quantity: number;
  /** Unité : G, KG, ML, CL, L ou U (convertie vers l'unité de stock de l'article). */
  @IsString() @MaxLength(4) unitCode: string;
  /** Perte prévue sur l'ingrédient, en % (0 à 99,99). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99.99) lossPercent?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) note?: string | null;
}

class VersionFieldsDto {
  /** Rendement : quantité de produit obtenue (unité de vente du produit). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) yieldQuantity?: number;
  /** Durée de conservation du produit fini, en jours (décision F). */
  @IsOptional() @IsInt() @Min(0) @Max(3650) shelfLifeDays?: number | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(5000) instructions?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RecipeItemDto) items?: RecipeItemDto[];
}

// Indépendant de VersionFieldsDto : à la création, rendement et ingrédients sont obligatoires
// (un héritage reprendrait les @IsOptional de la classe parente).
export class CreateRecipeDto {
  @IsUUID() productId: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) yieldQuantity: number;
  @IsOptional() @IsInt() @Min(0) @Max(3650) shelfLifeDays?: number | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(5000) instructions?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RecipeItemDto) items: RecipeItemDto[];
}

export class UpdateVersionDto extends VersionFieldsDto {}

class CostQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
}

@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly costing: CostingService,
  ) {}

  async list(me: AuthUser) {
    const recipes = await this.prisma.recipe.findMany({
      where: { companyId: me.companyId },
      include: { versions: { select: { id: true, version: true, status: true, yieldQuantity: true, _count: { select: { items: true } } }, orderBy: { version: 'desc' } } },
    });
    const products = await this.prisma.product.findMany({
      where: { id: { in: recipes.map((r) => r.productId) } },
      select: { id: true, code: true, name: true, saleUnitCode: true, isActive: true },
    });
    return recipes
      .map((r) => {
        const active = r.versions.find((v) => v.status === 'ACTIVE') ?? null;
        return {
          id: r.id,
          product: products.find((p) => p.id === r.productId) ?? null,
          activeVersion: active ? { id: active.id, version: active.version, yieldQuantity: active.yieldQuantity, items: active._count.items } : null,
          hasDraft: r.versions.some((v) => v.status === 'DRAFT'),
          versions: r.versions.length,
        };
      })
      .sort((a, b) => (a.product?.name ?? '').localeCompare(b.product?.name ?? '', 'fr'));
  }

  async get(me: AuthUser, id: string) {
    const r = await this.prisma.recipe.findFirst({
      where: { id, companyId: me.companyId },
      include: { versions: { orderBy: { version: 'desc' }, include: { items: { orderBy: { sortOrder: 'asc' } } } } },
    });
    if (!r) throw new NotFoundException('Recette introuvable');
    const product = await this.prisma.product.findUnique({ where: { id: r.productId }, select: { id: true, code: true, name: true, saleUnitCode: true, taxRate: true } });
    const names = await userNames(this.prisma, me.companyId, r.versions.flatMap((v) => [v.createdById, v.activatedById]));
    const versions = await Promise.all(
      r.versions.map(async (v) => ({
        ...v,
        items: await attachItems(this.prisma, v.items),
        createdBy: names.get(v.createdById) ?? null,
        activatedBy: v.activatedById ? names.get(v.activatedById) ?? null : null,
      })),
    );
    return { ...r, product, versions };
  }

  /**
   * Contrôle des ingrédients : article existant et stockable, différent du
   * produit de la recette, pas de doublon, unité compatible avec l'unité de
   * stock, et aucune boucle de sous-recettes (A contient B qui contient A).
   */
  private async validateItems(tx: Tx, me: AuthUser, productId: string, items: RecipeItemDto[]) {
    const units = await loadUnits(tx);
    const seen = new Set<string>();
    for (const i of items) {
      const item = itemOf(i);
      const key = itemKey(item);
      if (seen.has(key)) throw new BadRequestException('Un ingrédient apparaît deux fois dans la recette');
      seen.add(key);
      if (item.productId === productId) throw new BadRequestException('Un produit ne peut pas être un ingrédient de sa propre recette');
      const info = await loadItem(tx, me.companyId, item);
      if (!info.isActive) throw new BadRequestException(`« ${info.name} » est archivé`);
      convert(units, D(1), i.unitCode, info.unit, `« ${info.name} »`);
    }
    await this.assertNoCycle(tx, productId, items.map((i) => i.productId).filter((x): x is string => !!x));
  }

  /** Parcours des recettes actives des sous-préparations : refuse si l'on revient au produit. */
  private async assertNoCycle(tx: Tx, productId: string, ingredientProductIds: string[]) {
    const visited = new Set<string>();
    const stack = [...ingredientProductIds];
    while (stack.length) {
      const current = stack.pop()!;
      if (current === productId) {
        const p = await tx.product.findUnique({ where: { id: productId }, select: { name: true } });
        throw new BadRequestException(`Boucle de sous-recettes : « ${p?.name} » se retrouverait dans ses propres ingrédients`);
      }
      if (visited.has(current)) continue;
      visited.add(current);
      const recipe = await tx.recipe.findUnique({ where: { productId: current } });
      if (!recipe?.activeVersionId) continue;
      const subItems = await tx.recipeItem.findMany({ where: { versionId: recipe.activeVersionId, productId: { not: null } }, select: { productId: true } });
      stack.push(...subItems.map((s) => s.productId!));
    }
  }

  private itemRows(items: RecipeItemDto[]) {
    return items.map((i, index) => ({
      ...itemOf(i),
      quantity: D(i.quantity),
      unitCode: i.unitCode,
      lossPercent: D(i.lossPercent ?? 0),
      note: i.note ?? null,
      sortOrder: index,
    }));
  }

  private async lockRecipe(tx: Tx, me: AuthUser, recipeId: string) {
    await tx.$queryRaw`SELECT id FROM recipes WHERE id = ${recipeId}::uuid FOR UPDATE`;
    const r = await tx.recipe.findFirst({ where: { id: recipeId, companyId: me.companyId } });
    if (!r) throw new NotFoundException('Recette introuvable');
    return r;
  }

  async create(me: AuthUser, dto: CreateRecipeDto) {
    const id = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({ where: { id: dto.productId, companyId: me.companyId } });
      if (!product) throw new BadRequestException('Produit invalide');
      if (product.type !== 'MANUFACTURED') throw new BadRequestException('Seul un produit « fabriqué » a une recette');
      const existing = await tx.recipe.findUnique({ where: { productId: product.id } });
      if (existing) throw new ConflictException('Ce produit a déjà une recette : créez une nouvelle version');
      await this.validateItems(tx, me, product.id, dto.items);
      const recipe = await tx.recipe.create({ data: { companyId: me.companyId, productId: product.id } });
      await tx.recipeVersion.create({
        data: {
          recipeId: recipe.id,
          version: 1,
          yieldQuantity: D(dto.yieldQuantity),
          shelfLifeDays: dto.shelfLifeDays ?? null,
          instructions: dto.instructions ?? null,
          notes: dto.notes ?? null,
          createdById: me.userId,
          items: { create: this.itemRows(dto.items) },
        },
      });
      await this.audit.record(
        { action: 'RECIPE_CREATED', entityType: 'Recipe', entityId: recipe.id, establishmentId: null, newValues: { product: product.code, yieldQuantity: dto.yieldQuantity, items: dto.items.length } },
        tx,
      );
      return recipe.id;
    });
    return this.get(me, id);
  }

  /** Nouvelle version en brouillon, copiée depuis la version active (ou la plus récente). */
  async newVersion(me: AuthUser, recipeId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockRecipe(tx, me, recipeId);
      const versions = await tx.recipeVersion.findMany({ where: { recipeId }, include: { items: { orderBy: { sortOrder: 'asc' } } }, orderBy: { version: 'desc' } });
      if (versions.some((v) => v.status === 'DRAFT')) throw new ConflictException('Un brouillon existe déjà pour cette recette');
      const source = versions.find((v) => v.status === 'ACTIVE') ?? versions[0];
      const created = await tx.recipeVersion.create({
        data: {
          recipeId,
          version: versions[0].version + 1,
          yieldQuantity: source.yieldQuantity,
          shelfLifeDays: source.shelfLifeDays,
          instructions: source.instructions,
          notes: null,
          createdById: me.userId,
          items: {
            create: source.items.map((i) => ({
              rawMaterialId: i.rawMaterialId,
              productId: i.productId,
              quantity: i.quantity,
              unitCode: i.unitCode,
              lossPercent: i.lossPercent,
              note: i.note,
              sortOrder: i.sortOrder,
            })),
          },
        },
      });
      await this.audit.record({ action: 'RECIPE_VERSION_CREATED', entityType: 'RecipeVersion', entityId: created.id, establishmentId: null, newValues: { recipeId, version: created.version, from: source.version } }, tx);
    });
    return this.get(me, recipeId);
  }

  private async lockVersion(tx: Tx, me: AuthUser, versionId: string) {
    const v = await tx.recipeVersion.findFirst({ where: { id: versionId, recipe: { companyId: me.companyId } }, include: { recipe: true } });
    if (!v) throw new NotFoundException('Version de recette introuvable');
    await this.lockRecipe(tx, me, v.recipeId);
    return tx.recipeVersion.findUniqueOrThrow({ where: { id: versionId }, include: { recipe: true, items: true } });
  }

  /** Modification d'un brouillon (une version publiée est figée, y compris en base). */
  async updateVersion(me: AuthUser, versionId: string, dto: UpdateVersionDto) {
    const recipeId = await this.prisma.$transaction(async (tx) => {
      const v = await this.lockVersion(tx, me, versionId);
      if (v.status !== 'DRAFT') throw new ConflictException('Version publiée : modification impossible, créez une nouvelle version');
      if (dto.items) {
        await this.validateItems(tx, me, v.recipe.productId, dto.items);
        await tx.recipeItem.deleteMany({ where: { versionId } });
        await tx.recipeItem.createMany({ data: this.itemRows(dto.items).map((i) => ({ ...i, versionId })) });
      }
      await tx.recipeVersion.update({
        where: { id: versionId },
        data: {
          yieldQuantity: dto.yieldQuantity !== undefined ? D(dto.yieldQuantity) : undefined,
          shelfLifeDays: dto.shelfLifeDays,
          instructions: dto.instructions,
          notes: dto.notes,
        },
      });
      await this.audit.record(
        { action: 'RECIPE_VERSION_UPDATED', entityType: 'RecipeVersion', entityId: versionId, establishmentId: null, newValues: { ...dto, items: dto.items?.length } },
        tx,
      );
      return v.recipeId;
    });
    return this.get(me, recipeId);
  }

  /** Activation d'un brouillon : l'ancienne version active est archivée (une seule active). */
  async activate(me: AuthUser, versionId: string) {
    const recipeId = await this.prisma.$transaction(async (tx) => {
      const v = await this.lockVersion(tx, me, versionId);
      if (v.status !== 'DRAFT') throw new ConflictException('Seul un brouillon peut être activé');
      if (v.items.length === 0) throw new BadRequestException('Recette sans ingrédient');
      // Nouveau contrôle au moment de l'activation : les sous-recettes ont pu changer depuis.
      await this.validateItems(
        tx,
        me,
        v.recipe.productId,
        v.items.map((i) => ({ rawMaterialId: i.rawMaterialId, productId: i.productId, quantity: Number(i.quantity), unitCode: i.unitCode })),
      );
      const previous = await tx.recipeVersion.findFirst({ where: { recipeId: v.recipeId, status: 'ACTIVE' } });
      if (previous) await tx.recipeVersion.update({ where: { id: previous.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await tx.recipeVersion.update({ where: { id: versionId }, data: { status: 'ACTIVE', activatedById: me.userId, activatedAt: new Date() } });
      await tx.recipe.update({ where: { id: v.recipeId }, data: { activeVersionId: versionId } });
      await this.audit.record(
        { action: 'RECIPE_VERSION_ACTIVATED', entityType: 'RecipeVersion', entityId: versionId, establishmentId: null, oldValues: { activeVersion: previous?.version ?? null }, newValues: { activeVersion: v.version } },
        tx,
      );
      return v.recipeId;
    });
    return this.get(me, recipeId);
  }

  /** Archive un brouillon abandonné ou retire la version active (plus de production possible). */
  async archive(me: AuthUser, versionId: string) {
    const recipeId = await this.prisma.$transaction(async (tx) => {
      const v = await this.lockVersion(tx, me, versionId);
      if (v.status === 'ARCHIVED') throw new ConflictException('Version déjà archivée');
      await tx.recipeVersion.update({ where: { id: versionId }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      if (v.status === 'ACTIVE') await tx.recipe.update({ where: { id: v.recipeId }, data: { activeVersionId: null } });
      await this.audit.record({ action: 'RECIPE_VERSION_ARCHIVED', entityType: 'RecipeVersion', entityId: versionId, establishmentId: null, oldValues: { status: v.status } }, tx);
      return v.recipeId;
    });
    return this.get(me, recipeId);
  }

  private assertEstablishment(me: AuthUser, establishmentId?: string) {
    if (establishmentId && !me.access.canAccessEstablishment(establishmentId)) throw new ForbiddenException('Établissement non accessible');
    return establishmentId ?? me.establishmentId ?? null;
  }

  async cost(me: AuthUser, versionId: string, q: CostQuery) {
    const est = this.assertEstablishment(me, q.establishmentId);
    const cost = await this.costing.costVersion(this.prisma, me.companyId, versionId, est);
    const version = await this.prisma.recipeVersion.findUniqueOrThrow({ where: { id: versionId }, include: { recipe: true } });
    const product = await this.prisma.product.findUniqueOrThrow({ where: { id: version.recipe.productId } });
    const rows = await this.costing.productCosting(me.companyId, est);
    const row = rows.find((r) => r.productId === product.id);
    // Marge calculée sur le coût de CETTE version (pas forcément l'active).
    const margin = row?.priceHt != null && cost.unitCost ? row.priceHt.sub(cost.unitCost).toDecimalPlaces(2) : null;
    return {
      ...cost,
      establishmentId: est,
      priceTtc: row?.priceTtc ?? null,
      priceHt: row?.priceHt ?? null,
      margin,
      marginRate: margin && row?.priceHt?.gt(0) ? margin.div(row.priceHt).mul(100).toDecimalPlaces(1) : null,
    };
  }

  costing_(me: AuthUser, q: CostQuery) {
    return this.costing.productCosting(me.companyId, this.assertEstablishment(me, q.establishmentId));
  }
}

@ApiTags('Recettes')
@ApiBearerAuth()
@Controller()
export class RecipesController {
  constructor(private readonly service: RecipesService) {}

  @Get('recipes')
  @RequirePermissions('recipes.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser) {
    return this.service.list(me);
  }

  @Get('recipes/:id')
  @RequirePermissions('recipes.view')
  @AnyEstablishmentScope()
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  // Fiches techniques communes au groupe (décision G) : écriture au niveau groupe.
  @Post('recipes')
  @RequirePermissions('recipes.manage')
  @GroupScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateRecipeDto) {
    return this.service.create(me, dto);
  }

  @Post('recipes/:id/versions')
  @RequirePermissions('recipes.manage')
  @GroupScope()
  newVersion(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.newVersion(me, id);
  }

  @Patch('recipe-versions/:id')
  @RequirePermissions('recipes.manage')
  @GroupScope()
  updateVersion(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVersionDto) {
    return this.service.updateVersion(me, id, dto);
  }

  @Post('recipe-versions/:id/activate')
  @RequirePermissions('recipes.manage')
  @GroupScope()
  activate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.activate(me, id);
  }

  @Post('recipe-versions/:id/archive')
  @RequirePermissions('recipes.manage')
  @GroupScope()
  archive(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archive(me, id);
  }

  @Get('recipe-versions/:id/cost')
  @RequirePermissions('recipes.view')
  @AnyEstablishmentScope()
  cost(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: CostQuery) {
    return this.service.cost(me, id, q);
  }

  @Get('costing')
  @RequirePermissions('recipes.view')
  @AnyEstablishmentScope()
  costing(@CurrentUser() me: AuthUser, @Query() q: CostQuery) {
    return this.service.costing_(me, q);
  }
}
