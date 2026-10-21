import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { qty } from '../../lib/catalog-types';
import { formatDate, formatDateTime, formatXOF } from '../../lib/format';
import { PRODUCTION_STATUS, ProductionOrderRec, ProductionStatus, RecipeListRow } from '../../lib/production-types';
import { LOSS_CAUSES, unitLabel } from '../../lib/stock-types';
import { LocationSelect, RequireEstablishment, RequirePermission, StatusBadge, useEstablishment, useReasonDialog, useRequestId } from '../stock/shared';

const invalidate = (qc: ReturnType<typeof useQueryClient>) => Promise.all(['production-orders', 'stock', 'costing', 'movements'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
const money = (v: string | null | undefined) => (v == null ? '—' : formatXOF(Math.round(Number(v))));
const CAUSES = Object.entries(LOSS_CAUSES).filter(([k]) => k !== 'TRANSIT');

function CreateForm({ establishmentId, onDone }: { establishmentId: string; onDone: (o: ProductionOrderRec) => void }) {
  const qc = useQueryClient();
  const requestId = useRequestId();
  const recipes = useQuery({ queryKey: ['recipes', 'list'], queryFn: () => api.get<RecipeListRow[]>('/recipes') });
  const [f, setF] = useState({ productId: '', plannedQuantity: '', plannedDate: '', sourceLocationId: '', destLocationId: '', notes: '' });
  const producible = (recipes.data ?? []).filter((r) => r.activeVersion && r.product?.isActive);
  const chosen = producible.find((r) => r.product?.id === f.productId);
  const save = useMutation({
    mutationFn: () =>
      api.post<ProductionOrderRec>('/production-orders', {
        clientRequestId: requestId,
        establishmentId,
        productId: f.productId,
        plannedQuantity: Number(f.plannedQuantity),
        plannedDate: f.plannedDate || null,
        sourceLocationId: f.sourceLocationId || undefined,
        destLocationId: f.destLocationId || undefined,
        notes: f.notes || null,
      }),
    onSuccess: async (o) => {
      await invalidate(qc);
      onDone(o);
    },
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Field label="Produit (recette active)">
            <Select required value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}>
              <option value="">—</option>
              {producible.map((r) => (
                <option key={r.id} value={r.product!.id}>
                  {r.product!.code} — {r.product!.name} (v{r.activeVersion!.version}, rendement {qty(r.activeVersion!.yieldQuantity)})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={`Quantité à produire (${unitLabel(chosen?.product?.saleUnitCode) || 'unité'})`}>
          <Input required type="number" min="0" step="any" value={f.plannedQuantity} onChange={(e) => setF({ ...f, plannedQuantity: e.target.value })} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date prévue">
          <Input type="date" value={f.plannedDate} onChange={(e) => setF({ ...f, plannedDate: e.target.value })} />
        </Field>
        <Field label="Matières prises dans">
          <LocationSelect establishmentId={establishmentId} value={f.sourceLocationId} onChange={(sourceLocationId) => setF({ ...f, sourceLocationId })} />
        </Field>
        <Field label="Produits finis rangés dans">
          <LocationSelect establishmentId={establishmentId} value={f.destLocationId} onChange={(destLocationId) => setF({ ...f, destLocationId })} />
        </Field>
      </div>
      <Field label="Notes">
        <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
      <p className="text-xs text-stone-500">La version active de la recette est figée sur l’ordre. Les besoins sont calculés automatiquement.</p>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Planifier
        </Button>
      </div>
    </form>
  );
}

/** Fin de production : quantité produite, écarts de consommation, perte (décisions C et J). */
function CompleteForm({ order, onDone }: { order: ProductionOrderRec; onDone: () => void }) {
  const qc = useQueryClient();
  const unit = unitLabel(order.product?.saleUnitCode);
  const [produced, setProduced] = useState(String(Number(order.plannedQuantity)));
  const [loss, setLoss] = useState({ cause: 'BURNT', reason: '' });
  const [overReason, setOverReason] = useState('');
  const [adj, setAdj] = useState<Record<string, { mode: 'none' | 'extra' | 'return'; qty: string; reason: string }>>({});
  const planned = Number(order.plannedQuantity);
  const p = Number(produced || 0);
  const save = useMutation({
    mutationFn: () =>
      api.post(`/production-orders/${order.id}/complete`, {
        producedQuantity: p,
        ...(p < planned ? { lossCause: loss.cause, lossReason: loss.reason } : {}),
        ...(p > planned ? { overReason } : {}),
        adjustments: Object.entries(adj)
          .filter(([, a]) => a.mode !== 'none' && Number(a.qty) > 0)
          .map(([itemId, a]) => ({ itemId, reason: a.reason, ...(a.mode === 'extra' ? { extraQuantity: Number(a.qty) } : { returnedQuantity: Number(a.qty) }) })),
      }),
    onSuccess: async () => {
      await invalidate(qc);
      onDone();
    },
  });
  return (
    <form className="space-y-3 rounded-lg border border-stone-200 p-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <h3 className="font-semibold">Terminer la production</h3>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <Field label={`Quantité réellement produite (prévu : ${qty(order.plannedQuantity)} ${unit})`}>
        <Input required className="max-w-[10rem]" type="number" min="0" step="any" value={produced} onChange={(e) => setProduced(e.target.value)} />
      </Field>
      {p < planned && (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label={`Perte de ${qty(planned - p)} ${unit} — cause`}>
            <Select value={loss.cause} onChange={(e) => setLoss({ ...loss, cause: e.target.value })}>
              {CAUSES.map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Motif *">
              <Input required minLength={3} value={loss.reason} onChange={(e) => setLoss({ ...loss, reason: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
      {p > planned && (
        <Field label={`Surplus de ${qty(p - planned)} ${unit} — motif *`}>
          <Input required minLength={3} value={overReason} onChange={(e) => setOverReason(e.target.value)} />
        </Field>
      )}
      <div className="space-y-1">
        <div className="text-sm font-medium text-stone-700">Écarts de consommation (facultatif)</div>
        {order.items?.map((i) => {
          const a = adj[i.id] ?? { mode: 'none', qty: '', reason: '' };
          const set = (patch: Partial<typeof a>) => setAdj({ ...adj, [i.id]: { ...a, ...patch } });
          return (
            <div key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-48">
                {i.item?.name} <span className="text-stone-500">({qty(i.consumedQuantity)} {unitLabel(i.item?.unit)})</span>
              </span>
              <Select className="w-44" value={a.mode} onChange={(e) => set({ mode: e.target.value as typeof a.mode })}>
                <option value="none">Conforme à la recette</option>
                <option value="extra">Utilisé en plus</option>
                <option value="return">Reste rendu au stock</option>
              </Select>
              {a.mode !== 'none' && (
                <>
                  <Input className="w-24" required type="number" min="0" step="any" placeholder="Qté" value={a.qty} onChange={(e) => set({ qty: e.target.value })} />
                  <Input className="min-w-[12rem] flex-1" required minLength={3} placeholder="Motif *" value={a.reason} onChange={(e) => set({ reason: e.target.value })} />
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Terminer et entrer les produits en stock
        </Button>
      </div>
    </form>
  );
}

/** Contrôle qualité par un responsable autre que le producteur (décision E). */
function ControlForm({ order, onDone }: { order: ProductionOrderRec; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ nonConform: '', cause: 'QUALITY', reason: '', note: '' });
  const save = useMutation({
    mutationFn: () =>
      api.post(`/production-orders/${order.id}/control`, {
        note: f.note || null,
        ...(Number(f.nonConform) > 0 ? { nonConformQuantity: Number(f.nonConform), cause: f.cause, reason: f.reason } : {}),
      }),
    onSuccess: async () => {
      await invalidate(qc);
      onDone();
    },
  });
  return (
    <form className="space-y-3 rounded-lg border border-stone-200 p-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <h3 className="font-semibold">Contrôle qualité</h3>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label={`Quantité non conforme (${unitLabel(order.product?.saleUnitCode)})`}>
          <Input type="number" min="0" step="any" value={f.nonConform} onChange={(e) => setF({ ...f, nonConform: e.target.value })} placeholder="0" />
        </Field>
        {Number(f.nonConform) > 0 && (
          <>
            <Field label="Cause">
              <Select value={f.cause} onChange={(e) => setF({ ...f, cause: e.target.value })}>
                {CAUSES.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Motif *">
              <Input required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            </Field>
          </>
        )}
      </div>
      <Field label="Observation">
        <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Valider le contrôle
        </Button>
      </div>
    </form>
  );
}

function OrderDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { can } = useEstablishment();
  const { me } = useAuth();
  const reason = useReasonDialog();
  const [mode, setMode] = useState<'view' | 'complete' | 'control'>('view');
  const { data: o, isLoading } = useQuery({ queryKey: ['production-orders', id], queryFn: () => api.get<ProductionOrderRec>(`/production-orders/${id}`) });
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: object }) => api.post(`/production-orders/${id}/${action}`, body),
    onSuccess: () => invalidate(qc),
  });
  if (isLoading || !o) return <Spinner />;
  const manage = can('production.manage');
  const unit = unitLabel(o.product?.saleUnitCode);
  const canControl = can('inventory.validate') && o.completedById !== me?.id;

  return (
    <div className="space-y-4">
      {reason.dialog}
      {act.error && <Alert>{(act.error as ApiError).message}</Alert>}
      <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
        <div className="space-y-1">
          <div>
            <StatusBadge map={PRODUCTION_STATUS} status={o.status} /> <strong>{o.product?.name}</strong> · prévu {qty(o.plannedQuantity)} {unit}
            {o.producedQuantity !== null && ` · produit ${qty(o.producedQuantity)} ${unit}`} · recette v{o.version?.version}
          </div>
          <div className="text-stone-500">
            {o.sourceLocation?.name} → {o.destLocation?.name}
            {o.plannedDate && ` · prévu le ${formatDate(o.plannedDate)}`}
          </div>
          <div className="text-xs text-stone-500">
            {Object.entries(o.people ?? {})
              .filter(([, v]) => v)
              .map(([k, v]) => `${{ createdBy: 'planifié', validatedBy: 'validé', startedBy: 'lancé', completedBy: 'terminé', controlledBy: 'contrôlé', cancelledBy: 'annulé' }[k]} par ${v}`)
              .join(' · ')}
          </div>
          {o.cancelReason && <div className="text-xs text-stone-500">Annulation : {o.cancelReason}</div>}
          {o.overReason && <div className="text-xs text-stone-500">Surplus : {o.overReason}</div>}
          {o.controlNote && <div className="text-xs text-stone-500">Contrôle : {o.controlNote}</div>}
        </div>
        {mode === 'view' && (
          <div className="flex flex-wrap gap-2">
            {o.status === 'PLANNED' && manage && (
              <Button loading={act.isPending} onClick={() => act.mutate({ action: 'validate' })}>
                Valider (réserver les matières)
              </Button>
            )}
            {o.status === 'VALIDATED' && manage && (
              <Button loading={act.isPending} onClick={() => act.mutate({ action: 'start' })}>
                Lancer (sortir les matières)
              </Button>
            )}
            {o.status === 'IN_PROGRESS' && manage && <Button onClick={() => setMode('complete')}>Terminer</Button>}
            {o.status === 'COMPLETED' && canControl && <Button onClick={() => setMode('control')}>Contrôler</Button>}
            {['PLANNED', 'VALIDATED'].includes(o.status) && manage && (
              <Button variant="danger" onClick={() => reason.ask('Motif de l’annulation', (r) => act.mutate({ action: 'cancel', body: { reason: r } }))}>
                Annuler
              </Button>
            )}
          </div>
        )}
      </div>
      {o.status === 'COMPLETED' && can('inventory.validate') && o.completedById === me?.id && (
        <Alert tone="info">Vous avez terminé cette production : le contrôle doit être fait par un autre responsable.</Alert>
      )}
      {mode === 'complete' && <CompleteForm order={o} onDone={() => setMode('view')} />}
      {mode === 'control' && <ControlForm order={o} onDone={() => setMode('view')} />}

      <div className="space-y-2">
        <h3 className="font-semibold">Matières</h3>
        <Table head={['Ingrédient', 'Recette', 'Besoin théorique', 'Réservé', 'Consommé (net)']}>
          {o.items?.map((i) => (
            <tr key={i.id}>
              <Td>{i.item?.name}</Td>
              <Td className="whitespace-nowrap">
                {qty(i.recipeQuantity)} {unitLabel(i.recipeUnitCode)}
                {Number(i.lossPercent) > 0 && <span className="text-xs text-stone-500"> +{qty(i.lossPercent)} %</span>}
              </Td>
              <Td className="whitespace-nowrap font-semibold">
                {qty(i.theoreticalQuantity)} {unitLabel(i.item?.unit)}
              </Td>
              <Td>{Number(i.reserved) > 0 ? <Badge tone="blue">{qty(i.reserved)}</Badge> : '—'}</Td>
              <Td>{Number(i.consumedQuantity) > 0 ? qty(i.consumedQuantity) : '—'}</Td>
            </tr>
          ))}
        </Table>
      </div>

      {!!o.consumptions?.length && (
        <div className="space-y-2">
          <h3 className="font-semibold">Lots consommés</h3>
          <Table head={['Lot', 'Ingrédient', 'Type', 'Quantité', 'Coût', 'Valeur', 'Motif']}>
            {o.consumptions.map((c) => (
              <tr key={c.id}>
                <Td className="font-mono text-xs">
                  <Link className="text-brand-700 hover:underline" to={`/tracabilite?lot=${c.lotNumber}`}>
                    {c.lotNumber}
                  </Link>
                </Td>
                <Td>{o.items?.find((i) => i.id === c.itemId)?.item?.name}</Td>
                <Td>{c.kind === 'THEORETICAL' ? 'Recette' : c.kind === 'EXTRA' ? 'Supplément' : 'Reste rendu'}</Td>
                <Td className={Number(c.quantity) < 0 ? 'text-green-700' : ''}>{qty(c.quantity)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(Math.round(Number(c.unitCost) * 100) / 100)}</Td>
                <Td className="whitespace-nowrap">{money(c.value)}</Td>
                <Td className="text-stone-500">{c.reason ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-lg bg-stone-50 p-3">
          <div className="text-stone-500">Coût théorique</div>
          <div className="text-lg font-bold">{money(o.theoreticalCost)}</div>
        </div>
        <div className="rounded-lg bg-stone-50 p-3">
          <div className="text-stone-500">Coût réel</div>
          <div className="text-lg font-bold">{money(o.realCost)}</div>
        </div>
        <div className="rounded-lg bg-stone-50 p-3">
          <div className="text-stone-500">Coût unitaire réel</div>
          <div className="text-lg font-bold">{o.unitCost ? `${formatXOF(Math.round(Number(o.unitCost) * 100) / 100)} / ${unit}` : '—'}</div>
        </div>
      </div>

      {!!o.outputs?.length && (
        <div className="space-y-1 text-sm">
          <h3 className="font-semibold">Produits finis</h3>
          {o.outputs.map((x) => (
            <div key={x.id}>
              Lot{' '}
              <Link className="font-mono text-brand-700 hover:underline" to={`/tracabilite?lot=${x.lotNumber}`}>
                {x.lotNumber}
              </Link>{' '}
              : {qty(x.quantity)} {unit} à {formatXOF(Math.round(Number(x.unitCost) * 100) / 100)} · péremption {formatDate(x.expiryDate)}
            </div>
          ))}
        </div>
      )}
      {!!o.losses?.length && (
        <div className="space-y-1">
          <h3 className="font-semibold">Pertes de production</h3>
          <Table head={['Étape', 'Quantité', 'Cause', 'Motif', 'Valeur', 'Par']}>
            {o.losses.map((l) => (
              <tr key={l.id}>
                <Td>{l.stage === 'COMPLETION' ? 'Fin de production' : 'Contrôle'}</Td>
                <Td>
                  {qty(l.quantity)} {unit}
                </Td>
                <Td>
                  <Badge tone="red">{LOSS_CAUSES[l.cause]}</Badge>
                </Td>
                <Td>{l.reason}</Td>
                <Td className="whitespace-nowrap">{money(l.value)}</Td>
                <Td>{l.createdBy}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </div>
  );
}

export function ProductionPage() {
  const { establishment, can } = useEstablishment();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Production" subtitle={establishment ? `${establishment.name} — ordres de production` : undefined} />
      <RequireEstablishment>
        {(establishmentId) => (
          <RequirePermission permission={['production.view', 'stock.view']}>
            <OrderList
              establishmentId={establishmentId}
              status={status}
              setStatus={setStatus}
              onOpen={setOpenId}
              actions={
                can('production.manage') && (
                  <Button onClick={() => setCreating(true)}>
                    <Plus className="size-4" /> Nouvel ordre
                  </Button>
                )
              }
            />
            <Modal open={creating} onClose={() => setCreating(false)} title="Nouvel ordre de production" wide>
              {creating && (
                <CreateForm
                  establishmentId={establishmentId}
                  onDone={(o) => {
                    setCreating(false);
                    setOpenId(o.id);
                  }}
                />
              )}
            </Modal>
          </RequirePermission>
        )}
      </RequireEstablishment>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title="Ordre de production" wide>
        {openId && <OrderDetail key={openId} id={openId} />}
      </Modal>
    </>
  );
}

function OrderList({
  establishmentId,
  status,
  setStatus,
  onOpen,
  actions,
}: {
  establishmentId: string;
  status: string;
  setStatus: (s: string) => void;
  onOpen: (id: string) => void;
  actions: React.ReactNode;
}) {
  const { can } = useEstablishment();
  const { data, isLoading, error } = useQuery({
    queryKey: ['production-orders', 'list', establishmentId, status],
    queryFn: () => api.get<ProductionOrderRec[]>(`/production-orders?establishmentId=${establishmentId}${status ? `&status=${status}` : ''}`),
  });
  return (
    <Card title="Ordres de production" actions={actions}>
      {!can('production.view') && <Alert tone="info">Lecture seule : ordres validés et suivants, pour préparer les matières.</Alert>}
      <Select className="my-3 max-w-[16rem]" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">Tous les statuts</option>
        {(Object.keys(PRODUCTION_STATUS) as ProductionStatus[]).map((k) => (
          <option key={k} value={k}>
            {PRODUCTION_STATUS[k].label}
          </option>
        ))}
      </Select>
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{(error as ApiError).message}</Alert>
      ) : (
        <Table head={['N°', 'Créé le', 'Produit', 'Prévu', 'Produit', 'Coût réel', 'Statut', '']} empty={data?.length === 0}>
          {data?.map((o) => (
            <tr key={o.id} className="cursor-pointer hover:bg-stone-50" onClick={() => onOpen(o.id)}>
              <Td className="font-mono text-xs">{o.number}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(o.createdAt)}</Td>
              <Td>{o.product?.name}</Td>
              <Td>
                {qty(o.plannedQuantity)} {unitLabel(o.product?.saleUnitCode)}
              </Td>
              <Td>{o.producedQuantity !== null ? qty(o.producedQuantity) : '—'}</Td>
              <Td className="whitespace-nowrap">{money(o.realCost)}</Td>
              <Td>
                <StatusBadge map={PRODUCTION_STATUS} status={o.status} />
              </Td>
              <Td className="text-right text-brand-700">Ouvrir</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
