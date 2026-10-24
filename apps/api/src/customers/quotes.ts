import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CustomerDocumentKind, Prisma, Quote, QuoteStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SequenceService } from '../sequences/sequence.service';
import { D, idempotent, userNames } from '../stock/common';
import { activeCustomer, assertWrite, canRead, checkEvent, DocumentLineDto, emptyToNull, EventDto, lockRowOf, priceLines, readable, todayISO, trim, WRITE } from './lines';
import { CustomerOrdersService } from './orders';

export class CreateQuoteDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsUUID() customerId: string;
  @IsOptional() @IsEnum(CustomerDocumentKind) kind?: CustomerDocumentKind;
  @IsDateString() validUntil: string;
  @IsOptional() @IsDateString() desiredAt?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @ValidateNested() @Type(() => EventDto) event?: EventDto | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => DocumentLineDto) lines: DocumentLineDto[];
}

export class UpdateQuoteDto {
  @IsOptional() @IsDateString() validUntil?: string;
  @IsOptional() @IsDateString() desiredAt?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @ValidateNested() @Type(() => EventDto) event?: EventDto;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => DocumentLineDto) lines?: DocumentLineDto[];
}

export class RefuseQuoteDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class QuoteQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsEnum(QuoteStatus) status?: QuoteStatus;
}

/** « Expiré » est calculé, jamais enregistré : envoyé et date de validité dépassée. */
export const isExpired = (q: Pick<Quote, 'status' | 'validUntil'>, today = todayISO()) => q.status === 'SENT' && q.validUntil.toISOString().slice(0, 10) < today;

