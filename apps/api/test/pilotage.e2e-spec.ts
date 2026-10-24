import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const num = (v: unknown) => Number(v);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const inDays = day;

/**
 * Module 8 — Étape 1 : chiffre d'affaires, encaissements, rapprochement.
 *
 * Jeu de données du Restaurant Plateau (RES), le jour même :
 *   tickets : A 1 000 (facturé ensuite), addition restaurant 1 500, B 1 000 annulé,
 *             C 2 000 remboursé de 500, E 500 en Wave            → tickets 6 000 − 1 000 − 500 = 4 500
 *   factures hors tickets : commande 10 000 (4 000 payés par virement), M1 5 000 (avoir 1 000),
 *             M2 3 000 (avoir total), M3 2 000 (payée en espèces)  → 20 000
 *   avoirs : 1 000 + 3 000 + 500 (facture du ticket A, remboursé) → 4 500
 *   CA = 4 500 + 20 000 − 4 500 = 20 000
 *   encaissements : tickets 4 500 + clients en caisse (2 000 + acompte 7 000 − 500) + virement 4 000 = 17 000
 *   écart 3 000 = créances +10 000 (6 000 commande + 4 000 M1) − avances +7 000 (acompte)
 * Restaurant Yopougon (YOP) : un ticket de 500.
 */
