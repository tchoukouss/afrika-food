import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreditOverride, Customer } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { Db, PrismaService, Tx } from '../prisma/prisma.service';
import { establishmentFor, idempotent, userNames } from '../stock/common';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const MAX_AMOUNT = 1_000_000_000_000;
/** Durée de validité d'une pré-autorisation de dépassement (spécification du module 7). */
export const OVERRIDE_VALIDITY_MS = 60 * 60_000;

export class CreateOverrideDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  /** Établissement où la vente ou la facture à crédit sera faite. */
  @IsUUID() establishmentId: string;
  @IsInt() @Min(1) @Max(MAX_AMOUNT) maxAmount: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class CancelOverrideDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class CreditQuery {
  @IsUUID() establishmentId: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(MAX_AMOUNT) amount?: number;
}

/**
 * Source de l'encours d'un client : chaque étape du module 7 (factures
 * émises, avoirs, paiements répartis) déclare sa part. Encours = somme des
 * sources. Une source peut être négative (avoirs, paiements).
 */
export type OutstandingSource = (db: Db, customerId: string) => Promise<bigint>;

export type OverrideStatus = 'ACTIVE' | 'USED' | 'CANCELLED' | 'EXPIRED';
export const overrideStatus = (o: Pick<CreditOverride, 'usedAt' | 'cancelledAt' | 'expiresAt'>, now = new Date()): OverrideStatus =>
  o.usedAt ? 'USED' : o.cancelledAt ? 'CANCELLED' : o.expiresAt <= now ? 'EXPIRED' : 'ACTIVE';

export interface CreditDecision {
  customerId: string;
  limit: bigint;
  outstanding: bigint;
  amount: bigint;
  /** Pré-autorisation consommée pour couvrir le dépassement, sinon null. */
  overrideId: string | null;
}

/**
 * Crédit client (décision D4) : encours au niveau du groupe, contrôle de la
 * limite sous verrou de la fiche client (deux opérations simultanées ne
 * peuvent pas dépasser ensemble la limite), pré-autorisations consommées
 * une seule fois.
 */
