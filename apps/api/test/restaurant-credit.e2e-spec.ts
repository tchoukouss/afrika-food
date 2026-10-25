import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const num = (v: unknown) => Number(v);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Module 6 — vente à crédit d'une addition : même moteur que la caisse
 * (module 5) et même créance (facture du ticket, module 7).
 */
describe('Module 6 — Addition vendue à crédit', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let manager: User;
  let cashier: User;
  let managerYop: User;
  let res: string;
  let yop: string;
  const ids: Record<string, string> = {};
  let tableNo = 0;

  /** Nouvelle addition de quantity cocas (500 F) sur une table libre : commande, envoi au bar, addition. */
  const newBill = async (quantity: number) => {
    const table = (await api(app, manager, res).post('/api/restaurant/tables').send({ areaId: ids.area, code: `T${++tableNo}`, capacity: 4 }).expect(201)).body.id;
    const order = (await api(app, manager, res).post('/api/restaurant/orders').send({ establishmentId: res, mode: 'TABLE', tableId: table, covers: 2 }).expect(201)).body.id;
    await api(app, manager, res).post(`/api/restaurant/orders/${order}/items`).send({ items: [{ productId: ids.coca, quantity }] }).expect(201);
    await api(app, manager, res).post(`/api/restaurant/orders/${order}/send`).send({}).expect(201);
    const bill = (await api(app, manager, res).post(`/api/restaurant/orders/${order}/bills`).send({}).expect(201)).body.bills[0];
    return { id: bill.id as string, order, total: num(bill.total) };
  };
  const pay = (billId: string, body: object, u: Session = cashier, est = res) => api(app, u, est).post(`/api/restaurant/bills/${billId}/pay`).send({ sessionId: ids.sess, ...body });
  const saleOf = async (billId: string) => {
    const bill = await prisma.restaurantBill.findUniqueOrThrow({ where: { id: billId } });
    return prisma.sale.findUniqueOrThrow({ where: { id: bill.saleId! } });
  };
  const invoiceOfSale = async (saleId: string) => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { saleId } });
    return (await api(app, manager, res).get(`/api/invoices/${inv.id}`).expect(200)).body;
  };
  const snapshot = async () => ({
    sales: await prisma.sale.count(),
    invoices: await prisma.invoice.count(),
    moves: await prisma.cashMovement.count(),
    stockMoves: await prisma.stockMovement.count(),
    voided: await prisma.auditLog.count({ where: { action: 'SALE_NUMBER_VOIDED' } }),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    const admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    res = (await api(app, admin).post('/api/establishments').send({ code: 'RES', name: 'Restaurant Plateau', type: 'RESTAURANT' }).expect(201)).body.id;
    yop = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', res);
    cashier = await user('caisse@test.ci', 'CASHIER', res);
    managerYop = await user('respyop@test.ci', 'MANAGER', yop);
    const store = await user('mag@test.ci', 'STOREKEEPER', res);

    ids.coca = (await api(app, admin).post('/api/products').send({ code: 'COCA', name: 'Coca 33 cl', type: 'RESOLD', basePrice: 500 }).expect(201)).body.id;
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    await api(app, store, res)
      .post('/api/goods-receipts')
      .send({ establishmentId: res, supplierId: supplier, items: [{ productId: ids.coca, purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, receivedQuantity: 200, unitPrice: 300, expiryDate: inDays(90) }] })
      .expect(201);
    const bar = (await api(app, manager, res).post('/api/restaurant/stations').send({ establishmentId: res, name: 'Bar', kind: 'BAR' }).expect(201)).body.id;
    await api(app, manager, res).put('/api/restaurant/menu').send({ establishmentId: res, productId: ids.coca, stationId: bar }).expect(200);
    ids.area = (await api(app, manager, res).post('/api/restaurant/areas').send({ establishmentId: res, name: 'Salle' }).expect(201)).body.id;
    const register = (await api(app, manager, res).post('/api/cash-registers').send({ establishmentId: res, code: 'C1', name: 'Caisse salle', printerType: 'NONE' }).expect(201)).body.id;
    ids.sess = (await api(app, cashier, res).post('/api/cash-sessions').send({ registerId: register, openingFloat: 5000 }).expect(201)).body.id;
    const registerYop = (await api(app, managerYop, yop).post('/api/cash-registers').send({ establishmentId: yop, code: 'Y1', name: 'Caisse Yop', printerType: 'NONE' }).expect(201)).body.id;
    ids.sessYop = (await api(app, managerYop, yop).post('/api/cash-sessions').send({ registerId: registerYop, openingFloat: 0 }).expect(201)).body.id;
    const customer = async (name: string, extra: object) => (await api(app, manager, res).post('/api/customers').send({ type: 'BUSINESS', name, ...extra }).expect(201)).body.id;
    ids.a = await customer('Société Ivoire Events', { creditLimit: 100000, paymentTermDays: 30 });
    ids.d = await customer('Traiteur Kouassi', { creditLimit: 500 });
    ids.inactive = await customer('Client parti', { creditLimit: 50000 });
    await api(app, manager, res).patch(`/api/customers/${ids.inactive}`).send({ isActive: false }).expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('paiement normal d’une addition : inchangé (monnaie rendue, addition payée, aucune facture)', async () => {
    const b = await newBill(2);
    expect(b.total).toBe(1000);
    await pay(b.id, { payments: [{ method: 'CASH', amount: 500 }] }).expect(400); // toujours le paiement intégral sans crédit
    await pay(b.id, { payments: [{ method: 'CASH', amount: 1500 }] }).expect(201);
    const s = await saleOf(b.id);
    expect([num(s.total), num(s.paidTotal), num(s.changeGiven), num(s.creditAmount)]).toEqual([1000, 1500, 500, 0]);
    expect((await prisma.cashMovement.findMany({ where: { saleId: s.id } })).map((m) => num(m.amount))).toEqual([1000]);
    expect(await prisma.invoice.count({ where: { saleId: s.id } })).toBe(0);
    const bill = await prisma.restaurantBill.findUniqueOrThrow({ where: { id: b.id } });
    const order = await prisma.restaurantOrder.findUniqueOrThrow({ where: { id: b.order } });
    expect([bill.status, order.status]).toEqual(['PAID', 'PAID']);
  });

  it('400 encaissés + 600 à crédit : un ticket, un mouvement de 400, une facture de 1 000 dont 600 dus', async () => {
    const b = await newBill(2);
    const before = await snapshot();
    const key = randomUUID();
    const body = { clientRequestId: key, payments: [{ method: 'CASH', amount: 400 }], credit: { customerId: ids.a, amount: 600 } };
    await pay(b.id, body).expect(201);
    await pay(b.id, body).expect(201); // double envoi : rejoué, rien de plus
    const s = await saleOf(b.id);
    expect([num(s.total), num(s.paidTotal), num(s.changeGiven), num(s.creditAmount)]).toEqual([1000, 400, 0, 600]);
    expect((await prisma.cashMovement.findMany({ where: { saleId: s.id } })).map((m) => [m.type, m.method, num(m.amount)])).toEqual([['SALE', 'CASH', 400]]);
    const inv = await invoiceOfSale(s.id);
    expect([inv.source, inv.customer.id, inv.status, num(inv.total), num(inv.posPaidAmount), num(inv.balance), inv.paymentTermDays]).toEqual(['SALE', ids.a, 'ISSUED', 1000, 400, 600, 30]);
    const after = await snapshot();
    expect([after.sales - before.sales, after.invoices - before.invoices, after.moves - before.moves, after.stockMoves - before.stockMoves]).toEqual([1, 1, 1, 0]);
    const bill = await prisma.restaurantBill.findUniqueOrThrow({ where: { id: b.id } });
    expect([bill.status, bill.saleId]).toEqual(['PAID', s.id]);
    expect(num((await api(app, manager, res).get(`/api/customers/${ids.a}/credit`).query({ establishmentId: res }).expect(200)).body.outstanding)).toBe(600);
  });

  it('crédit total : aucun mouvement de caisse, facture entièrement due', async () => {
    const b = await newBill(3);
    await pay(b.id, { payments: [], credit: { customerId: ids.a, amount: 1500 } }).expect(201);
    const s = await saleOf(b.id);
    expect([num(s.paidTotal), num(s.creditAmount)]).toEqual([0, 1500]);
    expect(await prisma.cashMovement.count({ where: { saleId: s.id } })).toBe(0);
    const inv = await invoiceOfSale(s.id);
    expect([num(inv.posPaidAmount), num(inv.balance), inv.paymentStatus]).toEqual([0, 1500, 'UNPAID']);
  });

  it('refuse les demandes de crédit incohérentes, l’addition reste ouverte', async () => {
    const b = await newBill(2);
    const before = await snapshot();
    await pay(b.id, { payments: [{ method: 'CASH', amount: 400 }], credit: { amount: 600 } }).expect(400); // client obligatoire
    expect((await pay(b.id, { payments: [], credit: { customerId: ids.a, amount: 1500 } }).expect(400)).body.message).toMatch(/supérieur au total/);
    expect((await pay(b.id, { payments: [{ method: 'CASH', amount: 500 }], credit: { customerId: ids.a, amount: 600 } }).expect(400)).body.message).toMatch(/exactement le total/);
    expect((await pay(b.id, { payments: [{ method: 'CASH', amount: 300 }], credit: { customerId: ids.a, amount: 600 } }).expect(400)).body.message).toMatch(/exactement le total/);
    expect((await pay(b.id, { payments: [{ method: 'CASH', amount: 500 }], credit: { customerId: ids.inactive, amount: 500 } }).expect(409)).body.code).toBe('CUSTOMER_INACTIVE');
    await pay(b.id, { payments: [{ method: 'CASH', amount: 500 }], credit: { customerId: randomUUID(), amount: 500 } }).expect(404);
    const after = await snapshot();
    expect([after.sales, after.invoices, after.moves, after.stockMoves]).toEqual([before.sales, before.invoices, before.moves, before.stockMoves]);
    expect((await prisma.restaurantBill.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('OPEN');
  });

  it('dépassement : refus et retour arrière complet sans autorisation ; accepté une seule fois avec', async () => {
    const b = await newBill(2);
    const before = await snapshot();
    // Limite 500 : 1 000 à crédit refusés.
    expect((await pay(b.id, { payments: [], credit: { customerId: ids.d, amount: 1000 } }).expect(409)).body.code).toBe('CREDIT_LIMIT_EXCEEDED');
    const after = await snapshot();
    expect([after.sales, after.invoices, after.moves, after.stockMoves]).toEqual([before.sales, before.invoices, before.moves, before.stockMoves]);
    expect(after.voided).toBe(before.voided + 1);
    const bill = await prisma.restaurantBill.findUniqueOrThrow({ where: { id: b.id } });
    expect([bill.status, bill.saleId]).toEqual(['OPEN', null]);
    // Autorisation de dépassement d'un responsable.
    const ov = (await api(app, manager, res).post(`/api/customers/${ids.d}/credit-overrides`).send({ establishmentId: res, maxAmount: 1000, reason: 'Repas de fin d’année' }).expect(201)).body;
    const key = randomUUID();
    const body = { clientRequestId: key, payments: [], credit: { customerId: ids.d, amount: 1000, overrideId: ov.id } };
    await pay(b.id, body).expect(201);
    await pay(b.id, body).expect(201); // rejeu : autorisation non consommée deux fois
    expect(await prisma.auditLog.count({ where: { action: 'CREDIT_OVERRIDE_USED', entityId: ov.id } })).toBe(1);
    expect(num((await invoiceOfSale((await saleOf(b.id)).id)).balance)).toBe(1000);
    // La même autorisation pour une autre addition : refusée.
    const b2 = await newBill(1);
    expect((await pay(b2.id, { payments: [], credit: { customerId: ids.d, amount: 500, overrideId: ov.id } }).expect(409)).body.code).toBe('CREDIT_OVERRIDE_INVALID');
    expect((await prisma.restaurantBill.findUniqueOrThrow({ where: { id: b2.id } })).status).toBe('OPEN');
  });

  it('isole les établissements : une addition se paie avec une session de son établissement', async () => {
    const b = await newBill(1);
    const before = await snapshot();
    await api(app, managerYop, yop).post(`/api/restaurant/bills/${b.id}/pay`).send({ sessionId: ids.sessYop, payments: [], credit: { customerId: ids.a, amount: 500 } }).expect((r) => expect([400, 403, 404]).toContain(r.status));
    const after = await snapshot();
    expect([after.sales, after.invoices]).toEqual([before.sales, before.invoices]);
    await api(app, managerYop, yop).get(`/api/invoices/${(await prisma.invoice.findFirstOrThrow({ where: { customerId: ids.a } })).id}`).expect(404);
  });
});
