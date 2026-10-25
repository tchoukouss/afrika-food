import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };

describe('Module 7 — Liste des livreurs affectables (GET /deliveries/drivers)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User; // Responsable Plateau
  let cashier: User; // Caissier Plateau : pas de « Gérer les commandes clients »
  let driver: User; // Livreur Plateau
  let groupDriver: User; // Livreur de niveau groupe
  let inactive: User; // Livreur Plateau désactivé
  let deleted: User; // Livreur Plateau supprimé
  let driverYop: User; // Livreur Yopougon
  let plateau: string;
  let yopougon: string;
  let foreignId: string; // Livreur d'une autre entreprise

  const drivers = (u: Session, est: string) => api(app, u, est).get(`/api/deliveries/drivers?establishmentId=${est}`);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string | null) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', plateau);
    cashier = await user('caisse@test.ci', 'CASHIER', plateau);
    driver = await user('livreur@test.ci', 'DELIVERY', plateau);
    groupDriver = await user('livreurgroupe@test.ci', 'DELIVERY', null);
    inactive = await user('livreurinactif@test.ci', 'DELIVERY', plateau);
    deleted = await user('livreursupprime@test.ci', 'DELIVERY', plateau);
    driverYop = await user('livreuryop@test.ci', 'DELIVERY', yopougon);
    await api(app, admin).patch(`/api/users/${inactive.id}`).send({ isActive: false }).expect(200);
    // Aucune route ne supprime un utilisateur : suppression logique posée directement.
    await prisma.user.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    // Autre entreprise : un livreur de niveau groupe, qui ne doit jamais apparaître.
    const other = await prisma.company.create({ data: { name: 'Autre entreprise', currency: 'XOF' } });
    const role = await prisma.role.create({
      data: { companyId: other.id, code: 'DELIVERY', name: 'Livreur', permissions: { create: [{ permissionCode: 'deliveries.manage' }] } },
    });
    foreignId = (
      await prisma.user.create({
        data: { companyId: other.id, email: 'livreur@autre.ci', fullName: 'Livreur autre', passwordHash: 'x', userRoles: { create: { roleId: role.id, establishmentId: null } } },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('retourne les livreurs de l’établissement et du niveau groupe, avec id, fullName et phone seulement', async () => {
    const res = await drivers(manager, plateau).expect(200);
    const ids = res.body.map((u: { id: string }) => u.id);
    expect(ids).toContain(driver.id);
    expect(ids).toContain(groupDriver.id);
    for (const u of res.body) expect(Object.keys(u).sort()).toEqual(['fullName', 'id', 'phone']);
  });

  it('exclut les utilisateurs sans « Gérer les livraisons » et les livreurs d’un autre établissement', async () => {
    const ids = (await drivers(manager, plateau).expect(200)).body.map((u: { id: string }) => u.id);
    expect(ids).not.toContain(cashier.id);
    expect(ids).not.toContain(driverYop.id);
  });

  it('exclut les utilisateurs inactifs ou supprimés', async () => {
    const ids = (await drivers(manager, plateau).expect(200)).body.map((u: { id: string }) => u.id);
    expect(ids).not.toContain(inactive.id);
    expect(ids).not.toContain(deleted.id);
  });

  it('exclut les utilisateurs d’une autre entreprise', async () => {
    const ids = (await drivers(admin, plateau).expect(200)).body.map((u: { id: string }) => u.id);
    expect(ids).not.toContain(foreignId);
  });

  it('refuse l’appel sans « Gérer les commandes clients » ou hors de ses établissements', async () => {
    await drivers(cashier, plateau).expect(403);
    await drivers(driver, plateau).expect(403);
    await api(app, manager).get(`/api/deliveries/drivers?establishmentId=${yopougon}`).expect(403);
  });

  it('chaque livreur listé est accepté à l’affectation (même règle que checkDriver)', async () => {
    const customer = (await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Awa Koné' }).expect(201)).body.id;
    const fee = { kind: 'FEE', label: 'Prestation', quantity: 1, unitPrice: 1000, taxRate: 0 };
    const order = (await api(app, manager, plateau).post('/api/customer-orders').send({ establishmentId: plateau, customerId: customer, lines: [fee] }).expect(201)).body.id;
    await api(app, manager, plateau).post(`/api/customer-orders/${order}/status`).send({ status: 'CONFIRMED' }).expect(201);
    const listed = (await drivers(manager, plateau).expect(200)).body as { id: string }[];
    const d = (await api(app, manager, plateau).post(`/api/customer-orders/${order}/deliveries`).send({ address: 'Cocody Riviera 3' }).expect(201)).body.id;
    for (const u of listed) await api(app, manager, plateau).patch(`/api/deliveries/${d}`).send({ driverId: u.id }).expect(200);
    await api(app, manager, plateau).patch(`/api/deliveries/${d}`).send({ driverId: driverYop.id }).expect(400);
  });
});
