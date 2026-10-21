import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/decorators';
import { Db, Tx } from '../prisma/prisma.service';
import { D } from '../stock/common';

export const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value;
export const QTY = { maxDecimalPlaces: 4 };

/** Arrondi d'un montant au franc (FCFA, sans centimes). */
export const roundXof = (v: Prisma.Decimal): bigint => BigInt(v.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
export const big = (v: Prisma.Decimal.Value | bigint) => D(typeof v === 'bigint' ? v.toString() : v);

/** Préfixes des documents du module 5 (même table de compteurs que les modules 1 à 4). */
const DOC5 = { CASH_SESSION: 'SES', SALE_RETURN: 'RMB' } as const;

/**
 * Numéro de session de caisse ou de retour, ex. « PLT-SES-2026-000003 ».
 * Incrément atomique dans la transaction (même mécanisme que les autres documents).
 */
export async function nextSalesNumber(tx: Tx, companyId: string, docType: keyof typeof DOC5, establishment: { id: string; code: string }) {
  const year = new Date().getUTCFullYear();
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO document_sequences (company_id, scope_key, doc_type, year, last_value, updated_at)
    VALUES (${companyId}::uuid, ${establishment.id}, ${docType}, ${year}, 1, now())
    ON CONFLICT (company_id, scope_key, doc_type, year)
    DO UPDATE SET last_value = document_sequences.last_value + 1, updated_at = now()
    RETURNING last_value`;
  return `${establishment.code}-${DOC5[docType]}-${year}-${String(rows[0].last_value).padStart(6, '0')}`;
}

// --- Moyens de paiement ----------------------------------------------------------

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Espèces',
  ORANGE_MONEY: 'Orange Money',
  MTN_MONEY: 'MTN MoMo',
  MOOV_MONEY: 'Moov Money',
  WAVE: 'Wave',
  CARD: 'Carte bancaire',
  BANK_TRANSFER: 'Virement',
  CHEQUE: 'Chèque',
  OTHER: 'Autre',
};

/**
 * Prestataire d'un moyen de paiement (décision 10). En module 5, tous les
 * paiements électroniques sont confirmés manuellement par le caissier, qui
 * saisit la référence de la transaction. Une intégration API (Orange Money,
 * Wave…) remplacera plus tard le prestataire « MANUAL » d'un moyen sans
 * changer la vente.
 */
export interface PaymentProvider {
  code: string;
  /** Vérifie / confirme le paiement et retourne la référence retenue. */
  confirm(input: { method: PaymentMethod; amount: bigint; reference: string | null }): string | null;
}

const MANUAL: PaymentProvider = {
  code: 'MANUAL',
  confirm({ method, reference }) {
    if (REFERENCE_REQUIRED.has(method) && !reference) {
      throw new BadRequestException(`Référence de la transaction obligatoire pour ${METHOD_LABELS[method]}`);
    }
    return reference;
  },
};
const CASH: PaymentProvider = { code: 'CASH', confirm: () => null };

const REFERENCE_REQUIRED = new Set<PaymentMethod>(['ORANGE_MONEY', 'MTN_MONEY', 'MOOV_MONEY', 'WAVE', 'BANK_TRANSFER', 'CHEQUE']);

export function providerFor(method: PaymentMethod): PaymentProvider {
  return method === 'CASH' ? CASH : MANUAL;
}

// --- Contrôles d'accès -----------------------------------------------------------

/** Lève une erreur si l'utilisateur n'a pas la permission dans l'établissement. */
export function assertCan(me: AuthUser, establishmentId: string, ...permissions: string[]) {
  if (!me.access.canAccessEstablishment(establishmentId) || permissions.some((p) => !me.access.can(p, establishmentId))) {
    throw new ForbiddenException("Vous n'avez pas cette permission pour cet établissement");
  }
}

/** Établissements où l'utilisateur détient une des permissions (filtrés par l'en-tête s'il est fourni). */
export function establishmentsWithAny(me: AuthUser, permissions: string[], requested?: string) {
  const ids = new Set<string>();
  for (const p of permissions) me.access.establishmentsWith(p).forEach((id) => ids.add(id));
  const scope = requested ?? me.establishmentId;
  if (scope) return ids.has(scope) ? [scope] : [];
  return [...ids];
}

export async function loadEstablishment(db: Db, me: AuthUser, id: string) {
  const est = await db.establishment.findFirst({ where: { id, companyId: me.companyId, deletedAt: null } });
  if (!est) throw new NotFoundException('Établissement introuvable');
  return est;
}

/** Verrouille une ligne d'une table du module 5. */
export async function lockSalesRow(tx: Tx, table: 'cash_sessions' | 'sales' | 'cash_registers' | 'print_jobs', id: string) {
  await tx.$queryRaw`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}::uuid FOR UPDATE`;
}

/** Message lisible pour une violation d'index unique, sinon l'erreur d'origine. */
export function uniqueViolation(e: unknown, target: string): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === 'P2002') return JSON.stringify(e.meta ?? {}).includes(target);
  // Index partiel : Prisma remonte une erreur brute (P2010 / message PostgreSQL).
  return String(e.message).includes(target);
}
