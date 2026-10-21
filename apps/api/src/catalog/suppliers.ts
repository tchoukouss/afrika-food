import {
  BadRequestException,
  Body,
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
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { CODE_MESSAGE, CODE_RE, emptyToNull, lockRow, lowerOrNull, MAX_AMOUNT, MAX_QUANTITY, pricePerBaseUnit, toDecimal, trim, upper } from './common';

export class CreateSupplierDto {
  @Transform(upper) @Matches(CODE_RE, { message: CODE_MESSAGE }) code: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(120) contactName?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(40) phone2?: string | null;
  @IsOptional() @Transform(lowerOrNull) @IsEmail({}, { message: 'Email invalide' }) email?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) address?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(80) city?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(60) taxId?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) paymentTerms?: string | null;
  /** Plafond de crédit en FCFA (null = non défini). */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) creditLimit?: number | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

export class UpdateSupplierDto {
  @IsOptional() @Transform(upper) @Matches(CODE_RE, { message: CODE_MESSAGE }) code?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(120) contactName?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(40) phone2?: string | null;
  @IsOptional() @Transform(lowerOrNull) @IsEmail({}, { message: 'Email invalide' }) email?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) address?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(80) city?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(60) taxId?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) paymentTerms?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) creditLimit?: number | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateSupplierProductDto {
  @IsUUID() supplierId: string;
  /** Renseigner soit une matière première, soit un produit revendu. */
  @IsOptional() @IsUUID() rawMaterialId?: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(80) brand?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(60) supplierRef?: string | null;
  /** Unité d'achat telle que facturée : « Sac 25 kg », « Casier 24 bouteilles »… */
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) purchaseUnitLabel: string;
  /** Quantité contenue, dans l'unité de base de l'article (25 pour un sac de 25 kg). */
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(MAX_QUANTITY) quantityPerPurchaseUnit: number;
  /** Prix de référence TTC par unité d'achat, en FCFA. */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) unitPrice?: number | null;
  @IsOptional() @IsBoolean() isPreferred?: boolean;
}

export class UpdateSupplierProductDto {
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(80) brand?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(60) supplierRef?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) purchaseUnitLabel?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(MAX_QUANTITY) quantityPerPurchaseUnit?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) unitPrice?: number | null;
  @IsOptional() @IsBoolean() isPreferred?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class SupplierQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeInactive?: boolean;
}

const offerInclude = {
  rawMaterial: { select: { id: true, code: true, name: true, baseUnitCode: true } },
  product: { select: { id: true, code: true, name: true, saleUnitCode: true } },
} satisfies Prisma.SupplierProductInclude;

type Offer = Prisma.SupplierProductGetPayload<{ include: typeof offerInclude }>;
const presentOffer = (o: Offer) => ({ ...o, pricePerBaseUnit: pricePerBaseUnit(o.unitPrice, o.quantityPerPurchaseUnit) });

