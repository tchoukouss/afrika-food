import { Injectable } from '@nestjs/common';
import { Db, PrismaService } from '../prisma/prisma.service';

/** Types de documents numérotés et leur préfixe. */
export const DOC_PREFIX = {
  SALE: 'VTE',
  TICKET: 'TKT',
  INVOICE: 'FAC',
  CREDIT_NOTE: 'AVR',
  QUOTE: 'DEV',
  CUSTOMER_ORDER: 'CMD',
  DELIVERY_NOTE: 'BL',
  PURCHASE_ORDER: 'BCF',
  GOODS_RECEIPT: 'REC',
  PRODUCTION: 'PRD',
  TRANSFER: 'TRF',
  PAYMENT: 'PAY',
  DEPOSIT: 'ACP',
  INVENTORY: 'INV',
  RESTAURANT_ORDER: 'RST',
  EXPENSE: 'DEP',
  LOT: 'LOT',
} as const;

export type DocType = keyof typeof DOC_PREFIX;

@Injectable()
export class SequenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne le prochain numéro, ex. « PLT-VTE-2026-000042 ».
   *
   * L'incrément est atomique (INSERT … ON CONFLICT DO UPDATE … RETURNING) :
   * deux caisses simultanées ne peuvent pas obtenir le même numéro.
   * Appelé dans la transaction du document, le verrou de ligne est tenu
   * jusqu'au commit ; en cas d'annulation de la transaction, le numéro
   * n'est pas consommé, ce qui évite les trous dans la numérotation.
   */
  async next(
    db: Db,
    params: { companyId: string; docType: DocType; establishmentCode?: string; establishmentId?: string; date?: Date },
  ): Promise<string> {
    const year = (params.date ?? new Date()).getUTCFullYear();
    const scopeKey = params.establishmentId ?? 'GLOBAL';
    const rows = await db.$queryRaw<{ last_value: number }[]>`
      INSERT INTO document_sequences (company_id, scope_key, doc_type, year, last_value, updated_at)
      VALUES (${params.companyId}::uuid, ${scopeKey}, ${params.docType}, ${year}, 1, now())
      ON CONFLICT (company_id, scope_key, doc_type, year)
      DO UPDATE SET last_value = document_sequences.last_value + 1, updated_at = now()
      RETURNING last_value`;
    const value = rows[0].last_value;
    const parts = [params.establishmentCode, DOC_PREFIX[params.docType], String(year), String(value).padStart(6, '0')];
    return parts.filter(Boolean).join('-');
  }
}
