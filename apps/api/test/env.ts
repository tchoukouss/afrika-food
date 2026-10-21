import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Les tests utilisent exclusivement la base définie dans .env.test.
const file = join(__dirname, '..', '.env.test');
if (!existsSync(file)) {
  throw new Error('Créer apps/api/.env.test (voir .env.test.example) avant de lancer les tests');
}
process.loadEnvFile(file);
process.env.NODE_ENV = 'test';
process.env.DISABLE_THROTTLE = 'true';
