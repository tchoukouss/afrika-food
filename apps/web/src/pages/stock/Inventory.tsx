import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { qty } from '../../lib/catalog-types';
import { formatDateTime, formatXOF } from '../../lib/format';
import { unitLabel } from '../../lib/stock-types';
import { ItemSelect, itemPayload, LocationSelect, PickableItem, RequireEstablishment, useEstablishment, useReasonDialog, useStockItems } from './shared';

interface InventoryLine {
  id: string;
  theoreticalQuantity: string;
  countedQuantity: string | null;
  unitCost: string | null;
  justification: string | null;
  gap: string | null;
  gapValue: string | null;
  item: { name: string; code: string; unit: string } | null;
}

interface InventoryRec {
  id: string;
  number: string;
  status: 'OPEN' | 'VALIDATED' | 'CANCELLED';
  openedAt: string;
  closedAt: string | null;
  notes: string | null;
  locationName?: string;
  location?: { name: string } | null;
  openedBy?: string | null;
  closedBy?: string | null;
  items?: InventoryLine[];
  _count?: { items: number };
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all(['inventories', 'stock', 'stock-locations', 'movements'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

/** Ligne de comptage : enregistrée à la sortie du champ (saisie rapide au clavier). */
function CountRow({ inventoryId, line, editable }: { inventoryId: string; line: InventoryLine; editable: boolean }) {
  const qc = useQueryClient();
  const [counted, setCounted] = useState(line.countedQuantity !== null ? String(Number(line.countedQuantity)) : '');
  const [cost, setCost] = useState(line.unitCost !== null ? String(Number(line.unitCost)) : '');
  const [why, setWhy] = useState(line.justification ?? '');
  const save = useMutation({
    mutationFn: () =>
      api.put(`/inventories/${inventoryId}/items/${line.id}`, { countedQuantity: Number(counted), unitCost: cost === '' ? null : Number(cost), justification: why || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventories', inventoryId] }),
  });
  const gap = counted === '' ? null : Number(counted) - Number(line.theoreticalQuantity);
  const unit = unitLabel(line.item?.unit);
  const dirty =
    counted !== (line.countedQuantity !== null ? String(Number(line.countedQuantity)) : '') ||
    cost !== (line.unitCost !== null ? String(Number(line.unitCost)) : '') ||
    why !== (line.justification ?? '');
  const commit = () => counted !== '' && dirty && save.mutate();

  return (
    <tr className={gap !== null && gap !== 0 ? 'bg-amber-50' : ''}>
      <Td>
        <div className="font-medium">{line.item?.name}</div>
        <div className="font-mono text-xs text-stone-500">{line.item?.code}</div>
        {save.error && <div className="text-xs text-red-600">{(save.error as ApiError).message}</div>}
      </Td>
      <Td className="whitespace-nowrap">
        {qty(line.theoreticalQuantity)} {unit}
      </Td>
      <Td>
        {editable ? (
          <Input className="w-28" type="number" min="0" step="any" value={counted} onChange={(e) => setCounted(e.target.value)} onBlur={commit} />
        ) : (
          `${qty(line.countedQuantity)} ${unit}`
        )}
      </Td>
      <Td className={`whitespace-nowrap font-semibold ${gap === null ? '' : gap < 0 ? 'text-red-700' : gap > 0 ? 'text-green-700' : ''}`}>
        {gap === null ? '—' : `${gap > 0 ? '+' : ''}${qty(gap)} ${unit}`}
      </Td>
      <Td>
        {gap !== null && gap > 0 ? (
          editable ? (
            <Input className="w-28" type="number" min="0" step="any" placeholder="Coût" value={cost} onChange={(e) => setCost(e.target.value)} onBlur={commit} />
          ) : (
            formatXOF(line.unitCost)
          )
        ) : (
          '—'
        )}
      </Td>
      <Td>
        {gap !== null && gap !== 0 ? (
          editable ? (
            <Input placeholder="Justification *" value={why} onChange={(e) => setWhy(e.target.value)} onBlur={commit} />
          ) : (
            line.justification
          )
        ) : (
          '—'
        )}
      </Td>
      <Td>{save.isPending ? <span className="text-xs text-stone-500">…</span> : line.countedQuantity !== null && !dirty ? <Badge tone="green">✓</Badge> : null}</Td>
    </tr>
  );
}

function InventorySheet({ id }: { id: string }) {
  const qc = useQueryClient();
  const { can } = useEstablishment();
  const reason = useReasonDialog();
  const { items } = useStockItems();
  const [adding, setAdding] = useState<PickableItem | null>(null);
  const { data: inv, isLoading } = useQuery({ queryKey: ['inventories', id], queryFn: () => api.get<InventoryRec>(`/inventories/${id}`) });
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: object }) => api.post(`/inventories/${id}/${action}`, body),
    onSuccess: async () => {
      setAdding(null);
      await invalidate(qc);
    },
  });
  if (isLoading || !inv) return <Spinner />;
  const open = inv.status === 'OPEN';
  const editable = open && can('inventory.manage');
  const lines = inv.items ?? [];
  const counted = lines.filter((l) => l.countedQuantity !== null).length;

  return (
    <div className="space-y-4">
      {reason.dialog}
      {act.error && <Alert>{(act.error as ApiError).message}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div>
          {inv.location?.name} · ouvert le {formatDateTime(inv.openedAt)} par {inv.openedBy}
          {inv.closedAt && ` · clôturé le ${formatDateTime(inv.closedAt)} par ${inv.closedBy}`}
          <div className="text-stone-500">
            {counted} / {lines.length} lignes comptées
          </div>
        </div>
        {open && can('inventory.validate') && (
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => reason.ask('Annuler l’inventaire', (r) => act.mutate({ action: 'cancel', body: { reason: r } }))}>
              Annuler
            </Button>
            <Button loading={act.isPending} onClick={() => act.mutate({ action: 'validate' })}>
              Valider l’inventaire
            </Button>
          </div>
        )}
      </div>
      {open && <Alert tone="info">Emplacement gelé : aucune entrée ni sortie n’est possible tant que l’inventaire est ouvert. Saisissez les quantités réellement comptées.</Alert>}
      <Table head={['Article', 'Théorique', 'Compté', 'Écart', 'Coût du surplus', 'Justification', '']} empty={lines.length === 0}>
        {lines.map((l) => (
          <CountRow key={l.id} inventoryId={id} line={l} editable={editable} />
        ))}
      </Table>
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[16rem]">
            <ItemSelect items={items} value={adding?.key ?? ''} onChange={setAdding} />
          </div>
          <Button variant="secondary" disabled={!adding} onClick={() => act.mutate({ action: 'items', body: itemPayload(adding) })}>
            <Plus className="size-4" /> Ajouter un article trouvé
          </Button>
        </div>
      )}
    </div>
  );
}

