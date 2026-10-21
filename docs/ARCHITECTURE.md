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

## Module 2 — Catalogue

Choix fonctionnels validés le 21/10/2026 :

| Sujet | Règle |
|---|---|
| Marque | Portée par l'offre fournisseur et (module 3) par le lot. L'article reste « Farine T55 » : les recettes ne dépendent pas de la marque. |
| Unités | Stock d'une matière en kg, L ou unité. Conditionnements (sac 25 kg…) et offres fournisseurs exprimés dans cette unité ; elle est verrouillée dès qu'ils existent. Prix au kg = prix du sac ÷ contenu. |
| Prix de vente | TTC. Prix de base groupe + prix d'exception par établissement. Chaque changement ferme l'ancienne ligne (`valid_to`) et en ouvre une nouvelle : l'historique est complet, protégé par trigger (ni suppression, ni modification) et par un index unique partiel (un seul prix en vigueur par périmètre). |
| TVA | Taux par produit (0 % par défaut), inclus dans le prix TTC. |
| Types de produit | Fabriqué (recette au module 4), revendu (acheté chez un fournisseur), menu (composé d'autres produits, sans menu imbriqué). |
| Droits | Catalogue (produits, matières, catégories) et prix de base : niveau groupe. Prix d'exception et disponibilité : dans l'établissement concerné. Fournisseurs : permission dans au moins un établissement (fichier commun, audité). |
| Suppression | Aucune : archivage (`is_active`). |

Migrations : générées par différence entre le schéma Prisma de la version
précédente et le nouveau (`prisma migrate diff --from-schema-datamodel …`),
complétées à la main par les contraintes que Prisma ne sait pas exprimer
(CHECK, index partiels, triggers). Application avec `prisma migrate deploy`.

## Module 3 — Achats & stock

Choix fonctionnels validés le 21/10/2026 :

| Sujet | Règle |
|---|---|
| Valorisation | Coût réel par lot (prix d'achat TTC ÷ contenu). Valeur du stock = somme des lots ; coût moyen calculé. |
| Sorties | FEFO (le lot qui périme le plus tôt, puis le plus ancien), lot imposable. Jamais de stock négatif ni d'entame du stock réservé (verrous + CHECK en base). |
| Péremption | Lot périmé bloqué pour l'usage (sortie, transfert, déplacement, correction) ; sort uniquement par une perte « péremption », l'inventaire ou un retour fournisseur. |
| Réception | Avec commande ou directe (tracée). Contrôle : quantités refusées avec motif. Écart de quantité ou de prix avec la commande : motif obligatoire ; le prix réel valorise le lot. Date d'expiration obligatoire pour une matière périssable. |
| Commandes | Brouillon → validée (par un détenteur de « purchases.manage », éventuellement l'auteur) → partiellement reçue → reçue / clôturée (reliquat) ; annulable tant que rien n'est reçu. Les demandes d'achat sont rattachées à la commande. |
| Factures fournisseurs | Rattachées à des réceptions (une réception n'est facturée qu'une fois) ; écart affiché ; montant de la facture = montant dû. Annulation tracée uniquement sans règlement. |
| Paiements | Partiels, multi-factures, avance possible (affectable plus tard), jamais au-delà du reste à payer ; annulation tracée. Lien avec la caisse : module 5. |
| Retours | Sortie des lots du fournisseur au coût du lot + avoir (imputable sur une facture). |
| Corrections | Demande (stock.adjust) puis validation (inventory.validate). Les pertes avec cause sont immédiates. |
| Inventaire | Gel de l'emplacement pendant le comptage ; écarts justifiés ; surplus valorisés au coût proposé (dernier lot, sinon offre préférée) ; sert aussi d'inventaire d'ouverture. |
| Transferts | Demande (destination) → validation, préparation, expédition (source) → réception (destination) → clôture. Mêmes lots de bout en bout ; manque = perte « transit » de la source. |
| Emplacements | « Magasin principal » créé automatiquement par établissement ; autres emplacements libres. |
| Seuils | Par article et par établissement ; statut « sous le seuil » / « critique ». |
| Réservations | Mécanisme en place (physique / réservé / disponible) ; alimenté par les modules 4 et 7. |

Les modèles des modules 1 et 2 ne sont pas modifiés : les clés étrangères du
module 3 vers leurs tables sont déclarées en SQL dans la migration.
Le journal `stock_movements` est en ajout seul (trigger) ; soldes, lots,
réceptions, factures et paiements fournisseurs ne peuvent pas être supprimés.

### Anti double envoi (double clic, double paiement, coupure réseau)

Chaque création du module 3 (demande, commande, réception, retour, facture,
paiement, perte, correction, déplacement, transfert) accepte un
`clientRequestId` (UUID généré une fois par formulaire et renvoyé à chaque
tentative). Un index unique `(company_id, client_request_id)` garantit qu'un
même envoi ne crée qu'un document ; les envois suivants, même simultanés,
reçoivent le document déjà créé. Un identifiant ne peut être rejoué que par
l'utilisateur qui l'a émis. Les changements de statut (valider, expédier,
recevoir…) sont protégés par leur contrôle de statut (409 au second envoi).

### Droits du module 3 par rôle (validés le 21/10/2026)

Les rôles par défaut sont définis dans le module 1 et ne sont pas modifiés ;
la répartition ci-dessous découle des permissions qu'ils détiennent et des
règles du module 3. Un administrateur peut ajuster les rôles depuis l'écran
« Rôles & permissions ».

| Action | Permission exigée | Rôles par défaut |
|---|---|---|
| Voir stock, lots, mouvements, pertes, inventaires, transferts | stock.view | Admin, Directeur, Responsable, Resp. achats, Magasinier, Resp. production, Chef de cuisine |
| Créer une demande d'achat (voir/annuler les siennes) | stock.view | idem |
| Voir toutes les demandes, commandes, réceptions, retours, factures, paiements, comptes fournisseurs | purchases.view | Admin, Directeur, Responsable, Resp. achats, Magasinier, Comptable |
| Refuser une demande ; créer, modifier, valider, annuler, clôturer une commande | purchases.manage | Admin, Directeur, Responsable, Resp. achats |
| Réceptionner (avec ou sans commande) ; retour fournisseur | purchases.receive | Admin, Directeur, Responsable, Resp. achats, Magasinier |
| Factures fournisseurs, paiements, avances, annulations | supplier_payments.manage | Admin, Directeur, Resp. achats, Comptable |
| Déclarer une perte | stock.adjust OU production.manage | Admin, Directeur, Responsable, Magasinier, Resp. production, Chef de cuisine |
| Demander une correction ; déplacer entre emplacements ; emplacements ; seuils | stock.adjust | Admin, Directeur, Responsable, Magasinier, Resp. production |
| Valider / refuser une correction | inventory.validate | Admin, Directeur, Responsable |
| Ouvrir un inventaire, compter | inventory.manage | Admin, Directeur, Responsable, Magasinier |
| Valider / annuler un inventaire | inventory.validate | Admin, Directeur, Responsable |
| Demander un transfert (destination), préparer, expédier (source), réceptionner (destination), clôturer, annuler | stock.transfer | Admin, Directeur, Responsable, Magasinier |
| Valider un transfert (source) | stock.transfer ET inventory.validate | Admin, Directeur, Responsable |

Serveur, Caissier, Livreur : aucun accès au module 3.
Chaque permission s'apprécie dans l'établissement concerné (rôle attribué
au site) ou au niveau groupe (rôle sans établissement).

## Module 4 — Recettes & production

Décisions validées le 22/10/2026 :

| # | Sujet | Règle |
|---|---|---|
| A | Coût de revient | Estimé : lots qui seraient consommés en FEFO dans l'établissement (non périmés, hors réservé), puis dernier prix d'achat (à défaut dernière production, coût de la sous-recette, offre fournisseur). Réel : valeur exacte des lots consommés. |
| B | Sous-recettes | Un produit fabriqué stocké peut être ingrédient ; boucles refusées (à l'enregistrement et à l'activation) ; coût et traçabilité en cascade. |
| C | Consommation | Au lancement (quantités théoriques, FEFO) ; à la fin, supplément ou reste rendu avec motif. |
| D | Réservation | À la validation (FEFO, lots non périmés) ; libérée au lancement ou à l'annulation ; refus si stock disponible insuffisant. |
| E | Contrôle | Produit en stock dès « Terminée » ; contrôle par un détenteur de « Valider un inventaire », autre que celui qui a terminé ; non-conformité = perte (stock_losses). |
| F | Péremption | Durée de conservation par version de recette → péremption du lot produit. |
| G | Niveau | Recettes communes au groupe, écriture au niveau groupe ; coûts par établissement. |
| H | Magasinier | Lecture des ordres validés et suivants de son site (« Voir les stocks »). |
| I | Marge | Sur le prix HT (TTC ÷ (1 + TVA)). |
| J | Écarts | Manque = perte de production (cause et motif) ; surplus accepté avec motif ; coût unitaire sur la quantité bonne. |

Versions : une seule active (index unique partiel) ; une version publiée et
ses ingrédients ne se modifient plus, même en SQL (triggers). Consommations,
sorties et pertes de production en ajout seul ; ordres et réservations jamais
supprimés. Toutes les opérations verrouillent les soldes concernés en une
seule requête triée (pas d'interblocage entre productions simultanées).

Module 3 : seules les énumérations ont changé (origine de lot PRODUCTION,
mouvements CONSUMPTION et PRODUCTION) ; le moteur de stock est réutilisé tel
quel.

### Droits du module 4 par rôle

| Action | Permission | Rôles par défaut |
|---|---|---|
| Voir les recettes, coûts et marges | recipes.view | Admin, Directeur, Responsable, Resp. production, Chef de cuisine |
| Créer / modifier / activer / archiver une recette | recipes.manage au niveau groupe | Admin, Directeur (et tout rôle de groupe détenant la permission) |
| Voir tous les ordres de production | production.view | Admin, Directeur, Responsable, Resp. production, Chef de cuisine |
| Voir les ordres validés et suivants (lecture) | stock.view | + Magasinier, Resp. achats |
| Planifier, modifier, valider, lancer, terminer, annuler | production.manage | Admin, Directeur, Responsable, Resp. production, Chef de cuisine |
| Contrôler (autre que celui qui a terminé) | inventory.validate | Admin, Directeur, Responsable |
| Traçabilité d'un lot | stock.view (lot passé par l'établissement) | Admin, Directeur, Responsable, Resp. achats, Magasinier, Resp. production, Chef de cuisine |

## Module 5 — Caisse & ventes

Décisions validées le 23/10/2026 :

| # | Sujet | Règle |
|---|---|---|
| 1 | Stock vendu | Chaque caisse est liée à un emplacement de son établissement (Magasin principal par défaut). |
| 2 | Stock insuffisant | Vente refusée ; jamais de stock négatif. |
| 3 | Fabrication à la commande | Hors module 5 (module 6). |
| 4 | Menus | Vendus à leur propre prix ; leurs composants sortent du stock et donnent le coût réel. |
| 5 | Session | Une session = une caisse = un caissier (index uniques partiels). |
| 6 | Clôture | Le caissier compte et clôture ; un responsable (autre que le caissier) valide ; écart enregistré, non bloquant. |
| 7 | Annulation / remboursement | Rien n'est supprimé : retour numéroté, mouvements inverses, audit. Annulation seulement dans la session encore ouverte ; ensuite remboursement. |
| 8 | Remises | % ou montant, par ligne ou sur le ticket, avec permission et motif obligatoire ; sans plafond. |
| 9 | Prix | Non modifiable à la caisse (prix local, sinon prix de base). |
| 10 | Mobile money | Référence saisie après confirmation ; abstraction de prestataire prête pour une intégration API. |
| 11 | Paiements | Plusieurs moyens ; monnaie rendue uniquement sur les espèces. |
| 12 | Impression | Imprimante thermique réseau (ESC/POS, port 9100) ; repli navigateur ; pas d'USB. |
| 13 | Numéro de ticket | Unique, jamais réutilisé, séquence monotone et traçable ; attribué hors transaction : un numéro attribué à une vente qui échoue est tracé (audit SALE_NUMBER_VOIDED), sans garantie d'absence de trou. |
| 14 | Crédit client | Hors module 5 (module 7). |
| 15 | Paiement fournisseur en caisse | Hors module 5 (module 8) ; sortie manuelle d'espèces avec motif disponible. |
| 16 | Hors ligne | Non. |
| 17 | Configuration des caisses | Responsable de l'établissement (permissions existantes). |
| 18 | TVA | Prix TTC sur le ticket, détail HT / TVA par taux quand des produits y sont soumis. |

Flux d'une vente (une transaction) : verrou de la session, verrou des soldes
des produits vendus en une requête triée, sortie par le moteur de stock du
module 3 (mouvements SALE, FEFO, lots périmés exclus, réservé jamais entamé,
inventaire en cours bloquant), lignes et lots vendus, paiements, mouvements de
caisse, audit, travail d'impression. L'impression réseau a lieu après la
validation : une imprimante éteinte ne bloque jamais la vente (ticket en échec,
relance ou repli navigateur).

Retours : annulation et remboursement remettent en stock les mêmes lots
(mouvements SALE_RETURN) ou déclarent une perte « retour client » ; le
remboursement est prorata, la dernière unité solde exactement la ligne, et peut
être réparti entre les moyens de paiement de la vente, chacun dans la limite de
ce qu'il a encaissé.

Protection en base : ventes, lignes, lots vendus, sessions et tickets ne se
mettent à jour que sur leurs colonnes d'état (trigger `only_columns_update`) ;
paiements, mouvements de caisse, clôtures et retours en ajout seul ; rien ne se
supprime. Adresse d'imprimante limitée au réseau local.

Traçabilité : vente → lots vendus → production → matières et fournisseurs
(réutilise la traçabilité du module 4) ; lot → produits finis fabriqués avec
lui → tickets.

Modules précédents : seules les valeurs SALE et SALE_RETURN ont été ajoutées
aux mouvements du module 3 ; moteur de stock, numérotation, audit, anti double
envoi et traçabilité réutilisés tels quels.

### Droits du module 5 par rôle

| Action | Permission | Rôles par défaut |
|---|---|---|
| Ouvrir, compter et clôturer sa session ; relancer une impression | cash.operate | Responsable, Caissier |
| Vendre | sales.create | Responsable, Caissier |
| Remise | sales.discount | Responsable |
| Annuler une vente | sales.cancel | Responsable |
| Rembourser (depuis sa propre session ouverte) | sales.refund | Responsable |
| Réimprimer un duplicata | tickets.reprint | Responsable |
| Entrées / sorties manuelles d'espèces | cash.movements | Responsable |
| Voir toutes les sessions et rapports Z | cash.view_all | Responsable, Comptable |
| Valider une clôture ; configurer les caisses | cash.view_all + cash.movements | Responsable |
| Voir les ventes | sales.view | Responsable, Caissier, Comptable |
| Traçabilité amont d'une vente | stock.view | Responsable, Magasinier, Resp. achats, production |

(Admin et Directeur détiennent toutes ces permissions au niveau groupe.)
