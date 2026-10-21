import { useAuth } from './auth';

/**
 * Droits du catalogue côté interface (le serveur reste seul juge) :
 * - catalogue (produits, matières, catégories) : niveau groupe ;
 * - prix de base : niveau groupe ; prix d'exception : par établissement ;
 * - disponibilité : par établissement ;
 * - fournisseurs : permission dans au moins un établissement.
 */
export function useCatalogAccess() {
  const { me, canAnywhere } = useAuth();
  const global = new Set(me?.globalPermissions ?? []);
  const inEst = (estId: string, p: string) => !!me?.establishments.find((e) => e.id === estId)?.permissions.includes(p);
  return {
    manageCatalog: global.has('products.manage'),
    manageBasePrice: global.has('prices.manage'),
    canLocalPrice: (estId: string) => inEst(estId, 'prices.manage'),
    canAvailability: (estId: string) => inEst(estId, 'products.manage'),
    manageSuppliers: canAnywhere('suppliers.manage'),
    viewSuppliers: canAnywhere('suppliers.view'),
  };
}
