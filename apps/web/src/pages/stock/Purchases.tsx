import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { qty, Supplier, SupplierOffer } from '../../lib/catalog-types';
import { formatDate, formatDateTime, formatXOF } from '../../lib/format';
import { LotRow, PO_STATUS, REQUEST_STATUS, unitLabel } from '../../lib/stock-types';
import { itemPayload, ItemSelect, LocationSelect, PickableItem, RequireEstablishment, RequirePermission, StatusBadge, Tabs, useEstablishment, useReasonDialog, useRequestId, useStockItems, useSuppliers } from './shared';

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all(['purchase-requests', 'purchase-orders', 'goods-receipts', 'supplier-returns', 'stock', 'supplier-invoices', 'supplier-account'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

interface RequestRec {
  id: string;
  number: string;
  status: string;
  neededBy: string | null;
  notes: string | null;
  createdAt: string;
  requestedBy: string | null;
  requestedById: string;
  decisionNote: string | null;
  purchaseOrder: { id: string; number: string } | null;
  items: { id: string; quantity: string; note: string | null; item: { name: string; unit: string } | null }[];
}

interface OrderItemRec {
  id: string;
  rawMaterialId: string | null;
  productId: string | null;
  purchaseUnitLabel: string;
  quantityPerPurchaseUnit: string;
  orderedQuantity: string;
  receivedQuantity: string;
  remainingQuantity: string;
  unitPrice: string;
  discountAmount: string;
  lineTotal: string;
  item: { id: string; code: string; name: string; unit: string } | null;
}

interface OrderRec {
  id: string;
  number: string;
  status: string;
  supplierId: string;
  supplier: { id: string; code: string; name: string } | null;
  orderDate: string;
  expectedDate: string | null;
  subtotal: string;
  discountAmount: string;
  total: string;
  notes: string | null;
  createdBy?: string | null;
  validatedBy?: string | null;
  closeReason: string | null;
  items?: OrderItemRec[];
  receipts?: { id: string; number: string; receivedAt: string; totalValue: string }[];
  requests?: { id: string; number: string }[];
}

// --- Demandes d'achat --------------------------------------------------------------

function RequestForm({ establishmentId, onDone }: { establishmentId: string; onDone: () => void }) {
  const requestId = useRequestId();
  const qc = useQueryClient();
  const { items } = useStockItems({ purchasable: true });
  const [lines, setLines] = useState<{ item: PickableItem | null; quantity: string }[]>([{ item: null, quantity: '' }]);
  const [f, setF] = useState({ neededBy: '', notes: '' });
  const save = useMutation({
    mutationFn: () =>
      api.post('/purchase-requests', {
        clientRequestId: requestId,
        establishmentId,
        neededBy: f.neededBy || undefined,
        notes: f.notes || null,
        items: lines.filter((l) => l.item).map((l) => ({ ...itemPayload(l.item), quantity: Number(l.quantity) })),
      }),
    onSuccess: async () => {
      await invalidate(qc);
      onDone();
    },
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
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
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Besoin pour le">
          <Input type="date" value={f.neededBy} onChange={(e) => setF({ ...f, neededBy: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Envoyer la demande
        </Button>
      </div>
    </form>
  );
}

function RequestsTab({ establishmentId }: { establishmentId: string }) {
  const qc = useQueryClient();
  const { can } = useEstablishment();
  const { me } = useAuth();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['purchase-requests', establishmentId], queryFn: () => api.get<RequestRec[]>(`/purchase-requests?establishmentId=${establishmentId}`) });
  const reason = useReasonDialog();
  const decide = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: 'reject' | 'cancel'; reason: string }) => api.post(`/purchase-requests/${id}/${action}`, { reason }),
    onSuccess: () => invalidate(qc),
  });
  const ask = (id: string, action: 'reject' | 'cancel') =>
    reason.ask(action === 'reject' ? 'Motif du refus' : 'Motif de l’annulation', (r) => decide.mutate({ id, action, reason: r }));
  return (
    <Card
      title="Demandes d’achat"
      actions={
        can('stock.view') && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Nouvelle demande
          </Button>
        )
      }
    >
      {decide.error && <Alert>{(decide.error as ApiError).message}</Alert>}
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['N°', 'Date', 'Articles', 'Besoin', 'Demandeur', 'Statut', '']} empty={data?.length === 0}>
          {data?.map((r) => (
            <tr key={r.id}>
              <Td className="font-mono text-xs">{r.number}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(r.createdAt)}</Td>
              <Td>
                {r.items.map((i) => (
                  <div key={i.id}>
                    {qty(i.quantity)} {unitLabel(i.item?.unit)} {i.item?.name}
                  </div>
                ))}
              </Td>
              <Td>{formatDate(r.neededBy)}</Td>
              <Td>{r.requestedBy}</Td>
              <Td>
                <StatusBadge map={REQUEST_STATUS} status={r.status} />
                {r.purchaseOrder && <div className="text-xs text-stone-500">{r.purchaseOrder.number}</div>}
                {r.decisionNote && <div className="text-xs text-stone-500">{r.decisionNote}</div>}
              </Td>
              <Td className="whitespace-nowrap">
                {r.status === 'OPEN' && (
                  <>
                    {can('purchases.manage') && (
                      <Button variant="ghost" onClick={() => ask(r.id, 'reject')}>
                        Refuser
                      </Button>
                    )}
                    {(can('purchases.manage') || r.requestedById === me?.id) && (
                      <Button variant="ghost" onClick={() => ask(r.id, 'cancel')}>
                        Annuler
                      </Button>
                    )}
                  </>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {reason.dialog}
      <Modal open={creating} onClose={() => setCreating(false)} title="Nouvelle demande d’achat" wide>
        {creating && <RequestForm establishmentId={establishmentId} onDone={() => setCreating(false)} />}
      </Modal>
    </Card>
  );
}

// --- Commandes fournisseurs ----------------------------------------------------------

interface OrderLine {
  offerId: string;
  item: PickableItem | null;
  purchaseUnitLabel: string;
  quantityPerPurchaseUnit: string;
  orderedQuantity: string;
  unitPrice: string;
  discountAmount: string;
}

const emptyLine: OrderLine = { offerId: '', item: null, purchaseUnitLabel: '', quantityPerPurchaseUnit: '', orderedQuantity: '', unitPrice: '', discountAmount: '' };

function OrderForm({ establishmentId, initial, onDone }: { establishmentId: string; initial?: OrderRec; onDone: (o: OrderRec) => void }) {
  const requestId = useRequestId();
  const qc = useQueryClient();
  const suppliers = useSuppliers();
  const { items } = useStockItems({ purchasable: true });
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? '');
  const supplier = useQuery({ queryKey: ['suppliers', supplierId], queryFn: () => api.get<Supplier>(`/suppliers/${supplierId}`), enabled: !!supplierId });
  const offers = (supplier.data?.products ?? []).filter((o) => o.isActive);
  const requests = useQuery({ queryKey: ['purchase-requests', establishmentId, 'open'], queryFn: () => api.get<RequestRec[]>(`/purchase-requests?establishmentId=${establishmentId}&status=OPEN`), enabled: !initial });
  const [requestIds, setRequestIds] = useState<string[]>([]);
  const [lines, setLines] = useState<OrderLine[]>(
    initial?.items?.map((i) => ({
      offerId: '',
      item: items.find((x) => x.rawMaterialId === i.rawMaterialId && x.productId === i.productId) ?? null,
      purchaseUnitLabel: i.purchaseUnitLabel,
      quantityPerPurchaseUnit: String(Number(i.quantityPerPurchaseUnit)),
      orderedQuantity: String(Number(i.orderedQuantity)),
      unitPrice: i.unitPrice,
      discountAmount: i.discountAmount === '0' ? '' : i.discountAmount,
    })) ?? [{ ...emptyLine }],
  );
  const [f, setF] = useState({ expectedDate: initial?.expectedDate?.slice(0, 10) ?? '', notes: initial?.notes ?? '', discountAmount: initial && initial.discountAmount !== '0' ? initial.discountAmount : '' });
  const setLine = (i: number, patch: Partial<OrderLine>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const lineTotal = (l: OrderLine) => Math.max(0, Math.round(Number(l.orderedQuantity || 0) * Number(l.unitPrice || 0)) - Number(l.discountAmount || 0));
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);

  const save = useMutation({
    mutationFn: () => {
      const payloadItems = lines
        .filter((l) => l.offerId || l.item)
        .map((l) => ({
          ...(l.offerId ? { supplierProductId: l.offerId } : itemPayload(l.item)),
          purchaseUnitLabel: l.purchaseUnitLabel || undefined,
          quantityPerPurchaseUnit: l.quantityPerPurchaseUnit ? Number(l.quantityPerPurchaseUnit) : undefined,
          orderedQuantity: Number(l.orderedQuantity),
          unitPrice: l.unitPrice !== '' ? Number(l.unitPrice) : undefined,
          discountAmount: l.discountAmount ? Number(l.discountAmount) : undefined,
        }));
      const body = { expectedDate: f.expectedDate || null, notes: f.notes || null, discountAmount: Number(f.discountAmount || 0), items: payloadItems };
      return initial ? api.patch<OrderRec>(`/purchase-orders/${initial.id}`, body) : api.post<OrderRec>('/purchase-orders', { ...body, clientRequestId: requestId, establishmentId, supplierId, requestIds });
    },
    onSuccess: async (o) => {
      await invalidate(qc);
      onDone(o);
    },
  });

  return (
    <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Fournisseur">
          <Select required disabled={!!initial} value={supplierId} onChange={(e) => (setSupplierId(e.target.value), setLines([{ ...emptyLine }]))}>
            <option value="">—</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} — {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Livraison prévue le">
          <Input type="date" value={f.expectedDate} onChange={(e) => setF({ ...f, expectedDate: e.target.value })} />
        </Field>
        <Field label="Remise globale (FCFA)">
          <Input type="number" min="0" step="1" value={f.discountAmount} onChange={(e) => setF({ ...f, discountAmount: e.target.value })} />
        </Field>
      </div>

      {supplierId && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-stone-700">Lignes (en unités d’achat)</div>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-stone-200 p-2 sm:grid-cols-6">
              <div className="col-span-2 sm:col-span-2">
                <Select
                  value={l.offerId || (l.item ? `item:${l.item.key}` : '')}
                  onChange={(e) => {
                    const v = e.target.value;
                    const offer = offers.find((o) => o.id === v);
                    if (offer) {
                      setLine(i, { offerId: offer.id, item: null, purchaseUnitLabel: offer.purchaseUnitLabel, quantityPerPurchaseUnit: String(Number(offer.quantityPerPurchaseUnit)), unitPrice: offer.unitPrice ?? '' });
                    } else setLine(i, { offerId: '', item: items.find((x) => `item:${x.key}` === v) ?? null });
                  }}
                >
                  <option value="">— Offre du fournisseur ou article —</option>
                  <optgroup label="Offres de ce fournisseur">
                    {offers.map((o: SupplierOffer) => (
                      <option key={o.id} value={o.id}>
                        {(o.rawMaterial ?? o.product)?.name} — {o.brand ? `${o.brand}, ` : ''}
                        {o.purchaseUnitLabel}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Autre article (saisie libre)">
                    {items.map((x) => (
                      <option key={x.key} value={`item:${x.key}`}>
                        {x.code} — {x.name}
                      </option>
                    ))}
                  </optgroup>
                </Select>
              </div>
              <Input placeholder="Unité d’achat" required value={l.purchaseUnitLabel} onChange={(e) => setLine(i, { purchaseUnitLabel: e.target.value })} />
              <Input placeholder={`Contenu (${unitLabel(l.item?.unit) || 'base'})`} required type="number" min="0" step="any" value={l.quantityPerPurchaseUnit} onChange={(e) => setLine(i, { quantityPerPurchaseUnit: e.target.value })} />
              <Input placeholder="Quantité" required type="number" min="0" step="any" value={l.orderedQuantity} onChange={(e) => setLine(i, { orderedQuantity: e.target.value })} />
              <Input placeholder="Prix unitaire" required type="number" min="0" step="1" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
              <Input placeholder="Remise ligne" type="number" min="0" step="1" value={l.discountAmount} onChange={(e) => setLine(i, { discountAmount: e.target.value })} />
              <div className="col-span-2 flex items-center justify-between text-sm sm:col-span-5">
                <span className="font-semibold">{formatXOF(lineTotal(l))}</span>
                <Button type="button" variant="ghost" aria-label="Retirer" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" variant="secondary" onClick={() => setLines([...lines, { ...emptyLine }])}>
            <Plus className="size-4" /> Ligne
          </Button>
          <div className="text-right text-sm">
            Sous-total {formatXOF(subtotal)} · Remise {formatXOF(Number(f.discountAmount || 0))} ·{' '}
            <strong className="text-base">Total {formatXOF(Math.max(0, subtotal - Number(f.discountAmount || 0)))}</strong>
          </div>
        </div>
      )}

      {!initial && !!requests.data?.length && (
        <div className="space-y-1">
          <div className="text-sm font-medium text-stone-700">Demandes d’achat couvertes</div>
          {requests.data.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={requestIds.includes(r.id)} onChange={(e) => setRequestIds(e.target.checked ? [...requestIds, r.id] : requestIds.filter((x) => x !== r.id))} />
              {r.number} — {r.items.map((i) => `${qty(i.quantity)} ${unitLabel(i.item?.unit)} ${i.item?.name}`).join(', ')}
            </label>
          ))}
        </div>
      )}
      <Field label="Notes">
        <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending} disabled={!supplierId}>
          {initial ? 'Enregistrer' : 'Créer le brouillon'}
        </Button>
      </div>
    </form>
  );
}

