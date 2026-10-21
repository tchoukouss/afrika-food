# AFRIKA FOOD

ERP multisite pour pâtisseries, boulangeries et restaurants (FCFA / XOF).

```
apps/api   Backend NestJS 11 + Prisma 6 + PostgreSQL
apps/web   Frontend React 19 + Vite + Tailwind CSS 4
docs/      Architecture, feuille de route
scripts/   Sauvegarde de la base
```

## Prérequis

- Node.js 22+ (testé avec 24)
- PostgreSQL 15+ (testé avec 18)

## Installation

1. **Base de données** (une seule fois, dans `psql` en tant que `postgres`) :

   ```sql
   CREATE ROLE afrika_food WITH LOGIN PASSWORD '...' CREATEDB;
   CREATE DATABASE afrika_food OWNER afrika_food;
   CREATE DATABASE afrika_food_test OWNER afrika_food;
   ```

2. **Dépendances** :

   ```bash
   npm install
   npm install-scripts approve argon2 prisma @prisma/engines @prisma/client   # npm 11+
   ```

3. **Configuration** : copier `apps/api/.env.example` vers `apps/api/.env` et remplir
   `DATABASE_URL`, `JWT_ACCESS_SECRET` (≥ 32 caractères aléatoires),
   `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`.
   Pour les tests : copier `apps/api/.env.test.example` vers `apps/api/.env.test`
   (la base doit finir par `_test`, elle est vidée à chaque lancement).

4. **Schéma et données initiales** :

   ```bash
   cd apps/api
   npx prisma migrate deploy
   npm run db:seed        # crée l'entreprise, les rôles et le premier administrateur
   ```

5. **Lancement en développement** (deux terminaux, depuis la racine) :

   ```bash
   npm run dev:api        # http://localhost:3000/api  — documentation : /api/docs
   npm run dev:web        # http://localhost:5173
   ```

   À la première connexion, l'administrateur doit changer son mot de passe.

## Tests

```bash
npm test                 # tests de bout en bout sur la base afrika_food_test
```

## Variables d'environnement (`apps/api/.env`)

| Variable | Rôle | Défaut |
|---|---|---|
| `DATABASE_URL` | Connexion PostgreSQL | — (obligatoire) |
| `JWT_ACCESS_SECRET` | Signature des jetons d'accès (≥ 32 car.) | — (obligatoire) |
| `ACCESS_TOKEN_TTL_SECONDS` | Durée du jeton d'accès | 900 |
| `REFRESH_TOKEN_TTL_DAYS` | Durée de session sans activité | 7 |
| `MAX_FAILED_LOGINS` / `LOCKOUT_MINUTES` | Verrouillage après échecs | 5 / 15 |
| `PORT` | Port de l'API | 3000 |
| `CORS_ORIGINS` | Origines autorisées (si front sur un autre domaine) | http://localhost:5173 |
| `SEED_*` | Entreprise et premier administrateur (seed) | — |

## Sauvegardes

```powershell
powershell -File scripts\backup.ps1           # dump compressé dans backups\, rotation 30 jours
```

À planifier chaque jour (Planificateur de tâches Windows). Copier régulièrement
le dossier `backups\` hors de la machine (disque externe, cloud).

**Restauration** (sur une base vide) :

```powershell
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -h localhost -U afrika_food -d afrika_food --clean --if-exists backups\afrika_food_AAAA-MM-JJ_HHMM.dump
```

Tester une restauration sur une base de test au moins une fois par mois.

## Déploiement (production)

1. `npm ci && npm run build`
2. `apps/api/.env` avec `NODE_ENV=production` et un `JWT_ACCESS_SECRET` propre à la production.
3. `cd apps/api && npx prisma migrate deploy && npm run db:seed`
4. Lancer `node apps/api/dist/main.js` via un gestionnaire de services (PM2, NSSM…).
5. Servir `apps/web/dist` et faire suivre `/api` vers le port de l'API derrière un
   reverse proxy (Nginx, Caddy) en **HTTPS** obligatoire (le cookie de session est `Secure`).

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) et [docs/ROADMAP.md](docs/ROADMAP.md).
