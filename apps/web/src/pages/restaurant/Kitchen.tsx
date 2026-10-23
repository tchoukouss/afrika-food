import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, PageHeader, Select, Spinner } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { qty } from '../../lib/catalog-types';
import { ITEM_STATUS, KitchenTicket, ORDER_MODES, Station } from '../../lib/restaurant-types';
import { RequireEstablishment, RequirePermission, StatusBadge } from '../stock/shared';
import { printLines } from '../sales/Ticket';

const NEXT: Record<string, { status: string; label: string } | undefined> = {
  NEW: { status: 'IN_PREPARATION', label: 'Commencer' },
  IN_PREPARATION: { status: 'READY', label: 'Prêt' },
  READY: { status: 'SERVED', label: 'Servi' },
};

/** Écran cuisine / bar : bons à préparer, priorité, délai, statuts par ligne et par bon (décisions R13 et R22). */
export function KitchenPage() {
  return (
    <>
      <PageHeader title="Cuisine" subtitle="Bons à préparer — mise à jour automatique" />
      <RequirePermission permission={['restaurant.kitchen', 'restaurant.orders']}>
        <RequireEstablishment>{(establishmentId) => <Kitchen establishmentId={establishmentId} />}</RequireEstablishment>
      </RequirePermission>
    </>
  );
}

function minutesSince(iso: string, now: number) {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

function Kitchen({ establishmentId }: { establishmentId: string }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [stationId, setStationId] = useState(() => localStorage.getItem('af.kitchen.station') ?? '');
  const stations = useQuery({ queryKey: ['restaurant', 'stations', establishmentId], queryFn: () => api.get<Station[]>('/restaurant/stations') });
  const { data, isLoading, error } = useQuery({
    queryKey: ['restaurant', 'kitchen', establishmentId, stationId],
    queryFn: () => api.get<KitchenTicket[]>(`/restaurant/kitchen${stationId ? `?stationId=${stationId}` : ''}`),
    refetchInterval: 5_000,
  });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const refresh = () => qc.invalidateQueries({ queryKey: ['restaurant'] });
  const item = useMutation({ mutationFn: (v: { id: string; status: string }) => api.post(`/restaurant/kitchen/items/${v.id}/status`, { status: v.status }), onSuccess: refresh });
  const ticket = useMutation({ mutationFn: (v: { id: string; status: string }) => api.post(`/restaurant/kitchen/tickets/${v.id}/status`, { status: v.status }), onSuccess: refresh });
  const reprint = useMutation({
    mutationFn: (id: string) => api.post<{ print: { status: string }; lines: string[]; width: number }>(`/restaurant/kitchen/tickets/${id}/reprint`),
    onSuccess: (r) => r.print.status === 'BROWSER' && printLines(r.lines, r.width, 'Bon'),
  });
  const kitchen = can('restaurant.kitchen');
  const err = [item, ticket, reprint].find((m) => m.error)?.error as ApiError | undefined;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          className="w-56"
          aria-label="Poste"
          value={stationId}
          onChange={(e) => {
            setStationId(e.target.value);
            try {
              localStorage.setItem('af.kitchen.station', e.target.value);
            } catch {
              /* stockage indisponible : préférence non mémorisée */
            }
          }}
        >
          <option value="">Tous les postes</option>
          {(stations.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <span className="text-sm text-stone-500">{data?.length ?? 0} bon(s) en cours</span>
      </div>
      {err && <div className="mb-3"><Alert>{err.message}</Alert></div>}
      {isLoading && <Spinner />}
      {error && <Alert>{(error as ApiError).message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(data ?? []).map((t) => {
          const age = minutesSince(t.createdAt, now);
          return (
            <section key={t.id} className={`rounded-xl border-2 bg-white shadow-sm ${t.urgent ? 'border-red-400' : age >= 20 ? 'border-amber-400' : 'border-stone-200'}`}>
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-3 py-2">
                <div>
                  <div className="text-lg font-bold">{t.order.table ? `Table ${t.order.table}` : ORDER_MODES[t.order.mode]}</div>
                  <div className="text-xs text-stone-500">
                    {t.number} · {t.station?.name ?? 'Service'} {t.order.customerName && `· ${t.order.customerName}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {t.urgent && <Badge tone="red">Urgent</Badge>}
                  <Badge tone={age >= 20 ? 'orange' : 'neutral'}>{age} min</Badge>
                  <Button variant="ghost" className="px-2 py-1" aria-label="Réimprimer le bon" onClick={() => reprint.mutate(t.id)}>
                    <Printer className="size-4" />
                  </Button>
                </div>
              </header>
              <ul className="divide-y divide-stone-100 px-3">
                {t.items.map((i) => {
                  const next = NEXT[i.status];
                  const allowed = next && (kitchen || next.status === 'SERVED');
                  return (
                    <li key={i.id} className={`flex items-start gap-2 py-2 ${i.parentItemId ? 'pl-5' : ''}`}>
                      <div className="flex-1">
                        <div className="text-base">
                          {i.parentItemId && '+ '}
                          <strong>{qty(i.quantity)}</strong> {i.productName}
                        </div>
                        {i.options.length > 0 && <div className="text-sm font-medium text-brand-700">{i.options.join(' · ')}</div>}
                        {i.note && <div className="text-sm text-red-700">{i.note}</div>}
                        <StatusBadge map={ITEM_STATUS} status={i.status} />
                      </div>
                      {allowed && (
                        <Button className="px-3 py-1" variant={next.status === 'READY' ? 'primary' : 'secondary'} onClick={() => item.mutate({ id: i.id, status: next.status })}>
                          {next.label}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {t.order.note && <p className="border-t border-stone-100 px-3 py-2 text-sm text-red-700">Note : {t.order.note}</p>}
              {kitchen && (
                <footer className="flex gap-2 border-t border-stone-200 px-3 py-2">
                  <Button variant="secondary" className="flex-1" onClick={() => ticket.mutate({ id: t.id, status: 'IN_PREPARATION' })}>
                    Tout commencer
                  </Button>
                  <Button className="flex-1" onClick={() => ticket.mutate({ id: t.id, status: 'READY' })}>
                    Tout prêt
                  </Button>
                </footer>
              )}
            </section>
          );
        })}
      </div>
      {!isLoading && data?.length === 0 && <p className="py-10 text-center text-stone-500">Aucun bon en cours.</p>}
    </>
  );
}
