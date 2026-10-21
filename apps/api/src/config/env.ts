// Lecture et validation des variables d'environnement au démarrage.
// L'application refuse de démarrer si une variable obligatoire manque.

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`Variable ${name} invalide : ${raw}`);
  return value;
}

export interface AppEnv {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  jwtAccessSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  corsOrigins: string[];
  maxFailedLogins: number;
  lockoutMinutes: number;
}

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const jwtAccessSecret = required('JWT_ACCESS_SECRET');
  if (jwtAccessSecret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET doit contenir au moins 32 caractères');
  }
  cached = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: int('PORT', 3000),
    databaseUrl: required('DATABASE_URL'),
    jwtAccessSecret,
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 900),
    refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 7),
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    maxFailedLogins: int('MAX_FAILED_LOGINS', 5),
    lockoutMinutes: int('LOCKOUT_MINUTES', 15),
  };
  return cached;
}
