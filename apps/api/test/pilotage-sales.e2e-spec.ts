import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const num = (v: unknown) => Number(v);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Module 8 — Étape 3 : ventes détaillées, catégories historiques, marge brute, caisse.
 *
 * Restaurant Plateau (RES), le jour même :
 *   coca (Boissons) : lot 1 10 × 300 (péremption proche), lot 2 10 × 400 — FEFO
 *     T1 4 cocas 2 000 (coût 1 200), remboursé d'1 coca (lot rendu 300)
 *     T2 8 cocas 4 000 (6 × 300 + 2 × 400 = 2 600)
 *     T4 2 cocas 1 000 (2 × 400), annulé
 *     addition restaurant 3 cocas 1 500 (coût consommé 1 200), remboursée d'1 coca (lots non tracés au ticket)
 *   jus (sans catégorie) : T3 2 jus 2 000 (2 × 600), facturé ; avoir 1 000 remboursé
 *   gâteau (Pâtisseries, recette 500 g de farine à 700/kg = 350) :
 *     commande O1 2 gâteaux 40 000 + livraison 2 000 (frais), livrée (sortie 700), facturée, avoir 4 000
 *     commande O2 1 gâteau 20 000 facturée, non livrée
 *   facture manuelle : service traiteur 5 000 (frais)
 *   CA = tickets 10 500 − 1 000 − 1 000 + factures 67 000 − avoirs 5 000 = 70 500
 */
