import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { qty } from '../../lib/catalog-types';
import { formatDate, formatDateTime, formatXOF } from '../../lib/format';
import { LOSS_CAUSES, LotRow, Movement, MOVEMENT_TYPES, StockLocation, StockRow, unitLabel } from '../../lib/stock-types';
import { itemPayload, ItemSelect, LocationSelect, PickableItem, RequireEstablishment, Tabs, useEstablishment, useLocations, useRequestId, useStockItems } from './shared';

interface PurchasePrice {
  receiptId: string;
  receiptNumber: string;
  receivedAt: string;
  supplier: { id: string; name: string } | null;
  brand: string | null;
  purchaseUnitLabel: string;
  quantityPerPurchaseUnit: string;
  acceptedQuantity: string;
  unitPrice: string;
  unitCost: string;
}

const STATUS_BADGE = {
  OK: <Badge tone="green">OK</Badge>,
  ALERT: <Badge tone="orange">Sous le seuil</Badge>,
  CRITICAL: <Badge tone="red">Critique</Badge>,
  NONE: null,
};

const invalidateStock = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all(['stock', 'stock-losses', 'stock-adjustments', 'stock-locations', 'movements'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

// --- Formulaires d'opérations ----------------------------------------------------

function LossForm({ establishmentId, preset, lotId, onDone }: { establishmentId: string; preset?: PickableItem | null; lotId?: string; onDone: () => void }) {
  const requestId = useRequestId();
  const qc = useQueryClient();
  const { items } = useStockItems();
  const [item, setItem] = useState<PickableItem | null>(preset ?? null);
  const [f, setF] = useState({ quantity: '', cause: lotId ? 'EXPIRED' : 'BROKEN', comment: '', locationId: '' });
  const save = useMutation({
    mutationFn: () =>
      api.post('/stock-losses', { clientRequestId: requestId, establishmentId, ...itemPayload(item), lotId, quantity: Number(f.quantity), cause: f.cause, comment: f.comment || null, locationId: f.locationId || undefined }),
    onSuccess: async () => {
      await invalidateStock(qc);
      onDone();
    },
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      {!preset && (
        <Field label="Article">
          <ItemSelect required items={items} value={item?.key ?? ''} onChange={setItem} />
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={`Quantité (${unitLabel(item?.unit)})`}>
          <Input required type="number" min="0" step="any" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
        </Field>
        <Field label="Cause">
          <Select value={f.cause} onChange={(e) => setF({ ...f, cause: e.target.value })}>
            {Object.entries(LOSS_CAUSES)
              .filter(([k]) => k !== 'TRANSIT')
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </Select>
        </Field>
        {!lotId && (
          <Field label="Emplacement">
            <LocationSelect establishmentId={establishmentId} value={f.locationId} onChange={(locationId) => setF({ ...f, locationId })} />
          </Field>
        )}
      </div>
      <Field label="Commentaire">
        <Input value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
      </Field>
      <p className="text-xs text-stone-500">Sortie immédiate du stock (lot qui périme le plus tôt en premier). Un lot périmé ne sort qu’avec la cause « Péremption ».</p>
      <div className="flex justify-end">
        <Button type="submit" variant="danger" loading={save.isPending}>
          Déclarer la perte
        </Button>
      </div>
    </form>
  );
}

function AdjustmentForm({ establishmentId, preset, onDone }: { establishmentId: string; preset?: PickableItem | null; onDone: () => void }) {
  const requestId = useRequestId();
  const qc = useQueryClient();
  const { items } = useStockItems();
  const [item, setItem] = useState<PickableItem | null>(preset ?? null);
  const [f, setF] = useState({ direction: 'OUT', quantity: '', unitCost: '', reason: '', locationId: '' });
  const save = useMutation({
    mutationFn: () =>
      api.post('/stock-adjustments', {
        clientRequestId: requestId,
        establishmentId,
        ...itemPayload(item),
        direction: f.direction,
        quantity: Number(f.quantity),
        reason: f.reason,
        locationId: f.locationId || undefined,
        ...(f.direction === 'IN' && f.unitCost !== '' ? { unitCost: Number(f.unitCost) } : {}),
      }),
    onSuccess: async () => {
      await invalidateStock(qc);
      onDone();
    },
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      {!preset && (
        <Field label="Article">
          <ItemSelect required items={items} value={item?.key ?? ''} onChange={setItem} />
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Sens">
          <Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
            <option value="OUT">Retirer du stock</option>
            <option value="IN">Ajouter au stock</option>
          </Select>
        </Field>
        <Field label={`Quantité (${unitLabel(item?.unit)})`}>
          <Input required type="number" min="0" step="any" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
        </Field>
        <Field label="Emplacement">
          <LocationSelect establishmentId={establishmentId} value={f.locationId} onChange={(locationId) => setF({ ...f, locationId })} />
        </Field>
      </div>
      {f.direction === 'IN' && (
        <Field label="Coût unitaire (FCFA)" hint="Laisser vide pour utiliser le coût du dernier lot ou de l’offre fournisseur préférée.">
          <Input type="number" min="0" step="any" value={f.unitCost} onChange={(e) => setF({ ...f, unitCost: e.target.value })} />
        </Field>
      )}
      <Field label="Motif (obligatoire)">
        <Input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </Field>
      <p className="text-xs text-stone-500">La correction ne modifie le stock qu’après validation par un responsable.</p>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Demander la correction
        </Button>
      </div>
    </form>
  );
}

function MoveForm({ establishmentId, preset, onDone }: { establishmentId: string; preset: PickableItem; onDone: () => void }) {
  const requestId = useRequestId();
  const qc = useQueryClient();
  const { data: locations } = useLocations(establishmentId);
  const [f, setF] = useState({ fromLocationId: '', toLocationId: '', quantity: '', reason: '' });
  const save = useMutation({
    mutationFn: () => api.post('/location-moves', { clientRequestId: requestId, establishmentId, ...itemPayload(preset), ...f, quantity: Number(f.quantity), reason: f.reason || null }),
    onSuccess: async () => {
      await invalidateStock(qc);
      onDone();
    },
  });
  const active = locations?.filter((l) => l.isActive) ?? [];
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        {(['fromLocationId', 'toLocationId'] as const).map((k) => (
          <Field key={k} label={k === 'fromLocationId' ? 'De' : 'Vers'}>
            <Select required value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
              <option value="">—</option>
              {active.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        ))}
        <Field label={`Quantité (${unitLabel(preset.unit)})`}>
          <Input required type="number" min="0" step="any" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
        </Field>
      </div>
      <Field label="Motif">
        <Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Déplacer
        </Button>
      </div>
    </form>
  );
}

function ThresholdForm({ establishmentId, row, onDone }: { establishmentId: string; row: StockRow; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ minQuantity: row.minQuantity ? String(Number(row.minQuantity)) : '', alertQuantity: row.alertQuantity ? String(Number(row.alertQuantity)) : '' });
  const save = useMutation({
    mutationFn: () =>
      api.put('/stock/thresholds', { establishmentId, rawMaterialId: row.rawMaterialId ?? undefined, productId: row.productId ?? undefined, minQuantity: Number(f.minQuantity), alertQuantity: Number(f.alertQuantity) }),
    onSuccess: async () => {
      await invalidateStock(qc);
      onDone();
    },
  });
  const unit = unitLabel(row.item?.unit);
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <Field label={`Stock minimum (${unit})`}>
        <Input required className="w-32" type="number" min="0" step="any" value={f.minQuantity} onChange={(e) => setF({ ...f, minQuantity: e.target.value })} />
      </Field>
      <Field label={`Seuil d’alerte (${unit})`}>
        <Input required className="w-32" type="number" min="0" step="any" value={f.alertQuantity} onChange={(e) => setF({ ...f, alertQuantity: e.target.value })} />
      </Field>
      <Button type="submit" variant="secondary" loading={save.isPending}>
        Enregistrer
      </Button>
      {save.error && <span className="text-sm text-red-600">{(save.error as ApiError).message}</span>}
    </form>
  );
}

// --- Fiche article ----------------------------------------------------------------

function ItemDetail({ establishmentId, row }: { establishmentId: string; row: StockRow }) {
  const { can } = useEstablishment();
  const [action, setAction] = useState<'loss' | 'adjust' | 'move' | null>(null);
  const [lossLot, setLossLot] = useState<string | undefined>();
  const param = row.rawMaterialId ? `rawMaterialId=${row.rawMaterialId}` : `productId=${row.productId}`;
  const detail = useQuery({
    queryKey: ['stock', 'item', establishmentId, param],
    queryFn: () => api.get<{ lots: LotRow[]; purchaseHistory: PurchasePrice[] }>(`/stock/item?${param}&establishmentId=${establishmentId}`),
  });
  const moves = useQuery({ queryKey: ['movements', establishmentId, param], queryFn: () => api.get<{ items: Movement[] }>(`/stock/movements?${param}&establishmentId=${establishmentId}&pageSize=30`) });
  const unit = unitLabel(row.item?.unit);
  const preset: PickableItem = { key: '', rawMaterialId: row.rawMaterialId, productId: row.productId, code: row.item?.code ?? '', name: row.item?.name ?? '', unit: row.item?.unit ?? '', isPerishable: false };
  const canAdjust = can('stock.adjust');

  return (
    <div className="space-y-5">
      <div className="grid gap-2 text-sm sm:grid-cols-4">
        <div className="rounded-lg bg-stone-50 p-3">
          <div className="text-stone-500">Physique</div>
          <div className="text-lg font-bold">
            {qty(row.quantity)} {unit}
          </div>
          {row.packaging && (
            <div className="text-xs text-stone-500">
              soit {qty(row.packaging.count)} × {row.packaging.name}
            </div>
          )}
        </div>
        <div className="rounded-lg bg-stone-50 p-3">
          <div className="text-stone-500">Disponible</div>
          <div className="text-lg font-bold">
            {qty(row.available)} {unit}
          </div>
          <div className="text-xs text-stone-500">
            réservé {qty(row.reserved)} · périmé {qty(row.expired)}
          </div>
        </div>
        <div className="rounded-lg bg-stone-50 p-3">
          <div className="text-stone-500">Valeur</div>
          <div className="text-lg font-bold">{formatXOF(row.value)}</div>
          <div className="text-xs text-stone-500">coût moyen {row.averageCost ? `${formatXOF(row.averageCost)} / ${unit}` : '—'}</div>
        </div>
        <div className="rounded-lg bg-stone-50 p-3">
          <div className="text-stone-500">Dernier prix d’achat</div>
          <div className="text-lg font-bold">{row.lastPurchaseCost ? `${formatXOF(row.lastPurchaseCost)} / ${unit}` : '—'}</div>
        </div>
      </div>

      {canAdjust && (
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={() => (setLossLot(undefined), setAction('loss'))}>
            Déclarer une perte
          </Button>
          <Button variant="secondary" onClick={() => setAction('adjust')}>
            Demander une correction
          </Button>
          <Button variant="secondary" onClick={() => setAction('move')}>
            Déplacer
          </Button>
        </div>
      )}
      {action && (
        <Card title={action === 'loss' ? 'Perte' : action === 'adjust' ? 'Correction' : 'Déplacement entre emplacements'}>
          {action === 'loss' && <LossForm establishmentId={establishmentId} preset={preset} lotId={lossLot} onDone={() => setAction(null)} />}
          {action === 'adjust' && <AdjustmentForm establishmentId={establishmentId} preset={preset} onDone={() => setAction(null)} />}
          {action === 'move' && <MoveForm establishmentId={establishmentId} preset={preset} onDone={() => setAction(null)} />}
        </Card>
      )}

      <div className="space-y-2">
        <h3 className="font-semibold">Lots en stock</h3>
        {detail.isLoading ? (
          <Spinner />
        ) : (
          <Table head={['Lot', 'Emplacement', 'Fournisseur / marque', 'Péremption', 'Coût', 'Quantité', '']} empty={!detail.data?.lots.length}>
            {detail.data?.lots.map((l) => (
              <tr key={l.balanceId} className={l.isExpired ? 'bg-red-50' : ''}>
                <Td className="font-mono text-xs">
                  {l.lotNumber}
                  {l.supplierLotRef && <div className="text-stone-500">réf. {l.supplierLotRef}</div>}
                </Td>
                <Td>{l.location.name}</Td>
                <Td>
                  {l.supplier?.name ?? (l.origin === 'INVENTORY' ? 'Inventaire' : l.origin === 'ADJUSTMENT' ? 'Correction' : '—')}
                  {l.brand && <div className="text-xs text-stone-500">{l.brand}</div>}
                </Td>
                <Td className="whitespace-nowrap">{l.expiryDate ? <>{formatDate(l.expiryDate)} {l.isExpired && <Badge tone="red">Périmé</Badge>}</> : '—'}</Td>
                <Td className="whitespace-nowrap">
                  {formatXOF(l.unitCost)} / {unit}
                </Td>
                <Td className="whitespace-nowrap font-semibold">
                  {qty(l.quantity)} {unit}
                </Td>
                <Td>
                  {l.isExpired && canAdjust && (
                    <Button variant="ghost" onClick={() => (setLossLot(l.lotId), setAction('loss'))}>
                      Sortir (péremption)
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="font-semibold">Derniers prix d’achat</h3>
        <Table head={['Date', 'Réception', 'Fournisseur / marque', 'Conditionnement', 'Quantité', 'Prix', `Prix / ${unit}`]} empty={!detail.data?.purchaseHistory.length}>
          {detail.data?.purchaseHistory.map((p) => (
            <tr key={`${p.receiptId}-${p.unitPrice}-${p.purchaseUnitLabel}`}>
              <Td className="whitespace-nowrap">{formatDate(p.receivedAt)}</Td>
              <Td className="font-mono text-xs">{p.receiptNumber}</Td>
              <Td>
                {p.supplier?.name}
                {p.brand && <div className="text-xs text-stone-500">{p.brand}</div>}
              </Td>
              <Td>
                {p.purchaseUnitLabel} ({qty(p.quantityPerPurchaseUnit)} {unit})
              </Td>
              <Td>{qty(p.acceptedQuantity)}</Td>
              <Td className="whitespace-nowrap">{formatXOF(p.unitPrice)}</Td>
              <Td className="whitespace-nowrap font-semibold">{formatXOF(p.unitCost)}</Td>
            </tr>
          ))}
        </Table>
      </div>

      {canAdjust && (
        <div className="space-y-2">
          <h3 className="font-semibold">Seuils pour cet établissement</h3>
          <ThresholdForm establishmentId={establishmentId} row={row} onDone={() => undefined} />
        </div>
      )}

      <div className="space-y-2">
        <h3 className="font-semibold">Derniers mouvements</h3>
        <MovementTable rows={moves.data?.items ?? []} unit={unit} />
      </div>
    </div>
  );
}

function MovementTable({ rows, unit }: { rows: Movement[]; unit?: string }) {
  return (
    <Table head={['Date', 'Type', 'Article', 'Lot', 'Emplacement', 'Quantité', 'Solde lot', 'Par', 'Motif']} empty={rows.length === 0}>
      {rows.map((m) => (
        <tr key={m.id}>
          <Td className="whitespace-nowrap">{formatDateTime(m.createdAt)}</Td>
          <Td>{MOVEMENT_TYPES[m.type] ?? m.type}</Td>
          <Td>{m.item?.name}</Td>
          <Td className="font-mono text-xs">{m.lotNumber}</Td>
          <Td>{m.locationName}</Td>
          <Td className={`whitespace-nowrap font-semibold ${Number(m.quantity) < 0 ? 'text-red-700' : 'text-green-700'}`}>
            {Number(m.quantity) > 0 ? '+' : ''}
            {qty(m.quantity)} {unit ?? unitLabel(m.item?.unit)}
          </Td>
          <Td>{qty(m.balanceAfter)}</Td>
          <Td>{m.userName ?? '—'}</Td>
          <Td className="text-stone-500">{m.reason ?? '—'}</Td>
        </tr>
      ))}
    </Table>
  );
}

// --- Onglets ------------------------------------------------------------------

function StockTab({ establishmentId }: { establishmentId: string }) {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [below, setBelow] = useState(false);
  const [open, setOpen] = useState<StockRow | null>(null);
  const params = new URLSearchParams({ establishmentId });
  if (search.trim()) params.set('search', search.trim());
  if (kind) params.set('kind', kind);
  if (below) params.set('belowAlert', 'true');
  const { data, isLoading, error } = useQuery({ queryKey: ['stock', 'items', params.toString()], queryFn: () => api.get<StockRow[]>(`/stock/items?${params}`), placeholderData: keepPreviousData });
  const total = (data ?? []).reduce((s, r) => s + Number(r.value), 0);

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Rechercher un article…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select className="max-w-[12rem]" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Matières et produits</option>
          <option value="RAW_MATERIAL">Matières premières</option>
          <option value="PRODUCT">Produits</option>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={below} onChange={(e) => setBelow(e.target.checked)} /> Sous le seuil uniquement
        </label>
        <span className="ml-auto text-sm text-stone-600">
          Valeur totale : <strong>{formatXOF(total)}</strong>
        </span>
      </div>
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{(error as ApiError).message}</Alert>
      ) : (
        <Table head={['Article', 'Physique', 'Disponible', 'Périmé', 'Valeur', 'Coût moyen', 'Prochaine péremption', 'État']} empty={data?.length === 0}>
          {data?.map((r) => {
            const unit = unitLabel(r.item?.unit);
            return (
              <tr key={`${r.rawMaterialId}${r.productId}`} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpen(r)}>
                <Td>
                  <div className="font-medium">{r.item?.name}</div>
                  <div className="font-mono text-xs text-stone-500">{r.item?.code}</div>
                </Td>
                <Td className="whitespace-nowrap">
                  {qty(r.quantity)} {unit}
                  {r.packaging && (
                    <div className="text-xs text-stone-500">
                      {qty(r.packaging.count)} × {r.packaging.name}
                    </div>
                  )}
                </Td>
                <Td className="whitespace-nowrap font-semibold">
                  {qty(r.available)} {unit}
                </Td>
                <Td className="whitespace-nowrap">{Number(r.expired) > 0 ? <Badge tone="red">{qty(r.expired)} {unit}</Badge> : '—'}</Td>
                <Td className="whitespace-nowrap">{formatXOF(r.value)}</Td>
                <Td className="whitespace-nowrap">{r.averageCost ? `${formatXOF(r.averageCost)} / ${unit}` : '—'}</Td>
                <Td className="whitespace-nowrap">{formatDate(r.nextExpiry)}</Td>
                <Td>{STATUS_BADGE[r.status]}</Td>
              </tr>
            );
          })}
        </Table>
      )}
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.item?.name ?? ''} wide>
        {open && <ItemDetail establishmentId={establishmentId} row={open} />}
      </Modal>
    </Card>
  );
}

function MovementsTab({ establishmentId }: { establishmentId: string }) {
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ establishmentId, page: String(page), pageSize: '50' });
  if (type) params.set('type', type);
  const { data, isLoading } = useQuery({ queryKey: ['movements', params.toString()], queryFn: () => api.get<{ items: Movement[]; total: number }>(`/stock/movements?${params}`), placeholderData: keepPreviousData });
  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="max-w-[14rem]" value={type} onChange={(e) => (setType(e.target.value), setPage(1))}>
          <option value="">Tous les mouvements</option>
          {Object.entries(MOVEMENT_TYPES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <span className="text-sm text-stone-500">Journal en lecture seule : aucun mouvement ne peut être modifié ou supprimé.</span>
      </div>
      {isLoading ? <Spinner /> : <MovementTable rows={data?.items ?? []} />}
      <div className="mt-3 flex items-center justify-end gap-2 text-sm">
        <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Précédent
        </Button>
        {page} / {pages}
        <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Suivant
        </Button>
      </div>
    </Card>
  );
}

interface LossRecord {
  id: string;
  number: string;
  quantity: string;
  cause: string;
  comment: string | null;
  estimatedValue: string;
  createdAt: string;
  declaredBy: string | null;
  item: { name: string; unit: string } | null;
}

function LossesTab({ establishmentId }: { establishmentId: string }) {
  const { can } = useEstablishment();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['stock-losses', establishmentId], queryFn: () => api.get<LossRecord[]>(`/stock-losses?establishmentId=${establishmentId}`) });
  const total = (data ?? []).reduce((s, l) => s + Number(l.estimatedValue), 0);
  return (
    <Card
      title={`Pertes — ${formatXOF(total)}`}
      actions={
        can('stock.adjust') && (
          <Button variant="danger" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Déclarer une perte
          </Button>
        )
      }
    >
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['N°', 'Date', 'Article', 'Quantité', 'Cause', 'Valeur', 'Par', 'Commentaire']} empty={data?.length === 0}>
          {data?.map((l) => (
            <tr key={l.id}>
              <Td className="font-mono text-xs">{l.number}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(l.createdAt)}</Td>
              <Td>{l.item?.name}</Td>
              <Td className="whitespace-nowrap">
                {qty(l.quantity)} {unitLabel(l.item?.unit)}
              </Td>
              <Td>
                <Badge tone={l.cause === 'TRANSIT' ? 'orange' : 'red'}>{LOSS_CAUSES[l.cause]}</Badge>
              </Td>
              <Td className="whitespace-nowrap">{formatXOF(l.estimatedValue)}</Td>
              <Td>{l.declaredBy}</Td>
              <Td className="text-stone-500">{l.comment ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Déclarer une perte">
        {creating && <LossForm establishmentId={establishmentId} onDone={() => setCreating(false)} />}
      </Modal>
    </Card>
  );
}

interface AdjustmentRecord {
  id: string;
  number: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  direction: 'IN' | 'OUT';
  quantity: string;
  unitCost: string | null;
  reason: string;
  createdAt: string;
  requestedBy: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  item: { name: string; unit: string } | null;
}

function AdjustmentsTab({ establishmentId }: { establishmentId: string }) {
  const qc = useQueryClient();
  const { can } = useEstablishment();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['stock-adjustments', establishmentId], queryFn: () => api.get<AdjustmentRecord[]>(`/stock-adjustments?establishmentId=${establishmentId}`) });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.post(`/stock-adjustments/${id}/${approve ? 'approve' : 'reject'}`, {}),
    onSuccess: () => invalidateStock(qc),
  });
  return (
    <Card
      title="Corrections de stock"
      actions={
        can('stock.adjust') && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Demander une correction
          </Button>
        )
      }
    >
      {decide.error && <Alert>{(decide.error as ApiError).message}</Alert>}
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['N°', 'Date', 'Article', 'Correction', 'Motif', 'Demandée par', 'Statut', '']} empty={data?.length === 0}>
          {data?.map((a) => (
            <tr key={a.id}>
              <Td className="font-mono text-xs">{a.number}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(a.createdAt)}</Td>
              <Td>{a.item?.name}</Td>
              <Td className="whitespace-nowrap">
                {a.direction === 'IN' ? '+' : '−'}
                {qty(a.quantity)} {unitLabel(a.item?.unit)}
                {a.unitCost && <div className="text-xs text-stone-500">à {formatXOF(a.unitCost)}</div>}
              </Td>
              <Td>{a.reason}</Td>
              <Td>{a.requestedBy}</Td>
              <Td>
                {a.status === 'PENDING' ? <Badge tone="orange">À valider</Badge> : a.status === 'APPROVED' ? <Badge tone="green">Validée</Badge> : <Badge tone="red">Refusée</Badge>}
                {a.decidedBy && <div className="text-xs text-stone-500">{a.decidedBy}</div>}
              </Td>
              <Td className="whitespace-nowrap">
                {a.status === 'PENDING' && can('inventory.validate') && (
                  <>
                    <Button variant="secondary" loading={decide.isPending} onClick={() => decide.mutate({ id: a.id, approve: true })}>
                      Valider
                    </Button>
                    <Button variant="ghost" onClick={() => decide.mutate({ id: a.id, approve: false })}>
                      Refuser
                    </Button>
                  </>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Demander une correction">
        {creating && <AdjustmentForm establishmentId={establishmentId} onDone={() => setCreating(false)} />}
      </Modal>
    </Card>
  );
}

function LocationsTab({ establishmentId }: { establishmentId: string }) {
  const qc = useQueryClient();
  const { can } = useEstablishment();
  const { data, isLoading } = useLocations(establishmentId);
  const [draft, setDraft] = useState({ code: '', name: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['stock-locations'] });
  const create = useMutation({
    mutationFn: () => api.post('/stock-locations', { establishmentId, ...draft }),
    onSuccess: async () => {
      setDraft({ code: '', name: '' });
      await refresh();
    },
  });
  const toggle = useMutation({ mutationFn: (l: StockLocation) => api.patch(`/stock-locations/${l.id}`, { isActive: !l.isActive }), onSuccess: refresh });
  const error = (create.error || toggle.error) as ApiError | null;
  return (
    <Card title="Emplacements de stockage">
      {error && <Alert>{error.message}</Alert>}
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['Code', 'Nom', 'Statut', '']} empty={data?.length === 0}>
          {data?.map((l) => (
            <tr key={l.id}>
              <Td className="font-mono">{l.code}</Td>
              <Td>
                {l.name} {l.isDefault && <Badge tone="orange">Par défaut</Badge>}
              </Td>
              <Td>{l.openInventory ? <Badge tone="red">Gelé — inventaire {l.openInventory}</Badge> : l.isActive ? <Badge tone="green">Actif</Badge> : <Badge>Archivé</Badge>}</Td>
              <Td className="text-right">
                {can('stock.adjust') && !l.isDefault && (
                  <Button variant="ghost" onClick={() => toggle.mutate(l)}>
                    {l.isActive ? 'Archiver' : 'Réactiver'}
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {can('stock.adjust') && (
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => (e.preventDefault(), create.mutate())}>
          <Input className="max-w-[9rem]" required placeholder="FROID" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} />
          <Input className="max-w-xs" required placeholder="Chambre froide" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Button type="submit" variant="secondary" loading={create.isPending}>
            <Plus className="size-4" /> Ajouter
          </Button>
        </form>
      )}
    </Card>
  );
}

type Tab = 'stock' | 'movements' | 'losses' | 'adjustments' | 'locations';

export function StockPage() {
  const { establishment } = useEstablishment();
  const [tab, setTab] = useState<Tab>('stock');
  return (
    <>
      <PageHeader title="Stock" subtitle={establishment ? `${establishment.name} — lots, valeur, pertes et corrections` : undefined} />
      <RequireEstablishment>
        {(establishmentId) => (
          <>
            <Tabs<Tab>
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'stock', label: 'État du stock' },
                { id: 'movements', label: 'Mouvements' },
                { id: 'losses', label: 'Pertes' },
                { id: 'adjustments', label: 'Corrections' },
                { id: 'locations', label: 'Emplacements' },
              ]}
            />
            {tab === 'stock' && <StockTab establishmentId={establishmentId} />}
            {tab === 'movements' && <MovementsTab establishmentId={establishmentId} />}
            {tab === 'losses' && <LossesTab establishmentId={establishmentId} />}
            {tab === 'adjustments' && <AdjustmentsTab establishmentId={establishmentId} />}
            {tab === 'locations' && <LocationsTab establishmentId={establishmentId} />}
          </>
        )}
      </RequireEstablishment>
    </>
  );
}
