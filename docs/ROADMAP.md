# Feuille de route AFRIKA FOOD

Chaque module est testé (tests de bout en bout, permissions, transactions,
régressions) avant de passer au suivant.

| # | Module | Contenu | État |
|---|---|---|---|
| 1 | Fondations | Entreprise, établissements (5 types), utilisateurs, rôles par établissement, permissions, sessions sécurisées, audit en ajout seul, numérotation | Validé — 24/24 tests |
| 2 | Catalogue | Unités et conversions (sac ↔ kg), catégories, matières premières (farine…) et conditionnements, fournisseurs et offres (marque, prix au sac → prix au kg), produits fabriqués / revendus / menus, prix TTC groupe + exception par site historisés, disponibilité par site, TVA par produit | Développé — 23 tests (47 au total) |
| 3 | Achats & stock | Emplacements, lots au coût réel (FEFO, lots périmés bloqués), journal des mouvements, seuils, demandes et commandes fournisseurs, réceptions avec contrôle (avec ou sans commande), factures / paiements / avances / retours et avoirs fournisseurs, pertes, corrections validées, inventaires avec gel, déplacements, transferts inter-sites avec perte en transit | Développé — 31 tests (78 au total) |
| 4 | Recettes & production | Fiches techniques versionnées (une active, publiées figées), sous-recettes sans boucle, coût de revient (lots FEFO puis dernier prix d'achat) et marge sur le HT, ordres de production (réservation, consommation par lot, écarts, produits finis avec péremption, pertes, contrôle), traçabilité amont / aval | Développé — 19 tests (100 au total) |
| 5 | Caisse & ventes | Caisses, sessions (fond, clôture, écart), ventes POS, paiements multiples (espèces, Orange Money, MTN, Moov, Wave, carte), abstraction des paiements mobiles, tickets ESC/POS, réimpression tracée, annulation, remboursement | Développé — 19 tests (119 au total) |
| 6 | Restaurant | Salles, tables et statuts, commandes (table, comptoir, emporter, téléphone, livraison), écran cuisine, addition, réservations | Développé — 22 tests (141 au total) |
| 7 | Clients & facturation | Clients, commandes et événements, devis, acomptes, factures, avoirs, paiements partiels, créances, limite de crédit, livraisons | À faire |
| 8 | Pilotage | Dépenses, notifications, recherche globale, rapports et exports PDF/Excel/CSV, tableau de bord direction | À faire |
