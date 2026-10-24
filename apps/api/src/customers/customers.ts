import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CustomerType, Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { uniqueViolation } from '../sales/common';
import { idempotent, userNames } from '../stock/common';
import { CustomerCreditService } from './credit';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);
const MAX_AMOUNT = 1_000_000_000_000;

/**
 * Téléphone ramené à ses chiffres pour l'unicité : espaces, points et tirets
 * retirés, indicatif ivoirien (+225 / 00225) retiré.
 */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else digits = `225${digits}`;
  if (digits.startsWith('225') && digits.length > 9) digits = digits.slice(3);
  digits = digits.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) throw new BadRequestException('Numéro de téléphone invalide');
  return digits;
}

export class CreateCustomerDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsEnum(CustomerType) type: CustomerType;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(150) name: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsEmail({}, { message: 'Adresse e-mail invalide' }) @MaxLength(150) email?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(50) taxId?: string | null;
  /** Limite de crédit (FCFA) ; vide = pas de crédit. Réservé à « Autoriser un dépassement de crédit ». */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) creditLimit?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermDays?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
}

export class UpdateCustomerDto {
  @IsOptional() @IsEnum(CustomerType) type?: CustomerType;
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(150) name?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsEmail({}, { message: 'Adresse e-mail invalide' }) @MaxLength(150) email?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(50) taxId?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) creditLimit?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermDays?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class CustomerQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsEnum(CustomerType) type?: CustomerType;
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeInactive?: boolean;
}

/** Les conditions de crédit (limite, délai de paiement) relèvent d'un responsable habilité. */
function assertCreditRights(me: AuthUser) {
  if (!me.access.global.has('credit.override') && !me.access.establishmentsWith('credit.override').length) {
    throw new ForbiddenException('Seul un responsable habilité à autoriser le crédit fixe la limite et le délai de paiement');
  }
}

/** Fichier clients commun au groupe (décision D9) ; documents et finances par établissement. */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly credit: CustomerCreditService,
  ) {}

  list(me: AuthUser, q: CustomerQuery) {
    const where: Prisma.CustomerWhereInput = { companyId: me.companyId, type: q.type, ...(q.includeInactive ? {} : { isActive: true }) };
    if (q.q) {
      const digits = q.q.replace(/\D/g, '');
      where.OR = [{ name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }, ...(digits.length >= 4 ? [{ phoneNormalized: { contains: digits } }] : [])];
    }
    return this.prisma.customer.findMany({ where, orderBy: { name: 'asc' }, take: 200 });
  }

  async get(me: AuthUser, id: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, companyId: me.companyId } });
    if (!c) throw new NotFoundException('Client introuvable');
    const names = await userNames(this.prisma, me.companyId, [c.createdById]);
    const limit = c.creditLimit ?? 0n;
    const outstanding = await this.credit.outstanding(this.prisma, c.id);
    return { ...c, createdBy: names.get(c.createdById) ?? null, credit: { limit: c.creditLimit, outstanding, available: limit > outstanding ? limit - outstanding : 0n } };
  }

  create(me: AuthUser, dto: CreateCustomerDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.customer
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((c) => c && { id: c.id, ownerId: c.createdById }),
      () => this.doCreate(me, dto),
      (id) => this.get(me, id),
    );
  }

  private async doCreate(me: AuthUser, dto: CreateCustomerDto) {
    if ((dto.creditLimit !== undefined && dto.creditLimit !== null) || dto.paymentTermDays) assertCreditRights(me);
    const phoneNormalized = dto.phone ? normalizePhone(dto.phone) : null;
    await this.assertPhoneFree(me, phoneNormalized);
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const c = await tx.customer.create({
          data: {
            companyId: me.companyId,
            clientRequestId: dto.clientRequestId ?? null,
            type: dto.type,
            name: dto.name,
            phone: dto.phone ?? null,
            phoneNormalized,
            email: dto.email ?? null,
            address: dto.address ?? null,
            taxId: dto.taxId ?? null,
            creditLimit: dto.creditLimit === undefined || dto.creditLimit === null ? null : BigInt(dto.creditLimit),
            paymentTermDays: dto.paymentTermDays ?? 0,
            notes: dto.notes ?? null,
            createdById: me.userId,
          },
        });
        await this.audit.record({ action: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: c.id, establishmentId: null, newValues: c }, tx);
        return c.id;
      });
      return this.get(me, id);
    } catch (e) {
      if (uniqueViolation(e, 'phone')) throw this.phoneTaken();
      throw e;
    }
  }

  async update(me: AuthUser, id: string, dto: UpdateCustomerDto) {
    if (dto.creditLimit !== undefined || dto.paymentTermDays !== undefined) assertCreditRights(me);
    const data: Prisma.CustomerUpdateInput & Record<string, unknown> = {
      ...dto,
      ...(dto.creditLimit !== undefined ? { creditLimit: dto.creditLimit === null ? null : BigInt(dto.creditLimit) } : {}),
    };
    if (dto.phone !== undefined) {
      data.phoneNormalized = dto.phone ? normalizePhone(dto.phone) : null;
      await this.assertPhoneFree(me, data.phoneNormalized as string | null, id);
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customers WHERE id = ${id}::uuid FOR UPDATE`;
        const current = await tx.customer.findFirst({ where: { id, companyId: me.companyId } });
        if (!current) throw new NotFoundException('Client introuvable');
        // BigInt (limite de crédit) comparé sous forme de texte : JSON.stringify ne le sérialise pas.
        const asText = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
        const { oldValues, newValues, changed } = diff(asText(current), asText(data));
        if (!changed) return;
        await tx.customer.update({ where: { id }, data });
        const credit = 'creditLimit' in newValues || 'paymentTermDays' in newValues;
        await this.audit.record({ action: credit ? 'CUSTOMER_CREDIT_UPDATED' : 'CUSTOMER_UPDATED', entityType: 'Customer', entityId: id, establishmentId: null, oldValues, newValues }, tx);
      });
    } catch (e) {
      if (uniqueViolation(e, 'phone')) throw this.phoneTaken();
      throw e;
    }
    return this.get(me, id);
  }

  private async assertPhoneFree(me: AuthUser, phoneNormalized: string | null, exceptId?: string) {
    if (!phoneNormalized) return;
    const other = await this.prisma.customer.findFirst({ where: { companyId: me.companyId, phoneNormalized, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (other) throw this.phoneTaken(other.name);
  }

  private phoneTaken(name?: string) {
    return new ConflictException(`Ce numéro de téléphone est déjà utilisé${name ? ` par le client « ${name} »` : ''}`);
  }
}

@ApiTags('Clients')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly service: CustomersService) {}

  @Get()
  @RequirePermissions('customers.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser, @Query() q: CustomerQuery) {
    return this.service.list(me, q);
  }

  @Get(':id')
  @RequirePermissions('customers.view')
  @AnyEstablishmentScope()
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post()
  @RequirePermissions('customers.manage')
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateCustomerDto) {
    return this.service.create(me, dto);
  }

  @Patch(':id')
  @RequirePermissions('customers.manage')
  @AnyEstablishmentScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.service.update(me, id, dto);
  }
}
