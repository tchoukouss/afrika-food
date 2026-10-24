import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const num = (v: unknown) => Number(v);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Module 8 — Étape 4 : achats, stock, production.
 *
 * Pâtisserie Plateau (PLT) :
 *   réceptions : R1 (GMA) farine 20 kg × 700 + sucre 10 kg × 500 = 19 000 ; R2 (SOL) coca 12 × 300 = 3 600 ;
 *                R3 (GMA) farine 5 kg × 800 = 4 000, datée d'hier ; retour de 2 kg de farine de R1 = 1 400
 *   corrections : sucre +2 kg à 450 (coût déclaré), sucre +1 kg à 0 (non valorisé)
 *   production (gâteau : 500 g de farine) :
 *     P1 4 prévus → 3 produits (perte 1), contrôle : 1 non conforme → contrôlé
 *     P2 2 prévus → validé puis annulé ; P3 5 prévus → planifié ; P4 2 prévus → en cours
 *   commandes : 8 cocas réservés (non sortis) ; 1 gâteau livré (sortie CUSTOMER_DELIVERY)
 *   seuils : farine 25/30 (critique), coca 2/5 (alerte), gâteau 0/0 (OK), jus 1/3 sans stock (rupture) ; sucre sans seuil
 * Restaurant Yopougon (YOP) : coca 10 × 300 = 3 000.
 */
