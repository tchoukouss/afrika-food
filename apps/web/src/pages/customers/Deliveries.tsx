import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCircle2, Pencil, Truck, XCircle } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { qty } from '../../lib/catalog-types';
import { DELIVERY_ACTIVE, DELIVERY_DRIVER, DELIVERY_LIST_LIMIT, DELIVERY_MANAGER, DELIVERY_STATUS, DeliveryDetail, DeliveryRow } from '../../lib/delivery-types';
import { formatDateTime, formatXOF } from '../../lib/format';
import { CUSTOMER_ORDER_STATUS } from '../../lib/order-types';
import { RequirePermission, StatusBadge, useReasonDialog } from '../stock/shared';

const n = (v: string | number | null | undefined) => Number(v ?? 0);
/** Date-heure saisie (heure d'Abidjan = UTC) → ISO ; et l'inverse pour l'affichage dans le champ. */
const toIso = (local: string) => (local ? `${local}:00.000Z` : null);
const toLocal = (iso: string | null | undefined) => (iso ? iso.slice(0, 16) : '');
/** Jour d'une date ISO à Abidjan (UTC). */
const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const today = () => new Date().toISOString().slice(0, 10);
const NO_DRIVER = '__none__';

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="inline text-stone-500">{label} : </dt>
      <dd className="inline">{children}</dd>
    </div>
  );
}

/** Droits sur une livraison : responsable de l'établissement, ou livreur affecté (règles du serveur). */
function useDeliveryRights() {
  const { me } = useAuth();
  return (d: { establishmentId: string; driverId: string | null }) => {
    const est = me?.establishments.find((e) => e.id === d.establishmentId);
    const has = (perm: string) => !!me?.globalPermissions.includes(perm) || !!est?.permissions.includes(perm);
    return { manager: has(DELIVERY_MANAGER), driver: !!d.driverId && d.driverId === me?.id && has(DELIVERY_DRIVER) };
  };
}

/** Module 7 — Livraisons des commandes clients : suivi, circuit et modification d'une livraison prévue. */
export function DeliveriesPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  // Filtres conservés au retour de la fiche.
  const [status, setStatus] = useState('');
  const [day, setDay] = useState('');
  const [driver, setDriver] = useState('');
  return (
    <>
      <PageHeader title="Livraisons" subtitle="Livraisons des commandes clients : préparation, départ, remise ou échec" />
      <RequirePermission permission={DELIVERY_DRIVER}>
        {openId ? (
          <DeliveryView id={openId} onBack={() => setOpenId(null)} />
        ) : (
          <DeliveryList filters={{ status, day, driver }} set={{ setStatus, setDay, setDriver }} onOpen={setOpenId} />
        )}
      </RequirePermission>
    </>
  );
}

