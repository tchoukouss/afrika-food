import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const num = (v: unknown) => Number(v);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Module 8 — Étape 2 : créances, acomptes et clients.
 *
 * Pâtisserie Plateau (PLT), factures « frais » sans TVA :
 *   I1 c1 10 000, acompte D1 imputé 2 000      → reste 8 000, non échue (30 jours)
 *   I2 c1  8 000, virement 3 000               → reste 5 000, échue de 10 jours
 *   I3 c2  6 000                               → échue de 45 jours
 *   I4 c2  4 000                               → échue de 75 jours
 *   I5 c3  5 000, émise il y a 2 jours         → échue de 120 jours
 *   I6 c1  2 000 payée en espèces, avoir 500 en crédit client → soldée
 *   acomptes : D1 c1 7 000 (2 000 imputés), D2 c2 4 000 (1 500 remboursés, puis crédit client)
 *   avances libres : virement c3 3 000 non réparti + 500 libérés par l'avoir de I6
 *   un ticket anonyme de 1 000
 * Restaurant Yopougon (YOP) : Y1 c1 9 000, échue de 5 jours.
 */
describe('Module 8 — Étape 2 : créances, acomptes et clients', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User;
  let cashier: User;
  let accountant: User;
  let managerYop: User;
  let viewer: User; // tableau de bord sans « consulter les créances »
  let plt: string;
  let yop: string;
  const ids: Record<string, string> = {};
  const today = day(0);

  const as = (u: Session, est = plt) => api(app, u, est);
  const kpi = (path: string, u: Session, query: Record<string, string>, est?: string) => api(app, u, est).get(`/api/pilotage/${path}`).query(query);
  const period = (from = today, to = today) => ({ from, to });
  const invoice = async (u: Session, est: string, customerId: string, amount: number) => {
    const d = (await as(u, est).post('/api/invoices').send({ establishmentId: est, source: 'MANUAL', customerId, lines: [{ kind: 'FEE', label: 'Prestation', quantity: 1, unitPrice: amount }] }).expect(201)).body;
    return (await as(u, est).post(`/api/invoices/${d.id}/issue`).expect(201)).body as { id: string; lines: { id: string }[] };
  };
  const writes = async () =>
    Promise.all([
      prisma.sale.count(), prisma.cashMovement.count(), prisma.stockMovement.count(), prisma.customerPayment.count(), prisma.paymentAllocation.count(),
      prisma.deposit.count(), prisma.invoice.count(), prisma.creditNote.count(), prisma.customerRefund.count(), prisma.customer.count(), prisma.auditLog.count(),
    ]);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    roles.VIEWER = (await api(app, admin).post('/api/roles').send({ code: 'DIRECTION_LIGHT', name: 'Direction (synthèse)', permissions: ['dashboard.view', 'reports.view'] }).expect(201)).body.id;
    plt = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yop = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', plt);
    cashier = await user('caisse@test.ci', 'CASHIER', plt);
    accountant = await user('compta@test.ci', 'ACCOUNTANT', plt);
    managerYop = await user('respyop@test.ci', 'MANAGER', yop);
    viewer = await user('direction@test.ci', 'VIEWER', plt);
    const store = await user('mag@test.ci', 'STOREKEEPER', plt);

    // Ticket anonyme (jamais attribué à un client).
    ids.coca = (await api(app, admin).post('/api/products').send({ code: 'COCA', name: 'Coca 33 cl', type: 'RESOLD', basePrice: 500 }).expect(201)).body.id;
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    await as(store)
      .post('/api/goods-receipts')
      .send({ establishmentId: plt, supplierId: supplier, items: [{ productId: ids.coca, purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, receivedQuantity: 20, unitPrice: 300, expiryDate: day(90) }] })
      .expect(201);
    const c1reg = (await as(manager).post('/api/cash-registers').send({ establishmentId: plt, code: 'C1', name: 'Caisse', printerType: 'NONE' }).expect(201)).body.id;
    ids.sess = (await as(manager).post('/api/cash-sessions').send({ registerId: c1reg, openingFloat: 20000 }).expect(201)).body.id;
    await as(manager).post('/api/sales').send({ sessionId: ids.sess, lines: [{ productId: ids.coca, quantity: 2 }], payments: [{ method: 'CASH', amount: 1000 }] }).expect(201);

    const customer = async (type: string, name: string, extra: object = {}) => (await as(manager).post('/api/customers').send({ type, name, ...extra }).expect(201)).body.id;
    ids.c1 = await customer('BUSINESS', 'Société Ivoire Events', { paymentTermDays: 30 });
    ids.c2 = await customer('INDIVIDUAL', 'Awa Koné');
    ids.c3 = await customer('EVENT', 'Famille Kouassi');
    ids.c4 = await customer('WHOLESALER', 'Grossiste parti');
    await as(manager).patch(`/api/customers/${ids.c4}`).send({ isActive: false }).expect(200);

    const i1 = await invoice(manager, plt, ids.c1, 10000);
    const i2 = await invoice(manager, plt, ids.c1, 8000);
    const i3 = await invoice(manager, plt, ids.c2, 6000);
    const i4 = await invoice(manager, plt, ids.c2, 4000);
    const i5 = await invoice(manager, plt, ids.c3, 5000);
    const i6 = await invoice(manager, plt, ids.c1, 2000);
    const y1 = await invoice(managerYop, yop, ids.c1, 9000);
    Object.assign(ids, { i1: i1.id, i2: i2.id, i3: i3.id, i4: i4.id, i5: i5.id, i6: i6.id, y1: y1.id });

    // Règlements : virement partiel (hors caisse), paiement comptant puis avoir en crédit client.
    await as(accountant).post(`/api/invoices/${i2.id}/payments`).send({ method: 'BANK_TRANSFER', amount: 3000, reference: 'VIR-1' }).expect(201);
    await as(manager).post(`/api/invoices/${i6.id}/payments`).send({ method: 'CASH', amount: 2000, sessionId: ids.sess }).expect(201);
    await as(manager).post(`/api/invoices/${i6.id}/credit-notes`).send({ reason: 'Geste commercial', lines: [{ invoiceLineId: i6.lines[0].id, amount: 500 }], settlement: { mode: 'CUSTOMER_CREDIT' } }).expect(201);
    // Acomptes : D1 imputé en partie ; D2 remboursé en partie puis converti en crédit client.
    const o1 = (await as(manager).post('/api/customer-orders').send({ establishmentId: plt, customerId: ids.c1, lines: [{ kind: 'FEE', label: 'Traiteur', quantity: 1, unitPrice: 30000 }] }).expect(201)).body.id;
    await as(manager).post(`/api/customer-orders/${o1}/status`).send({ status: 'CONFIRMED' }).expect(201);
    const d1 = (await as(manager).post('/api/deposits').send({ establishmentId: plt, customerId: ids.c1, orderId: o1, payment: { method: 'CASH', amount: 7000, sessionId: ids.sess } }).expect(201)).body.id;
    await as(manager).post(`/api/invoices/${i1.id}/allocations`).send({ depositId: d1, amount: 2000 }).expect(201);
    const d2 = (await as(manager).post('/api/deposits').send({ establishmentId: plt, customerId: ids.c2, payment: { method: 'CASH', amount: 4000, sessionId: ids.sess } }).expect(201)).body.id;
    await as(manager).post(`/api/deposits/${d2}/refund`).send({ method: 'CASH', amount: 1500, sessionId: ids.sess, reason: 'Invités en moins' }).expect(201);
    await as(manager).post(`/api/deposits/${d2}/credit`).send({ reason: 'Événement reporté' }).expect(201);
    // Paiement hors caisse non réparti : avance du client.
    await as(accountant).post('/api/customer-payments').send({ establishmentId: plt, customerId: ids.c3, method: 'BANK_TRANSFER', amount: 3000, reference: 'VIR-2' }).expect(201);

    // Échéances et dates d'émission (simulées : la facture émise est figée en base).
    await prisma.$executeRawUnsafe('ALTER TABLE invoices DISABLE TRIGGER invoices_guard');
    try {
      for (const [id, offset] of [[i2.id, -10], [i3.id, -45], [i4.id, -75], [i5.id, -120], [y1.id, -5]] as const) {
        await prisma.$executeRaw`UPDATE invoices SET due_date = ${day(offset)}::date WHERE id = ${id}::uuid`;
      }
      await prisma.$executeRaw`UPDATE invoices SET issued_at = ${new Date(`${day(-2)}T10:00:00.000Z`)} WHERE id = ${i5.id}::uuid`;
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE invoices ENABLE TRIGGER invoices_guard');
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Créances', () => {
    it('calcule reste dû, échues, non échues et ancienneté, factures payées exclues', async () => {
      const r = (await kpi('receivables', manager, period()).expect(200)).body;
      const t = r.total;
      expect([r.asOf, t.open.count, num(t.open.billed), num(t.open.paid), num(t.open.credited), num(t.open.balance)]).toEqual([today, 5, 33000, 5000, 0, 28000]);
      expect([t.notDue.count, num(t.notDue.balance), t.overdue.count, num(t.overdue.balance)]).toEqual([1, 8000, 4, 20000]);
      expect(t.aging.map((a: { bucket: string; count: number; balance: string }) => [a.bucket, a.count, num(a.balance)])).toEqual([
        ['NOT_DUE', 1, 8000],
        ['DAYS_1_30', 1, 5000],
        ['DAYS_31_60', 1, 6000],
        ['DAYS_61_90', 1, 4000],
        ['OVER_90', 1, 5000],
      ]);
      // Émises dans la période (I5 émise il y a 2 jours en est exclue) : I6 soldée y figure à 0.
      expect([t.issuedInPeriod.count, num(t.issuedInPeriod.billed), num(t.issuedInPeriod.paid), num(t.issuedInPeriod.credited), num(t.issuedInPeriod.balance)]).toEqual([5, 30000, 6500, 500, 23000]);
      const wide = (await kpi('receivables', manager, period(day(-2), today)).expect(200)).body.total.issuedInPeriod;
      expect([wide.count, num(wide.billed), num(wide.balance)]).toEqual([6, 35000, 28000]);
    });

    it('reconstitue la situation à une date passée sans lire l’état actuel', async () => {
      const y = (await kpi('receivables', manager, period(day(-1), day(-1))).expect(200)).body.total;
      // Fin d'hier : seule I5 (émise il y a 2 jours) existait, aucun règlement.
      expect([y.open.count, num(y.open.balance), y.aging.find((a: { bucket: string }) => a.bucket === 'OVER_90').count]).toEqual([1, 5000, 1]);
      const adv = (await kpi('advances', manager, period(day(-1), day(-1))).expect(200)).body.total.closing;
      expect([num(adv.totalAdvances), adv.deposits.count]).toEqual([0, 0]);
    });

    it('reste cohérent avec les soldes et l’encours du module 7', async () => {
      const d = (await kpi('customers/details', admin, period()).expect(200)).body;
      for (const inv of d.overdueInvoices) {
        expect(num(inv.balance)).toBe(num((await api(app, admin).get(`/api/invoices/${inv.invoiceId}`).expect(200)).body.balance));
      }
      for (const row of d.topByReceivables) {
        const m7 = (await api(app, admin).get(`/api/customers/${row.customer.id}/credit`).query({ establishmentId: plt }).expect(200)).body;
        expect(num(row.receivables)).toBe(num(m7.outstanding)); // encours du groupe, comme le module 7 (D9)
      }
      expect(d.topByReceivables.map((r: { customer: { name: string }; receivables: string }) => [r.customer.name, num(r.receivables)])).toEqual([
        ['Société Ivoire Events', 22000],
        ['Awa Koné', 10000],
        ['Famille Kouassi', 5000],
      ]);
    });
  });

  describe('Acomptes et avances', () => {
    it('distingue acomptes reçus, imputés, remboursés, disponibles, crédit client et paiements non répartis', async () => {
      const a = (await kpi('advances', accountant, period()).expect(200)).body;
      const c = a.total.closing;
      expect([c.deposits.count, num(c.deposits.received), num(c.deposits.applied), num(c.deposits.refunded), num(c.deposits.available), num(c.deposits.availableOnOrders), num(c.deposits.convertedToCustomerCredit)]).toEqual([
        2, 11000, 2000, 1500, 7500, 5000, 2500,
      ]);
      expect([num(c.unappliedPayments), num(c.customerCredit), num(c.totalAdvances)]).toEqual([3500, 6000, 11000]);
      const f = a.total.flows;
      expect([num(f.depositsReceived), f.depositsReceivedCount, num(f.depositsApplied), num(f.depositsRefunded), num(f.depositsCancelled)]).toEqual([11000, 2, 2000, 1500, 0]);
      expect(num(a.total.opening.totalAdvances)).toBe(0);
      expect(a.notes.join(' ')).toMatch(/TVA des acomptes : non calculée/);
      // Même situation que le rapprochement de l'étape 1 ; aucun acompte dans le chiffre d'affaires.
      const rec = (await kpi('reconciliation', accountant, period()).expect(200)).body.total;
      expect([num(rec.advances.closing), num(rec.advances.depositsClosing), num(rec.receivables.closing), num(rec.explanation.residual)]).toEqual([11000, 7500, 28000, 0]);
      const rev = (await kpi('revenue', accountant, period()).expect(200)).body.total;
      expect([num(rev.ticketsNet), num(rev.invoices.amount), num(rev.creditNotes.amount), num(rev.revenue)]).toEqual([1000, 30000, 500, 30500]);
    });
  });

  describe('Clients', () => {
    it('compte les clients, leur encours et la concentration, sans attribuer les tickets anonymes', async () => {
      const c = (await kpi('customers', manager, period()).expect(200)).body;
      expect([c.activeCustomers, c.inactiveCustomers, c.activeByType.map((t: { type: string; count: number }) => [t.type, t.count])]).toEqual([3, 1, [['BUSINESS', 1], ['EVENT', 1], ['INDIVIDUAL', 1]]]);
      expect([c.customersWithReceivables, c.customersOverdue, num(c.receivables), num(c.overdue)]).toEqual([3, 3, 28000, 20000]);
      // CA facturé : factures hors tickets − avoirs ; le ticket anonyme de 1 000 n'est à personne.
      expect([num(c.invoicedRevenue), c.concentration.top5ReceivablesShare, c.concentration.top5InvoicedRevenueShare]).toEqual([29500, 100, 100]);
      const d = (await kpi('customers/details', accountant, period()).expect(200)).body;
      expect(d.topByReceivables.map((r: { customer: { name: string }; receivables: string; overdue: string }) => [r.customer.name, num(r.receivables), num(r.overdue)])).toEqual([
        ['Société Ivoire Events', 13000, 5000],
        ['Awa Koné', 10000, 10000],
        ['Famille Kouassi', 5000, 5000],
      ]);
      expect(d.topByInvoicedRevenue.map((r: { customer: { name: string }; revenue: string }) => [r.customer.name, num(r.revenue)])).toEqual([['Société Ivoire Events', 19500], ['Awa Koné', 10000]]);
      expect(d.overdueInvoices.map((i: { daysOverdue: number; balance: string }) => [i.daysOverdue, num(i.balance)])).toEqual([[120, 5000], [75, 4000], [45, 6000], [10, 5000]]);
      const named = new Set([...d.topByReceivables, ...d.topByInvoicedRevenue].map((r: { customer: { id: string } }) => r.customer.id));
      expect([...named].every((id) => [ids.c1, ids.c2, ids.c3].includes(id))).toBe(true);
    });

    it('consolide un client présent dans plusieurs établissements, établissement par établissement', async () => {
      const all = (await kpi('receivables', admin, period()).expect(200)).body;
      expect([num(all.total.open.balance), num(all.total.overdue.balance)]).toEqual([37000, 29000]);
      expect(all.byEstablishment.map((e: { establishment: { code: string }; open: { balance: string } }) => [e.establishment.code, num(e.open.balance)])).toEqual([['PLT', 28000], ['YOP', 9000]]);
      const yo = (await kpi('customers/details', managerYop, period(), yop).expect(200)).body;
      expect(yo.topByReceivables.map((r: { customer: { name: string }; receivables: string }) => [r.customer.name, num(r.receivables)])).toEqual([['Société Ivoire Events', 9000]]);
    });
  });

  describe('Droits et lecture seule', () => {
    it('applique dashboard.view, reports.view + créances pour le détail, et l’isolation', async () => {
      for (const path of ['receivables', 'advances', 'customers', 'customers/details']) await kpi(path, cashier, period()).expect(403);
      expect((await kpi('customers', viewer, period()).expect(200)).body.customersWithReceivables).toBe(3);
      await kpi('customers/details', viewer, period()).expect(403); // pas « consulter les créances »
      await kpi('receivables', managerYop, { ...period(), establishmentId: plt }).expect(403);
      expect((await kpi('receivables', managerYop, period(), yop).expect(200)).body.byEstablishment.map((e: { establishment: { code: string } }) => e.establishment.code)).toEqual(['YOP']);
      await kpi('advances', manager, period(day(-366), today)).expect(400);
    });

    it('n’écrit rien', async () => {
      const before = await writes();
      for (const path of ['receivables', 'advances', 'customers', 'customers/details']) await kpi(path, admin, period(day(-30), today)).expect(200);
      expect(await writes()).toEqual(before);
    });
  });
});