export function InventoryPage() {
  const qc = useQueryClient();
  const { establishment, can } = useEstablishment();
  const [opening, setOpening] = useState(false);
  const [locationId, setLocationId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Inventaires" subtitle={establishment ? establishment.name : undefined} />
      <RequireEstablishment>
        {(establishmentId) => (
          <InventoryList
            establishmentId={establishmentId}
            onOpen={setOpenId}
            actions={
              can('inventory.manage') && (
                <Button onClick={() => setOpening(true)}>
                  <Plus className="size-4" /> Ouvrir un inventaire
                </Button>
              )
            }
          >
            <Modal open={opening} onClose={() => setOpening(false)} title="Ouvrir un inventaire">
              <OpenForm
                establishmentId={establishmentId}
                locationId={locationId}
                setLocationId={setLocationId}
                onDone={async (id) => {
                  setOpening(false);
                  await invalidate(qc);
                  setOpenId(id);
                }}
              />
            </Modal>
          </InventoryList>
        )}
      </RequireEstablishment>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title="Feuille d’inventaire" wide>
        {openId && <InventorySheet key={openId} id={openId} />}
      </Modal>
    </>
  );
}

function OpenForm({ establishmentId, locationId, setLocationId, onDone }: { establishmentId: string; locationId: string; setLocationId: (id: string) => void; onDone: (id: string) => void }) {
  const [notes, setNotes] = useState('');
  const open = useMutation({ mutationFn: () => api.post<InventoryRec>('/inventories', { establishmentId, locationId: locationId || undefined, notes: notes || null }), onSuccess: (inv) => onDone(inv.id) });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), open.mutate())}>
      {open.error && <Alert>{(open.error as ApiError).message}</Alert>}
      <Field label="Emplacement à inventorier">
        <LocationSelect establishmentId={establishmentId} value={locationId} onChange={setLocationId} />
      </Field>
      <Field label="Notes">
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Inventaire de fin de mois…" />
      </Field>
      <Alert tone="info">À l’ouverture, le stock théorique est figé et l’emplacement est gelé jusqu’à la validation. Pour le démarrage, ce premier inventaire sert d’inventaire d’ouverture : ajoutez chaque article trouvé et son coût.</Alert>
      <div className="flex justify-end">
        <Button type="submit" loading={open.isPending}>
          Ouvrir et geler l’emplacement
        </Button>
      </div>
    </form>
  );
}

function InventoryList({ establishmentId, onOpen, actions, children }: { establishmentId: string; onOpen: (id: string) => void; actions: React.ReactNode; children: React.ReactNode }) {
  const { data, isLoading } = useQuery({ queryKey: ['inventories', 'list', establishmentId], queryFn: () => api.get<InventoryRec[]>(`/inventories?establishmentId=${establishmentId}`) });
  return (
    <Card title="Inventaires" actions={actions}>
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['N°', 'Emplacement', 'Ouvert le', 'Lignes', 'Statut', '']} empty={data?.length === 0}>
          {data?.map((i) => (
            <tr key={i.id} className="cursor-pointer hover:bg-stone-50" onClick={() => onOpen(i.id)}>
              <Td className="font-mono text-xs">{i.number}</Td>
              <Td>{i.locationName}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(i.openedAt)}</Td>
              <Td>{i._count?.items}</Td>
              <Td>{i.status === 'OPEN' ? <Badge tone="orange">En cours (gelé)</Badge> : i.status === 'VALIDATED' ? <Badge tone="green">Validé</Badge> : <Badge>Annulé</Badge>}</Td>
              <Td className="text-right text-brand-700">Ouvrir</Td>
            </tr>
          ))}
        </Table>
      )}
      {children}
    </Card>
  );
}
