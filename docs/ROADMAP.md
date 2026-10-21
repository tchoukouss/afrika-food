# Feuille de route AFRIKA FOOD

Chaque module est testé (tests de bout en bout, permissions, transactions,
régressions) avant de passer au suivant.

| # | Module | Contenu | État |
|---|---|---|---|
| 1 | Fondations | Entreprise, établissements (5 types), utilisateurs, rôles par établissement, permissions, sessions sécurisées, audit en ajout seul, numérotation | Validé — 24/24 tests |
| 2 | Catalogue | Unités et conversions (sac ↔ kg), catégories, matières premières (farine…), produits finis, prix par établissement, historique des prix, fournisseurs | À faire |
| 3 | Achats & stock | Demandes et commandes fournisseurs, réceptions, lots (DLC), mouvements de stock, stock par magasin, réservations, inventaires, transferts inter-sites, pertes | À faire |
| 4 | Recettes & production | Fiches techniques versionnées, coût de revient réel, ordres de production, consommation FEFO par lot, traçabilité lot → produit | À faire |
| 5 | Caisse & ventes | Caisses, sessions (fond, clôture, écart), ventes POS, paiements multiples (espèces, Orange Money, MTN, Moov, Wave, carte), abstraction des paiements mobiles, tickets ESC/POS, réimpression tracée, annulation, remboursement | À faire |
| 6 | Restaurant | Salles, tables et statuts, commandes (table, comptoir, emporter, téléphone, livraison), écran cuisine, addition, réservations | À faire |
| 7 | Clients & facturation | Clients, commandes et événements, devis, acomptes, factures, avoirs, paiements partiels, créances, limite de crédit, livraisons | À faire |
| 8 | Pilotage | Dépenses, notifications, recherche globale, rapports et exports PDF/Excel/CSV, tableau de bord direction | À faire |
