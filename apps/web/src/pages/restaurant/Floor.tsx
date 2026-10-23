import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Field, Input, Modal, PageHeader, Spinner } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, formatXOF } from '../../lib/format';
import { Area, FloorTable, OrderDetail, TABLE_STATUS } from '../../lib/restaurant-types';
import { RequireEstablishment, RequirePermission, useRequestId } from '../stock/shared';

/** Plan de salle : statut de chaque table, rafraîchi automatiquement (décision R8). */
export function FloorPage() {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Salle"
        subtitle="Tables, statuts et commandes en cours"
        actions={
          <Button variant="secondary" onClick={() => navigate('/commandes')}>
            Commandes hors table
          </Button>
        }
      />
      <RequirePermission permission={['restaurant.orders', 'restaurant.tables']}>
        <RequireEstablishment>{(establishmentId) => <Floor establishmentId={establishmentId} />}</RequireEstablishment>
      </RequirePermission>
    </>
  );
}

function Floor({ establishmentId }: { establishmentId: string }) {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['restaurant', 'floor', establishmentId],
    queryFn: () => api.get<Area[]>('/restaurant/floor'),
    refetchInterval: 10_000,
  });
  const [area, setArea] = useState<string | null>(null);
  const [opening, setOpening] = useState<FloorTable | null>(null);
  const [managing, setManaging] = useState<FloorTable | null>(null);
  if (isLoading) return <Spinner />;
  if (error) return <Alert>{(error as ApiError).message}</Alert>;
  if (!data?.length) return <Alert tone="info">Aucune salle. Un responsable doit créer les zones et les tables (menu « Paramétrage restaurant »).</Alert>;
  const current = data.find((a) => a.id === area) ?? data[0];
  const click = (t: FloorTable) => {
    if (t.order) navigate(`/commandes/${t.order.id}`);
    else if (t.status === 'FREE' || t.status === 'RESERVED') setOpening(t);
    else setManaging(t);
  };
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        {data.map((a) => (
          <Button key={a.id} variant={a.id === current.id ? 'primary' : 'secondary'} onClick={() => setArea(a.id)}>
            {a.name} ({a.tables.filter((t) => t.isActive && t.status === 'FREE').length} libres)
          </Button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {Object.entries(TABLE_STATUS).map(([k, s]) => (
          <Badge key={k} tone={s.tone}>
            {s.label}
          </Badge>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {current.tables
          .filter((t) => t.isActive)
          .map((t) => {
            const s = TABLE_STATUS[t.status];
            return (
              <button key={t.id} aria-label={`Table ${t.code} — ${s.label}`} onClick={() => click(t)} className={`flex min-h-28 flex-col justify-between rounded-xl border-2 p-3 text-left shadow-sm transition hover:shadow ${s.card}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xl font-bold">{t.code}</span>
                  <span className="flex items-center gap-1 text-xs text-stone-600">
                    <Users className="size-3" /> {t.order?.covers ?? t.capacity}
                  </span>
                </div>
                <div className="text-xs font-semibold">{s.label}</div>
                {t.order && (
                  <div className="text-xs text-stone-700">
                    {formatXOF(t.order.total)} · {t.order.waiter}
                  </div>
                )}
                {!t.order && t.reservation && (
                  <div className="text-xs text-sky-800">
                    {t.reservation.name} · {formatDateTime(t.reservation.reservedAt).slice(-5)}
                  </div>
                )}
              </button>
            );
          })}
      </div>
      {opening && <OpenTable table={opening} establishmentId={establishmentId} onClose={() => setOpening(null)} />}
      {managing && <TableState table={managing} onClose={() => setManaging(null)} />}
    </>
  );
}

function OpenTable({ table, establishmentId, onClose }: { table: FloorTable; establishmentId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const requestId = useRequestId();
  const [covers, setCovers] = useState(String(table.reservation?.covers ?? Math.min(2, table.capacity)));
  const [useReservation, setUseReservation] = useState(!!table.reservation);
  const create = useMutation({
    mutationFn: () =>
      api.post<OrderDetail>('/restaurant/orders', {
        clientRequestId: requestId,
        establishmentId,
        mode: 'TABLE',
        tableId: table.id,
        covers: Number(covers),
        ...(useReservation && table.reservation ? { reservationId: table.reservation.id } : {}),
      }),
    onSuccess: (o) => navigate(`/commandes/${o.id}`),
  });
  return (
    <Modal open title={`Ouvrir la table ${table.code}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Couverts">
          <Input type="number" min={1} max={500} required value={covers} onChange={(e) => setCovers(e.target.value)} />
        </Field>
        {table.reservation && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useReservation} onChange={(e) => setUseReservation(e.target.checked)} />
            Arrivée de la réservation « {table.reservation.name} » ({table.reservation.covers} pers.)
          </label>
        )}
        {create.error && <Alert>{(create.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" loading={create.isPending}>
            Ouvrir la commande
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Nettoyage → libre (personnel de salle) ; hors service (responsable des tables). */
function TableState({ table, onClose }: { table: FloorTable; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const set = useMutation({
    mutationFn: (state: string) => api.post(`/restaurant/tables/${table.id}/state`, { state }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['restaurant', 'floor'] });
      onClose();
    },
  });
  return (
    <Modal open title={`Table ${table.code} — ${TABLE_STATUS[table.status].label}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {table.state !== 'AVAILABLE' && (table.state !== 'OUT_OF_SERVICE' || can('restaurant.tables')) && (
            <Button loading={set.isPending} onClick={() => set.mutate('AVAILABLE')}>
              Marquer libre
            </Button>
          )}
          {table.state === 'AVAILABLE' && (
            <Button variant="secondary" onClick={() => set.mutate('CLEANING')}>
              Nettoyage
            </Button>
          )}
          {table.state !== 'OUT_OF_SERVICE' && can('restaurant.tables') && (
            <Button variant="danger" onClick={() => set.mutate('OUT_OF_SERVICE')}>
              Hors service
            </Button>
          )}
        </div>
        {set.error && <Alert>{(set.error as ApiError).message}</Alert>}
      </div>
    </Modal>
  );
}

