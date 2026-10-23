import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { Area, RESERVATION_STATUS, Reservation } from '../../lib/restaurant-types';
import { RequireEstablishment, RequirePermission, StatusBadge, useRequestId } from '../stock/shared';

const today = () => new Date().toISOString().slice(0, 10);

/** Réservations simples (décision R9) : la table passe « réservée » 60 min avant l'heure. */
export function ReservationsPage() {
  return (
    <>
      <PageHeader title="Réservations" subtitle="Tables réservées, arrivées, non-venues" />
      <RequirePermission permission="restaurant.orders">
        <RequireEstablishment>{(establishmentId) => <Reservations establishmentId={establishmentId} />}</RequireEstablishment>
      </RequirePermission>
    </>
  );
}

function Reservations({ establishmentId }: { establishmentId: string }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(today);
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ['restaurant', 'reservations', establishmentId, date], queryFn: () => api.get<Reservation[]>(`/restaurant/reservations?date=${date}`) });
  const status = useMutation({
    mutationFn: (v: { id: string; status: string }) => api.post(`/restaurant/reservations/${v.id}/status`, { status: v.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['restaurant'] }),
  });
  return (
    <Card
      actions={
        <>
          <Input type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Jour" />
          <Button onClick={() => setCreating(true)}>Nouvelle réservation</Button>
        </>
      }
    >
      {isLoading && <Spinner />}
      {(error || status.error) && <Alert>{((error || status.error) as ApiError).message}</Alert>}
      {data && (
        <Table head={['Heure', 'Nom', 'Couverts', 'Téléphone', 'Table', 'Statut', '']} empty={data.length === 0}>
          {data.map((r) => (
            <tr key={r.id}>
              <Td>{formatDateTime(r.reservedAt)}</Td>
              <Td className="font-medium">
                {r.name}
                {r.note && <div className="text-xs text-stone-500">{r.note}</div>}
              </Td>
              <Td>{r.covers}</Td>
              <Td>{r.phone}</Td>
              <Td>{r.table?.code ?? '—'}</Td>
              <Td>
                <StatusBadge map={RESERVATION_STATUS} status={r.status} />
              </Td>
              <Td className="whitespace-nowrap">
                {r.status === 'CONFIRMED' && (
                  <>
                    <Button variant="ghost" className="px-2 py-1" onClick={() => status.mutate({ id: r.id, status: 'NO_SHOW' })}>
                      Non venue
                    </Button>
                    <Button variant="ghost" className="px-2 py-1" onClick={() => status.mutate({ id: r.id, status: 'CANCELLED' })}>
                      Annuler
                    </Button>
                  </>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-xs text-stone-500">L’arrivée se valide en ouvrant la table réservée depuis le plan de salle.</p>
      {creating && <NewReservation establishmentId={establishmentId} date={date} onClose={() => setCreating(false)} />}
    </Card>
  );
}

function NewReservation({ establishmentId, date, onClose }: { establishmentId: string; date: string; onClose: () => void }) {
  const qc = useQueryClient();
  const requestId = useRequestId();
  const floor = useQuery({ queryKey: ['restaurant', 'floor', establishmentId], queryFn: () => api.get<Area[]>('/restaurant/floor') });
  const [form, setForm] = useState({ time: '20:00', covers: '2', name: '', phone: '', tableId: '', note: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const create = useMutation({
    mutationFn: () =>
      api.post('/restaurant/reservations', {
        clientRequestId: requestId,
        establishmentId,
        reservedAt: new Date(`${date}T${form.time}:00Z`).toISOString(), // Abidjan : UTC+0
        covers: Number(form.covers),
        name: form.name,
        phone: form.phone,
        tableId: form.tableId || null,
        note: form.note,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['restaurant'] });
      onClose();
    },
  });
  return (
    <Modal open title={`Réservation du ${date}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Heure">
            <Input type="time" required value={form.time} onChange={set('time')} />
          </Field>
          <Field label="Couverts">
            <Input type="number" min={1} max={500} required value={form.covers} onChange={set('covers')} />
          </Field>
          <Field label="Nom">
            <Input required minLength={2} maxLength={120} value={form.name} onChange={set('name')} />
          </Field>
          <Field label="Téléphone">
            <Input maxLength={30} value={form.phone} onChange={set('phone')} />
          </Field>
        </div>
        <Field label="Table (facultatif)">
          <Select value={form.tableId} onChange={set('tableId')}>
            <option value="">— À attribuer —</option>
            {(floor.data ?? []).flatMap((a) =>
              a.tables
                .filter((t) => t.isActive)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {a.name} · {t.code} ({t.capacity} pl.)
                  </option>
                )),
            )}
          </Select>
        </Field>
        <Field label="Note">
          <Input maxLength={500} value={form.note} onChange={set('note')} />
        </Field>
        {create.error && <Alert>{(create.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" loading={create.isPending}>
            Enregistrer
          </Button>
        </div>
      </form>
    </Modal>
  );
}
