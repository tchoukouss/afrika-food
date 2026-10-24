import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const num = (v: unknown) => Number(v);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Module 8 — Étape 5 : tableau de bord consolidé, contrôles et exports.
 *
 * Pâtisserie Plateau (PLT) :
 *   réceptions : R1 (SOL) coca 20 × 300 + (GMA) R1b farine 10 kg × 700 aujourd'hui ;
 *                R2 (GMA) farine 5 kg × 800 déclarée hier (received_at = jour A) mais enregistrée aujourd'hui (mouvement = jour B) ;
 *                retour de 2 cocas (600)
 *   ventes : ticket 4 cocas 2 000 ; ticket 2 cocas 1 000 remboursé d'1 coca (500)
 *   facture manuelle 10 000, virement 4 000 → créance 6 000 ; acompte 3 000 en espèces
 *   production : P1 4 gâteaux produits ; P2 2 planifiés ; seuil coca 20/25 (sous seuil)
 *   caisse : clôture du caissier avec −100 en espèces
 *   CA 12 500 ; encaissements 9 500 ; écart 3 000 = créances +6 000 − avances +3 000
 * Restaurant Yopougon (YOP) : réception coca 5 × 300, ticket 1 coca 500.
 */
describe('Module 8 — Étape 5 : tableau de bord, contrôles et exports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User;
  let cashier: User;
  let viewer: User;
  let managerYop: User;
  let plt: string;
  let yop: string;
  const ids: Record<string, string> = {};
  const today = day(0);

  const as = (u: Session, est = plt) => api(app, u, est);
  const get = async (path: string, u: Session, query: Record<string, string>, est?: string): Promise<Body> => (await api(app, u, est).get(`/api/pilotage/${path}`).query(query).expect(200)).body;
  const period = (from = today, to = today) => ({ from, to });
  const writes = async () =>
    Promise.all([
      prisma.sale.count(), prisma.cashMovement.count(), prisma.cashClosure.count(), prisma.stockMovement.count(), prisma.stockLot.count(), prisma.goodsReceipt.count(),
      prisma.productionOrder.count(), prisma.customerPayment.count(), prisma.paymentAllocation.count(), prisma.deposit.count(), prisma.invoice.count(), prisma.creditNote.count(), prisma.auditLog.count(),
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
    viewer = await user('direction@test.ci', 'VIEWER', plt);
    managerYop = await user('respyop@test.ci', 'MANAGER', yop);
    const accountant = await user('compta@test.ci', 'ACCOUNTANT', plt);
    const store = await user('mag@test.ci', 'STOREKEEPER', plt);
    const storeYop = await user('magyop@test.ci', 'STOREKEEPER', yop);

    const boissons = (await api(app, admin).post('/api/product-categories').send({ name: 'Boissons' }).expect(201)).body.id;
    ids.coca = (await api(app, admin).post('/api/products').send({ code: 'COCA', name: 'Coca 33 cl', type: 'RESOLD', basePrice: 500, categoryId: boissons }).expect(201)).body.id;
    ids.cake = (await api(app, admin).post('/api/products').send({ code: 'GAT', name: 'Gâteau', type: 'MANUFACTURED', basePrice: 20000 }).expect(201)).body.id;
    ids.flour = (await api(app, admin).post('/api/raw-materials').send({ code: 'FAR', name: 'Farine', baseUnitCode: 'KG', isPerishable: true }).expect(201)).body.id;
    const gma = (await api(app, admin).post('/api/suppliers').send({ code: 'GMA', name: 'Grands Moulins' }).expect(201)).body.id;
    const sol = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    const line = (item: object, qty: number, price: number) => ({ purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, receivedQuantity: qty, unitPrice: price, expiryDate: day(60), ...item });
    const receive = (u: Session, est: string, supplierId: string, items: object[], extra: object = {}) => as(u, est).post('/api/goods-receipts').send({ establishmentId: est, supplierId, items, ...extra }).expect(201);
    const r1 = (await receive(store, plt, sol, [line({ productId: ids.coca }, 20, 300)])).body;
    await receive(store, plt, gma, [line({ rawMaterialId: ids.flour }, 10, 700)]);
    await receive(store, plt, gma, [line({ rawMaterialId: ids.flour }, 5, 800)], { receivedAt: `${day(-1)}T15:00:00.000Z` });
    await receive(storeYop, yop, sol, [line({ productId: ids.coca }, 5, 300)]);
    const cocaLot = await prisma.stockLot.findFirstOrThrow({ where: { receiptItem: { receiptId: r1.id } } });
    await as(store).post('/api/supplier-returns').send({ establishmentId: plt, supplierId: sol, reason: 'Casse au transport', items: [{ lotId: cocaLot.id, quantity: 2 }] }).expect(201);

    // Production : P1 4 produits, P2 planifié.
    const r = await api(app, admin).post('/api/recipes').send({ productId: ids.cake, yieldQuantity: 1, shelfLifeDays: 3, items: [{ rawMaterialId: ids.flour, quantity: 500, unitCode: 'G' }] }).expect(201);
    await api(app, admin).post(`/api/recipe-versions/${r.body.versions[0].id}/activate`).expect(201);
    const p1 = (await as(manager).post('/api/production-orders').send({ establishmentId: plt, productId: ids.cake, plannedQuantity: 4 }).expect(201)).body.id;
    for (const st of ['validate', 'start']) await as(manager).post(`/api/production-orders/${p1}/${st}`).expect(201);
    await as(manager).post(`/api/production-orders/${p1}/complete`).send({ producedQuantity: 4 }).expect(201);
    await as(manager).post('/api/production-orders').send({ establishmentId: plt, productId: ids.cake, plannedQuantity: 2 }).expect(201);
    await as(store).put('/api/stock/thresholds').send({ establishmentId: plt, productId: ids.coca, minQuantity: 20, alertQuantity: 25 }).expect(200);

    // Caisse et ventes.
    const reg = async (u: Session, est: string, code: string) => (await as(u, est).post('/api/cash-registers').send({ establishmentId: est, code, name: `Caisse ${code}`, printerType: 'NONE' }).expect(201)).body.id;
    const [c1, c2, y1] = [await reg(manager, plt, 'C1'), await reg(manager, plt, 'C2'), await reg(managerYop, yop, 'Y1')];
    ids.sessCashier = (await as(cashier).post('/api/cash-sessions').send({ registerId: c1, openingFloat: 10000 }).expect(201)).body.id;
    ids.sessManager = (await as(manager).post('/api/cash-sessions').send({ registerId: c2, openingFloat: 10000 }).expect(201)).body.id;
    const sessYop = (await as(managerYop, yop).post('/api/cash-sessions').send({ registerId: y1, openingFloat: 0 }).expect(201)).body.id;
    const sell = async (u: Session, session: string, quantity: number, est = plt) =>
      (await as(u, est).post('/api/sales').send({ sessionId: session, lines: [{ productId: ids.coca, quantity }], payments: [{ method: 'CASH', amount: quantity * 500 }] }).expect(201)).body.sale;
    await sell(cashier, ids.sessCashier, 4);
    const t2 = await sell(cashier, ids.sessCashier, 2);
    await as(manager).post(`/api/sales/${t2.id}/refund`).send({ sessionId: ids.sessManager, reason: 'Bouteille cassée', lines: [{ saleItemId: t2.items[0].id, quantity: 1, disposition: 'RESTOCK' }] }).expect(201);
    await sell(managerYop, sessYop, 1, yop);

    // Client : facture manuelle 10 000 dont 4 000 par virement ; acompte 3 000.
    ids.customer = (await as(manager).post('/api/customers').send({ type: 'BUSINESS', name: 'Société Ivoire Events', paymentTermDays: 30 }).expect(201)).body.id;
    const d = (await as(manager).post('/api/invoices').send({ establishmentId: plt, source: 'MANUAL', customerId: ids.customer, lines: [{ kind: 'FEE', label: 'Service traiteur', quantity: 1, unitPrice: 10000 }] }).expect(201)).body;
    await as(manager).post(`/api/invoices/${d.id}/issue`).expect(201);
    await as(accountant).post(`/api/invoices/${d.id}/payments`).send({ method: 'BANK_TRANSFER', amount: 4000, reference: 'VIR-1' }).expect(201);
    await as(manager).post('/api/deposits').send({ establishmentId: plt, customerId: ids.customer, payment: { method: 'CASH', amount: 3000, sessionId: ids.sessManager } }).expect(201);

    // Clôture du caissier : −100 en espèces.
    const s = (await as(cashier).get(`/api/cash-sessions/${ids.sessCashier}`).expect(200)).body;
    const counts = s.expected.map((e: { method: string; amount: string }) => ({ method: e.method, counted: num(e.amount) - (e.method === 'CASH' ? 100 : 0) }));
    await as(cashier).post(`/api/cash-sessions/${ids.sessCashier}/close`).send({ counts }).expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Synthèse', () => {
    it('reprend exactement les indicateurs des étapes 1 à 4', async () => {
      const q = period();
      const [dash, revenue, sales, collections, rec, receivables, advances, purchases, stock, production, margin, cash] = await Promise.all(
        ['dashboard', 'revenue', 'sales', 'collections', 'reconciliation', 'receivables', 'advances', 'purchases', 'stock', 'production', 'margin', 'cash'].map((p) => get(p, manager, q)),
      );
      const s = dash.summary;
      expect([num(s.revenue.ttc), num(s.collections.total), num(s.revenueCollectionsGap)]).toEqual([12500, 9500, 3000]);
      expect(s.revenue.ttc).toBe(revenue.total.revenue);
      expect(s.revenue.ttc).toBe(sales.total.revenue);
      expect(s.collections.total).toBe(collections.total.total);
      expect(s.revenueCollectionsGap).toBe(rec.total.gap);
      expect([s.receivables.balance, s.receivables.overdue]).toEqual([receivables.total.open.balance, receivables.total.overdue.balance]);
      expect(s.advances.total).toBe(advances.total.closing.totalAdvances);
      expect([num(s.receivables.balance), num(s.advances.total)]).toEqual([6000, 3000]);
      expect([s.purchases.net, s.purchases.receipts]).toEqual([purchases.total.netPurchases, purchases.total.receipts.amount]);
      expect([num(s.purchases.receipts), num(s.purchases.returns), num(s.purchases.net)]).toEqual([13000, 600, 12400]);
      expect([s.stock.value, s.stock.belowThreshold, s.stock.outOfStock]).toEqual([stock.total.valuation.total, stock.total.items.belowThreshold, stock.total.items.outOfStock]);
      expect([s.production.produced, s.production.plannedQuantity, s.production.realizationRate]).toEqual([production.total.completed.producedQuantity, production.total.created.plannedQuantity, production.total.completed.realizationRate]);
      expect([s.production.produced, s.production.plannedQuantity, s.production.realizationRate]).toEqual([4, 6, 100]);
      expect([s.margin.grossMargin, s.margin.cogs, s.margin.rate]).toEqual([margin.total.goods.grossMargin, margin.total.goods.cogs, margin.total.goods.rate]);
      expect([s.cash.totalDifference, s.cash.sessionsWithDifference]).toEqual([cash.total.closures.totalDifference, cash.total.closures.sessionsWithDifference]);
      expect([num(s.cash.totalDifference), s.cash.sessionsWithDifference]).toEqual([-100, 1]);
    });

    it('consolide les établissements accessibles et isole les autres', async () => {
      const all = await get('dashboard', admin, period());
      expect(num(all.summary.revenue.ttc)).toBe(13000);
      expect(all.byEstablishment.map((e: Body) => [e.establishment.code, num(e.revenue), num(e.collections), num(e.netPurchases)])).toEqual([
        ['PLT', 12500, 9500, 12400],
        ['YOP', 500, 500, 1500],
      ]);
      const y = await get('dashboard', managerYop, period(), yop);
      expect([y.establishments.map((e: Body) => e.code), num(y.summary.revenue.ttc)]).toEqual([['YOP'], 500]);
      await api(app, managerYop, yop).get('/api/pilotage/dashboard').query({ ...period(), establishmentId: plt }).expect(403);
    });
  });

  describe('Contrôles', () => {
    it('affiche les rapprochements des étapes 1 à 4, tous cohérents', async () => {
      const c = (await get('dashboard', manager, period())).controls;
      expect([num(c.revenueVsCollections.residual), c.revenueVsCollections.consistent]).toEqual([0, true]);
      expect([num(c.revenueVsSales.revenue), num(c.revenueVsSales.sales), num(c.revenueVsSales.categories), num(c.revenueVsSales.margin), c.revenueVsSales.consistent]).toEqual([12500, 12500, 12500, 12500, true]);
      expect([num(c.receivablesAndAdvances.receivables), num(c.receivablesAndAdvances.advances), c.receivablesAndAdvances.consistent]).toEqual([6000, 3000, true]);
      expect([c.productionVsStock.completedOrders.orders, c.productionVsStock.completedOrders.producedQuantity, c.productionVsStock.completedOrders.stockMovementQuantity, c.productionVsStock.completedOrders.ordersWithMismatch, c.productionVsStock.consistent]).toEqual([1, 4, 4, 0, true]);
    });

    it('rend visible une réception déclarée le jour A et enregistrée en stock le jour B, sans changer les montants', async () => {
      const r2 = await prisma.goodsReceipt.findFirstOrThrow({ where: { receivedAt: { lt: new Date(`${today}T00:00:00.000Z`) } } });
      const mv = await prisma.stockMovement.findFirstOrThrow({ where: { originId: r2.id, type: 'RECEIPT' } });
      expect([r2.receivedAt.toISOString().slice(0, 10), mv.createdAt.toISOString().slice(0, 10)]).toEqual([day(-1), today]);

      // Jour B (aujourd'hui) : enregistrée dans la période, déclarée hors période ; achats sans elle, entrées de stock avec elle.
      const b = (await get('dashboard', manager, period())).controls.purchasesVsStock;
      expect([num(b.purchasesReceipts), num(b.stockReceiptMovements)]).toEqual([13000, 17000]);
      expect([b.bothInPeriod.count, num(b.bothInPeriod.receiptAmount)]).toEqual([2, 13000]);
      expect([b.recordedInPeriodDeclaredOutside.count, num(b.recordedInPeriodDeclaredOutside.receiptAmount), num(b.recordedInPeriodDeclaredOutside.stockMovementValue)]).toEqual([1, 4000, 4000]);
      expect([b.declaredInPeriodRecordedOutside.count, b.consistent]).toEqual([0, true]);
      // Jour A (hier) : déclarée dans la période, enregistrée hors période ; achats avec elle, aucune entrée de stock.
      const a = (await get('dashboard', manager, period(day(-1), day(-1)))).controls.purchasesVsStock;
      expect([num(a.purchasesReceipts), num(a.stockReceiptMovements), a.declaredInPeriodRecordedOutside.count, num(a.declaredInPeriodRecordedOutside.receiptAmount), a.bothInPeriod.count, a.consistent]).toEqual([4000, 0, 1, 4000, 0, true]);
      // Sur les deux jours, plus aucun décalage ; montants d'achats inchangés (étape 4).
      const ab = (await get('dashboard', manager, period(day(-1), today))).controls.purchasesVsStock;
      expect([ab.bothInPeriod.count, ab.recordedInPeriodDeclaredOutside.count, ab.declaredInPeriodRecordedOutside.count, num(ab.purchasesReceipts), num(ab.stockReceiptMovements)]).toEqual([3, 0, 0, 17000, 17000]);
      expect(num((await get('purchases', manager, period(day(-1), today))).total.receipts.amount)).toBe(17000);
    });
  });

  describe('Évolutions et classements', () => {
    it('ventile CA, encaissements, achats et marge par mois, sommes égales aux totaux', async () => {
      const q = period(day(-40), today);
      const [dash, purchases, margin] = await Promise.all([get('dashboard', manager, q), get('purchases', manager, q), get('margin', manager, q)]);
      const months = dash.trends.monthly as Body[];
      expect(months.length).toBeGreaterThanOrEqual(2);
      expect(months.map((m) => m.month)).toEqual([...new Set(months.map((m) => m.month))].sort());
      expect(months.reduce((a, m) => a + num(m.revenue), 0)).toBe(num(dash.summary.revenue.ttc));
      expect(months.reduce((a, m) => a + num(m.collections), 0)).toBe(num(dash.summary.collections.total));
      expect(months.reduce((a, m) => a + num(m.netPurchases), 0)).toBe(num(purchases.total.netPurchases));
      expect(months.reduce((a, m) => a + num(m.grossMargin), 0)).toBeCloseTo(num(margin.total.goods.grossMargin), 2);
      expect(months.at(-1)!.month).toBe(today.slice(0, 7));
    });

    it('donne les principaux catégories, produits, clients et fournisseurs', async () => {
      const t = (await get('dashboard', manager, period(day(-1), today))).top;
      expect(t.categories.map((c: Body) => [c.name, num(c.revenue)])).toEqual([['Frais et prestations', 10000], ['Boissons', 2500]]);
      expect(t.products.map((p: Body) => [p.code, num(p.revenue), p.quantity])).toEqual([['COCA', 2500, 5]]);
      expect(t.customersByReceivables.map((c: Body) => [c.customer.name, num(c.receivables)])).toEqual([['Société Ivoire Events', 6000]]);
      expect(t.customersByInvoicedRevenue.map((c: Body) => [c.customer.name, num(c.revenue)])).toEqual([['Société Ivoire Events', 10000]]);
      expect(t.suppliers.map((s: Body) => [s.supplier.code, num(s.netPurchases)])).toEqual([['GMA', 11000], ['SOL', 5400]]);
    });
  });

  describe('Exports', () => {
    it('exporte en JSON, sans fichier conservé, les mêmes données que les rapports', async () => {
      const q = period();
      for (const kind of ['dashboard', 'sales', 'purchases', 'stock', 'production']) {
        const res = await api(app, manager, plt).get(`/api/pilotage/export/${kind}`).query(q).expect(200);
        expect(res.headers['content-disposition']).toBe(`attachment; filename="pilotage-${kind}-${today}_${today}.json"`);
        expect([res.body.export, res.body.format, res.body.filters.from, res.body.filters.to, res.body.filters.establishmentIds]).toEqual([kind, 'json', today, today, [plt]]);
      }
      const sales = (await api(app, manager, plt).get('/api/pilotage/export/sales').query(q).expect(200)).body.data;
      expect([sales.sales.total.revenue, sales.categories.total, sales.margin.total.goods.grossMargin]).toEqual([
        (await get('sales', manager, q)).total.revenue,
        (await get('sales/categories', manager, q)).total,
        (await get('margin', manager, q)).total.goods.grossMargin,
      ]);
      const stock = (await api(app, manager, plt).get('/api/pilotage/export/stock').query(q).expect(200)).body.data;
      expect(stock.stock.total).toEqual((await get('stock', manager, q)).total);
      const prod = (await api(app, manager, plt).get('/api/pilotage/export/production').query(q).expect(200)).body.data;
      expect(prod.production.total).toEqual((await get('production', manager, q)).total);
      const pur = (await api(app, manager, plt).get('/api/pilotage/export/purchases').query(q).expect(200)).body.data;
      expect(pur.purchases.total).toEqual((await get('purchases', manager, q)).total);
    });
  });

  describe('Droits, périodes et lecture seule', () => {
    it('exige dashboard.view, masque les détails sans permission métier, et protège les exports', async () => {
      await api(app, cashier, plt).get('/api/pilotage/dashboard').query(period()).expect(403);
      const v = await get('dashboard', viewer, period());
      expect([num(v.summary.revenue.ttc), v.summary.margin.available, v.top.categories.available, v.top.customersByReceivables.available, v.top.suppliers.available, v.trends.marginAvailable]).toEqual([12500, false, false, false, false, false]);
      expect(v.trends.monthly[0].grossMargin).toBeNull();
      await api(app, viewer, plt).get('/api/pilotage/export/dashboard').query(period()).expect(200);
      for (const kind of ['sales', 'purchases', 'stock', 'production']) await api(app, viewer, plt).get(`/api/pilotage/export/${kind}`).query(period()).expect(403);
      for (const kind of ['dashboard', 'sales']) await api(app, cashier, plt).get(`/api/pilotage/export/${kind}`).query(period()).expect(403);
    });

    it('respecte la période maximale et les bornes', async () => {
      await api(app, manager, plt).get('/api/pilotage/dashboard').query(period(day(-366), today)).expect(400);
      await api(app, manager, plt).get('/api/pilotage/export/sales').query(period(day(-366), today)).expect(400);
      expect((await api(app, manager, plt).get('/api/pilotage/dashboard').query(period(day(-365), today)).expect(200)).body.trends.monthly.length).toBeGreaterThanOrEqual(12);
      const tomorrow = await get('dashboard', manager, period(day(1), day(1)));
      expect([num(tomorrow.summary.revenue.ttc), num(tomorrow.summary.collections.total), num(tomorrow.summary.purchases.net), tomorrow.summary.production.produced]).toEqual([0, 0, 0, 0]);
    });

    it('n’écrit rien', async () => {
      const before = await writes();
      await get('dashboard', admin, period(day(-60), today));
      for (const kind of ['dashboard', 'sales', 'purchases', 'stock', 'production']) await api(app, admin).get(`/api/pilotage/export/${kind}`).query(period(day(-60), today)).expect(200);
      expect(await writes()).toEqual(before);
    });
  });
});
