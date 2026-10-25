import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import './index.css';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { AuditPage } from './pages/Audit';
import { CategoriesPage } from './pages/catalog/Categories';
import { ProductsPage } from './pages/catalog/Products';
import { RawMaterialsPage } from './pages/catalog/RawMaterials';
import { SuppliersPage } from './pages/catalog/Suppliers';
import { CostingPage } from './pages/production/Costing';
import { ProductionPage } from './pages/production/Production';
import { RecipesPage } from './pages/production/Recipes';
import { TraceabilityPage } from './pages/production/Traceability';
import { FloorPage } from './pages/restaurant/Floor';
import { KitchenPage } from './pages/restaurant/Kitchen';
import { OrderPage } from './pages/restaurant/Order';
import { OrdersPage } from './pages/restaurant/Orders';
import { ReservationsPage } from './pages/restaurant/Reservations';
import { RestaurantSetupPage } from './pages/restaurant/Setup';
import { PosPage } from './pages/sales/Pos';
import { RegistersPage } from './pages/sales/Registers';
import { SalesPage } from './pages/sales/Sales';
import { SessionsPage } from './pages/sales/Sessions';
import { InventoryPage } from './pages/stock/Inventory';
import { PurchaseRequestsPage, PurchasesPage } from './pages/stock/Purchases';
import { StockPage } from './pages/stock/Stock';
import { SupplierFinancePage } from './pages/stock/SupplierFinance';
import { TransfersPage } from './pages/stock/Transfers';
import { ChangePasswordPage } from './pages/ChangePassword';
import { CompanyPage } from './pages/Company';
import { CustomerDepositsPage } from './pages/customers/CustomerDeposits';
import { DeliveriesPage } from './pages/customers/Deliveries';
import { CustomerInvoicesPage } from './pages/customers/CustomerInvoices';
import { CustomerOrdersPage } from './pages/customers/CustomerOrders';
import { CustomerPaymentsPage } from './pages/customers/CustomerPayments';
import { CustomerQuotesPage } from './pages/customers/CustomerQuotes';
import { CustomersPage } from './pages/customers/Customers';
import { DashboardPage } from './pages/pilotage/Dashboard';
import { EstablishmentsPage } from './pages/Establishments';
import { HomePage } from './pages/Home';
import { LoginPage } from './pages/Login';
import { RolesPage } from './pages/Roles';
import { UsersPage } from './pages/Users';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // Pas de nouvelle tentative sur une erreur de droits ou de validation.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

function App() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <LoginPage />;
  if (me.mustChangePassword) return <ChangePasswordPage forced />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="etablissements" element={<EstablishmentsPage />} />
        <Route path="utilisateurs" element={<UsersPage />} />
        <Route path="roles" element={<RolesPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="entreprise" element={<CompanyPage />} />
        <Route path="mot-de-passe" element={<ChangePasswordPage />} />
        <Route path="produits" element={<ProductsPage />} />
        <Route path="matieres" element={<RawMaterialsPage />} />
        <Route path="fournisseurs" element={<SuppliersPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="stock" element={<StockPage />} />
        <Route path="achats" element={<PurchasesPage />} />
        <Route path="demandes-achat" element={<PurchaseRequestsPage />} />
        <Route path="factures-fournisseurs" element={<SupplierFinancePage />} />
        <Route path="inventaires" element={<InventoryPage />} />
        <Route path="transferts" element={<TransfersPage />} />
        <Route path="production" element={<ProductionPage />} />
        <Route path="recettes" element={<RecipesPage />} />
        <Route path="couts-marges" element={<CostingPage />} />
        <Route path="tracabilite" element={<TraceabilityPage />} />
        <Route path="caisse" element={<PosPage />} />
        <Route path="sessions-caisse" element={<SessionsPage />} />
        <Route path="ventes" element={<SalesPage />} />
        <Route path="caisses" element={<RegistersPage />} />
        <Route path="salle" element={<FloorPage />} />
        <Route path="commandes" element={<OrdersPage />} />
        <Route path="commandes/:id" element={<OrderPage />} />
        <Route path="cuisine" element={<KitchenPage />} />
        <Route path="reservations" element={<ReservationsPage />} />
        <Route path="restaurant-parametres" element={<RestaurantSetupPage />} />
        <Route path="clients" element={<CustomersPage />} />
        <Route path="devis-clients" element={<CustomerQuotesPage />} />
        <Route path="commandes-clients" element={<CustomerOrdersPage />} />
        <Route path="livraisons" element={<DeliveriesPage />} />
        <Route path="factures-clients" element={<CustomerInvoicesPage />} />
        <Route path="paiements-clients" element={<CustomerPaymentsPage />} />
        <Route path="acomptes-clients" element={<CustomerDepositsPage />} />
        <Route path="pilotage/dashboard" element={<DashboardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
