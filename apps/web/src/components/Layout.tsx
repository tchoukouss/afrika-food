import {
  ArrowLeftRight,
  Banknote,
  BookOpen,
  Boxes,
  Building2,
  Calculator,
  CalendarDays,
  ChefHat,
  ClipboardCheck,
  ClipboardList,
  Contact,
  Croissant,
  Factory,
  FileSignature,
  FileText,
  Gauge,
  GitBranch,
  Home,
  KeyRound,
  LayoutGrid,
  ListOrdered,
  LogOut,
  Menu,
  MonitorSmartphone,
  PackageCheck,
  PiggyBank,
  Receipt,
  ReceiptText,
  ScrollText,
  Settings,
  Settings2,
  ShieldCheck,
  ShoppingCart,
  Tags,
  Store,
  Truck,
  Users,
  Wallet,
  Wheat,
  X,
} from 'lucide-react';
import { ReactNode, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { DELIVERY_DRIVER } from '../lib/delivery-types';
import { DEPOSIT_READ } from '../lib/deposit-types';
import { INVOICE_READ, PAYMENT_READ } from '../lib/invoice-types';
import { CUSTOMER_ORDER_READ } from '../lib/order-types';
import { QUOTE_READ } from '../lib/quote-types';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** Permission requise (n'importe quel établissement), ou l'une d'une liste ; absent = toujours visible. */
  permission?: string | string[];
}

// Seuls les modules réellement développés apparaissent dans le menu.
const NAV: { section: string; items: NavItem[] }[] = [
  { section: '', items: [{ to: '/', label: 'Accueil', icon: <Home className="size-4" /> }] },
  {
    section: 'Catalogue',
    items: [
      { to: '/produits', label: 'Produits', icon: <Croissant className="size-4" />, permission: 'products.view' },
      { to: '/matieres', label: 'Matières premières', icon: <Wheat className="size-4" />, permission: 'products.view' },
      { to: '/fournisseurs', label: 'Fournisseurs', icon: <Truck className="size-4" />, permission: 'suppliers.view' },
      { to: '/categories', label: 'Catégories', icon: <Tags className="size-4" />, permission: 'products.view' },
    ],
  },
  {
    section: 'Achats & stock',
    items: [
      { to: '/stock', label: 'Stock', icon: <Boxes className="size-4" />, permission: 'stock.view' },
      { to: '/demandes-achat', label: 'Demandes d’achat', icon: <ClipboardList className="size-4" />, permission: 'stock.view' },
      { to: '/achats', label: 'Achats', icon: <ShoppingCart className="size-4" />, permission: 'purchases.view' },
      { to: '/factures-fournisseurs', label: 'Factures fournisseurs', icon: <Receipt className="size-4" />, permission: 'purchases.view' },
      { to: '/inventaires', label: 'Inventaires', icon: <ClipboardCheck className="size-4" />, permission: 'stock.view' },
      { to: '/transferts', label: 'Transferts', icon: <ArrowLeftRight className="size-4" />, permission: 'stock.view' },
    ],
  },
  {
    section: 'Production',
    items: [
      { to: '/production', label: 'Ordres de production', icon: <Factory className="size-4" />, permission: 'stock.view' },
      { to: '/recettes', label: 'Recettes', icon: <BookOpen className="size-4" />, permission: 'recipes.view' },
      { to: '/couts-marges', label: 'Coûts & marges', icon: <Calculator className="size-4" />, permission: 'recipes.view' },
      { to: '/tracabilite', label: 'Traçabilité', icon: <GitBranch className="size-4" />, permission: 'stock.view' },
    ],
  },
  {
    section: 'Caisse & ventes',
    items: [
      { to: '/caisse', label: 'Caisse', icon: <Store className="size-4" />, permission: 'cash.operate' },
      { to: '/sessions-caisse', label: 'Sessions de caisse', icon: <Wallet className="size-4" />, permission: 'sales.view' },
      { to: '/ventes', label: 'Ventes', icon: <ReceiptText className="size-4" />, permission: 'sales.view' },
      { to: '/caisses', label: 'Caisses', icon: <MonitorSmartphone className="size-4" />, permission: 'cash.movements' },
    ],
  },
  {
    section: 'Restaurant',
    items: [
      { to: '/salle', label: 'Salle', icon: <LayoutGrid className="size-4" />, permission: 'restaurant.orders' },
      { to: '/commandes', label: 'Commandes', icon: <ListOrdered className="size-4" />, permission: 'restaurant.orders' },
      { to: '/cuisine', label: 'Cuisine', icon: <ChefHat className="size-4" />, permission: 'restaurant.kitchen' },
      { to: '/reservations', label: 'Réservations', icon: <CalendarDays className="size-4" />, permission: 'restaurant.orders' },
      { to: '/restaurant-parametres', label: 'Paramétrage restaurant', icon: <Settings2 className="size-4" />, permission: 'restaurant.tables' },
    ],
  },
  {
    section: 'Clients',
    items: [
      { to: '/clients', label: 'Clients', icon: <Contact className="size-4" />, permission: 'customers.view' },
      { to: '/devis-clients', label: 'Devis clients', icon: <FileSignature className="size-4" />, permission: QUOTE_READ },
      { to: '/commandes-clients', label: 'Commandes clients', icon: <ClipboardList className="size-4" />, permission: CUSTOMER_ORDER_READ },
      { to: '/livraisons', label: 'Livraisons', icon: <PackageCheck className="size-4" />, permission: DELIVERY_DRIVER },
      { to: '/factures-clients', label: 'Facturation', icon: <FileText className="size-4" />, permission: INVOICE_READ },
      { to: '/paiements-clients', label: 'Paiements clients', icon: <Banknote className="size-4" />, permission: PAYMENT_READ },
      { to: '/acomptes-clients', label: 'Acomptes clients', icon: <PiggyBank className="size-4" />, permission: DEPOSIT_READ },
    ],
  },
  {
    section: 'Pilotage',
    items: [{ to: '/pilotage/dashboard', label: 'Tableau de bord', icon: <Gauge className="size-4" />, permission: 'dashboard.view' }],
  },
  {
    section: 'Administration',
    items: [
      { to: '/etablissements', label: 'Établissements', icon: <Building2 className="size-4" />, permission: 'establishments.view' },
      { to: '/utilisateurs', label: 'Utilisateurs', icon: <Users className="size-4" />, permission: 'users.view' },
      { to: '/roles', label: 'Rôles & permissions', icon: <ShieldCheck className="size-4" />, permission: 'users.view' },
      { to: '/audit', label: "Journal d'audit", icon: <ScrollText className="size-4" />, permission: 'audit.view' },
      { to: '/entreprise', label: 'Entreprise', icon: <Settings className="size-4" />, permission: 'company.manage' },
    ],
  },
];

function EstablishmentSwitcher() {
  const { me, establishmentId, setEstablishmentId, hasGroupAccess } = useAuth();
  if (!me) return null;
  return (
    <select
      aria-label="Établissement"
      value={establishmentId ?? ''}
      onChange={(e) => setEstablishmentId(e.target.value || null)}
      className="w-full rounded-lg border border-brand-600 bg-brand-800 px-2 py-1.5 text-sm text-white"
    >
      {hasGroupAccess && <option value="">Tout le groupe</option>}
      {me.establishments.map((e) => (
        <option key={e.id} value={e.id}>
          {e.code} — {e.name}
        </option>
      ))}
    </select>
  );
}

export function Layout() {
  const { me, logout, canAnywhere } = useAuth();
  const [open, setOpen] = useState(false);

  const sidebar = (
    <nav className="flex h-full flex-col gap-4 bg-brand-700 p-4 text-brand-50">
      <div>
        <div className="text-lg font-extrabold tracking-wide text-white">AFRIKA FOOD</div>
        <div className="truncate text-xs text-brand-200">{me?.company.name}</div>
      </div>
      <EstablishmentSwitcher />
      <div className="flex-1 space-y-4 overflow-y-auto">
        {NAV.map((group) => {
          const items = group.items.filter((i) => !i.permission || (Array.isArray(i.permission) ? i.permission : [i.permission]).some((p) => canAnywhere(p)));
          if (items.length === 0) return null;
          return (
            <div key={group.section}>
              {group.section && <div className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-brand-200">{group.section}</div>}
              {items.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  end={i.to === '/'}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${isActive ? 'bg-white/15 font-semibold text-white' : 'hover:bg-white/10'}`
                  }
                >
                  {i.icon}
                  {i.label}
                </NavLink>
              ))}
            </div>
          );
        })}
      </div>
      <div className="space-y-1 border-t border-white/15 pt-3 text-sm">
        <div className="truncate px-2 font-medium text-white">{me?.fullName}</div>
        <NavLink to="/mot-de-passe" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/10">
          <KeyRound className="size-4" /> Mot de passe
        </NavLink>
        <button onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/10">
          <LogOut className="size-4" /> Déconnexion
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-2 lg:hidden">
          <button onClick={() => setOpen(!open)} aria-label="Menu" className="rounded p-1 hover:bg-stone-100">
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <span className="font-extrabold text-brand-700">AFRIKA FOOD</span>
        </header>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
