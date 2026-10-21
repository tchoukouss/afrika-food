import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { SequenceService } from '../src/sequences/sequence.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

describe('Module 1 — Fondations', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let companyId: string;
  let admin: Session;
  let roles: Record<string, string>;
  let plateau: string;
  let yopougon: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    companyId = (await resetDatabase(prisma)).id;
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const list = await api(app, admin).get('/api/roles').expect(200);
    roles = Object.fromEntries(list.body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  describe('Authentification', () => {
    it('vérifie la santé du service sans authentification', async () => {
      const res = await request(server()).get('/api/health').expect(200);
      expect(res.body.database).toBe('ok');
    });

    it('refuse une route protégée sans jeton', async () => {
      await request(server()).get('/api/users').expect(401);
    });

    it('refuse un mauvais mot de passe avec un message générique et trace l’événement', async () => {
      const res = await request(server()).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'mauvais' }).expect(401);
      expect(res.body.message).toBe('Email ou mot de passe incorrect');
      const unknown = await request(server()).post('/api/auth/login').send({ email: 'inconnu@test.ci', password: 'x' }).expect(401);
      expect(unknown.body.message).toBe(res.body.message);
      const events = await prisma.securityEvent.count({ where: { type: 'LOGIN_FAILED' } });
      expect(events).toBeGreaterThanOrEqual(2);
      await prisma.user.update({ where: { email: ADMIN_EMAIL }, data: { failedLoginCount: 0 } });
    });

    it('verrouille le compte après 5 échecs, même avec le bon mot de passe ensuite', async () => {
      const u = await createAndLogin(app, admin, { email: 'lock@test.ci', fullName: 'Lock', roles: [{ roleId: roles.CASHIER, establishmentId: plateau }] });
      await Promise.all(
        Array.from({ length: 5 }, () => request(server()).post('/api/auth/login').send({ email: 'lock@test.ci', password: 'faux' })),
      );
      const res = await request(server()).post('/api/auth/login').send({ email: 'lock@test.ci', password: 'Definitif2026' }).expect(401);
      expect(res.body.message).toMatch(/verrouillé/);
      expect(await prisma.securityEvent.count({ where: { type: 'ACCOUNT_LOCKED', userId: u.id } })).toBe(1);

      await api(app, admin).post(`/api/users/${u.id}/unlock`).expect(204);
      await login(app, 'lock@test.ci', 'Definitif2026');
    });

    it('exige le changement du mot de passe provisoire avant tout accès', async () => {
      await api(app, admin).post('/api/users').send({ email: 'neuf@test.ci', fullName: 'Neuf', password: 'Provisoire1', roles: [{ roleId: roles.CASHIER, establishmentId: plateau }] }).expect(201);
      const s = await login(app, 'neuf@test.ci', 'Provisoire1');
      const blocked = await api(app, s, plateau).get('/api/company').expect(403);
      expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
      await api(app, s).get('/api/auth/me').expect(200);
      await api(app, s).post('/api/auth/change-password').send({ currentPassword: 'Provisoire1', newPassword: 'court' }).expect(400);
      await api(app, s).post('/api/auth/change-password').send({ currentPassword: 'Provisoire1', newPassword: 'Nouveau2026' }).expect(204);
      await api(app, s, plateau).get('/api/company').expect(200);
    });

    it('fait tourner le jeton de rafraîchissement et coupe la session en cas de réutilisation', async () => {
      const s = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const r1 = await request(server()).post('/api/auth/refresh').set('Cookie', s.cookie).expect(200);
      const newCookie = (r1.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      expect(newCookie).not.toBe(s.cookie);
      // Réutilisation de l'ancien jeton : refusée et session révoquée.
      await request(server()).post('/api/auth/refresh').set('Cookie', s.cookie).expect(401);
      await request(server()).post('/api/auth/refresh').set('Cookie', newCookie).expect(401);
      await api(app, { token: r1.body.accessToken, cookie: newCookie }).get('/api/auth/me').expect(401);
      expect(await prisma.securityEvent.count({ where: { type: 'REFRESH_TOKEN_REUSE' } })).toBe(1);
    });

    it('invalide immédiatement le jeton après déconnexion', async () => {
      const s = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      await api(app, s).post('/api/auth/logout').expect(204);
      await api(app, s).get('/api/auth/me').expect(401);
      expect(await prisma.auditLog.count({ where: { action: 'LOGOUT' } })).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Établissements', () => {
    it('refuse un code en double', async () => {
      await api(app, admin).post('/api/establishments').send({ code: 'plt', name: 'Doublon', type: 'PATISSERIE' }).expect(409);
    });

    it('valide le type et le format', async () => {
      await api(app, admin).post('/api/establishments').send({ code: 'X', name: 'A', type: 'GARAGE' }).expect(400);
      await api(app, admin).post('/api/establishments').send({ code: 'ABJ', name: 'Abidjan', type: 'PATISSERIE', champInconnu: 1 }).expect(400);
    });

    it('expose les modules selon le type et journalise les modifications', async () => {
      const res = await api(app, admin).get(`/api/establishments/${yopougon}`).expect(200);
      expect(res.body.modules).toEqual({ restaurant: true, patisserie: false, boulangerie: false, production: true });
      await api(app, admin).patch(`/api/establishments/${yopougon}`).send({ phone: '+225 07 00 00 00 00' }).expect(200);
      const log = await prisma.auditLog.findFirst({ where: { entityId: yopougon, action: 'ESTABLISHMENT_UPDATED' } });
      expect(log?.oldValues).toEqual({ phone: null });
      expect(log?.newValues).toEqual({ phone: '+225 07 00 00 00 00' });
    });
  });

  describe('Permissions par établissement', () => {
    let manager: Session & { id: string };
    let cashier: Session & { id: string };

    beforeAll(async () => {
      manager = await createAndLogin(app, admin, { email: 'manager@test.ci', fullName: 'Resp Plateau', roles: [{ roleId: roles.MANAGER, establishmentId: plateau }] });
      cashier = await createAndLogin(app, admin, { email: 'caisse@test.ci', fullName: 'Caissier Plateau', roles: [{ roleId: roles.CASHIER, establishmentId: plateau }] });
    });

    it("limite l'accès aux seuls établissements attribués", async () => {
      const me = await api(app, manager).get('/api/auth/me').expect(200);
      expect(me.body.establishments.map((e: { code: string }) => e.code)).toEqual(['PLT']);
      await api(app, manager, yopougon).get('/api/users').expect(403);
      await api(app, manager, 'pas-un-uuid').get('/api/users').expect(403);
    });

    it("un responsable ne voit que les utilisateurs de son établissement", async () => {
      const res = await api(app, manager, plateau).get('/api/users').expect(200);
      const emails = res.body.map((u: { email: string }) => u.email);
      expect(emails).toContain('caisse@test.ci');
      expect(emails).not.toContain(ADMIN_EMAIL);
    });

    it("un responsable crée un caissier dans son établissement, pas ailleurs", async () => {
      await api(app, manager, plateau).post('/api/users').send({ email: 'c2@test.ci', fullName: 'C2', password: 'Provisoire1', roles: [{ roleId: roles.CASHIER, establishmentId: plateau }] }).expect(201);
      await api(app, manager, plateau).post('/api/users').send({ email: 'c3@test.ci', fullName: 'C3', password: 'Provisoire1', roles: [{ roleId: roles.CASHIER, establishmentId: yopougon }] }).expect(403);
      await api(app, manager, plateau).post('/api/users').send({ email: 'c4@test.ci', fullName: 'C4', password: 'Provisoire1', roles: [{ roleId: roles.CASHIER, establishmentId: null }] }).expect(403);
    });

    it("empêche l'escalade de privilèges", async () => {
      // Le rôle Administrateur contient des permissions que le responsable n'a pas.
      await api(app, manager, plateau).post('/api/users').send({ email: 'pirate@test.ci', fullName: 'Pirate', password: 'Provisoire1', roles: [{ roleId: roles.ADMIN, establishmentId: plateau }] }).expect(403);
      await api(app, manager, plateau).put(`/api/users/${manager.id}/roles`).send({ roles: [{ roleId: roles.ADMIN }] }).expect(403);
      // Il ne peut pas non plus gérer un utilisateur de niveau groupe.
      const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
      await api(app, manager, plateau).patch(`/api/users/${adminUser.id}`).send({ isActive: false }).expect(403);
    });

    it('réserve la création d’établissement et la gestion des rôles au niveau groupe', async () => {
      await api(app, manager, plateau).post('/api/establishments').send({ code: 'NEW', name: 'Nouveau', type: 'PATISSERIE' }).expect(403);
      await api(app, manager, plateau).post('/api/roles').send({ code: 'TEST', name: 'Test', permissions: [] }).expect(403);
    });

    it('refuse au caissier la gestion des utilisateurs et le journal d’audit', async () => {
      await api(app, cashier, plateau).get('/api/users').expect(403);
      await api(app, cashier, plateau).get('/api/audit-logs').expect(403);
    });

    it('coupe immédiatement l’accès d’un utilisateur désactivé', async () => {
      await api(app, cashier, plateau).get('/api/company').expect(200);
      await api(app, manager, plateau).patch(`/api/users/${cashier.id}`).send({ isActive: false }).expect(200);
      await api(app, cashier, plateau).get('/api/company').expect(401);
      await request(server()).post('/api/auth/login').send({ email: 'caisse@test.ci', password: 'Definitif2026' }).expect(401);
      const log = await prisma.auditLog.findFirst({ where: { entityId: cashier.id, action: 'USER_DEACTIVATED' } });
      expect(log).not.toBeNull();
    });
  });

  describe('Rôles et garde-fous', () => {
    it('crée un rôle personnalisé et refuse une permission inconnue', async () => {
      await api(app, admin).post('/api/roles').send({ code: 'PATISSIER', name: 'Pâtissier', permissions: ['recipes.view', 'production.view'] }).expect(201);
      await api(app, admin).post('/api/roles').send({ code: 'BIDON', name: 'Bidon', permissions: ['tout.faire'] }).expect(400);
    });

    it('empêche de supprimer le dernier administrateur', async () => {
      const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
      await api(app, admin).patch(`/api/users/${adminUser.id}`).send({ isActive: false }).expect(400);
      await api(app, admin).put(`/api/users/${adminUser.id}/roles`).send({ roles: [] }).expect(403);
      const adminRole = await api(app, admin).get('/api/roles').expect(200);
      const perms = adminRole.body.find((r: { code: string }) => r.code === 'ADMIN').permissions.filter((p: string) => p !== 'roles.manage');
      await api(app, admin).patch(`/api/roles/${roles.ADMIN}`).send({ permissions: perms }).expect(409);
      await api(app, admin).delete(`/api/roles/${roles.ADMIN}`).expect(409);
    });

    it('trace les changements de rôles dans le journal', async () => {
      const u = await createAndLogin(app, admin, { email: 'roles@test.ci', fullName: 'Rôles Test', roles: [{ roleId: roles.CASHIER, establishmentId: plateau }] });
      await api(app, admin).put(`/api/users/${u.id}/roles`).send({ roles: [{ roleId: roles.WAITER, establishmentId: yopougon }] }).expect(200);
      const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: u.id, action: 'USER_ROLES_CHANGED' } });
      expect(log.oldValues).toEqual({ roles: [{ roleId: roles.CASHIER, establishmentId: plateau }] });
      expect(log.newValues).toEqual({ roles: [{ roleId: roles.WAITER, establishmentId: yopougon }] });
    });
  });

  describe('Journal d’audit', () => {
    it('est lisible par l’administrateur et ne contient aucun mot de passe', async () => {
      const res = await api(app, admin).get('/api/audit-logs?pageSize=200').expect(200);
      expect(res.body.total).toBeGreaterThan(0);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|refreshTokenHash|Provisoire1|Definitif2026|\$argon2/);
    });

    it('ne peut être ni modifié ni supprimé, même en SQL direct', async () => {
      await expect(prisma.$executeRaw`UPDATE audit_logs SET action = 'X'`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`DELETE FROM audit_logs`).rejects.toThrow(/ajout seul/);
    });
  });

  describe('Numérotation', () => {
    it('ne produit aucun doublon avec 50 transactions simultanées', async () => {
      const seq = app.get(SequenceService);
      const numbers = await Promise.all(
        Array.from({ length: 50 }, () =>
          prisma.$transaction((tx) => seq.next(tx, { companyId, docType: 'SALE', establishmentId: plateau, establishmentCode: 'PLT' })),
        ),
      );
      expect(new Set(numbers).size).toBe(50);
      const year = new Date().getUTCFullYear();
      expect(numbers.sort().at(-1)).toBe(`PLT-VTE-${year}-000050`);
    });

    it("ne consomme pas de numéro si la transaction est annulée", async () => {
      const seq = app.get(SequenceService);
      await expect(
        prisma.$transaction(async (tx) => {
          await seq.next(tx, { companyId, docType: 'INVOICE', establishmentId: plateau, establishmentCode: 'PLT' });
          throw new Error('annulation');
        }),
      ).rejects.toThrow('annulation');
      const n = await prisma.$transaction((tx) => seq.next(tx, { companyId, docType: 'INVOICE', establishmentId: plateau, establishmentCode: 'PLT' }));
      expect(n.endsWith('-000001')).toBe(true);
    });
  });
});
