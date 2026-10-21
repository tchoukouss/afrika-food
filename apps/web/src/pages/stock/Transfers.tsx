import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { qty } from '../../lib/catalog-types';
import { formatDateTime, formatXOF } from '../../lib/format';
import { TRANSFER_STATUS, unitLabel } from '../../lib/stock-types';
import { itemPayload, ItemSelect, LocationSelect, PickableItem, RequireEstablishment, StatusBadge, useEstablishment, useReasonDialog, useRequestId, useStockItems } from './shared';

interface TransferItem {
  id: string;
  requestedQuantity: string;
  preparedQuantity: string | null;
  shippedQuantity: string | null;
  receivedQuantity: string | null;
  gapReason: string | null;
  item: { name: string; unit: string } | null;
  lots: { id: string; lotNumber?: string; shippedQuantity: string; receivedQuantity: string | null; unitCost: string }[];
}

interface TransferRec {
  id: string;
  number: string;
  status: string;
  sourceEstablishmentId: string;
  destEstablishmentId: string;
  notes: string | null;
  requestedAt: string;
  cancelReason: string | null;
  items?: TransferItem[];
  transitLosses?: { id: string; quantity: string; estimatedValue: string; comment: string | null }[];
  people?: Record<string, string | null>;
  _count?: { items: number };
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) => Promise.all(['stock-transfers', 'stock', 'stock-losses', 'movements'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

/** Tous les établissements actifs (nom et code), y compris ceux où l'utilisateur n'a pas de droits. */
function useAllEstablishments() {
  return useQuery({
    queryKey: ['stock-transfers', 'establishments'],
    queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/stock-transfers/establishments'),
    staleTime: 5 * 60_000,
  });
}

function useEstName() {
  const { me } = useAuth();
  const all = useAllEstablishments();
  return (id: string) => {
    const e = all.data?.find((x) => x.id === id) ?? me?.establishments.find((x) => x.id === id);
    return e ? `${e.code} — ${e.name}` : '…';
  };
}

function TransferForm({ establishmentId, onDone }: { establishmentId: string; onDone: (t: TransferRec) => void }) {
  const requestId = useRequestId();
  const qc = useQueryClient();
  const all = useAllEstablishments();
  const { items } = useStockItems();
  const [sourceId, setSourceId] = useState('');
  const [lines, setLines] = useState<{ item: PickableItem | null; quantity: string }[]>([{ item: null, quantity: '' }]);
  const [notes, setNotes] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.post<TransferRec>('/stock-transfers', {
        clientRequestId: requestId,
        sourceEstablishmentId: sourceId,
        destEstablishmentId: establishmentId,
        notes: notes || null,
        items: lines.filter((l) => l.item).map((l) => ({ ...itemPayload(l.item), quantity: Number(l.quantity) })),
      }),
    onSuccess: async (t) => {
      await invalidate(qc);
      onDone(t);
    },
  });
  // La source peut être un établissement où l'utilisateur n'a aucun droit : c'est elle qui validera.
  const sources = all.data?.filter((e) => e.id !== establishmentId) ?? [];
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <Field label="Demander à l’établissement" hint="La demande devra être validée par l’établissement source.">
        <Select required value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">—</option>
          {sources.map((e) => (
            <option key={e.id} value={e.id}>
              {e.code} — {e.name}
            </option>
          ))}
        </Select>
      </Field>
      {lines.map((l, i) => (
        <div key={i} className="flex flex-wrap gap-2">
          <div className="min-w-[14rem] flex-1">
            <ItemSelect required items={items} value={l.item?.key ?? ''} onChange={(item) => setLines(lines.map((x, j) => (j === i ? { ...x, item } : x)))} />
          </div>
          <Input className="w-28" required type="number" min="0" step="any" placeholder="Qté" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
          <span className="self-center text-sm text-stone-500">{unitLabel(l.item?.unit)}</span>
          <Button type="button" variant="ghost" aria-label="Retirer" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={() => setLines([...lines, { item: null, quantity: '' }])}>
        <Plus className="size-4" /> Article
      </Button>
      <Field label="Notes">
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Envoyer la demande
        </Button>
      </div>
    </form>
  );
}

function TransferDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const estName = useEstName();
  const reason = useReasonDialog();
  const { data: t, isLoading } = useQuery({ queryKey: ['stock-transfers', id], queryFn: () => api.get<TransferRec>(`/stock-transfers/${id}`) });
  const [prep, setPrep] = useState<Record<string, string>>({});
  const [recv, setRecv] = useState<Record<string, { q: string; why: string }>>({});
  const [location, setLocation] = useState('');
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: object }) => api.post(`/stock-transfers/${id}/${action}`, body),
    onSuccess: () => invalidate(qc),
  });
  if (isLoading || !t) return <Spinner />;
  const canAt = (estId: string) => !!me?.establishments.find((e) => e.id === estId)?.permissions.includes('stock.transfer');
  const atSource = canAt(t.sourceEstablishmentId);
  const atDest = canAt(t.destEstablishmentId);
  const items = t.items ?? [];

  return (
    <div className="space-y-4">
      {reason.dialog}
      {act.error && <Alert>{(act.error as ApiError).message}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div>
          <StatusBadge map={TRANSFER_STATUS} status={t.status} /> {estName(t.sourceEstablishmentId)} → {estName(t.destEstablishmentId)}
          <div className="text-xs text-stone-500">
            {Object.entries(t.people ?? {})
              .filter(([, v]) => v)
              .map(([k, v]) => `${{ requestedBy: 'demandé', validatedBy: 'validé', preparedBy: 'préparé', shippedBy: 'expédié', receivedBy: 'reçu', closedBy: 'clôturé', cancelledBy: 'annulé' }[k]} par ${v}`)
              .join(' · ')}
          </div>
          {t.cancelReason && <div className="text-xs text-stone-500">Motif : {t.cancelReason}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {t.status === 'REQUESTED' && atSource && (
            <Button loading={act.isPending} onClick={() => act.mutate({ action: 'validate' })}>
              Valider
            </Button>
          )}
          {t.status === 'PREPARED' && atSource && (
            <Button loading={act.isPending} onClick={() => act.mutate({ action: 'ship' })}>
              Expédier
            </Button>
          )}
          {t.status === 'RECEIVED' && (atSource || atDest) && (
            <Button loading={act.isPending} onClick={() => act.mutate({ action: 'close' })}>
              Clôturer
            </Button>
          )}
          {['REQUESTED', 'VALIDATED', 'PREPARED'].includes(t.status) && (atSource || atDest) && (
            <Button variant="danger" onClick={() => reason.ask('Annuler le transfert', (r) => act.mutate({ action: 'cancel', body: { reason: r } }))}>
              Annuler
            </Button>
          )}
        </div>
      </div>

      <Table head={['Article', 'Demandé', 'Préparé', 'Expédié', 'Reçu', 'Lots']}>
        {items.map((i) => {
          const unit = unitLabel(i.item?.unit);
          return (
            <tr key={i.id}>
              <Td>{i.item?.name}</Td>
              <Td>
                {qty(i.requestedQuantity)} {unit}
              </Td>
              <Td>
                {t.status === 'VALIDATED' && atSource ? (
                  <Input className="w-24" type="number" min="0" step="any" value={prep[i.id] ?? String(Number(i.requestedQuantity))} onChange={(e) => setPrep({ ...prep, [i.id]: e.target.value })} />
                ) : (
                  qty(i.preparedQuantity)
                )}
              </Td>
              <Td>{qty(i.shippedQuantity)}</Td>
              <Td>
                {t.status === 'SHIPPED' && atDest && Number(i.shippedQuantity) > 0 ? (
                  <div className="space-y-1">
                    <Input
                      className="w-24"
                      type="number"
                      min="0"
                      step="any"
                      value={recv[i.id]?.q ?? String(Number(i.shippedQuantity))}
                      onChange={(e) => setRecv({ ...recv, [i.id]: { q: e.target.value, why: recv[i.id]?.why ?? '' } })}
                    />
                    {Number(recv[i.id]?.q ?? i.shippedQuantity) < Number(i.shippedQuantity) && (
                      <Input placeholder="Motif du manque *" value={recv[i.id]?.why ?? ''} onChange={(e) => setRecv({ ...recv, [i.id]: { q: recv[i.id]?.q ?? '', why: e.target.value } })} />
                    )}
                  </div>
                ) : (
                  <>
                    {qty(i.receivedQuantity)}
                    {i.gapReason && <div className="text-xs text-orange-700">{i.gapReason}</div>}
                  </>
                )}
              </Td>
              <Td className="font-mono text-xs">
                {i.lots.map((l) => (
                  <div key={l.id}>
                    {l.lotNumber} : {qty(l.shippedQuantity)}
                  </div>
                ))}
              </Td>
            </tr>
          );
        })}
      </Table>

      {t.status === 'VALIDATED' && atSource && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Emplacement de départ">
            <LocationSelect establishmentId={t.sourceEstablishmentId} value={location} onChange={setLocation} />
          </Field>
          <Button
            loading={act.isPending}
            onClick={() =>
              act.mutate({ action: 'prepare', body: { sourceLocationId: location || undefined, items: items.map((i) => ({ itemId: i.id, quantity: Number(prep[i.id] ?? i.requestedQuantity) })) } })
            }
          >
            Marquer comme préparé
          </Button>
        </div>
      )}
      {t.status === 'SHIPPED' && atDest && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Emplacement d’arrivée">
            <LocationSelect establishmentId={t.destEstablishmentId} value={location} onChange={setLocation} />
          </Field>
          <Button
            loading={act.isPending}
            onClick={() =>
              act.mutate({
                action: 'receive',
                body: {
                  destLocationId: location || undefined,
                  items: items
                    .filter((i) => Number(i.shippedQuantity) > 0)
                    .map((i) => ({ itemId: i.id, receivedQuantity: Number(recv[i.id]?.q ?? i.shippedQuantity), gapReason: recv[i.id]?.why || null })),
                },
              })
            }
          >
            Réceptionner
          </Button>
        </div>
      )}
      {!!t.transitLosses?.length && (
        <Alert>
          Perte en transit (à la charge de l’établissement source) :{' '}
          {t.transitLosses.map((l) => `${qty(l.quantity)} — ${formatXOF(l.estimatedValue)}`).join(', ')}
        </Alert>
      )}
    </div>
  );
}

