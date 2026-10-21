// Catalogue des permissions d'AFRIKA FOOD.
// Source de vérité unique : synchronisé en base par le seed et utilisé
// par les décorateurs @RequirePermissions côté API.

export interface PermissionDef {
  code: string;
  module: string;
  label: string;
}

const P = (code: string, module: string, label: string): PermissionDef => ({ code, module, label });

export const PERMISSIONS: PermissionDef[] = [
  // Administration
  P('company.manage', 'Administration', "Modifier les informations de l'entreprise"),
  P('establishments.view', 'Administration', 'Voir les établissements'),
  P('establishments.manage', 'Administration', 'Créer / modifier les établissements'),
  P('users.view', 'Administration', 'Voir les utilisateurs'),
  P('users.manage', 'Administration', 'Gérer les utilisateurs'),
  P('roles.manage', 'Administration', 'Gérer les rôles et permissions'),
  P('audit.view', 'Administration', "Consulter le journal d'audit"),
  P('security.view', 'Administration', 'Consulter les événements de sécurité'),

  // Produits et prix
  P('products.view', 'Produits', 'Voir les produits'),
  P('products.manage', 'Produits', 'Gérer les produits'),
  P('prices.manage', 'Produits', 'Modifier les prix'),

  // Fournisseurs et achats
  P('suppliers.view', 'Achats', 'Voir les fournisseurs'),
  P('suppliers.manage', 'Achats', 'Gérer les fournisseurs'),
  P('purchases.view', 'Achats', 'Voir les achats'),
  P('purchases.manage', 'Achats', 'Gérer les commandes fournisseurs'),
  P('purchases.receive', 'Achats', 'Réceptionner une livraison'),
  P('supplier_payments.manage', 'Achats', 'Payer les fournisseurs'),

  // Stock
  P('stock.view', 'Stock', 'Voir les stocks'),
  P('stock.adjust', 'Stock', 'Ajuster le stock / déclarer une perte'),
  P('stock.transfer', 'Stock', 'Gérer les transferts'),
  P('inventory.manage', 'Stock', 'Effectuer un inventaire'),
  P('inventory.validate', 'Stock', 'Valider un inventaire'),

  // Recettes et production
  P('recipes.view', 'Production', 'Voir les recettes'),
  P('recipes.manage', 'Production', 'Gérer les recettes'),
  P('production.view', 'Production', 'Voir la production'),
  P('production.manage', 'Production', 'Lancer / clôturer une production'),

  // Ventes et caisse
  P('sales.view', 'Ventes', 'Voir les ventes'),
  P('sales.create', 'Ventes', 'Créer une vente'),
  P('sales.cancel', 'Ventes', 'Annuler une vente'),
  P('sales.discount', 'Ventes', 'Accorder une remise'),
  P('sales.refund', 'Ventes', 'Effectuer un remboursement'),
  P('tickets.reprint', 'Ventes', 'Réimprimer un ticket'),
  P('cash.operate', 'Caisse', 'Ouvrir / clôturer une caisse'),
  P('cash.movements', 'Caisse', 'Entrées / sorties manuelles de caisse'),
  P('cash.view_all', 'Caisse', 'Voir toutes les caisses'),

  // Restaurant
  P('restaurant.orders', 'Restaurant', 'Prendre les commandes'),
  P('restaurant.orders_edit', 'Restaurant', 'Retirer un article envoyé en cuisine'),
  P('restaurant.kitchen', 'Restaurant', 'Écran cuisine'),
  P('restaurant.tables', 'Restaurant', 'Gérer salles et tables'),

  // Clients, commandes, facturation
  P('customers.view', 'Clients', 'Voir les clients'),
  P('customers.manage', 'Clients', 'Gérer les clients'),
  P('customer_orders.manage', 'Clients', 'Gérer les commandes clients / événements'),
  P('invoices.view', 'Facturation', 'Voir les factures'),
  P('invoices.manage', 'Facturation', 'Émettre / annuler des factures'),
  P('payments.manage', 'Facturation', 'Encaisser paiements et acomptes'),
  P('receivables.view', 'Facturation', 'Consulter les créances'),
  P('credit.override', 'Facturation', 'Autoriser un dépassement de crédit'),
  P('deliveries.manage', 'Livraisons', 'Gérer les livraisons'),

  // Dépenses et rapports
  P('expenses.view', 'Dépenses', 'Voir les dépenses'),
  P('expenses.manage', 'Dépenses', 'Saisir des dépenses'),
  P('reports.view', 'Rapports', 'Consulter les rapports'),
  P('dashboard.view', 'Rapports', 'Tableau de bord direction'),
];

