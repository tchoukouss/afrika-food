import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { idempotent, userNames } from '../stock/common';
import { assertAny, emptyToNull, readableWith, restaurantEstablishment, trim } from './common';

export class ReservationDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsDateString() reservedAt: string;
  @IsInt() @Min(1) @Max(500) covers: number;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @IsUUID() tableId?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) note?: string | null;
}

export class UpdateReservationDto {
  @IsOptional() @IsDateString() reservedAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(500) covers?: number;
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @IsUUID() tableId?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) note?: string | null;
}

export class ReservationStatusDto {
  @IsIn(['NO_SHOW', 'CANCELLED']) status: 'NO_SHOW' | 'CANCELLED';
}

class ReservationQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  /** Jour (AAAA-MM-JJ) ; par défaut aujourd'hui. */
  @IsOptional() @IsDateString() date?: string;
}

/**
 * Réservations simples (décision R9) : la table passe « réservée » 60 min
 * avant l'heure ; l'arrivée se fait en ouvrant la commande sur la réservation ;
 * « non venu » et annulation sont posés à la main. Pas d'acompte (module 7).
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(me: AuthUser, q: ReservationQuery) {
    const ests = readableWith(me, ['restaurant.orders', 'restaurant.tables'], q.establishmentId);
    const day = (q.date ?? new Date().toISOString()).slice(0, 10);
    const from = new Date(`${day}T00:00:00.000Z`);
    const rows = await this.prisma.restaurantReservation.findMany({
      where: { companyId: me.companyId, establishmentId: { in: ests }, reservedAt: { gte: from, lt: new Date(from.getTime() + 86_400_000) } },
      orderBy: { reservedAt: 'asc' },
    });
    const [tables, names] = await Promise.all([
      this.prisma.restaurantTable.findMany({ where: { id: { in: rows.map((r) => r.tableId).filter((x): x is string => !!x) } }, select: { id: true, code: true } }),
      userNames(this.prisma, me.companyId, rows.map((r) => r.createdById)),
    ]);
    return rows.map((r) => ({ ...r, table: tables.find((t) => t.id === r.tableId) ?? null, createdBy: names.get(r.createdById) ?? null }));
  }

  private async checkTable(establishmentId: string, tableId?: string | null) {
    if (!tableId) return;
    const t = await this.prisma.restaurantTable.findFirst({ where: { id: tableId, establishmentId, isActive: true } });
    if (!t) throw new BadRequestException('Table invalide pour cet établissement');
  }

  create(me: AuthUser, dto: ReservationDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.restaurantReservation
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((r) => r && { id: r.id, ownerId: r.createdById }),
      async () => {
        const est = await restaurantEstablishment(this.prisma, me, dto.establishmentId, 'restaurant.orders');
        await this.checkTable(est.id, dto.tableId);
        return this.prisma.$transaction(async (tx) => {
          const r = await tx.restaurantReservation.create({
            data: {
              companyId: me.companyId,
              establishmentId: est.id,
              clientRequestId: dto.clientRequestId ?? null,
              tableId: dto.tableId ?? null,
              reservedAt: new Date(dto.reservedAt),
              covers: dto.covers,
              name: dto.name,
              phone: dto.phone ?? null,
              note: dto.note ?? null,
              createdById: me.userId,
            },
          });
          await this.audit.record({ action: 'RESTAURANT_RESERVATION_CREATED', entityType: 'RestaurantReservation', entityId: r.id, establishmentId: est.id, newValues: r }, tx);
          return r;
        });
      },
      (id) => this.prisma.restaurantReservation.findUniqueOrThrow({ where: { id } }),
    );
  }

  private async find(me: AuthUser, id: string) {
    const r = await this.prisma.restaurantReservation.findFirst({ where: { id, companyId: me.companyId } });
    if (!r) throw new NotFoundException('Réservation introuvable');
    assertAny(me, r.establishmentId, 'restaurant.orders');
    return r;
  }

  async update(me: AuthUser, id: string, dto: UpdateReservationDto) {
    const r = await this.find(me, id);
    if (r.status !== 'CONFIRMED') throw new ConflictException('Réservation déjà traitée');
    await this.checkTable(r.establishmentId, dto.tableId);
    const data = { ...dto, reservedAt: dto.reservedAt ? new Date(dto.reservedAt) : undefined };
    const { oldValues, newValues, changed } = diff(r as unknown as Record<string, unknown>, data);
    if (!changed) return r;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.restaurantReservation.update({ where: { id }, data });
      await this.audit.record({ action: 'RESTAURANT_RESERVATION_UPDATED', entityType: 'RestaurantReservation', entityId: id, establishmentId: r.establishmentId, oldValues, newValues }, tx);
      return updated;
    });
  }

  async setStatus(me: AuthUser, id: string, dto: ReservationStatusDto) {
    const r = await this.find(me, id);
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.restaurantReservation.updateMany({ where: { id, status: 'CONFIRMED' }, data: { status: dto.status, statusChangedAt: new Date() } });
      if (!res.count) throw new ConflictException('Réservation déjà traitée');
      await this.audit.record({ action: 'RESTAURANT_RESERVATION_STATUS', entityType: 'RestaurantReservation', entityId: id, establishmentId: r.establishmentId, newValues: { status: dto.status } }, tx);
      return tx.restaurantReservation.findUniqueOrThrow({ where: { id } });
    });
  }
}

@ApiTags('Restaurant')
@ApiBearerAuth()
@Controller('restaurant/reservations')
export class ReservationsController {
  constructor(private readonly service: ReservationsService) {}

  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: ReservationQuery) {
    return this.service.list(me, q);
  }

  @Post()
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: ReservationDto) {
    return this.service.create(me, dto);
  }

  @Patch(':id')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReservationDto) {
    return this.service.update(me, id, dto);
  }

  @Post(':id/status')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  setStatus(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReservationStatusDto) {
    return this.service.setStatus(me, id, dto);
  }
}
