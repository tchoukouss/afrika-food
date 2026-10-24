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
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CashSession, CashSessionStatus, PaymentMethod, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { Db, PrismaService, Tx } from '../prisma/prisma.service';
import { idempotent, userNames } from '../stock/common';
import { assertCan, emptyToNull, establishmentsWithAny, lockSalesRow, METHOD_LABELS, nextSalesNumber, trim, uniqueViolation } from './common';

const MAX_AMOUNT = 1_000_000_000;

export class OpenSessionDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() registerId: string;
  /** Fond de caisse en espèces (FCFA). */
  @IsInt() @Min(0) @Max(MAX_AMOUNT) openingFloat: number;
}

export class ManualMovementDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsIn(['MANUAL_IN', 'MANUAL_OUT']) type: 'MANUAL_IN' | 'MANUAL_OUT';
  @IsInt() @Min(1) @Max(MAX_AMOUNT) amount: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class CountDto {
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsInt() @Min(0) @Max(MAX_AMOUNT) counted: number;
}

export class CloseSessionDto {
  /** Montants comptés par moyen de paiement (espèces obligatoires). */
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => CountDto) counts: CountDto[];
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) note?: string | null;
}

export class ValidateSessionDto {
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) note?: string | null;
}

class SessionQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() registerId?: string;
  @IsOptional() @IsEnum(CashSessionStatus) status?: CashSessionStatus;
}

/** Droits de validation d'une clôture : responsable, autre que le caissier (décision 6). */
const SESSION_VALIDATOR = ['cash.view_all', 'cash.movements'];

/** Montant attendu par moyen de paiement : somme des mouvements de la session. */
export async function expectedByMethod(db: Db, sessionId: string) {
  const rows = await db.cashMovement.groupBy({ by: ['method'], where: { sessionId }, _sum: { amount: true } });
  const map = new Map<PaymentMethod, bigint>();
  rows.forEach((r) => map.set(r.method, r._sum.amount ?? 0n));
  return map;
}

/**
 * Mouvement de caisse d'un paiement ou d'un remboursement client (module 7,
 * décision D1), dans la transaction de l'opération : session ouverte de
 * l'établissement, verrouillée ; pour un encaissement ou un remboursement,
 * session de l'utilisateur lui-même. Une sortie d'espèces ne dépasse jamais
 * les espèces présentes. Le montant apparaît au rapport Z et dans l'attendu
 * de la clôture, jamais dans les ventes.
 */
export async function customerCashMovement(
  tx: Tx,
  me: AuthUser,
  input: { sessionId: string; establishmentId: string; type: 'CUSTOMER_PAYMENT' | 'CUSTOMER_REFUND'; method: PaymentMethod; amount: bigint; reason: string | null; ownSession: boolean },
) {
  await lockSalesRow(tx, 'cash_sessions', input.sessionId);
  const s = await tx.cashSession.findFirst({ where: { id: input.sessionId, companyId: me.companyId } });
  if (!s || s.establishmentId !== input.establishmentId) throw new BadRequestException('Session de caisse invalide pour cet établissement');
  if (s.status !== 'OPEN') throw new ConflictException('Session de caisse clôturée');
  if (input.ownSession) {
    assertCan(me, s.establishmentId, 'cash.operate');
    if (s.cashierId !== me.userId) throw new ForbiddenException('Cette session de caisse appartient à un autre caissier');
  }
  if (input.type === 'CUSTOMER_REFUND' && input.method === 'CASH') {
    const cash = (await expectedByMethod(tx, s.id)).get('CASH') ?? 0n;
    if (input.amount > cash) throw new ConflictException(`Remboursement impossible : il n’y a que ${cash} FCFA en espèces dans la caisse`);
  }
  return tx.cashMovement.create({
    data: {
      companyId: me.companyId,
      establishmentId: s.establishmentId,
      sessionId: s.id,
      type: input.type,
      method: input.method,
      amount: input.type === 'CUSTOMER_REFUND' ? -input.amount : input.amount,
      reason: input.reason,
      userId: me.userId,
    },
  });
}