@Injectable()
export class CustomerCreditService {
  private readonly sources: OutstandingSource[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Appelé par les étapes suivantes (factures, avoirs, paiements) pour alimenter l'encours. */
  registerOutstandingSource(source: OutstandingSource) {
    this.sources.push(source);
  }

  async outstanding(db: Db, customerId: string): Promise<bigint> {
    let total = 0n;
    for (const source of this.sources) total += await source(db, customerId);
    return total;
  }

  /** Verrouille la fiche client jusqu'à la fin de la transaction. */
  async lockCustomer(tx: Tx, companyId: string, customerId: string): Promise<Customer> {
    await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId}::uuid FOR UPDATE`;
    const c = await tx.customer.findFirst({ where: { id: customerId, companyId } });
    if (!c) throw new NotFoundException('Client introuvable');
    return c;
  }

  /**
   * Contrôle d'une opération à crédit, à appeler dans la transaction du
   * document (ticket, facture). Verrouille le client ; si encours + montant
   * dépasse la limite (vide = 0), consomme la pré-autorisation fournie ou
   * refuse (409, code CREDIT_LIMIT_EXCEEDED).
   */
  async check(tx: Tx, me: AuthUser, input: { customerId: string; establishmentId: string; amount: bigint; overrideId?: string | null; reference: string }): Promise<CreditDecision> {
    if (input.amount <= 0n) throw new BadRequestException('Montant à crédit invalide');
    const customer = await this.lockCustomer(tx, me.companyId, input.customerId);
    if (!customer.isActive) throw new ConflictException({ code: 'CUSTOMER_INACTIVE', message: `Client « ${customer.name} » désactivé` });
    const limit = customer.creditLimit ?? 0n;
    const outstanding = await this.outstanding(tx, customer.id);
    const base = { customerId: customer.id, limit, outstanding, amount: input.amount };
    if (outstanding + input.amount <= limit) return { ...base, overrideId: null };
    if (!input.overrideId) {
      throw new ConflictException({
        code: 'CREDIT_LIMIT_EXCEEDED',
        message: `Limite de crédit dépassée pour « ${customer.name} » : encours ${outstanding} F, limite ${limit} F, demandé ${input.amount} F`,
        outstanding: outstanding.toString(),
        limit: limit.toString(),
        available: (limit > outstanding ? limit - outstanding : 0n).toString(),
      });
    }
    // Consommation atomique : une seule opération peut utiliser l'autorisation.
    const used = await tx.$queryRaw<{ id: string }[]>`
      UPDATE credit_overrides
      SET used_at = now(), used_by_id = ${me.userId}::uuid, used_amount = ${input.amount}, used_reference = ${input.reference}
      WHERE id = ${input.overrideId}::uuid AND company_id = ${me.companyId}::uuid AND customer_id = ${customer.id}::uuid
        AND establishment_id = ${input.establishmentId}::uuid AND used_at IS NULL AND cancelled_at IS NULL
        AND expires_at > now() AND max_amount >= ${input.amount}
      RETURNING id`;
    if (!used.length) {
      throw new ConflictException({ code: 'CREDIT_OVERRIDE_INVALID', message: 'Autorisation de dépassement expirée, déjà utilisée, annulée ou insuffisante' });
    }
    await this.audit.record(
      {
        action: 'CREDIT_OVERRIDE_USED',
        entityType: 'CreditOverride',
        entityId: input.overrideId,
        // Explicites : le contrôle peut être appelé hors d'une requête HTTP (transaction d'un autre module).
        companyId: me.companyId,
        userId: me.userId,
        establishmentId: input.establishmentId,
        newValues: { customer: customer.name, amount: input.amount, outstanding, limit, reference: input.reference },
      },
      tx,
    );
    return { ...base, overrideId: input.overrideId };
  }

  // --- Consultation -----------------------------------------------------------------

  private async findCustomer(me: AuthUser, id: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, companyId: me.companyId } });
    if (!c) throw new NotFoundException('Client introuvable');
    return c;
  }

  /** Situation de crédit (lecture seule) : limite, encours, disponible, effet d'un montant. */
  async summary(me: AuthUser, id: string, q: CreditQuery) {
    await establishmentFor(this.prisma, me, q.establishmentId, 'customers.view');
    const c = await this.findCustomer(me, id);
    const limit = c.creditLimit ?? 0n;
    const outstanding = await this.outstanding(this.prisma, c.id);
    const amount = BigInt(q.amount ?? 0);
    const active = await this.prisma.creditOverride.count({
      where: { customerId: c.id, establishmentId: q.establishmentId, usedAt: null, cancelledAt: null, expiresAt: { gt: new Date() } },
    });
    return {
      customerId: c.id,
      isActive: c.isActive,
      creditLimit: c.creditLimit,
      paymentTermDays: c.paymentTermDays,
      outstanding,
      available: limit > outstanding ? limit - outstanding : 0n,
      amount,
      withinLimit: outstanding + amount <= limit,
      activeOverrides: active,
    };
  }

  /** Établissements dont l'utilisateur voit les autorisations. */
  private overrideScope(me: AuthUser) {
    const ids = new Set<string>();
    for (const p of ['credit.override', 'receivables.view']) me.access.establishmentsWith(p).forEach((x) => ids.add(x));
    return [...ids];
  }

  async listOverrides(me: AuthUser, customerId: string) {
    await this.findCustomer(me, customerId);
    const rows = await this.prisma.creditOverride.findMany({
      where: { customerId, establishmentId: { in: this.overrideScope(me) } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const names = await userNames(this.prisma, me.companyId, rows.flatMap((r) => [r.approvedById, r.usedById, r.cancelledById]));
    const now = new Date();
    return rows.map((r) => ({
      ...r,
      status: overrideStatus(r, now),
      approvedBy: names.get(r.approvedById) ?? null,
      usedBy: r.usedById ? names.get(r.usedById) ?? null : null,
      cancelledBy: r.cancelledById ? names.get(r.cancelledById) ?? null : null,
    }));
  }

  // --- Pré-autorisations ------------------------------------------------------------

  /** Pré-autorisation donnée par un responsable : montant maximal, 1 heure, un établissement. */
  grantOverride(me: AuthUser, customerId: string, dto: CreateOverrideDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.creditOverride
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((o) => o && { id: o.id, ownerId: o.approvedById }),
      async () => {
        await establishmentFor(this.prisma, me, dto.establishmentId, 'credit.override');
        return this.prisma.$transaction(async (tx) => {
          const c = await this.lockCustomer(tx, me.companyId, customerId);
          if (!c.isActive) throw new ConflictException(`Client « ${c.name} » désactivé`);
          const now = new Date(); // création et expiration à partir du même instant : exactement 1 heure
          const o = await tx.creditOverride.create({
            data: {
              companyId: me.companyId,
              establishmentId: dto.establishmentId,
              customerId: c.id,
              clientRequestId: dto.clientRequestId ?? null,
              maxAmount: BigInt(dto.maxAmount),
              reason: dto.reason,
              approvedById: me.userId,
              createdAt: now,
              expiresAt: new Date(now.getTime() + OVERRIDE_VALIDITY_MS),
            },
          });
          await this.audit.record(
            {
              action: 'CREDIT_OVERRIDE_GRANTED',
              entityType: 'CreditOverride',
              entityId: o.id,
              establishmentId: dto.establishmentId,
              newValues: { customer: c.name, maxAmount: o.maxAmount, expiresAt: o.expiresAt },
              reason: dto.reason,
            },
            tx,
          );
          return { ...o, status: overrideStatus(o) };
        });
      },
      (id) => this.prisma.creditOverride.findUniqueOrThrow({ where: { id } }).then((o) => ({ ...o, status: overrideStatus(o) })),
    );
  }

  async cancelOverride(me: AuthUser, id: string, dto: CancelOverrideDto) {
    const o = await this.prisma.creditOverride.findFirst({ where: { id, companyId: me.companyId } });
    if (!o) throw new NotFoundException('Autorisation introuvable');
    await establishmentFor(this.prisma, me, o.establishmentId, 'credit.override');
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.creditOverride.updateMany({
        where: { id, usedAt: null, cancelledAt: null, expiresAt: { gt: new Date() } },
        data: { cancelledAt: new Date(), cancelledById: me.userId },
      });
      if (!res.count) throw new ConflictException('Autorisation déjà utilisée, annulée ou expirée');
      await this.audit.record({ action: 'CREDIT_OVERRIDE_CANCELLED', entityType: 'CreditOverride', entityId: id, establishmentId: o.establishmentId, reason: dto.reason }, tx);
      const updated = await tx.creditOverride.findUniqueOrThrow({ where: { id } });
      return { ...updated, status: overrideStatus(updated) };
    });
  }
}

@ApiTags('Clients')
@ApiBearerAuth()
@Controller()
export class CreditController {
  constructor(private readonly service: CustomerCreditService) {}

  @Get('customers/:id/credit')
  @RequirePermissions('customers.view')
  @AnyEstablishmentScope()
  summary(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: CreditQuery) {
    return this.service.summary(me, id, q);
  }

  @Get('customers/:id/credit-overrides')
  listOverrides(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.listOverrides(me, id);
  }

  @Post('customers/:id/credit-overrides')
  @RequirePermissions('credit.override')
  @AnyEstablishmentScope()
  grant(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateOverrideDto) {
    return this.service.grantOverride(me, id, dto);
  }

  @Post('credit-overrides/:id/cancel')
  @RequirePermissions('credit.override')
  @AnyEstablishmentScope()
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOverrideDto) {
    return this.service.cancelOverride(me, id, dto);
  }
}
