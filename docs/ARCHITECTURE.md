# Architecture d'AFRIKA FOOD

```
React (apps/web)  ──HTTP /api──▶  NestJS (apps/api)  ──Prisma──▶  PostgreSQL
                                    │
                                    ├─ AuthGuard global : jeton, session, droits
                                    ├─ Services métier (transactions)
                                    └─ AuditService (journal en ajout seul)
```

## Principes

- **Multi-entreprise et multisite** : chaque donnée métier porte `company_id`, et
  `establishment_id` quand elle dépend d'un site. L'en-tête `X-Establishment-Id`
  indique l'établissement de travail ; sans en-tête, la requête est « niveau groupe ».
- **Permissions côté serveur** : `@RequirePermissions('sales.create')` sur chaque route.
  Un rôle est attribué à un utilisateur **pour un établissement** ou **pour tout le
  groupe** (`user_roles.establishment_id` NULL). Droits effectifs dans un
  établissement = rôles groupe ∪ rôles de cet établissement.
  - `@GroupScope()` : permission exigée au niveau groupe (création d'établissement, rôles).
  - `@AnyEstablishmentScope()` : permission dans au moins un établissement, le service
    filtre ensuite les données (listes consolidées).
- **Pas d'escalade de privilèges** : on ne peut attribuer un rôle que si l'on détient
  toutes ses permissions dans le périmètre concerné. Il reste toujours au moins un
  administrateur actif.
- **Audit** : `AuditService.record(entry, tx)` écrit dans la même transaction que
  l'opération (validé ou annulé avec elle). Table `audit_logs` protégée par trigger :
  aucune modification ni suppression possible, même en SQL direct. Les secrets
  (mots de passe, jetons) sont filtrés.
- **Suppression logique** : `deleted_at` ; jamais de DELETE sur les données métier.
- **Concurrence** : verrous de ligne (`SELECT … FOR UPDATE`) dans les transactions
  de modification ; numérotation atomique par `INSERT … ON CONFLICT … RETURNING`
  (table `document_sequences`), sans doublon et sans trou en cas d'annulation.
- **Montants** : FCFA entiers (pas de décimales flottantes).

## Authentification

| Élément | Choix |
|---|---|
| Mot de passe | argon2id ; 8 car. min. avec lettre et chiffre ; changement obligatoire à la 1re connexion |
| Jeton d'accès | JWT HS256, 15 min, en mémoire côté navigateur (jamais en localStorage) |
| Session | cookie `af_refresh` httpOnly, SameSite=Strict, chemin `/api/auth`, Secure en production |
| Rotation | nouveau jeton de rafraîchissement à chaque usage ; réutilisation d'un ancien jeton ⇒ session révoquée |
| Révocation | chaque requête vérifie la session et le compte : déconnexion/désactivation immédiates |
| Force brute | 10 tentatives/min/IP sur `/auth/login` ; compte verrouillé 15 min après 5 échecs |
| CSRF | API par en-tête `Authorization` ; cookie limité au renouvellement, SameSite=Strict |

## Organisation du code (API)

```
src/
  auth/           connexion, sessions, garde global, catalogue des permissions
  audit/          journal d'audit et événements de sécurité
  sequences/      numérotation des documents
  company/  establishments/  users/  roles/
  common/         contexte de requête, filtre d'erreurs Prisma
prisma/
  schema.prisma   modèle de données
  migrations/     migrations SQL versionnées
  bootstrap-data  initialisation idempotente (permissions, rôles, admin)
test/             tests de bout en bout (vraie base PostgreSQL)
```
