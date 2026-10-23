import { useMutation, useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { qty } from '../../lib/catalog-types';
import { formatDateTime, formatXOF } from '../../lib/format';
import { ITEM_STATUS, ORDER_MODES, ORDER_STATUS, OrderDetail, OrderRow } from '../../lib/restaurant-types';
import { RequireEstablishment, RequirePermission, StatusBadge, Tabs, useRequestId } from '../stock/shared';

/** Commandes : sur place et hors table (comptoir, emporter, téléphone, en ligne, livraison), et traçabilité lot → commandes. */
export function OrdersPage() {
  const [tab, setTab] = useState<'orders' | 'lots'>('orders');
  return (
    <>
      <PageHeader title="Commandes restaurant" subtitle="Toutes les commandes, nouvelle commande hors table, traçabilité" />
      <RequirePermission permission={['restaurant.orders', 'restaurant.kitchen']}>
        <Tabs
          tabs={[
            { id: 'orders', label: 'Commandes' },
            { id: 'lots', label: 'Lot → commandes' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'orders' ? <RequireEstablishment>{(establishmentId) => <OrdersList establishmentId={establishmentId} />}</RequireEstablishment> : <LotOrders />}
      </RequirePermission>
    </>
  );
}

function OrdersList({ establishmentId }: { establishmentId: string }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('OPEN');
  const [mode, setMode] = useState('');
  const [creating, setCreating] = useState(false);
  const qs = new URLSearchParams(Object.entries({ status, mode }).filter(([, v]) => v)).toString();
  const { data, isLoading, error } = useQuery({
    queryKey: ['restaurant', 'orders', establishmentId, qs],
    queryFn: () => api.get<OrderRow[]>(`/restaurant/orders${qs ? `?${qs}` : ''}`),
    refetchInterval: 15_000,
  });
  return (
    <Card
      actions={
        <>
          <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut">
            <option value="">Tous les statuts</option>
            {Object.entries(ORDER_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
          <Select className="w-40" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Mode">
            <option value="">Tous les modes</option>
            {Object.entries(ORDER_MODES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          {can('restaurant.orders') && <Button onClick={() => setCreating(true)}>Nouvelle commande hors table</Button>}
        </>
      }
    >
      {isLoading && <Spinner />}
      {error && <Alert>{(error as ApiError).message}</Alert>}
      {data && (
        <Table head={['Commande', 'Mode', 'Client', 'Serveur', 'Cuisine', 'Total', 'Statut']} empty={data.length === 0}>
          {data.map((o) => (
            <tr key={o.id} className="cursor-pointer hover:bg-stone-50" onClick={() => navigate(`/commandes/${o.id}`)}>
              <Td className="font-mono text-xs font-semibold">
                {o.number}
                <div className="font-sans font-normal text-stone-500">{formatDateTime(o.createdAt)}</div>
              </Td>
              <Td>{o.table ? `Table ${o.table.code}` : ORDER_MODES[o.mode]}</Td>
              <Td>{o.customerName}</Td>
              <Td>{o.waiter}</Td>
              <Td className="text-xs">
                {o.counts.draft > 0 && <Badge tone="blue">{o.counts.draft} à envoyer</Badge>} {o.counts.inKitchen > 0 && <Badge tone="orange">{o.counts.inKitchen} en cuisine</Badge>}{' '}
                {o.counts.ready > 0 && <Badge tone="green">{o.counts.ready} prêt(s)</Badge>} {o.openBills > 0 && <Badge tone="red">Addition</Badge>}
              </Td>
              <Td className="font-semibold">{formatXOF(o.total)}</Td>
              <Td>
                <StatusBadge map={ORDER_STATUS} status={o.status} />
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {creating && <NewOrder establishmentId={establishmentId} onClose={() => setCreating(false)} />}
    </Card>
  );
}

function NewOrder({ establishmentId, onClose }: { establishmentId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const requestId = useRequestId();
  const [form, setForm] = useState({ mode: 'TAKEAWAY', customerName: '', customerPhone: '', deliveryAddress: '', expectedAt: '', note: '', urgent: false });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const create = useMutation({
    mutationFn: () =>
      api.post<OrderDetail>('/restaurant/orders', {
        clientRequestId: requestId,
        establishmentId,
        mode: form.mode,
        customerName: form.customerName,
        customerPhone: form.customerPhone,
        deliveryAddress: form.mode === 'DELIVERY' ? form.deliveryAddress : null,
        ...(form.expectedAt ? { expectedAt: new Date(form.expectedAt).toISOString() } : {}),
        note: form.note,
        urgent: form.urgent,
      }),
    onSuccess: (o) => navigate(`/commandes/${o.id}`),
  });
  const phone = form.mode === 'PHONE' || form.mode === 'DELIVERY';
  return (
    <Modal open title="Nouvelle commande hors table" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Mode">
          <Select value={form.mode} onChange={set('mode')}>
            {Object.entries(ORDER_MODES)
              .filter(([k]) => k !== 'TABLE')
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nom du client">
            <Input maxLength={120} value={form.customerName} onChange={set('customerName')} />
          </Field>
          <Field label={phone ? 'Téléphone (obligatoire)' : 'Téléphone'}>
            <Input required={phone} maxLength={30} value={form.customerPhone} onChange={set('customerPhone')} />
          </Field>
        </div>
        {form.mode === 'DELIVERY' && (
          <Field label="Adresse de livraison" hint="Le suivi des livraisons (livreur, statut, frais) arrive avec le module 7.">
            <Input required maxLength={300} value={form.deliveryAddress} onChange={set('deliveryAddress')} />
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Heure prévue">
            <Input type="datetime-local" value={form.expectedAt} onChange={set('expectedAt')} />
          </Field>
          <label className="flex items-center gap-2 pt-6 text-sm">
            <input type="checkbox" checked={form.urgent} onChange={(e) => setForm({ ...form, urgent: e.target.checked })} /> Urgent
          </label>
        </div>
        <Field label="Note">
          <Input maxLength={500} value={form.note} onChange={set('note')} />
        </Field>
        {create.error && <Alert>{(create.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" loading={create.isPending}>
            Créer et saisir
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface LotOrdersResult {
  lots: { id: string; lotNumber: string; item: { name: string } | null; via: string | null; depth: number }[];
  orders: { orderId: string; orderNumber: string; orderStatus: string; createdAt: string; lotNumber: string | null; product: string; itemStatus: string; quantity: string; bill: { number: string } | null; sale: { number: string } | null }[];
}

/** Lot → produits fabriqués avec lui → commandes restaurant → tickets. */
function LotOrders() {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [lot, setLot] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['restaurant', 'lot', lot],
    queryFn: () => api.get<LotOrdersResult>(`/restaurant/traceability?lotNumber=${encodeURIComponent(lot)}`),
    enabled: lot.length >= 3,
    retry: false,
  });
  return (
    <Card>
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setLot(input.trim().toUpperCase());
        }}
      >
        <Input className="max-w-xs" placeholder="N° de lot, ex. LOT-2026-000012" value={input} onChange={(e) => setInput(e.target.value)} />
        <Button type="submit">Rechercher</Button>
      </form>
      {isLoading && <Spinner />}
      {error && <Alert>{(error as ApiError).message}</Alert>}
      {data && (
        <div className="space-y-4">
          <div className="text-sm">
            {data.lots.map((l) => (
              <div key={l.id} style={{ marginLeft: l.depth * 16 }}>
                <span className="font-mono font-semibold">{l.lotNumber}</span> · {l.item?.name} {l.via && <span className="text-stone-500">(fabriqué par {l.via})</span>}
              </div>
            ))}
          </div>
          <Table head={['Commande', 'Date', 'Article', 'Lot', 'Quantité', 'Statut', 'Ticket']} empty={data.orders.length === 0}>
            {data.orders.map((o, i) => (
              <tr key={i} className="cursor-pointer hover:bg-stone-50" onClick={() => navigate(`/commandes/${o.orderId}`)}>
                <Td className="font-mono text-xs font-semibold">{o.orderNumber}</Td>
                <Td>{formatDateTime(o.createdAt)}</Td>
                <Td>{o.product}</Td>
                <Td className="font-mono text-xs">{o.lotNumber}</Td>
                <Td>{qty(o.quantity)}</Td>
                <Td>
                  <StatusBadge map={ITEM_STATUS} status={o.itemStatus} />
                </Td>
                <Td className="font-mono text-xs">{o.sale?.number ?? (o.bill ? `${o.bill.number} (non payée)` : '—')}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}
