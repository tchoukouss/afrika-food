import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const year = new Date().getUTCFullYear();
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v);

describe('Module 7 — Étape 2 : devis, commandes et événements', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User; // Responsable Plateau : gère devis et commandes
  let managerYop: User; // Responsable Yopougon
  let cashier: User; // Caissier Plateau : consulte
  let waiter: User; // Serveur : aucun accès
  let plateau: string;
  let yopougon: string;
  const ids: Record<string, string> = {};

  const lines = () => [
    { kind: 'PRODUCT', productId: ids.cake, quantity: 2, madeToOrder: true, note: 'Inscription « Joyeux anniversaire Awa »' },
    { kind: 'PRODUCT', productId: ids.coca, quantity: 10 },
    { kind: 'FEE', label: 'Frais de livraison Cocody', quantity: 1, unitPrice: 2000 },
  ];
  const event = () => ({ eventType: 'WEDDING', eventDate: `${inDays(30)}T15:00:00.000Z`, venue: 'Salle Ivoire, Cocody', guests: 250, contactName: 'Mme Kouassi', contactPhone: '0708090807' });
  const quote = (u: Session, body: object = {}, est = plateau) =>
    api(app, u, est).post('/api/quotes').send({ establishmentId: est, customerId: ids.customer, validUntil: inDays(15), lines: lines(), ...body });
  const order = (u: Session, body: object = {}, est = plateau) => api(app, u, est).post('/api/customer-orders').send({ establishmentId: est, customerId: ids.customer, lines: lines(), ...body });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', plateau);
    managerYop = await user('respyop@test.ci', 'MANAGER', yopougon);
    cashier = await user('caisse@test.ci', 'CASHIER', plateau);
    waiter = await user('serveur@test.ci', 'WAITER', plateau);
    const product = async (code: string, name: string, type: string, extra: object) => (await api(app, admin).post('/api/products').send({ code, name, type, ...extra }).expect(201)).body.id;
    ids.cake = await product('GAT', 'Gâteau d’anniversaire 20 parts', 'MANUFACTURED', { basePrice: 25000, taxRate: 18 });
    ids.coca = await product('COCA', 'Coca 33 cl', 'RESOLD', { basePrice: 500 });
    ids.archived = await product('OLD', 'Ancien produit', 'RESOLD', { basePrice: 100 });
    await api(app, admin).patch(`/api/products/${ids.archived}`).send({ isActive: false }).expect(200);
    await api(app, admin).put(`/api/products/${ids.coca}/price`).send({ price: 600, establishmentId: plateau }).expect(200);
    // Stock du Plateau : les coca des commandes confirmées y sont réservés (étape 3).
    const store = await user('mag@test.ci', 'STOREKEEPER', plateau);
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    await api(app, store, plateau)
      .post('/api/goods-receipts')
      .send({ establishmentId: plateau, supplierId: supplier, items: [{ productId: ids.coca, purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, receivedQuantity: 50, unitPrice: 300, expiryDate: inDays(90) }] })
      .expect(201);
    ids.customer = (await api(app, manager, plateau).post('/api/customers').send({ type: 'EVENT', name: 'Famille Kouassi', phone: '0708090807' }).expect(201)).body.id;
    ids.inactive = (await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Client parti' }).expect(201)).body.id;
    await api(app, manager, plateau).patch(`/api/customers/${ids.inactive}`).send({ isActive: false }).expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Devis', () => {
    it('crée un devis à prix figés, lignes produit et frais, avec numéro, historique, audit et anti double envoi', async () => {
      const key = randomUUID();
      const q = (await quote(manager, { clientRequestId: key }).expect(201)).body;
      expect((await quote(manager, { clientRequestId: key }).expect(201)).body.id).toBe(q.id);
      expect([q.number, q.status, q.expired, num(q.total), num(q.taxTotal)]).toEqual([`PLT-DEV-${year}-000001`, 'DRAFT', false, 50000 + 6000 + 2000, 7627]);
      expect(q.lines.map((l: { kind: string; label: string; unitPrice: string; lineTotal: string }) => [l.kind, l.label, num(l.unitPrice), num(l.lineTotal)])).toEqual([
        ['PRODUCT', 'Gâteau d’anniversaire 20 parts', 25000, 50000],
        ['PRODUCT', 'Coca 33 cl', 600, 6000], // prix local de l'établissement
        ['FEE', 'Frais de livraison Cocody', 2000, 2000],
      ]);
      expect(q.lines[2].productId).toBeNull();
      expect(q.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['DRAFT']);
      expect(await prisma.auditLog.count({ where: { action: 'QUOTE_CREATED', entityId: q.id } })).toBe(1);
      ids.quote = q.id;

      // Refus des lignes incohérentes et des clients désactivés.
      await quote(manager, { lines: [{ kind: 'PRODUCT', productId: ids.cake, quantity: 1, unitPrice: 1 }] }).expect(400); // prix non modifiable
      await quote(manager, { lines: [{ kind: 'FEE', quantity: 1, unitPrice: 1000 }] }).expect(400); // frais sans libellé
      await quote(manager, { lines: [{ kind: 'PRODUCT', productId: ids.archived, quantity: 1 }] }).expect(400);
      await quote(manager, { lines: [] }).expect(400);
      await quote(manager, { validUntil: inDays(-1) }).expect(400);
      await quote(manager, { customerId: ids.inactive }).expect(409);
      await quote(manager, { kind: 'EVENT' }).expect(400); // détails d'événement manquants
      await quote(manager, { event: event() }).expect(400); // détails sur un devis non événementiel
    });

    it('applique les permissions et l’isolation entre établissements', async () => {
      await quote(cashier).expect(403);
      await quote(managerYop, {}, plateau).expect(403);
      await quote(waiter).expect(403);
      expect((await api(app, cashier, plateau).get(`/api/quotes/${ids.quote}`).expect(200)).body.canManage).toBe(false);
      await api(app, managerYop, yopougon).get(`/api/quotes/${ids.quote}`).expect(404);
      await api(app, waiter, plateau).get(`/api/quotes/${ids.quote}`).expect(404);
      expect((await api(app, managerYop, yopougon).get('/api/quotes').expect(200)).body).toHaveLength(0);
      expect((await api(app, waiter, plateau).get('/api/quotes').expect(200)).body).toHaveLength(0);
      await api(app, cashier, plateau).post(`/api/quotes/${ids.quote}/send`).expect(403);
      // Le client du groupe sert aussi à Yopougon.
      ids.yopQuote = (await quote(managerYop, { lines: [{ kind: 'FEE', label: 'Traiteur', quantity: 1, unitPrice: 100000 }] }, yopougon).expect(201)).body.id;
    });

    it('modifie en brouillon, puis fige le devis envoyé ; refus motivé ; expiré calculé', async () => {
      const edited = (await api(app, manager, plateau).patch(`/api/quotes/${ids.quote}`).send({ lines: lines().slice(0, 2), notes: 'Livraison retirée' }).expect(200)).body;
      expect([num(edited.total), edited.lines.length]).toEqual([56000, 2]);
      await api(app, manager, plateau).post(`/api/quotes/${ids.quote}/send`).expect(201);
      await api(app, manager, plateau).patch(`/api/quotes/${ids.quote}`).send({ notes: 'Trop tard' }).expect(409);
      await api(app, manager, plateau).post(`/api/quotes/${ids.quote}/send`).expect(409);
      // Hausse de prix après l'envoi : le devis garde ses prix.
      await api(app, admin).put(`/api/products/${ids.cake}/price`).send({ price: 30000 }).expect(200);
      expect(num((await api(app, manager, plateau).get(`/api/quotes/${ids.quote}`).expect(200)).body.lines[0].unitPrice)).toBe(25000);

      const refused = (await quote(manager).expect(201)).body.id;
      await api(app, manager, plateau).post(`/api/quotes/${refused}/refuse`).send({ reason: 'x' }).expect(400); // devis en brouillon / motif trop court
      await api(app, manager, plateau).post(`/api/quotes/${refused}/send`).expect(201);
      await api(app, manager, plateau).post(`/api/quotes/${refused}/refuse`).send({ reason: '' }).expect(400);
      const r = (await api(app, manager, plateau).post(`/api/quotes/${refused}/refuse`).send({ reason: 'Budget dépassé' }).expect(201)).body;
      expect([r.status, r.refuseReason]).toEqual(['REFUSED', 'Budget dépassé']);
      await api(app, manager, plateau).post(`/api/quotes/${refused}/accept`).expect(409);

      // Devis envoyé dont la validité est passée : « expiré » calculé, acceptation refusée.
      const old = (await quote(manager).expect(201)).body.id;
      await prisma.$executeRaw`UPDATE quotes SET status = 'SENT', sent_at = now(), valid_until = CURRENT_DATE - 1 WHERE id = ${old}::uuid`;
      expect((await api(app, manager, plateau).get(`/api/quotes/${old}`).expect(200)).body.expired).toBe(true);
      await api(app, manager, plateau).post(`/api/quotes/${old}/accept`).expect(409);
    });

    it('accepte un devis en créant une seule commande confirmée, même en simultané', async () => {
      await api(app, manager, plateau).post(`/api/quotes/${(await quote(manager).expect(201)).body.id}/accept`).expect(409); // brouillon
      const res = (await api(app, manager, plateau).post(`/api/quotes/${ids.quote}/accept`).expect(201)).body;
      expect([res.quote.status, res.order.status, res.order.quote.number, num(res.order.total)]).toEqual(['ACCEPTED', 'CONFIRMED', res.quote.number, 56000]);
      expect(res.order.lines.map((l: { label: string; unitPrice: string }) => [l.label, num(l.unitPrice)])).toEqual([
        ['Gâteau d’anniversaire 20 parts', 25000], // prix du devis, pas le nouveau prix
        ['Coca 33 cl', 600],
      ]);
      expect(res.order.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['DRAFT', 'CONFIRMED']);
      await api(app, manager, plateau).post(`/api/quotes/${ids.quote}/accept`).expect(409);
      ids.acceptedOrder = res.order.id;

      // Événement : deux acceptations simultanées → une seule commande, avec ses détails en 1 pour 1.
      const ev = (await quote(manager, { kind: 'EVENT', event: event() }).expect(201)).body.id;
      await api(app, manager, plateau).post(`/api/quotes/${ev}/send`).expect(201);
      const [a, b] = await Promise.all([api(app, manager, plateau).post(`/api/quotes/${ev}/accept`), api(app, manager, plateau).post(`/api/quotes/${ev}/accept`)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await prisma.customerOrder.count({ where: { quoteId: ev } })).toBe(1);
      const created = (a.status === 201 ? a : b).body.order;
      expect([created.kind, created.event.eventType, created.event.guests, created.event.venue]).toEqual(['EVENT', 'WEDDING', 250, 'Salle Ivoire, Cocody']);
      expect(await prisma.auditLog.count({ where: { action: 'QUOTE_ACCEPTED', entityId: ev } })).toBe(1);
    });
  });

  describe('Commandes', () => {
    it('crée une commande directe ou événementielle, sans double création simultanée', async () => {
      const key = randomUUID();
      const [a, b] = await Promise.all([order(manager, { clientRequestId: key }), order(manager, { clientRequestId: key })]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect(await prisma.customerOrder.count({ where: { clientRequestId: key } })).toBe(1);
      expect([a.body.number.startsWith(`PLT-CMD-${year}-`), a.body.status, num(a.body.total)]).toEqual([true, 'DRAFT', 60000 + 6000 + 2000]); // nouveau prix du gâteau
      ids.order = a.body.id;
      const ev = (await order(manager, { kind: 'EVENT', event: { ...event(), eventType: 'BAPTISM', guests: 80 } }).expect(201)).body;
      expect([ev.event.eventType, ev.event.guests]).toEqual(['BAPTISM', 80]);
      ids.eventOrder = ev.id;
      await order(manager, { kind: 'EVENT' }).expect(400);
      await order(manager, { event: event() }).expect(400);
      await order(cashier).expect(403);
      await order(managerYop, {}, plateau).expect(403);
      await api(app, managerYop, yopougon).get(`/api/customer-orders/${ids.order}`).expect(404);
      expect((await api(app, cashier, plateau).get('/api/customer-orders?kind=EVENT').expect(200)).body.length).toBe(2);
      // Détails d'événement : une seule ligne par commande.
      await expect(prisma.customerOrderEvent.create({ data: { orderId: ev.id, eventType: 'OTHER', eventDate: new Date() } })).rejects.toThrow();
    });

    it('suit le circuit étape par étape, sans retour ni saut', async () => {
      const url = `/api/customer-orders/${ids.order}`;
      await api(app, manager, plateau).patch(url).send({ lines: lines().slice(1), notes: 'Sans gâteau' }).expect(200);
      await api(app, manager, plateau).post(`${url}/status`).send({ status: 'READY' }).expect(409); // saut
      for (const s of ['CONFIRMED', 'IN_PREPARATION', 'READY']) await api(app, manager, plateau).post(`${url}/status`).send({ status: s }).expect(201);
      // « Livrée » passe par la remise (ou la livraison), qui fait la sortie de stock.
      await api(app, manager, plateau).post(`${url}/status`).send({ status: 'DELIVERED' }).expect(409);
      await api(app, manager, plateau).post(`${url}/hand-over`).expect(201);
      await api(app, manager, plateau).post(`${url}/status`).send({ status: 'COMPLETED' }).expect(201);
      await api(app, manager, plateau).post(`${url}/status`).send({ status: 'COMPLETED' }).expect(409);
      await api(app, manager, plateau).post(`${url}/status`).send({ status: 'DRAFT' }).expect(400);
      await api(app, manager, plateau).patch(url).send({ notes: 'Trop tard' }).expect(409);
      await api(app, manager, plateau).post(`${url}/cancel`).send({ reason: 'Erreur' }).expect(409); // déjà livrée
      await api(app, cashier, plateau).post(`/api/customer-orders/${ids.eventOrder}/status`).send({ status: 'CONFIRMED' }).expect(403);
      const o = (await api(app, cashier, plateau).get(url).expect(200)).body;
      expect(o.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['DRAFT', 'CONFIRMED', 'IN_PREPARATION', 'READY', 'DELIVERED', 'COMPLETED']);
      expect(await prisma.auditLog.count({ where: { action: 'CUSTOMER_ORDER_STATUS', entityId: ids.order } })).toBe(5);
    });

    it('annule avant livraison, toujours avec motif et trace', async () => {
      const url = `/api/customer-orders/${ids.acceptedOrder}`;
      await api(app, manager, plateau).post(`${url}/cancel`).send({}).expect(400);
      await api(app, manager, plateau).post(`${url}/cancel`).send({ reason: 'ab' }).expect(400);
      const c = (await api(app, manager, plateau).post(`${url}/cancel`).send({ reason: 'Mariage reporté' }).expect(201)).body;
      expect([c.status, c.cancelReason, c.cancelledBy]).toEqual(['CANCELLED', 'Mariage reporté', 'resp']);
      expect(c.history.at(-1)).toMatchObject({ fromStatus: 'CONFIRMED', toStatus: 'CANCELLED', reason: 'Mariage reporté' });
      await api(app, manager, plateau).post(`${url}/cancel`).send({ reason: 'Encore' }).expect(409);
      await api(app, manager, plateau).post(`${url}/status`).send({ status: 'IN_PREPARATION' }).expect(409);
      expect(await prisma.auditLog.count({ where: { action: 'CUSTOMER_ORDER_CANCELLED', entityId: ids.acceptedOrder, reason: 'Mariage reporté' } })).toBe(1);
    });
  });

  describe('Protections en base', () => {
    it('fige les documents hors brouillon et ne supprime rien', async () => {
      const line = await prisma.customerOrderLine.findFirstOrThrow({ where: { orderId: ids.acceptedOrder } });
      await expect(prisma.$executeRaw`UPDATE customer_orders SET total = 1 WHERE id = ${ids.acceptedOrder}::uuid`).rejects.toThrow(/seul son état/);
      await expect(prisma.$executeRaw`UPDATE customer_order_lines SET unit_price = 1 WHERE id = ${line.id}::uuid`).rejects.toThrow(/lignes figées/);
      await expect(prisma.$executeRaw`DELETE FROM customer_order_lines WHERE id = ${line.id}::uuid`).rejects.toThrow(/lignes figées/);
      await expect(prisma.$executeRaw`UPDATE quotes SET total = 1 WHERE id = ${ids.quote}::uuid`).rejects.toThrow(/seul son état/);
      await expect(prisma.$executeRaw`DELETE FROM quotes WHERE id = ${ids.yopQuote}::uuid`).rejects.toThrow(/suppression interdite/);
      await expect(prisma.$executeRaw`DELETE FROM customer_orders WHERE id = ${ids.order}::uuid`).rejects.toThrow(/suppression interdite/);
      await expect(prisma.$executeRaw`DELETE FROM customer_order_status_history`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`DELETE FROM quote_status_history`).rejects.toThrow(/ajout seul/);
      // Les colonnes de production et de livraison restent ouvertes à l'étape stock.
      await prisma.$executeRaw`UPDATE customer_order_lines SET delivered_quantity = 1 WHERE id = ${line.id}::uuid`;
    });
  });
});
