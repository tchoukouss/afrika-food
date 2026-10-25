import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const year = new Date().getUTCFullYear();
const num = (v: unknown) => Number(v);

describe('Module 7 — Étape 4 : paiements clients, répartitions et acomptes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User; // Responsable Plateau : tous les droits
  let cashier: User; // Caissier Plateau : encaisse, sans annuler ni rembourser
  let accountant: User; // Comptable Plateau : paiements hors caisse
  let managerYop: User;
  let waiter: User; // Serveur : aucun droit sur les paiements
  let plateau: string;
  let yopougon: string;
  const ids: Record<string, string> = {};

  const pay = (u: Session, body: object, est = plateau) => api(app, u, est).post('/api/customer-payments').send({ establishmentId: est, customerId: ids.customer, ...body });
  const deposit = (u: Session, body: object, est = plateau) => api(app, u, est).post('/api/deposits').send({ establishmentId: est, customerId: ids.customer, ...body });
  const session = async (id: string) => (await api(app, manager, plateau).get(`/api/cash-sessions/${id}`).expect(200)).body;
  const expected = async (id: string, method = 'CASH') => num((await session(id)).expected.find((e: { method: string }) => e.method === method)?.amount ?? 0);
  const movements = (sessionId: string, type: string) => prisma.cashMovement.findMany({ where: { sessionId, type: type as never }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', plateau);
    cashier = await user('caisse@test.ci', 'CASHIER', plateau);
    accountant = await user('compta@test.ci', 'ACCOUNTANT', plateau);
    managerYop = await user('respyop@test.ci', 'MANAGER', yopougon);
    waiter = await user('serveur@test.ci', 'WAITER', plateau);

    const register = async (est: string, code: string) => (await api(app, admin).post('/api/cash-registers').send({ establishmentId: est, code, name: `Caisse ${code}`, printerType: 'NONE' }).expect(201)).body.id;
    const open = async (u: Session, registerId: string, openingFloat: number) => (await api(app, u, plateau).post('/api/cash-sessions').send({ registerId, openingFloat }).expect(201)).body.id;
    ids.sessCashier = await open(cashier, await register(plateau, 'C1'), 10000);
    ids.sessManager = await open(manager, await register(plateau, 'C2'), 5000);

    ids.customer = (await api(app, manager, plateau).post('/api/customers').send({ type: 'EVENT', name: 'Famille Kouassi', phone: '0708090807' }).expect(201)).body.id;
    ids.other = (await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Awa Koné' }).expect(201)).body.id;
    const order = async (customerId: string) =>
      (await api(app, manager, plateau).post('/api/customer-orders').send({ establishmentId: plateau, customerId, lines: [{ kind: 'FEE', label: 'Traiteur mariage', quantity: 1, unitPrice: 300000 }] }).expect(201)).body.id;
    ids.order = await order(ids.customer);
    ids.otherOrder = await order(ids.other);
    ids.cancelledOrder = await order(ids.customer);
    await api(app, manager, plateau).post(`/api/customer-orders/${ids.cancelledOrder}/cancel`).send({ reason: 'Erreur de saisie' }).expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Encaissements', () => {
    it('encaisse des espèces par la session de caisse, une seule fois malgré un double envoi', async () => {
      const key = randomUUID();
      const [a, b] = await Promise.all([
        pay(cashier, { clientRequestId: key, method: 'CASH', amount: 20000, sessionId: ids.sessCashier }),
        pay(cashier, { clientRequestId: key, method: 'CASH', amount: 20000, sessionId: ids.sessCashier }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect([a.body.number, a.body.status, num(a.body.amount), num(a.body.unallocated), a.body.provider]).toEqual([`PLT-PAY-${year}-000001`, 'RECORDED', 20000, 20000, 'CASH']);
      expect(await prisma.customerPayment.count({ where: { clientRequestId: key } })).toBe(1);
      const m = await movements(ids.sessCashier, 'CUSTOMER_PAYMENT');
      expect(m.map((x) => [x.method, num(x.amount), x.id])).toEqual([['CASH', 20000, a.body.cashMovementId]]);
      expect(await expected(ids.sessCashier)).toBe(30000); // fond 10 000 + paiement 20 000
      expect(await prisma.auditLog.count({ where: { action: 'CUSTOMER_PAYMENT_RECORDED', entityId: a.body.id } })).toBe(1);
      ids.cashPayment = a.body.id;

      await pay(cashier, { method: 'CASH', amount: 1000 }).expect(400); // session obligatoire
      await pay(cashier, { method: 'CASH', amount: 1000, sessionId: ids.sessManager }).expect(403); // session d'un autre caissier
      await pay(cashier, { method: 'CASH', amount: 0, sessionId: ids.sessCashier }).expect(400);
      await pay(cashier, { customerId: randomUUID(), method: 'CASH', amount: 1000, sessionId: ids.sessCashier }).expect(404);
    });

    it('encaisse mobile money (référence obligatoire) et carte par la caisse', async () => {
      await pay(cashier, { method: 'ORANGE_MONEY', amount: 15000, sessionId: ids.sessCashier }).expect(400);
      const om = (await pay(cashier, { method: 'WAVE', amount: 15000, reference: 'WV-778899', sessionId: ids.sessCashier }).expect(201)).body;
      expect([om.method, om.reference, om.provider]).toEqual(['WAVE', 'WV-778899', 'MANUAL']);
      const card = (await pay(cashier, { method: 'CARD', amount: 8000, sessionId: ids.sessCashier }).expect(201)).body;
      expect(await expected(ids.sessCashier, 'WAVE')).toBe(15000);
      expect(await expected(ids.sessCashier, 'CARD')).toBe(8000);
      ids.cardPayment = card.id;
    });

    it('enregistre virement et chèque hors caisse, sans mouvement de caisse', async () => {
      const before = await prisma.cashMovement.count();
      await pay(accountant, { method: 'BANK_TRANSFER', amount: 50000, reference: 'VIR-001', sessionId: ids.sessCashier }).expect(400);
      await pay(accountant, { method: 'CHEQUE', amount: 50000 }).expect(400); // numéro de chèque obligatoire
      const t = (await pay(accountant, { method: 'BANK_TRANSFER', amount: 50000, reference: 'VIR-001' }).expect(201)).body;
      expect([t.sessionId, t.cashMovementId, num(t.unallocated)]).toEqual([null, null, 50000]);
      expect(await prisma.cashMovement.count()).toBe(before);
      await pay(accountant, { method: 'CASH', amount: 1000, sessionId: ids.sessCashier }).expect(403); // pas de caisse pour le comptable
      ids.transfer = t.id;
    });

    it('ne compte aucun paiement dans le chiffre d’affaires', async () => {
      expect(await prisma.sale.count()).toBe(0);
      const z = (await api(app, manager, plateau).get(`/api/cash-sessions/${ids.sessCashier}/report`).expect(200)).body;
      expect([num(z.totals.total), num(z.totals.tax), z.salesByStatus]).toEqual([0, 0, []]);
      expect(z.movements.filter((m: { type: string }) => m.type === 'CUSTOMER_PAYMENT').reduce((s: number, m: { amount: string }) => s + num(m.amount), 0)).toBe(43000);
      const list = (await api(app, manager, plateau).get('/api/cash-sessions').expect(200)).body;
      expect(num(list.find((s: { id: string }) => s.id === ids.sessCashier).salesTotal)).toBe(0);
    });
  });

  describe('Acomptes', () => {
    it('reçoit un acompte sur une commande, avec reçu ACP, sans vente ni stock', async () => {
      const moves = await prisma.stockMovement.count();
      const key = randomUUID();
      const d = (await deposit(manager, { clientRequestId: key, orderId: ids.order, payment: { method: 'CASH', amount: 100000, sessionId: ids.sessManager }, notes: 'Acompte mariage' }).expect(201)).body;
      expect((await deposit(manager, { clientRequestId: key, orderId: ids.order, payment: { method: 'CASH', amount: 100000, sessionId: ids.sessManager } }).expect(201)).body.id).toBe(d.id);
      expect([d.number, d.status, num(d.amount), num(d.available), d.order.id, d.customer.id]).toEqual([`PLT-ACP-${year}-000001`, 'RECEIVED', 100000, 100000, ids.order, ids.customer]);
      expect(d.allocations.map((a: { amount: string; payment: { method: string } }) => [num(a.amount), a.payment.method])).toEqual([[100000, 'CASH']]);
      expect(await expected(ids.sessManager)).toBe(105000);
      expect(await prisma.customerPayment.count({ where: { allocations: { some: { depositId: d.id } } } })).toBe(1);
      expect([await prisma.sale.count(), await prisma.stockMovement.count()]).toEqual([0, moves]);
      expect(await prisma.auditLog.count({ where: { action: 'DEPOSIT_RECEIVED', entityId: d.id } })).toBe(1);

      const r = (await api(app, cashier, plateau).get(`/api/deposits/${d.id}/receipt`).expect(200)).body;
      expect([r.number, num(r.amount), r.customer.name, r.order.number, r.payments.length]).toEqual([d.number, 100000, 'Famille Kouassi', d.order.number, 1]);
      expect(r.mention).toMatch(/ne vaut pas facture/);
      const o = (await api(app, manager, plateau).get(`/api/customer-orders/${ids.order}`).expect(200)).body;
      expect(o.deposits.map((x: { number: string }) => x.number)).toEqual([d.number]);
      ids.deposit = d.id;

      await deposit(manager, { orderId: ids.otherOrder, payment: { method: 'CASH', amount: 1000, sessionId: ids.sessManager } }).expect(400); // commande d'un autre client
      await deposit(manager, { orderId: ids.cancelledOrder, payment: { method: 'CASH', amount: 1000, sessionId: ids.sessManager } }).expect(409);
      await deposit(manager, { orderId: ids.order }).expect(400); // ni encaissement ni répartition
    });

    it('répartit un paiement reçu sans jamais dépasser son montant, même en simultané', async () => {
      // Virement de 50 000 : deux acomptes simultanés de 30 000.
      const [a, b] = await Promise.all([
        deposit(accountant, { funding: [{ paymentId: ids.transfer, amount: 30000 }] }),
        deposit(accountant, { funding: [{ paymentId: ids.transfer, amount: 30000 }] }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const won = (a.status === 201 ? a : b).body;
      expect([won.order, num(won.amount)]).toEqual([null, 30000]); // acompte rattaché au client seul
      const t = (await api(app, accountant, plateau).get(`/api/customer-payments/${ids.transfer}`).expect(200)).body;
      expect([num(t.allocated), num(t.unallocated)]).toEqual([30000, 20000]);
      await deposit(accountant, { funding: [{ paymentId: ids.transfer, amount: 20001 }] }).expect(409);
      await deposit(accountant, { funding: [{ paymentId: ids.transfer, amount: 15000 }, { paymentId: ids.transfer, amount: 5001 }] }).expect(409); // cumul d'un même paiement
      // Plusieurs paiements pour un acompte.
      const multi = (await deposit(manager, { orderId: ids.order, funding: [{ paymentId: ids.transfer, amount: 20000 }, { paymentId: ids.cashPayment, amount: 20000 }] }).expect(201)).body;
      expect(num(multi.amount)).toBe(40000);
      expect(num((await api(app, manager, plateau).get(`/api/customer-payments/${ids.transfer}`).expect(200)).body.unallocated)).toBe(0);
      const agg = await prisma.paymentAllocation.aggregate({ where: { paymentId: ids.transfer, releasedAt: null }, _sum: { amount: true } });
      expect(num(agg._sum.amount)).toBe(50000);
      // Paiement d'un autre client.
      const otherPay = (await pay(accountant, { customerId: ids.other, method: 'CHEQUE', amount: 5000, reference: 'CHQ-12' }).expect(201)).body.id;
      await deposit(manager, { funding: [{ paymentId: otherPay, amount: 1000 }] }).expect(400);
      ids.clientDeposit = won.id;
      ids.multiDeposit = multi.id;
    });
  });

  describe('Annulations et remboursements', () => {
    it('annule un paiement non réparti par un mouvement inverse, selon les droits', async () => {
      await api(app, cashier, plateau).post(`/api/customer-payments/${ids.cardPayment}/cancel`).send({ reason: 'Erreur de montant' }).expect(403); // pas « annuler une vente »
      await api(app, manager, plateau).post(`/api/customer-payments/${ids.cardPayment}/cancel`).send({ reason: '' }).expect(400);
      const c = (await api(app, manager, plateau).post(`/api/customer-payments/${ids.cardPayment}/cancel`).send({ reason: 'Erreur de montant' }).expect(201)).body;
      expect([c.status, c.cancelReason, num(c.unallocated)]).toEqual(['CANCELLED', 'Erreur de montant', 0]);
      const rev = await prisma.cashMovement.findUniqueOrThrow({ where: { id: c.reversalMovementId } });
      expect([rev.type, rev.method, num(rev.amount), rev.sessionId]).toEqual(['CUSTOMER_REFUND', 'CARD', -8000, ids.sessCashier]);
      expect(await expected(ids.sessCashier, 'CARD')).toBe(0);
      await api(app, manager, plateau).post(`/api/customer-payments/${ids.cardPayment}/cancel`).send({ reason: 'Encore' }).expect(409);
      await api(app, manager, plateau).post(`/api/customer-payments/${ids.transfer}/cancel`).send({ reason: 'Virement rejeté' }).expect(409); // réparti
      expect(await prisma.auditLog.count({ where: { action: 'CUSTOMER_PAYMENT_CANCELLED', entityId: ids.cardPayment } })).toBe(1);
    });

    it('rembourse un acompte par la caisse ou hors caisse, jamais au-delà', async () => {
      const url = `/api/deposits/${ids.deposit}/refund`;
      await api(app, cashier, plateau).post(url).send({ method: 'CASH', amount: 1000, sessionId: ids.sessCashier, reason: 'Geste' }).expect(403); // pas « rembourser »
      await api(app, manager, plateau).post(url).send({ method: 'CASH', amount: 1000, sessionId: ids.sessManager }).expect(400); // motif obligatoire
      await api(app, manager, plateau).post(url).send({ method: 'CASH', amount: 200000, sessionId: ids.sessManager, reason: 'Trop' }).expect(409);
      const key = randomUUID();
      const part = (await api(app, manager, plateau).post(url).send({ clientRequestId: key, method: 'CASH', amount: 30000, sessionId: ids.sessManager, reason: 'Invités en moins' }).expect(201)).body;
      expect((await api(app, manager, plateau).post(url).send({ clientRequestId: key, method: 'CASH', amount: 30000, sessionId: ids.sessManager, reason: 'Invités en moins' }).expect(201)).body.refundedAmount).toBe(part.refundedAmount);
      expect([part.status, num(part.refundedAmount), num(part.available), part.refunds.length]).toEqual(['RECEIVED', 30000, 70000, 1]);
      expect(await expected(ids.sessManager)).toBe(75000);
      expect((await movements(ids.sessManager, 'CUSTOMER_REFUND')).map((m) => num(m.amount))).toEqual([-30000]);
      await api(app, manager, plateau).post(url).send({ method: 'CASH', amount: 70001, sessionId: ids.sessManager, reason: 'Trop' }).expect(409);
      const full = (await api(app, manager, plateau).post(url).send({ method: 'BANK_TRANSFER', amount: 70000, reference: 'VIR-RMB-1', reason: 'Mariage annulé' }).expect(201)).body;
      expect([full.status, num(full.refundedAmount), num(full.available)]).toEqual(['REFUNDED', 100000, 0]);
      await api(app, manager, plateau).post(url).send({ method: 'BANK_TRANSFER', amount: 1, reference: 'X', reason: 'Encore' }).expect(409);
      await api(app, manager, plateau).post(`/api/deposits/${ids.deposit}/cancel`).send({ reason: 'Erreur' }).expect(409);
      expect(await prisma.auditLog.count({ where: { action: 'DEPOSIT_REFUNDED', entityId: ids.deposit } })).toBe(2);
      // Les espèces remboursées ne dépassent jamais celles de la caisse.
      const d = (await deposit(manager, { funding: [{ paymentId: (await pay(accountant, { method: 'BANK_TRANSFER', amount: 200000, reference: 'VIR-2' }).expect(201)).body.id, amount: 200000 }] }).expect(201)).body;
      await api(app, manager, plateau).post(`/api/deposits/${d.id}/refund`).send({ method: 'CASH', amount: 100000, sessionId: ids.sessManager, reason: 'Retour client' }).expect(409);
    });

    it('conserve un acompte en crédit client, ou l’annule en libérant ses répartitions', async () => {
      await api(app, manager, plateau).post(`/api/customer-orders/${ids.order}/cancel`).send({ reason: 'Mariage reporté' }).expect(201);
      const credit = (await api(app, manager, plateau).post(`/api/deposits/${ids.multiDeposit}/credit`).send({ reason: 'Commande annulée, avance gardée' }).expect(201)).body;
      expect([credit.status, num(credit.available), credit.creditReason]).toEqual(['CUSTOMER_CREDIT', 40000, 'Commande annulée, avance gardée']);
      await api(app, manager, plateau).post(`/api/deposits/${ids.multiDeposit}/credit`).send({ reason: 'Encore' }).expect(409);

      await api(app, cashier, plateau).post(`/api/deposits/${ids.clientDeposit}/cancel`).send({ reason: 'Saisie en double' }).expect(403);
      const c = (await api(app, manager, plateau).post(`/api/deposits/${ids.clientDeposit}/cancel`).send({ reason: 'Saisie en double' }).expect(201)).body;
      expect([c.status, c.allocations.every((a: { releasedAt: string | null }) => !!a.releasedAt)]).toEqual(['CANCELLED', true]);
      expect(num((await api(app, manager, plateau).get(`/api/customer-payments/${ids.transfer}`).expect(200)).body.unallocated)).toBe(30000);
      expect(await prisma.auditLog.count({ where: { action: { in: ['DEPOSIT_TO_CUSTOMER_CREDIT', 'DEPOSIT_CANCELLED'] } } })).toBe(2);
    });

    it('refuse paiement et annulation sur une session clôturée', async () => {
      const wave = (await pay(cashier, { method: 'WAVE', amount: 2000, reference: 'WV-1', sessionId: ids.sessCashier }).expect(201)).body.id;
      const s = await session(ids.sessCashier);
      const counts = s.expected.map((e: { method: string; amount: string }) => ({ method: e.method, counted: num(e.amount) }));
      await api(app, cashier, plateau).post(`/api/cash-sessions/${ids.sessCashier}/close`).send({ counts }).expect(201);
      await pay(cashier, { method: 'CASH', amount: 1000, sessionId: ids.sessCashier }).expect(409);
      const res = await api(app, manager, plateau).post(`/api/customer-payments/${wave}/cancel`).send({ reason: 'Erreur' }).expect(409);
      expect(res.body.message).toMatch(/clôturée/);
      const closure = await prisma.cashClosure.findFirstOrThrow({ where: { sessionId: ids.sessCashier, method: 'CASH' } });
      expect(num(closure.expected)).toBe(30000); // les paiements clients sont comptés à la clôture
    });
  });

  describe('Reçus de paiement', () => {
    const receipt = (u: Session, id: string, est = plateau) => api(app, u, est).get(`/api/customer-payments/${id}/receipt`);

    it('imprime un paiement en caisse, sans exposer la session ni les mouvements', async () => {
      const r = (await receipt(cashier, ids.cashPayment).expect(200)).body;
      expect([r.title, r.number, r.status, r.cancelled, r.method, r.methodLabel, r.reference, r.register, num(r.amount)]).toEqual([
        'Reçu de paiement',
        `PLT-PAY-${year}-000001`,
        'RECORDED',
        null,
        'CASH',
        'Espèces',
        null,
        'En caisse',
        20000,
      ]);
      expect([r.customer.name, r.customer.phone, r.establishment.code, r.establishment.name, r.company.name, typeof r.receivedBy]).toEqual([
        'Famille Kouassi',
        '0708090807',
        'PLT',
        'Pâtisserie Plateau',
        'AFRIKA FOOD Test',
        'string',
      ]);
      expect(Object.keys(r.establishment).sort()).toEqual(['address', 'city', 'code', 'name', 'phone', 'receiptFooter', 'receiptHeader']);
      expect(Object.keys(r.company).sort()).toEqual(['legalName', 'name', 'taxId']);
      for (const key of ['sessionId', 'cashMovementId', 'reversalMovementId', 'provider']) expect(r).not.toHaveProperty(key);
      expect(r.mention).toBe('Reçu de paiement. Ce reçu ne vaut pas facture.');
    });

    it('détaille les répartitions actives sur facture et acompte, avec le reste au crédit du client', async () => {
      const p = (await pay(accountant, { method: 'CHEQUE', amount: 10000, reference: 'CHQ-RECU' }).expect(201)).body;
      const inv = (
        await api(app, manager, plateau)
          .post('/api/invoices')
          .send({ establishmentId: plateau, source: 'MANUAL', customerId: ids.customer, lines: [{ kind: 'FEE', label: 'Location de salle', quantity: 1, unitPrice: 4000 }] })
          .expect(201)
      ).body;
      const issued = (await api(app, manager, plateau).post(`/api/invoices/${inv.id}/issue`).expect(201)).body;
      await api(app, manager, plateau).post(`/api/invoices/${inv.id}/allocations`).send({ paymentId: p.id, amount: 4000 }).expect(201);
      const d = (await deposit(manager, { funding: [{ paymentId: p.id, amount: 3000 }] }).expect(201)).body;
      const detail = (await api(app, manager, plateau).get(`/api/customer-payments/${p.id}`).expect(200)).body;

      const r = (await receipt(accountant, p.id).expect(200)).body;
      expect([r.method, r.methodLabel, r.reference, r.register]).toEqual(['CHEQUE', 'Chèque', 'CHQ-RECU', 'Hors caisse']);
      expect(r.allocations.map((a: { target: string; number: string; amount: string }) => [a.target, a.number, num(a.amount)])).toEqual([
        ['INVOICE', issued.number, 4000],
        ['DEPOSIT', d.number, 3000],
      ]);
      expect([num(r.allocated), num(r.unallocated)]).toEqual([num(detail.allocated), num(detail.unallocated)]);
      expect([num(r.allocated), num(r.unallocated)]).toEqual([7000, 3000]);
      expect(r.mention).toMatch(/^Reçu de paiement\. Ce reçu ne vaut pas facture\. /);
      expect(r.mention).toMatch(/3000 FCFA.*crédit du client/);
    });

    it('exclut les répartitions libérées', async () => {
      // Virement : 30 000 libérés par l'annulation d'un acompte, 20 000 toujours affectés.
      const released = await prisma.paymentAllocation.count({ where: { paymentId: ids.transfer, releasedAt: { not: null } } });
      expect(released).toBeGreaterThan(0);
      const r = (await receipt(accountant, ids.transfer).expect(200)).body;
      const active = await prisma.paymentAllocation.findMany({ where: { paymentId: ids.transfer, releasedAt: null } });
      expect(r.allocations).toHaveLength(active.length);
      expect(r.allocations.reduce((s: number, a: { amount: string }) => s + num(a.amount), 0)).toBe(num(r.allocated));
      expect([num(r.allocated), num(r.unallocated)]).toEqual([20000, 30000]);
    });

    it('imprime un paiement annulé avec son annulation', async () => {
      const r = (await receipt(manager, ids.cardPayment).expect(200)).body;
      expect([r.status, r.cancelled.reason, typeof r.cancelled.by, !!r.cancelled.at, num(r.unallocated), r.allocations]).toEqual(['CANCELLED', 'Erreur de montant', 'string', true, 0, []]);
      expect(r.mention).toBe('Reçu de paiement. Ce reçu ne vaut pas facture.');
    });

    it('applique les droits de lecture et l’isolation des établissements', async () => {
      await receipt(waiter, ids.cashPayment).expect(404); // aucun droit de lecture des paiements
      await receipt(managerYop, ids.cashPayment, yopougon).expect(404); // autre établissement
      await receipt(manager, randomUUID()).expect(404);
      await receipt(manager, 'pas-un-uuid').expect(400);
      await receipt(accountant, ids.cashPayment).expect(200);
    });

    it('reste une lecture pure : aucune écriture, aucun audit, aucun mouvement de caisse', async () => {
      const counts = () =>
        Promise.all([prisma.auditLog.count(), prisma.cashMovement.count(), prisma.paymentAllocation.count(), prisma.customerPayment.count(), prisma.customerPayment.findUniqueOrThrow({ where: { id: ids.cashPayment } })]);
      const before = await counts();
      await receipt(manager, ids.cashPayment).expect(200);
      await receipt(manager, ids.transfer).expect(200);
      expect(await counts()).toEqual(before);
    });
  });

  describe('Droits et isolation', () => {
    it('limite paiements et acomptes à l’établissement et aux droits', async () => {
      await api(app, managerYop, yopougon).get(`/api/customer-payments/${ids.cashPayment}`).expect(404);
      await api(app, managerYop, yopougon).get(`/api/deposits/${ids.deposit}`).expect(404);
      await api(app, managerYop, yopougon).get(`/api/deposits/${ids.deposit}/receipt`).expect(404);
      expect((await api(app, managerYop, yopougon).get('/api/customer-payments').expect(200)).body).toHaveLength(0);
      expect((await api(app, managerYop, yopougon).get('/api/deposits').expect(200)).body).toHaveLength(0);
      await pay(managerYop, { method: 'BANK_TRANSFER', amount: 1000, reference: 'V' }, plateau).expect(403);
      await deposit(managerYop, { funding: [{ paymentId: ids.transfer, amount: 1000 }] }, yopougon).expect(400); // paiement d'un autre site
      await pay(waiter, { method: 'BANK_TRANSFER', amount: 1000, reference: 'V' }).expect(403);
      await api(app, waiter, plateau).get(`/api/customer-payments/${ids.cashPayment}`).expect(404);
      expect((await api(app, waiter, plateau).get('/api/deposits').expect(200)).body).toHaveLength(0);
      expect((await api(app, accountant, plateau).get(`/api/customer-payments?customerId=${ids.customer}`).expect(200)).body.length).toBeGreaterThan(3);
    });
  });

  describe('Protections en base', () => {
    it('protège paiements, répartitions, acomptes, remboursements et mouvements de caisse', async () => {
      const p = await prisma.customerPayment.findUniqueOrThrow({ where: { id: ids.transfer } });
      const a = await prisma.paymentAllocation.findFirstOrThrow({ where: { paymentId: ids.transfer, releasedAt: null } });
      const r = await prisma.customerRefund.findFirstOrThrow();
      await expect(prisma.$executeRaw`DELETE FROM customer_payments WHERE id = ${p.id}::uuid`).rejects.toThrow(/aucune suppression/);
      await expect(prisma.$executeRaw`UPDATE customer_payments SET amount = 1 WHERE id = ${p.id}::uuid`).rejects.toThrow(/seules les colonnes/);
      await expect(prisma.$executeRaw`DELETE FROM payment_allocations WHERE id = ${a.id}::uuid`).rejects.toThrow(/aucune suppression/);
      await expect(prisma.$executeRaw`UPDATE payment_allocations SET amount = 1 WHERE id = ${a.id}::uuid`).rejects.toThrow(/seules les colonnes/);
      await expect(prisma.$executeRaw`UPDATE deposits SET amount = 1 WHERE id = ${ids.multiDeposit}::uuid`).rejects.toThrow(/seules les colonnes/);
      await expect(prisma.$executeRaw`DELETE FROM deposits WHERE id = ${ids.multiDeposit}::uuid`).rejects.toThrow(/aucune suppression/);
      await expect(prisma.$executeRaw`UPDATE customer_refunds SET amount = 1 WHERE id = ${r.id}::uuid`).rejects.toThrow(/ajout seul/i);
      // Répartition au-delà du paiement, même écrite directement en base.
      await expect(prisma.paymentAllocation.create({ data: { paymentId: p.id, target: 'DEPOSIT', depositId: ids.multiDeposit, amount: 50001n, createdById: p.createdById } })).rejects.toThrow(/Repartition superieure/);
      // Paiement « caisse » sans mouvement, mouvement de paiement négatif.
      await expect(
        prisma.customerPayment.create({ data: { companyId: p.companyId, establishmentId: p.establishmentId, customerId: p.customerId, number: 'TEST-PAY', method: 'CASH', amount: 1n, provider: 'CASH', createdById: p.createdById } }),
      ).rejects.toThrow();
      await expect(
        prisma.cashMovement.create({ data: { companyId: p.companyId, establishmentId: p.establishmentId, sessionId: ids.sessManager, type: 'CUSTOMER_PAYMENT', method: 'CASH', amount: -1n, userId: p.createdById } }),
      ).rejects.toThrow();
    });
  });
});
