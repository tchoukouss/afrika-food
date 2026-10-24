import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Préparation du module 8 : catégorie historique figée sur les lignes de ticket, de commande et de facture. */
describe('Catégorie historique des lignes commerciales', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User;
  let cashier: User;
  let managerYop: User;
  let res: string;
  let yop: string;
  const ids: Record<string, string> = {};

  const as = (u: Session, est = res) => api(app, u, est);
  const sell = async (quantity: number) =>
    (await as(cashier).post('/api/sales').send({ sessionId: ids.sessCashier, lines: [{ productId: ids.coca, quantity }], payments: [{ method: 'CASH', amount: quantity * 500 }] }).expect(201)).body.sale;
  const itemsOf = (saleId: string) => prisma.saleItem.findMany({ where: { saleId }, select: { categoryId: true, categoryName: true } });
  /** Change la catégorie du produit et renomme l'ancienne : l'historique ne doit pas bouger. */
  const recategorize = async (to: string, renameFrom: string, newName: string) => {
    await api(app, admin).patch(`/api/products/${ids.coca}`).send({ categoryId: to }).expect(200);
    await api(app, admin).patch(`/api/product-categories/${renameFrom}`).send({ name: newName }).expect(200);
  };

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
    managerYop = await user('respyop@test.ci', 'MANAGER', yop);
    const store = await user('mag@test.ci', 'STOREKEEPER', res);

    const category = async (name: string) => (await api(app, admin).post('/api/product-categories').send({ name }).expect(201)).body.id;
    ids.boissons = await category('Boissons');
    ids.fraiches = await category('Boissons fraîches');
    ids.promo = await category('Promotions');
    ids.coca = (await api(app, admin).post('/api/products').send({ code: 'COCA', name: 'Coca 33 cl', type: 'RESOLD', basePrice: 500, categoryId: ids.boissons }).expect(201)).body.id;
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    await as(store)
      .post('/api/goods-receipts')
      .send({ establishmentId: res, supplierId: supplier, items: [{ productId: ids.coca, purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, receivedQuantity: 100, unitPrice: 300, expiryDate: inDays(90) }] })
      .expect(201);
    const c1 = (await as(manager).post('/api/cash-registers').send({ establishmentId: res, code: 'C1', name: 'Caisse salle', printerType: 'NONE' }).expect(201)).body.id;
    ids.sessCashier = (await as(cashier).post('/api/cash-sessions').send({ registerId: c1, openingFloat: 10000 }).expect(201)).body.id;
    ids.customer = (await as(manager).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Awa Koné' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('fige la catégorie du produit sur le ticket, sans la relire ensuite', async () => {
    const before = await sell(2);
    expect(await itemsOf(before.id)).toEqual([{ categoryId: ids.boissons, categoryName: 'Boissons' }]);
    await recategorize(ids.promo, ids.boissons, 'Sodas');
    expect(await itemsOf(before.id)).toEqual([{ categoryId: ids.boissons, categoryName: 'Boissons' }]); // historique intact
    const after = await sell(1);
    expect(await itemsOf(after.id)).toEqual([{ categoryId: ids.promo, categoryName: 'Promotions' }]);
    ids.sale = before.id;
  });

  it('couvre le restaurant : l’addition encaissée devient un ticket M5 avec sa catégorie', async () => {
    const bar = (await as(manager).post('/api/restaurant/stations').send({ establishmentId: res, name: 'Bar', kind: 'BAR' }).expect(201)).body.id;
    await as(manager).put('/api/restaurant/menu').send({ establishmentId: res, productId: ids.coca, stationId: bar }).expect(200);
    const area = (await as(manager).post('/api/restaurant/areas').send({ establishmentId: res, name: 'Salle' }).expect(201)).body.id;
    const table = (await as(manager).post('/api/restaurant/tables').send({ areaId: area, code: 'T1', capacity: 4 }).expect(201)).body.id;
    const order = (await as(manager).post('/api/restaurant/orders').send({ establishmentId: res, mode: 'TABLE', tableId: table, covers: 2 }).expect(201)).body.id;
    await as(manager).post(`/api/restaurant/orders/${order}/items`).send({ items: [{ productId: ids.coca, quantity: 3 }] }).expect(201);
    await as(manager).post(`/api/restaurant/orders/${order}/send`).send({}).expect(201);
    const bill = (await as(manager).post(`/api/restaurant/orders/${order}/bills`).send({}).expect(201)).body.bills[0];
    const before = await prisma.sale.count();
    await as(cashier).post(`/api/restaurant/bills/${bill.id}/pay`).send({ sessionId: ids.sessCashier, payments: [{ method: 'CASH', amount: 1500 }] }).expect(201);
    expect(await prisma.sale.count()).toBe(before + 1);
    const sale = await prisma.sale.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(await itemsOf(sale.id)).toEqual([{ categoryId: ids.promo, categoryName: 'Promotions' }]);
    await recategorize(ids.fraiches, ids.promo, 'Offres');
    expect(await itemsOf(sale.id)).toEqual([{ categoryId: ids.promo, categoryName: 'Promotions' }]);
  });

  it('conserve la catégorie de la commande jusqu’à la facture, frais sans catégorie', async () => {
    // Catégorie actuelle du coca : « Boissons fraîches ».
    const o = (await as(manager)
      .post('/api/customer-orders')
      .send({ establishmentId: res, customerId: ids.customer, lines: [{ kind: 'PRODUCT', productId: ids.coca, quantity: 4 }, { kind: 'FEE', label: 'Service traiteur', quantity: 1, unitPrice: 10000 }] })
      .expect(201)).body;
    const lines = await prisma.customerOrderLine.findMany({ where: { orderId: o.id }, orderBy: { position: 'asc' }, select: { categoryId: true, categoryName: true } });
    expect(lines).toEqual([{ categoryId: ids.fraiches, categoryName: 'Boissons fraîches' }, { categoryId: null, categoryName: null }]);
    await as(manager).post(`/api/customer-orders/${o.id}/status`).send({ status: 'CONFIRMED' }).expect(201);
    await recategorize(ids.boissons, ids.fraiches, 'Jus et sodas'); // après la commande, avant la facture
    const inv = (await as(manager).post('/api/invoices').send({ establishmentId: res, source: 'ORDER', orderId: o.id }).expect(201)).body;
    await as(manager).post(`/api/invoices/${inv.id}/issue`).expect(201);
    const invLines = (await as(manager).get(`/api/invoices/${inv.id}`).expect(200)).body.lines.map((l: { categoryId: string | null; categoryName: string | null }) => [l.categoryId, l.categoryName]);
    expect(invLines).toEqual([[ids.fraiches, 'Boissons fraîches'], [null, null]]);
    // Facture de ticket : catégorie copiée du ticket, pas du catalogue.
    const ti = (await as(manager).post('/api/invoices').send({ establishmentId: res, source: 'SALE', saleId: ids.sale, customerId: ids.customer }).expect(201)).body;
    expect(ti.lines.map((l: { categoryId: string; categoryName: string }) => [l.categoryId, l.categoryName])).toEqual([[ids.boissons, 'Boissons']]);
    ids.invoice = inv.id;
  });

  it('respecte isolation, permissions et immutabilité en base', async () => {
    await api(app, managerYop, yop).get(`/api/invoices/${ids.invoice}`).expect(404);
    await as(cashier).post('/api/invoices').send({ establishmentId: res, source: 'SALE', saleId: ids.sale, customerId: ids.customer }).expect(403);
    const item = await prisma.saleItem.findFirstOrThrow({ where: { saleId: ids.sale } });
    await expect(prisma.$executeRaw`UPDATE sale_items SET category_name = 'Autre' WHERE id = ${item.id}::uuid`).rejects.toThrow(/seules les colonnes/);
    const line = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: ids.invoice, kind: 'PRODUCT' } });
    await expect(prisma.$executeRaw`UPDATE invoice_lines SET category_id = NULL, category_name = NULL WHERE id = ${line.id}::uuid`).rejects.toThrow(/lignes figées/);
    const fee = await prisma.customerOrderLine.findFirstOrThrow({ where: { kind: 'FEE' } });
    await expect(prisma.$executeRaw`UPDATE customer_order_lines SET category_id = ${ids.boissons}::uuid, category_name = 'Boissons' WHERE id = ${fee.id}::uuid`).rejects.toThrow();
  });
});
