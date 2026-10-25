import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const num = (v: unknown) => Number(v);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Module 8 — créances des ventes à crédit (tickets M5 facturés par M7).
 *
 * Pâtisserie Plateau (PLT) :
 *   T0 aujourd'hui : 1 000 payés en espèces, puis facturé (facture de ticket soldée) → aucune créance
 *   T1 aujourd'hui : 1 000 = 400 encaissés + 600 à crédit (client A, 30 jours) → créance 600, non échue
 *   T2 hier        : 1 000 entièrement à crédit (client B), échéance dépassée de 40 jours → créance 1 000 (31–60 jours)
 * Restaurant Yopougon (YOP) : 500 à crédit (client A).
 */
describe('Module 8 — Créances des ventes à crédit', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User;
  let cashier: User;
  let managerYop: User;
  let plt: string;
  let yop: string;
  const ids: Record<string, string> = {};
  const today = day(0);

  const as = (u: Session, est = plt) => api(app, u, est);
  const get = async (path: string, u: Session, query: Record<string, string>, est?: string): Promise<Body> => (await api(app, u, est).get(`/api/pilotage/${path}`).query(query).expect(200)).body;
  const period = (from = today, to = today) => ({ from, to });
  const sell = async (u: Session, session: string, quantity: number, payments: object[], credit?: object, est = plt) =>
    (await as(u, est).post('/api/sales').send({ sessionId: session, lines: [{ productId: ids.coca, quantity }], payments, credit }).expect(201)).body.sale;
  const balanceOf = async (saleId: string) => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { saleId } });
    return (await as(manager).get(`/api/invoices/${inv.id}`).expect(200)).body;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plt = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yop = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', plt);
    cashier = await user('caisse@test.ci', 'CASHIER', plt);
    managerYop = await user('respyop@test.ci', 'MANAGER', yop);
    const store = await user('mag@test.ci', 'STOREKEEPER', plt);
    const storeYop = await user('magyop@test.ci', 'STOREKEEPER', yop);

    ids.coca = (await api(app, admin).post('/api/products').send({ code: 'COCA', name: 'Coca 33 cl', type: 'RESOLD', basePrice: 500 }).expect(201)).body.id;
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    for (const [u, est] of [[store, plt], [storeYop, yop]] as const) {
      await as(u, est)
        .post('/api/goods-receipts')
        .send({ establishmentId: est, supplierId: supplier, items: [{ productId: ids.coca, purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, receivedQuantity: 50, unitPrice: 300, expiryDate: day(90) }] })
        .expect(201);
    }
    const reg = async (u: Session, est: string, code: string) => (await as(u, est).post('/api/cash-registers').send({ establishmentId: est, code, name: `Caisse ${code}`, printerType: 'NONE' }).expect(201)).body.id;
    const [c1, y1] = [await reg(manager, plt, 'C1'), await reg(managerYop, yop, 'Y1')];
    ids.sess = (await as(cashier).post('/api/cash-sessions').send({ registerId: c1, openingFloat: 0 }).expect(201)).body.id;
    ids.sessYop = (await as(managerYop, yop).post('/api/cash-sessions').send({ registerId: y1, openingFloat: 0 }).expect(201)).body.id;
    ids.a = (await as(manager).post('/api/customers').send({ type: 'BUSINESS', name: 'Société Ivoire Events', creditLimit: 100000, paymentTermDays: 30 }).expect(201)).body.id;
    ids.b = (await as(manager).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Awa Koné', creditLimit: 100000 }).expect(201)).body.id;

    // T2 : entièrement à crédit, ramené à hier (ticket et facture), échéance dépassée de 40 jours.
    const t2 = await sell(cashier, ids.sess, 2, [], { customerId: ids.b, amount: 1000 });
    const t2inv = await prisma.invoice.findFirstOrThrow({ where: { saleId: t2.id } });
    const yesterday = new Date(`${day(-1)}T10:00:00.000Z`);
    await prisma.$executeRawUnsafe('ALTER TABLE sales DISABLE TRIGGER USER');
    await prisma.$executeRawUnsafe('ALTER TABLE invoices DISABLE TRIGGER invoices_guard');
    try {
      await prisma.$executeRaw`UPDATE sales SET created_at = ${yesterday} WHERE id = ${t2.id}::uuid`;
      await prisma.$executeRaw`UPDATE invoices SET issued_at = ${yesterday}, due_date = ${day(-40)}::date WHERE id = ${t2inv.id}::uuid`;
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE sales ENABLE TRIGGER USER');
      await prisma.$executeRawUnsafe('ALTER TABLE invoices ENABLE TRIGGER invoices_guard');
    }
    // T0 : payé en caisse puis facturé ; T1 : 400 encaissés + 600 à crédit.
    const t0 = await sell(cashier, ids.sess, 2, [{ method: 'CASH', amount: 1000 }]);
    const d = (await as(manager).post('/api/invoices').send({ establishmentId: plt, source: 'SALE', saleId: t0.id, customerId: ids.a }).expect(201)).body;
    await as(manager).post(`/api/invoices/${d.id}/issue`).expect(201);
    const t1 = await sell(cashier, ids.sess, 2, [{ method: 'CASH', amount: 400 }], { customerId: ids.a, amount: 600 });
    await sell(managerYop, ids.sessYop, 1, [], { customerId: ids.a, amount: 500 }, yop);
    Object.assign(ids, { t0: t0.id, t1: t1.id, t2: t2.id });
  });

  afterAll(async () => {
    await app.close();
  });

  it('compte le CA du ticket une seule fois, l’encaissé seulement, et la part à crédit en créance (1 000 / 400 / 600)', async () => {
    const r = (await get('revenue', manager, period())).total;
    // T0 + T1 ; les factures de tickets ne s'ajoutent jamais au CA.
    expect([num(r.tickets.gross), num(r.tickets.onCredit), num(r.invoices.amount), r.invoices.count, num(r.revenue)]).toEqual([2000, 600, 0, 0, 2000]);
    const c = (await get('collections', manager, period())).total;
    expect([num(c.tickets), num(c.total)]).toEqual([1400, 1400]);
    const b = (await get('reconciliation', manager, period())).total;
    expect([num(b.revenue), num(b.collections), num(b.gap)]).toEqual([2000, 1400, 600]);
    const e = b.explanation;
    expect([num(e.ticketsTiming), num(e.ticketsOnCredit), num(e.receivablesChange), num(e.residual)]).toEqual([0, 600, 600, 0]);
    expect([num(b.receivables.opening), num(b.receivables.closing)]).toEqual([1000, 1600]);
    // Hier : T2 entièrement à crédit.
    const y = (await get('reconciliation', manager, period(day(-1), day(-1)))).total;
    expect([num(y.revenue), num(y.collections), num(y.explanation.ticketsOnCredit), num(y.explanation.receivablesChange), num(y.explanation.residual)]).toEqual([1000, 0, 1000, 1000, 0]);
  });

  it('met en créance la part à crédit restant due, jamais un ticket payé, avec échéance et ancienneté', async () => {
    expect([num((await balanceOf(ids.t0)).balance), num((await balanceOf(ids.t1)).balance), num((await balanceOf(ids.t2)).balance)]).toEqual([0, 600, 1000]);
    const t = (await get('receivables', manager, period())).total;
    expect([t.open.count, num(t.open.billed), num(t.open.paid), num(t.open.balance)]).toEqual([2, 2000, 400, 1600]);
    expect([t.notDue.count, num(t.notDue.balance), t.overdue.count, num(t.overdue.balance)]).toEqual([1, 600, 1, 1000]);
    expect(t.aging.map((a: Body) => [a.bucket, num(a.balance)])).toEqual([['NOT_DUE', 600], ['DAYS_1_30', 0], ['DAYS_31_60', 1000], ['DAYS_61_90', 0], ['OVER_90', 0]]);
    // Émises aujourd'hui : seule la facture du ticket à crédit (la facture du ticket payé n'est pas une créance).
    expect([t.issuedInPeriod.count, num(t.issuedInPeriod.billed), num(t.issuedInPeriod.paid), num(t.issuedInPeriod.balance)]).toEqual([1, 1000, 400, 600]);
    const a = await balanceOf(ids.t1);
    expect([a.dueDate.slice(0, 10), a.overdue, a.paymentStatus]).toEqual([day(30), false, 'PARTIALLY_PAID']);
    // À une date passée (fin d'hier) : seule T2 existait.
    const y = (await get('receivables', manager, period(day(-1), day(-1)))).total;
    expect([y.open.count, num(y.open.balance), y.aging.find((x: Body) => x.bucket === 'DAYS_31_60').count]).toEqual([1, 1000, 1]);
  });

  it('rend l’encours visible par client, sans attribuer de CA facturé aux tickets', async () => {
    const c = await get('customers', manager, period());
    expect([c.customersWithReceivables, c.customersOverdue, num(c.receivables), num(c.overdue), num(c.invoicedRevenue)]).toEqual([2, 1, 1600, 1000, 0]);
    const d = await get('customers/details', manager, period());
    expect(d.topByReceivables.map((r: Body) => [r.customer.name, num(r.receivables), num(r.overdue)])).toEqual([['Awa Koné', 1000, 1000], ['Société Ivoire Events', 600, 0]]);
    expect(d.topByInvoicedRevenue).toEqual([]);
    expect(d.overdueInvoices.map((i: Body) => [i.customer.name, i.daysOverdue, num(i.balance)])).toEqual([['Awa Koné', 40, 1000]]);
    // Encours du groupe identique au module 7 (D9) : A doit 600 au Plateau + 500 à Yopougon.
    const all = await get('customers/details', admin, period());
    for (const row of all.topByReceivables) {
      const m7 = (await api(app, admin).get(`/api/customers/${row.customer.id}/credit`).query({ establishmentId: plt }).expect(200)).body;
      expect(num(row.receivables)).toBe(num(m7.outstanding));
    }
    expect(all.topByReceivables.map((r: Body) => [r.customer.name, num(r.receivables)])).toEqual([['Société Ivoire Events', 1100], ['Awa Koné', 1000]]);
  });

  it('solde la créance par l’encaissement ultérieur, toujours sans résidu', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { saleId: ids.t1 } });
    await as(manager).post(`/api/invoices/${inv.id}/payments`).send({ method: 'BANK_TRANSFER', amount: 600, reference: 'VIR-1' }).expect(201);
    expect(num((await balanceOf(ids.t1)).balance)).toBe(0);
    const t = (await get('receivables', manager, period())).total;
    expect([t.open.count, num(t.open.balance)]).toEqual([1, 1000]);
    const b = (await get('reconciliation', manager, period())).total;
    expect([num(b.revenue), num(b.collections), num(b.gap), num(b.explanation.ticketsOnCredit), num(b.explanation.receivablesChange), num(b.explanation.residual)]).toEqual([2000, 2000, 0, 600, 0, 0]);
  });

  it('recalcule le reste dû après un avoir sur le ticket à crédit', async () => {
    const inv = await balanceOf(ids.t2);
    const cn = (await as(manager).post(`/api/invoices/${inv.id}/credit-notes`).send({ reason: 'Bouteilles abîmées', lines: [{ invoiceLineId: inv.lines[0].id, amount: 300 }] }).expect(201)).body;
    expect([num(cn.reducedDue), num(cn.refundAmount)]).toEqual([300, 0]);
    expect(num((await balanceOf(ids.t2)).balance)).toBe(700);
    const t = (await get('receivables', manager, period())).total;
    expect([num(t.open.balance), num(t.open.credited), t.aging.find((x: Body) => x.bucket === 'DAYS_31_60').count]).toEqual([700, 300, 1]);
    const b = (await get('reconciliation', manager, period())).total;
    // L'avoir réduit le CA du jour et la créance d'autant.
    expect([num(b.revenue), num(b.collections), num(b.explanation.receivablesChange), num(b.explanation.residual)]).toEqual([1700, 2000, -300, 0]);
    expect(num((await get('revenue', manager, period())).total.creditNotes.onTicketInvoices)).toBe(300);
  });

  it('isole les établissements et consolide l’accessible', async () => {
    const y = (await get('receivables', managerYop, period(), yop)).total;
    expect([y.open.count, num(y.open.balance)]).toEqual([1, 500]);
    expect((await get('reconciliation', managerYop, period(), yop)).total.explanation.residual).toBe('0');
    await api(app, managerYop, yop).get('/api/pilotage/receivables').query({ ...period(), establishmentId: plt }).expect(403);
    const all = await get('receivables', admin, period());
    expect([num(all.total.open.balance), all.byEstablishment.map((e: Body) => [e.establishment.code, num(e.open.balance)])]).toEqual([1200, [['PLT', 700], ['YOP', 500]]]);
    const dash = await get('dashboard', admin, period());
    expect([dash.controls.revenueVsCollections.consistent, dash.controls.receivablesAndAdvances.consistent]).toEqual([true, true]);
  });
});