const toJsonEvent = (e: EventDto) => ({ ...e }) as unknown as Prisma.InputJsonValue;

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly orders: CustomerOrdersService,
  ) {}

  async list(me: AuthUser, q: QuoteQuery) {
    const rows = await this.prisma.quote.findMany({
      where: { companyId: me.companyId, establishmentId: { in: readable(me, q.establishmentId) }, customerId: q.customerId, status: q.status },
      include: { customer: { select: { id: true, name: true, phone: true } }, order: { select: { id: true, number: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const today = todayISO();
    return rows.map((r) => ({ ...r, expired: isExpired(r, today) }));
  }

  async get(me: AuthUser, id: string) {
    const q = await this.prisma.quote.findFirst({
      where: { id, companyId: me.companyId },
      include: {
        customer: { select: { id: true, name: true, phone: true, type: true } },
        lines: { orderBy: { position: 'asc' } },
        history: { orderBy: { createdAt: 'asc' } },
        order: { select: { id: true, number: true, status: true } },
      },
    });
    if (!q || !canRead(me, q.establishmentId)) throw new NotFoundException('Devis introuvable');
    const names = await userNames(this.prisma, me.companyId, [q.createdById, ...q.history.map((h) => h.userId)]);
    return {
      ...q,
      expired: isExpired(q),
      createdBy: names.get(q.createdById) ?? null,
      history: q.history.map((h) => ({ ...h, user: names.get(h.userId) ?? null })),
      canManage: me.access.can(WRITE, q.establishmentId),
    };
  }

  // --- Création et modification ------------------------------------------------------------

  create(me: AuthUser, dto: CreateQuoteDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.quote
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((q) => q && { id: q.id, ownerId: q.createdById }),
      () => this.doCreate(me, dto),
      (id) => this.get(me, id),
    );
  }

  private async doCreate(me: AuthUser, dto: CreateQuoteDto) {
    assertWrite(me, dto.establishmentId);
    const kind = dto.kind ?? 'STANDARD';
    checkEvent(kind, dto.event);
    if (dto.validUntil.slice(0, 10) < todayISO()) throw new BadRequestException('Date de validité déjà dépassée');
    const id = await this.prisma.$transaction(async (tx) => {
      const est = await tx.establishment.findFirst({ where: { id: dto.establishmentId, companyId: me.companyId, deletedAt: null } });
      if (!est) throw new BadRequestException('Établissement invalide');
      const customer = await activeCustomer(tx, me, dto.customerId);
      const priced = await priceLines(tx, me, est.id, dto.lines);
      const quote = await tx.quote.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          customerId: customer.id,
          number: await this.sequences.next(tx, { companyId: me.companyId, docType: 'QUOTE', establishmentId: est.id, establishmentCode: est.code }),
          clientRequestId: dto.clientRequestId ?? null,
          kind,
          validUntil: new Date(`${dto.validUntil.slice(0, 10)}T00:00:00.000Z`),
          desiredAt: dto.desiredAt ? new Date(dto.desiredAt) : null,
          event: dto.event ? toJsonEvent(dto.event) : Prisma.DbNull,
          notes: dto.notes ?? null,
          total: priced.total,
          taxTotal: priced.taxTotal,
          createdById: me.userId,
          lines: { create: priced.lines },
        },
      });
      await tx.quoteStatusHistory.create({ data: { quoteId: quote.id, fromStatus: null, toStatus: 'DRAFT', userId: me.userId } });
      await this.audit.record(
        { action: 'QUOTE_CREATED', entityType: 'Quote', entityId: quote.id, establishmentId: est.id, newValues: { number: quote.number, kind, customerId: customer.id, total: quote.total, lines: priced.lines.length } },
        tx,
      );
      return quote.id;
    });
    return this.get(me, id);
  }

  private async locked(tx: Tx, me: AuthUser, id: string) {
    await lockRowOf(tx, 'quotes', id);
    const q = await tx.quote.findFirst({ where: { id, companyId: me.companyId } });
    if (!q || !canRead(me, q.establishmentId)) throw new NotFoundException('Devis introuvable');
    assertWrite(me, q.establishmentId);
    return q;
  }

  async update(me: AuthUser, id: string, dto: UpdateQuoteDto) {
    await this.prisma.$transaction(async (tx) => {
      const q = await this.locked(tx, me, id);
      if (q.status !== 'DRAFT') throw new ConflictException('Devis envoyé : il ne se modifie plus');
      if (dto.event !== undefined) checkEvent(q.kind, dto.event);
      if (dto.validUntil && dto.validUntil.slice(0, 10) < todayISO()) throw new BadRequestException('Date de validité déjà dépassée');
      const data: Prisma.QuoteUpdateInput = {};
      if (dto.validUntil) data.validUntil = new Date(`${dto.validUntil.slice(0, 10)}T00:00:00.000Z`);
      if (dto.desiredAt !== undefined) data.desiredAt = dto.desiredAt ? new Date(dto.desiredAt) : null;
      if (dto.notes !== undefined) data.notes = dto.notes;
      if (dto.event) data.event = toJsonEvent(dto.event);
      const old = { total: q.total };
      if (dto.lines) {
        const priced = await priceLines(tx, me, q.establishmentId, dto.lines);
        await tx.quoteLine.deleteMany({ where: { quoteId: id } });
        await tx.quoteLine.createMany({ data: priced.lines.map((l) => ({ ...l, quoteId: id })) });
        data.total = priced.total;
        data.taxTotal = priced.taxTotal;
      }
      const updated = await tx.quote.update({ where: { id }, data });
      await this.audit.record({ action: 'QUOTE_UPDATED', entityType: 'Quote', entityId: id, establishmentId: q.establishmentId, oldValues: old, newValues: { total: updated.total, lines: dto.lines?.length } }, tx);
    });
    return this.get(me, id);
  }

  // --- Circuit ------------------------------------------------------------------------------

  private async move(tx: Tx, me: AuthUser, q: Quote, to: QuoteStatus, data: Prisma.QuoteUpdateInput, reason: string | null) {
    await tx.quote.update({ where: { id: q.id }, data: { status: to, ...data } });
    await tx.quoteStatusHistory.create({ data: { quoteId: q.id, fromStatus: q.status, toStatus: to, reason, userId: me.userId } });
    await this.audit.record(
      { action: `QUOTE_${to}`, entityType: 'Quote', entityId: q.id, establishmentId: q.establishmentId, oldValues: { status: q.status }, newValues: { number: q.number, status: to }, reason },
      tx,
    );
  }

  async send(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const q = await this.locked(tx, me, id);
      if (q.status !== 'DRAFT') throw new ConflictException('Seul un devis en brouillon s’envoie');
      if (q.validUntil.toISOString().slice(0, 10) < todayISO()) throw new ConflictException('Date de validité dépassée : modifiez-la avant d’envoyer');
      await this.move(tx, me, q, 'SENT', { sentAt: new Date(), sentById: me.userId }, null);
    });
    return this.get(me, id);
  }

  /**
   * Acceptation : crée la commande (confirmée) aux prix figés du devis, avec
   * ses détails d'événement. Sous verrou du devis et grâce à l'unicité du lien
   * devis → commande, un devis ne crée jamais qu'une commande.
   */
  async accept(me: AuthUser, id: string) {
    const orderId = await this.prisma.$transaction(async (tx) => {
      const q = await this.locked(tx, me, id);
      if (q.status === 'ACCEPTED') throw new ConflictException('Devis déjà accepté : la commande existe déjà');
      if (q.status !== 'SENT') throw new ConflictException('Seul un devis envoyé s’accepte');
      if (isExpired(q)) throw new ConflictException('Devis expiré : établissez un nouveau devis');
      const customer = await activeCustomer(tx, me, q.customerId);
      const est = await tx.establishment.findUniqueOrThrow({ where: { id: q.establishmentId } });
      const lines = await tx.quoteLine.findMany({ where: { quoteId: id }, orderBy: { position: 'asc' } });
      const event = q.event as unknown as EventDto | null;
      const oid = await this.orders.insert(tx, me, est, customer.id, {
        clientRequestId: null,
        kind: q.kind,
        dueAt: q.desiredAt ?? (event ? new Date(event.eventDate) : null),
        notes: q.notes,
        priced: {
          lines: lines.map((l) => ({ ...l, quantity: D(l.quantity), taxRate: D(l.taxRate) })),
          total: q.total,
          taxTotal: q.taxTotal,
        },
        event: event
          ? {
              eventType: event.eventType,
              eventDate: new Date(event.eventDate),
              venue: event.venue ?? null,
              guests: event.guests ?? null,
              contactName: event.contactName ?? null,
              contactPhone: event.contactPhone ?? null,
              notes: event.notes ?? null,
            }
          : null,
        quoteId: id,
      });
      const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: oid } });
      await this.orders.transition(tx, me, order, 'CONFIRMED', `Devis ${q.number} accepté`);
      await this.move(tx, me, q, 'ACCEPTED', { acceptedAt: new Date(), acceptedById: me.userId }, null);
      return oid;
    });
    return { quote: await this.get(me, id), order: await this.orders.get(me, orderId) };
  }

  async refuse(me: AuthUser, id: string, dto: RefuseQuoteDto) {
    await this.prisma.$transaction(async (tx) => {
      const q = await this.locked(tx, me, id);
      if (q.status !== 'SENT') throw new ConflictException('Seul un devis envoyé se refuse');
      await this.move(tx, me, q, 'REFUSED', { refusedAt: new Date(), refusedById: me.userId, refuseReason: dto.reason }, dto.reason);
    });
    return this.get(me, id);
  }
}

@ApiTags('Clients')
@ApiBearerAuth()
@Controller('quotes')
export class QuotesController {
  constructor(private readonly service: QuotesService) {}

  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: QuoteQuery) {
    return this.service.list(me, q);
  }

  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post()
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateQuoteDto) {
    return this.service.create(me, dto);
  }

  @Patch(':id')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateQuoteDto) {
    return this.service.update(me, id, dto);
  }

  @Post(':id/send')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  send(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.send(me, id);
  }

  @Post(':id/accept')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  accept(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.accept(me, id);
  }

  @Post(':id/refuse')
  @RequirePermissions(WRITE)
  @AnyEstablishmentScope()
  refuse(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RefuseQuoteDto) {
    return this.service.refuse(me, id, dto);
  }
}
