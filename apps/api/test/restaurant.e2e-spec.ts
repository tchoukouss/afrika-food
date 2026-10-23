import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AddressInfo, createServer, Server } from 'node:net';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v);
const year = new Date().getUTCFullYear();

/** Imprimante thermique simulée (bons de cuisine). */
async function fakePrinter() {
  const received: string[] = [];
  const server: Server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => received.push(Buffer.concat(chunks).toString('latin1')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  /** Attend que l'imprimante ait reçu `count` documents (réception TCP asynchrone). */
  const waitFor = async (count: number) => {
    for (let i = 0; i < 100 && received.length < count; i++) await new Promise((r) => setTimeout(r, 20));
  };
  return { server, received, waitFor, port: (server.address() as AddressInfo).port };
}

type User = Session & { id: string };

describe('Module 6 — Restaurant & commandes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User; // Responsable du restaurant
  let waiter: User; // Serveur
  let waiter2: User; // Second serveur
  let chef: User; // Chef de cuisine
  let cashier: User; // Caissier
  let accountant: User; // Comptable
  let storekeeper: User; // Magasinier
  let waiterYop: User; // Serveur d'un autre restaurant
  let res: string; // Restaurant (type RESTAURANT)
  let pat: string; // Pâtisserie seule (module restaurant non activé)
  let yop: string; // Autre restaurant
  let printer: Awaited<ReturnType<typeof fakePrinter>>;
  const ids: Record<string, string> = {};

  const qtyOf = async (where: { productId?: string; rawMaterialId?: string }, establishmentId = res) =>
    num((await prisma.stockBalance.aggregate({ where: { establishmentId, ...where }, _sum: { quantity: true } }))._sum.quantity ?? 0);
  const as = (u: Session, est = res) => api(app, u, est);
  const floorStatus = async (code: string) => {
    const areas = (await as(waiter).get('/api/restaurant/floor').expect(200)).body as { tables: { code: string; status: string }[] }[];
    return areas.flatMap((a) => a.tables).find((t) => t.code === code)!.status;
  };
  const open = (u: Session, body: object) => as(u).post('/api/restaurant/orders').send({ establishmentId: res, ...body });
  const add = (u: Session, orderId: string, items: object[], extra: object = {}) => as(u).post(`/api/restaurant/orders/${orderId}/items`).send({ items, ...extra });
  const send = (u: Session, orderId: string, extra: object = {}) => as(u).post(`/api/restaurant/orders/${orderId}/send`).send(extra);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Item = { id: string; productId: string; status: string } & Record<string, any>;
  const itemOf = (order: { items: Item[] }, productId: string, status?: string): Item =>
    order.items.find((i) => i.productId === productId && (!status || i.status === status))!;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    printer = await fakePrinter();
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    const est = async (code: string, name: string, type: string) => (await api(app, admin).post('/api/establishments').send({ code, name, type }).expect(201)).body.id;
    res = await est('RES', 'Maquis Cocody', 'RESTAURANT');
    pat = await est('PAT', 'Pâtisserie Plateau', 'PATISSERIE');
    yop = await est('YOP', 'Restaurant Yopougon', 'RESTAURANT');
    const user = (email: string, role: string, e: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: e }] });
    manager = await user('resp@test.ci', 'MANAGER', res);
    waiter = await user('serveur@test.ci', 'WAITER', res);
    waiter2 = await user('serveur2@test.ci', 'WAITER', res);
    chef = await user('chef@test.ci', 'HEAD_CHEF', res);
    cashier = await user('caisse@test.ci', 'CASHIER', res);
    accountant = await user('compta@test.ci', 'ACCOUNTANT', res);
    storekeeper = await user('mag@test.ci', 'STOREKEEPER', res);
    waiterYop = await user('serveuryop@test.ci', 'WAITER', yop);

    // Catalogue.
    const raw = async (code: string, name: string) => (await api(app, admin).post('/api/raw-materials').send({ code, name, baseUnitCode: 'KG', isPerishable: true }).expect(201)).body.id;
    ids.viande = await raw('VIA', 'Viande de poulet');
    ids.riz = await raw('RIZ', 'Riz parfumé');
    ids.farine = await raw('FAR', 'Farine T55');
    ids.boeuf = await raw('BOE', 'Bœuf');
    const product = async (code: string, name: string, type: string, extra: object = {}) => (await api(app, admin).post('/api/products').send({ code, name, type, ...extra }).expect(201)).body.id;
    ids.poulet = await product('POU', 'Poulet braisé', 'MANUFACTURED', { basePrice: 5000, taxRate: 18 });
    ids.brochette = await product('BRO', 'Brochette de bœuf', 'MANUFACTURED', { basePrice: 3000 });
    ids.garba = await product('GAR', 'Garba', 'MANUFACTURED', { basePrice: 1500 });
    ids.croissant = await product('CRO', 'Croissant', 'MANUFACTURED', { basePrice: 300 });
    ids.coca = await product('COCA', 'Coca 33 cl', 'RESOLD', { basePrice: 500 });
    ids.piment = await product('PIM', 'Sauce piment', 'RESOLD', { basePrice: 200 });
    ids.formule = await product('FML', 'Formule midi', 'MENU', { basePrice: 5300, components: [{ productId: ids.poulet, quantity: 1 }, { productId: ids.coca, quantity: 1 }] });
    ids.gma = (await api(app, admin).post('/api/suppliers').send({ code: 'GMA', name: 'Grands Moulins' }).expect(201)).body.id;
    ids.sipra = (await api(app, admin).post('/api/suppliers').send({ code: 'SIP', name: 'SIPRA' }).expect(201)).body.id;

    const receive = (item: object, supplierId: string, qty: number, price: number, expiry?: string) =>
      as(storekeeper)
        .post('/api/goods-receipts')
        .send({ establishmentId: res, supplierId, items: [{ ...item, purchaseUnitLabel: 'U', quantityPerPurchaseUnit: 1, receivedQuantity: qty, unitPrice: price, expiryDate: expiry }] })
        .expect(201);
    await receive({ rawMaterialId: ids.viande }, ids.sipra, 10, 4000, inDays(10));
    await receive({ rawMaterialId: ids.riz }, ids.gma, 20, 800, inDays(90));
    await receive({ rawMaterialId: ids.farine }, ids.gma, 20, 700, inDays(60));
    await receive({ rawMaterialId: ids.boeuf }, ids.sipra, 1, 6000, inDays(5));
    await receive({ productId: ids.coca }, ids.sipra, 30, 350, inDays(120));
    await receive({ productId: ids.piment }, ids.gma, 50, 50, inDays(30));
    ids.viandeLot = (await prisma.stockLot.findFirstOrThrow({ where: { rawMaterialId: ids.viande } })).id;
    ids.farineLot = (await prisma.stockLot.findFirstOrThrow({ where: { rawMaterialId: ids.farine } })).id;
    ids.cocaLot = (await prisma.stockLot.findFirstOrThrow({ where: { productId: ids.coca } })).id;

    // Recettes (module 4) : poulet et brochette à la commande, croissant produit d'avance.
    const recipe = async (productId: string, yieldQuantity: number, items: object[]) => {
      const r = await api(app, admin).post('/api/recipes').send({ productId, yieldQuantity, shelfLifeDays: 2, items }).expect(201);
      await api(app, admin).post(`/api/recipe-versions/${r.body.versions[0].id}/activate`).expect(201);
    };
    await recipe(ids.poulet, 1, [{ rawMaterialId: ids.viande, quantity: 300, unitCode: 'G' }, { rawMaterialId: ids.riz, quantity: 200, unitCode: 'G' }]);
    await recipe(ids.brochette, 1, [{ rawMaterialId: ids.boeuf, quantity: 600, unitCode: 'G' }]);
    await recipe(ids.croissant, 10, [{ rawMaterialId: ids.farine, quantity: 500, unitCode: 'G' }]);
    const order = await as(manager).post('/api/production-orders').send({ establishmentId: res, productId: ids.croissant, plannedQuantity: 20 }).expect(201);
    for (const step of ['validate', 'start']) await as(manager).post(`/api/production-orders/${order.body.id}/${step}`).expect(201);
    await as(manager).post(`/api/production-orders/${order.body.id}/complete`).send({ producedQuantity: 20 }).expect(201);
    ids.productionNumber = order.body.number;
    ids.croissantLot = (await prisma.productionOutput.findFirstOrThrow({ where: { orderId: order.body.id } })).lotId;

    // Caisses (module 5).
    ids.c1 = (await as(manager).post('/api/cash-registers').send({ establishmentId: res, code: 'C1', name: 'Caisse salle' }).expect(201)).body.id;
    ids.c2 = (await as(manager).post('/api/cash-registers').send({ establishmentId: res, code: 'C2', name: 'Caisse bar' }).expect(201)).body.id;
    ids.cashierSession = (await as(cashier).post('/api/cash-sessions').send({ registerId: ids.c1, openingFloat: 20000 }).expect(201)).body.id;
    ids.managerSession = (await as(manager).post('/api/cash-sessions').send({ registerId: ids.c2, openingFloat: 20000 }).expect(201)).body.id;
  });

  afterAll(async () => {
    printer.server.close();
    await app.close();
  });

  describe('Paramétrage', () => {
    it('réserve le module aux restaurants et le paramétrage au responsable', async () => {
      await api(app, admin).post('/api/restaurant/areas').send({ establishmentId: pat, name: 'Salle' }).expect(400); // décision R1
      await as(waiter).post('/api/restaurant/areas').send({ establishmentId: res, name: 'Salle' }).expect(403);
      ids.salle = (await as(manager).post('/api/restaurant/areas').send({ establishmentId: res, name: 'Salle' }).expect(201)).body.id;
      ids.terrasse = (await as(manager).post('/api/restaurant/areas').send({ establishmentId: res, name: 'Terrasse', sortOrder: 2 }).expect(201)).body.id;
      for (const [code, capacity, area] of [['T1', 4, ids.salle], ['T2', 2, ids.salle], ['T3', 6, ids.salle], ['T4', 4, ids.terrasse]] as const) {
        ids[code] = (await as(manager).post('/api/restaurant/tables').send({ areaId: area, code, capacity }).expect(201)).body.id;
      }
      await as(manager).post('/api/restaurant/tables').send({ areaId: ids.salle, code: 't1', capacity: 2 }).expect(409);
      await as(manager).post('/api/restaurant/stations').send({ establishmentId: res, name: 'Cuisine', kind: 'KITCHEN', printerType: 'NETWORK', printerHost: '8.8.8.8' }).expect(400);
      ids.cuisine = (
        await as(manager).post('/api/restaurant/stations').send({ establishmentId: res, name: 'Cuisine', kind: 'KITCHEN', printerType: 'NETWORK', printerHost: '127.0.0.1', printerPort: printer.port }).expect(201)
      ).body.id;
      ids.bar = (await as(manager).post('/api/restaurant/stations').send({ establishmentId: res, name: 'Bar', kind: 'BAR' }).expect(201)).body.id;
      ids.yopArea = (await api(app, admin).post('/api/restaurant/areas').send({ establishmentId: yop, name: 'Salle' }).expect(201)).body.id;
      ids.yopT1 = (await api(app, admin).post('/api/restaurant/tables').send({ areaId: ids.yopArea, code: 'Y1', capacity: 4 }).expect(201)).body.id;
    });

    it('construit la carte : préparé à la commande avec recette obligatoire, postes, suppléments, options (R5, R6)', async () => {
      const carte = (body: object) => as(manager).put('/api/restaurant/menu').send({ establishmentId: res, ...body });
      await carte({ productId: ids.garba, preparation: 'TO_ORDER' }).expect(409); // pas de recette
      await carte({ productId: ids.coca, preparation: 'TO_ORDER' }).expect(400); // produit revendu
      await carte({ productId: ids.poulet, preparation: 'TO_ORDER', stationId: ids.cuisine }).expect(200);
      await carte({ productId: ids.brochette, preparation: 'TO_ORDER', stationId: ids.cuisine }).expect(200);
      await carte({ productId: ids.croissant, preparation: 'FROM_STOCK' }).expect(200); // service direct, sans poste
      await carte({ productId: ids.coca, stationId: ids.bar }).expect(200);
      await carte({ productId: ids.piment, stationId: ids.cuisine, isSupplement: true }).expect(200);
      await carte({ productId: ids.formule, stationId: ids.cuisine }).expect(200);
      await as(waiter).put('/api/restaurant/menu').send({ establishmentId: res, productId: ids.garba }).expect(403);
      for (const label of ['Bien cuit', 'Sans oignon']) await as(manager).post('/api/restaurant/options').send({ establishmentId: res, productId: ids.poulet, label }).expect(201);
      const menu = (await as(waiter).get('/api/restaurant/menu').expect(200)).body;
      const poulet = menu.find((m: { productId: string }) => m.productId === ids.poulet);
      expect([num(poulet.price), poulet.preparation, poulet.station.name, poulet.options.length, poulet.isAvailable]).toEqual([5000, 'TO_ORDER', 'Cuisine', 2, true]);
      await api(app, admin).put('/api/restaurant/menu').send({ establishmentId: yop, productId: ids.coca }).expect(200);
    });
  });

  describe('Commandes et cuisine', () => {
    it('ouvre une commande par table, rejoue un double envoi, départage deux serveurs (R10, R24)', async () => {
      const key = randomUUID();
      const o = await open(waiter, { clientRequestId: key, mode: 'TABLE', tableId: ids.T1, covers: 2 }).expect(201);
      expect(o.body.number).toBe(`RES-RST-${year}-000001`);
      expect((await open(waiter, { clientRequestId: key, mode: 'TABLE', tableId: ids.T1, covers: 2 }).expect(201)).body.id).toBe(o.body.id);
      ids.order1 = o.body.id;
      await open(waiter2, { mode: 'TABLE', tableId: ids.T1 }).expect(409);
      await open(waiter, { mode: 'TABLE' }).expect(400); // table obligatoire
      await open(waiter, { mode: 'DELIVERY', customerPhone: '0700000000' }).expect(400); // adresse obligatoire
      expect(await floorStatus('T1')).toBe('WAITING_ORDER');
      const [a, b] = await Promise.all([open(waiter, { mode: 'TABLE', tableId: ids.T2 }), open(waiter2, { mode: 'TABLE', tableId: ids.T2 })]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      ids.order2 = (a.status === 201 ? a : b).body.id;
      expect(await prisma.restaurantOrder.count({ where: { tableId: ids.T2, status: 'OPEN' } })).toBe(1);
    });

    it('saisit des brouillons au prix figé, avec options et suppléments ; un brouillon retiré reste tracé (R7, R13)', async () => {
      await add(waiter, ids.order1, [{ productId: ids.garba, quantity: 1 }]).expect(400); // hors carte
      await add(waiter, ids.order1, [{ productId: ids.poulet, quantity: 1, options: ['Saignant'] }]).expect(400); // option inconnue
      await add(waiter, ids.order1, [{ productId: ids.coca, quantity: 1, supplements: [{ productId: ids.coca, quantity: 1 }] }]).expect(400); // pas un supplément
      const key = randomUUID();
      const lines = [
        { productId: ids.poulet, quantity: 2, options: ['Bien cuit'], note: 'Peu de sel', supplements: [{ productId: ids.piment, quantity: 1 }] },
        { productId: ids.coca, quantity: 2 },
        { productId: ids.croissant, quantity: 1 },
      ];
      await add(waiter, ids.order1, lines, { clientRequestId: key }).expect(201);
      const again = await add(waiter, ids.order1, lines, { clientRequestId: key }).expect(201);
      expect(again.body.items).toHaveLength(4); // pas de doublon
      await api(app, admin).put(`/api/products/${ids.coca}/price`).send({ price: 600 }).expect(200);
      const order = (await as(waiter).get(`/api/restaurant/orders/${ids.order1}`).expect(200)).body;
      expect(num(itemOf(order, ids.coca).unitPrice)).toBe(500); // prix annoncé conservé
      const croissant = itemOf(order, ids.croissant);
      const removed = await as(waiter).post(`/api/restaurant/orders/${ids.order1}/items/${croissant.id}/remove`).expect(201);
      expect(itemOf(removed.body, ids.croissant).status).toBe('REMOVED');
      expect(await prisma.restaurantOrderItem.count({ where: { orderId: ids.order1 } })).toBe(4);
      expect(num(removed.body.totals.ordered)).toBe(2 * 5000 + 200 + 2 * 500);
    });

    it('envoie en cuisine et au bar : la recette sort du stock au coût réel des lots, un bon par poste (R11, R12)', async () => {
      const [viande, riz, coca] = [await qtyOf({ rawMaterialId: ids.viande }), await qtyOf({ rawMaterialId: ids.riz }), await qtyOf({ productId: ids.coca })];
      const printed = printer.received.length;
      const key = randomUUID();
      const res1 = await send(waiter, ids.order1, { clientRequestId: key }).expect(201);
      await send(waiter, ids.order1, { clientRequestId: key }).expect(201); // double envoi rejoué
      expect(await prisma.restaurantKitchenTicket.count({ where: { orderId: ids.order1 } })).toBe(2);
      await send(waiter, ids.order1).expect(400); // plus rien à envoyer
      expect([await qtyOf({ rawMaterialId: ids.viande }), await qtyOf({ rawMaterialId: ids.riz }), await qtyOf({ productId: ids.coca })]).toEqual([viande - 0.6, riz - 0.4, coca - 2]);
      const poulet = itemOf(res1.body, ids.poulet);
      expect([poulet.status, num(poulet.costTotal)]).toEqual(['NEW', 2720]); // 0,6 kg × 4 000 + 0,4 kg × 800
      expect(itemOf(res1.body, ids.piment).kitchenTicketId).toBe(poulet.kitchenTicketId); // le supplément suit son plat
      expect(res1.body.kitchenTickets.map((t: { station: { name: string } }) => t.station.name).sort()).toEqual(['Bar', 'Cuisine']);
      const moves = await prisma.stockMovement.findMany({ where: { originId: poulet.id } });
      expect(moves.every((m) => m.type === 'ORDER_CONSUMPTION' && num(m.quantity) < 0)).toBe(true);
      expect(await prisma.restaurantConsumption.count({ where: { itemId: poulet.id, kind: 'CONSUMED' } })).toBe(2);
      await printer.waitFor(printed + 1);
      const bon = printer.received.at(-1)!;
      expect(bon).toContain('CUISINE');
      expect(bon).toContain('TABLE T1');
      expect(bon).toContain('Bien cuit');
      expect(bon).toContain('+ 1 Sauce piment');
      expect(await floorStatus('T1')).toBe('OCCUPIED');
      expect(await prisma.auditLog.count({ where: { action: 'RESTAURANT_ORDER_SENT', entityId: ids.order1 } })).toBe(1);
    });

    it('refuse un envoi si un ingrédient manque, sans rien sortir', async () => {
      const viande = await qtyOf({ rawMaterialId: ids.viande });
      await add(waiter, ids.order2, [{ productId: ids.poulet, quantity: 100 }]).expect(201);
      const r = await send(waiter, ids.order2).expect(409);
      expect(r.body.message).toContain('Viande de poulet');
      expect(await qtyOf({ rawMaterialId: ids.viande })).toBe(viande);
      expect(await prisma.restaurantKitchenTicket.count({ where: { orderId: ids.order2 } })).toBe(0);
      const order = (await as(waiter).get(`/api/restaurant/orders/${ids.order2}`).expect(200)).body;
      expect(itemOf(order, ids.poulet).status).toBe('DRAFT');
      await as(waiter).post(`/api/restaurant/orders/${ids.order2}/items/${itemOf(order, ids.poulet).id}/remove`).expect(201);
    });

    it('fait avancer les statuts en cuisine, jamais en arrière ; le serveur marque « servi » (R13, R29)', async () => {
      const queue = (await as(chef).get(`/api/restaurant/kitchen?stationId=${ids.cuisine}`).expect(200)).body;
      expect(queue).toHaveLength(1);
      expect(queue[0].order.table).toBe('T1');
      const poulet = queue[0].items.find((i: { productName: string }) => i.productName === 'Poulet braisé');
      expect(poulet.options).toEqual(['Bien cuit']);
      await as(waiter).post(`/api/restaurant/kitchen/items/${poulet.id}/status`).send({ status: 'IN_PREPARATION' }).expect(403);
      await as(chef).post(`/api/restaurant/kitchen/items/${poulet.id}/status`).send({ status: 'IN_PREPARATION' }).expect(201);
      await as(chef).post(`/api/restaurant/kitchen/items/${poulet.id}/status`).send({ status: 'IN_PREPARATION' }).expect(409); // déjà atteint
      const bar = (await as(chef).get(`/api/restaurant/kitchen?stationId=${ids.bar}`).expect(200)).body[0];
      await as(chef).post(`/api/restaurant/kitchen/tickets/${bar.id}/status`).send({ status: 'READY' }).expect(201);
      const coca = bar.items[0];
      await as(waiter).post(`/api/restaurant/kitchen/items/${coca.id}/status`).send({ status: 'SERVED' }).expect(201);
      await as(chef).post(`/api/restaurant/kitchen/items/${coca.id}/status`).send({ status: 'READY' }).expect(409); // pas de retour arrière
    });

    it('annule un article envoyé : ingrédients rendus avant préparation, perte après (R14)', async () => {
      // Nouvelle boisson non préparée : retour au même lot.
      await add(waiter, ids.order1, [{ productId: ids.coca, quantity: 1 }]).expect(201);
      const sent = (await send(waiter, ids.order1).expect(201)).body;
      const newCoca = itemOf(sent, ids.coca, 'NEW');
      const coca = await qtyOf({ productId: ids.coca });
      await as(waiter).post(`/api/restaurant/orders/${ids.order1}/items/${newCoca.id}/cancel`).send({ quantity: 1, reason: 'Erreur de saisie' }).expect(403);
      const key = randomUUID();
      await as(manager).post(`/api/restaurant/orders/${ids.order1}/items/${newCoca.id}/cancel`).send({ clientRequestId: key, quantity: 1, reason: 'Erreur de saisie' }).expect(201);
      await as(manager).post(`/api/restaurant/orders/${ids.order1}/items/${newCoca.id}/cancel`).send({ clientRequestId: key, quantity: 1, reason: 'Erreur de saisie' }).expect(201); // rejoué
      expect(await qtyOf({ productId: ids.coca })).toBe(coca + 1);
      const back = await prisma.stockMovement.findMany({ where: { type: 'ORDER_RETURN' } });
      expect(back.map((m) => [m.lotId, num(m.quantity)])).toEqual([[ids.cocaLot, 1]]);

      // Poulet en préparation : perte déclarée, rien ne revient en stock.
      const order = (await as(manager).get(`/api/restaurant/orders/${ids.order1}`).expect(200)).body;
      const poulet = itemOf(order, ids.poulet);
      const viande = await qtyOf({ rawMaterialId: ids.viande });
      await as(manager).post(`/api/restaurant/orders/${ids.order1}/items/${poulet.id}/cancel`).send({ quantity: 1, reason: 'Plat tombé' }).expect(400); // cause manquante
      await as(manager).post(`/api/restaurant/orders/${ids.order1}/items/${poulet.id}/cancel`).send({ quantity: 3, reason: 'Trop', lossCause: 'OTHER' }).expect(409);
      const after = (await as(manager).post(`/api/restaurant/orders/${ids.order1}/items/${poulet.id}/cancel`).send({ quantity: 1, reason: 'Plat tombé', lossCause: 'QUALITY' }).expect(201)).body;
      expect(await qtyOf({ rawMaterialId: ids.viande })).toBe(viande);
      const losses = await prisma.stockLoss.findMany({ where: { cause: 'QUALITY' }, orderBy: { number: 'asc' } });
      expect(losses.map((l) => num(l.quantity)).sort()).toEqual([0.2, 0.3]);
      const p = itemOf(after, ids.poulet);
      expect([num(p.cancelledQuantity), p.status, num(p.costTotal), num(p.amount)]).toEqual([1, 'IN_PREPARATION', 1360, 5000]);
      expect(itemOf(after, ids.coca, 'CANCELLED').cancelledQuantity).toBe('1');
      expect(await prisma.auditLog.count({ where: { action: 'RESTAURANT_ITEM_CANCELLED' } })).toBe(2);
    });

    it('transfère une commande, déplace des articles, regroupe et annule des commandes (R15, R16)', async () => {
      await as(waiter).post(`/api/restaurant/orders/${ids.order1}/transfer`).send({ tableId: ids.T2 }).expect(409); // occupée
      await as(waiter).post(`/api/restaurant/orders/${ids.order1}/transfer`).send({ tableId: ids.T3 }).expect(201);
      expect([await floorStatus('T1'), await floorStatus('T3')]).toEqual(['FREE', 'OCCUPIED']);

      // Une commande en terrasse : croissant servi depuis le stock, sans poste (prêt aussitôt).
      const t4 = (await open(waiter2, { mode: 'TABLE', tableId: ids.T4 }).expect(201)).body.id;
      await add(waiter2, t4, [{ productId: ids.croissant, quantity: 2 }]).expect(201);
      const sent = (await send(waiter2, t4).expect(201)).body;
      const croissant = itemOf(sent, ids.croissant);
      expect(croissant.status).toBe('READY');
      expect(await prisma.restaurantConsumption.findFirst({ where: { itemId: croissant.id } })).toMatchObject({ lotId: ids.croissantLot });
      const moved = (await as(waiter2).post(`/api/restaurant/orders/${t4}/move-items`).send({ targetOrderId: ids.order1, itemIds: [croissant.id] }).expect(201)).body;
      expect(moved.items.filter((i: { status: string }) => i.status !== 'REMOVED')).toHaveLength(0);
      await as(waiter2).post(`/api/restaurant/orders/${t4}/cancel`).send({ reason: 'Clients partis à l’intérieur' }).expect(201);
      expect(await floorStatus('T4')).toBe('FREE');

      // Regroupement de la table T2 dans la commande de T3.
      await add(waiter, ids.order2, [{ productId: ids.coca, quantity: 1 }]).expect(201);
      await send(waiter, ids.order2).expect(201);
      const merged = (await as(waiter).post(`/api/restaurant/orders/${ids.order1}/merge`).send({ sourceOrderId: ids.order2 }).expect(201)).body;
      expect(merged.items.filter((i: { productId: string; status: string }) => i.productId === ids.coca && i.status !== 'CANCELLED')).toHaveLength(2);
      const source = await prisma.restaurantOrder.findUniqueOrThrow({ where: { id: ids.order2 } });
      expect([source.status, source.mergedIntoId]).toEqual(['MERGED', ids.order1]);
      expect(await floorStatus('T2')).toBe('FREE');
      // L'écran cuisine affiche la commande actuelle des articles, pas celle d'origine du bon.
      const bar = (await as(chef).get(`/api/restaurant/kitchen?stationId=${ids.bar}`).expect(200)).body;
      expect(bar.map((t: { order: { number: string; table: string } }) => [t.order.number, t.order.table])).toEqual([[merged.number, 'T3']]);
      // Une commande avec des articles envoyés non annulés ne s'annule pas.
      await as(manager).post(`/api/restaurant/orders/${ids.order1}/cancel`).send({ reason: 'Test' }).expect(409);
    });
  });

  describe('Additions et encaissement', () => {
    it('sépare l’addition par articles, imprime une note provisoire tracée (R17, R23)', async () => {
      const order = (await as(waiter).get(`/api/restaurant/orders/${ids.order1}`).expect(200)).body;
      const poulet = itemOf(order, ids.poulet);
      const a = (await as(waiter).post(`/api/restaurant/orders/${ids.order1}/bills`).send({ itemIds: [poulet.id] }).expect(201)).body;
      const billA = a.bills[0];
      expect([billA.number, num(billA.total), billA.items.length]).toEqual([`RES-ADD-${year}-000001`, 5000 + 200, 2]); // le supplément suit
      ids.billA = billA.id;
      await as(manager).post(`/api/restaurant/orders/${ids.order1}/items/${poulet.id}/cancel`).send({ quantity: 1, reason: 'x x x', lossCause: 'OTHER' }).expect(409); // sur une addition
      const b = (await as(waiter).post(`/api/restaurant/orders/${ids.order1}/bills`).send({}).expect(201)).body;
      ids.billB = b.bills[1].id;
      expect(num(b.bills[1].total)).toBe(2 * 500 + 2 * 300 + 600); // cocas servis, croissants déplacés, coca de T2 saisi après la hausse à 600 F
      expect(await floorStatus('T3')).toBe('WAITING_BILL');
      await as(waiter).post(`/api/restaurant/orders/${ids.order1}/bills`).send({}).expect(400); // plus rien à facturer
      const p1 = (await as(waiter).post(`/api/restaurant/bills/${ids.billA}/print`).send({}).expect(201)).body;
      expect(p1.print.status).toBe('BROWSER');
      expect(p1.lines.join('\n')).toContain('ADDITION');
      expect(p1.lines.join('\n')).toContain('pas un ticket de caisse');
      expect(p1.lines.join('\n')).not.toContain('Réimpression');
      const p2 = (await as(waiter).post(`/api/restaurant/bills/${ids.billA}/print`).send({}).expect(201)).body;
      expect(p2.lines.join('\n')).toContain('Réimpression n° 1');
      expect(await prisma.auditLog.count({ where: { action: 'RESTAURANT_BILL_PRINTED', entityId: ids.billA } })).toBe(2);
      // Annulation d'une addition non payée : ses articles redeviennent à payer.
      await as(waiter).post(`/api/restaurant/bills/${ids.billB}/cancel`).send({ reason: 'Le client recommande' }).expect(201);
      const again = (await as(waiter).post(`/api/restaurant/orders/${ids.order1}/bills`).send({}).expect(201)).body;
      ids.billB = again.bills.find((x: { status: string; id: string }) => x.status === 'OPEN' && x.id !== ids.billA).id;
    });

    it('encaisse une addition par la caisse : plusieurs paiements sur un ticket, sans nouvelle sortie de stock (R18, R20, R25, R26)', async () => {
      const pay = (u: Session, billId: string, body: object) => as(u).post(`/api/restaurant/bills/${billId}/pay`).send(body);
      const movements = await prisma.stockMovement.count();
      await pay(waiter, ids.billA, { sessionId: ids.cashierSession, payments: [{ method: 'CASH', amount: 5200 }] }).expect(403);
      await pay(cashier, ids.billA, { sessionId: ids.managerSession, payments: [{ method: 'CASH', amount: 5200 }] }).expect(403); // session d'un autre
      await pay(cashier, ids.billA, { sessionId: ids.cashierSession, payments: [{ method: 'CASH', amount: 5000 }] }).expect(400); // paiement intégral
      await pay(cashier, ids.billA, { sessionId: ids.cashierSession, payments: [{ method: 'CASH', amount: 5200 }], ticketDiscountAmount: 200, ticketDiscountReason: 'Fidèle' }).expect(403); // remise
      const key = randomUUID();
      const body = { clientRequestId: key, sessionId: ids.cashierSession, payments: [{ method: 'CASH', amount: 3000 }, { method: 'WAVE', amount: 2200, reference: 'WV-123' }] };
      const r = (await pay(cashier, ids.billA, body).expect(201)).body;
      const again = (await pay(cashier, ids.billA, body).expect(201)).body;
      expect(again.sale.id).toBe(r.sale.id);
      await pay(cashier, ids.billA, { ...body, clientRequestId: randomUUID() }).expect(409); // déjà payée
      expect(r.sale.number).toBe(`RES-TKT-${year}-000001`);
      expect([num(r.sale.total), num(r.sale.costTotal), r.sale.payments.length]).toEqual([5200, 1360 + 50, 2]);
      expect(r.sale.items.every((i: { lots: unknown[] }) => i.lots.length === 0)).toBe(true);
      expect(r.ticket.lines.join('\n')).toContain(`Commande RES-RST-${year}-000001 — Table T3`);
      expect(await prisma.stockMovement.count()).toBe(movements);
      const mv = await prisma.cashMovement.findMany({ where: { saleId: r.sale.id }, orderBy: { method: 'asc' } });
      expect(mv.map((m) => [m.method, num(m.amount)])).toEqual([['CASH', 3000], ['WAVE', 2200]]);
      expect(r.order.status).toBe('OPEN'); // reste l'addition B
      ids.saleA = r.sale.id;
    });

    it('solde la commande au dernier paiement, table en nettoyage puis libre (R8)', async () => {
      const r = (
        await as(manager)
          .post(`/api/restaurant/bills/${ids.billB}/pay`)
          .send({ sessionId: ids.managerSession, payments: [{ method: 'CASH', amount: 5000 }], ticketDiscountAmount: 100, ticketDiscountReason: 'Attente trop longue' })
          .expect(201)
      ).body;
      expect([num(r.sale.total), num(r.sale.changeGiven)]).toEqual([2100, 2900]);
      expect(r.order.status).toBe('PAID');
      expect(await floorStatus('T3')).toBe('CLEANING');
      await open(waiter, { mode: 'TABLE', tableId: ids.T3 }).expect(409); // à nettoyer d'abord
      ids.saleB = r.sale.id;
      expect(await prisma.auditLog.count({ where: { action: 'RESTAURANT_ORDER_PAID', entityId: ids.order1 } })).toBe(1);
    });

    it('rouvre la commande si le ticket est annulé à la caisse, sans toucher au stock (R27)', async () => {
      const movements = await prisma.stockMovement.count();
      const cancelled = await as(manager).post(`/api/sales/${ids.saleB}/cancel`).send({ reason: 'Erreur de moyen de paiement' });
      expect([cancelled.status, cancelled.body.message]).toEqual([201, undefined]);
      expect(await prisma.stockMovement.count()).toBe(movements);
      const order = (await as(waiter).get(`/api/restaurant/orders/${ids.order1}`).expect(200)).body;
      expect(order.status).toBe('OPEN');
      expect(order.bills.find((b: { id: string }) => b.id === ids.billB).status).toBe('CANCELLED');
      expect(num(order.totals.toBill)).toBe(2200);
      expect(await floorStatus('T3')).toBe('OCCUPIED');
      const bill = (await as(waiter).post(`/api/restaurant/orders/${ids.order1}/bills`).send({}).expect(201)).body.bills.at(-1);
      const r = (await as(cashier).post(`/api/restaurant/bills/${bill.id}/pay`).send({ sessionId: ids.cashierSession, payments: [{ method: 'CASH', amount: 2200 }] }).expect(201)).body;
      expect(r.order.status).toBe('PAID');
      await as(waiter).post(`/api/restaurant/tables/${ids.T3}/state`).send({ state: 'AVAILABLE' }).expect(201);
      expect(await floorStatus('T3')).toBe('FREE');
      expect(await prisma.auditLog.count({ where: { action: 'RESTAURANT_BILL_REOPENED' } })).toBe(1);
    });
  });

  describe('Réservations et salle', () => {
    it('rend la table réservée avant l’heure et passe la réservation « arrivée » à l’ouverture (R9)', async () => {
      const at = new Date(Date.now() + 30 * 60_000).toISOString();
      const r = (await as(waiter).post('/api/restaurant/reservations').send({ establishmentId: res, reservedAt: at, covers: 4, name: 'Famille Kouassi', phone: '0707070707', tableId: ids.T1 }).expect(201)).body;
      expect(await floorStatus('T1')).toBe('RESERVED');
      const o = (await open(waiter, { mode: 'TABLE', tableId: ids.T1, reservationId: r.id, covers: 4 }).expect(201)).body;
      expect((await prisma.restaurantReservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('SEATED');
      await as(waiter).post(`/api/restaurant/reservations/${r.id}/status`).send({ status: 'NO_SHOW' }).expect(409);
      await as(waiter).post(`/api/restaurant/orders/${o.id}/cancel`).send({ reason: 'Clients repartis' }).expect(201);
      const r2 = (await as(waiter).post('/api/restaurant/reservations').send({ establishmentId: res, reservedAt: at, covers: 2, name: 'M. Bamba' }).expect(201)).body;
      await as(waiter).post(`/api/restaurant/reservations/${r2.id}/status`).send({ status: 'NO_SHOW' }).expect(201);
      expect((await as(waiter).get(`/api/restaurant/reservations?date=${at.slice(0, 10)}`).expect(200)).body).toHaveLength(2);
    });

    it('met une table hors service (responsable) et refuse de l’ouvrir', async () => {
      await as(waiter).post(`/api/restaurant/tables/${ids.T4}/state`).send({ state: 'OUT_OF_SERVICE' }).expect(403);
      await as(manager).post(`/api/restaurant/tables/${ids.T4}/state`).send({ state: 'OUT_OF_SERVICE' }).expect(201);
      expect(await floorStatus('T4')).toBe('OUT_OF_SERVICE');
      await open(waiter, { mode: 'TABLE', tableId: ids.T4 }).expect(409);
      await as(manager).post(`/api/restaurant/tables/${ids.T4}/state`).send({ state: 'AVAILABLE' }).expect(201);
    });
  });

  describe('Concurrence', () => {
    it('envoie simultanément sur les mêmes ingrédients sans interblocage ni stock négatif (R24)', async () => {
      const viande = await qtyOf({ rawMaterialId: ids.viande });
      const orders = [];
      for (let i = 0; i < 6; i++) {
        const o = (await open(i % 2 ? waiter : waiter2, { mode: 'TAKEAWAY', customerName: `Client ${i}` }).expect(201)).body.id;
        await add(waiter, o, [{ productId: ids.poulet, quantity: 1 }, { productId: ids.coca, quantity: 1 }]).expect(201);
        orders.push(o);
      }
      const results = await Promise.all(orders.map((o, i) => send(i % 2 ? waiter : waiter2, o)));
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
      expect(await qtyOf({ rawMaterialId: ids.viande })).toBeCloseTo(viande - 1.8, 4);

      // Un seul kilo de bœuf : deux brochettes de 600 g envoyées en même temps, une seule passe.
      const a = (await open(waiter, { mode: 'COUNTER' }).expect(201)).body.id;
      const b = (await open(waiter2, { mode: 'COUNTER' }).expect(201)).body.id;
      await add(waiter, a, [{ productId: ids.brochette, quantity: 1 }]).expect(201);
      await add(waiter2, b, [{ productId: ids.brochette, quantity: 1 }]).expect(201);
      const race = await Promise.all([send(waiter, a), send(waiter2, b)]);
      expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await qtyOf({ rawMaterialId: ids.boeuf })).toBeCloseTo(0.4, 4);
      ids.takeaway = orders[0];
    });

    it('ne laisse passer qu’un encaissement pour une addition disputée', async () => {
      const bill = (await as(waiter).post(`/api/restaurant/orders/${ids.takeaway}/bills`).send({}).expect(201)).body.bills[0];
      const [a, b] = await Promise.all([
        as(cashier).post(`/api/restaurant/bills/${bill.id}/pay`).send({ sessionId: ids.cashierSession, payments: [{ method: 'CASH', amount: 5600 }] }),
        as(manager).post(`/api/restaurant/bills/${bill.id}/pay`).send({ sessionId: ids.managerSession, payments: [{ method: 'CASH', amount: 5600 }] }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await prisma.restaurantBill.count({ where: { id: bill.id, status: 'PAID' } })).toBe(1);
      expect(await prisma.sale.count({ where: { id: (a.status === 201 ? a : b).body.sale.id } })).toBe(1);
    });
  });

  describe('Formules', () => {
    it('envoie une formule : la recette du plat et la boisson sortent du stock, la formule est vendue à son prix', async () => {
      const [viande, coca] = [await qtyOf({ rawMaterialId: ids.viande }), await qtyOf({ productId: ids.coca })];
      const o = (await open(waiter, { mode: 'TAKEAWAY', customerName: 'Awa' }).expect(201)).body.id;
      await add(waiter, o, [{ productId: ids.formule, quantity: 2 }]).expect(201);
      const sent = (await send(waiter, o).expect(201)).body;
      expect(await qtyOf({ rawMaterialId: ids.viande })).toBeCloseTo(viande - 0.6, 4);
      expect(await qtyOf({ productId: ids.coca })).toBe(coca - 2);
      const formule = itemOf(sent, ids.formule);
      expect([formule.isMenu, num(formule.amount), num(formule.costTotal)]).toEqual([true, 10600, 2 * (1200 + 160) + 2 * 350]);
      const bill = (await as(waiter).post(`/api/restaurant/orders/${o}/bills`).send({}).expect(201)).body.bills[0];
      const r = (await as(cashier).post(`/api/restaurant/bills/${bill.id}/pay`).send({ sessionId: ids.cashierSession, payments: [{ method: 'CASH', amount: 10600 }] }).expect(201)).body;
      expect([r.sale.items[0].isMenu, num(r.sale.items[0].costTotal), num(r.sale.taxTotal)]).toEqual([true, 3420, 0]);
    });
  });

  describe('Droits et isolation', () => {
    it('isole les établissements et applique la matrice des droits (R29)', async () => {
      await as(waiterYop, yop).get(`/api/restaurant/orders/${ids.order1}`).expect(404);
      expect((await as(waiterYop, yop).get('/api/restaurant/orders').expect(200)).body).toHaveLength(0);
      const floor = (await as(waiterYop, yop).get('/api/restaurant/floor').expect(200)).body;
      expect(floor.flatMap((a: { tables: { code: string }[] }) => a.tables.map((t) => t.code))).toEqual(['Y1']);
      await as(waiterYop, res).get('/api/restaurant/floor').expect(403);
      await as(waiterYop, yop).post('/api/restaurant/orders').send({ establishmentId: res, mode: 'COUNTER' }).expect(403);
      await as(accountant).post('/api/restaurant/orders').send({ establishmentId: res, mode: 'COUNTER' }).expect(403);
      await as(chef).post('/api/restaurant/orders').send({ establishmentId: res, mode: 'COUNTER' }).expect(403);
      await as(storekeeper).get('/api/restaurant/kitchen').expect(200).expect((r) => expect(r.body).toHaveLength(0)); // aucun droit restaurant : rien
      await as(cashier).post('/api/restaurant/orders').send({ establishmentId: res, mode: 'COUNTER' }).expect(201); // caissier : comptoir
      await as(waiter).post('/api/restaurant/tables').send({ areaId: ids.salle, code: 'T9', capacity: 2 }).expect(403);
    });
  });

  describe('Traçabilité', () => {
    it('remonte d’une commande aux lots, à la production et aux matières premières', async () => {
      const t = (await as(manager).get(`/api/restaurant/orders/${ids.order1}/trace`).expect(200)).body;
      expect(t.canTrace).toBe(true);
      const poulet = t.items.find((i: { productName: string }) => i.productName === 'Poulet braisé');
      const viande = poulet.lots.find((l: { lotId: string }) => l.lotId === ids.viandeLot);
      expect([num(viande.quantity), num(viande.lost)]).toEqual([0.6, 0.3]);
      expect(viande.upstream.supplier.name).toBe('SIPRA');
      const croissant = t.items.find((i: { productName: string; status: string }) => i.productName === 'Croissant' && i.status === 'READY');
      expect(croissant.lots[0].upstream.production.number).toBe(ids.productionNumber);
      expect(croissant.lots[0].upstream.inputs[0].lot.lotId).toBe(ids.farineLot);
      const w = (await as(waiter).get(`/api/restaurant/orders/${ids.order1}/trace`).expect(200)).body;
      expect([w.canTrace, w.items[0].lots[0].upstream]).toEqual([false, null]);
    });

    it('descend d’un lot de farine aux croissants, aux commandes et aux tickets', async () => {
      const farine = await prisma.stockLot.findUniqueOrThrow({ where: { id: ids.farineLot } });
      const r = (await as(manager).get(`/api/restaurant/traceability?lotNumber=${farine.lotNumber}`).expect(200)).body;
      expect(r.lots.map((l: { id: string }) => l.id)).toEqual([ids.farineLot, ids.croissantLot]);
      const line = r.orders.find((o: { orderId: string }) => o.orderId === ids.order1);
      expect([line.product, num(line.quantity), line.sale.number]).toEqual(['Croissant', 2, `RES-TKT-${year}-000003`]);
      expect((await as(waiterYop, yop).get(`/api/restaurant/traceability/lots/${ids.farineLot}`).expect(200)).body.orders).toHaveLength(0);
    });
  });

  describe('Protections en base', () => {
    it('ne supprime rien et fige les articles envoyés', async () => {
      const sent = await prisma.restaurantOrderItem.findFirstOrThrow({ where: { orderId: ids.order1, status: { not: 'DRAFT' } } });
      await expect(prisma.$executeRaw`UPDATE restaurant_order_items SET unit_price = 1 WHERE id = ${sent.id}::uuid`).rejects.toThrow(/modification interdite/);
      await expect(prisma.$executeRaw`DELETE FROM restaurant_order_items WHERE id = ${sent.id}::uuid`).rejects.toThrow(/suppression interdite/);
      await expect(prisma.$executeRaw`DELETE FROM restaurant_orders WHERE id = ${ids.order1}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`UPDATE restaurant_bills SET total = 1`).rejects.toThrow(/modifiables/);
      await expect(prisma.$executeRaw`DELETE FROM restaurant_consumptions`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`DELETE FROM restaurant_bill_items`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`DELETE FROM restaurant_tables`).rejects.toThrow();
      const removed = await prisma.restaurantOrderItem.findFirstOrThrow({ where: { status: 'REMOVED' } });
      await expect(prisma.$executeRaw`UPDATE restaurant_order_items SET status = 'DRAFT' WHERE id = ${removed.id}::uuid`).rejects.toThrow(/définitif/);
    });
  });
});