function DeliveryList({
  filters,
  set,
  onOpen,
}: {
  filters: { status: string; day: string; driver: string };
  set: { setStatus: (s: string) => void; setDay: (d: string) => void; setDriver: (d: string) => void };
  onOpen: (id: string) => void;
}) {
  // Établissement : celui du menu (en-tête de requête). Le serveur ne renvoie que les livraisons
  // des établissements gérés et celles affectées à l'utilisateur comme livreur.
  const { me, establishmentId } = useAuth();
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  const { data, isLoading, error } = useQuery({
    queryKey: ['deliveries', 'list', establishmentId, params.toString()],
    queryFn: () => api.get<DeliveryRow[]>(`/deliveries${params.size ? `?${params}` : ''}`),
  });
  // Date prévue et livreur : filtrés sur les lignes reçues (l'API ne les propose pas).
  const drivers = [...new Map((data ?? []).filter((d) => d.driverId).map((d) => [d.driverId!, d.driver ?? 'Livreur'])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const rows = (data ?? []).filter(
    (d) =>
      (!filters.day || dayOf(d.scheduledAt) === filters.day) &&
      (!filters.driver || (filters.driver === NO_DRIVER ? !d.driverId : d.driverId === filters.driver)),
  );
  const estCode = (id: string) => me?.establishments.find((e) => e.id === id)?.code ?? '—';
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-[12rem_12rem_minmax(0,16rem)_auto] md:items-end">
        <Field label="Statut">
          <Select value={filters.status} onChange={(e) => set.setStatus(e.target.value)}>
            <option value="">Tous les statuts</option>
            {Object.entries(DELIVERY_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Prévue le">
          <Input type="date" value={filters.day} onChange={(e) => set.setDay(e.target.value)} />
        </Field>
        <Field label="Livreur">
          <Select value={filters.driver} onChange={(e) => set.setDriver(e.target.value)}>
            <option value="">Tous</option>
            {me && drivers.some(([id]) => id === me.id) && <option value={me.id}>Mes livraisons</option>}
            {drivers
              .filter(([id]) => id !== me?.id)
              .map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            <option value={NO_DRIVER}>Sans livreur</option>
          </Select>
        </Field>
        <div className="flex gap-2 pb-0.5">
          <Button variant="ghost" onClick={() => set.setDay(today())}>
            Aujourd’hui
          </Button>
          {(filters.day || filters.status || filters.driver) && (
            <Button
              variant="ghost"
              onClick={() => {
                set.setDay('');
                set.setStatus('');
                set.setDriver('');
              }}
            >
              Effacer
            </Button>
          )}
        </div>
      </div>
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{(error as ApiError).message}</Alert>
      ) : (
        <>
          <Table head={['Livraison', 'Prévue', 'Étab.', 'Commande', 'Client', 'Adresse', 'Livreur', 'Frais', 'Statut']} empty={rows.length === 0}>
            {rows.map((d) => (
              <tr key={d.id} className={`cursor-pointer hover:bg-stone-50 ${['CANCELLED', 'FAILED'].includes(d.status) ? 'text-stone-400' : ''}`} onClick={() => onOpen(d.id)}>
                <Td className="whitespace-nowrap font-mono text-xs font-semibold">{d.number}</Td>
                <Td className="whitespace-nowrap">{d.scheduledAt ? formatDateTime(d.scheduledAt) : '—'}</Td>
                <Td>{estCode(d.establishmentId)}</Td>
                <Td className="whitespace-nowrap font-mono text-xs">{d.order.number}</Td>
                <Td>
                  {d.order.customer?.name ?? '—'}
                  {d.phone || d.order.customer?.phone ? <div className="text-xs text-stone-500">{d.phone ?? d.order.customer?.phone}</div> : null}
                </Td>
                <Td className="text-xs">{d.address}</Td>
                <Td className="text-xs">{d.driver ?? (d.driverId ? 'Livreur affecté' : '—')}</Td>
                <Td className="whitespace-nowrap">{n(d.fee) > 0 ? formatXOF(d.fee) : '—'}</Td>
                <Td>
                  <StatusBadge map={DELIVERY_STATUS} status={d.status} />
                </Td>
              </tr>
            ))}
          </Table>
          {data?.length === DELIVERY_LIST_LIMIT && (
            <p className="mt-2 text-xs text-stone-500">
              {DELIVERY_LIST_LIMIT} livraisons reçues (limite du serveur, sans pagination) ; les filtres date et livreur portent sur ces lignes : affinez avec le statut.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** Modification d'une livraison prévue (PATCH /deliveries/:id) : responsable, livraison à préparer ou prête. */
function EditDelivery({ delivery, onClose }: { delivery: DeliveryDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    address: delivery.address,
    phone: delivery.phone ?? '',
    scheduledAt: toLocal(delivery.scheduledAt),
    fee: String(n(delivery.fee)),
    feeLabel: delivery.feeLabel ?? '',
    notes: delivery.notes ?? '',
  });
  const fee = Number(f.fee);
  const error =
    f.address.trim().length < 3
      ? 'Adresse de livraison obligatoire (3 caractères au moins).'
      : f.fee.trim() === '' || !(Number.isInteger(fee) && fee >= 0)
        ? 'Frais de livraison : entier en FCFA (0 = sans frais).'
        : null;
  const save = useMutation({
    mutationFn: () =>
      api.patch<DeliveryDetail>(`/deliveries/${delivery.id}`, {
        address: f.address.trim(),
        phone: f.phone.trim() || null,
        scheduledAt: toIso(f.scheduledAt),
        fee,
        feeLabel: f.feeLabel.trim() || null,
        notes: f.notes.trim() || null,
      }),
    onSuccess: (updated) => {
      qc.setQueryData(['deliveries', 'detail', delivery.id], updated);
      qc.invalidateQueries({ queryKey: ['deliveries', 'list'] });
      qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', delivery.orderId] });
      onClose();
    },
  });
  return (
    <Modal open title={`Modifier la livraison ${delivery.number}`} onClose={() => !save.isPending && onClose()}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error && !save.isPending) save.mutate();
        }}
      >
        <Field label="Adresse de livraison">
          <Textarea rows={2} required minLength={3} maxLength={500} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Téléphone">
            <Input maxLength={30} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
          <Field label="Prévue le (date et heure)">
            <Input type="datetime-local" value={f.scheduledAt} onChange={(e) => setF({ ...f, scheduledAt: e.target.value })} />
          </Field>
          <Field label="Frais de livraison TTC (FCFA)" hint="Facturés avec la commande ; 0 = sans frais">
            <Input type="number" min={0} step={1} value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />
          </Field>
          <Field label="Libellé des frais">
            <Input maxLength={150} value={f.feeLabel} onChange={(e) => setF({ ...f, feeLabel: e.target.value })} />
          </Field>
        </div>
        <Field label="Notes (facultatif)">
          <Textarea rows={2} maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        {error && <Alert tone="info">{error}</Alert>}
        {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!!error}>
            Enregistrer
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeliveryView({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const rights = useDeliveryRights();
  const reason = useReasonDialog();
  const [editing, setEditing] = useState(false);
  const [confirmingDelivered, setConfirmingDelivered] = useState(false);
  const { data: d, isLoading, error } = useQuery({ queryKey: ['deliveries', 'detail', id], queryFn: () => api.get<DeliveryDetail>(`/deliveries/${id}`) });
  // Chaque action renvoie la fiche à jour : elle remplace celle affichée.
  const applied = (updated: DeliveryDetail) => {
    qc.setQueryData(['deliveries', 'detail', id], updated);
    qc.invalidateQueries({ queryKey: ['deliveries', 'list'] });
    qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', updated.orderId] });
    qc.invalidateQueries({ queryKey: ['customer-orders', 'list'] });
    // Livrée : sortie de stock de la commande.
    qc.invalidateQueries({ queryKey: ['stock'] });
  };
  const status = useMutation({
    mutationFn: (body: { status: 'READY' | 'OUT' | 'DELIVERED' | 'FAILED'; reason?: string }) => api.post<DeliveryDetail>(`/deliveries/${id}/status`, body),
    onSuccess: (updated) => {
      applied(updated);
      setConfirmingDelivered(false);
    },
  });
  const cancel = useMutation({ mutationFn: (r: string) => api.post<DeliveryDetail>(`/deliveries/${id}/cancel`, { reason: r }), onSuccess: applied });
  const back = (
    <Button variant="ghost" onClick={onBack}>
      <ArrowLeft className="size-4" /> Retour à la liste
    </Button>
  );
  if (isLoading) return <Spinner />;
  if (error || !d)
    return (
      <div className="space-y-3">
        {back}
        <Alert>{(error as ApiError | null)?.message ?? 'Livraison introuvable'}</Alert>
      </div>
    );
  const { driver } = rights(d);
  // Responsable : calculé par le serveur pour cette livraison.
  const manager = d.canManage;
  const busy = status.isPending || cancel.isPending;
  const s = d.status;
  const est = me?.establishments.find((e) => e.id === d.establishmentId);
  // Circuit du serveur : prête (responsable, commande prête) → départ (livreur affecté requis) → livrée (commande prête) ou échec.
  const canReady = s === 'TO_PREPARE' && manager;
  const canOut = s === 'READY' && (manager || driver);
  const canFinish = s === 'OUT' && (manager || driver);
  const canCancel = (s === 'TO_PREPARE' || s === 'READY') && manager;
  const canEdit = (s === 'TO_PREPARE' || s === 'READY') && manager;
  const orderReady = d.order.status === 'READY';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil className="size-4" /> Modifier
            </Button>
          )}
          {canReady && (
            <Button loading={status.isPending} disabled={busy || !orderReady} onClick={() => !status.isPending && status.mutate({ status: 'READY' })}>
              <CheckCircle2 className="size-4" /> Livraison prête
            </Button>
          )}
          {canOut && (
            <Button loading={status.isPending} disabled={busy || !d.driverId} onClick={() => !status.isPending && status.mutate({ status: 'OUT' })}>
              <Truck className="size-4" /> Départ
            </Button>
          )}
          {canFinish && (
            <>
              <Button disabled={busy || !orderReady} onClick={() => setConfirmingDelivered(true)}>
                <CheckCircle2 className="size-4" /> Livrée
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => reason.ask(`Échec de la livraison ${d.number}`, (r) => !status.isPending && status.mutate({ status: 'FAILED', reason: r }))}>
                <XCircle className="size-4" /> Échec
              </Button>
            </>
          )}
          {canCancel && (
            <Button variant="danger" loading={cancel.isPending} disabled={busy} onClick={() => reason.ask(`Annuler la livraison ${d.number}`, (r) => !cancel.isPending && cancel.mutate(r))}>
              <Ban className="size-4" /> Annuler
            </Button>
          )}
        </div>
      </div>
      {canReady && !orderReady && <Alert tone="info">Commande {d.order.number} pas encore prête : la livraison ne peut pas être marquée prête.</Alert>}
      {canOut && !d.driverId && <Alert tone="info">Affectez un livreur (fiche de la commande) avant le départ.</Alert>}
      {canFinish && !orderReady && <Alert tone="info">Commande {d.order.number} non prête : la livraison ne peut pas être confirmée.</Alert>}
      {status.error && <Alert>{(status.error as ApiError).message}</Alert>}
      {cancel.error && <Alert>{(cancel.error as ApiError).message}</Alert>}
      {reason.dialog}
      {editing && <EditDelivery delivery={d} onClose={() => setEditing(false)} />}
      <Modal open={confirmingDelivered} title={`Livraison ${d.number} effectuée`} onClose={() => !status.isPending && setConfirmingDelivered(false)}>
        <div className="space-y-3 text-sm">
          <p>
            Confirmer la remise à <strong>{d.order.customer?.name}</strong> : le stock réservé de la commande {d.order.number} sort définitivement et la commande passe « livrée ».
          </p>
          {status.error && <Alert>{(status.error as ApiError).message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={status.isPending} onClick={() => setConfirmingDelivered(false)}>
              Retour
            </Button>
            <Button loading={status.isPending} onClick={() => !status.isPending && status.mutate({ status: 'DELIVERED' })}>
              Confirmer la livraison
            </Button>
          </div>
        </div>
      </Modal>

      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            Livraison {d.number} <StatusBadge map={DELIVERY_STATUS} status={d.status} />
            {driver && <Badge tone="blue">Votre livraison</Badge>}
          </span>
        }
      >
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Info label="Commande">
            <span className="font-mono">{d.order.number}</span> ({CUSTOMER_ORDER_STATUS[d.order.status].label.toLowerCase()}, {formatXOF(d.order.total)})
          </Info>
          <Info label="Établissement">{est ? `${est.code} — ${est.name}` : '—'}</Info>
          <Info label="Client">
            <strong>{d.order.customer?.name ?? '—'}</strong>
          </Info>
          <Info label="Téléphone">{d.phone ?? d.order.customer?.phone ?? '—'}</Info>
          <Info label="Adresse">{d.address}</Info>
          <Info label="Prévue le">{d.scheduledAt ? formatDateTime(d.scheduledAt) : '—'}</Info>
          <Info label="Livreur">{d.driver ?? (d.driverId ? 'Livreur affecté' : 'Sans livreur')}</Info>
          <Info label="Frais">{n(d.fee) > 0 ? `${formatXOF(d.fee)}${d.feeLabel ? ` (${d.feeLabel})` : ''}` : '—'}</Info>
          <Info label="Créée le">{`${formatDateTime(d.createdAt)}${d.createdBy ? ` par ${d.createdBy}` : ''}`}</Info>
          {d.deliveredAt && <Info label="Livrée le">{formatDateTime(d.deliveredAt)}</Info>}
          {d.notes && <div className="text-stone-600 sm:col-span-2">{d.notes}</div>}
        </dl>
        {d.failedReason && (
          <div className="mt-3">
            <Alert>Échec : {d.failedReason}</Alert>
          </div>
        )}
        {d.cancelReason && (
          <div className="mt-3">
            <Alert>Annulée : {d.cancelReason}</Alert>
          </div>
        )}
        {!DELIVERY_ACTIVE.includes(s) && s === 'FAILED' && (
          <p className="mt-2 text-xs text-stone-500">Les réservations de la commande sont conservées : une nouvelle livraison peut être prévue depuis la commande.</p>
        )}
      </Card>

      <Card title="Contenu de la commande">
        <Table head={['Désignation', 'Qté', 'Livré', 'Total TTC']} empty={d.order.lines.length === 0}>
          {d.order.lines.map((l) => (
            <tr key={l.id}>
              <Td>
                {l.label} {l.kind === 'FEE' && <Badge>Frais</Badge>}
                {l.productCode && <div className="font-mono text-xs text-stone-500">{l.productCode}</div>}
                {l.note && <div className="text-xs text-stone-500">{l.note}</div>}
              </Td>
              <Td>{qty(l.quantity)}</Td>
              <Td className="text-xs">{l.kind === 'FEE' ? '—' : qty(l.deliveredQuantity)}</Td>
              <Td className="whitespace-nowrap">{formatXOF(l.lineTotal)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Historique">
        <Table head={['Date', 'Étape', 'Motif', 'Par']} empty={d.history.length === 0}>
          {d.history.map((h) => (
            <tr key={h.id}>
              <Td className="whitespace-nowrap">{formatDateTime(h.createdAt)}</Td>
              <Td>
                {h.fromStatus ? `${DELIVERY_STATUS[h.fromStatus].label} → ` : ''}
                {DELIVERY_STATUS[h.toStatus].label}
              </Td>
              <Td className="text-xs">{h.reason ?? '—'}</Td>
              <Td className="text-xs">{h.user ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