export const ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

export interface DefaultRoleDef {
  code: string;
  name: string;
  description: string;
  permissions: string[];
}

const viewAll = ALL_PERMISSION_CODES.filter((c) => c.endsWith('.view'));

// Dédoublonnage : une permission présente deux fois ferait échouer l'insertion.
export const DEFAULT_ROLES: DefaultRoleDef[] = ([

  {
    code: 'ADMIN',
    name: 'Administrateur',
    description: 'Accès complet au système',
    permissions: ALL_PERMISSION_CODES,
  },
  {
    code: 'DIRECTOR',
    name: 'Directeur',
    description: 'Pilotage du groupe, rapports et validations',
    permissions: ALL_PERMISSION_CODES.filter((c) => !['roles.manage', 'company.manage'].includes(c)),
  },
  {
    code: 'MANAGER',
    name: "Responsable d'établissement",
    description: "Gestion opérationnelle d'un établissement",
    permissions: [
      ...viewAll.filter((c) => !['security.view'].includes(c)),
      // users.manage limité à son établissement, sans pouvoir donner plus que ses propres droits.
      'users.view', 'users.manage', 'products.manage', 'prices.manage', 'purchases.manage', 'purchases.receive',
      'stock.adjust', 'stock.transfer', 'inventory.manage', 'inventory.validate',
      'recipes.manage', 'production.manage', 'sales.create', 'sales.cancel', 'sales.discount',
      'sales.refund', 'tickets.reprint', 'cash.operate', 'cash.movements', 'cash.view_all',
      'restaurant.orders', 'restaurant.orders_edit', 'restaurant.kitchen', 'restaurant.tables',
      'customers.manage', 'customer_orders.manage', 'invoices.manage', 'payments.manage',
      'credit.override', 'deliveries.manage', 'expenses.manage',
    ],
  },
  {
    code: 'PURCHASER',
    name: 'Responsable achats',
    description: 'Fournisseurs et commandes fournisseurs',
    permissions: [
      'products.view', 'suppliers.view', 'suppliers.manage', 'purchases.view', 'purchases.manage',
      'purchases.receive', 'supplier_payments.manage', 'stock.view',
    ],
  },
  {
    code: 'STOREKEEPER',
    name: 'Magasinier',
    description: 'Réceptions, stock, inventaires et transferts',
    permissions: [
      'products.view', 'suppliers.view', 'purchases.view', 'purchases.receive', 'stock.view',
      'stock.adjust', 'stock.transfer', 'inventory.manage',
    ],
  },
  {
    code: 'PRODUCTION_MANAGER',
    name: 'Responsable production',
    description: 'Recettes et ordres de production',
    permissions: [
      'products.view', 'stock.view', 'recipes.view', 'recipes.manage', 'production.view',
      'production.manage', 'stock.adjust',
    ],
  },
  {
    code: 'HEAD_CHEF',
    name: 'Chef de cuisine',
    description: 'Cuisine, recettes et production restaurant',
    permissions: [
      'products.view', 'stock.view', 'recipes.view', 'recipes.manage', 'production.view',
      'production.manage', 'restaurant.kitchen',
    ],
  },
  {
    code: 'WAITER',
    name: 'Serveur',
    description: 'Prise de commande en salle',
    permissions: ['products.view', 'restaurant.orders'],
  },
  {
    code: 'CASHIER',
    name: 'Caissier',
    description: 'Ventes et encaissements sur sa caisse',
    permissions: [
      'products.view', 'sales.view', 'sales.create', 'cash.operate', 'restaurant.orders',
      'customers.view', 'payments.manage',
    ],
  },
  {
    code: 'DELIVERY',
    name: 'Livreur',
    description: 'Suivi de ses livraisons',
    permissions: ['deliveries.manage'],
  },
  {
    code: 'ACCOUNTANT',
    name: 'Comptable',
    description: 'Facturation, créances, dépenses et rapports',
    permissions: [
      'sales.view', 'cash.view_all', 'customers.view', 'invoices.view', 'invoices.manage',
      'payments.manage', 'receivables.view', 'expenses.view', 'expenses.manage', 'reports.view',
      'dashboard.view', 'suppliers.view', 'purchases.view', 'supplier_payments.manage', 'audit.view',
    ],
  },
] as DefaultRoleDef[]).map((r) => ({ ...r, permissions: [...new Set(r.permissions)] }));
