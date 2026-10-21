import { execSync } from 'node:child_process';
import { join } from 'node:path';

// Met le schéma de la base de test à jour avant la suite.
export default async function globalSetup() {
  require('./env');
  // Garde-fou : on ne vide jamais une base dont le nom ne finit pas par _test.
  const dbName = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname;
  if (!dbName.endsWith('_test')) {
    throw new Error(`Sécurité : la base de test doit se terminer par "_test" (reçu : ${dbName})`);
  }
  // migrate deploy : applique les migrations manquantes, sans rien effacer.
  // Le vidage des données est fait par resetDatabase() (helpers.ts), protégé lui aussi.
  execSync('npx prisma migrate deploy', {
    cwd: join(__dirname, '..'),
    env: process.env,
    stdio: 'pipe',
  });
}
