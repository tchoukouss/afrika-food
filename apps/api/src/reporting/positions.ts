import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { AuthUser } from '../auth/decorators';

export const DASHBOARD = 'dashboard.view';
const MAX_DAYS = 366;
export const DAY = 86_400_000;

export class PeriodQuery {
  /** Premier jour inclus (AAAA-MM-JJ, Abidjan = UTC+0). */
  @Matches(/^\d{4}-\d{2}-\d{2}$/) from: string;
  /** Dernier jour inclus. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/) to: string;
  @IsOptional() @IsUUID() establishmentId?: string;
}

/** Période et établissements d'un indicateur : bornes [début, fin[ en UTC. */
export interface Scope {
  companyId: string;
  ids: string[];
  start: Date;
  end: Date;
  from: string;
  to: string;
}

/**
 * Socle commun du module 8 : période validée (1 an au plus, bornes incluses)
 * et établissements accessibles où toutes les permissions demandées sont détenues.
 */
export function periodScope(me: AuthUser, q: PeriodQuery, permissions: string[]): Scope {
  const start = new Date(`${q.from}T00:00:00.000Z`);
  const last = new Date(`${q.to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(last.getTime()) || start.toISOString().slice(0, 10) !== q.from || last.toISOString().slice(0, 10) !== q.to) {
    throw new BadRequestException('Dates invalides (AAAA-MM-JJ)');
  }
  if (last < start) throw new BadRequestException('La fin de période précède son début');
  if ((last.getTime() - start.getTime()) / DAY + 1 > MAX_DAYS) throw new BadRequestException(`Période limitée à ${MAX_DAYS} jours`);
  const allowed = me.access.establishmentsWith(permissions[0]).filter((id) => me.access.canAccessEstablishment(id) && permissions.every((p) => me.access.can(p, id)));
  const requested = q.establishmentId ?? me.establishmentId;
  if (requested && !allowed.includes(requested)) throw new ForbiddenException("Vous n'avez pas cette permission pour cet établissement");
  return { companyId: me.companyId, ids: requested ? [requested] : allowed, start, end: new Date(last.getTime() + DAY), from: q.from, to: q.to };
}

/**
 * Soldes des factures à l'instant t (exclu), même formule que le module 7
 * (invoiceBalances) appliquée aux écritures antérieures à t :
 * reste dû = total − part réglée en caisse − avoirs − répartitions actives + remboursements d'avoirs.
 * CTE « ib » : une ligne par facture émise avant t dans les établissements donnés.
 */
export function invoiceBalancesAt(companyId: string, ids: string[], t: Date) {
  return Prisma.sql`
  inv_scope AS (
    SELECT id FROM invoices
    WHERE company_id = ${companyId}::uuid AND establishment_id = ANY(${ids}::uuid[]) AND number IS NOT NULL AND issued_at < ${t}),
  ib AS (
    SELECT i.id, i.establishment_id, i.customer_id, i.source, i.number, i.issued_at, i.due_date, i.total, i.pos_paid_amount AS pos_paid,
           coalesce(cn.v, 0)::bigint AS credited, coalesce(al.v, 0)::bigint AS allocated, coalesce(rf.v, 0)::bigint AS cn_refunded,
           (i.total - i.pos_paid_amount - coalesce(cn.v, 0) - coalesce(al.v, 0) + coalesce(rf.v, 0))::bigint AS balance
    FROM invoices i
    JOIN inv_scope sc ON sc.id = i.id
    LEFT JOIN (SELECT invoice_id, sum(total) AS v FROM credit_notes WHERE invoice_id IN (SELECT id FROM inv_scope) AND created_at < ${t} GROUP BY 1) cn ON cn.invoice_id = i.id
    LEFT JOIN (SELECT invoice_id, sum(amount) AS v FROM payment_allocations
               WHERE invoice_id IN (SELECT id FROM inv_scope) AND target = 'INVOICE' AND created_at < ${t} AND (released_at IS NULL OR released_at >= ${t}) GROUP BY 1) al ON al.invoice_id = i.id
    LEFT JOIN (SELECT c.invoice_id, sum(r.amount) AS v FROM customer_refunds r JOIN credit_notes c ON c.id = r.credit_note_id
               WHERE c.invoice_id IN (SELECT id FROM inv_scope) AND r.created_at < ${t} GROUP BY 1) rf ON rf.invoice_id = i.id)`;
}

/**
 * Acomptes et paiements à l'instant t (exclu) :
 * - « dep » : acomptes reçus avant t et non annulés à t, avec part imputée sur
 *   factures, part remboursée, statut à t (crédit client si converti avant t) ;
 * - « pv » : paiements valides à t (heure du mouvement inverse s'il y en a un)
 *   et leur part encore répartie (acomptes et factures).
 */
export function advancesAt(companyId: string, ids: string[], t: Date) {
  return Prisma.sql`
  dep AS (
    SELECT d.id, d.establishment_id, d.customer_id, d.amount,
           (d.credited_at IS NOT NULL AND d.credited_at < ${t}) AS customer_credit,
           coalesce(ap.v, 0)::bigint AS applied, coalesce(rf.v, 0)::bigint AS refunded,
           (d.amount - coalesce(ap.v, 0) - coalesce(rf.v, 0))::bigint AS available
    FROM deposits d
    LEFT JOIN (SELECT deposit_id, sum(amount) AS v FROM payment_allocations
               WHERE target = 'INVOICE' AND deposit_id IS NOT NULL AND created_at < ${t} AND (released_at IS NULL OR released_at >= ${t}) GROUP BY 1) ap ON ap.deposit_id = d.id
    LEFT JOIN (SELECT deposit_id, sum(amount) AS v FROM customer_refunds WHERE deposit_id IS NOT NULL AND created_at < ${t} GROUP BY 1) rf ON rf.deposit_id = d.id
    WHERE d.company_id = ${companyId}::uuid AND d.establishment_id = ANY(${ids}::uuid[]) AND d.created_at < ${t}
      AND NOT (d.cancelled_at IS NOT NULL AND d.cancelled_at < ${t})),
  pv AS (
    SELECT p.id, p.establishment_id, p.customer_id, p.amount, coalesce(al.v, 0)::bigint AS allocated
    FROM customer_payments p
    LEFT JOIN cash_movements m ON m.id = p.reversal_movement_id
    LEFT JOIN (SELECT payment_id, sum(amount) AS v FROM payment_allocations
               WHERE created_at < ${t} AND (released_at IS NULL OR released_at >= ${t}) GROUP BY 1) al ON al.payment_id = p.id
    WHERE p.company_id = ${companyId}::uuid AND p.establishment_id = ANY(${ids}::uuid[]) AND p.created_at < ${t}
      AND NOT (p.status = 'CANCELLED' AND coalesce(m.created_at, p.cancelled_at) < ${t}))`;
}