@Injectable()
export class CashSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Sessions visibles : les siennes, et toutes celles des établissements où l'on « voit toutes les caisses ». */
  private visibleWhere(me: AuthUser, establishmentId?: string): Prisma.CashSessionWhereInput {
    const all = establishmentsWithAny(me, ['cash.view_all'], establishmentId);
    const own = establishmentsWithAny(me, ['cash.operate', 'cash.view_all'], establishmentId);
    return { companyId: me.companyId, OR: [{ establishmentId: { in: all } }, { establishmentId: { in: own }, cashierId: me.userId }] };
  }

  private canSee(me: AuthUser, s: CashSession) {
    return me.access.canAccessEstablishment(s.establishmentId) && (me.access.can('cash.view_all', s.establishmentId) || s.cashierId === me.userId);
  }

  async list(me: AuthUser, q: SessionQuery) {
    const rows = await this.prisma.cashSession.findMany({
      where: { ...this.visibleWhere(me, q.establishmentId), registerId: q.registerId, status: q.status },
      include: { register: { select: { id: true, code: true, name: true } } },
      orderBy: { openedAt: 'desc' },
      take: 300,
    });
    const names = await userNames(this.prisma, me.companyId, rows.flatMap((r) => [r.cashierId, r.validatedById]));
    const totals = await this.prisma.sale.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: rows.map((r) => r.id) }, status: { not: 'CANCELLED' } },
      _sum: { total: true, refundedTotal: true },
      _count: true,
    });
    return rows.map((r) => {
      const t = totals.find((x) => x.sessionId === r.id);
      return {
        ...r,
        cashier: names.get(r.cashierId) ?? null,
        validatedBy: r.validatedById ? names.get(r.validatedById) ?? null : null,
        salesCount: t?._count ?? 0,
        salesTotal: (t?._sum.total ?? 0n) - (t?._sum.refundedTotal ?? 0n),
      };
    });
  }

  /** Session ouverte de l'utilisateur connecté (une seule possible). */
  async current(me: AuthUser) {
    const s = await this.prisma.cashSession.findFirst({ where: { companyId: me.companyId, cashierId: me.userId, status: 'OPEN' } });
    return s ? this.get(me, s.id) : null;
  }

  async get(me: AuthUser, id: string) {
    const s = await this.prisma.cashSession.findFirst({
      where: { id, companyId: me.companyId },
      include: { register: true, movements: { orderBy: { createdAt: 'asc' } }, closures: true },
    });
    if (!s || !this.canSee(me, s)) throw new NotFoundException('Session de caisse introuvable');
    const expected = await expectedByMethod(this.prisma, id);
    const names = await userNames(this.prisma, me.companyId, [s.cashierId, s.validatedById, ...s.movements.map((m) => m.userId)]);
    const saleIds = [...new Set(s.movements.map((m) => m.saleId).filter((x): x is string => !!x))];
    const sales = await this.prisma.sale.findMany({ where: { id: { in: saleIds } }, select: { id: true, number: true } });
    return {
      ...s,
      cashier: names.get(s.cashierId) ?? null,
      validatedBy: s.validatedById ? names.get(s.validatedById) ?? null : null,
      movements: s.movements.map((m) => ({ ...m, user: names.get(m.userId) ?? null, saleNumber: sales.find((x) => x.id === m.saleId)?.number ?? null })),
      expected: [...expected].map(([method, amount]) => ({ method, amount })),
      canValidate: s.status === 'CLOSED' && s.cashierId !== me.userId && SESSION_VALIDATOR.every((p) => me.access.can(p, s.establishmentId)),
      canMoveCash: s.status === 'OPEN' && me.access.can('cash.movements', s.establishmentId),
    };
  }

  // --- Ouverture -------------------------------------------------------------------

  open(me: AuthUser, dto: OpenSessionDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.cashSession
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((s) => s && { id: s.id, ownerId: s.cashierId }),
      () => this.doOpen(me, dto),
      (id) => this.get(me, id),
    );
  }

  private async doOpen(me: AuthUser, dto: OpenSessionDto) {
    const reg = await this.prisma.cashRegister.findFirst({ where: { id: dto.registerId, companyId: me.companyId } });
    if (!reg) throw new NotFoundException('Caisse introuvable');
    assertCan(me, reg.establishmentId, 'cash.operate');
    if (!reg.isActive) throw new BadRequestException('Caisse désactivée');
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        await lockSalesRow(tx, 'cash_registers', reg.id);
        const est = await tx.establishment.findUniqueOrThrow({ where: { id: reg.establishmentId } });
        const busy = await tx.cashSession.findFirst({ where: { OR: [{ registerId: reg.id }, { cashierId: me.userId }], status: 'OPEN' } });
        if (busy) throw this.busyError(busy.registerId === reg.id);
        const session = await tx.cashSession.create({
          data: {
            companyId: me.companyId,
            establishmentId: reg.establishmentId,
            registerId: reg.id,
            number: await nextSalesNumber(tx, me.companyId, 'CASH_SESSION', est),
            clientRequestId: dto.clientRequestId ?? null,
            cashierId: me.userId,
            openingFloat: BigInt(dto.openingFloat),
          },
        });
        if (dto.openingFloat > 0) {
          await tx.cashMovement.create({
            data: {
              companyId: me.companyId,
              establishmentId: reg.establishmentId,
              sessionId: session.id,
              type: 'OPENING_FLOAT',
              method: 'CASH',
              amount: BigInt(dto.openingFloat),
              userId: me.userId,
            },
          });
        }
        await this.audit.record(
          { action: 'CASH_SESSION_OPENED', entityType: 'CashSession', entityId: session.id, establishmentId: reg.establishmentId, newValues: { number: session.number, register: reg.code, openingFloat: dto.openingFloat } },
          tx,
        );
        return session.id;
      });
    } catch (e) {
      // Deux ouvertures simultanées : l'index unique partiel n'en laisse passer qu'une.
      if (uniqueViolation(e, 'one_open_per_register')) throw this.busyError(true);
      if (uniqueViolation(e, 'one_open_per_cashier')) throw this.busyError(false);
      throw e;
    }
    return this.get(me, id);
  }

  private busyError(sameRegister: boolean) {
    return new ConflictException(
      sameRegister ? 'Une session est déjà ouverte sur cette caisse' : 'Vous avez déjà une session ouverte : clôturez-la avant d’en ouvrir une autre',
    );
  }

  // --- Mouvements manuels ----------------------------------------------------------

  movement(me: AuthUser, id: string, dto: ManualMovementDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.cashMovement
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((m) => m && { id: m.sessionId, ownerId: m.userId }),
      () => this.doMovement(me, id, dto),
      (sessionId) => this.get(me, sessionId),
    );
  }

  private async doMovement(me: AuthUser, id: string, dto: ManualMovementDto) {
    await this.prisma.$transaction(async (tx) => {
      await lockSalesRow(tx, 'cash_sessions', id);
      const s = await tx.cashSession.findFirst({ where: { id, companyId: me.companyId } });
      if (!s) throw new NotFoundException('Session de caisse introuvable');
      assertCan(me, s.establishmentId, 'cash.movements');
      if (s.status !== 'OPEN') throw new ConflictException('Session clôturée : aucun mouvement possible');
      const amount = BigInt(dto.amount);
      if (dto.type === 'MANUAL_OUT') {
        const cash = (await expectedByMethod(tx, id)).get('CASH') ?? 0n;
        if (amount > cash) throw new ConflictException(`Sortie impossible : il n’y a que ${cash} FCFA en espèces dans la caisse`);
      }
      const m = await tx.cashMovement.create({
        data: {
          companyId: me.companyId,
          establishmentId: s.establishmentId,
          sessionId: id,
          type: dto.type,
          method: 'CASH',
          amount: dto.type === 'MANUAL_OUT' ? -amount : amount,
          reason: dto.reason,
          clientRequestId: dto.clientRequestId ?? null,
          userId: me.userId,
        },
      });
      await this.audit.record(
        { action: dto.type === 'MANUAL_IN' ? 'CASH_IN' : 'CASH_OUT', entityType: 'CashSession', entityId: id, establishmentId: s.establishmentId, newValues: { movementId: m.id, amount: m.amount }, reason: dto.reason },
        tx,
      );
    });
    return this.get(me, id);
  }

  // --- Clôture et validation -------------------------------------------------------

  async close(me: AuthUser, id: string, dto: CloseSessionDto) {
    await this.prisma.$transaction(async (tx) => {
      await lockSalesRow(tx, 'cash_sessions', id);
      const s = await tx.cashSession.findFirst({ where: { id, companyId: me.companyId } });
      if (!s) throw new NotFoundException('Session de caisse introuvable');
      assertCan(me, s.establishmentId, 'cash.operate');
      if (s.cashierId !== me.userId) throw new ForbiddenException('Seul le caissier de la session peut la compter et la clôturer');
      if (s.status !== 'OPEN') throw new ConflictException('Session déjà clôturée');
      const counted = new Map<PaymentMethod, bigint>();
      for (const c of dto.counts) {
        if (counted.has(c.method)) throw new BadRequestException(`${METHOD_LABELS[c.method]} compté deux fois`);
        counted.set(c.method, BigInt(c.counted));
      }
      const expected = await expectedByMethod(tx, id);
      if (!counted.has('CASH')) throw new BadRequestException('Le comptage des espèces est obligatoire');
      for (const [method, amount] of expected) {
        if (amount !== 0n && !counted.has(method)) throw new BadRequestException(`Montant compté manquant pour ${METHOD_LABELS[method]}`);
      }
      const methods = new Set<PaymentMethod>([...expected.keys(), ...counted.keys()]);
      const closures = [...methods].map((method) => {
        const exp = expected.get(method) ?? 0n;
        const cnt = counted.get(method) ?? 0n;
        return { sessionId: id, method, expected: exp, counted: cnt, difference: cnt - exp };
      });
      await tx.cashClosure.createMany({ data: closures });
      await tx.cashSession.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), closingNote: dto.note ?? null } });
      await this.audit.record(
        {
          action: 'CASH_SESSION_CLOSED',
          entityType: 'CashSession',
          entityId: id,
          establishmentId: s.establishmentId,
          newValues: { number: s.number, closures: closures.map((c) => ({ method: c.method, expected: c.expected, counted: c.counted, difference: c.difference })) },
          reason: dto.note ?? null,
        },
        tx,
      );
    });
    return this.get(me, id);
  }

  async validate(me: AuthUser, id: string, dto: ValidateSessionDto) {
    await this.prisma.$transaction(async (tx) => {
      await lockSalesRow(tx, 'cash_sessions', id);
      const s = await tx.cashSession.findFirst({ where: { id, companyId: me.companyId } });
      if (!s) throw new NotFoundException('Session de caisse introuvable');
      assertCan(me, s.establishmentId, ...SESSION_VALIDATOR);
      if (s.cashierId === me.userId) throw new ForbiddenException('La clôture doit être validée par un autre responsable que le caissier');
      if (s.status !== 'CLOSED') throw new ConflictException(s.status === 'OPEN' ? 'La session n’est pas encore clôturée' : 'Clôture déjà validée');
      await tx.cashSession.update({ where: { id }, data: { status: 'VALIDATED', validatedById: me.userId, validatedAt: new Date(), validationNote: dto.note ?? null } });
      await this.audit.record({ action: 'CASH_SESSION_VALIDATED', entityType: 'CashSession', entityId: id, establishmentId: s.establishmentId, newValues: { number: s.number }, reason: dto.note ?? null }, tx);
    });
    return this.get(me, id);
  }

  /** Rapport Z : synthèse de la session (ventes, remises, TVA, moyens de paiement, retours, écarts). */
  async report(me: AuthUser, id: string) {
    const session = await this.get(me, id);
    const [byStatus, sums, payments, returns, est] = await Promise.all([
      this.prisma.sale.groupBy({ by: ['status'], where: { sessionId: id }, _count: true, _sum: { total: true } }),
      this.prisma.sale.aggregate({
        where: { sessionId: id, status: { not: 'CANCELLED' } },
        _sum: { grossTotal: true, lineDiscountTotal: true, ticketDiscountAmount: true, total: true, taxTotal: true, costTotal: true },
      }),
      this.prisma.cashMovement.groupBy({ by: ['method', 'type'], where: { sessionId: id }, _sum: { amount: true }, _count: true }),
      this.prisma.saleReturn.groupBy({ by: ['kind'], where: { sessionId: id }, _sum: { total: true }, _count: true }),
      this.prisma.establishment.findUniqueOrThrow({ where: { id: session.establishmentId }, select: { code: true, name: true } }),
    ]);
    return {
      session,
      establishment: est,
      salesByStatus: byStatus.map((r) => ({ status: r.status, count: r._count, total: r._sum.total ?? 0n })),
      totals: {
        gross: sums._sum.grossTotal ?? 0n,
        discounts: (sums._sum.lineDiscountTotal ?? 0n) + (sums._sum.ticketDiscountAmount ?? 0n),
        total: sums._sum.total ?? 0n,
        tax: sums._sum.taxTotal ?? 0n,
        cost: sums._sum.costTotal ?? new Prisma.Decimal(0),
      },
      movements: payments.map((p) => ({ method: p.method, type: p.type, count: p._count, amount: p._sum.amount ?? 0n })),
      returns: returns.map((r) => ({ kind: r.kind, count: r._count, total: r._sum.total ?? 0n })),
    };
  }
}

