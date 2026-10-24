import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthUser } from '../src/auth/decorators';
import { CustomerCreditService } from '../src/customers/credit';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Module 7 — Étape 1 : clients, encours et crédit', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let credit: CustomerCreditService;
  let companyId: string;
  let admin: Session;
  let manager: User; // Responsable Plateau : gère les clients et autorise le crédit
  let managerYop: User; // Responsable Yopougon
  let cashier: User; // Caissier Plateau : voit les clients
  let accountant: User; // Comptable Plateau : voit clients et créances
  let clerk: User; // Rôle personnalisé : gère les clients, sans autoriser le crédit
  let waiter: User; // Serveur : aucun accès aux clients
  let plateau: string;
  let yopougon: string;
  const ids: Record<string, string> = {};
  // Encours de test : alimenté pendant la transaction, comme le feront les factures des étapes suivantes.
  const ledger = new Map<string, bigint>();

  const me = (u: User): AuthUser => ({ userId: u.id, companyId, sessionId: '', access: undefined as never });
  const check = (u: User, input: { customerId: string; establishmentId?: string; amount: number; overrideId?: string }, record = false, hold = 0) =>
    prisma.$transaction(async (tx) => {
      const decision = await credit.check(tx, me(u), {
        customerId: input.customerId,
        establishmentId: input.establishmentId ?? plateau,
        amount: BigInt(input.amount),
        overrideId: input.overrideId,
        reference: `test-${randomUUID()}`,
      });
      if (record) ledger.set(input.customerId, (ledger.get(input.customerId) ?? 0n) + BigInt(input.amount));
      if (hold) await sleep(hold); // garde le verrou du client un instant
      return decision;
    });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    companyId = (await resetDatabase(prisma)).id;
    credit = app.get(CustomerCreditService);
    credit.registerOutstandingSource(async (_db, customerId) => ledger.get(customerId) ?? 0n);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    roles.CLERK = (await api(app, admin).post('/api/roles').send({ code: 'CLERK', name: 'Gestion clients', permissions: ['customers.view', 'customers.manage'] }).expect(201)).body.id;
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', plateau);
    managerYop = await user('respyop@test.ci', 'MANAGER', yopougon);
    cashier = await user('caisse@test.ci', 'CASHIER', plateau);
    accountant = await user('compta@test.ci', 'ACCOUNTANT', plateau);
    clerk = await user('clients@test.ci', 'CLERK', plateau);
    waiter = await user('serveur@test.ci', 'WAITER', plateau);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Fichier clients', () => {
    it('crée, consulte et modifie un client du groupe, avec audit et anti double envoi', async () => {
      const key = randomUUID();
      const body = { clientRequestId: key, type: 'BUSINESS', name: 'Société Ivoire Events', phone: '07 07 07 07 07', email: 'contact@ivoire-events.ci', address: 'Cocody, Abidjan', taxId: 'CI-1234567' };
      const c = (await api(app, manager, plateau).post('/api/customers').send(body).expect(201)).body;
      expect([c.phoneNormalized, c.creditLimit, c.paymentTermDays, c.isActive]).toEqual(['0707070707', null, 0, true]);
      expect((await api(app, manager, plateau).post('/api/customers').send(body).expect(201)).body.id).toBe(c.id);
      ids.events = c.id;
      await api(app, manager, plateau).post('/api/customers').send({ type: 'VIP', name: 'X' }).expect(400);
      await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Awa', email: 'pas-un-email' }).expect(400);

      // Consultation par le caissier et le comptable ; modification par le responsable.
      expect((await api(app, cashier, plateau).get(`/api/customers?q=ivoire`).expect(200)).body.map((x: { id: string }) => x.id)).toEqual([c.id]);
      expect((await api(app, accountant, plateau).get(`/api/customers?q=0707`).expect(200)).body).toHaveLength(1);
      const updated = (await api(app, manager, plateau).patch(`/api/customers/${c.id}`).send({ address: 'Plateau, Abidjan' }).expect(200)).body;
      expect([updated.address, updated.credit.outstanding]).toEqual(['Plateau, Abidjan', '0']);
      expect(await prisma.auditLog.count({ where: { action: 'CUSTOMER_CREATED', entityId: c.id } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'CUSTOMER_UPDATED', entityId: c.id } })).toBe(1);
    });

    it('applique les permissions existantes', async () => {
      await api(app, cashier, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Awa Koné' }).expect(403);
      await api(app, accountant, plateau).patch(`/api/customers/${ids.events}`).send({ name: 'Autre' }).expect(403);
      await api(app, waiter, plateau).get('/api/customers').expect(403);
      // Gérer les clients ne suffit pas pour fixer les conditions de crédit.
      ids.awa = (await api(app, clerk, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Awa Koné', phone: '+225 05 55 55 55 55' }).expect(201)).body.id;
      await api(app, clerk, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Moussa', creditLimit: 1000 }).expect(403);
      await api(app, clerk, plateau).patch(`/api/customers/${ids.awa}`).send({ creditLimit: 50000 }).expect(403);
      await api(app, clerk, plateau).patch(`/api/customers/${ids.awa}`).send({ paymentTermDays: 30 }).expect(403);
      await api(app, clerk, plateau).patch(`/api/customers/${ids.awa}`).send({ notes: 'Fidèle' }).expect(200);
    });

    it('impose un téléphone unique dans l’entreprise, quel que soit le format, y compris en simultané', async () => {
      await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Doublon', phone: '+225 0707070707' }).expect(409);
      await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Doublon', phone: '00225 07.07.07.07.07' }).expect(409);
      await api(app, manager, plateau).patch(`/api/customers/${ids.awa}`).send({ phone: '0707070707' }).expect(409);
      await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Sans téléphone A' }).expect(201);
      await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Sans téléphone B' }).expect(201);
      await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Mauvais', phone: '12' }).expect(400);
      const [a, b] = await Promise.all([
        api(app, manager, plateau).post('/api/customers').send({ type: 'WHOLESALER', name: 'Grossiste A', phone: '01 02 03 04 05' }),
        api(app, managerYop, yopougon).post('/api/customers').send({ type: 'WHOLESALER', name: 'Grossiste B', phone: '+2250102030405' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
    });

    it('partage le fichier au niveau du groupe, sans jamais supprimer', async () => {
      // Le responsable de Yopougon voit et peut servir le client créé à Plateau (décision D9).
      expect((await api(app, managerYop, yopougon).get(`/api/customers/${ids.events}`).expect(200)).body.name).toBe('Société Ivoire Events');
      await api(app, manager, plateau).patch(`/api/customers/${ids.awa}`).send({ isActive: false }).expect(200);
      expect((await api(app, cashier, plateau).get('/api/customers').expect(200)).body.some((x: { id: string }) => x.id === ids.awa)).toBe(false);
      expect((await api(app, cashier, plateau).get('/api/customers?includeInactive=true').expect(200)).body.some((x: { id: string }) => x.id === ids.awa)).toBe(true);
      await expect(prisma.$executeRaw`DELETE FROM customers WHERE id = ${ids.awa}::uuid`).rejects.toThrow();
    });
  });

  describe('Crédit', () => {
    it('fixe la limite (responsable habilité) et la contrôle : vide = aucun crédit', async () => {
      const c = (await api(app, manager, plateau).patch(`/api/customers/${ids.events}`).send({ creditLimit: 100000, paymentTermDays: 30 }).expect(200)).body;
      expect([c.creditLimit, c.paymentTermDays, c.credit.available]).toEqual(['100000', 30, '100000']);
      expect(await prisma.auditLog.count({ where: { action: 'CUSTOMER_CREDIT_UPDATED', entityId: ids.events } })).toBe(1);
      const s = (await api(app, cashier, plateau).get(`/api/customers/${ids.events}/credit?establishmentId=${plateau}&amount=120000`).expect(200)).body;
      expect([s.outstanding, s.available, s.withinLimit]).toEqual(['0', '100000', false]);
      await api(app, waiter, plateau).get(`/api/customers/${ids.events}/credit?establishmentId=${plateau}`).expect(403);

      expect((await check(manager, { customerId: ids.events, amount: 80000 })).overrideId).toBeNull();
      await expect(check(manager, { customerId: ids.events, amount: 120000 })).rejects.toMatchObject({ response: { code: 'CREDIT_LIMIT_EXCEEDED', available: '100000' } });
      // Client sans limite : aucun crédit.
      ids.noLimit = (await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Sans crédit' }).expect(201)).body.id;
      await expect(check(manager, { customerId: ids.noLimit, amount: 1 })).rejects.toMatchObject({ response: { code: 'CREDIT_LIMIT_EXCEEDED' } });
      // Client désactivé : refusé.
      await expect(check(manager, { customerId: ids.awa, amount: 1 })).rejects.toMatchObject({ response: { code: 'CUSTOMER_INACTIVE' } });
    });

    it('verrouille le client : deux opérations simultanées ne dépassent pas ensemble la limite', async () => {
      ledger.set(ids.events, 0n);
      const results = await Promise.allSettled([
        check(cashier, { customerId: ids.events, amount: 60000 }, true, 300),
        check(manager, { customerId: ids.events, amount: 60000 }, true, 300),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(ledger.get(ids.events)).toBe(60000n);
      expect((await api(app, accountant, plateau).get(`/api/customers/${ids.events}`).expect(200)).body.credit.outstanding).toBe('60000');
    });
  });

  describe('Pré-autorisations de dépassement', () => {
    it('est donnée par un responsable habilité de l’établissement, valable 1 heure', async () => {
      const url = `/api/customers/${ids.events}/credit-overrides`;
      await api(app, cashier, plateau).post(url).send({ establishmentId: plateau, maxAmount: 80000, reason: 'Mariage Kouassi' }).expect(403);
      await api(app, clerk, plateau).post(url).send({ establishmentId: plateau, maxAmount: 80000, reason: 'Mariage Kouassi' }).expect(403);
      await api(app, managerYop, yopougon).post(url).send({ establishmentId: plateau, maxAmount: 80000, reason: 'Mariage Kouassi' }).expect(403); // autre établissement
      await api(app, manager, plateau).post(url).send({ establishmentId: plateau, maxAmount: 0, reason: 'Zéro' }).expect(400);
      await api(app, manager, plateau).post(`/api/customers/${ids.awa}/credit-overrides`).send({ establishmentId: plateau, maxAmount: 1000, reason: 'Client désactivé' }).expect(409);
      const key = randomUUID();
      const o = (await api(app, manager, plateau).post(url).send({ clientRequestId: key, establishmentId: plateau, maxAmount: 80000, reason: 'Mariage Kouassi' }).expect(201)).body;
      expect((await api(app, manager, plateau).post(url).send({ clientRequestId: key, establishmentId: plateau, maxAmount: 80000, reason: 'Mariage Kouassi' }).expect(201)).body.id).toBe(o.id);
      const validity = new Date(o.expiresAt).getTime() - new Date(o.createdAt).getTime();
      expect([o.status, validity]).toEqual(['ACTIVE', 3_600_000]);
      ids.override = o.id;
      expect(await prisma.auditLog.count({ where: { action: 'CREDIT_OVERRIDE_GRANTED', entityId: o.id } })).toBe(1);
      // Visibles du comptable de Plateau, pas du responsable de Yopougon.
      expect((await api(app, accountant, plateau).get(url).expect(200)).body.map((x: { id: string }) => x.id)).toEqual([o.id]);
      expect((await api(app, managerYop, yopougon).get(url).expect(200)).body).toHaveLength(0);
    });

    it('couvre un dépassement une seule fois, même en simultané, dans la limite du montant autorisé', async () => {
      // Encours 60 000 + 70 000 > 100 000 : refus sans autorisation, puis une seule consommation.
      await expect(check(cashier, { customerId: ids.events, amount: 90000, overrideId: ids.override })).rejects.toMatchObject({ response: { code: 'CREDIT_OVERRIDE_INVALID' } }); // 90 000 > montant autorisé (80 000)
      await expect(check(cashier, { customerId: ids.events, amount: 70000, overrideId: ids.override, establishmentId: yopougon })).rejects.toMatchObject({
        response: { code: 'CREDIT_OVERRIDE_INVALID' },
      }); // autre établissement
      const results = await Promise.allSettled([
        check(cashier, { customerId: ids.events, amount: 70000, overrideId: ids.override }, true),
        check(manager, { customerId: ids.events, amount: 70000, overrideId: ids.override }, true),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const used = await prisma.creditOverride.findUniqueOrThrow({ where: { id: ids.override } });
      expect([used.usedAmount, used.usedAt !== null, used.usedReference?.startsWith('test-')]).toEqual([70000n, true, true]);
      expect(await prisma.auditLog.count({ where: { action: 'CREDIT_OVERRIDE_USED', entityId: ids.override } })).toBe(1);
      const list = (await api(app, manager, plateau).get(`/api/customers/${ids.events}/credit-overrides`).expect(200)).body;
      expect(list[0].status).toBe('USED');
      await api(app, manager, plateau).post(`/api/credit-overrides/${ids.override}/cancel`).send({ reason: 'Trop tard' }).expect(409);
    });

    it('refuse une autorisation expirée ou annulée', async () => {
      const past = new Date(Date.now() - 2 * 3_600_000);
      const expired = await prisma.creditOverride.create({
        data: { companyId, establishmentId: plateau, customerId: ids.events, maxAmount: 500000n, reason: 'Ancienne', approvedById: manager.id, createdAt: past, expiresAt: new Date(past.getTime() + 3_600_000) },
      });
      await expect(check(manager, { customerId: ids.events, amount: 50000, overrideId: expired.id })).rejects.toMatchObject({ response: { code: 'CREDIT_OVERRIDE_INVALID' } });
      await api(app, manager, plateau).post(`/api/credit-overrides/${expired.id}/cancel`).send({ reason: 'Nettoyage' }).expect(409);

      const o = (await api(app, manager, plateau).post(`/api/customers/${ids.events}/credit-overrides`).send({ establishmentId: plateau, maxAmount: 50000, reason: 'Buffet' }).expect(201)).body;
      await api(app, cashier, plateau).post(`/api/credit-overrides/${o.id}/cancel`).send({ reason: 'Erreur' }).expect(403);
      expect((await api(app, manager, plateau).post(`/api/credit-overrides/${o.id}/cancel`).send({ reason: 'Client parti' }).expect(201)).body.status).toBe('CANCELLED');
      await expect(check(manager, { customerId: ids.events, amount: 50000, overrideId: o.id })).rejects.toMatchObject({ response: { code: 'CREDIT_OVERRIDE_INVALID' } });
      const statuses = (await api(app, manager, plateau).get(`/api/customers/${ids.events}/credit-overrides`).expect(200)).body.map((x: { status: string }) => x.status).sort();
      expect(statuses).toEqual(['CANCELLED', 'EXPIRED', 'USED']);
      expect(await prisma.auditLog.count({ where: { action: 'CREDIT_OVERRIDE_CANCELLED' } })).toBe(1);
    });

    it('protège les autorisations en base', async () => {
      await expect(prisma.$executeRaw`UPDATE credit_overrides SET max_amount = 999999999 WHERE id = ${ids.override}::uuid`).rejects.toThrow(/modifiables/);
      await expect(prisma.$executeRaw`DELETE FROM credit_overrides WHERE id = ${ids.override}::uuid`).rejects.toThrow();
    });
  });
});
