import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCircle2, FileText, HandHelping, Pencil, Plus, Trash2, Truck } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { CustomerPicker } from '../../components/CustomerPicker';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Product, qty } from '../../lib/catalog-types';
import type { Customer } from '../../lib/customer-types';
import { formatDate, formatDateTime, formatXOF } from '../../lib/format';
import { INVOICE_PAYMENT_STATUS, INVOICE_STATUS, InvoiceDetail, InvoiceRow } from '../../lib/invoice-types';
import {
  CUSTOMER_DOCUMENT_KINDS,
  CUSTOMER_ORDER_LIST_LIMIT,
  CUSTOMER_ORDER_READ,
  CUSTOMER_ORDER_STATUS,
  CustomerDocumentKind,
  CustomerOrderDetail,
  CustomerOrderRow,
  DELIVERY_STATUS,
  EVENT_TYPES,
  EventType,
} from '../../lib/order-types';
import { RequirePermission, StatusBadge, useReasonDialog, useRequestId } from '../stock/shared';

const WRITE = 'customer_orders.manage';
/** Statuts depuis lesquels le serveur accepte l'annulation (avant « livrée »). */
const CANCELLABLE = ['DRAFT', 'CONFIRMED', 'IN_PREPARATION', 'READY'];
/** Commandes facturables (règle du serveur) : confirmées, avant ou après la livraison, jamais annulées. */
const INVOICEABLE_ORDER = ['CONFIRMED', 'IN_PREPARATION', 'READY', 'DELIVERED', 'COMPLETED'];
/** Facture « en cours » : une seule par commande (règle du serveur). */
const INVOICE_IN_PROGRESS = ['DRAFT', 'ISSUED', 'DISPUTED'];
/** Livraisons actives : elles bloquent la remise directe et une seconde livraison (règle du serveur). */
const ACTIVE_DELIVERY = ['TO_PREPARE', 'READY', 'OUT'];
const DRIVER = 'deliveries.manage';
/** GET /deliveries/drivers : livreurs affectables dans l'établissement. */
interface DriverOption {
  id: string;
  fullName: string;
  phone: string | null;
}

/**
 * Création d'une livraison (POST /customer-orders/:id/deliveries) : aucune sortie de stock,
 * la livraison réussie la fera. Livreur non proposé : aucune route ne liste les livreurs possibles.
 */
