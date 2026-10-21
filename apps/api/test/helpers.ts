import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { bootstrapData } from '../prisma/bootstrap-data';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/setup';

export const ADMIN_EMAIL = 'admin@test.ci';
export const ADMIN_PASSWORD = 'Admin2026!';

export async function createTestApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}

/** Vide toutes les tables (TRUNCATE ne déclenche pas les triggers « ajout seul ») puis réinitialise. */
export async function resetDatabase(prisma: PrismaService) {
  // Garde-fou : vérifie la base réellement connectée, pas seulement la configuration.
  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  if (!db.endsWith('_test')) throw new Error(`Refus de vider la base « ${db} » : seule une base *_test est autorisée`);
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  const { company } = await bootstrapData(prisma, {
    companyName: 'AFRIKA FOOD Test',
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    adminName: 'Admin Test',
  });
  // L'admin de test a déjà « changé » son mot de passe.
  await prisma.user.updateMany({ where: { email: ADMIN_EMAIL }, data: { mustChangePassword: false } });
  return company;
}

export interface Session {
  token: string;
  cookie: string;
}

export async function login(app: INestApplication, email: string, password: string): Promise<Session> {
  const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password }).expect(200);
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  return { token: res.body.accessToken, cookie: setCookie.find((c) => c.startsWith('af_refresh='))!.split(';')[0] };
}

/** Requête authentifiée, éventuellement dans le contexte d'un établissement. */
export function api(app: INestApplication, s: Session, establishmentId?: string) {
  const server = app.getHttpServer();
  const wrap = (r: request.Test) => {
    r.set('Authorization', `Bearer ${s.token}`);
    if (establishmentId) r.set('X-Establishment-Id', establishmentId);
    return r;
  };
  return {
    get: (url: string) => wrap(request(server).get(url)),
    post: (url: string) => wrap(request(server).post(url)),
    patch: (url: string) => wrap(request(server).patch(url)),
    put: (url: string) => wrap(request(server).put(url)),
    delete: (url: string) => wrap(request(server).delete(url)),
  };
}

/** Crée un utilisateur via l'API puis le connecte (avec changement du mot de passe provisoire). */
export async function createAndLogin(
  app: INestApplication,
  admin: Session,
  data: { email: string; fullName: string; roles: { roleId: string; establishmentId?: string | null }[] },
): Promise<Session & { id: string }> {
  const created = await api(app, admin).post('/api/users').send({ ...data, password: 'Provisoire1' }).expect(201);
  const first = await login(app, data.email, 'Provisoire1');
  await api(app, first).post('/api/auth/change-password').send({ currentPassword: 'Provisoire1', newPassword: 'Definitif2026' }).expect(204);
  return { ...first, id: created.body.id };
}