describe('Module 8 — Étape 3 : ventes, catégories, marge et caisse', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User;
  let cashier: User;
  let accountant: User;
  let managerYop: User;
  let viewer: User;
  let res: string;
  let yop: string;
  const ids: Record<string, string> = {};
  const today = day(0);

  const as = (u: Session, est = res) => api(app, u, est);
  const kpi = (path: string, u: Session, query: Record<string, string>, est?: string) => api(app, u, est).get(`/api/pilotage/${path}`).query(query);
  const period = (from = today, to = today) => ({ from, to });
  const sell = async (u: Session, session: string, productId: string, quantity: number, unit: number, est = res) =>
    (await as(u, est).post('/api/sales').send({ sessionId: session, lines: [{ productId, quantity }], payments: [{ method: 'CASH', amount: quantity * unit }] }).expect(201)).body.sale;
  const category = (rows: { name: string }[], name: string) => rows.find((r) => r.name === name) as unknown as Record<string, never> & { revenue: string; quantity: number; lines: number; share: number; margin: { revenueWithCost: string; cogs: string; grossMargin: string } };
  const writes = async () =>
    Promise.all([
      prisma.sale.count(), prisma.saleReturn.count(), prisma.cashMovement.count(), prisma.cashSession.count(), prisma.cashClosure.count(), prisma.stockMovement.count(),
      prisma.stockLot.count(), prisma.invoice.count(), prisma.creditNote.count(), prisma.customerPayment.count(), prisma.productCategory.count(), prisma.auditLog.count(),
    ]);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    roles.VIEWER = (await api(app, admin).post('/api/roles').send({ code: 'DIRECTION_LIGHT', name: 'Direction (synthèse)', permissions: ['dashboard.view', 'reports.view'] }).expect(201)).body.id;
    res = (await api(app, admin).post('/api/establishments').send({ code: 'RES', name: 'Restaurant Plateau', type: 'RESTAURANT' }).expect(201)).body.id;
    yop = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', res);
    cashier = await user('caisse@test.ci', 'CASHIER', res);
    accountant = await user('compta@test.ci', 'ACCOUNTANT', res);
    managerYop = await user('respyop@test.ci', 'MANAGER', yop);
    viewer = await user('direction@test.ci', 'VIEWER', res);
    const store = await user('mag@test.ci', 'STOREKEEPER', res);
    const storeYop = await user('magyop@test.ci', 'STOREKEEPER', yop);

    const cat = async (name: string) => (await api(app, admin).post('/api/product-categories').send({ name }).expect(201)).body.id;
    ids.boissons = await cat('Boissons');
    ids.patisseries = await cat('Pâtisseries');
    const product = async (code: string, name: string, type: string, basePrice: number, categoryId?: string) =>
      (await api(app, admin).post('/api/products').send({ code, name, type, basePrice, categoryId }).expect(201)).body.id;
    ids.coca = await product('COCA', 'Coca 33 cl', 'RESOLD', 500, ids.boissons);
    ids.jus = await product('BISS', 'Jus de bissap', 'RESOLD', 1000);
    ids.cake = await product('GAT', 'Gâteau', 'MANUFACTURED', 20000, ids.patisseries);
    ids.flour = (await api(app, admin).post('/api/raw-materials').send({ code: 'FAR', name: 'Farine', baseUnitCode: 'KG', isPerishable: true }).expect(201)).body.id;
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    const receive = (u: Session, est: string, item: object) =>
      as(u, est).post('/api/goods-receipts').send({ establishmentId: est, supplierId: supplier, items: [{ purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, ...item }] }).expect(201);
    await receive(store, res, { productId: ids.coca, receivedQuantity: 10, unitPrice: 300, expiryDate: day(30) });
    await receive(store, res, { productId: ids.coca, receivedQuantity: 10, unitPrice: 400, expiryDate: day(60) });
    await receive(store, res, { productId: ids.jus, receivedQuantity: 10, unitPrice: 600, expiryDate: day(30) });
    await receive(store, res, { rawMaterialId: ids.flour, purchaseUnitLabel: 'kg', receivedQuantity: 10, unitPrice: 700, expiryDate: day(60) });
    await receive(storeYop, yop, { productId: ids.coca, receivedQuantity: 5, unitPrice: 300, expiryDate: day(30) });

    // Production : 3 gâteaux à 350 (500 g de farine à 700/kg).
    const r = await api(app, admin).post('/api/recipes').send({ productId: ids.cake, yieldQuantity: 1, shelfLifeDays: 3, items: [{ rawMaterialId: ids.flour, quantity: 500, unitCode: 'G' }] }).expect(201);
    await api(app, admin).post(`/api/recipe-versions/${r.body.versions[0].id}/activate`).expect(201);
    const po = (await as(manager).post('/api/production-orders').send({ establishmentId: res, productId: ids.cake, plannedQuantity: 3 }).expect(201)).body.id;
    for (const step of ['validate', 'start']) await as(manager).post(`/api/production-orders/${po}/${step}`).expect(201);
    await as(manager).post(`/api/production-orders/${po}/complete`).send({ producedQuantity: 3 }).expect(201);

    // Caisses.
    const register = async (u: Session, est: string, code: string) => (await as(u, est).post('/api/cash-registers').send({ establishmentId: est, code, name: `Caisse ${code}`, printerType: 'NONE' }).expect(201)).body.id;
    const [c1, c2, y1] = [await register(manager, res, 'C1'), await register(manager, res, 'C2'), await register(managerYop, yop, 'Y1')];
    ids.sessCashier = (await as(cashier).post('/api/cash-sessions').send({ registerId: c1, openingFloat: 10000 }).expect(201)).body.id;
    ids.sessManager = (await as(manager).post('/api/cash-sessions').send({ registerId: c2, openingFloat: 20000 }).expect(201)).body.id;
    ids.sessYop = (await as(managerYop, yop).post('/api/cash-sessions').send({ registerId: y1, openingFloat: 0 }).expect(201)).body.id;
    ids.customer = (await as(manager).post('/api/customers').send({ type: 'BUSINESS', name: 'Société Ivoire Events' }).expect(201)).body.id;

    // Tickets.
    const t1 = await sell(cashier, ids.sessCashier, ids.coca, 4, 500);
    await sell(cashier, ids.sessCashier, ids.coca, 8, 500);
    const t3 = await sell(cashier, ids.sessCashier, ids.jus, 2, 1000);
    const t4 = await sell(cashier, ids.sessCashier, ids.coca, 2, 500);
    await as(manager).post(`/api/sales/${t4.id}/cancel`).send({ reason: 'Erreur de saisie' }).expect(201);
    // Addition du restaurant (coût consommé à l'envoi en cuisine/bar).
    const bar = (await as(manager).post('/api/restaurant/stations').send({ establishmentId: res, name: 'Bar', kind: 'BAR' }).expect(201)).body.id;
    await as(manager).put('/api/restaurant/menu').send({ establishmentId: res, productId: ids.coca, stationId: bar }).expect(200);
    const area = (await as(manager).post('/api/restaurant/areas').send({ establishmentId: res, name: 'Salle' }).expect(201)).body.id;
    const table = (await as(manager).post('/api/restaurant/tables').send({ areaId: area, code: 'T1', capacity: 4 }).expect(201)).body.id;
    const ro = (await as(manager).post('/api/restaurant/orders').send({ establishmentId: res, mode: 'TABLE', tableId: table, covers: 2 }).expect(201)).body.id;
    await as(manager).post(`/api/restaurant/orders/${ro}/items`).send({ items: [{ productId: ids.coca, quantity: 3 }] }).expect(201);
    await as(manager).post(`/api/restaurant/orders/${ro}/send`).send({}).expect(201);
    const bill = (await as(manager).post(`/api/restaurant/orders/${ro}/bills`).send({}).expect(201)).body.bills[0];
    await as(cashier).post(`/api/restaurant/bills/${bill.id}/pay`).send({ sessionId: ids.sessCashier, payments: [{ method: 'CASH', amount: 1500 }] }).expect(201);
    const rSale = await prisma.sale.findFirstOrThrow({ orderBy: { createdAt: 'desc' }, include: { items: true } });
    // Remboursements : T1 (lot rendu tracé) et addition (sans lots au ticket).
    await as(manager).post(`/api/sales/${t1.id}/refund`).send({ sessionId: ids.sessManager, reason: 'Bouteille cassée', lines: [{ saleItemId: t1.items[0].id, quantity: 1, disposition: 'RESTOCK' }] }).expect(201);
    await as(manager).post(`/api/sales/${rSale.id}/refund`).send({ sessionId: ids.sessManager, reason: 'Boisson renversée', lines: [{ saleItemId: rSale.items[0].id, quantity: 1, disposition: 'LOSS' }] }).expect(201);

    // Facture du ticket T3 (sans double comptage) et avoir remboursé.
    const ti = (await as(manager).post('/api/invoices').send({ establishmentId: res, source: 'SALE', saleId: t3.id, customerId: ids.customer }).expect(201)).body;
    const tii = (await as(manager).post(`/api/invoices/${ti.id}/issue`).expect(201)).body;
    await as(manager).post(`/api/invoices/${ti.id}/credit-notes`).send({ reason: 'Jus tiède', lines: [{ invoiceLineId: tii.lines[0].id, amount: 1000 }], settlement: { mode: 'REFUND', refund: { method: 'CASH', amount: 1000, sessionId: ids.sessManager } } }).expect(201);

    // Commandes : O1 livrée (sortie CUSTOMER_DELIVERY), O2 facturée sans livraison.
    const order = async (cakes: number, fee: boolean) => {
      const lines = [{ kind: 'PRODUCT', productId: ids.cake, quantity: cakes }, ...(fee ? [{ kind: 'FEE', label: 'Livraison', quantity: 1, unitPrice: 2000 }] : [])];
      const o = (await as(manager).post('/api/customer-orders').send({ establishmentId: res, customerId: ids.customer, lines }).expect(201)).body.id;
      await as(manager).post(`/api/customer-orders/${o}/status`).send({ status: 'CONFIRMED' }).expect(201);
      return o as string;
    };
    const o1 = await order(2, true);
    const o2 = await order(1, false);
    for (const st of ['IN_PREPARATION', 'READY']) await as(manager).post(`/api/customer-orders/${o1}/status`).send({ status: st }).expect(201);
    await as(manager).post(`/api/customer-orders/${o1}/hand-over`).expect(201);
    ids.o1 = o1;
    const invoiceOf = async (orderId: string) => {
      const d = (await as(manager).post('/api/invoices').send({ establishmentId: res, source: 'ORDER', orderId }).expect(201)).body;
      return (await as(manager).post(`/api/invoices/${d.id}/issue`).expect(201)).body;
    };
    const i1 = await invoiceOf(o1);
    await invoiceOf(o2);
    const cakeLine = i1.lines.find((l: { kind: string }) => l.kind === 'PRODUCT').id;
    await as(manager).post(`/api/invoices/${i1.id}/credit-notes`).send({ reason: 'Remise fidélité', lines: [{ invoiceLineId: cakeLine, amount: 4000 }] }).expect(201);
    const m = (await as(manager).post('/api/invoices').send({ establishmentId: res, source: 'MANUAL', customerId: ids.customer, lines: [{ kind: 'FEE', label: 'Service traiteur', quantity: 1, unitPrice: 5000 }] }).expect(201)).body;
    await as(manager).post(`/api/invoices/${m.id}/issue`).expect(201);

    // Caisse : mouvements manuels et clôture du caissier avec un écart de −500 en espèces.
    await as(manager).post(`/api/cash-sessions/${ids.sessManager}/movements`).send({ type: 'MANUAL_IN', amount: 5000, reason: 'Appoint monnaie' }).expect(201);
    await as(manager).post(`/api/cash-sessions/${ids.sessManager}/movements`).send({ type: 'MANUAL_OUT', amount: 2000, reason: 'Achat glace' }).expect(201);
    const s = (await as(cashier).get(`/api/cash-sessions/${ids.sessCashier}`).expect(200)).body;
    const counts = s.expected.map((e: { method: string; amount: string }) => ({ method: e.method, counted: num(e.amount) - (e.method === 'CASH' ? 500 : 0) }));
    await as(cashier).post(`/api/cash-sessions/${ids.sessCashier}/close`).send({ counts }).expect(201);

    // Yopougon : 1 coca.
    await sell(managerYop, ids.sessYop, ids.coca, 1, 500, yop);

    // Changement de catalogue après coup : coca en Pâtisseries, « Boissons » renommée.
    await api(app, admin).patch(`/api/products/${ids.coca}`).send({ categoryId: ids.patisseries }).expect(200);
    await api(app, admin).patch(`/api/product-categories/${ids.boissons}`).send({ name: 'Sodas' }).expect(200);
    ids.t3 = t3.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Ventes détaillées', () => {
    it('reprend le CA de l’étape 1 avec nombres de tickets, factures et paniers moyens', async () => {
      const v = (await kpi('sales', manager, period()).expect(200)).body.total;
      const r = (await kpi('revenue', manager, period()).expect(200)).body.total;
      expect(num(v.revenue)).toBe(num(r.revenue));
      expect([num(v.revenue), num(v.tickets.gross), num(v.cancellations.amount), num(v.refunds.amount), num(v.invoices.amount), num(v.creditNotes.amount)]).toEqual([70500, 10500, 1000, 1000, 67000, 5000]);
      expect([v.ticketCount, v.netTicketCount, v.invoiceCount, v.averageTicket, v.averageInvoice, v.tax]).toEqual([5, 4, 3, 2125, 22333, null]);
    });
  });

  describe('Catégories historiques', () => {
    it('classe le CA par catégorie figée, avec « Non catégorisé » et les frais à part', async () => {
      const c = (await kpi('sales/categories', accountant, period()).expect(200)).body;
      expect(num(c.total)).toBe(70500);
      expect(c.categories.map((x: { name: string; kind: string; revenue: string; share: number }) => [x.name, x.kind, num(x.revenue), x.share])).toEqual([
        ['Pâtisseries', 'CATEGORY', 56000, 79.4],
        ['Frais et prestations', 'FEES', 7000, 9.9],
        ['Boissons', 'CATEGORY', 6500, 9.2], // nom figé : la catégorie a été renommée « Sodas » depuis
        ['Non catégorisé', 'UNCATEGORIZED', 1000, 1.4],
      ]);
      const boissons = category(c.categories, 'Boissons');
      expect([boissons.quantity, boissons.lines, num(boissons.margin.revenueWithCost), num(boissons.margin.cogs), num(boissons.margin.grossMargin)]).toEqual([13, 4, 7000, 4700, 2300]);
      const nc = category(c.categories, 'Non catégorisé');
      expect([nc.quantity, num(nc.margin.cogs), num(nc.margin.grossMargin)]).toEqual([2, 1200, -200]);
      expect(category(c.categories, 'Frais et prestations').margin).toBeNull();
      // Le coca, désormais en Pâtisseries au catalogue, n'y est pas compté.
      expect(category(c.categories, 'Pâtisseries').quantity).toBe(3);
    });
  });

  describe('Marge brute', () => {
    it('calcule la marge sur coûts réels et isole frais et ventes sans coût fiable', async () => {
      const m = (await kpi('margin', manager, period()).expect(200)).body.total;
      expect([num(m.goods.revenue), num(m.goods.cogs), num(m.goods.grossMargin), m.goods.rate]).toEqual([44000, 6600, 37400, 85]);
      expect(num(m.fees.revenue)).toBe(7000);
      expect([num(m.uncovered.revenue), m.uncovered.reasons.map((r: { reason: string; revenue: string; lines: number }) => [r.reason, num(r.revenue), r.lines])]).toEqual([
        19500,
        [['NOT_DELIVERED', 20000, 1], ['REFUND_WITHOUT_LOTS', -500, 1]],
      ]);
      expect([num(m.revenue), m.coverage]).toEqual([70500, 62.4]);
      // Coût de la commande livrée : celui des sorties CUSTOMER_DELIVERY (lot de production à 350).
      const issued = await prisma.customerOrderLineIssue.aggregate({ where: { line: { orderId: ids.o1 } }, _sum: { value: true } });
      const moves = await prisma.stockMovement.aggregate({ where: { type: 'CUSTOMER_DELIVERY', originId: ids.o1 }, _sum: { value: true } });
      expect([num(issued._sum.value), -num(moves._sum.value)]).toEqual([700, 700]);
    });
  });

  describe('Caisse', () => {
    it('présente sessions, mouvements et écarts du module 5, distincts du CA et des encaissements', async () => {
      const k = (await kpi('cash', manager, period()).expect(200)).body.total;
      expect(k.sessions).toEqual({ opened: 2, closed: 1, validated: 0, openAtEnd: 1, closedNotValidatedAtEnd: 1 });
      const mv = k.movements;
      expect([num(mv.ticketSales), num(mv.ticketCancellations), num(mv.ticketRefunds), num(mv.ticketsNet), num(mv.customerPayments), num(mv.customerRefunds)]).toEqual([10500, -1000, -1000, 8500, 0, -1000]);
      expect([num(mv.openingFloats), num(mv.manualIn), num(mv.manualOut)]).toEqual([30000, 5000, -2000]);
      expect([k.closures.sessionsWithDifference, num(k.closures.totalDifference)]).toEqual([1, -500]);
      expect(k.closures.byMethod.map((x: { method: string; expected: string; counted: string; difference: string }) => [x.method, num(x.expected), num(x.counted), num(x.difference)])).toEqual([['CASH', 19500, 19000, -500]]);
      // Mêmes montants que les encaissements « caisse » de l'étape 1 (non additionnables) ; le CA est différent.
      const col = (await kpi('collections', manager, period()).expect(200)).body.total;
      expect([num(col.tickets), num(col.customers.register), num(col.total)]).toEqual([8500, -1000, 7500]);
      expect(num((await kpi('revenue', manager, period()).expect(200)).body.total.revenue)).toBe(70500);
    });
  });

  describe('Établissements, droits, périodes et lecture seule', () => {
    it('consolide les établissements accessibles et isole les autres', async () => {
      const all = (await kpi('sales/categories', admin, period()).expect(200)).body;
      expect([num(all.total), num(category(all.categories, 'Boissons').revenue)]).toEqual([71000, 7000]);
      const y = (await kpi('margin', managerYop, period(), yop).expect(200)).body;
      expect([y.byEstablishment.map((e: { establishment: { code: string } }) => e.establishment.code), num(y.total.goods.revenue), num(y.total.goods.cogs)]).toEqual([['YOP'], 500, 300]);
      await kpi('sales', managerYop, { ...period(), establishmentId: res }).expect(403);
      await kpi('cash', managerYop, period(), res).expect(403);
    });

    it('exige dashboard.view pour la synthèse, reports.view + ventes pour catégories et marge', async () => {
      for (const path of ['sales', 'sales/categories', 'margin', 'cash']) await kpi(path, cashier, period()).expect(403);
      await kpi('sales', viewer, period()).expect(200);
      await kpi('cash', viewer, period()).expect(200);
      await kpi('sales/categories', viewer, period()).expect(403);
      await kpi('margin', viewer, period()).expect(403);
      await kpi('margin', manager, period(day(-366), today)).expect(400);
    });

    it('rattache chaque ligne à sa date et n’écrit rien', async () => {
      expect(num((await kpi('sales/categories', manager, period(day(1), day(1))).expect(200)).body.total)).toBe(0);
      // Le ticket T3 placé à la veille 23:59:59.999 : ses lignes passent à la veille, son avoir reste au jour même.
      await prisma.$executeRawUnsafe('ALTER TABLE sales DISABLE TRIGGER USER');
      await prisma.$executeRawUnsafe('ALTER TABLE cash_movements DISABLE TRIGGER USER');
      try {
        const at = new Date(`${day(-1)}T23:59:59.999Z`);
        await prisma.$executeRaw`UPDATE sales SET created_at = ${at} WHERE id = ${ids.t3}::uuid`;
        await prisma.$executeRaw`UPDATE cash_movements SET created_at = ${at} WHERE sale_id = ${ids.t3}::uuid`;
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE sales ENABLE TRIGGER USER');
        await prisma.$executeRawUnsafe('ALTER TABLE cash_movements ENABLE TRIGGER USER');
      }
      const y = (await kpi('sales/categories', manager, period(day(-1), day(-1))).expect(200)).body;
      expect(y.categories.map((x: { name: string; revenue: string; quantity: number }) => [x.name, num(x.revenue), x.quantity])).toEqual([['Non catégorisé', 2000, 2]]);
      const t = (await kpi('sales/categories', manager, period()).expect(200)).body;
      expect([num(t.total), num(category(t.categories, 'Non catégorisé').revenue)]).toEqual([68500, -1000]);
      const both = (await kpi('margin', manager, period(day(-1), today)).expect(200)).body.total;
      expect([num(both.revenue), num(both.goods.cogs)]).toEqual([70500, 6600]);
      expect(num((await kpi('revenue', manager, period(day(-1), today)).expect(200)).body.total.revenue)).toBe(70500);

      const before = await writes();
      for (const path of ['sales', 'sales/categories', 'margin', 'cash']) await kpi(path, admin, period(day(-30), today)).expect(200);
      expect(await writes()).toEqual(before);
    });
  });
});