function DeliveryForm({ order, onClose }: { order: CustomerOrderDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const requestId = useRequestId();
  const [f, setF] = useState({ address: '', phone: order.customer?.phone ?? '', scheduledAt: '', fee: '0', feeLabel: '', notes: '' });
  const fee = Number(f.fee);
  const error =
    f.address.trim().length < 3
      ? 'Adresse de livraison obligatoire (3 caractères au moins).'
      : f.fee.trim() !== '' && !(Number.isInteger(fee) && fee >= 0)
        ? 'Frais de livraison : entier en FCFA.'
        : null;
  const create = useMutation({
    mutationFn: () =>
      api.post(`/customer-orders/${order.id}/deliveries`, {
        clientRequestId: requestId,
        address: f.address.trim(),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
        ...(f.scheduledAt ? { scheduledAt: toIso(f.scheduledAt) } : {}),
        ...(fee > 0 ? { fee } : {}),
        ...(f.feeLabel.trim() ? { feeLabel: f.feeLabel.trim() } : {}),
        ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
      }),
    onSuccess: () => {
      // La réponse est la livraison : la fiche de la commande est relue pour l'afficher.
      qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', order.id] });
      qc.invalidateQueries({ queryKey: ['customer-orders', 'list'] });
      onClose();
    },
  });
  return (
    <Modal open title={`Prévoir une livraison — ${order.number}`} onClose={() => !create.isPending && onClose()}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error && !create.isPending) create.mutate();
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
          <Field label="Frais de livraison TTC (FCFA)" hint="Facturés plus tard ; 0 = sans frais">
            <Input type="number" min={0} step={1} value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />
          </Field>
          <Field label="Libellé des frais">
            <Input maxLength={150} value={f.feeLabel} onChange={(e) => setF({ ...f, feeLabel: e.target.value })} placeholder="Livraison Cocody…" />
          </Field>
        </div>
        <Field label="Notes (facultatif)">
          <Textarea rows={2} maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <p className="text-xs text-stone-500">Le livreur s’affecte plus tard ; il est obligatoire avant le départ. Aucun stock ne sort à la création.</p>
        {error && (f.address || f.fee !== '0') && <Alert tone="info">{error}</Alert>}
        {create.error && <Alert>{(create.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={create.isPending} onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!!error}>
            Créer la livraison
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Actions d'une livraison active, selon le circuit du serveur : à préparer → prête → en livraison →
 * livrée (sortie de stock unique) ou échouée (motif). Prête et annulation : responsable ; départ et
 * retour : responsable ou livreur affecté.
 */
function DeliveryActions({ order, delivery }: { order: CustomerOrderDetail; delivery: CustomerOrderDetail['deliveries'][number] }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const reason = useReasonDialog();
  const [confirmingDelivered, setConfirmingDelivered] = useState(false);
  const est = me?.establishments.find((e) => e.id === order.establishmentId);
  const hasHere = (perm: string) => !!me?.globalPermissions.includes(perm) || !!est?.permissions.includes(perm);
  const manager = order.canManage;
  const driver = delivery.driverId === me?.id && hasHere(DRIVER);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', order.id] });
    qc.invalidateQueries({ queryKey: ['customer-orders', 'list'] });
    qc.invalidateQueries({ queryKey: ['stock'] });
  };
  const status = useMutation({
    mutationFn: (body: { status: 'READY' | 'OUT' | 'DELIVERED' | 'FAILED'; reason?: string }) => api.post(`/deliveries/${delivery.id}/status`, body),
    onSuccess: () => {
      setConfirmingDelivered(false);
      refresh();
    },
  });
  const cancel = useMutation({ mutationFn: (r: string) => api.post(`/deliveries/${delivery.id}/cancel`, { reason: r }), onSuccess: refresh });
  const s = delivery.status;
  // Affectation : responsable, livraison à préparer, choix limité aux livreurs renvoyés par le serveur.
  const canAssign = manager && s === 'TO_PREPARE';
  const drivers = useQuery({
    queryKey: ['deliveries', 'drivers', order.establishmentId],
    queryFn: () => api.get<DriverOption[]>(`/deliveries/drivers?establishmentId=${order.establishmentId}`),
    enabled: manager,
  });
  const [choice, setChoice] = useState('');
  const assign = useMutation({
    mutationFn: (driverId: string | null) => api.patch(`/deliveries/${delivery.id}`, { driverId }),
    onSuccess: () => {
      setChoice('');
      refresh();
    },
  });
  const busy = status.isPending || cancel.isPending || assign.isPending;
  const assigned = drivers.data?.find((d) => d.id === delivery.driverId);
  const driverLabel = !delivery.driverId
    ? 'Sans livreur'
    : delivery.driverId === me?.id
      ? 'Livreur : vous'
      : assigned
        ? `Livreur : ${assigned.fullName}${assigned.phone ? ` · ${assigned.phone}` : ''}`
        : 'Livreur affecté';
  return (
    <div className="space-y-1">
      <div className="text-xs text-stone-600">{driverLabel}</div>
      {canAssign && (
        <div className="flex flex-wrap items-center gap-1">
          <Select aria-label="Livreur" className="w-auto py-1 text-xs" value={choice} disabled={busy || drivers.isLoading} onChange={(e) => setChoice(e.target.value)}>
            <option value="">{drivers.isLoading ? 'Chargement…' : 'Choisir un livreur'}</option>
            {drivers.data
              ?.filter((d) => d.id !== delivery.driverId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fullName}
                  {d.phone ? ` · ${d.phone}` : ''}
                </option>
              ))}
          </Select>
          <Button
            variant="secondary"
            className="px-2 py-1"
            loading={assign.isPending}
            disabled={busy || !drivers.data?.some((d) => d.id === choice)}
            onClick={() => !assign.isPending && assign.mutate(choice)}
          >
            Affecter
          </Button>
          {delivery.driverId && (
            <Button variant="ghost" className="px-2 py-1" disabled={busy} onClick={() => !assign.isPending && assign.mutate(null)}>
              Retirer
            </Button>
          )}
        </div>
      )}
      {drivers.error && <div className="text-xs text-red-700">{(drivers.error as ApiError).message}</div>}
      {assign.error && <div className="text-xs text-red-700">{(assign.error as ApiError).message}</div>}
      <div className="flex flex-wrap gap-1">
        {s === 'TO_PREPARE' &&
          manager &&
          order.status === 'READY' &&
          (delivery.driverId ? (
            <Button variant="secondary" className="px-2 py-1" loading={status.isPending} disabled={busy} onClick={() => !status.isPending && status.mutate({ status: 'READY' })}>
              Livraison prête
            </Button>
          ) : (
            <span className="text-xs text-stone-500">Affectez un livreur pour préparer le départ.</span>
          ))}
        {s === 'READY' &&
          (manager || driver) &&
          (delivery.driverId ? (
            <Button variant="secondary" className="px-2 py-1" loading={status.isPending} disabled={busy} onClick={() => !status.isPending && status.mutate({ status: 'OUT' })}>
              Départ
            </Button>
          ) : (
            <span className="text-xs text-stone-500">Affectez un livreur avant le départ.</span>
          ))}
        {s === 'OUT' && (manager || driver) && (
          <>
            <Button className="px-2 py-1" disabled={busy} onClick={() => setConfirmingDelivered(true)}>
              Livrée
            </Button>
            <Button variant="secondary" className="px-2 py-1" disabled={busy} onClick={() => reason.ask(`Échec de la livraison ${delivery.number}`, (r) => status.mutate({ status: 'FAILED', reason: r }))}>
              Échec
            </Button>
          </>
        )}
        {(s === 'TO_PREPARE' || s === 'READY') && manager && (
          <Button variant="ghost" className="px-2 py-1" loading={cancel.isPending} disabled={busy} onClick={() => reason.ask(`Annuler la livraison ${delivery.number}`, (r) => cancel.mutate(r))}>
            Annuler
          </Button>
        )}
      </div>
      {status.error && <div className="text-xs text-red-700">{(status.error as ApiError).message}</div>}
      {cancel.error && <div className="text-xs text-red-700">{(cancel.error as ApiError).message}</div>}
      {reason.dialog}
      <Modal open={confirmingDelivered} title={`Livraison ${delivery.number} effectuée`} onClose={() => !status.isPending && setConfirmingDelivered(false)}>
        <div className="space-y-3 text-sm">
          <p>Confirmer la remise au client : le stock réservé de la commande {order.number} sort définitivement et la commande passe « livrée ».</p>
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
    </div>
  );
}

const n = (v: string | number | null | undefined) => Number(v ?? 0);
/** Statuts d'acompte du serveur. */
const DEPOSIT_STATUS: Record<string, string> = {
  RECEIVED: 'Reçu',
  CUSTOMER_CREDIT: 'Converti en crédit client',
  REFUNDED: 'Remboursé',
  CANCELLED: 'Annulé',
};

/** Module 7 — Commandes clients (lecture seule) : distinctes des commandes du restaurant (module 6). */
export function CustomerOrdersPage() {
  const { establishmentId, can, canAnywhere } = useAuth();
  const [openId, setOpenId] = useState<string | null>(null);
  // Formulaire : nouvelle commande, ou modification d'un brouillon (identifiant).
  const [editing, setEditing] = useState<'new' | string | null>(null);
  // Filtres conservés au retour de la fiche.
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const canCreate = establishmentId ? can(WRITE) : canAnywhere(WRITE);
  return (
    <>
      <PageHeader
        title="Commandes clients"
        subtitle="Commandes, événements et suivi jusqu’à la livraison (les commandes du restaurant sont dans « Restaurant »)"
        actions={
          canCreate &&
          !editing && (
            <Button
              onClick={() => {
                setOpenId(null);
                setEditing('new');
              }}
            >
              <Plus className="size-4" /> Nouvelle commande
            </Button>
          )
        }
      />
      <RequirePermission permission={CUSTOMER_ORDER_READ}>
        {editing ? (
          <OrderForm
            orderId={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={(id) => {
              setEditing(null);
              setOpenId(id);
            }}
          />
        ) : openId ? (
          <OrderView id={openId} onBack={() => setOpenId(null)} onEdit={() => setEditing(openId)} />
        ) : (
          <OrderList
            filters={{ customer, status, kind, search }}
            set={{ setCustomer, setStatus, setKind, setSearch }}
            onOpen={setOpenId}
          />
        )}
      </RequirePermission>
    </>
  );
}

function OrderList({
  filters,
  set,
  onOpen,
}: {
  filters: { customer: Customer | null; status: string; kind: string; search: string };
  set: { setCustomer: (c: Customer | null) => void; setStatus: (s: string) => void; setKind: (k: string) => void; setSearch: (s: string) => void };
  onOpen: (id: string) => void;
}) {
  // Établissement : celui du menu (en-tête de requête) ; vue groupe = établissements autorisés.
  const { me, establishmentId } = useAuth();
  const params = new URLSearchParams();
  if (filters.customer) params.set('customerId', filters.customer.id);
  if (filters.status) params.set('status', filters.status);
  if (filters.kind) params.set('kind', filters.kind);
  const { data, isLoading, error } = useQuery({
    queryKey: ['customer-orders', 'list', establishmentId, params.toString()],
    queryFn: () => api.get<CustomerOrderRow[]>(`/customer-orders${params.size ? `?${params}` : ''}`),
  });
  // Numéro : recherche sur les lignes reçues (l'API ne la propose pas).
  const term = filters.search.trim().toLowerCase();
  const rows = (data ?? []).filter((o) => !term || o.number.toLowerCase().includes(term));
  const estCode = (id: string) => me?.establishments.find((e) => e.id === id)?.code ?? '—';
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_10rem_12rem] md:items-end">
        <div>
          <span className="mb-1 block text-sm font-medium text-stone-700">Client</span>
          <CustomerPicker establishmentId={establishmentId ?? ''} value={filters.customer} onChange={set.setCustomer} showCredit={false} />
        </div>
        <Field label="Statut">
          <Select value={filters.status} onChange={(e) => set.setStatus(e.target.value)}>
            <option value="">Tous les statuts</option>
            {Object.entries(CUSTOMER_ORDER_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type">
          <Select value={filters.kind} onChange={(e) => set.setKind(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(CUSTOMER_DOCUMENT_KINDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="N° de commande">
          <Input value={filters.search} onChange={(e) => set.setSearch(e.target.value)} placeholder="Rechercher…" />
        </Field>
      </div>
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{(error as ApiError).message}</Alert>
      ) : (
        <>
          <Table head={['N°', 'Créée le', 'Étab.', 'Client', 'Type', 'Pour le', 'Total TTC', 'Statut']} empty={rows.length === 0}>
            {rows.map((o) => (
              <tr key={o.id} className="cursor-pointer hover:bg-stone-50" onClick={() => onOpen(o.id)}>
                <Td className="whitespace-nowrap font-mono text-xs font-semibold">{o.number}</Td>
                <Td className="whitespace-nowrap">{formatDate(o.createdAt)}</Td>
                <Td>{estCode(o.establishmentId)}</Td>
                <Td>{o.customer?.name ?? '—'}</Td>
                <Td>
                  {o.kind === 'EVENT' ? (
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge tone="blue">Événement</Badge>
                      {o.event && <span className="text-xs text-stone-500">{EVENT_TYPES[o.event.eventType]}</span>}
                    </span>
                  ) : (
                    CUSTOMER_DOCUMENT_KINDS.STANDARD
                  )}
                </Td>
                <Td className="whitespace-nowrap">{o.dueAt ? formatDateTime(o.dueAt) : o.event ? formatDateTime(o.event.eventDate) : '—'}</Td>
                <Td className="whitespace-nowrap font-semibold">{formatXOF(o.total)}</Td>
                <Td>
                  <StatusBadge map={CUSTOMER_ORDER_STATUS} status={o.status} />
                </Td>
              </tr>
            ))}
          </Table>
          {data?.length === CUSTOMER_ORDER_LIST_LIMIT && (
            <p className="mt-2 text-xs text-stone-500">
              {CUSTOMER_ORDER_LIST_LIMIT} commandes les plus récentes reçues (limite du serveur, sans pagination) : affinez avec le client, le statut ou le type.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="inline text-stone-500">{label} : </dt>
      <dd className="inline">{children}</dd>
    </div>
  );
}

/** Factures de la commande (GET /invoices?orderId=) : rien n'est affiché sans droit de lecture des factures. */
function OrderInvoices({ orderId }: { orderId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['invoices', 'list', 'order', orderId],
    queryFn: () => api.get<InvoiceRow[]>(`/invoices?orderId=${orderId}`),
    retry: false,
  });
  if (isLoading) return <Spinner />;
  if (error) return <p className="text-sm text-stone-500">Factures non consultables avec vos droits.</p>;
  if (!data?.length) return <p className="text-sm text-stone-500">Aucune facture pour cette commande.</p>;
  return (
    <Table head={['Facture', 'Date', 'Total TTC', 'Payé', 'Reste dû', 'Statut']}>
      {data.map((i) => (
        <tr key={i.id}>
          <Td className="font-mono text-xs font-semibold">{i.number ?? 'Brouillon'}</Td>
          <Td className="whitespace-nowrap">{formatDate(i.issuedAt ?? i.createdAt)}</Td>
          <Td className="whitespace-nowrap">{formatXOF(i.total)}</Td>
          <Td className="whitespace-nowrap">{formatXOF(i.paid)}</Td>
          <Td className="whitespace-nowrap">{formatXOF(i.balance)}</Td>
          <Td>
            <span className="flex flex-wrap gap-1">
              <StatusBadge map={INVOICE_STATUS} status={i.status} />
              {i.paymentStatus && <StatusBadge map={INVOICE_PAYMENT_STATUS} status={i.paymentStatus} />}
            </span>
          </Td>
        </tr>
      ))}
    </Table>
  );
}

// --- Création / modification d'un brouillon -----------------------------------------------

interface LineDraft {
  key: string;
  kind: 'PRODUCT' | 'FEE';
  productId: string;
  quantity: string;
  madeToOrder: boolean;
  label: string;
  unitPrice: string;
  taxRate: string;
  note: string;
}

let lineSeq = 0;
const newLine = (kind: 'PRODUCT' | 'FEE'): LineDraft => ({ key: `l${++lineSeq}`, kind, productId: '', quantity: '1', madeToOrder: false, label: '', unitPrice: '', taxRate: '0', note: '' });

/** Date-heure saisie (heure d'Abidjan = UTC) → ISO ; et l'inverse pour l'affichage dans le champ. */
const toIso = (local: string) => (local ? `${local}:00.000Z` : null);
const toLocal = (iso: string | null | undefined) => (iso ? iso.slice(0, 16) : '');

/**
 * Brouillon de commande client : POST /customer-orders (création), PATCH /customer-orders/:id
 * (modification, brouillon seulement). Prix, TVA et libellé d'une ligne produit viennent du
 * catalogue côté serveur : l'écran n'en montre qu'une estimation.
 */
function OrderForm({ orderId, onCancel, onSaved }: { orderId: string | null; onCancel: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const { me, establishmentId: selected } = useAuth();
  // Même identifiant à chaque tentative de ce formulaire : jamais deux commandes pour un double clic.
  const requestId = useRequestId();
  const existing = useQuery({ queryKey: ['customer-orders', 'detail', orderId], queryFn: () => api.get<CustomerOrderDetail>(`/customer-orders/${orderId}`), enabled: !!orderId });
  const o = existing.data;
  const editing = !!orderId;

  const allowed = (me?.establishments ?? []).filter((e) => me?.globalPermissions.includes(WRITE) || e.permissions.includes(WRITE));
  const [estChoice, setEstChoice] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [kind, setKind] = useState<CustomerDocumentKind>('STANDARD');
  const [dueAt, setDueAt] = useState('');
  const [notes, setNotes] = useState('');
  const [event, setEvent] = useState({ eventType: 'BIRTHDAY' as EventType, eventDate: '', venue: '', guests: '', contactName: '', contactPhone: '', notes: '' });
  const [lines, setLines] = useState<LineDraft[]>([newLine('PRODUCT')]);
  // Brouillon existant : le formulaire reprend ses valeurs une fois chargé.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (o && loadedFor !== o.id) {
    setLoadedFor(o.id);
    setKind(o.kind);
    setDueAt(toLocal(o.dueAt));
    setNotes(o.notes ?? '');
    if (o.event)
      setEvent({
        eventType: o.event.eventType,
        eventDate: toLocal(o.event.eventDate),
        venue: o.event.venue ?? '',
        guests: o.event.guests !== null ? String(o.event.guests) : '',
        contactName: o.event.contactName ?? '',
        contactPhone: o.event.contactPhone ?? '',
        notes: o.event.notes ?? '',
      });
    setLines(
      o.lines.map((l) => ({
        ...newLine(l.kind),
        productId: l.productId ?? '',
        quantity: String(Number(l.quantity)),
        madeToOrder: l.madeToOrder,
        label: l.kind === 'FEE' ? l.label : '',
        unitPrice: l.kind === 'FEE' ? String(Number(l.unitPrice)) : '',
        taxRate: l.kind === 'FEE' ? String(Number(l.taxRate)) : '0',
        note: l.note ?? '',
      })),
    );
  }
  const establishmentId = editing ? o?.establishmentId ?? '' : selected ?? estChoice;

  // Catalogue : prix de l'établissement du menu (sinon prix de base) — estimation, le serveur tarifie.
  const products = useQuery({ queryKey: ['products', 'customer-orders', selected], queryFn: () => api.get<Product[]>('/products') });
  const sellable = (products.data ?? []).filter((p) => p.isActive);
  const productOf = (id: string) => sellable.find((p) => p.id === id);
  const priceOf = (p: Product | undefined) => n(p?.price ?? p?.basePrice);
  const lineTotal = (l: LineDraft) => Math.round((Number(l.quantity) || 0) * (l.kind === 'FEE' ? Number(l.unitPrice) || 0 : priceOf(productOf(l.productId))));
  const total = lines.reduce((s, l) => s + lineTotal(l), 0);
  const update = (key: string, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const lineError = lines
    .map((l, i) => {
      const q = Number(l.quantity);
      if (!(q > 0) || Math.round(q * 10000) !== q * 10000) return `Ligne ${i + 1} : quantité positive (4 décimales au plus).`;
      if (l.kind === 'PRODUCT') {
        const p = productOf(l.productId);
        if (!p) return `Ligne ${i + 1} : choisissez le produit.`;
        if (l.madeToOrder && p.type !== 'MANUFACTURED') return `Ligne ${i + 1} : seul un produit fabriqué se fabrique à la demande.`;
      } else {
        if (l.label.trim().length < 2) return `Ligne ${i + 1} : libellé des frais (2 caractères au moins).`;
        if (l.unitPrice.trim() === '' || !Number.isInteger(Number(l.unitPrice)) || Number(l.unitPrice) < 0) return `Ligne ${i + 1} : prix TTC entier en FCFA.`;
        const t = Number(l.taxRate);
        if (!(t >= 0 && t <= 100)) return `Ligne ${i + 1} : TVA entre 0 et 100 %.`;
      }
      return null;
    })
    .find((e) => e);
  const error = !establishmentId
    ? 'Choisissez l’établissement.'
    : !editing && !customer
      ? 'Choisissez le client.'
      : lines.length === 0
        ? 'Ajoutez au moins une ligne.'
        : lineError ??
          (kind === 'EVENT' && !event.eventDate
            ? 'Date de l’événement obligatoire.'
            : kind === 'EVENT' && event.guests.trim() !== '' && !(Number.isInteger(Number(event.guests)) && Number(event.guests) >= 1)
              ? 'Nombre d’invités : entier positif.'
              : null);

  const payloadLines = () =>
    lines.map((l) =>
      l.kind === 'PRODUCT'
        ? { kind: 'PRODUCT', productId: l.productId, quantity: Number(l.quantity), ...(l.madeToOrder ? { madeToOrder: true } : {}), ...(l.note.trim() ? { note: l.note.trim() } : {}) }
        : { kind: 'FEE', label: l.label.trim(), quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), taxRate: Number(l.taxRate) || 0, ...(l.note.trim() ? { note: l.note.trim() } : {}) },
    );
  const payloadEvent = () => ({
    eventType: event.eventType,
    eventDate: toIso(event.eventDate),
    ...(event.venue.trim() ? { venue: event.venue.trim() } : {}),
    ...(event.guests.trim() ? { guests: Number(event.guests) } : {}),
    ...(event.contactName.trim() ? { contactName: event.contactName.trim() } : {}),
    ...(event.contactPhone.trim() ? { contactPhone: event.contactPhone.trim() } : {}),
    ...(event.notes.trim() ? { notes: event.notes.trim() } : {}),
  });

  const save = useMutation({
    mutationFn: () =>
      editing
        ? // Établissement, client et type ne se modifient pas (règle du serveur).
          api.patch<CustomerOrderDetail>(`/customer-orders/${orderId}`, {
            dueAt: toIso(dueAt),
            notes: notes.trim() || null,
            ...(kind === 'EVENT' ? { event: payloadEvent() } : {}),
            lines: payloadLines(),
          })
        : api.post<CustomerOrderDetail>('/customer-orders', {
            clientRequestId: requestId,
            establishmentId,
            customerId: customer!.id,
            kind,
            ...(dueAt ? { dueAt: toIso(dueAt) } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            ...(kind === 'EVENT' ? { event: payloadEvent() } : {}),
            lines: payloadLines(),
          }),
    onSuccess: (saved) => {
      // La réponse est la fiche de la commande : elle s'affiche sans relecture.
      qc.setQueryData(['customer-orders', 'detail', saved.id], saved);
      qc.invalidateQueries({ queryKey: ['customer-orders', 'list'] });
      onSaved(saved.id);
    },
  });

  if (editing && existing.isLoading) return <Spinner />;
  if (editing && (existing.error || !o)) return <Alert>{(existing.error as ApiError | null)?.message ?? 'Commande introuvable'}</Alert>;
  if (editing && o && o.status !== 'DRAFT') return <Alert>Commande {o.number} confirmée : elle ne se modifie plus.</Alert>;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error && !save.isPending) save.mutate();
      }}
    >
      <Card title={editing ? `Modifier le brouillon ${o?.number}` : 'Nouvelle commande client'}>
        <div className="grid gap-3 md:grid-cols-2">
          {editing ? (
            <div className="text-sm">
              Établissement : <strong>{me?.establishments.find((e) => e.id === o?.establishmentId)?.name ?? '—'}</strong>
              <br />
              Client : <strong>{o?.customer?.name}</strong> · Type : <strong>{CUSTOMER_DOCUMENT_KINDS[o!.kind]}</strong>
            </div>
          ) : (
            <>
              {selected ? (
                <div className="text-sm">
                  Établissement : <strong>{me?.establishments.find((e) => e.id === selected)?.name ?? '—'}</strong>
                </div>
              ) : (
                <Field label="Établissement">
                  <Select required value={estChoice} onChange={(e) => setEstChoice(e.target.value)}>
                    <option value="">— Choisir —</option>
                    {allowed.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.code} — {e.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Type de commande">
                <Select value={kind} onChange={(e) => setKind(e.target.value as CustomerDocumentKind)}>
                  {Object.entries(CUSTOMER_DOCUMENT_KINDS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="md:col-span-2">
                <span className="mb-1 block text-sm font-medium text-stone-700">Client</span>
                <CustomerPicker establishmentId={establishmentId} value={customer} onChange={setCustomer} showCredit={false} />
              </div>
            </>
          )}
          <Field label="Pour le (date et heure, facultatif)">
            <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
          <Field label="Notes (facultatif)">
            <Textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </Card>

      {kind === 'EVENT' && (
        <Card title="Événement">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Type d’événement">
              <Select value={event.eventType} onChange={(e) => setEvent({ ...event, eventType: e.target.value as EventType })}>
                {Object.entries(EVENT_TYPES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date et heure">
              <Input type="datetime-local" required value={event.eventDate} onChange={(e) => setEvent({ ...event, eventDate: e.target.value })} />
            </Field>
            <Field label="Nombre d’invités">
              <Input type="number" min={1} step={1} value={event.guests} onChange={(e) => setEvent({ ...event, guests: e.target.value })} />
            </Field>
            <Field label="Lieu">
              <Input maxLength={300} value={event.venue} onChange={(e) => setEvent({ ...event, venue: e.target.value })} />
            </Field>
            <Field label="Contact sur place">
              <Input maxLength={120} value={event.contactName} onChange={(e) => setEvent({ ...event, contactName: e.target.value })} />
            </Field>
            <Field label="Téléphone du contact">
              <Input maxLength={30} value={event.contactPhone} onChange={(e) => setEvent({ ...event, contactPhone: e.target.value })} />
            </Field>
            <div className="md:col-span-3">
              <Field label="Notes de l’événement">
                <Textarea rows={2} maxLength={1000} value={event.notes} onChange={(e) => setEvent({ ...event, notes: e.target.value })} />
              </Field>
            </div>
          </div>
        </Card>
      )}

      <Card
        title="Lignes"
        actions={
          <>
            <Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, newLine('PRODUCT')])}>
              <Plus className="size-4" /> Produit
            </Button>
            <Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, newLine('FEE')])}>
              <Plus className="size-4" /> Frais
            </Button>
          </>
        }
      >
        {products.isLoading ? (
          <Spinner />
        ) : (
          <div className="space-y-3">
            {lines.map((l, i) => {
              const p = productOf(l.productId);
              return (
                <div key={l.key} className="grid gap-2 rounded-lg border border-stone-200 p-3 md:grid-cols-[2fr_6rem_8rem_6rem_8rem_auto] md:items-end">
                  {l.kind === 'PRODUCT' ? (
                    <Field label={`Ligne ${i + 1} — produit`}>
                      <Select value={l.productId} onChange={(e) => update(l.key, { productId: e.target.value, madeToOrder: false })}>
                        <option value="">— Choisir —</option>
                        {sellable.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.code} — {x.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <Field label={`Ligne ${i + 1} — frais (libellé)`}>
                      <Input maxLength={150} value={l.label} onChange={(e) => update(l.key, { label: e.target.value })} placeholder="Livraison, service, location…" />
                    </Field>
                  )}
                  <Field label="Quantité">
                    <Input type="number" min={0.0001} step="any" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                  </Field>
                  {l.kind === 'PRODUCT' ? (
                    <div className="text-sm">
                      <span className="block text-sm font-medium text-stone-700">Prix TTC</span>
                      <span className="block py-2">{p ? formatXOF(priceOf(p)) : '—'}</span>
                    </div>
                  ) : (
                    <Field label="Prix TTC (FCFA)">
                      <Input type="number" min={0} step={1} value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} />
                    </Field>
                  )}
                  {l.kind === 'PRODUCT' ? (
                    <div className="text-sm">
                      <span className="block text-sm font-medium text-stone-700">TVA</span>
                      <span className="block py-2">{p ? `${n(p.taxRate)} %` : '—'}</span>
                    </div>
                  ) : (
                    <Field label="TVA (%)">
                      <Input type="number" min={0} max={100} step={0.01} value={l.taxRate} onChange={(e) => update(l.key, { taxRate: e.target.value })} />
                    </Field>
                  )}
                  <div className="text-sm">
                    <span className="block text-sm font-medium text-stone-700">Total TTC</span>
                    <span className="block py-2 font-semibold">{formatXOF(lineTotal(l))}</span>
                  </div>
                  <Button type="button" variant="ghost" aria-label="Retirer la ligne" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    <Trash2 className="size-4" />
                  </Button>
                  <div className="flex flex-wrap items-center gap-4 md:col-span-6">
                    {l.kind === 'PRODUCT' && p?.type === 'MANUFACTURED' && (
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={l.madeToOrder} onChange={(e) => update(l.key, { madeToOrder: e.target.checked })} /> Fabriqué à la demande
                      </label>
                    )}
                    <Input className="flex-1" maxLength={500} value={l.note} onChange={(e) => update(l.key, { note: e.target.value })} placeholder="Note de ligne (facultatif)" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3 flex justify-end text-base font-bold">Total TTC estimé : {formatXOF(total)}</div>
        <p className="mt-1 text-right text-xs text-stone-500">Prix et TVA des produits fixés par le serveur selon le catalogue de l’établissement.</p>
      </Card>

      {error && <Alert tone="info">{error}</Alert>}
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Annuler
        </Button>
        <Button type="submit" loading={save.isPending} disabled={!!error}>
          {editing ? 'Enregistrer le brouillon' : 'Créer la commande (brouillon)'}
        </Button>
      </div>
    </form>
  );
}

function OrderView({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const reason = useReasonDialog();
  const [confirming, setConfirming] = useState(false);
  const [handingOver, setHandingOver] = useState(false);
  const [planningDelivery, setPlanningDelivery] = useState(false);
  const { data: o, isLoading, error } = useQuery({ queryKey: ['customer-orders', 'detail', id], queryFn: () => api.get<CustomerOrderDetail>(`/customer-orders/${id}`) });
  // Les deux actions renvoient la fiche à jour (statut, réservations, historique) : elle remplace celle affichée.
  const applied = (updated: CustomerOrderDetail) => {
    qc.setQueryData(['customer-orders', 'detail', id], updated);
    qc.invalidateQueries({ queryKey: ['customer-orders', 'list'] });
    // Réservation ou libération du stock.
    qc.invalidateQueries({ queryKey: ['stock'] });
  };
  // Confirmation : seule étape autorisée ici (brouillon → confirmée) ; le serveur réserve le stock.
  const confirm = useMutation({
    mutationFn: () => api.post<CustomerOrderDetail>(`/customer-orders/${id}/status`, { status: 'CONFIRMED' }),
    onSuccess: (updated) => {
      applied(updated);
      setConfirming(false);
    },
  });
  const cancel = useMutation({ mutationFn: (r: string) => api.post<CustomerOrderDetail>(`/customer-orders/${id}/cancel`, { reason: r }), onSuccess: applied });
  // Préparation : confirmée → en préparation → prête, une étape à la fois (aucune sortie de stock).
  const advance = useMutation({
    mutationFn: (status: 'IN_PREPARATION' | 'READY') => api.post<CustomerOrderDetail>(`/customer-orders/${id}/status`, { status }),
    onSuccess: applied,
  });
  // Remise directe au client : sortie de stock unique et passage « livrée », faits par le serveur.
  const handOver = useMutation({
    mutationFn: () => api.post<CustomerOrderDetail>(`/customer-orders/${id}/hand-over`),
    onSuccess: (updated) => {
      applied(updated);
      setHandingOver(false);
    },
  });
  // Facture de la commande : brouillon créé par le serveur (lignes, prix et TVA repris de la commande), émis ensuite depuis « Facturation ».
  const invoiceRequestId = useRequestId();
  const [invoicing, setInvoicing] = useState(false);
  const [draftInvoice, setDraftInvoice] = useState<InvoiceDetail | null>(null);
  const invoices = useQuery({
    queryKey: ['invoices', 'list', 'order', id],
    queryFn: () => api.get<InvoiceRow[]>(`/invoices?orderId=${id}`),
    retry: false,
  });
  const createInvoice = useMutation({
    mutationFn: (o: CustomerOrderDetail) =>
      api.post<InvoiceDetail>('/invoices', { clientRequestId: invoiceRequestId, source: 'ORDER', establishmentId: o.establishmentId, orderId: o.id }),
    onSuccess: (inv) => {
      qc.setQueryData(['invoices', 'detail', inv.id], inv);
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', id] });
      setDraftInvoice(inv);
      setInvoicing(false);
    },
  });
  const back = (
    <Button variant="ghost" onClick={onBack}>
      <ArrowLeft className="size-4" /> Retour à la liste
    </Button>
  );
  if (isLoading) return <Spinner />;
  if (error || !o)
    return (
      <div className="space-y-3">
        {back}
        <Alert>{(error as ApiError | null)?.message ?? 'Commande introuvable'}</Alert>
      </div>
    );
  const est = me?.establishments.find((e) => e.id === o.establishmentId);
  const hasHere = (perm: string) => !!me?.globalPermissions.includes(perm) || !!est?.permissions.includes(perm);
  // Facturable : commande confirmée et non annulée, aucune facture en cours (brouillon, émise, en litige), « Émettre / annuler des factures ».
  const canInvoice =
    INVOICEABLE_ORDER.includes(o.status) && !!invoices.data && !invoices.data.some((i) => INVOICE_IN_PROGRESS.includes(i.status)) && hasHere('invoices.manage');
  const reserved = (l: CustomerOrderDetail['lines'][number]) => l.reservations.reduce((s, r) => s + n(r.quantity), 0);
  const depositsAvailable = o.deposits.reduce((s, d) => s + n(d.amount) - n(d.refundedAmount), 0);
  // Modification : brouillon seulement, droit « Gérer les commandes clients » (canManage, calculé par le serveur).
  const canEdit = o.status === 'DRAFT' && o.canManage;
  const canConfirm = o.status === 'DRAFT' && o.canManage;
  const canCancel = CANCELLABLE.includes(o.status) && o.canManage;
  const busy = confirm.isPending || cancel.isPending || advance.isPending || handOver.isPending;
  const activeDelivery = o.deliveries.find((d) => ACTIVE_DELIVERY.includes(d.status));
  // Sortie d'une commande prête : remise directe, ou livraison (jamais les deux à la fois).
  const canHandOver = o.status === 'READY' && o.canManage && !activeDelivery;
  const canPlanDelivery = o.status === 'READY' && o.canManage && !activeDelivery;
  const nextStep = o.canManage ? (o.status === 'CONFIRMED' ? { to: 'IN_PREPARATION' as const, label: 'Mettre en préparation' } : o.status === 'IN_PREPARATION' ? { to: 'READY' as const, label: 'Marquer comme prête' } : null) : null;
  const productLines = o.lines.filter((l) => l.kind === 'PRODUCT' && !l.madeToOrder);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button variant="secondary" onClick={onEdit} disabled={busy}>
              <Pencil className="size-4" /> Modifier le brouillon
            </Button>
          )}
          {canConfirm && (
            <Button onClick={() => setConfirming(true)} disabled={busy}>
              <CheckCircle2 className="size-4" /> Confirmer
            </Button>
          )}
          {nextStep && (
            <Button loading={advance.isPending} disabled={busy} onClick={() => !advance.isPending && advance.mutate(nextStep.to)}>
              <CheckCircle2 className="size-4" /> {nextStep.label}
            </Button>
          )}
          {canPlanDelivery && (
            <Button variant="secondary" disabled={busy} onClick={() => setPlanningDelivery(true)}>
              <Truck className="size-4" /> Prévoir une livraison
            </Button>
          )}
          {canHandOver && (
            <Button disabled={busy} onClick={() => setHandingOver(true)}>
              <HandHelping className="size-4" /> Remettre au client
            </Button>
          )}
          {canInvoice && (
            <Button variant="secondary" disabled={busy || createInvoice.isPending} onClick={() => setInvoicing(true)}>
              <FileText className="size-4" /> Créer la facture
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" loading={cancel.isPending} disabled={busy} onClick={() => reason.ask(`Annuler la commande ${o.number}`, (r) => cancel.mutate(r))}>
              <Ban className="size-4" /> Annuler la commande
            </Button>
          )}
        </div>
      </div>
      {cancel.error && <Alert>{(cancel.error as ApiError).message}</Alert>}
      {advance.error && <Alert>{(advance.error as ApiError).message}</Alert>}
      {draftInvoice && (
        <Alert tone="success">
          Brouillon de facture créé : {INVOICE_STATUS[draftInvoice.status].label.toLowerCase()}, sans numéro, total {formatXOF(draftInvoice.total)}. Il s’émet depuis{' '}
          <Link className="underline" to="/factures-clients">
            Facturation
          </Link>
          .
        </Alert>
      )}
      <Modal open={invoicing} title={`Facturer la commande ${o.number}`} onClose={() => !createInvoice.isPending && setInvoicing(false)}>
        <div className="space-y-3 text-sm">
          <p>
            Facture de <strong>{o.customer?.name}</strong> pour <strong>{formatXOF(o.total)}</strong> : lignes, prix et TVA repris de la commande (frais de livraison éventuels ajoutés par le serveur).
          </p>
          <p>Elle est créée en brouillon, sans numéro : le numéro FAC est attribué à l’émission.</p>
          {createInvoice.error && <Alert>{(createInvoice.error as ApiError).message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={createInvoice.isPending} onClick={() => setInvoicing(false)}>
              Retour
            </Button>
            <Button loading={createInvoice.isPending} onClick={() => !createInvoice.isPending && createInvoice.mutate(o)}>
              Créer le brouillon
            </Button>
          </div>
        </div>
      </Modal>
      {o.status === 'READY' && activeDelivery && <Alert tone="info">Livraison {activeDelivery.number} prévue : la commande sortira à sa livraison (pas de remise directe).</Alert>}
      {planningDelivery && <DeliveryForm order={o} onClose={() => setPlanningDelivery(false)} />}
      <Modal open={handingOver} title={`Remettre la commande ${o.number} au client`} onClose={() => !handOver.isPending && setHandingOver(false)}>
        <div className="space-y-3 text-sm">
          <p>
            Remise sur place à <strong>{o.customer?.name}</strong> : le stock réservé sort définitivement et la commande passe « livrée ».
          </p>
          {handOver.error && <Alert>{(handOver.error as ApiError).message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={handOver.isPending} onClick={() => setHandingOver(false)}>
              Retour
            </Button>
            <Button loading={handOver.isPending} onClick={() => !handOver.isPending && handOver.mutate()}>
              Confirmer la remise
            </Button>
          </div>
        </div>
      </Modal>
      {reason.dialog}
      <Modal open={confirming} title={`Confirmer la commande ${o.number}`} onClose={() => !confirm.isPending && setConfirming(false)}>
        <div className="space-y-3 text-sm">
          <p>
            Client <strong>{o.customer?.name}</strong> · total <strong>{formatXOF(o.total)}</strong>.
          </p>
          <p>La confirmation fige la commande (plus de modification) et réserve le stock des produits :</p>
          {productLines.length > 0 ? (
            <ul className="list-inside list-disc text-stone-700">
              {productLines.map((l) => (
                <li key={l.id}>
                  {l.label} × {qty(l.quantity)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-stone-500">Aucun produit pris en stock (frais ou fabrication à la demande).</p>
          )}
          {confirm.error && <Alert>{(confirm.error as ApiError).message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={confirm.isPending} onClick={() => setConfirming(false)}>
              Retour
            </Button>
            <Button loading={confirm.isPending} onClick={() => !confirm.isPending && confirm.mutate()}>
              Confirmer la commande
            </Button>
          </div>
        </div>
      </Modal>
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            Commande client {o.number} <StatusBadge map={CUSTOMER_ORDER_STATUS} status={o.status} />
            {o.kind === 'EVENT' && <Badge tone="blue">Événement</Badge>}
          </span>
        }
      >
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Info label="Client">
            <strong>{o.customer?.name ?? '—'}</strong>
            {o.customer?.phone ? ` · ${o.customer.phone}` : ''}
          </Info>
          <Info label="Établissement">{est ? `${est.code} — ${est.name}` : '—'}</Info>
          <Info label="Origine">{o.quote ? `Devis ${o.quote.number} (accepté)` : 'Saisie directe'}</Info>
          <Info label="Pour le">{o.dueAt ? formatDateTime(o.dueAt) : '—'}</Info>
          <Info label="Créée le">{`${formatDateTime(o.createdAt)}${o.createdBy ? ` par ${o.createdBy}` : ''}`}</Info>
          <Info label="Confirmée le">{o.confirmedAt ? formatDateTime(o.confirmedAt) : '—'}</Info>
          {o.notes && <div className="text-stone-600 sm:col-span-2">{o.notes}</div>}
        </dl>
        {o.status === 'CANCELLED' && (
          <div className="mt-3">
            <Alert>
              Annulée le {formatDateTime(o.cancelledAt)}
              {o.cancelledBy ? ` par ${o.cancelledBy}` : ''} : {o.cancelReason}
            </Alert>
          </div>
        )}
      </Card>

      {o.event && (
        <Card title="Événement">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <Info label="Type">{EVENT_TYPES[o.event.eventType]}</Info>
            <Info label="Date">{formatDateTime(o.event.eventDate)}</Info>
            {o.event.venue && <Info label="Lieu">{o.event.venue}</Info>}
            {o.event.guests !== null && <Info label="Invités">{o.event.guests}</Info>}
            {(o.event.contactName || o.event.contactPhone) && <Info label="Contact sur place">{[o.event.contactName, o.event.contactPhone].filter(Boolean).join(' · ')}</Info>}
            {o.event.notes && <div className="text-stone-600 sm:col-span-2">{o.event.notes}</div>}
          </dl>
        </Card>
      )}

      <Card title="Lignes">
        <Table head={['Désignation', 'Qté', 'Prix TTC', 'TVA', 'Total TTC', 'Réservé', 'Livré']} empty={o.lines.length === 0}>
          {o.lines.map((l) => (
            <tr key={l.id}>
              <Td>
                {l.label} {l.kind === 'FEE' && <Badge>Frais</Badge>} {l.madeToOrder && <Badge tone="orange">Fabriqué à la demande</Badge>}
                {l.productCode && <div className="font-mono text-xs text-stone-500">{l.productCode}</div>}
                {l.madeToOrder && <div className="text-xs text-stone-500">{l.productionOrderId ? 'Ordre de production lancé' : 'Production non lancée'}</div>}
                {l.note && <div className="text-xs text-stone-500">{l.note}</div>}
              </Td>
              <Td>{qty(l.quantity)}</Td>
              <Td className="whitespace-nowrap">{formatXOF(l.unitPrice)}</Td>
              <Td className="whitespace-nowrap">{n(l.taxRate) > 0 ? `${n(l.taxRate)} %` : '—'}</Td>
              <Td className="whitespace-nowrap font-semibold">{formatXOF(l.lineTotal)}</Td>
              <Td className="whitespace-nowrap text-xs">{l.kind === 'FEE' ? '—' : reserved(l) > 0 ? `${qty(String(reserved(l)))} (${l.reservations.length} lot${l.reservations.length > 1 ? 's' : ''})` : '0'}</Td>
              <Td className="whitespace-nowrap text-xs">{l.kind === 'FEE' ? '—' : qty(l.deliveredQuantity)}</Td>
            </tr>
          ))}
        </Table>
        <div className="mt-3 ml-auto max-w-sm space-y-1 text-sm">
          <div className="flex justify-between text-base font-bold">
            <span>Total TTC</span>
            <span>{formatXOF(o.total)}</span>
          </div>
          {n(o.taxTotal) > 0 && (
            <div className="flex justify-between">
              <span>dont TVA</span>
              <span>{formatXOF(o.taxTotal)}</span>
            </div>
          )}
        </div>
      </Card>

      <Card title="Facturation">
        <div className="space-y-3">
          <OrderInvoices orderId={o.id} />
          <div>
            <h3 className="mb-1 text-sm font-semibold">Acomptes</h3>
            {o.deposits.length === 0 ? (
              <p className="text-sm text-stone-500">Aucun acompte.</p>
            ) : (
              <>
                <Table head={['Acompte', 'Date', 'Montant', 'Remboursé', 'Statut']}>
                  {o.deposits.map((d) => (
                    <tr key={d.id}>
                      <Td className="font-mono text-xs font-semibold">{d.number}</Td>
                      <Td className="whitespace-nowrap">{formatDate(d.createdAt)}</Td>
                      <Td className="whitespace-nowrap">{formatXOF(d.amount)}</Td>
                      <Td className="whitespace-nowrap">{formatXOF(d.refundedAmount)}</Td>
                      <Td className="text-xs">{DEPOSIT_STATUS[d.status] ?? d.status}</Td>
                    </tr>
                  ))}
                </Table>
                <p className="mt-1 text-xs text-stone-500">Acomptes versés, nets des remboursements : {formatXOF(depositsAvailable)}.</p>
              </>
            )}
          </div>
        </div>
      </Card>

      {o.deliveries.length > 0 && (
        <Card title="Livraisons">
          <Table head={['Livraison', 'Prévue', 'Adresse', 'Frais', 'Statut', '']}>
            {o.deliveries.map((d) => (
              <tr key={d.id}>
                <Td className="font-mono text-xs font-semibold">{d.number}</Td>
                <Td className="whitespace-nowrap">{d.scheduledAt ? formatDateTime(d.scheduledAt) : '—'}</Td>
                <Td className="text-xs">
                  {d.address}
                  {d.phone ? ` · ${d.phone}` : ''}
                </Td>
                <Td className="whitespace-nowrap">{n(d.fee) > 0 ? formatXOF(d.fee) : '—'}</Td>
                <Td>
                  <StatusBadge map={DELIVERY_STATUS} status={d.status} />
                  {d.failedReason && <div className="text-xs text-red-700">{d.failedReason}</div>}
                  {d.cancelReason && <div className="text-xs text-stone-500">{d.cancelReason}</div>}
                </Td>
                <Td>{ACTIVE_DELIVERY.includes(d.status) && <DeliveryActions order={o} delivery={d} />}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card title="Historique">
        <Table head={['Date', 'Étape', 'Motif', 'Par']} empty={o.history.length === 0}>
          {o.history.map((h) => (
            <tr key={h.id}>
              <Td className="whitespace-nowrap">{formatDateTime(h.createdAt)}</Td>
              <Td>
                {h.fromStatus ? `${CUSTOMER_ORDER_STATUS[h.fromStatus].label} → ` : ''}
                {CUSTOMER_ORDER_STATUS[h.toStatus].label}
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