export function TransfersPage() {
  const { establishment, can } = useEstablishment();
  const estName = useEstName();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Transferts entre établissements" subtitle={establishment ? establishment.name : undefined} />
      <RequireEstablishment>
        {(establishmentId) => (
          <TransferList establishmentId={establishmentId} estName={estName} onOpen={setOpenId}>
            {can('stock.transfer') && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" /> Demander un transfert
              </Button>
            )}
            <Modal open={creating} onClose={() => setCreating(false)} title="Demande de transfert vers cet établissement" wide>
              {creating && (
                <TransferForm
                  establishmentId={establishmentId}
                  onDone={(t) => {
                    setCreating(false);
                    setOpenId(t.id);
                  }}
                />
              )}
            </Modal>
          </TransferList>
        )}
      </RequireEstablishment>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title="Transfert" wide>
        {openId && <TransferDetail key={openId} id={openId} />}
      </Modal>
    </>
  );
}

function TransferList({ establishmentId, estName, onOpen, children }: { establishmentId: string; estName: (id: string) => string; onOpen: (id: string) => void; children: React.ReactNode }) {
  const { data, isLoading } = useQuery({ queryKey: ['stock-transfers', 'list', establishmentId], queryFn: () => api.get<TransferRec[]>(`/stock-transfers?establishmentId=${establishmentId}`) });
  return (
    <Card title="Transferts" actions={children}>
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['N°', 'Demandé le', 'De', 'Vers', 'Lignes', 'Statut', '']} empty={data?.length === 0}>
          {data?.map((t) => (
            <tr key={t.id} className="cursor-pointer hover:bg-stone-50" onClick={() => onOpen(t.id)}>
              <Td className="font-mono text-xs">{t.number}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(t.requestedAt)}</Td>
              <Td>{estName(t.sourceEstablishmentId)}</Td>
              <Td>{estName(t.destEstablishmentId)}</Td>
              <Td>{t._count?.items}</Td>
              <Td>
                <StatusBadge map={TRANSFER_STATUS} status={t.status} />
              </Td>
              <Td className="text-right text-brand-700">Ouvrir</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
