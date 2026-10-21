import { Injectable } from '@nestjs/common';
import { Socket } from 'node:net';
import { Prisma } from '@prisma/client';
import { D } from '../stock/common';
import { METHOD_LABELS } from './common';

/** Contenu d'un ticket, indépendant du support (imprimante thermique ou navigateur). */
export interface TicketData {
  company: { name: string; legalName: string | null; taxId: string | null };
  establishment: { name: string; address: string | null; city: string | null; phone: string | null; receiptHeader: string | null; receiptFooter: string | null };
  register: { name: string } | null;
  number: string;
  createdAt: Date;
  cashier: string | null;
  status: string;
  items: {
    productName: string;
    quantity: Prisma.Decimal;
    unitPrice: bigint;
    grossAmount: bigint;
    lineDiscount: bigint;
    lineTotal: bigint;
    taxRate: Prisma.Decimal;
    taxAmount: bigint;
  }[];
  grossTotal: bigint;
  lineDiscountTotal: bigint;
  ticketDiscountAmount: bigint;
  total: bigint;
  taxTotal: bigint;
  payments: { method: keyof typeof METHOD_LABELS; amount: bigint; reference: string | null }[];
  changeGiven: bigint;
  refundedTotal: bigint;
}

export const money = (v: bigint | number) => `${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F`;
const qtyText = (q: Prisma.Decimal) => (q.isInteger() ? q.toFixed(0) : q.toDecimalPlaces(3).toString().replace('.', ','));
const dateText = (d: Date) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Abidjan' }).format(d);

/** Nombre de caractères par ligne selon la largeur du papier. */
export const columnsFor = (paperWidth: number) => (paperWidth === 58 ? 32 : 48);

/**
 * Met en page un ticket en lignes de texte de largeur fixe. Prix TTC ; détail
 * HT / TVA par taux quand des produits sont soumis à la TVA (décision 18).
 */
export function renderTicket(t: TicketData, opts: { width: number; duplicate?: boolean; test?: boolean }): string[] {
  const W = opts.width;
  const lines: string[] = [];
  const center = (s: string) => {
    for (let i = 0; i < s.length; i += W) {
      const part = s.slice(i, i + W);
      lines.push(' '.repeat(Math.floor((W - part.length) / 2)) + part);
    }
  };
  const lr = (left: string, right: string) => {
    const room = W - right.length - 1;
    if (left.length > room) {
      lines.push(left.slice(0, W));
      lines.push(right.padStart(W));
    } else lines.push(left + ' '.repeat(W - left.length - right.length) + right);
  };
  const rule = (c = '-') => lines.push(c.repeat(W));

  center(t.company.name.toUpperCase());
  if (t.company.legalName && t.company.legalName !== t.company.name) center(t.company.legalName);
  center(t.establishment.name);
  const address = [t.establishment.address, t.establishment.city].filter(Boolean).join(', ');
  if (address) center(address);
  if (t.establishment.phone) center(`Tél. ${t.establishment.phone}`);
  if (t.company.taxId) center(`N° CC ${t.company.taxId}`);
  if (t.establishment.receiptHeader) t.establishment.receiptHeader.split('\n').forEach((l) => center(l.trim()));
  rule('=');
  if (opts.test) {
    center('TEST D’IMPRESSION');
    center(dateText(new Date()));
    rule('=');
    return lines;
  }
  if (opts.duplicate) center('*** DUPLICATA ***');
  if (t.status === 'CANCELLED') center('*** VENTE ANNULÉE ***');
  lr(`Ticket ${t.number}`, '');
  lr(dateText(t.createdAt), t.register?.name ?? '');
  if (t.cashier) lines.push(`Caissier : ${t.cashier}`.slice(0, W));
  rule();
  for (const i of t.items) {
    lines.push(i.productName.slice(0, W));
    lr(`  ${qtyText(i.quantity)} x ${money(i.unitPrice)}`, money(i.grossAmount));
    if (i.lineDiscount > 0n) lr('  Remise', `-${money(i.lineDiscount)}`);
  }
  rule();
  if (t.lineDiscountTotal > 0n || t.ticketDiscountAmount > 0n) {
    lr('Sous-total', money(t.grossTotal));
    if (t.lineDiscountTotal > 0n) lr('Remises lignes', `-${money(t.lineDiscountTotal)}`);
    if (t.ticketDiscountAmount > 0n) lr('Remise ticket', `-${money(t.ticketDiscountAmount)}`);
  }
  lr('TOTAL TTC', money(t.total));
  if (t.taxTotal > 0n) {
    const byRate = new Map<string, { base: bigint; tax: bigint }>();
    for (const i of t.items) {
      const key = D(i.taxRate).toString();
      const cur = byRate.get(key) ?? { base: 0n, tax: 0n };
      byRate.set(key, { base: cur.base + i.lineTotal - i.taxAmount, tax: cur.tax + i.taxAmount });
    }
    for (const [rate, v] of byRate) {
      if (v.tax === 0n) continue;
      lr(`  HT (TVA ${rate.replace('.', ',')} %)`, money(v.base));
      lr(`  TVA ${rate.replace('.', ',')} %`, money(v.tax));
    }
  }
  rule();
  for (const p of t.payments) {
    lr(METHOD_LABELS[p.method], money(p.amount));
    if (p.reference) lines.push(`  Réf. ${p.reference}`.slice(0, W));
  }
  if (t.changeGiven > 0n) lr('Monnaie rendue', money(t.changeGiven));
  if (t.refundedTotal > 0n) lr('Remboursé', `-${money(t.refundedTotal)}`);
  rule('=');
  center(t.establishment.receiptFooter?.trim() || 'Merci de votre visite !');
  return lines;
}

/** Texte → octets ESC/POS (accents retirés : jeu de caractères de base de toutes les imprimantes). */
export function escPos(lines: string[]): Buffer {
  const text = lines
    .join('\n')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[^\x0a\x20-\x7e]/g, '?');
  const INIT = Buffer.from([0x1b, 0x40]);
  const FEED_CUT = Buffer.from([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00]);
  return Buffer.concat([INIT, Buffer.from(text + '\n', 'ascii'), FEED_CUT]);
}

/**
 * Imprimante thermique réseau (port RAW 9100). Envoi direct en TCP avec délai
 * maximal : une imprimante éteinte ne bloque jamais la caisse, le ticket reste
 * en échec et peut être relancé.
 */
@Injectable()
export class NetworkPrinter {
  timeoutMs = 4000;

  send(host: string, port: number, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };
      socket.setTimeout(this.timeoutMs, () => finish(new Error('Imprimante injoignable (délai dépassé)')));
      socket.once('error', (e) => finish(new Error(`Imprimante injoignable (${(e as NodeJS.ErrnoException).code ?? e.message})`)));
      socket.connect(port, host, () => socket.end(data, () => finish()));
    });
  }
}
