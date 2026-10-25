import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { CreditSummary, Customer, CUSTOMER_TYPES } from '../lib/customer-types';
import { formatXOF } from '../lib/format';
import { Alert, Badge, Button, Input } from './ui';

/** Situation de crédit d'un client pour un établissement (encours au niveau du groupe). */
export function useCustomerCredit(customerId: string | null | undefined, establishmentId: string) {
  return useQuery({
    queryKey: ['customer-credit', customerId, establishmentId],
    queryFn: () => api.get<CreditSummary>(`/customers/${customerId}/credit?establishmentId=${establishmentId}`),
    enabled: !!customerId,
    // Encours susceptible de changer à chaque vente : toujours relu.
    staleTime: 0,
  });
}

/**
 * Recherche (nom, e-mail, téléphone) et sélection d'un client actif, avec sa
 * situation de crédit. `amount` (FCFA) indique si ce montant tient dans le
 * disponible ; le contrôle définitif reste celui du serveur.
 */
export function CustomerPicker({
  establishmentId,
  value,
  onChange,
  amount,
  showCredit = true,
}: {
  establishmentId: string;
  value: Customer | null;
  onChange: (customer: Customer | null) => void;
  amount?: number;
  /** false : simple choix du client (filtre), sans lecture du crédit — utilisable sans établissement. */
  showCredit?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const results = useQuery({
    queryKey: ['customers', 'search', q],
    queryFn: () => api.get<Customer[]>(`/customers?q=${encodeURIComponent(q)}`),
    enabled: !value && q.length >= 2,
  });
  const credit = useCustomerCredit(showCredit ? value?.id : null, establishmentId);

  if (value) {
    const c = credit.data;
    const over = c && amount !== undefined && amount > Number(c.available);
    return (
      <div className="space-y-2 rounded-lg border border-stone-200 p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium">{value.name}</div>
            <div className="text-xs text-stone-500">
              {CUSTOMER_TYPES[value.type]}
              {value.phone ? ` · ${value.phone}` : ''}
            </div>
          </div>
          <Button type="button" variant="ghost" className="px-2 py-1" aria-label="Changer de client" onClick={() => onChange(null)}>
            <X className="size-4" />
          </Button>
        </div>
        {!showCredit ? null : credit.isLoading ? (
          <p className="text-sm text-stone-500">Chargement du crédit…</p>
        ) : credit.error ? (
          <Alert>{(credit.error as ApiError).message}</Alert>
        ) : (
          c && (
            <>
              <div className="grid grid-cols-3 gap-2 rounded-lg bg-stone-50 p-2 text-center text-sm">
                <div>
                  Encours<div className="font-bold">{formatXOF(c.outstanding)}</div>
                </div>
                <div>
                  Plafond<div className="font-bold">{c.creditLimit === null ? 'Aucun' : formatXOF(c.creditLimit)}</div>
                </div>
                <div>
                  Disponible<div className={`font-bold ${Number(c.available) > 0 ? 'text-green-700' : 'text-red-700'}`}>{formatXOF(c.available)}</div>
                </div>
              </div>
              {!c.isActive && <Alert>Client désactivé : aucune vente à crédit possible.</Alert>}
              {over && <Alert>Montant supérieur au disponible : une autorisation de dépassement sera nécessaire.</Alert>}
              {c.activeOverrides > 0 && <Badge tone="blue">{c.activeOverrides} autorisation(s) de dépassement active(s)</Badge>}
            </>
          )
        )}
      </div>
    );
  }

  const list = results.data ?? [];
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-2.5 size-4 text-stone-400" />
        <Input className="pl-9" placeholder="Nom, téléphone ou e-mail du client" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Rechercher un client" />
      </div>
      {q.length < 2 ? null : results.isLoading ? (
        <p className="text-sm text-stone-500">Recherche…</p>
      ) : results.error ? (
        <Alert>{(results.error as ApiError).message}</Alert>
      ) : list.length === 0 ? (
        <p className="text-sm text-stone-500">Aucun client trouvé.</p>
      ) : (
        <ul className="max-h-60 divide-y divide-stone-100 overflow-y-auto rounded-lg border border-stone-200">
          {list.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-brand-50"
                onClick={() => {
                  setSearch('');
                  onChange(c);
                }}
              >
                <span>
                  <span className="font-medium">{c.name}</span>
                  {c.phone && <span className="text-stone-500"> · {c.phone}</span>}
                </span>
                <span className="text-xs text-stone-500">{CUSTOMER_TYPES[c.type]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