@ApiTags('Caisse')
@ApiBearerAuth()
@Controller('cash-sessions')
export class CashSessionsController {
  constructor(private readonly service: CashSessionsService) {}

  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: SessionQuery) {
    return this.service.list(me, q);
  }

  @Get('current')
  async current(@CurrentUser() me: AuthUser) {
    return { session: await this.service.current(me) };
  }

  @Get(':id')
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Get(':id/report')
  report(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.report(me, id);
  }

  @Post()
  @RequirePermissions('cash.operate')
  @AnyEstablishmentScope()
  open(@CurrentUser() me: AuthUser, @Body() dto: OpenSessionDto) {
    return this.service.open(me, dto);
  }

  @Post(':id/movements')
  @RequirePermissions('cash.movements')
  @AnyEstablishmentScope()
  movement(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ManualMovementDto) {
    return this.service.movement(me, id, dto);
  }

  @Post(':id/close')
  @RequirePermissions('cash.operate')
  @AnyEstablishmentScope()
  close(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseSessionDto) {
    return this.service.close(me, id, dto);
  }

  @Post(':id/validate')
  @RequirePermissions(...SESSION_VALIDATOR)
  @AnyEstablishmentScope()
  validate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ValidateSessionDto) {
    return this.service.validate(me, id, dto);
  }
}
