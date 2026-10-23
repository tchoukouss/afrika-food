import { Injectable, NotFoundException } from '@nestjs/common';
import { PrintJobStatus, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { columnsFor, escPos, money, NetworkPrinter } from '../sales/printer';
import { D } from '../stock/common';

const MODES: Record<string, string> = {
  TABLE: 'Sur place',
  COUNTER: 'Comptoir',
  TAKEAWAY: 'À emporter',
  PHONE: 'Téléphone',
  ONLINE: 'En ligne',
  DELIVERY: 'Livraison',
};

const time = (d: Date) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Abidjan' }).format(d);
const qtyText = (q: Prisma.Decimal) => (q.isInteger() ? q.toFixed(0) : q.toDecimalPlaces(3).toString().replace('.', ','));

/** Imprimante cible : poste de cuisine / bar, ou caisse pour une addition. */
interface Target {
  printerType: string;
  printerHost: string | null;
  printerPort: number;
  paperWidth: number;
}

/**
 * Bons de cuisine et additions provisoires. Même principe que les tickets du
 * module 5 (envoi direct à l'imprimante réseau avec délai, échec conservé et
 * relance, repli navigateur), avec la même mise en forme ESC/POS.
 */
@Injectable()
export class RestaurantPrinting {
  constructor(
    private readonly prisma: PrismaService,
    private readonly printer: NetworkPrinter,
  ) {}

  async kitchenLines(ticketId: string, width = 48): Promise<string[]> {
    const t = await this.prisma.restaurantKitchenTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { order: true } });
    const [items, station, table] = await Promise.all([
      this.prisma.restaurantOrderItem.findMany({ where: { kitchenTicketId: ticketId }, orderBy: { position: 'asc' } }),
      t.stationId ? this.prisma.restaurantStation.findUnique({ where: { id: t.stationId } }) : null,
      t.order.tableId ? this.prisma.restaurantTable.findUnique({ where: { id: t.order.tableId } }) : null,
    ]);
    const lines = [
      (station?.name ?? 'Service').toUpperCase(),
      `Bon ${t.number}`,
      `Commande ${t.order.number}`,
      table ? `TABLE ${table.code}` : MODES[t.order.mode],
      ...(t.order.customerName ? [`Client : ${t.order.customerName}`] : []),
      time(t.createdAt),
      ...(t.urgent || t.order.urgent ? ['*** URGENT ***'] : []),
      '-'.repeat(width),
    ];
    for (const i of items.filter((x) => !x.parentItemId)) {
      lines.push(`${qtyText(D(i.quantity))} x ${i.productName}`.slice(0, width));
      for (const o of i.options) lines.push(`   > ${o}`.slice(0, width));
      for (const s of items.filter((x) => x.parentItemId === i.id)) lines.push(`   + ${qtyText(D(s.quantity))} ${s.productName}`.slice(0, width));
      if (i.note) lines.push(`   NOTE : ${i.note}`.slice(0, width));
    }
    // Suppléments envoyés seuls (article principal déjà envoyé).
    for (const s of items.filter((x) => x.parentItemId && !items.some((p) => p.id === x.parentItemId))) {
      lines.push(`+ ${qtyText(D(s.quantity))} ${s.productName}`.slice(0, width));
    }
    if (t.order.note) lines.push('-'.repeat(width), `Note : ${t.order.note}`.slice(0, width));
    return lines;
  }

  /** `reprint` : rang de l'impression (0 = première). */
  async billLines(billId: string, width = 48, reprint = 0): Promise<string[]> {
    const b = await this.prisma.restaurantBill.findUniqueOrThrow({ where: { id: billId }, include: { items: true, order: true } });
    const [company, est, items, table] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: b.companyId } }),
      this.prisma.establishment.findUniqueOrThrow({ where: { id: b.establishmentId } }),
      this.prisma.restaurantOrderItem.findMany({ where: { id: { in: b.items.map((i) => i.itemId) } } }),
      b.order.tableId ? this.prisma.restaurantTable.findUnique({ where: { id: b.order.tableId } }) : null,
    ]);
    const lr = (l: string, r: string) => (l.length + r.length + 1 > width ? [l.slice(0, width), r.padStart(width)] : [l + ' '.repeat(width - l.length - r.length) + r]);
    const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((width - s.length) / 2))) + s.slice(0, width);
    const lines = [center(company.name.toUpperCase()), center(est.name), '='.repeat(width), center('ADDITION'), center('Ceci n’est pas un ticket de caisse')];
    if (reprint > 0) lines.push(center(`Réimpression n° ${reprint}`));
    lines.push(`Addition ${b.number}`, `Commande ${b.order.number}`, table ? `Table ${table.code}${b.order.covers ? ` — ${b.order.covers} couvert(s)` : ''}` : MODES[b.order.mode], time(new Date()), '-'.repeat(width));
    let tax = 0n;
    for (const bi of b.items) {
      const it = items.find((i) => i.id === bi.itemId)!;
      lines.push(`${it.parentItemId ? '  + ' : ''}${it.productName}`.slice(0, width));
      lines.push(...lr(`  ${qtyText(D(bi.quantity))} x ${money(bi.unitPrice)}`, money(bi.amount)));
      if (D(it.taxRate).gt(0)) tax += BigInt(D(bi.amount.toString()).mul(it.taxRate).div(D(100).add(it.taxRate)).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
    }
    lines.push('-'.repeat(width), ...lr('TOTAL TTC', money(b.total)));
    if (tax > 0n) lines.push(...lr('  dont TVA', money(tax)));
    lines.push('='.repeat(width), center('Le ticket est remis au paiement'));
    return lines;
  }

  /** Crée un travail d'impression : réseau → en attente ; navigateur → rendu par le poste ; sinon rien. */
  async createJob(
    tx: Tx,
    me: AuthUser,
    data: { establishmentId: string; kind: 'KITCHEN' | 'BILL'; kitchenTicketId?: string; billId?: string; stationId?: string | null; registerId?: string | null },
    target: Target | null,
    forced = false,
  ) {
    if (!target || (!forced && target.printerType === 'NONE')) return null;
    const network = target.printerType === 'NETWORK' && !!target.printerHost;
    return tx.restaurantPrintJob.create({
      data: {
        companyId: me.companyId,
        establishmentId: data.establishmentId,
        kind: data.kind,
        kitchenTicketId: data.kitchenTicketId ?? null,
        billId: data.billId ?? null,
        stationId: data.stationId ?? null,
        registerId: data.registerId ?? null,
        status: network ? 'PENDING' : 'BROWSER',
        requestedById: me.userId,
      },
    });
  }

  private async targetOf(job: { stationId: string | null; registerId: string | null }): Promise<Target | null> {
    if (job.stationId) return this.prisma.restaurantStation.findUnique({ where: { id: job.stationId } });
    if (job.registerId) return this.prisma.cashRegister.findUnique({ where: { id: job.registerId } });
    return null;
  }

  async lines(job: { kind: string; kitchenTicketId: string | null; billId: string | null; stationId: string | null; registerId: string | null; createdAt: Date }) {
    const width = columnsFor((await this.targetOf(job))?.paperWidth ?? 80);
    if (job.kind === 'KITCHEN') return { width, lines: await this.kitchenLines(job.kitchenTicketId!, width) };
    const rank = (await this.prisma.restaurantPrintJob.count({ where: { billId: job.billId, createdAt: { lte: job.createdAt } } })) - 1;
    return { width, lines: await this.billLines(job.billId!, width, rank) };
  }

  /** Envoie un travail en attente ; une imprimante éteinte ne bloque jamais la commande. */
  async deliver(jobId: string) {
    const job = await this.prisma.restaurantPrintJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== 'PENDING' && job.status !== 'FAILED') return job;
    const target = await this.targetOf(job);
    const fail = (lastError: string) =>
      this.prisma.restaurantPrintJob.update({ where: { id: jobId }, data: { status: 'FAILED' as PrintJobStatus, attempts: { increment: 1 }, lastError } });
    if (!target || target.printerType !== 'NETWORK' || !target.printerHost) return fail('Aucune imprimante réseau configurée');
    try {
      const { lines } = await this.lines(job);
      await this.printer.send(target.printerHost, target.printerPort, escPos(lines));
      return this.prisma.restaurantPrintJob.update({ where: { id: jobId }, data: { status: 'PRINTED', attempts: { increment: 1 }, lastError: null, printedAt: new Date() } });
    } catch (e) {
      return fail((e as Error).message.slice(0, 300));
    }
  }

  async find(me: AuthUser, jobId: string) {
    const job = await this.prisma.restaurantPrintJob.findFirst({ where: { id: jobId, companyId: me.companyId } });
    if (!job) throw new NotFoundException('Impression introuvable');
    return job;
  }
}
