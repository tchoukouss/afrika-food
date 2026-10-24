import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v);

describe('Module 7 — Étape 3 : réservations, fabrication à la demande et livraisons', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User; // Responsable Plateau : commandes, production, livraisons
  let store: User; // Magasinier Plateau : pertes de stock
  let cashier: User; // Caissier Plateau : consulte seulement
  let driver: User; // Livreur Plateau
  let driver2: User; // Autre livreur Plateau
  let driverYop: User; // Livreur Yopougon
  let plateau: string;
  let yopougon: string;
  const ids: Record<string, string> = {};

  const order = async (lines: object[]) =>
    (await api(app, manager, plateau).post('/api/customer-orders').send({ establishmentId: plateau, customerId: ids.customer, lines }).expect(201)).body as { id: string; lines: { id: string }[] };
  const status = (id: string, s: string, u: Session = manager) => api(app, u, plateau).post(`/api/customer-orders/${id}/status`).send({ status: s });
  const advance = async (id: string, steps: string[]) => {
    for (const s of steps) await status(id, s).expect(201);
  };
  const free = async (productId: string) => {
    const b = await prisma.stockBalance.aggregate({ where: { productId, establishmentId: plateau }, _sum: { quantity: true, reservedQuantity: true } });
    return { quantity: num(b._sum.quantity ?? 0), reserved: num(b._sum.reservedQuantity ?? 0) };
  };
  const reservations = async (orderId: string) => {
    const rows = await prisma.orderReservation.findMany({ where: { line: { orderId }, releasedAt: null } });
    const lots = await prisma.stockLot.findMany({ where: { id: { in: rows.map((r) => r.lotId) } } });
    return rows.map((r) => ({ ...r, lot: lots.find((l) => l.id === r.lotId)! }));
  };
  const loss = (productId: string, quantity: number, lotId?: string) =>
    api(app, store, plateau).post('/api/stock-losses').send({ establishmentId: plateau, productId, quantity, lotId, cause: 'BROKEN' });
  const delivery = (orderId: string, body: object = {}) =>
    api(app, manager, plateau).post(`/api/customer-orders/${orderId}/deliveries`).send({ address: 'Cocody Riviera 3, villa 12', driverId: driver.id, ...body });
  const deliveryStatus = (id: string, s: string, u: Session = manager, reason?: string) => api(app, u, plateau).post(`/api/deliveries/${id}/status`).send({ status: s, reason });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', plateau);
    store = await user('mag@test.ci', 'STOREKEEPER', plateau);
    cashier = await user('caisse@test.ci', 'CASHIER', plateau);
    driver = await user('livreur@test.ci', 'DELIVERY', plateau);
    driver2 = await user('livreur2@test.ci', 'DELIVERY', plateau);
    driverYop = await user('livreuryop@test.ci', 'DELIVERY', yopougon);

    const product = async (code: string, name: string, type: string, extra: object = {}) => (await api(app, admin).post('/api/products').send({ code, name, type, ...extra }).expect(201)).body.id;
    ids.coca = await product('COCA', 'Coca 33 cl', 'RESOLD', { basePrice: 500 });
    ids.jus = await product('BISS', 'Jus de bissap', 'RESOLD', { basePrice: 700 });
    ids.cake = await product('GAT', 'Gâteau d’anniversaire', 'MANUFACTURED', { basePrice: 20000 });
    ids.menu = await product('FORM', 'Formule goûter', 'MENU', { basePrice: 1000, components: [{ productId: ids.coca, quantity: 1 }, { productId: ids.jus, quantity: 1 }] });
    ids.flour = (await api(app, admin).post('/api/raw-materials').send({ code: 'FAR', name: 'Farine', baseUnitCode: 'KG', isPerishable: true }).expect(201)).body.id;
    const r = await api(app, admin).post('/api/recipes').send({ productId: ids.cake, yieldQuantity: 1, shelfLifeDays: 2, items: [{ rawMaterialId: ids.flour, quantity: 500, unitCode: 'G' }] }).expect(201);
    await api(app, admin).post(`/api/recipe-versions/${r.body.versions[0].id}/activate`).expect(201);

    // Deux lots de coca : le plus tardif reçu d'abord, pour distinguer FEFO de « premier arrivé ».
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    const receive = (item: object) =>
      api(app, store, plateau).post('/api/goods-receipts').send({ establishmentId: plateau, supplierId: supplier, items: [{ purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, ...item }] }).expect(201);
    await receive({ productId: ids.coca, receivedQuantity: 20, unitPrice: 300, expiryDate: inDays(60) });
    await receive({ productId: ids.coca, receivedQuantity: 10, unitPrice: 320, expiryDate: inDays(10) });
    await receive({ productId: ids.jus, receivedQuantity: 10, unitPrice: 400, expiryDate: inDays(30) });
    await receive({ rawMaterialId: ids.flour, receivedQuantity: 50, unitPrice: 700, expiryDate: inDays(60) });
    const lots = await prisma.stockLot.findMany({ where: { productId: ids.coca }, orderBy: { expiryDate: 'asc' } });
    [ids.lotSoon, ids.lotLate] = lots.map((l) => l.id);
    ids.customer = (await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Awa Koné', phone: '0707070707' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Réservations', () => {
    it('réserve à la confirmation selon FEFO, jamais les frais', async () => {
      const o = await order([
        { kind: 'PRODUCT', productId: ids.coca, quantity: 12 },
        { kind: 'FEE', label: 'Frais de livraison', quantity: 1, unitPrice: 1500 },
      ]);
      expect(await reservations(o.id)).toHaveLength(0); // brouillon : rien de réservé
      await status(o.id, 'CONFIRMED').expect(201);
      const r = await reservations(o.id);
      expect(r.map((x) => [x.lotId, num(x.quantity)]).sort()).toEqual([[ids.lotLate, 2], [ids.lotSoon, 10]].sort());
      expect(r.every((x) => x.orderLineId === o.lines[0].id)).toBe(true);
      expect(await free(ids.coca)).toEqual({ quantity: 30, reserved: 12 });
      expect(await prisma.auditLog.count({ where: { action: 'CUSTOMER_ORDER_RESERVED', entityId: o.id } })).toBe(1);
      ids.order1 = o.id;
    });

    it('protège le stock réservé contre toute autre sortie', async () => {
      await loss(ids.coca, 1, ids.lotSoon).expect(409); // lot entièrement réservé
      await loss(ids.coca, 19).expect(409); // libre : 18
      await loss(ids.coca, 1).expect(201);
      expect(await free(ids.coca)).toEqual({ quantity: 29, reserved: 12 });
    });

    it('refuse toute la confirmation si un article manque, et décompose les menus', async () => {
      const o = await order([
        { kind: 'PRODUCT', productId: ids.coca, quantity: 5 },
        { kind: 'PRODUCT', productId: ids.jus, quantity: 11 },
      ]);
      const res = await status(o.id, 'CONFIRMED').expect(409);
      expect(res.body.message).toMatch(/Jus de bissap.*manque 1/);
      expect(await reservations(o.id)).toHaveLength(0);
      expect((await api(app, manager, plateau).get(`/api/customer-orders/${o.id}`).expect(200)).body.status).toBe('DRAFT');
      expect(await free(ids.coca)).toEqual({ quantity: 29, reserved: 12 });

      const menu = await order([{ kind: 'PRODUCT', productId: ids.menu, quantity: 2 }]);
      await status(menu.id, 'CONFIRMED').expect(201);
      const r = await reservations(menu.id);
      expect(r.map((x) => [x.lot.productId, num(x.quantity)]).sort()).toEqual([[ids.coca, 2], [ids.jus, 2]].sort());
      expect(await free(ids.coca)).toEqual({ quantity: 29, reserved: 14 });
      ids.menuOrder = menu.id;
    });

    it('ne réserve pas deux fois le même stock en confirmations simultanées, et libère à l’annulation', async () => {
      // Libre : 29 − 14 = 15 cocas ; deux commandes de 10.
      const a = await order([{ kind: 'PRODUCT', productId: ids.coca, quantity: 10 }]);
      const b = await order([{ kind: 'PRODUCT', productId: ids.coca, quantity: 10 }]);
      const res = await Promise.all([status(a.id, 'CONFIRMED'), status(b.id, 'CONFIRMED')]);
      expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
      expect(await free(ids.coca)).toEqual({ quantity: 29, reserved: 24 });
      const won = res[0].status === 201 ? a.id : b.id;

      const c = (await api(app, manager, plateau).post(`/api/customer-orders/${won}/cancel`).send({ reason: 'Client injoignable' }).expect(201)).body;
      expect(c.status).toBe('CANCELLED');
      expect(await reservations(won)).toHaveLength(0);
      expect(await prisma.orderReservation.count({ where: { line: { orderId: won }, releasedAt: { not: null } } })).toBeGreaterThan(0);
      expect(await free(ids.coca)).toEqual({ quantity: 29, reserved: 14 });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'CUSTOMER_ORDER_CANCELLED', entityId: won } });
      expect((audit.newValues as { releasedReservations: number }).releasedReservations).toBeGreaterThan(0);
    });
  });

  describe('Fabrication à la demande', () => {
    it('lance la production par le module 4 et réserve le lot fini dans la transaction de fin', async () => {
      const o = await order([
        { kind: 'PRODUCT', productId: ids.cake, quantity: 3, madeToOrder: true },
        { kind: 'PRODUCT', productId: ids.coca, quantity: 1 },
      ]);
      await api(app, manager, plateau).post('/api/customer-orders').send({ establishmentId: plateau, customerId: ids.customer, lines: [{ kind: 'PRODUCT', productId: ids.coca, quantity: 1, madeToOrder: true }] }).expect(400);
      const cakeLine = o.lines[0].id;
      const launch = (u: Session = manager) => api(app, u, plateau).post(`/api/customer-orders/${o.id}/lines/${cakeLine}/production`);
      await launch().expect(409); // brouillon
      await status(o.id, 'CONFIRMED').expect(201);
      expect((await reservations(o.id)).map((r) => r.lot.productId)).toEqual([ids.coca]); // le gâteau n'est pas pris en stock
      await launch(cashier).expect(403);
      await api(app, manager, plateau).post(`/api/customer-orders/${o.id}/lines/${o.lines[1].id}/production`).expect(400);
      const p = (await launch().expect(201)).body;
      expect((await launch().expect(201)).body.id).toBe(p.id); // relance : même ordre
      expect(await prisma.productionOrder.count({ where: { productId: ids.cake } })).toBe(1);
      expect((await prisma.customerOrderLine.findUniqueOrThrow({ where: { id: cakeLine } })).productionOrderId).toBe(p.id);

      await advance(o.id, ['IN_PREPARATION', 'READY']);
      expect((await api(app, manager, plateau).post(`/api/customer-orders/${o.id}/hand-over`).expect(409)).body.message).toMatch(/production pas encore terminée/);

      for (const step of ['validate', 'start']) await api(app, manager, plateau).post(`/api/production-orders/${p.id}/${step}`).expect(201);
      await api(app, manager, plateau).post(`/api/production-orders/${p.id}/complete`).send({ producedQuantity: 3 }).expect(201);
      const output = await prisma.productionOutput.findFirstOrThrow({ where: { orderId: p.id } });
      const cakeRes = (await reservations(o.id)).find((r) => r.lot.productId === ids.cake)!;
      expect([cakeRes.lotId, cakeRes.orderLineId, num(cakeRes.quantity)]).toEqual([output.lotId, cakeLine, 3]);
      expect(await free(ids.cake)).toEqual({ quantity: 3, reserved: 3 });
      await loss(ids.cake, 1).expect(409); // lot fini réservé, jamais vendable entre-temps

      // Remise : une seule sortie CUSTOMER_DELIVERY par lot réservé.
      const before = await prisma.stockMovement.count();
      const done = (await api(app, manager, plateau).post(`/api/customer-orders/${o.id}/hand-over`).expect(201)).body;
      expect(done.status).toBe('DELIVERED');
      const moves = await prisma.stockMovement.findMany({ where: { type: 'CUSTOMER_DELIVERY', originId: o.id } });
      expect(moves.map((m) => [m.productId, num(m.quantity)]).sort()).toEqual([[ids.cake, -3], [ids.coca, -1]].sort());
      expect(await prisma.stockMovement.count()).toBe(before + 2);
      expect(await free(ids.cake)).toEqual({ quantity: 0, reserved: 0 });
      expect(await reservations(o.id)).toHaveLength(0);
      expect(await prisma.customerOrderLineIssue.count({ where: { line: { orderId: o.id }, deliveryId: null } })).toBe(2);
      expect(done.lines.map((l: { deliveredQuantity: string }) => num(l.deliveredQuantity))).toEqual([3, 1]);
      await api(app, manager, plateau).post(`/api/customer-orders/${o.id}/hand-over`).expect(409);
      expect(await prisma.stockMovement.count()).toBe(before + 2);
    });

    it('laisse le lot libre si la commande est annulée avant la fin de production', async () => {
      const o = await order([{ kind: 'PRODUCT', productId: ids.cake, quantity: 2, madeToOrder: true }]);
      await status(o.id, 'CONFIRMED').expect(201);
      const p = (await api(app, manager, plateau).post(`/api/customer-orders/${o.id}/lines/${o.lines[0].id}/production`).expect(201)).body;
      for (const step of ['validate', 'start']) await api(app, manager, plateau).post(`/api/production-orders/${p.id}/${step}`).expect(201);
      await api(app, manager, plateau).post(`/api/customer-orders/${o.id}/cancel`).send({ reason: 'Fête annulée' }).expect(201);
      await api(app, manager, plateau).post(`/api/production-orders/${p.id}/complete`).send({ producedQuantity: 2 }).expect(201);
      expect(await free(ids.cake)).toEqual({ quantity: 2, reserved: 0 });
    });
  });

  describe('Livraisons', () => {
    it('suit le circuit à préparer → prête → en cours → livrée, avec une seule sortie de stock', async () => {
      const o = ids.order1; // 12 cocas réservés + frais
      await status(o, 'IN_PREPARATION').expect(201);
      await delivery(o, { driverId: driverYop.id }).expect(400); // livreur d'un autre établissement
      await delivery(o, { driverId: cashier.id }).expect(400); // pas livreur
      await api(app, cashier, plateau).post(`/api/customer-orders/${o}/deliveries`).send({ address: 'Cocody' }).expect(403);
      const d = (await delivery(o, { fee: 1500, feeLabel: 'Livraison Cocody', scheduledAt: `${inDays(1)}T12:00:00.000Z` }).expect(201)).body;
      expect([d.status, d.number.startsWith('PLT-BL-'), num(d.fee), d.driver]).toEqual(['TO_PREPARE', true, 1500, 'livreur']);
      await delivery(o).expect(409); // une seule livraison active

      // Le livreur ne voit que ses livraisons.
      expect((await api(app, driver, plateau).get('/api/deliveries').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([d.id]);
      expect((await api(app, driver2, plateau).get('/api/deliveries').expect(200)).body).toHaveLength(0);
      await api(app, driver2, plateau).get(`/api/deliveries/${d.id}`).expect(404);
      await api(app, driverYop, yopougon).get(`/api/deliveries/${d.id}`).expect(404);

      await deliveryStatus(d.id, 'READY', driver).expect(403); // la préparation revient au responsable
      await deliveryStatus(d.id, 'READY').expect(409); // commande pas encore prête
      await status(o, 'READY').expect(201);
      await deliveryStatus(d.id, 'READY').expect(201);
      await api(app, manager, plateau).post(`/api/customer-orders/${o}/hand-over`).expect(409); // la sortie se fera à la livraison
      await deliveryStatus(d.id, 'DELIVERED', driver).expect(409); // pas encore partie
      await deliveryStatus(d.id, 'OUT', driver2).expect(404);
      await deliveryStatus(d.id, 'OUT', driver).expect(201);
      await api(app, manager, plateau).post(`/api/customer-orders/${o}/cancel`).send({ reason: 'Trop tard' }).expect(409); // livraison en cours

      const before = { coca: await free(ids.coca), moves: await prisma.stockMovement.count() };
      const done = (await deliveryStatus(d.id, 'DELIVERED', driver).expect(201)).body;
      expect([done.status, !!done.deliveredAt, done.order.status]).toEqual(['DELIVERED', true, 'DELIVERED']);
      expect(await free(ids.coca)).toEqual({ quantity: before.coca.quantity - 12, reserved: before.coca.reserved - 12 });
      const moves = await prisma.stockMovement.findMany({ where: { type: 'CUSTOMER_DELIVERY', originId: o } });
      expect(moves.map((m) => [m.lotId, num(m.quantity)]).sort()).toEqual([[ids.lotLate, -2], [ids.lotSoon, -10]].sort());
      expect(await prisma.stockMovement.count()).toBe(before.moves + 2); // les frais ne touchent jamais le stock
      expect(await prisma.customerOrderLineIssue.count({ where: { deliveryId: d.id } })).toBe(2);
      await deliveryStatus(d.id, 'DELIVERED', driver).expect(409);
      expect(await prisma.stockMovement.count()).toBe(before.moves + 2);
      expect(await prisma.auditLog.count({ where: { action: 'DELIVERY_STATUS', entityId: d.id } })).toBe(3);
      expect(await prisma.auditLog.count({ where: { action: 'CUSTOMER_ORDER_ISSUED', entityId: o } })).toBe(1);
      expect(done.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['TO_PREPARE', 'READY', 'OUT', 'DELIVERED']);
    });

    it('garde les réservations après un échec, permet une nouvelle livraison, et annule avec la commande', async () => {
      const o = ids.menuOrder;
      await advance(o, ['IN_PREPARATION', 'READY']);
      const d = (await delivery(o).expect(201)).body;
      await deliveryStatus(d.id, 'READY').expect(201);
      await deliveryStatus(d.id, 'OUT', driver).expect(201);
      await deliveryStatus(d.id, 'FAILED', driver).expect(400); // motif obligatoire
      const failed = (await deliveryStatus(d.id, 'FAILED', driver, 'Client absent').expect(201)).body;
      expect([failed.status, failed.failedReason, failed.order.status]).toEqual(['FAILED', 'Client absent', 'READY']);
      expect(await reservations(o)).toHaveLength(2);
      expect(await prisma.stockMovement.count({ where: { originId: o } })).toBe(0);

      const again = (await delivery(o, { driverId: driver2.id }).expect(201)).body;
      await api(app, manager, plateau).post(`/api/deliveries/${again.id}/cancel`).send({ reason: '' }).expect(400);
      const c = (await api(app, manager, plateau).post(`/api/customer-orders/${o}/cancel`).send({ reason: 'Client a renoncé' }).expect(201)).body;
      expect([c.status, c.deliveries.map((x: { status: string }) => x.status)]).toEqual(['CANCELLED', ['FAILED', 'CANCELLED']]);
      expect(await reservations(o)).toHaveLength(0);
      await delivery(o).expect(409);
    });
  });

  describe('Protections en base', () => {
    it('interdit la suppression, la retouche des sorties et une seconde livraison active', async () => {
      const d = await prisma.delivery.findFirstOrThrow({ where: { orderId: ids.order1 } });
      const issue = await prisma.customerOrderLineIssue.findFirstOrThrow();
      const r = await prisma.orderReservation.findFirstOrThrow();
      await expect(prisma.$executeRaw`DELETE FROM deliveries WHERE id = ${d.id}::uuid`).rejects.toThrow(/suppression interdite/i);
      await expect(prisma.$executeRaw`UPDATE customer_order_line_issues SET quantity = 99 WHERE id = ${issue.id}::uuid`).rejects.toThrow(/ajout seul/i);
      await expect(prisma.$executeRaw`DELETE FROM delivery_status_history`).rejects.toThrow(/ajout seul/i);
      await expect(prisma.$executeRaw`UPDATE order_reservations SET quantity = 99 WHERE id = ${r.id}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`UPDATE deliveries SET status = 'FAILED' WHERE id = ${d.id}::uuid`).rejects.toThrow(); // échec sans motif
      const o = await order([{ kind: 'PRODUCT', productId: ids.jus, quantity: 1 }]);
      const base = { companyId: d.companyId, establishmentId: d.establishmentId, orderId: o.id, address: 'Cocody', createdById: d.createdById };
      await prisma.delivery.create({ data: { ...base, number: 'TEST-BL-1' } });
      await expect(prisma.delivery.create({ data: { ...base, number: 'TEST-BL-2' } })).rejects.toThrow();
      const fee = await prisma.customerOrderLine.findFirstOrThrow({ where: { kind: 'FEE' } });
      await expect(prisma.$executeRaw`UPDATE customer_order_lines SET made_to_order = true WHERE id = ${fee.id}::uuid`).rejects.toThrow();
    });
  });
});
