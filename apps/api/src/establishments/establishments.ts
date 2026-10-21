import { Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, PartialType } from '@nestjs/swagger';
import { EstablishmentType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AuthUser, CurrentUser, GroupScope, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateEstablishmentDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9]{2,6}$/, { message: 'Code : 2 à 6 lettres majuscules ou chiffres (ex. PLT)' })
  code: string;

  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsEnum(EstablishmentType) type: EstablishmentType;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(255) address?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) city?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(500) receiptHeader?: string;
  @IsOptional() @IsString() @MaxLength(500) receiptFooter?: string;
}

export class UpdateEstablishmentDto extends PartialType(CreateEstablishmentDto) {
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** Modules disponibles selon le type d'établissement. */
export function modulesFor(type: EstablishmentType) {
  const restaurant = type.includes('RESTAURANT');
  const patisserie = type.includes('PATISSERIE');
  const boulangerie = type.includes('BOULANGERIE');
  return { restaurant, patisserie, boulangerie, production: patisserie || boulangerie || restaurant };
}

@Injectable()
export class EstablishmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(me: AuthUser) {
    const items = await this.prisma.establishment.findMany({
      where: {
        companyId: me.companyId,
        deletedAt: null,
        // Accès groupe : tous, y compris inactifs. Sinon uniquement ceux autorisés.
        ...(me.access.global.has('establishments.view') ? {} : { id: { in: me.access.establishmentsWith('establishments.view') } }),
      },
      orderBy: { name: 'asc' },
    });
    return items.map((e) => ({ ...e, modules: modulesFor(e.type) }));
  }

  async get(me: AuthUser, id: string) {
    const e = await this.prisma.establishment.findFirst({ where: { id, companyId: me.companyId, deletedAt: null } });
    if (!e || (!me.access.global.has('establishments.view') && !me.access.can('establishments.view', id))) {
      throw new NotFoundException('Établissement introuvable');
    }
    return { ...e, modules: modulesFor(e.type) };
  }

  async create(me: AuthUser, dto: CreateEstablishmentDto) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.establishment.create({ data: { ...dto, email: dto.email?.toLowerCase(), companyId: me.companyId } });
      await this.audit.record(
        { action: 'ESTABLISHMENT_CREATED', entityType: 'Establishment', entityId: created.id, establishmentId: created.id, newValues: created },
        tx,
      );
      return created;
    });
  }

  async update(me: AuthUser, id: string, dto: UpdateEstablishmentDto) {
    return this.prisma.$transaction(async (tx) => {
      // Verrou de ligne : deux modifications simultanées s'appliquent l'une après l'autre
      // et le journal reflète la bonne « ancienne valeur ».
      await tx.$queryRaw`SELECT id FROM establishments WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.establishment.findFirst({ where: { id, companyId: me.companyId, deletedAt: null } });
      if (!before) throw new NotFoundException('Établissement introuvable');
      const { oldValues, newValues, changed } = diff(before, { ...dto, email: dto.email?.toLowerCase() });
      if (!changed) return before;
      const updated = await tx.establishment.update({ where: { id }, data: newValues });
      await this.audit.record(
        {
          action: dto.isActive === false ? 'ESTABLISHMENT_DEACTIVATED' : 'ESTABLISHMENT_UPDATED',
          entityType: 'Establishment',
          entityId: id,
          establishmentId: id,
          oldValues,
          newValues,
        },
        tx,
      );
      return updated;
    });
  }
}

@ApiTags('Établissements')
@ApiBearerAuth()
@Controller('establishments')
export class EstablishmentsController {
  constructor(private readonly service: EstablishmentsService) {}

  // Pas d'en-tête établissement requis : la liste est filtrée selon les droits.
  @Get()
  list(@CurrentUser() me: AuthUser) {
    return this.service.list(me);
  }

  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  // Création et modification : réservées aux rôles de niveau groupe.
  @Post()
  @RequirePermissions('establishments.manage')
  @GroupScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateEstablishmentDto) {
    return this.service.create(me, dto);
  }

  @Patch(':id')
  @RequirePermissions('establishments.manage')
  @GroupScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEstablishmentDto) {
    return this.service.update(me, id, dto);
  }
}