const big = (n: number | null | undefined) => (n === undefined ? undefined : n === null ? null : BigInt(n));

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(me: AuthUser, q: SupplierQuery) {
    return this.prisma.supplier.findMany({
      where: {
        companyId: me.companyId,
        ...(q.includeInactive ? {} : { isActive: true }),
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' } },
                { code: { contains: q.search, mode: 'insensitive' } },
                { phone: { contains: q.search } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: { where: { isActive: true } } } } },
    });
  }

  async get(me: AuthUser, id: string) {
    const s = await this.prisma.supplier.findFirst({
      where: { id, companyId: me.companyId },
      include: { products: { orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }], include: offerInclude } },
    });
    if (!s) throw new NotFoundException('Fournisseur introuvable');
    return { ...s, products: s.products.map(presentOffer) };
  }

  create(me: AuthUser, dto: CreateSupplierDto) {
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.supplier.create({ data: { ...dto, creditLimit: big(dto.creditLimit), companyId: me.companyId } });
      await this.audit.record({ action: 'SUPPLIER_CREATED', entityType: 'Supplier', entityId: s.id, establishmentId: null, newValues: s }, tx);
      return s;
    });
  }

  update(me: AuthUser, id: string, dto: UpdateSupplierDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'suppliers', id);
      const before = await tx.supplier.findFirst({ where: { id, companyId: me.companyId } });
      if (!before) throw new NotFoundException('Fournisseur introuvable');
      const { oldValues, newValues, changed } = diff(before, { ...dto, creditLimit: big(dto.creditLimit) });
      if (!changed) return before;
      const updated = await tx.supplier.update({ where: { id }, data: newValues });
      await this.audit.record(
        { action: dto.isActive === false ? 'SUPPLIER_ARCHIVED' : 'SUPPLIER_UPDATED', entityType: 'Supplier', entityId: id, establishmentId: null, oldValues, newValues },
        tx,
      );
      return updated;
    });
  }

  /** Verrouille l'article (matière ou produit) pour sérialiser le choix de l'offre préférée. */
  private async lockItem(tx: Tx, me: AuthUser, item: { rawMaterialId?: string | null; productId?: string | null }) {
    if (item.rawMaterialId) {
      await lockRow(tx, 'raw_materials', item.rawMaterialId);
      const m = await tx.rawMaterial.findFirst({ where: { id: item.rawMaterialId, companyId: me.companyId } });
      if (!m) throw new BadRequestException('Matière première invalide');
    } else if (item.productId) {
      await lockRow(tx, 'products', item.productId);
      const p = await tx.product.findFirst({ where: { id: item.productId, companyId: me.companyId } });
      if (!p) throw new BadRequestException('Produit invalide');
      if (p.type !== 'RESOLD') throw new BadRequestException('Seul un produit de type « revendu » peut être acheté chez un fournisseur');
    }
  }

  private async clearPreferred(tx: Tx, item: { rawMaterialId: string | null; productId: string | null }, exceptId?: string) {
    await tx.supplierProduct.updateMany({
      where: {
        isPreferred: true,
        ...(item.rawMaterialId ? { rawMaterialId: item.rawMaterialId } : { productId: item.productId }),
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { isPreferred: false },
    });
  }

  createOffer(me: AuthUser, dto: CreateSupplierProductDto) {
    if (!!dto.rawMaterialId === !!dto.productId) {
      throw new BadRequestException('Indiquer soit une matière première, soit un produit revendu');
    }
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, companyId: me.companyId } });
      if (!supplier) throw new BadRequestException('Fournisseur invalide');
      await this.lockItem(tx, me, dto);
      const item = { rawMaterialId: dto.rawMaterialId ?? null, productId: dto.productId ?? null };
      if (dto.isPreferred) await this.clearPreferred(tx, item);
      const offer = await tx.supplierProduct.create({
        data: {
          ...dto,
          ...item,
          quantityPerPurchaseUnit: toDecimal(dto.quantityPerPurchaseUnit),
          unitPrice: big(dto.unitPrice),
          priceUpdatedAt: dto.unitPrice != null ? new Date() : null,
        },
        include: offerInclude,
      });
      await this.audit.record(
        { action: 'SUPPLIER_OFFER_CREATED', entityType: 'SupplierProduct', entityId: offer.id, establishmentId: null, newValues: { ...dto } },
        tx,
      );
      return presentOffer(offer);
    });
  }

  updateOffer(me: AuthUser, id: string, dto: UpdateSupplierProductDto) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.supplierProduct.findFirst({ where: { id, supplier: { companyId: me.companyId } } });
      if (!current) throw new NotFoundException('Offre fournisseur introuvable');
      await this.lockItem(tx, me, current);
      const before = await tx.supplierProduct.findUniqueOrThrow({ where: { id } });
      if (dto.isPreferred) await this.clearPreferred(tx, before, id);
      const next = {
        ...dto,
        quantityPerPurchaseUnit: dto.quantityPerPurchaseUnit !== undefined ? toDecimal(dto.quantityPerPurchaseUnit) : undefined,
        unitPrice: big(dto.unitPrice),
      };
      const { oldValues, newValues, changed } = diff(before, next);
      if (!changed) return presentOffer(await tx.supplierProduct.findUniqueOrThrow({ where: { id }, include: offerInclude }));
      const priceChanged = 'unitPrice' in newValues;
      const updated = await tx.supplierProduct.update({
        where: { id },
        data: { ...newValues, ...(priceChanged ? { priceUpdatedAt: new Date() } : {}) },
        include: offerInclude,
      });
      await this.audit.record(
        {
          action: priceChanged ? 'SUPPLIER_PRICE_CHANGED' : 'SUPPLIER_OFFER_UPDATED',
          entityType: 'SupplierProduct',
          entityId: id,
          establishmentId: null,
          oldValues,
          newValues,
        },
        tx,
      );
      return presentOffer(updated);
    });
  }
}

@ApiTags('Catalogue — fournisseurs')
@ApiBearerAuth()
@Controller()
export class SuppliersController {
  constructor(private readonly service: SuppliersService) {}

  @Get('suppliers')
  @RequirePermissions('suppliers.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser, @Query() q: SupplierQuery) {
    return this.service.list(me, q);
  }

  @Get('suppliers/:id')
  @RequirePermissions('suppliers.view')
  @AnyEstablishmentScope()
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  // Le fichier fournisseurs est commun au groupe : un responsable achats
  // de n'importe quel établissement peut le tenir à jour (tout est audité).
  @Post('suppliers')
  @RequirePermissions('suppliers.manage')
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateSupplierDto) {
    return this.service.create(me, dto);
  }

  @Patch('suppliers/:id')
  @RequirePermissions('suppliers.manage')
  @AnyEstablishmentScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) {
    return this.service.update(me, id, dto);
  }

  @Post('supplier-products')
  @RequirePermissions('suppliers.manage')
  @AnyEstablishmentScope()
  createOffer(@CurrentUser() me: AuthUser, @Body() dto: CreateSupplierProductDto) {
    return this.service.createOffer(me, dto);
  }

  @Patch('supplier-products/:id')
  @RequirePermissions('suppliers.manage')
  @AnyEstablishmentScope()
  updateOffer(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierProductDto) {
    return this.service.updateOffer(me, id, dto);
  }
}