describe('Module 8 — Étape 1 : chiffre d’affaires, encaissements et rapprochement', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User;
  let cashier: User;
  let accountant: User;
  let managerYop: User;
  let res: string;
  let yop: string;
  const ids: Record<string, string> = {};
  const today = day(0);

  const as = (u: Session, est = res) => api(app, u, est);
  const kpi = (path: string, u: Session, query: Record<string, string>, est?: string) => api(app, u, est).get(`/api/pilotage/${path}`).query(query);
  const period = (from = today, to = today) => ({ from, to });
  const sell = async (u: Session, session: string, quantity: number, method = 'CASH', est = res) =>
    (await as(u, est).post('/api/sales').send({ sessionId: session, lines: [{ productId: ids.coca, quantity }], payments: [{ method, amount: quantity * 500, reference: method === 'CASH' ? undefined : 'WV-1' }] }).expect(201)).body.sale;
  const manualInvoice = async (amount: number) => {
    const d = (await as(manager).post('/api/invoices').send({ establishmentId: res, source: 'MANUAL', customerId: ids.customer, lines: [{ kind: 'FEE', label: 'Prestation', quantity: 1, unitPrice: amount, taxRate: 18 }] }).expect(201)).body;
    return (await as(manager).post(`/api/invoices/${d.id}/issue`).expect(201)).body;
  };
  const feeOrder = async (amount: number) => {
    const o = (await as(manager).post('/api/customer-orders').send({ establishmentId: res, customerId: ids.customer, lines: [{ kind: 'FEE', label: 'Traiteur', quantity: 1, unitPrice: amount, taxRate: 18 }] }).expect(201)).body.id;
    await as(manager).post(`/api/customer-orders/${o}/status`).send({ status: 'CONFIRMED' }).expect(201);
    return o as string;
  };
  /** Compte des écritures sources : M8 ne doit rien écrire. */
  const writes = async () =>
    Promise.all([
      prisma.sale.count(), prisma.saleReturn.count(), prisma.cashMovement.count(), prisma.stockMovement.count(), prisma.customerPayment.count(),
      prisma.paymentAllocation.count(), prisma.deposit.count(), prisma.invoice.count(), prisma.creditNote.count(), prisma.customerRefund.count(), prisma.auditLog.count(),
    ]);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    res = (await api(app, admin).post('/api/establishments').send({ code: 'RES', name: 'Restaurant Plateau', type: 'RESTAURANT' }).expect(201)).body.id;
    yop = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', res);
    cashier = await user('caisse@test.ci', 'CASHIER', res);
    accountant = await user('compta@test.ci', 'ACCOUNTANT', res);
    managerYop = await user('respyop@test.ci', 'MANAGER', yop);
    const store = await user('mag@test.ci', 'STOREKEEPER', res);
    const storeYop = await user('magyop@test.ci', 'STOREKEEPER', yop);

    ids.coca = (await api(app, admin).post('/api/products').send({ code: 'COCA', name: 'Coca 33 cl', type: 'RESOLD', basePrice: 500, taxRate: 18 }).expect(201)).body.id;
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    const receive = (u: Session, est: string, qty: number) =>
      as(u, est)
        .post('/api/goods-receipts')
        .send({ establishmentId: est, supplierId: supplier, items: [{ productId: ids.coca, purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, receivedQuantity: qty, unitPrice: 300, expiryDate: inDays(90) }] })
        .expect(201);
    await receive(store, res, 200);
    await receive(storeYop, yop, 50);
    const register = async (u: Session, est: string, code: string) => (await as(u, est).post('/api/cash-registers').send({ establishmentId: est, code, name: `Caisse ${code}`, printerType: 'NONE' }).expect(201)).body.id;
    const [c1, c2, y1] = [await register(manager, res, 'C1'), await register(manager, res, 'C2'), await register(managerYop, yop, 'Y1')];
    ids.sessCashier = (await as(cashier).post('/api/cash-sessions').send({ registerId: c1, openingFloat: 10000 }).expect(201)).body.id;
    ids.sessManager = (await as(manager).post('/api/cash-sessions').send({ registerId: c2, openingFloat: 20000 }).expect(201)).body.id;
    ids.sessYop = (await as(managerYop, yop).post('/api/cash-sessions').send({ registerId: y1, openingFloat: 5000 }).expect(201)).body.id;
    ids.customer = (await as(manager).post('/api/customers').send({ type: 'BUSINESS', name: 'Société Ivoire Events', paymentTermDays: 30 }).expect(201)).body.id;

    // Tickets.
    ids.saleA = (await sell(cashier, ids.sessCashier, 2)).id;
    const saleB = await sell(cashier, ids.sessCashier, 2);
    await as(manager).post(`/api/sales/${saleB.id}/cancel`).send({ reason: 'Erreur de saisie' }).expect(201);
    const saleC = await sell(cashier, ids.sessCashier, 4);
    await as(manager).post(`/api/sales/${saleC.id}/refund`).send({ sessionId: ids.sessManager, reason: 'Une bouteille cassée', lines: [{ saleItemId: saleC.items[0].id, quantity: 1, disposition: 'RESTOCK' }] }).expect(201);
    await sell(cashier, ids.sessCashier, 1, 'WAVE');
    // Addition du restaurant : encaissée par un ticket M5.
    const bar = (await as(manager).post('/api/restaurant/stations').send({ establishmentId: res, name: 'Bar', kind: 'BAR' }).expect(201)).body.id;
    await as(manager).put('/api/restaurant/menu').send({ establishmentId: res, productId: ids.coca, stationId: bar }).expect(200);
    const area = (await as(manager).post('/api/restaurant/areas').send({ establishmentId: res, name: 'Salle' }).expect(201)).body.id;
    const table = (await as(manager).post('/api/restaurant/tables').send({ areaId: area, code: 'T1', capacity: 4 }).expect(201)).body.id;
    const ro = (await as(manager).post('/api/restaurant/orders').send({ establishmentId: res, mode: 'TABLE', tableId: table, covers: 2 }).expect(201)).body.id;
    await as(manager).post(`/api/restaurant/orders/${ro}/items`).send({ items: [{ productId: ids.coca, quantity: 3 }] }).expect(201);
    await as(manager).post(`/api/restaurant/orders/${ro}/send`).send({}).expect(201);
    const bill = (await as(manager).post(`/api/restaurant/orders/${ro}/bills`).send({}).expect(201)).body.bills[0];
    await as(cashier).post(`/api/restaurant/bills/${bill.id}/pay`).send({ sessionId: ids.sessCashier, payments: [{ method: 'CASH', amount: 1500 }] }).expect(201);

    // Facture du ticket A (aucun double comptage), puis avoir remboursé de 500.
    const ta = (await as(manager).post('/api/invoices').send({ establishmentId: res, source: 'SALE', saleId: ids.saleA, customerId: ids.customer }).expect(201)).body;
    const tai = (await as(manager).post(`/api/invoices/${ta.id}/issue`).expect(201)).body;
    await as(manager).post(`/api/invoices/${ta.id}/credit-notes`).send({ reason: 'Bouteille défectueuse', lines: [{ invoiceLineId: tai.lines[0].id, quantity: 1 }], settlement: { mode: 'REFUND', refund: { method: 'CASH', amount: 500, sessionId: ids.sessManager } } }).expect(201);

    // Factures hors tickets : à crédit (virement partiel), avoir partiel, avoir total, payée comptant.
    const order = await feeOrder(10000);
    const oi = (await as(manager).post('/api/invoices').send({ establishmentId: res, source: 'ORDER', orderId: order }).expect(201)).body;
    await as(manager).post(`/api/invoices/${oi.id}/issue`).expect(201);
    await as(accountant).post(`/api/invoices/${oi.id}/payments`).send({ method: 'BANK_TRANSFER', amount: 4000, reference: 'VIR-1' }).expect(201);
    const m1 = await manualInvoice(5000);
    await as(manager).post(`/api/invoices/${m1.id}/credit-notes`).send({ reason: 'Remise commerciale', lines: [{ invoiceLineId: m1.lines[0].id, amount: 1000 }] }).expect(201);
    const m2 = await manualInvoice(3000);
    await as(manager).post(`/api/invoices/${m2.id}/credit-notes`).send({ reason: 'Prestation annulée', full: true }).expect(201);
    const m3 = await manualInvoice(2000);
    await as(manager).post(`/api/invoices/${m3.id}/payments`).send({ method: 'CASH', amount: 2000, sessionId: ids.sessManager }).expect(201);
    // Acompte sur une autre commande (pas encore facturée).
    const order2 = await feeOrder(20000);
    await as(manager).post('/api/deposits').send({ establishmentId: res, customerId: ids.customer, orderId: order2, payment: { method: 'CASH', amount: 7000, sessionId: ids.sessManager } }).expect(201);

    // Yopougon.
    await sell(managerYop, ids.sessYop, 1, 'CASH', yop);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Chiffre d’affaires', () => {
    it('applique la règle CA sans double comptage (ticket, restaurant, annulation, remboursement, factures, avoirs)', async () => {
      const r = (await kpi('revenue', manager, period()).expect(200)).body;
      expect([r.basis, r.byEstablishment.length, r.byEstablishment[0].establishment.code]).toEqual(['TTC', 1, 'RES']);
      const t = r.total;
      expect([num(t.tickets.gross), t.tickets.count, num(t.cancellations.amount), t.cancellations.count, num(t.refunds.amount), t.refunds.count, num(t.ticketsNet)]).toEqual([6000, 5, 1000, 1, 500, 1, 4500]);
      // Factures hors tickets seulement : la facture du ticket A n'est pas ajoutée.
      expect([num(t.invoices.amount), t.invoices.count]).toEqual([20000, 4]);
      expect([num(t.creditNotes.amount), t.creditNotes.count, num(t.creditNotes.onTicketInvoices)]).toEqual([4500, 3, 500]);
      expect(num(t.revenue)).toBe(20000);
      // TVA non inventée : un remboursement de ticket n'est pas ventilé par taux.
      expect([t.tax, t.revenueExcludingTax, t.refunds.tax]).toEqual([null, null, null]);
      expect(t.taxNote).toMatch(/remboursements de tickets/);
      expect(num(t.invoices.tax)).toBe(1525 + 763 + 458 + 305); // 18 % inclus sur 10 000, 5 000, 3 000, 2 000
    });

    it('expose la TVA quand elle est exacte (aucun remboursement de ticket)', async () => {
      const r = (await kpi('revenue', managerYop, period(), yop).expect(200)).body.total;
      expect([num(r.revenue), num(r.tax), num(r.revenueExcludingTax)]).toEqual([500, 76, 424]);
    });
  });

  describe('Encaissements et rapprochement', () => {
    it('distingue caisse et hors caisse, sans compter deux fois, et met à part les mouvements internes', async () => {
      const c = (await kpi('collections', accountant, period()).expect(200)).body.total;
      expect([num(c.tickets), num(c.customers.register), num(c.customers.offRegister), num(c.total)]).toEqual([4500, 8500, 4000, 17000]);
      expect(c.byMethod.map((m: { method: string; amount: string }) => [m.method, num(m.amount)])).toEqual([
        ['BANK_TRANSFER', 4000],
        ['CASH', 12500],
        ['WAVE', 500],
      ]);
      // Le virement n'apparaît qu'une fois (hors caisse) ; le paiement comptant de M3 une fois (caisse).
      const off = c.byType.filter((x: { source: string }) => x.source === 'OFF_REGISTER');
      expect(off.map((x: { type: string; amount: string }) => [x.type, num(x.amount)])).toEqual([['CUSTOMER_PAYMENT', 4000]]);
      expect(c.internalCashMovements.map((x: { type: string; amount: string }) => [x.type, num(x.amount)])).toEqual([['OPENING_FLOAT', 30000]]);
    });

    it('rapproche CA et encaissements par les créances et les avances, sans résidu', async () => {
      const b = (await kpi('reconciliation', manager, period()).expect(200)).body.total;
      expect([num(b.revenue), num(b.collections), num(b.gap)]).toEqual([20000, 17000, 3000]);
      const e = b.explanation;
      expect([num(e.ticketsTiming), num(e.receivablesChange), num(e.advancesChange), num(e.advancesDetail.deposits), num(e.advancesDetail.unappliedPayments), num(e.residual)]).toEqual([0, 10000, 7000, 7000, 0, 0]);
      expect([num(b.receivables.opening), num(b.receivables.closing)]).toEqual([0, 10000]);
    });
  });

  describe('Établissements, droits et lecture seule', () => {
    it('consolide les établissements accessibles et isole les autres', async () => {
      const all = (await kpi('revenue', admin, period()).expect(200)).body;
      expect([num(all.total.revenue), all.byEstablishment.map((e: { establishment: { code: string }; revenue: string }) => [e.establishment.code, num(e.revenue)])]).toEqual([20500, [['RES', 20000], ['YOP', 500]]]);
      const rec = (await kpi('reconciliation', admin, period()).expect(200)).body.total;
      expect([num(rec.revenue), num(rec.collections), num(rec.explanation.residual)]).toEqual([20500, 17500, 0]);
      const y = (await kpi('collections', managerYop, period(), yop).expect(200)).body;
      expect([y.byEstablishment.map((e: { establishment: { code: string } }) => e.establishment.code), num(y.total.total)]).toEqual([['YOP'], 500]);
      await kpi('revenue', managerYop, { ...period(), establishmentId: res }).expect(403);
      await kpi('revenue', managerYop, period(), res).expect(403);
    });

    it('exige « Tableau de bord direction » et une période valide d’un an au plus', async () => {
      await kpi('revenue', cashier, period()).expect(403);
      await kpi('collections', cashier, period()).expect(403);
      await kpi('revenue', manager, { from: today }).expect(400);
      await kpi('revenue', manager, period(today, day(-1))).expect(400);
      await kpi('revenue', manager, period(day(-366), today)).expect(400); // 367 jours
      await kpi('revenue', manager, period(day(-365), today)).expect(200); // 366 jours
      await kpi('revenue', manager, period('2026-02-30', '2026-03-01')).expect(400);
    });

    it('n’écrit rien : aucun mouvement de stock, de caisse ou financier', async () => {
      const before = await writes();
      for (const path of ['revenue', 'collections', 'reconciliation']) await kpi(path, admin, period(day(-30), today)).expect(200);
      expect(await writes()).toEqual(before);
    });
  });

  describe('Dates et périodes', () => {
    it('rattache chaque ticket et chaque remboursement à sa propre date, bornes comprises', async () => {
      // Deux tickets placés aux bornes : la veille à 23:59:59.999 et aujourd'hui à 00:00:00.000 (mouvements de caisse compris).
      const late = await sell(cashier, ids.sessCashier, 2);
      const early = await sell(cashier, ids.sessCashier, 6);
      const yesterdayEnd = new Date(`${day(-1)}T23:59:59.999Z`);
      const todayStart = new Date(`${today}T00:00:00.000Z`);
      await prisma.$executeRawUnsafe('ALTER TABLE sales DISABLE TRIGGER USER');
      await prisma.$executeRawUnsafe('ALTER TABLE cash_movements DISABLE TRIGGER USER');
      try {
        await prisma.$executeRaw`UPDATE sales SET created_at = ${yesterdayEnd} WHERE id = ${late.id}::uuid`;
        await prisma.$executeRaw`UPDATE cash_movements SET created_at = ${yesterdayEnd} WHERE sale_id = ${late.id}::uuid`;
        await prisma.$executeRaw`UPDATE sales SET created_at = ${todayStart} WHERE id = ${early.id}::uuid`;
        await prisma.$executeRaw`UPDATE cash_movements SET created_at = ${todayStart} WHERE sale_id = ${early.id}::uuid`;
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE sales ENABLE TRIGGER USER');
        await prisma.$executeRawUnsafe('ALTER TABLE cash_movements ENABLE TRIGGER USER');
      }
      // Remboursement aujourd'hui du ticket d'hier : il reste à sa date, sans réécrire la veille.
      await as(manager).post(`/api/sales/${late.id}/refund`).send({ sessionId: ids.sessManager, reason: 'Retour le lendemain', lines: [{ saleItemId: late.items[0].id, quantity: 1, disposition: 'RESTOCK' }] }).expect(201);

      const y = (await kpi('revenue', manager, period(day(-1), day(-1))).expect(200)).body.total;
      expect([num(y.tickets.gross), y.tickets.count, num(y.refunds.amount), num(y.revenue)]).toEqual([1000, 1, 0, 1000]);
      const t = (await kpi('revenue', manager, period()).expect(200)).body.total;
      expect([num(t.tickets.gross), t.tickets.count, num(t.refunds.amount), num(t.revenue)]).toEqual([9000, 6, 1000, 20000 + 3000 - 500]);
      const both = (await kpi('revenue', manager, period(day(-1), today)).expect(200)).body.total;
      expect(num(both.revenue)).toBe(1000 + 22500);
      for (const p of [period(day(-1), day(-1)), period(), period(day(-1), today)]) {
        const b = (await kpi('reconciliation', manager, p).expect(200)).body.total;
        expect([num(b.explanation.ticketsTiming), num(b.explanation.residual)]).toEqual([0, 0]);
      }
      // La veille : encaissement du seul ticket d'hier.
      expect(num((await kpi('collections', manager, period(day(-1), day(-1))).expect(200)).body.total.total)).toBe(1000);
      // Demain : rien.
      expect(num((await kpi('revenue', manager, period(day(1), day(1))).expect(200)).body.total.revenue)).toBe(0);
    });
  });
});
