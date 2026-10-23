import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, TableState } from '@prisma/client';
import { AuthUser } from '../auth/decorators';
import { modulesFor } from '../establishments/establishments';
import { Db, Tx } from '../prisma/prisma.service';

export { emptyToNull, QTY, roundXof, trim } from '../sales/common';

/** Adresse IPv4 d'un réseau local (imprimante de la cuisine) : jamais une adresse Internet. */
export const PRIVATE_IPV4 = /^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|127(\.\d{1,3}){3})$/;

/** Vrai si l'utilisateur détient au moins une des permissions dans l'établissement. */
export const canAny = (me: AuthUser, establishmentId: string, permissions: string[]) =>
  me.access.canAccessEstablishment(establishmentId) && permissions.some((p) => me.access.can(p, establishmentId));

export function assertAny(me: AuthUser, establishmentId: string, ...permissions: string[]) {
  if (!canAny(me, establishmentId, permissions)) throw new ForbiddenException("Vous n'avez pas cette permission pour cet établissement");
}

/**
 * Établissement de l'entreprise dont le type comprend un restaurant (décision R1),
 * où l'utilisateur détient au moins une des permissions demandées.
 */
export async function restaurantEstablishment(db: Db, me: AuthUser, establishmentId: string, ...permissions: string[]) {
  const est = await db.establishment.findFirst({ where: { id: establishmentId, companyId: me.companyId, deletedAt: null } });
  if (!est) throw new NotFoundException('Établissement introuvable');
  if (!modulesFor(est.type).restaurant) throw new BadRequestException(`Le module restaurant n’est pas activé pour « ${est.name} »`);
  if (permissions.length) assertAny(me, est.id, ...permissions);
  return est;
}

/** Établissements consultables : celui de l'en-tête, sinon tous ceux où l'une des permissions est détenue. */
export function readableWith(me: AuthUser, permissions: string[], requested?: string) {
  const ids = new Set<string>();
  for (const p of permissions) me.access.establishmentsWith(p).forEach((id) => ids.add(id));
  const scope = requested ?? me.establishmentId;
  if (scope) return ids.has(scope) ? [scope] : [];
  return [...ids];
}

/** Préfixes des documents du module 6 (même table de compteurs que les modules précédents). */
const DOC6 = { KITCHEN_TICKET: 'BON', BILL: 'ADD' } as const;

/** Numéro de bon de cuisine ou d'addition, ex. « PLT-BON-2026-000012 ». Incrément atomique dans la transaction. */
export async function nextRestaurantNumber(tx: Tx, companyId: string, docType: keyof typeof DOC6, establishment: { id: string; code: string }) {
  const year = new Date().getUTCFullYear();
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO document_sequences (company_id, scope_key, doc_type, year, last_value, updated_at)
    VALUES (${companyId}::uuid, ${establishment.id}, ${docType}, ${year}, 1, now())
    ON CONFLICT (company_id, scope_key, doc_type, year)
    DO UPDATE SET last_value = document_sequences.last_value + 1, updated_at = now()
    RETURNING last_value`;
  return `${establishment.code}-${DOC6[docType]}-${year}-${String(rows[0].last_value).padStart(6, '0')}`;
}

/** Verrouille des commandes dans l'ordre des identifiants (deux commandes à la fois : pas d'interblocage). */
export async function lockOrders(tx: Tx, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  await tx.$queryRaw`SELECT id FROM restaurant_orders WHERE id IN (${Prisma.join(sorted.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
}

/** Prix TTC en vigueur dans l'établissement : exception locale, sinon prix de base. */
export async function currentPrices(db: Db, productIds: string[], establishmentId: string) {
  const rows = await db.productPrice.findMany({ where: { productId: { in: productIds }, validTo: null, OR: [{ establishmentId: null }, { establishmentId }] } });
  const map = new Map<string, bigint>();
  for (const id of productIds) {
    const local = rows.find((r) => r.productId === id && r.establishmentId === establishmentId);
    const base = rows.find((r) => r.productId === id && r.establishmentId === null);
    const price = local?.price ?? base?.price;
    if (price !== undefined) map.set(id, price);
  }
  return map;
}

/** Statut affiché d'une table (décision R8) : six statuts plus « hors service ». */
export type TableStatus = 'FREE' | 'RESERVED' | 'WAITING_ORDER' | 'OCCUPIED' | 'WAITING_BILL' | 'CLEANING' | 'OUT_OF_SERVICE';

/** Une réservation confirmée rend la table « réservée » de 60 min avant à 30 min après l'heure prévue. */
export const RESERVATION_BEFORE_MS = 60 * 60_000;
export const RESERVATION_AFTER_MS = 30 * 60_000;

export function tableStatus(
  state: TableState,
  order: { sentCount: number; openBills: number } | null,
  reservedSoon: boolean,
): TableStatus {
  if (state === 'OUT_OF_SERVICE') return 'OUT_OF_SERVICE';
  if (order) return order.openBills > 0 ? 'WAITING_BILL' : order.sentCount > 0 ? 'OCCUPIED' : 'WAITING_ORDER';
  if (state === 'CLEANING') return 'CLEANING';
  return reservedSoon ? 'RESERVED' : 'FREE';
}

/** Statuts d'un article après envoi, dans l'ordre du circuit cuisine. */
export const SENT_STATUSES = ['NEW', 'IN_PREPARATION', 'READY', 'SERVED'] as const;