function OrderDetail({ establishmentId, id }: { establishmentId: string; id: string }) {
  const qc = useQueryClient();
  const { can } = useEstablishment();
  const [mode, setMode] = useState<'view' | 'edit' | 'receive'>('view');
  const { data: o, isLoading } = useQuery({ queryKey: ['purchase-orders', id], queryFn: () => api.get<OrderRec>(`/purchase-orders/${id}`) });
  const act = useMutation({
    mutationFn: ({ action, reason }: { action: string; reason?: string }) => api.post(`/purchase-orders/${id}/${action}`, reason ? { reason } : undefined),
    onSuccess: () => invalidate(qc),
  });
  const reasonDialog = useReasonDialog();
  const withReason = (action: string, question: string) => reasonDialog.ask(question, (reason) => act.mutate({ action, reason }));
  if (isLoading || !o) return <Spinner />;
  if (mode === 'edit') return <OrderForm establishmentId={establishmentId} initial={o} onDone={() => setMode('view')} />;
  if (mode === 'receive') return <ReceiptForm establishmentId={establishmentId} order={o} onDone={() => setMode('view')} />;
  const manage = can('purchases.manage');

  return (
    <div className="space-y-4">
      {reasonDialog.dialog}
      {act.error && <Alert>{(act.error as ApiError).message}</Alert>}
      <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
        <div className="space-y-1">
          <div>
            <StatusBadge map={PO_STATUS} status={o.status} /> {o.supplier?.name} · commandée le {formatDate(o.orderDate)}
            {o.expectedDate && ` · livraison prévue le ${formatDate(o.expectedDate)}`}
          </div>
          <div className="text-stone-500">
            Créée par {o.createdBy}
            {o.validatedBy && ` · validée par ${o.validatedBy}`}
            {o.requests?.length ? ` · demandes ${o.requests.map((r) => r.number).join(', ')}` : ''}
          </div>
          {o.closeReason && <div className="text-stone-500">Motif : {o.closeReason}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {o.status === 'DRAFT' && manage && (
            <>
              <Button variant="secondary" onClick={() => setMode('edit')}>
                Modifier
              </Button>
              <Button loading={act.isPending} onClick={() => act.mutate({ action: 'validate' })}>
                Valider
              </Button>
            </>
          )}
          {['VALIDATED', 'PARTIALLY_RECEIVED'].includes(o.status) && can('purchases.receive') && <Button onClick={() => setMode('receive')}>Réceptionner</Button>}
          {['DRAFT', 'VALIDATED'].includes(o.status) && manage && (
            <Button variant="danger" onClick={() => withReason('cancel', 'Motif de l’annulation')}>
              Annuler
            </Button>
          )}
          {o.status === 'PARTIALLY_RECEIVED' && manage && (
            <Button variant="secondary" onClick={() => withReason('close', 'Motif de clôture (reliquat non livré)')}>
              Clôturer
            </Button>
          )}
        </div>
      </div>
      <Table head={['Article', 'Unité d’achat', 'Commandé', 'Reçu', 'Reste', 'Prix', 'Total']}>
        {o.items?.map((i) => (
          <tr key={i.id}>
            <Td>{i.item?.name}</Td>
            <Td>
              {i.purchaseUnitLabel} ({qty(i.quantityPerPurchaseUnit)} {unitLabel(i.item?.unit)})
            </Td>
            <Td>{qty(i.orderedQuantity)}</Td>
            <Td>{qty(i.receivedQuantity)}</Td>
            <Td>{Number(i.remainingQuantity) > 0 ? <Badge tone="orange">{qty(i.remainingQuantity)}</Badge> : '—'}</Td>
            <Td className="whitespace-nowrap">{formatXOF(i.unitPrice)}</Td>
            <Td className="whitespace-nowrap">{formatXOF(i.lineTotal)}</Td>
          </tr>
        ))}
      </Table>
      <div className="text-right text-sm">
        Sous-total {formatXOF(o.subtotal)} · remise {formatXOF(o.discountAmount)} · <strong>Total {formatXOF(o.total)}</strong>
      </div>
      {!!o.receipts?.length && (
        <div className="text-sm">
          <h3 className="font-semibold">Réceptions</h3>
          {o.receipts.map((r) => (
            <div key={r.id}>
              {r.number} — {formatDateTime(r.receivedAt)} — {formatXOF(r.totalValue)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OrdersTab({ establishmentId }: { establishmentId: string }) {
  const { can } = useEstablishment();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['purchase-orders', establishmentId, status],
    queryFn: () => api.get<OrderRec[]>(`/purchase-orders?establishmentId=${establishmentId}${status ? `&status=${status}` : ''}`),
  });
  const opened = data?.find((o) => o.id === openId);
  return (
    <Card
      title="Commandes fournisseurs"
      actions={
        can('purchases.manage') && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Nouvelle commande
          </Button>
        )
      }
    >
      <Select className="mb-3 max-w-[14rem]" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">Tous les statuts</option>
        {Object.entries(PO_STATUS).map(([k, v]) => (
          <option key={k} value={k}>
            {v.label}
          </option>
        ))}
      </Select>
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['N°', 'Date', 'Fournisseur', 'Total', 'Statut', '']} empty={data?.length === 0}>
          {data?.map((o) => (
            <tr key={o.id} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpenId(o.id)}>
              <Td className="font-mono text-xs">{o.number}</Td>
              <Td>{formatDate(o.orderDate)}</Td>
              <Td>{o.supplier?.name}</Td>
              <Td className="whitespace-nowrap">{formatXOF(o.total)}</Td>
              <Td>
                <StatusBadge map={PO_STATUS} status={o.status} />
              </Td>
              <Td className="text-right text-brand-700">Voir</Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Nouvelle commande fournisseur" wide>
        {creating && (
          <OrderForm
            establishmentId={establishmentId}
            onDone={(o) => {
              setCreating(false);
              setOpenId(o.id);
            }}
          />
        )}
      </Modal>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title={opened ? `Commande ${opened.number}` : 'Commande'} wide>
        {openId && <OrderDetail key={openId} establishmentId={establishmentId} id={openId} />}
      </Modal>
    </Card>
  );
}

// --- Réceptions ----------------------------------------------------------------

interface ReceiptLine {
  orderItemId?: string;
  item: PickableItem | null;
  label: string;
  purchaseUnitLabel: string;
  quantityPerPurchaseUnit: string;
  receivedQuantity: string;
  rejectedQuantity: string;
  rejectionReason: string;
  unitPrice: string;
  orderedUnitPrice?: string;
  remaining?: number;
  varianceReason: string;
  brand: string;
  supplierLotRef: string;
  productionDate: string;
  expiryDate: string;
}

function ReceiptForm({ establishmentId, order, onDone }: { establishmentId: string; order?: OrderRec; onDone: () => void }) {
  const requestId = useRequestId();
  const qc = useQueryClient();
  const suppliers = useSuppliers();
  const { items } = useStockItems({ purchasable: true });
  const [supplierId, setSupplierId] = useState(order?.supplierId ?? '');
  const [locationId, setLocationId] = useState('');
  const [docRef, setDocRef] = useState('');
  const blank = (): ReceiptLine => ({ item: null, label: '', purchaseUnitLabel: '', quantityPerPurchaseUnit: '', receivedQuantity: '', rejectedQuantity: '', rejectionReason: '', unitPrice: '', varianceReason: '', brand: '', supplierLotRef: '', productionDate: '', expiryDate: '' });
  const [lines, setLines] = useState<ReceiptLine[]>(() =>
    order?.items
      ? order.items
          .filter((i) => Number(i.remainingQuantity) > 0)
          .map((i) => ({
            ...blank(),
            orderItemId: i.id,
            label: `${i.item?.name} — ${i.purchaseUnitLabel}`,
            item: { key: '', rawMaterialId: i.rawMaterialId, productId: i.productId, code: i.item?.code ?? '', name: i.item?.name ?? '', unit: i.item?.unit ?? '', isPerishable: false },
            receivedQuantity: String(Number(i.remainingQuantity)),
            unitPrice: i.unitPrice,
            orderedUnitPrice: i.unitPrice,
            remaining: Number(i.remainingQuantity),
          }))
      : [blank()],
  );
  const setLine = (i: number, patch: Partial<ReceiptLine>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const perishable = (l: ReceiptLine) => !!items.find((x) => x.rawMaterialId && x.rawMaterialId === l.item?.rawMaterialId)?.isPerishable;
  const total = lines.reduce((s, l) => s + Math.round((Number(l.receivedQuantity || 0) - Number(l.rejectedQuantity || 0)) * Number(l.unitPrice || 0)), 0);

  const save = useMutation({
    mutationFn: () =>
      api.post('/goods-receipts', {
        clientRequestId: requestId,
        establishmentId,
        supplierId,
        purchaseOrderId: order?.id,
        locationId: locationId || undefined,
        supplierDocumentRef: docRef || null,
        items: lines
          .filter((l) => Number(l.receivedQuantity) > 0)
          .map((l) => ({
            ...(l.orderItemId ? { orderItemId: l.orderItemId } : { ...itemPayload(l.item), purchaseUnitLabel: l.purchaseUnitLabel, quantityPerPurchaseUnit: Number(l.quantityPerPurchaseUnit) }),
            receivedQuantity: Number(l.receivedQuantity),
            rejectedQuantity: l.rejectedQuantity ? Number(l.rejectedQuantity) : undefined,
            rejectionReason: l.rejectionReason || null,
            unitPrice: Number(l.unitPrice),
            varianceReason: l.varianceReason || null,
            brand: l.brand || null,
            supplierLotRef: l.supplierLotRef || null,
            productionDate: l.productionDate || null,
            expiryDate: l.expiryDate || null,
          })),
      }),
    onSuccess: async () => {
      await invalidate(qc);
      onDone();
    },
  });

  return (
    <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Fournisseur">
          <Select required disabled={!!order} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">—</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} — {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="N° bon de livraison">
          <Input value={docRef} onChange={(e) => setDocRef(e.target.value)} />
        </Field>
        <Field label="Emplacement de stockage">
          <LocationSelect establishmentId={establishmentId} value={locationId} onChange={setLocationId} />
        </Field>
      </div>
      {!order && <Alert tone="info">Réception directe (sans commande) : elle est tracée comme telle.</Alert>}
      {lines.map((l, i) => {
        const priceGap = l.orderedUnitPrice !== undefined && l.unitPrice !== l.orderedUnitPrice;
        const overQty = l.remaining !== undefined && Number(l.receivedQuantity || 0) - Number(l.rejectedQuantity || 0) > l.remaining;
        return (
          <div key={i} className="space-y-2 rounded-lg border border-stone-200 p-3">
            {l.orderItemId ? (
              <div className="text-sm font-semibold">
                {l.label} <span className="font-normal text-stone-500">· reste {qty(l.remaining)}</span>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-3">
                <ItemSelect required items={items} value={l.item?.key ?? ''} onChange={(item) => setLine(i, { item })} />
                <Input required placeholder="Unité d’achat (Sac 25 kg)" value={l.purchaseUnitLabel} onChange={(e) => setLine(i, { purchaseUnitLabel: e.target.value })} />
                <Input required type="number" min="0" step="any" placeholder={`Contenu (${unitLabel(l.item?.unit) || 'base'})`} value={l.quantityPerPurchaseUnit} onChange={(e) => setLine(i, { quantityPerPurchaseUnit: e.target.value })} />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label="Reçu">
                <Input required type="number" min="0" step="any" value={l.receivedQuantity} onChange={(e) => setLine(i, { receivedQuantity: e.target.value })} />
              </Field>
              <Field label="Refusé au contrôle">
                <Input type="number" min="0" step="any" value={l.rejectedQuantity} onChange={(e) => setLine(i, { rejectedQuantity: e.target.value })} />
              </Field>
              <Field label="Prix unitaire (FCFA)">
                <Input required type="number" min="0" step="1" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
              </Field>
              <Field label={perishable(l) ? 'Date d’expiration *' : 'Date d’expiration'}>
                <Input required={perishable(l)} type="date" value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} />
              </Field>
              <Field label="Marque">
                <Input value={l.brand} onChange={(e) => setLine(i, { brand: e.target.value })} />
              </Field>
              <Field label="N° lot fournisseur">
                <Input value={l.supplierLotRef} onChange={(e) => setLine(i, { supplierLotRef: e.target.value })} />
              </Field>
              <Field label="Date de production">
                <Input type="date" value={l.productionDate} onChange={(e) => setLine(i, { productionDate: e.target.value })} />
              </Field>
              {Number(l.rejectedQuantity) > 0 && (
                <div className="col-span-2">
                  <Field label="Motif du refus *">
                    <Input required value={l.rejectionReason} onChange={(e) => setLine(i, { rejectionReason: e.target.value })} />
                  </Field>
                </div>
              )}
              {(priceGap || overQty) && (
                <div className="col-span-2">
                  <Field label={`Motif de l’écart * (${overQty ? 'quantité supérieure à la commande' : 'prix différent de la commande'})`}>
                    <Input required value={l.varianceReason} onChange={(e) => setLine(i, { varianceReason: e.target.value })} />
                  </Field>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {!order && (
        <Button type="button" variant="secondary" onClick={() => setLines([...lines, blank()])}>
          <Plus className="size-4" /> Article
        </Button>
      )}
      <div className="flex items-center justify-between">
        <span className="text-sm">
          Valeur acceptée : <strong>{formatXOF(total)}</strong>
        </span>
        <Button type="submit" loading={save.isPending} disabled={!supplierId}>
          Valider la réception
        </Button>
      </div>
    </form>
  );
}

interface ReceiptRec {
  id: string;
  number: string;
  receivedAt: string;
  totalValue: string;
  supplierDocumentRef: string | null;
  supplier: { name: string } | null;
  purchaseOrder: { number: string } | null;
  invoice: { number: string } | null;
}

interface ReceiptDetailRec {
  number: string;
  receivedAt: string;
  totalValue: string;
  receivedBy: string | null;
  location: { name: string } | null;
  items: {
    id: string;
    purchaseUnitLabel: string;
    receivedQuantity: string;
    rejectedQuantity: string;
    acceptedQuantity: string;
    rejectionReason: string | null;
    varianceReason: string | null;
    unitPrice: string;
    lineValue: string;
    brand: string | null;
    expiryDate: string | null;
    item: { name: string } | null;
    lot: { lotNumber: string; unitCost: string } | null;
  }[];
}

function ReceiptDetail({ id }: { id: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['goods-receipts', id], queryFn: () => api.get<ReceiptDetailRec>(`/goods-receipts/${id}`) });
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="space-y-3">
      <div className="text-sm text-stone-600">
        Reçue le {formatDateTime(data.receivedAt)} par {data.receivedBy} · {data.location?.name}
      </div>
      <Table head={['Article', 'Reçu', 'Refusé', 'Accepté', 'Prix', 'Valeur', 'Lot', 'Péremption']}>
        {data.items.map((i) => (
          <tr key={i.id}>
            <Td>
              {i.item?.name}
              {i.brand && <div className="text-xs text-stone-500">{i.brand}</div>}
              {i.varianceReason && <div className="text-xs text-orange-700">Écart : {i.varianceReason}</div>}
            </Td>
            <Td>
              {qty(i.receivedQuantity)} × {i.purchaseUnitLabel}
            </Td>
            <Td>{Number(i.rejectedQuantity) > 0 ? <span title={i.rejectionReason ?? ''}>{qty(i.rejectedQuantity)}</span> : '—'}</Td>
            <Td>{qty(i.acceptedQuantity)}</Td>
            <Td className="whitespace-nowrap">{formatXOF(i.unitPrice)}</Td>
            <Td className="whitespace-nowrap">{formatXOF(i.lineValue)}</Td>
            <Td className="font-mono text-xs">{i.lot?.lotNumber ?? '—'}</Td>
            <Td>{formatDate(i.expiryDate)}</Td>
          </tr>
        ))}
      </Table>
      <div className="text-right text-sm font-semibold">Total {formatXOF(data.totalValue)}</div>
    </div>
  );
}

function ReceiptsTab({ establishmentId }: { establishmentId: string }) {
  const { can } = useEstablishment();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['goods-receipts', establishmentId], queryFn: () => api.get<ReceiptRec[]>(`/goods-receipts?establishmentId=${establishmentId}`) });
  const opened = data?.find((r) => r.id === openId);
  return (
    <Card
      title="Réceptions"
      actions={
        can('purchases.receive') && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Réception directe
          </Button>
        )
      }
    >
      <p className="mb-2 text-xs text-stone-500">Pour réceptionner une commande, ouvrez-la dans l’onglet « Commandes ».</p>
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['N°', 'Date', 'Fournisseur', 'Commande', 'BL', 'Valeur', 'Facture']} empty={data?.length === 0}>
          {data?.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpenId(r.id)}>
              <Td className="font-mono text-xs">{r.number}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(r.receivedAt)}</Td>
              <Td>{r.supplier?.name}</Td>
              <Td>{r.purchaseOrder?.number ?? <Badge>Directe</Badge>}</Td>
              <Td>{r.supplierDocumentRef ?? '—'}</Td>
              <Td className="whitespace-nowrap">{formatXOF(r.totalValue)}</Td>
              <Td>{r.invoice ? r.invoice.number : <Badge tone="orange">Non facturée</Badge>}</Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Réception directe (sans commande)" wide>
        {creating && <ReceiptForm establishmentId={establishmentId} onDone={() => setCreating(false)} />}
      </Modal>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title={opened ? `Réception ${opened.number}` : 'Réception'} wide>
        {openId && <ReceiptDetail id={openId} />}
      </Modal>
    </Card>
  );
}

// --- Retours fournisseurs ----------------------------------------------------------

function ReturnForm({ establishmentId, onDone }: { establishmentId: string; onDone: () => void }) {
  const requestId = useRequestId();
  const qc = useQueryClient();
  const suppliers = useSuppliers();
  const { items } = useStockItems({ purchasable: true });
  const [supplierId, setSupplierId] = useState('');
  const [item, setItem] = useState<PickableItem | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const param = item ? (item.rawMaterialId ? `rawMaterialId=${item.rawMaterialId}` : `productId=${item.productId}`) : '';
  const lots = useQuery({ queryKey: ['stock', 'item', establishmentId, param], queryFn: () => api.get<{ lots: LotRow[] }>(`/stock/item?${param}&establishmentId=${establishmentId}`), enabled: !!item });
  const supplierLots = (lots.data?.lots ?? []).filter((l) => l.supplier?.id === supplierId);
  const account = useQuery({ queryKey: ['supplier-account', supplierId], queryFn: () => api.get<{ openInvoices: { id: string; number: string; remaining: string }[] }>(`/suppliers/${supplierId}/account`), enabled: !!supplierId });
  // Un retour sort d'un seul emplacement : celui du premier lot choisi.
  const chosen = supplierLots.filter((l) => Number(quantities[l.balanceId] || 0) > 0);
  const locationId = chosen[0]?.location.id;
  const save = useMutation({
    mutationFn: () =>
      api.post('/supplier-returns', {
        clientRequestId: requestId,
        establishmentId,
        supplierId,
        locationId,
        reason,
        invoiceId: invoiceId || undefined,
        items: chosen.map((l) => ({ lotId: l.lotId, quantity: Number(quantities[l.balanceId]) })),
      }),
    onSuccess: async () => {
      await invalidate(qc);
      onDone();
    },
  });
  const mixedLocations = new Set(chosen.map((l) => l.location.id)).size > 1;
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fournisseur">
          <Select required value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">—</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Article">
          <ItemSelect required items={items} value={item?.key ?? ''} onChange={setItem} />
        </Field>
      </div>
      {item && supplierId && (
        <Table head={['Lot', 'Emplacement', 'En stock', 'Coût', 'Quantité à retourner']} empty={supplierLots.length === 0}>
          {supplierLots.map((l) => (
            <tr key={l.balanceId}>
              <Td className="font-mono text-xs">{l.lotNumber}</Td>
              <Td>{l.location.name}</Td>
              <Td>
                {qty(l.quantity)} {unitLabel(item.unit)}
              </Td>
              <Td>{formatXOF(l.unitCost)}</Td>
              <Td>
                <Input className="w-28" type="number" min="0" step="any" value={quantities[l.balanceId] ?? ''} onChange={(e) => setQuantities({ ...quantities, [l.balanceId]: e.target.value })} />
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {mixedLocations && <Alert>Un retour ne peut porter que sur un seul emplacement.</Alert>}
      <Field label="Motif du retour *">
        <Input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Field label="Imputer l’avoir sur la facture" hint="Facultatif : sinon l’avoir réduit le solde du fournisseur.">
        <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
          <option value="">—</option>
          {account.data?.openInvoices.map((i) => (
            <option key={i.id} value={i.id}>
              {i.number} (reste {formatXOF(i.remaining)})
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending} disabled={!chosen.length || mixedLocations}>
          Retourner et créer l’avoir
        </Button>
      </div>
    </form>
  );
}

interface ReturnRec {
  id: string;
  number: string;
  createdAt: string;
  reason: string;
  totalValue: string;
  supplier: { name: string } | null;
  creditNote: { number: string; amount: string } | null;
}

function ReturnsTab({ establishmentId }: { establishmentId: string }) {
  const { can } = useEstablishment();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['supplier-returns', establishmentId], queryFn: () => api.get<ReturnRec[]>(`/supplier-returns?establishmentId=${establishmentId}`) });
  return (
    <Card
      title="Retours fournisseurs"
      actions={
        can('purchases.receive') && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Nouveau retour
          </Button>
        )
      }
    >
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['N°', 'Date', 'Fournisseur', 'Motif', 'Valeur', 'Avoir']} empty={data?.length === 0}>
          {data?.map((r) => (
            <tr key={r.id}>
              <Td className="font-mono text-xs">{r.number}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(r.createdAt)}</Td>
              <Td>{r.supplier?.name}</Td>
              <Td>{r.reason}</Td>
              <Td className="whitespace-nowrap">{formatXOF(r.totalValue)}</Td>
              <Td className="font-mono text-xs">{r.creditNote?.number}</Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Retour au fournisseur" wide>
        {creating && <ReturnForm establishmentId={establishmentId} onDone={() => setCreating(false)} />}
      </Modal>
    </Card>
  );
}

type Tab = 'orders' | 'receipts' | 'returns';

/** Achats : commandes, réceptions et retours (permission « Voir les achats »). */
export function PurchasesPage() {
  const { establishment } = useEstablishment();
  const [tab, setTab] = useState<Tab>('orders');
  const tabs = useMemo(
    () => [
      { id: 'orders' as const, label: 'Commandes' },
      { id: 'receipts' as const, label: 'Réceptions' },
      { id: 'returns' as const, label: 'Retours' },
    ],
    [],
  );
  return (
    <>
      <PageHeader title="Achats" subtitle={establishment ? `${establishment.name} — commandes, réceptions et retours` : undefined} />
      <RequireEstablishment>
        {(establishmentId) => (
          <RequirePermission permission="purchases.view">
            <Tabs<Tab> tabs={tabs} value={tab} onChange={setTab} />
            {tab === 'orders' && <OrdersTab establishmentId={establishmentId} />}
            {tab === 'receipts' && <ReceiptsTab establishmentId={establishmentId} />}
            {tab === 'returns' && <ReturnsTab establishmentId={establishmentId} />}
          </RequirePermission>
        )}
      </RequireEstablishment>
    </>
  );
}

/**
 * Demandes d'achat : ouvertes à quiconque voit le stock (magasinier, chef,
 * production…). Les achats voient toutes les demandes ; les autres, les leurs.
 */
export function PurchaseRequestsPage() {
  const { establishment } = useEstablishment();
  return (
    <>
      <PageHeader title="Demandes d’achat" subtitle={establishment ? `${establishment.name} — signaler un besoin aux achats` : undefined} />
      <RequireEstablishment>
        {(establishmentId) => (
          <RequirePermission permission={['stock.view', 'purchases.view']}>
            <RequestsTab establishmentId={establishmentId} />
          </RequirePermission>
        )}
      </RequireEstablishment>
    </>
  );
}