describe('Module 8 — Étape 4 : achats, stock et production', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User;
  let manager2: User;
  let store: User;
  let cashier: User;
  let managerYop: User;
  let viewer: User;
  let plt: string;
  let yop: string;
  const ids: Record<string, string> = {};
  const today = day(0);

  const as = (u: Session, est = plt) => api(app, u, est);
  const kpi = (path: string, u: Session, query: Record<string, string>, est?: string) => api(app, u, est).get(`/api/pilotage/${path}`).query(query);
  const period = (from = today, to = today) => ({ from, to });
  const writes = async () =>
    Promise.all([
      prisma.goodsReceipt.count(), prisma.supplierReturn.count(), prisma.stockMovement.count(), prisma.stockBalance.count(), prisma.stockLot.count(),
      prisma.stockThreshold.count(), prisma.productionOrder.count(), prisma.productionOutput.count(), prisma.productionLoss.count(), prisma.orderReservation.count(), prisma.auditLog.count(),
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
    manager2 = await user('resp2@test.ci', 'MANAGER', plt);
    store = await user('mag@test.ci', 'STOREKEEPER', plt);
    cashier = await user('caisse@test.ci', 'CASHIER', plt);
    managerYop = await user('respyop@test.ci', 'MANAGER', yop);
    viewer = await user('direction@test.ci', 'VIEWER', plt);
    const storeYop = await user('magyop@test.ci', 'STOREKEEPER', yop);

    const raw = async (code: string, name: string) => (await api(app, admin).post('/api/raw-materials').send({ code, name, baseUnitCode: 'KG', isPerishable: true }).expect(201)).body.id;
    ids.flour = await raw('FAR', 'Farine');
    ids.sugar = await raw('SUC', 'Sucre');
    const product = async (code: string, name: string, type: string) => (await api(app, admin).post('/api/products').send({ code, name, type, basePrice: 1000 }).expect(201)).body.id;
    ids.coca = await product('COCA', 'Coca 33 cl', 'RESOLD');
    ids.jus = await product('BISS', 'Jus de bissap', 'RESOLD');
    ids.cake = await product('GAT', 'Gâteau', 'MANUFACTURED');
    ids.gma = (await api(app, admin).post('/api/suppliers').send({ code: 'GMA', name: 'Grands Moulins' }).expect(201)).body.id;
    ids.sol = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;

    // Réceptions et retour.
    const line = (item: object, qty: number, price: number, expiry: number) => ({ purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, receivedQuantity: qty, unitPrice: price, expiryDate: day(expiry), ...item });
    const receive = (u: Session, est: string, supplierId: string, items: object[], extra: object = {}) => as(u, est).post('/api/goods-receipts').send({ establishmentId: est, supplierId, items, ...extra }).expect(201);
    const r1 = (await receive(store, plt, ids.gma, [line({ rawMaterialId: ids.flour }, 20, 700, 60), line({ rawMaterialId: ids.sugar }, 10, 500, 120)])).body;
    await receive(store, plt, ids.sol, [line({ productId: ids.coca }, 12, 300, 90)]);
    await receive(store, plt, ids.gma, [line({ rawMaterialId: ids.flour }, 5, 800, 90)], { receivedAt: `${day(-1)}T15:00:00.000Z` });
    await receive(storeYop, yop, ids.sol, [line({ productId: ids.coca }, 10, 300, 90)]);
    const flourLot = await prisma.stockLot.findFirstOrThrow({ where: { receiptItem: { receiptId: r1.id }, rawMaterialId: ids.flour } });
    await as(store).post('/api/supplier-returns').send({ establishmentId: plt, supplierId: ids.gma, reason: 'Farine humide', items: [{ lotId: flourLot.id, quantity: 2 }] }).expect(201);

    // Corrections d'entrée : coût déclaré, puis coût nul (non valorisable).
    for (const unitCost of [450, 0]) {
      const adj = (await as(store).post('/api/stock-adjustments').send({ establishmentId: plt, rawMaterialId: ids.sugar, direction: 'IN', quantity: unitCost ? 2 : 1, unitCost, reason: 'Sac retrouvé en réserve' }).expect(201)).body;
      await as(manager).post(`/api/stock-adjustments/${adj.id}/approve`).send({ note: 'OK' }).expect(201);
    }

    // Production.
    const r = await api(app, admin).post('/api/recipes').send({ productId: ids.cake, yieldQuantity: 1, shelfLifeDays: 3, items: [{ rawMaterialId: ids.flour, quantity: 500, unitCode: 'G' }] }).expect(201);
    await api(app, admin).post(`/api/recipe-versions/${r.body.versions[0].id}/activate`).expect(201);
    const po = async (plannedQuantity: number) => (await as(manager).post('/api/production-orders').send({ establishmentId: plt, productId: ids.cake, plannedQuantity }).expect(201)).body.id as string;
    const step = (id: string, s: string, body: object = {}, u: Session = manager) => as(u).post(`/api/production-orders/${id}/${s}`).send(body).expect(201);
    ids.p1 = await po(4);
    await step(ids.p1, 'validate');
    await step(ids.p1, 'start');
    await step(ids.p1, 'complete', { producedQuantity: 3, lossCause: 'BURNT', lossReason: 'Four trop chaud' });
    await step(ids.p1, 'control', { nonConformQuantity: 1, cause: 'QUALITY', reason: 'Gâteau fendu' }, manager2);
    const p2 = await po(2);
    await step(p2, 'validate');
    await step(p2, 'cancel', { reason: 'Commande annulée' });
    await po(5);
    const p4 = await po(2);
    await step(p4, 'validate');
    await step(p4, 'start');

    // Commandes : 8 cocas réservés ; 1 gâteau livré.
    ids.customer = (await as(manager).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Awa Koné' }).expect(201)).body.id;
    const order = async (productId: string, quantity: number) => {
      const o = (await as(manager).post('/api/customer-orders').send({ establishmentId: plt, customerId: ids.customer, lines: [{ kind: 'PRODUCT', productId, quantity }] }).expect(201)).body.id;
      await as(manager).post(`/api/customer-orders/${o}/status`).send({ status: 'CONFIRMED' }).expect(201);
      return o as string;
    };
    await order(ids.coca, 8);
    const o2 = await order(ids.cake, 1);
    for (const st of ['IN_PREPARATION', 'READY']) await as(manager).post(`/api/customer-orders/${o2}/status`).send({ status: st }).expect(201);
    await as(manager).post(`/api/customer-orders/${o2}/hand-over`).expect(201);

    // Seuils.
    const threshold = (item: object, minQuantity: number, alertQuantity: number) => as(store).put('/api/stock/thresholds').send({ establishmentId: plt, ...item, minQuantity, alertQuantity }).expect(200);
    await threshold({ rawMaterialId: ids.flour }, 25, 30);
    await threshold({ productId: ids.coca }, 2, 5);
    await threshold({ productId: ids.cake }, 0, 0);
    await threshold({ productId: ids.jus }, 1, 3);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Achats', () => {
    it('calcule réceptions − retours à leur date, par établissement, mois et fournisseur', async () => {
      const p = (await kpi('purchases', manager, period()).expect(200)).body.total;
      expect([num(p.receipts.amount), p.receipts.count, num(p.returns.amount), p.returns.count, num(p.netPurchases)]).toEqual([22600, 2, 1400, 1, 21200]);
      const y = (await kpi('purchases', manager, period(day(-1), day(-1))).expect(200)).body.total;
      expect([num(y.receipts.amount), y.receipts.count, num(y.returns.amount)]).toEqual([4000, 1, 0]);
      const both = (await kpi('purchases', manager, period(day(-1), today)).expect(200)).body;
      expect(num(both.total.netPurchases)).toBe(25200);
      expect(both.byMonth.reduce((a: number, m: { netPurchases: string }) => a + num(m.netPurchases), 0)).toBe(25200);
      const s = (await kpi('purchases/suppliers', manager, period(day(-1), today)).expect(200)).body.suppliers;
      expect(s.map((x: { supplier: { code: string }; receipts: { amount: string }; returns: { amount: string }; netPurchases: string }) => [x.supplier.code, num(x.receipts.amount), num(x.returns.amount), num(x.netPurchases)])).toEqual([
        ['GMA', 23000, 1400, 21600],
        ['SOL', 3600, 0, 3600],
      ]);
      // Cohérence module 3 : mêmes montants que les mouvements de réception et de retour.
      const mv = await prisma.stockMovement.groupBy({ by: ['type'], where: { establishmentId: plt, type: { in: ['RECEIPT', 'SUPPLIER_RETURN'] } }, _sum: { value: true } });
      expect(mv.map((m) => [m.type, num(m._sum.value)]).sort()).toEqual([['RECEIPT', 26600], ['SUPPLIER_RETURN', -1400]]);
    });

    it('consolide les établissements accessibles et isole les autres', async () => {
      const all = (await kpi('purchases', admin, period()).expect(200)).body;
      expect([num(all.total.receipts.amount), all.byEstablishment.map((e: { establishment: { code: string }; netPurchases: string }) => [e.establishment.code, num(e.netPurchases)])]).toEqual([25600, [['PLT', 21200], ['YOP', 3000]]]);
      await kpi('purchases', managerYop, { ...period(), establishmentId: plt }).expect(403);
      expect(num((await kpi('purchases', managerYop, period(), yop).expect(200)).body.total.netPurchases)).toBe(3000);
    });
  });

  describe('Stock', () => {
    it('reprend l’état du module 3 : disponible, réservé, seuils, ruptures, sans statut pour un article sans seuil', async () => {
      const st = (await kpi('stock', manager, period()).expect(200)).body.total;
      expect(st.items).toEqual({ inStock: 4, withReservedStock: 1, withThreshold: 4, withoutThreshold: 1, status: { ok: 1, alert: 1, critical: 2 }, outOfStock: 1, belowThreshold: 3 });
      expect(st.quantities).toEqual([
        { kind: 'PRODUCT', unit: 'U', quantity: 13, reserved: 8, expired: 0, available: 5 },
        { kind: 'RAW_MATERIAL', unit: 'KG', quantity: 33, reserved: 0, expired: 0, available: 33 },
      ]);
      const alerts = (await kpi('stock/alerts', manager, period()).expect(200)).body.items;
      expect(alerts.map((a: { code: string; status: string; available: number; outOfStock: boolean }) => [a.code, a.status, a.available, a.outOfStock])).toEqual([
        ['BISS', 'CRITICAL', 0, true],
        ['FAR', 'CRITICAL', 20, false],
        ['COCA', 'ALERT', 4, false],
      ]);
      // Même statut que l'état de stock du module 3 pour chaque article.
      const m3 = (await as(manager).get('/api/stock/items').query({ establishmentId: plt }).expect(200)).body as { item: { code: string }; status: string; value: string; reserved: string }[];
      expect(Object.fromEntries(m3.map((i) => [i.item.code, i.status]))).toEqual({ BISS: 'CRITICAL', COCA: 'ALERT', FAR: 'CRITICAL', GAT: 'OK', SUC: 'NONE' });
      expect(num(st.valuation.total)).toBe(m3.reduce((a, i) => a + num(i.value), 0));
    });

    it('valorise au coût des lots en séparant coût réel, coût déclaré et lots non valorisés', async () => {
      const v = (await kpi('stock', manager, period()).expect(200)).body.total.valuation;
      // Réel : farine 15 × 700 + 5 × 800, sucre 10 × 500, coca 12 × 300, gâteau 1 × (1 400 / 3) ; déclaré : sucre 2 × 450.
      expect([num(v.realCost), num(v.declaredCost), v.notValued.lots, num(v.total), num(v.expired)]).toEqual([23567, 900, 1, 24467, 0]);
    });

    it('ventile les mouvements de la période : la livraison est une sortie, jamais un achat ni une production', async () => {
      const mv = (await kpi('stock', manager, period()).expect(200)).body.total.movements.byType as { type: string; value: string; count: number }[];
      const by = Object.fromEntries(mv.map((m) => [m.type, num(m.value)]));
      expect([by.RECEIPT, by.SUPPLIER_RETURN, by.ADJUSTMENT_IN]).toEqual([26600, -1400, 900]);
      expect(by.CUSTOMER_DELIVERY).toBeCloseTo(-466.67, 2);
      expect(by.PRODUCTION).toBeCloseTo(1400, 1);
      // Les réservations ne sont pas des sorties : 8 cocas réservés, aucun mouvement de sortie pour eux.
      expect(await prisma.stockMovement.count({ where: { productId: ids.coca, quantity: { lt: 0 } } })).toBe(0);
    });
  });

  describe('Production', () => {
    it('compte ordres, statuts à la fin de la période, quantités, pertes et taux de réalisation', async () => {
      const p = (await kpi('production', manager, period()).expect(200)).body.total;
      expect([p.created.count, p.created.plannedQuantity, p.completed.count, p.completed.plannedQuantity, p.completed.producedQuantity, p.completed.realizationRate, p.cancelled, p.inProgressAtEnd]).toEqual([4, 13, 1, 4, 3, 75, 1, 2]);
      expect(p.statusAtEnd).toEqual({ PLANNED: 1, VALIDATED: 0, IN_PROGRESS: 1, COMPLETED: 0, CONTROLLED: 1, CANCELLED: 1 });
      expect([p.outputs.quantity, p.losses.completion.quantity, p.losses.control.quantity]).toEqual([3, 1, 1]);
      expect(num(p.outputs.value)).toBeCloseTo(1400, 1);
      // Cohérence module 4 : sorties de production et ordres tels qu'enregistrés.
      const outputs = await prisma.productionOutput.aggregate({ _sum: { quantity: true } });
      expect(num(outputs._sum.quantity)).toBe(p.outputs.quantity);
      const byStatus = await prisma.productionOrder.groupBy({ by: ['status'], _count: true });
      expect(Object.fromEntries(byStatus.map((b) => [b.status, b._count]))).toEqual({ PLANNED: 1, IN_PROGRESS: 1, CONTROLLED: 1, CANCELLED: 1 });
      const d = (await kpi('production/products', manager, period()).expect(200)).body.products;
      expect(d.map((x: { product: { code: string }; created: { count: number }; outputs: { quantity: number } }) => [x.product.code, x.created.count, x.outputs.quantity])).toEqual([['GAT', 4, 3]]);
    });

    it('reconstitue les statuts à une date passée', async () => {
      const y = (await kpi('production', manager, period(day(-1), day(-1))).expect(200)).body.total;
      expect([y.created.count, y.completed.count, y.inProgressAtEnd, y.outputs.quantity]).toEqual([0, 0, 0, 0]);
      expect(Object.values(y.statusAtEnd).every((n) => n === 0)).toBe(true);
    });
  });

  describe('Droits et lecture seule', () => {
    it('exige dashboard.view pour les synthèses et reports.view + permission métier pour les détails', async () => {
      for (const path of ['purchases', 'stock', 'production', 'purchases/suppliers', 'stock/alerts', 'production/products']) await kpi(path, cashier, period()).expect(403);
      for (const path of ['purchases', 'stock', 'production']) await kpi(path, viewer, period()).expect(200);
      for (const path of ['purchases/suppliers', 'stock/alerts', 'production/products']) await kpi(path, viewer, period()).expect(403);
      await kpi('stock', managerYop, period(), plt).expect(403);
      await kpi('production', manager, period(day(-366), today)).expect(400);
    });

    it('n’écrit rien', async () => {
      const before = await writes();
      for (const path of ['purchases', 'purchases/suppliers', 'stock', 'stock/alerts', 'production', 'production/products']) await kpi(path, admin, period(day(-30), today)).expect(200);
      expect(await writes()).toEqual(before);
    });
  });
});
