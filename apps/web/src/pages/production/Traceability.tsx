import { useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, Input, PageHeader, Spinner } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { qty } from '../../lib/catalog-types';
import { formatDate } from '../../lib/format';
import { TraceDown, TraceLot, TraceResult, TraceUp } from '../../lib/production-types';
import { unitLabel } from '../../lib/stock-types';
import { RequirePermission } from '../stock/shared';

const ORIGIN = { RECEIPT: 'Réception', INVENTORY: 'Inventaire', ADJUSTMENT: 'Correction', PRODUCTION: 'Production' } as Record<string, string>;

function LotLine({ lot, quantity }: { lot: TraceLot; quantity?: string }) {
  return (
    <div className="text-sm">
      <span className="font-mono text-xs font-semibold">{lot.lotNumber}</span> · <strong>{lot.item?.name}</strong> <Badge>{ORIGIN[lot.origin] ?? lot.origin}</Badge>
      {quantity && (
        <span className="text-stone-600">
          {' '}
          · {qty(quantity)} {unitLabel(lot.item?.unit)} utilisés
        </span>
      )}
      <div className="text-xs text-stone-500">
        {lot.supplier && `Fournisseur ${lot.supplier.name}${lot.brand ? ` (${lot.brand})` : ''}`}
        {lot.supplierLotRef && ` · lot fournisseur ${lot.supplierLotRef}`}
        {lot.receipt && ` · réception ${lot.receipt.number} du ${formatDate(lot.receipt.receivedAt)}`}
        {lot.expiryDate && ` · péremption ${formatDate(lot.expiryDate)}`}
      </div>
    </div>
  );
}

function Upstream({ node }: { node: TraceUp }) {
  return (
    <ul className="space-y-2 border-l-2 border-brand-200 pl-4">
      {node.production && <li className="text-xs text-stone-500">Produit par l’ordre {node.production.number}</li>}
      {node.inputs.map((i) => (
        <li key={i.lot.lotId} className="space-y-2">
          <LotLine lot={i.lot} quantity={i.quantity} />
          {(i.lot.production || i.lot.inputs.length > 0) && <Upstream node={i.lot} />}
        </li>
      ))}
    </ul>
  );
}

function Downstream({ uses }: { uses: TraceDown[] }) {
  return (
    <ul className="space-y-2 border-l-2 border-accent-600/30 pl-4">
      {uses.map((u) => (
        <li key={u.production.id} className="space-y-1">
          <div className="text-xs text-stone-500">
            Utilisé par l’ordre {u.production.number} ({qty(u.quantityUsed)})
          </div>
          {u.outputs.map((o) => (
            <div key={o.lotId} className="space-y-2">
              <LotLine lot={o} />
              {o.usedBy.length > 0 && <Downstream uses={o.usedBy} />}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** Traçabilité d'un lot : matières et fournisseurs en amont, produits fabriqués en aval. */
export function TraceabilityPage() {
  const [params, setParams] = useSearchParams();
  const lot = params.get('lot') ?? '';
  const [input, setInput] = useState(lot);
  const { data, isLoading, error } = useQuery({
    queryKey: ['traceability', lot],
    queryFn: () => api.get<TraceResult>(`/traceability?lotNumber=${encodeURIComponent(lot)}`),
    enabled: lot.length >= 3,
    retry: false,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setParams(input.trim() ? { lot: input.trim().toUpperCase() } : {});
  };
  return (
    <>
      <PageHeader title="Traçabilité" subtitle="Fournisseur → réception → lot → production → produit fini" />
      <RequirePermission permission="stock.view">
        <Card>
          <form className="mb-4 flex flex-wrap gap-2" onSubmit={submit}>
            <Input className="max-w-xs" placeholder="N° de lot, ex. LOT-2026-000012" value={input} onChange={(e) => setInput(e.target.value)} />
            <Button type="submit">Tracer</Button>
          </form>
          {isLoading && <Spinner />}
          {error && <Alert>{(error as ApiError).message}</Alert>}
          {data && (
            <div className="space-y-5">
              <LotLine lot={data.lot} />
              <div>
                <h3 className="mb-2 font-semibold">En amont : de quoi est fait ce lot ?</h3>
                {data.upstream.production || data.upstream.inputs.length ? <Upstream node={data.upstream} /> : <p className="text-sm text-stone-500">Lot d’origine (réception, inventaire ou correction).</p>}
              </div>
              <div>
                <h3 className="mb-2 font-semibold">En aval : dans quoi ce lot a-t-il été utilisé ?</h3>
                {data.downstream.length ? <Downstream uses={data.downstream} /> : <p className="text-sm text-stone-500">Aucune production n’a encore utilisé ce lot.</p>}
              </div>
            </div>
          )}
        </Card>
      </RequirePermission>
    </>
  );
}
