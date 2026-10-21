import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Db, Tx } from '../prisma/prisma.service';
import { D, ItemInfo } from '../stock/common';

export type UnitMap = Map<string, { dimension: string; factor: Prisma.Decimal; symbol: string }>;

export async function loadUnits(db: Db): Promise<UnitMap> {
  const units = await db.unit.findMany();
  return new Map(units.map((u) => [u.code, { dimension: u.dimension, factor: D(u.factorToBase), symbol: u.symbol }]));
}

/**
 * Convertit une quantité d'une unité vers une autre de même dimension
 * (ex. 250 g → 0,25 kg). Refuse un mélange masse / volume / unité.
 */
export function convert(units: UnitMap, quantity: Prisma.Decimal, from: string, to: string, label = 'cet ingrédient'): Prisma.Decimal {
  if (from === to) return quantity;
  const a = units.get(from);
  const b = units.get(to);
  if (!a || !b) throw new BadRequestException(`Unité inconnue pour ${label}`);
  if (a.dimension !== b.dimension) {
    throw new BadRequestException(`Unité incompatible pour ${label} : ${a.symbol} ne se convertit pas en ${b.symbol}`);
  }
  return quantity.mul(a.factor).div(b.factor);
}

/** Unité de stock d'un article (unité de base de la matière, unité de vente du produit). */
export const stockUnit = (info: ItemInfo) => info.unit;

/**
 * Quantité à sortir du stock pour un ingrédient : quantité de la recette,
 * majorée de la perte prévue, rapportée à la quantité à produire, convertie
 * dans l'unité de stock.
 */
export function requiredQuantity(
  units: UnitMap,
  line: { quantity: Prisma.Decimal.Value; unitCode: string; lossPercent: Prisma.Decimal.Value },
  scale: Prisma.Decimal,
  info: ItemInfo,
): Prisma.Decimal {
  const withLoss = D(line.quantity).mul(D(1).add(D(line.lossPercent).div(100)));
  return convert(units, withLoss.mul(scale), line.unitCode, stockUnit(info), `« ${info.name} »`).toDecimalPlaces(4, Prisma.Decimal.ROUND_UP);
}

/**
 * Numéro d'ordre de production, ex. « PLT-PRD-2026-000004 ». Même table de
 * compteurs et même garantie que les autres documents (incrément atomique
 * dans la transaction : ni doublon ni trou).
 */
export async function nextProductionNumber(tx: Tx, companyId: string, establishment: { id: string; code: string }) {
  const year = new Date().getUTCFullYear();
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO document_sequences (company_id, scope_key, doc_type, year, last_value, updated_at)
    VALUES (${companyId}::uuid, ${establishment.id}, 'PRODUCTION', ${year}, 1, now())
    ON CONFLICT (company_id, scope_key, doc_type, year)
    DO UPDATE SET last_value = document_sequences.last_value + 1, updated_at = now()
    RETURNING last_value`;
  return `${establishment.code}-PRD-${year}-${String(rows[0].last_value).padStart(6, '0')}`;
}

/** Prix HT à partir du prix TTC et du taux de TVA (décision I). */
export function priceExclTax(priceTtc: bigint | null, taxRate: Prisma.Decimal.Value): Prisma.Decimal | null {
  if (priceTtc === null) return null;
  return D(priceTtc.toString()).div(D(1).add(D(taxRate).div(100))).toDecimalPlaces(2);
}
