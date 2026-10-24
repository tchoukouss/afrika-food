import { ConflictException, INestApplication } from '@nestjs/common';
import { ProductionCompletion, ProductionService } from '../src/production/production';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v);

/** Crochet de fin de production (module 4) utilisé par le module 7 pour réserver le lot fini d'une commande. */
describe('Module 4 — Crochet de fin de production', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let production: ProductionService;
  let manager: Session;
  let plateau: string;
  let cake: string;
  let flour: string;

  /** Crée, valide et lance un ordre de 10 gâteaux ; renvoie l'URL de fin de production. */
  const startedOrder = async () => {
    const o = await api(app, manager, plateau).post('/api/production-orders').send({ establishmentId: plateau, productId: cake, plannedQuantity: 10 }).expect(201);
    for (const step of ['validate', 'start']) await api(app, manager, plateau).post(`/api/production-orders/${o.body.id}/${step}`).expect(201);
    return { id: o.body.id as string, url: `/api/production-orders/${o.body.id}/complete` };
  };
  const cakeStock = async () => num((await prisma.stockBalance.aggregate({ where: { productId: cake }, _sum: { quantity: true } }))._sum.quantity ?? 0);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    production = app.get(ProductionService);
    const admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    manager = await createAndLogin(app, admin, { email: 'resp@test.ci', fullName: 'resp', roles: [{ roleId: roles.MANAGER, establishmentId: plateau }] });
    const store = await createAndLogin(app, admin, { email: 'mag@test.ci', fullName: 'mag', roles: [{ roleId: roles.STOREKEEPER, establishmentId: plateau }] });
    flour = (await api(app, admin).post('/api/raw-materials').send({ code: 'FAR', name: 'Farine', baseUnitCode: 'KG', isPerishable: true }).expect(201)).body.id;
    cake = (await api(app, admin).post('/api/products').send({ code: 'GAT', name: 'Gâteau', type: 'MANUFACTURED', basePrice: 20000 }).expect(201)).body.id;
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'GMA', name: 'Grands Moulins' }).expect(201)).body.id;
    await api(app, store, plateau)
      .post('/api/goods-receipts')
      .send({ establishmentId: plateau, supplierId: supplier, items: [{ rawMaterialId: flour, purchaseUnitLabel: 'kg', quantityPerPurchaseUnit: 1, receivedQuantity: 50, unitPrice: 700, expiryDate: inDays(60) }] })
      .expect(201);
    const r = await api(app, admin).post('/api/recipes').send({ productId: cake, yieldQuantity: 1, shelfLifeDays: 2, items: [{ rawMaterialId: flour, quantity: 500, unitCode: 'G' }] }).expect(201);
    await api(app, admin).post(`/api/recipe-versions/${r.body.versions[0].id}/activate`).expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('ne change rien sans crochet enregistré', async () => {
    const before = await cakeStock();
    const { id, url } = await startedOrder();
    const res = (await api(app, manager, plateau).post(url).send({ producedQuantity: 10 }).expect(201)).body;
    expect(res.status).toBe('COMPLETED');
    expect(await cakeStock()).toBe(before + 10);
    expect(await prisma.productionOutput.count({ where: { orderId: id } })).toBe(1);
  });

  it('appelle le crochet avec le lot fini, dans la transaction de la fin de production', async () => {
    const calls: { completion: ProductionCompletion; visibleInTx: number; visibleOutside: number; userId: string }[] = [];
    const remove = production.registerCompletionHook(async (tx, me, completion) => {
      calls.push({
        completion,
        // Le lot et la sortie de production sont visibles dans la transaction…
        visibleInTx: await tx.productionOutput.count({ where: { orderId: completion.orderId } }),
        // …mais pas encore hors de celle-ci : rien n'est validé tant que le crochet n'a pas fini.
        visibleOutside: await prisma.productionOutput.count({ where: { orderId: completion.orderId } }),
        userId: me.userId,
      });
      await tx.auditLog.create({ data: { companyId: me.companyId, action: 'TEST_HOOK', entityType: 'StockLot', entityId: completion.lot.id } });
    });
    try {
      const { id, url } = await startedOrder();
      await api(app, manager, plateau).post(url).send({ producedQuantity: 8, lossCause: 'BURNT', lossReason: 'Four trop chaud' }).expect(201);
      const output = await prisma.productionOutput.findFirstOrThrow({ where: { orderId: id } });
      expect(calls).toHaveLength(1);
      const c = calls[0].completion;
      expect([c.orderId, c.lot.id, c.productId, c.establishmentId, c.locationId, num(c.quantity), c.lot.origin]).toEqual([id, output.lotId, cake, plateau, output.locationId, 8, 'PRODUCTION']);
      expect([calls[0].visibleInTx, calls[0].visibleOutside]).toEqual([1, 0]);
      // L'écriture du crochet est validée avec la production.
      expect(await prisma.auditLog.count({ where: { action: 'TEST_HOOK', entityId: output.lotId } })).toBe(1);
    } finally {
      remove();
    }
  });

  it('annule toute la fin de production si le crochet échoue, sans effet partiel', async () => {
    const { id, url } = await startedOrder();
    const before = { stock: await cakeStock(), lots: await prisma.stockLot.count({ where: { productId: cake } }), movements: await prisma.stockMovement.count({ where: { type: 'PRODUCTION' } }) };
    const remove = production.registerCompletionHook(async (tx, _me, completion) => {
      await tx.auditLog.create({ data: { companyId: (await tx.productionOrder.findUniqueOrThrow({ where: { id: completion.orderId } })).companyId, action: 'TEST_HOOK_FAIL', entityType: 'StockLot' } });
      throw new ConflictException('Réservation impossible');
    });
    try {
      const res = await api(app, manager, plateau).post(url).send({ producedQuantity: 10 }).expect(409);
      expect(res.body.message).toBe('Réservation impossible');
    } finally {
      remove();
    }
    const order = await prisma.productionOrder.findUniqueOrThrow({ where: { id } });
    expect(order.status).toBe('IN_PROGRESS');
    expect(await prisma.productionOutput.count({ where: { orderId: id } })).toBe(0);
    expect(await cakeStock()).toBe(before.stock);
    expect(await prisma.stockLot.count({ where: { productId: cake } })).toBe(before.lots);
    expect(await prisma.stockMovement.count({ where: { type: 'PRODUCTION' } })).toBe(before.movements);
    expect(await prisma.auditLog.count({ where: { action: { in: ['TEST_HOOK_FAIL', 'PRODUCTION_COMPLETED'] }, entityId: { in: [id] } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'TEST_HOOK_FAIL' } })).toBe(0);
    // Crochet retiré : la même fin de production réussit.
    await api(app, manager, plateau).post(url).send({ producedQuantity: 10 }).expect(201);
    expect(await cakeStock()).toBe(before.stock + 10);
  });
});
