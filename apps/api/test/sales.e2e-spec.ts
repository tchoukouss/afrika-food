import { INestApplication } from '@nestjs/common';
import { AddressInfo, createServer, Server } from 'node:net';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v);
const year = new Date().getUTCFullYear();

/** Imprimante thermique simulée : un serveur TCP qui garde ce qu'il reçoit. */
async function fakePrinter() {
  const received: string[] = [];
  const server: Server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => received.push(Buffer.concat(chunks).toString('latin1')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  /** Attend que l'imprimante ait reçu `count` tickets (la réception TCP est asynchrone). */
  const waitFor = async (count: number) => {
    for (let i = 0; i < 100 && received.length < count; i++) await new Promise((r) => setTimeout(r, 20));
    return received.at(-1) ?? '';
  };
  return { server, received, waitFor, port: (server.address() as AddressInfo).port };
}

/** Port local fermé : imprimante éteinte. */
async function closedPort() {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

describe('Module 5 — Caisse & ventes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: Session & { id: string }; // Responsable Plateau
  let cashier: Session & { id: string }; // Caissier Plateau
  let cashier2: Session & { id: string }; // Second caissier Plateau
  let accountant: Session & { id: string }; // Comptable Plateau
  let storekeeper: Session & { id: string }; // Magasinier Plateau
  let cashierYop: Session & { id: string }; // Caissier Yopougon
  let plateau: string;
  let yopougon: string;
  let printer: Awaited<ReturnType<typeof fakePrinter>>;
  const ids: Record<string, string> = {};

  const qtyOf = async (productId: string, establishmentId = plateau) =>
    num((await prisma.stockBalance.aggregate({ where: { establishmentId, productId }, _sum: { quantity: true } }))._sum.quantity ?? 0);
  const sell = (s: Session, sessionId: string, lines: object[], payments: object[], extra: object = {}) =>
    api(app, s, plateau).post('/api/sales').send({ sessionId, lines, payments, ...extra });
  const cash = (amount: number) => [{ method: 'CASH', amount }];

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    printer = await fakePrinter();
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'PATISSERIE_RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', plateau);
    cashier = await user('caisse@test.ci', 'CASHIER', plateau);
    cashier2 = await user('caisse2@test.ci', 'CASHIER', plateau);
    accountant = await user('compta@test.ci', 'ACCOUNTANT', plateau);
    storekeeper = await user('mag@test.ci', 'STOREKEEPER', plateau);
    cashierYop = await user('caisseyop@test.ci', 'CASHIER', yopougon);

    // Catalogue : produit fabriqué, produits revendus (dont un avec TVA), menu.
    const raw = async (code: string, name: string) => (await api(app, admin).post('/api/raw-materials').send({ code, name, baseUnitCode: 'KG', isPerishable: true }).expect(201)).body.id;
    ids.farine = await raw('FAR', 'Farine T55');
    ids.beurre = await raw('BEU', 'Beurre');
    const product = async (code: string, name: string, type: string, extra: object = {}) => (await api(app, admin).post('/api/products').send({ code, name, type, ...extra }).expect(201)).body.id;
    ids.croissant = await product('CRO', 'Croissant', 'MANUFACTURED', { basePrice: 300 });
    ids.coca = await product('COCA', 'Coca 33 cl', 'RESOLD', { basePrice: 500 });
    ids.jus = await product('JUS', 'Jus de bissap', 'RESOLD', { basePrice: 1000, taxRate: 18 });
    ids.eau = await product('EAU', 'Eau minérale', 'RESOLD', { basePrice: 250 });
    ids.menu = await product('PDJ', 'Petit-déjeuner', 'MENU', { basePrice: 700, components: [{ productId: ids.croissant, quantity: 1 }, { productId: ids.coca, quantity: 1 }] });
    ids.sansPrix = await product('SANS', 'Sans prix', 'RESOLD');
    ids.gma = (await api(app, admin).post('/api/suppliers').send({ code: 'GMA', name: 'Grands Moulins' }).expect(201)).body.id;
    ids.soc = (await api(app, admin).post('/api/suppliers').send({ code: 'SOC', name: 'Solibra' }).expect(201)).body.id;
    // Prix local à Plateau pour l'eau (exception d'établissement).
    await api(app, admin).put(`/api/products/${ids.eau}/price`).send({ price: 300, establishmentId: plateau }).expect(200);

    const receive = (item: object, supplierId: string, qty: number, price: number, expiry?: string) =>
      api(app, storekeeper, plateau)
        .post('/api/goods-receipts')
        .send({ establishmentId: plateau, supplierId, items: [{ ...item, purchaseUnitLabel: 'U', quantityPerPurchaseUnit: 1, receivedQuantity: qty, unitPrice: price, expiryDate: expiry }] })
        .expect(201);
    await receive({ rawMaterialId: ids.farine }, ids.gma, 50, 700, inDays(60));
    await receive({ rawMaterialId: ids.beurre }, ids.gma, 10, 4000, inDays(30));
    await receive({ productId: ids.coca }, ids.soc, 20, 350, inDays(90)); // lot A
    await receive({ productId: ids.coca }, ids.soc, 10, 360, inDays(10)); // lot B : périme plus tôt (FEFO)
    await receive({ productId: ids.coca }, ids.soc, 5, 300, inDays(1)); // lot C : rendu périmé ci-dessous
    await receive({ productId: ids.jus }, ids.soc, 10, 600);
    await receive({ productId: ids.eau }, ids.soc, 3, 100);
    const cocaLots = await prisma.stockLot.findMany({ where: { productId: ids.coca }, orderBy: { createdAt: 'asc' } });
    [ids.cocaA, ids.cocaB, ids.cocaC] = cocaLots.map((l) => l.id);
    await prisma.stockLot.update({ where: { id: ids.cocaC }, data: { expiryDate: new Date(`${inDays(-2)}T00:00:00Z`) } });

    // Croissants fabriqués par le module 4 (pour la traçabilité matière → vente).
    const recipe = await api(app, admin)
      .post('/api/recipes')
      .send({ productId: ids.croissant, yieldQuantity: 10, shelfLifeDays: 2, items: [{ rawMaterialId: ids.farine, quantity: 1000, unitCode: 'G' }, { rawMaterialId: ids.beurre, quantity: 500, unitCode: 'G' }] })
      .expect(201);
    await api(app, admin).post(`/api/recipe-versions/${recipe.body.versions[0].id}/activate`).expect(201);
    const order = await api(app, manager, plateau).post('/api/production-orders').send({ establishmentId: plateau, productId: ids.croissant, plannedQuantity: 30 }).expect(201);
    for (const step of ['validate', 'start']) await api(app, manager, plateau).post(`/api/production-orders/${order.body.id}/${step}`).expect(201);
    await api(app, manager, plateau).post(`/api/production-orders/${order.body.id}/complete`).send({ producedQuantity: 30 }).expect(201);
    ids.productionNumber = order.body.number;
    ids.croissantLot = (await prisma.productionOutput.findFirstOrThrow({ where: { orderId: order.body.id } })).lotId;
    ids.farineLot = (await prisma.stockLot.findFirstOrThrow({ where: { rawMaterialId: ids.farine } })).id;
    ids.principal = (await prisma.stockLocation.findFirstOrThrow({ where: { establishmentId: plateau, isDefault: true } })).id;
  });

  afterAll(async () => {
    printer.server.close();
    await app.close();
  });

  describe('Caisses et sessions', () => {
    it('configure les caisses par le responsable de l’établissement (décision 17)', async () => {
      const body = { establishmentId: plateau, code: 'c1', name: 'Caisse comptoir', printerType: 'NETWORK', printerHost: '127.0.0.1', printerPort: printer.port, paperWidth: 80 };
      await api(app, cashier, plateau).post('/api/cash-registers').send(body).expect(403);
      await api(app, accountant, plateau).post('/api/cash-registers').send(body).expect(403); // pas « mouvements de caisse »
      await api(app, manager, plateau).post('/api/cash-registers').send({ ...body, printerHost: '8.8.8.8' }).expect(400); // réseau local uniquement
      await api(app, manager, plateau).post('/api/cash-registers').send({ ...body, printerHost: null }).expect(400); // IP obligatoire
      await api(app, manager, plateau).post('/api/cash-registers').send({ ...body, establishmentId: yopougon }).expect(403);
      const c1 = await api(app, manager, plateau).post('/api/cash-registers').send(body).expect(201);
      expect([c1.body.code, c1.body.stockLocationId]).toEqual(['C1', ids.principal]); // décision 1 : Magasin principal par défaut
      ids.c1 = c1.body.id;
      await api(app, manager, plateau).post('/api/cash-registers').send(body).expect(409); // code en double
      ids.c2 = (await api(app, manager, plateau).post('/api/cash-registers').send({ establishmentId: plateau, code: 'C2', name: 'Caisse terrasse' }).expect(201)).body.id;
      ids.c3 = (await api(app, manager, plateau).post('/api/cash-registers').send({ establishmentId: plateau, code: 'C3', name: 'Caisse 3', printerType: 'NONE' }).expect(201)).body.id;
      ids.yop1 = (await api(app, admin).post('/api/cash-registers').send({ establishmentId: yopougon, code: 'Y1', name: 'Caisse Yop' }).expect(201)).body.id;

      const test = await api(app, manager, plateau).post(`/api/cash-registers/${ids.c1}/test-print`).expect(201);
      expect(test.body.ok).toBe(true);
      expect(await printer.waitFor(1)).toContain('TEST D');
      // Le caissier voit les caisses de son établissement, pas celles de Yopougon.
      const list = await api(app, cashier, plateau).get('/api/cash-registers').expect(200);
      expect(list.body.map((r: { code: string }) => r.code).sort()).toEqual(['C1', 'C2', 'C3']);
      expect((await api(app, cashierYop, yopougon).get('/api/cash-registers').expect(200)).body.map((r: { code: string }) => r.code)).toEqual(['Y1']);
    });

    it('ouvre une session : une caisse = un caissier, anti double envoi (décision 5)', async () => {
      const key = randomUUID();
      const s1 = await api(app, cashier, plateau).post('/api/cash-sessions').send({ clientRequestId: key, registerId: ids.c1, openingFloat: 10000 }).expect(201);
      expect(s1.body.number).toBe(`PLT-SES-${year}-000001`);
      const again = await api(app, cashier, plateau).post('/api/cash-sessions').send({ clientRequestId: key, registerId: ids.c1, openingFloat: 10000 }).expect(201);
      expect(again.body.id).toBe(s1.body.id);
      ids.s1 = s1.body.id;
      await api(app, cashier2, plateau).post('/api/cash-sessions').send({ registerId: ids.c1, openingFloat: 0 }).expect(409); // caisse occupée
      await api(app, cashier, plateau).post('/api/cash-sessions').send({ registerId: ids.c2, openingFloat: 0 }).expect(409); // caissier déjà en session
      await api(app, cashierYop, yopougon).post('/api/cash-sessions').send({ registerId: ids.c2, openingFloat: 0 }).expect(403);
      expect((await api(app, cashier, plateau).get('/api/cash-sessions/current').expect(200)).body.session.id).toBe(ids.s1);
      expect(await prisma.cashMovement.count({ where: { sessionId: ids.s1, type: 'OPENING_FLOAT' } })).toBe(1);

      // Deux ouvertures simultanées de la même caisse : une seule réussit.
      const [a, b] = await Promise.all([
        api(app, cashier2, plateau).post('/api/cash-sessions').send({ registerId: ids.c2, openingFloat: 5000 }),
        api(app, manager, plateau).post('/api/cash-sessions').send({ registerId: ids.c2, openingFloat: 5000 }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const winner = a.status === 201 ? a : b;
      ids.s2 = winner.body.id;
      ids.s2Owner = a.status === 201 ? 'cashier2' : 'manager';
      expect(await prisma.cashSession.count({ where: { registerId: ids.c2, status: 'OPEN' } })).toBe(1);
      // Le second ouvre sur la caisse 3.
      const loser = a.status === 201 ? manager : cashier2;
      ids.s3 = (await api(app, loser, plateau).post('/api/cash-sessions').send({ registerId: ids.c3, openingFloat: 5000 }).expect(201)).body.id;
      ids.managerSession = ids.s2Owner === 'manager' ? ids.s2 : ids.s3;
      ids.cashier2Session = ids.s2Owner === 'manager' ? ids.s3 : ids.s2;
    });
  });

  describe('Encaissement', () => {
    it('encaisse une vente : FEFO, TVA incluse, rendu monnaie, impression réseau, audit', async () => {
      const cocaB = await prisma.stockBalance.findFirstOrThrow({ where: { lotId: ids.cocaB } });
      const printed = printer.received.length;
      const res = await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 2 }, { productId: ids.jus, quantity: 1 }, { productId: ids.eau, quantity: 1 }], cash(5000)).expect(201);
      const sale = res.body.sale;
      ids.sale1 = sale.id;
      expect(sale.number).toBe(`PLT-TKT-${year}-000001`);
      expect(sale.items.map((i: { productId: string }) => i.productId)).toEqual([ids.coca, ids.jus, ids.eau]); // ordre de saisie
      expect([num(sale.total), num(sale.taxTotal), num(sale.paidTotal), num(sale.changeGiven)]).toEqual([2300, 153, 5000, 2700]); // eau au prix local 300
      // FEFO : le lot B (périme plus tôt, non périmé) part en premier ; le lot C périmé n'est jamais vendu.
      const coca = sale.items.find((i: { productId: string }) => i.productId === ids.coca);
      expect(coca.lots.map((l: { lotId: string; quantity: string }) => [l.lotId, num(l.quantity)])).toEqual([[ids.cocaB, 2]]);
      expect(num((await prisma.stockBalance.findFirstOrThrow({ where: { lotId: ids.cocaB } })).quantity)).toBe(num(cocaB.quantity) - 2);
      expect(num(coca.costTotal)).toBe(720);
      const movements = await prisma.stockMovement.findMany({ where: { originId: sale.id } });
      expect(movements.every((m) => m.type === 'SALE' && num(m.quantity) < 0)).toBe(true);
      expect(movements).toHaveLength(3);
      const cashMv = await prisma.cashMovement.findMany({ where: { saleId: sale.id } });
      expect(cashMv.map((m) => [m.type, m.method, num(m.amount)])).toEqual([['SALE', 'CASH', 2300]]);
      // Ticket imprimé sur l'imprimante réseau.
      expect(res.body.print.status).toBe('PRINTED');
      const text = await printer.waitFor(printed + 1);
      expect(text).toContain(sale.number);
      expect(text).toContain('TOTAL TTC');
      expect(text).toContain('TVA 18 %');
      expect(res.body.ticket.lines.join('\n')).toContain('Monnaie rendue');
      expect(await prisma.auditLog.count({ where: { action: 'SALE_CREATED', entityId: sale.id } })).toBe(1);
    });

    it('refuse les ventes invalides sans toucher au stock', async () => {
      const before = await qtyOf(ids.coca);
      await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1000 }], cash(500000)).expect(409); // stock insuffisant (décision 2)
      await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1, unitPrice: 1 }], cash(500)).expect(400); // prix non modifiable (décision 9)
      await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1, discountPercent: 10, discountReason: 'Fidèle' }], cash(500)).expect(403); // remise sans droit
      await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1 }], cash(400)).expect(400); // paiement insuffisant
      await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1 }], [{ method: 'WAVE', amount: 1000, reference: 'W1' }]).expect(400); // monnaie hors espèces
      await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1 }], [{ method: 'ORANGE_MONEY', amount: 500 }]).expect(400); // référence obligatoire
      await sell(cashier, ids.s1, [{ productId: ids.sansPrix, quantity: 1 }], cash(500)).expect(409); // pas de prix
      await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1 }], []).expect(400); // paiement manquant
      await sell(cashier2, ids.s1, [{ productId: ids.coca, quantity: 1 }], cash(500)).expect(403); // session d'un autre caissier
      await sell(accountant, ids.s1, [{ productId: ids.coca, quantity: 1 }], cash(500)).expect(403); // pas « créer une vente »
      await api(app, admin).put(`/api/products/${ids.eau}/availability`).send({ establishmentId: plateau, isAvailable: false }).expect(200);
      await sell(cashier, ids.s1, [{ productId: ids.eau, quantity: 1 }], cash(500)).expect(409); // indisponible
      await api(app, admin).put(`/api/products/${ids.eau}/availability`).send({ establishmentId: plateau, isAvailable: true }).expect(200);
      expect(await qtyOf(ids.coca)).toBe(before);
      // Le numéro attribué à la vente refusée pour stock insuffisant est tracé, jamais réutilisé (décision 13).
      const voided = await prisma.auditLog.findMany({ where: { action: 'SALE_NUMBER_VOIDED' } });
      expect(voided.length).toBeGreaterThanOrEqual(1);
      expect(voided[0].reason).toContain('Stock insuffisant');
      const next = await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1 }], cash(500)).expect(201);
      expect(next.body.sale.number > `PLT-TKT-${year}-000001`).toBe(true);
      expect((voided[0].newValues as { number: string }).number).not.toBe(next.body.sale.number);
    });

    it('applique remises (ligne et ticket, avec motif) et paiements multiples (décisions 8 et 11)', async () => {
      const lines = [{ productId: ids.coca, quantity: 2, discountPercent: 10, discountReason: 'Client fidèle' }, { productId: ids.jus, quantity: 1 }];
      await sell(manager, ids.managerSession, lines, cash(5000), { ticketDiscountAmount: 100 }).expect(400); // motif ticket manquant
      await sell(manager, ids.managerSession, [{ productId: ids.coca, quantity: 1, discountAmount: 600, discountReason: 'Trop' }], cash(500)).expect(400); // remise > montant
      const res = await sell(manager, ids.managerSession, lines, [{ method: 'WAVE', amount: 1000, reference: 'WV-778' }, { method: 'CASH', amount: 2000 }], {
        ticketDiscountAmount: 100,
        ticketDiscountReason: 'Geste commercial',
      }).expect(201);
      const s = res.body.sale;
      // 2 × 500 = 1000 − 10 % = 900 ; + 1000 = 1900 ; − 100 = 1800.
      expect([num(s.grossTotal), num(s.lineDiscountTotal), num(s.ticketDiscountAmount), num(s.total), num(s.changeGiven)]).toEqual([2000, 100, 100, 1800, 1200]);
      const shares = s.items.map((i: { ticketDiscount: string }) => num(i.ticketDiscount));
      expect(shares.reduce((a: number, b: number) => a + b, 0)).toBe(100);
      expect(s.payments.map((p: { method: string; reference: string | null }) => [p.method, p.reference])).toEqual([['WAVE', 'WV-778'], ['CASH', null]]);
      const mv = await prisma.cashMovement.findMany({ where: { saleId: s.id }, orderBy: { method: 'asc' } });
      expect(mv.map((m) => [m.method, num(m.amount)])).toEqual([['CASH', 800], ['WAVE', 1000]]);
      ids.saleMixed = s.id;
    });

    it('vend un menu à son prix : ses composants sortent du stock au coût réel (décision 4)', async () => {
      const croissants = await qtyOf(ids.croissant);
      const res = await sell(cashier, ids.s1, [{ productId: ids.menu, quantity: 2 }], cash(1400)).expect(201);
      const item = res.body.sale.items[0];
      expect([item.isMenu, num(item.lineTotal)]).toEqual([true, 1400]);
      const parts = Object.fromEntries(
        [ids.croissant, ids.coca].map((pid) => [pid, item.lots.filter((l: { productId: string }) => l.productId === pid).reduce((s: number, l: { quantity: string }) => s + num(l.quantity), 0)]),
      );
      expect(parts).toEqual({ [ids.croissant]: 2, [ids.coca]: 2 });
      expect(await qtyOf(ids.croissant)).toBe(croissants - 2);
      expect(num(item.costTotal)).toBeGreaterThan(0);
      ids.saleMenu = res.body.sale.id;
    });

    it('rejoue un double envoi et départage les ventes simultanées sans stock négatif', async () => {
      const key = randomUUID();
      const before = await qtyOf(ids.eau);
      const [a, b] = await Promise.all([
        sell(cashier, ids.s1, [{ productId: ids.eau, quantity: 1 }], cash(300), { clientRequestId: key }),
        sell(cashier, ids.s1, [{ productId: ids.eau, quantity: 1 }], cash(300), { clientRequestId: key }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.sale.id).toBe(b.body.sale.id);
      expect(await qtyOf(ids.eau)).toBe(before - 1);
      // Il reste 1 eau (3 reçues, 1 au ticket n° 1, 1 ci-dessus) : 4 ventes simultanées sur deux caisses, une seule passe.
      const results = await Promise.all([
        sell(cashier, ids.s1, [{ productId: ids.eau, quantity: 1 }], cash(300)),
        sell(cashier2, ids.cashier2Session, [{ productId: ids.eau, quantity: 1 }], cash(300)),
        sell(cashier, ids.s1, [{ productId: ids.eau, quantity: 1 }], cash(300)),
        sell(cashier2, ids.cashier2Session, [{ productId: ids.eau, quantity: 1 }], cash(300)),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      expect(await qtyOf(ids.eau)).toBe(0);
      const numbers = (await prisma.sale.findMany({ select: { number: true } })).map((s) => s.number);
      expect(new Set(numbers).size).toBe(numbers.length);
    });

    it('enchaîne des ventes croisées simultanées sans interblocage, et une seule action sur une vente disputée', async () => {
      const [coca, croissant] = [await qtyOf(ids.coca), await qtyOf(ids.croissant)];
      const ab = [{ productId: ids.coca, quantity: 1 }, { productId: ids.croissant, quantity: 1 }];
      const ba = [...ab].reverse();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => (i % 2 ? sell(cashier, ids.s1, ab, cash(800)) : sell(cashier2, ids.cashier2Session, ba, cash(800)))),
      );
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
      expect([await qtyOf(ids.coca), await qtyOf(ids.croissant)]).toEqual([coca - 8, croissant - 8]);

      // Annulation et remboursement simultanés de la même vente : une seule opération passe.
      const target = results[1].body.sale;
      const [c, r] = await Promise.all([
        api(app, manager, plateau).post(`/api/sales/${target.id}/cancel`).send({ reason: 'Course annulation' }),
        api(app, manager, plateau)
          .post(`/api/sales/${target.id}/refund`)
          .send({ sessionId: ids.managerSession, reason: 'Course remboursement', lines: target.items.map((i: { id: string }) => ({ saleItemId: i.id, quantity: 1, disposition: 'RESTOCK' })) }),
      ]);
      expect([c.status, r.status].sort()).toEqual([201, 409]);
      expect(await prisma.saleReturn.count({ where: { saleId: target.id } })).toBe(1);
      expect([await qtyOf(ids.coca), await qtyOf(ids.croissant)]).toEqual([coca - 7, croissant - 7]);
    });

    it('refuse de vendre sur un emplacement gelé par un inventaire', async () => {
      const inv = await api(app, storekeeper, plateau).post('/api/inventories').send({ establishmentId: plateau, locationId: ids.principal }).expect(201);
      await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1 }], cash(500)).expect(409);
      await api(app, manager, plateau).post(`/api/inventories/${inv.body.id}/cancel`).send({ reason: 'Test caisse' }).expect(201);
    });
  });

  describe('Annulation et remboursement', () => {
    it('annule une vente dans la session ouverte : stock et argent rendus, rien supprimé (décision 7)', async () => {
      const sale = await prisma.sale.findUniqueOrThrow({ where: { id: ids.sale1 }, include: { items: { include: { lots: true } } } });
      const cocaB = num((await prisma.stockBalance.findFirstOrThrow({ where: { lotId: ids.cocaB } })).quantity);
      await api(app, cashier, plateau).post(`/api/sales/${ids.sale1}/cancel`).send({ reason: 'Erreur de saisie' }).expect(403);
      await api(app, manager, plateau).post(`/api/sales/${ids.sale1}/cancel`).send({ reason: '' }).expect(400);
      const res = await api(app, manager, plateau).post(`/api/sales/${ids.sale1}/cancel`).send({ reason: 'Erreur de saisie' }).expect(201);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.returns[0].kind).toBe('CANCEL');
      expect(res.body.returns[0].number).toMatch(new RegExp(`^PLT-RMB-${year}-[0-9]{6}$`));
      // Retour dans les mêmes lots.
      expect(num((await prisma.stockBalance.findFirstOrThrow({ where: { lotId: ids.cocaB } })).quantity)).toBe(cocaB + 2);
      const back = await prisma.stockMovement.findMany({ where: { type: 'SALE_RETURN', originId: res.body.returns[0].id } });
      expect(back).toHaveLength(sale.items.flatMap((i) => i.lots).length);
      const mv = await prisma.cashMovement.findMany({ where: { saleId: ids.sale1 }, orderBy: { createdAt: 'asc' } });
      expect(mv.map((m) => [m.type, num(m.amount)])).toEqual([['SALE', 2300], ['SALE_CANCEL', -2300]]);
      await api(app, manager, plateau).post(`/api/sales/${ids.sale1}/cancel`).send({ reason: 'Encore' }).expect(409);
      await api(app, manager, plateau).post(`/api/sales/${ids.sale1}/refund`).send({ sessionId: ids.managerSession, reason: 'x x x', lines: [{ saleItemId: sale.items[0].id, quantity: 1, disposition: 'RESTOCK' }] }).expect(409);
      expect(await prisma.auditLog.count({ where: { action: 'SALE_CANCELLED', entityId: ids.sale1 } })).toBe(1);
    });

    it('rembourse partiellement puis totalement, avec remise en stock ou perte « retour client »', async () => {
      const sale = await prisma.sale.findUniqueOrThrow({ where: { id: ids.saleMixed }, include: { items: true } });
      const coca = sale.items.find((i) => i.productId === ids.coca)!;
      const jus = sale.items.find((i) => i.productId === ids.jus)!;
      const url = `/api/sales/${ids.saleMixed}/refund`;
      const body = (lines: object[], extra: object = {}) => ({ sessionId: ids.managerSession, reason: 'Produit défectueux', lines, ...extra });
      await api(app, cashier, plateau).post(url).send(body([{ saleItemId: coca.id, quantity: 1, disposition: 'RESTOCK' }], { sessionId: ids.s1 })).expect(403); // pas le droit
      await api(app, manager, plateau).post(url).send(body([{ saleItemId: coca.id, quantity: 3, disposition: 'RESTOCK' }])).expect(409); // plus que vendu
      await api(app, manager, plateau).post(url).send(body([{ saleItemId: coca.id, quantity: 1, disposition: 'RESTOCK' }], { sessionId: ids.s1 })).expect(409); // session d'un autre
      await api(app, manager, plateau).post(url).send(body([{ saleItemId: coca.id, quantity: 1, disposition: 'RESTOCK' }], { method: 'ORANGE_MONEY' })).expect(400); // non utilisé

      const coca1 = await qtyOf(ids.coca);
      const key = randomUUID();
      const r1 = await api(app, manager, plateau).post(url).send(body([{ saleItemId: coca.id, quantity: 1, disposition: 'RESTOCK' }], { clientRequestId: key })).expect(201);
      await api(app, manager, plateau).post(url).send(body([{ saleItemId: coca.id, quantity: 1, disposition: 'RESTOCK' }], { clientRequestId: key })).expect(201); // rejoué
      expect(r1.body.status).toBe('PARTIALLY_REFUNDED');
      expect(r1.body.returns).toHaveLength(1);
      const lineTotal = num(coca.lineTotal);
      const first = Math.round(lineTotal / 2);
      expect(num(r1.body.refundedTotal)).toBe(first);
      expect(await qtyOf(ids.coca)).toBe(coca1 + 1);

      // Le reste : la dernière unité solde exactement la ligne ; le jus part en perte, remboursé par Wave.
      const r2 = await api(app, manager, plateau)
        .post(url)
        .send(body([{ saleItemId: coca.id, quantity: 1, disposition: 'RESTOCK' }, { saleItemId: jus.id, quantity: 1, disposition: 'LOSS' }], { method: 'WAVE' }))
        .expect(409); // Wave limité à 1000 F
      expect(r2.body.message).toContain('Wave');
      const jusStock = await qtyOf(ids.jus);
      const rest = [{ saleItemId: coca.id, quantity: 1, disposition: 'RESTOCK' }, { saleItemId: jus.id, quantity: 1, disposition: 'LOSS' }];
      const remaining = num(sale.total) - first;
      await api(app, manager, plateau).post(url).send(body(rest)).expect(409); // espèces encaissées : 800 F seulement
      await api(app, manager, plateau).post(url).send(body(rest, { refunds: [{ method: 'CASH', amount: 100 }, { method: 'WAVE', amount: 1000 }] })).expect(400); // total faux
      const r3 = await api(app, manager, plateau).post(url).send(body(rest, { refunds: [{ method: 'CASH', amount: remaining - 1000 }, { method: 'WAVE', amount: 1000 }] })).expect(201);
      expect(r3.body.status).toBe('REFUNDED');
      expect(num(r3.body.refundedTotal)).toBe(num(sale.total));
      expect(await qtyOf(ids.jus)).toBe(jusStock); // perte : pas de retour en stock
      const loss = await prisma.stockLoss.findFirstOrThrow({ where: { productId: ids.jus } });
      expect([loss.cause, num(loss.quantity)]).toEqual(['CUSTOMER_RETURN', 1]);
      const refunds = await prisma.cashMovement.findMany({ where: { saleId: ids.saleMixed, type: 'REFUND' } });
      expect(refunds.reduce((s, m) => s + num(m.amount), 0)).toBe(-num(sale.total));
      expect(refunds.filter((m) => m.method === 'WAVE').map((m) => num(m.amount))).toEqual([-1000]);
      await api(app, manager, plateau).post(url).send(body([{ saleItemId: jus.id, quantity: 1, disposition: 'RESTOCK' }])).expect(409);
      expect(await prisma.auditLog.count({ where: { action: 'SALE_REFUNDED', entityId: ids.saleMixed } })).toBe(2);
    });

    it('protège en base ventes, paiements, mouvements, retours et tickets contre toute suppression', async () => {
      await expect(prisma.$executeRaw`DELETE FROM sales WHERE id = ${ids.saleMenu}::uuid`).rejects.toThrow();
      await expect(prisma.$executeRaw`UPDATE sales SET total = 1 WHERE id = ${ids.saleMenu}::uuid`).rejects.toThrow(/modifiables/);
      await expect(prisma.$executeRaw`UPDATE sale_items SET unit_price = 1 WHERE sale_id = ${ids.saleMenu}::uuid`).rejects.toThrow(/modifiables/);
      await expect(prisma.$executeRaw`DELETE FROM sale_payments`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`UPDATE cash_movements SET amount = 1`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`DELETE FROM sale_returns`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`DELETE FROM print_jobs`).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM cash_sessions`).rejects.toThrow();
    });
  });

  describe('Tickets', () => {
    it('garde un ticket en échec quand l’imprimante est éteinte, puis le relance ou bascule sur le navigateur (décision 12)', async () => {
      const dead = await closedPort();
      await api(app, manager, plateau).patch(`/api/cash-registers/${ids.c1}`).send({ printerPort: dead }).expect(200);
      const res = await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1 }], cash(500)).expect(201); // la vente n'est jamais bloquée
      expect(res.body.print.status).toBe('FAILED');
      expect(res.body.print.lastError).toContain('Imprimante injoignable');
      await api(app, manager, plateau).patch(`/api/cash-registers/${ids.c1}`).send({ printerPort: printer.port }).expect(200);
      const count = printer.received.length;
      const retry = await api(app, cashier, plateau).post(`/api/print-jobs/${res.body.print.id}/retry`).expect(201);
      expect([retry.body.print.status, retry.body.print.attempts]).toEqual(['PRINTED', 2]);
      expect(await printer.waitFor(count + 1)).not.toContain('DUPLICATA');
      expect(printer.received).toHaveLength(count + 1);
      await api(app, cashier, plateau).post(`/api/print-jobs/${res.body.print.id}/retry`).expect(409); // déjà imprimé

      // Repli navigateur après un échec.
      await api(app, manager, plateau).patch(`/api/cash-registers/${ids.c1}`).send({ printerPort: dead }).expect(200);
      const failed = await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1 }], cash(500)).expect(201);
      const browser = await api(app, cashier, plateau).post(`/api/print-jobs/${failed.body.print.id}/browser`).expect(201);
      expect(browser.body.print.status).toBe('BROWSER');
      expect(browser.body.ticket.lines.join('\n')).toContain(failed.body.sale.number);
      await api(app, manager, plateau).patch(`/api/cash-registers/${ids.c1}`).send({ printerPort: printer.port }).expect(200);
      ids.saleBrowser = failed.body.sale.id;
    });

    it('réimprime un DUPLICATA sans créer de vente, avec droit et audit', async () => {
      const sales = await prisma.sale.count();
      const printed = printer.received.length;
      await api(app, cashier, plateau).post(`/api/sales/${ids.saleMenu}/reprint`).expect(403); // pas « réimprimer »
      const res = await api(app, manager, plateau).post(`/api/sales/${ids.saleMenu}/reprint`).expect(201);
      expect(res.body.print).toMatchObject({ kind: 'DUPLICATE', status: 'PRINTED' });
      expect(await printer.waitFor(printed + 1)).toContain('*** DUPLICATA ***');
      expect(res.body.ticket.lines.join('\n')).toContain('DUPLICATA');
      expect(await prisma.sale.count()).toBe(sales);
      expect(await prisma.auditLog.count({ where: { action: 'TICKET_REPRINTED', entityId: ids.saleMenu } })).toBe(1);
      // Caisse sans imprimante réseau (caisse 2 ou 3) : réimpression rendue pour le navigateur.
      const browser = await api(app, manager, plateau).post(`/api/sales/${ids.saleMixed}/reprint`).expect(201);
      expect(browser.body.print.status).toBe('BROWSER');
      // L'aperçu d'un ticket déjà imprimé est marqué DUPLICATA.
      expect((await api(app, cashier, plateau).get(`/api/sales/${ids.saleMenu}/ticket`).expect(200)).body.duplicate).toBe(true);
    });
  });

  describe('Clôture de caisse', () => {
    it('limite les mouvements manuels au responsable, avec motif et sans dépasser les espèces', async () => {
      const url = `/api/cash-sessions/${ids.s1}/movements`;
      await api(app, cashier, plateau).post(url).send({ type: 'MANUAL_OUT', amount: 1000, reason: 'Achat sachets' }).expect(403);
      await api(app, manager, plateau).post(url).send({ type: 'MANUAL_OUT', amount: 1000 }).expect(400); // motif obligatoire
      await api(app, manager, plateau).post(url).send({ type: 'MANUAL_OUT', amount: 10_000_000, reason: 'Trop' }).expect(409);
      await api(app, manager, plateau).post(url).send({ type: 'MANUAL_OUT', amount: 1000, reason: 'Achat sachets' }).expect(201);
      await api(app, manager, plateau).post(url).send({ type: 'MANUAL_IN', amount: 500, reason: 'Appoint monnaie' }).expect(201);
      expect(await prisma.auditLog.count({ where: { action: { in: ['CASH_IN', 'CASH_OUT'] }, entityId: ids.s1 } })).toBe(2);
    });

    it('fait compter et clôturer par le caissier, valider par un autre responsable (décision 6)', async () => {
      const detail = await api(app, cashier, plateau).get(`/api/cash-sessions/${ids.s1}`).expect(200);
      const expectedCash = num(detail.body.expected.find((e: { method: string }) => e.method === 'CASH').amount);
      const sumMovements = (await prisma.cashMovement.findMany({ where: { sessionId: ids.s1, method: 'CASH' } })).reduce((s, m) => s + num(m.amount), 0);
      expect(expectedCash).toBe(sumMovements);
      await api(app, manager, plateau).post(`/api/cash-sessions/${ids.s1}/close`).send({ counts: [{ method: 'CASH', counted: expectedCash }] }).expect(403); // pas son caissier
      await api(app, cashier, plateau).post(`/api/cash-sessions/${ids.s1}/close`).send({ counts: [] }).expect(400); // espèces obligatoires
      const closed = await api(app, cashier, plateau).post(`/api/cash-sessions/${ids.s1}/close`).send({ counts: [{ method: 'CASH', counted: expectedCash - 200 }], note: 'Manque 200' }).expect(201);
      expect(closed.body.status).toBe('CLOSED');
      expect(closed.body.closures.map((c: { method: string; difference: string }) => [c.method, num(c.difference)])).toEqual([['CASH', -200]]); // écart non bloquant
      await sell(cashier, ids.s1, [{ productId: ids.coca, quantity: 1 }], cash(500)).expect(409); // session clôturée
      await api(app, cashier, plateau).post(`/api/cash-sessions/${ids.s1}/close`).send({ counts: [{ method: 'CASH', counted: 0 }] }).expect(409);
      await api(app, cashier, plateau).post(`/api/cash-sessions/${ids.s1}/validate`).send({}).expect(403);
      await api(app, accountant, plateau).post(`/api/cash-sessions/${ids.s1}/validate`).send({}).expect(403); // voit tout mais ne valide pas
      const v = await api(app, manager, plateau).post(`/api/cash-sessions/${ids.s1}/validate`).send({ note: 'Écart expliqué' }).expect(201);
      expect(v.body.status).toBe('VALIDATED');
      await api(app, manager, plateau).post(`/api/cash-sessions/${ids.s1}/validate`).send({}).expect(409);
      // Annulation impossible une fois la session clôturée : il faut un remboursement.
      await api(app, manager, plateau).post(`/api/sales/${ids.saleBrowser}/cancel`).send({ reason: 'Trop tard' }).expect(409);

      const z = await api(app, accountant, plateau).get(`/api/cash-sessions/${ids.s1}/report`).expect(200);
      const cancelled = await prisma.sale.count({ where: { sessionId: ids.s1, status: 'CANCELLED' } });
      expect(cancelled).toBeGreaterThanOrEqual(1);
      expect(z.body.salesByStatus.find((r: { status: string }) => r.status === 'CANCELLED').count).toBe(cancelled);
      expect(z.body.returns.find((r: { kind: string }) => r.kind === 'CANCEL').count).toBe(await prisma.saleReturn.count({ where: { sessionId: ids.s1, kind: 'CANCEL' } }));
      expect(num(z.body.totals.total)).toBeGreaterThan(0);
      expect(await prisma.auditLog.count({ where: { action: { in: ['CASH_SESSION_CLOSED', 'CASH_SESSION_VALIDATED'] }, entityId: ids.s1 } })).toBe(2);
    });
  });

  describe('Droits et isolation', () => {
    it('isole les établissements et filtre selon le rôle', async () => {
      await api(app, cashierYop, yopougon).get(`/api/sales/${ids.saleMenu}`).expect(404);
      expect((await api(app, cashierYop, yopougon).get('/api/sales').expect(200)).body).toHaveLength(0);
      await api(app, cashierYop, plateau).get('/api/sales').expect(403); // établissement non accessible
      await api(app, cashierYop, yopougon).get(`/api/cash-sessions/${ids.s1}`).expect(404);
      // Le comptable voit les ventes et toutes les sessions ; le caissier seulement les siennes.
      expect((await api(app, accountant, plateau).get('/api/sales').expect(200)).body.length).toBeGreaterThan(3);
      const mine = (await api(app, cashier2, plateau).get('/api/cash-sessions').expect(200)).body;
      expect(mine.map((s: { id: string }) => s.id)).toEqual([ids.cashier2Session]);
      expect((await api(app, accountant, plateau).get('/api/cash-sessions').expect(200)).body.length).toBe(3);
      await api(app, cashier2, plateau).get(`/api/cash-sessions/${ids.s1}`).expect(404);
      await api(app, storekeeper, plateau).get('/api/sales').expect(403);
      await api(app, storekeeper, plateau).post('/api/cash-sessions').send({ registerId: ids.c1, openingFloat: 0 }).expect(403);
    });
  });

  describe('Traçabilité', () => {
    it('remonte d’une vente à ses lots, à la production et aux matières premières', async () => {
      const res = await api(app, manager, plateau).get(`/api/sales/${ids.saleMenu}/trace`).expect(200);
      expect(res.body.canTrace).toBe(true);
      const lots = res.body.items[0].lots;
      const croissant = lots.find((l: { lotId: string }) => l.lotId === ids.croissantLot);
      expect(croissant.upstream.production.number).toBe(ids.productionNumber);
      const inputs = croissant.upstream.inputs.map((i: { lot: { lotId: string } }) => i.lot.lotId);
      expect(inputs).toContain(ids.farineLot);
      const coca = lots.find((l: { productId: string }) => l.productId === ids.coca);
      expect(coca.upstream.supplier.name).toBe('Solibra');
      expect(coca.upstream.receipt.number).toMatch(/^PLT-REC-/);
      // Le caissier voit les lots de sa vente, sans l'arbre de stock.
      const c = await api(app, cashier, plateau).get(`/api/sales/${ids.saleMenu}/trace`).expect(200);
      expect([c.body.canTrace, c.body.items[0].lots[0].upstream]).toEqual([false, null]);
    });

    it('descend d’un lot de matière aux produits finis puis aux tickets', async () => {
      const farine = await prisma.stockLot.findUniqueOrThrow({ where: { id: ids.farineLot } });
      const res = await api(app, manager, plateau).get(`/api/traceability/sales?lotNumber=${farine.lotNumber}`).expect(200);
      expect(res.body.lots.map((l: { id: string }) => l.id)).toEqual([ids.farineLot, ids.croissantLot]);
      expect(res.body.lots[1].via).toBe(ids.productionNumber);
      const sale = res.body.sales.find((s: { saleId: string }) => s.saleId === ids.saleMenu);
      expect([sale.soldAs, sale.product, num(sale.quantity)]).toEqual(['Petit-déjeuner', 'Croissant', 2]);
      // Lot de coca vendu puis remis en stock par l'annulation : la vente et le retour sont visibles.
      const cocaB = await api(app, manager, plateau).get(`/api/traceability/lots/${ids.cocaB}/sales`).expect(200);
      const cancelled = cocaB.body.sales.find((s: { saleId: string }) => s.saleId === ids.sale1);
      expect([cancelled.status, num(cancelled.returnedQuantity)]).toEqual(['CANCELLED', 2]);
      expect((await api(app, cashierYop, yopougon).get(`/api/traceability/lots/${ids.cocaB}/sales`).expect(200)).body.sales).toHaveLength(0);
    });
  });
});
