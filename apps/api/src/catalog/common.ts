import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../auth/decorators';
import { Tx } from '../prisma/prisma.service';

export const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
export const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
/** Chaîne vide → null (pour pouvoir effacer un champ facultatif). */
export const emptyToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
};

/** Code article / fournisseur : majuscules, chiffres, tiret, souligné. */
export const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
export const CODE_MESSAGE = 'Code : 1 à 30 caractères (lettres majuscules, chiffres, - ou _), ex. FAR-T55';

/** Montant maximal accepté (1 000 milliards FCFA). */
export const MAX_AMOUNT = 1_000_000_000_000;
export const MAX_QUANTITY = 1_000_000_000;

export const toDecimal = (n: number) => new Prisma.Decimal(n);

/** Prix par unité de base (ex. FCFA/kg) à partir d'un prix par conditionnement. */
export function pricePerBaseUnit(unitPrice: bigint | null, quantity: Prisma.Decimal): number | null {
  if (unitPrice === null || quantity.lte(0)) return null;
  return new Prisma.Decimal(unitPrice.toString()).div(quantity).toDecimalPlaces(2).toNumber();
}

/** Tables verrouillables par SELECT … FOR UPDATE (liste fermée, pas d'injection possible). */
type LockableTable = 'raw_materials' | 'suppliers' | 'supplier_products' | 'products' | 'product_categories' | 'raw_material_categories' | 'raw_material_packagings';

export async function lockRow(tx: Tx, table: LockableTable, id: string) {
  await tx.$queryRaw`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}::uuid FOR UPDATE`;
}

/**
 * Vérifie qu'un établissement appartient à l'entreprise, est accessible à
 * l'utilisateur, et que celui-ci y détient la permission demandée.
 */
export async function assertEstablishmentPermission(tx: Tx, me: AuthUser, establishmentId: string, permission: string) {
  const est = await tx.establishment.findFirst({ where: { id: establishmentId, companyId: me.companyId, deletedAt: null } });
  if (!est) throw new BadRequestException('Établissement invalide');
  if (!me.access.canAccessEstablishment(establishmentId) || !me.access.can(permission, establishmentId)) {
    throw new ForbiddenException("Vous n'avez pas cette permission pour cet établissement");
  }
  return est;
}

/** Email : chaîne vide → null, sinon minuscules. */
export const lowerOrNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim().toLowerCase();
  return t === '' ? null : t;
};
