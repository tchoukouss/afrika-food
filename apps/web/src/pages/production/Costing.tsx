import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Card, PageHeader, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { qty } from '../../lib/catalog-types';
import { formatXOF } from '../../lib/format';
import { CostingRow } from '../../lib/production-types';
import { unitLabel } from '../../lib/stock-types';
import { RequirePermission } from '../stock/shared';

const round = (v: string | null) => (v === null ? null : Math.round(Number(v)));

/** Coûts de revient et marges des produits fabriqués (sur le prix HT, décision I). */
export function CostingPage() {
  const { establishmentId, me } = useAuth();
  const current = me?.establishments.find((e) => e.id === establishmentId);
  const { data, isLoading, error } = useQuery({
    queryKey: ['costing', establishmentId],
    queryFn: () => api.get<CostingRow[]>(`/costing${establishmentId ? `?establishmentId=${establishmentId}` : ''}`),
  });
  return (
    <>
      <PageHeader
        title="Coûts & marges"
        subtitle={current ? `${current.name} — coût selon les lots en stock, prix de vente du site` : 'Vue groupe — derniers prix d’achat, prix de base'}
      />
      <RequirePermission permission="recipes.view">
        <Card>
          {isLoading ? (
            <Spinner />
          ) : error ? (
            <Alert>{(error as ApiError).message}</Alert>
          ) : (
            <Table head={['Produit', 'Prix TTC', 'TVA', 'Prix HT', 'Coût de revient', 'Marge', 'Marge %']} empty={data?.length === 0}>
              {data?.map((r) => (
                <tr key={r.productId}>
                  <Td>
                    <div className="font-medium">{r.name}</div>
                    <div className="font-mono text-xs text-stone-500">{r.code}</div>
                  </Td>
                  <Td className="whitespace-nowrap">{r.priceTtc ? formatXOF(r.priceTtc) : <Badge tone="red">Sans prix</Badge>}</Td>
                  <Td>{qty(r.taxRate)} %</Td>
                  <Td className="whitespace-nowrap">{r.priceHt ? formatXOF(round(r.priceHt)) : '—'}</Td>
                  <Td className="whitespace-nowrap">
                    {!r.hasActiveRecipe ? (
                      <Badge tone="orange">Pas de recette active</Badge>
                    ) : !r.costComplete ? (
                      <Badge tone="red">Coût incomplet</Badge>
                    ) : (
                      <>
                        {formatXOF(Math.round(Number(r.unitCost) * 100) / 100)}
                        <span className="text-xs text-stone-500"> / {unitLabel(r.saleUnitCode)}</span>
                      </>
                    )}
                  </Td>
                  <Td className={`whitespace-nowrap font-semibold ${r.margin && Number(r.margin) < 0 ? 'text-red-700' : ''}`}>{r.margin ? formatXOF(round(r.margin)) : '—'}</Td>
                  <Td>
                    {r.marginRate ? <Badge tone={Number(r.marginRate) < 0 ? 'red' : 'green'}>{qty(r.marginRate)} %</Badge> : '—'}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </RequirePermission>
    </>
  );
}
