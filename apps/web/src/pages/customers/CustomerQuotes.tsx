import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCircle2, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { CustomerPicker } from '../../components/CustomerPicker';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Product, qty } from '../../lib/catalog-types';
import type { Customer } from '../../lib/customer-types';
import { formatDate, formatDateTime, formatXOF } from '../../lib/format';
import { CUSTOMER_DOCUMENT_KINDS, CUSTOMER_ORDER_STATUS, CustomerDocumentKind, CustomerOrderDetail, EVENT_TYPES, EventType } from '../../lib/order-types';
import { QUOTE_LIST_LIMIT, QUOTE_READ, QUOTE_STATUS, QUOTE_WRITE, QuoteDetail, QuoteRow } from '../../lib/quote-types';
import { RequirePermission, StatusBadge, useReasonDialog, useRequestId } from '../stock/shared';

const n = (v: string | number | null | undefined) => Number(v ?? 0);

/** Statut affiché : « Expiré » (calculé par le serveur) prime sur « Envoyé ». */
function QuoteStatusBadge({ q }: { q: Pick<QuoteRow, 'status' | 'expired'> }) {
  return q.expired ? <Badge tone="orange">Expiré</Badge> : <StatusBadge map={QUOTE_STATUS} status={q.status} />;
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="inline text-stone-500">{label} : </dt>
      <dd className="inline">{children}</dd>
    </div>
  );
}

/** Module 7 — Devis clients : consultation, création et modification des brouillons. */
export function CustomerQuotesPage() {
  const { establishmentId, can, canAnywhere } = useAuth();
  const [openId, setOpenId] = useState<string | null>(null);
  // Formulaire : nouveau devis, ou modification d'un brouillon (identifiant).
  const [editing, setEditing] = useState<'new' | string | null>(null);
  // Filtres conservés au retour de la fiche.
  const [estFilter, setEstFilter] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const canCreate = establishmentId ? can(QUOTE_WRITE) : canAnywhere(QUOTE_WRITE);
  return (
    <>
      <PageHeader
        title="Devis clients"
        subtitle="Devis, envoi et acceptation (un devis accepté crée la commande client)"
        actions={
          canCreate &&
          !editing && (
            <Button
              onClick={() => {
                setOpenId(null);
                setEditing('new');
              }}
            >
              <Plus className="size-4" /> Nouveau devis
            </Button>
          )
        }
      />
      <RequirePermission permission={QUOTE_READ}>
        {editing ? (
          <QuoteForm
            quoteId={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={(id) => {
              setEditing(null);
              setOpenId(id);
            }}
          />
        ) : openId ? (
          <QuoteView id={openId} onBack={() => setOpenId(null)} onEdit={() => setEditing(openId)} />
        ) : (
          <QuoteList filters={{ estFilter, customer, status, search }} set={{ setEstFilter, setCustomer, setStatus, setSearch }} onOpen={setOpenId} />
        )}
      </RequirePermission>
    </>
  );
}

function QuoteList({
  filters,
  set,
  onOpen,
}: {
  filters: { estFilter: string; customer: Customer | null; status: string; search: string };
  set: { setEstFilter: (e: string) => void; setCustomer: (c: Customer | null) => void; setStatus: (s: string) => void; setSearch: (s: string) => void };
  onOpen: (id: string) => void;
}) {
  // Établissement : celui du menu (en-tête de requête) ; en vue groupe, filtre facultatif parmi les établissements lisibles.
  const { me, establishmentId } = useAuth();
  const readable = (me?.establishments ?? []).filter((e) => QUOTE_READ.some((p) => me?.globalPermissions.includes(p) || e.permissions.includes(p)));
  const params = new URLSearchParams();
  if (!establishmentId && filters.estFilter) params.set('establishmentId', filters.estFilter);
  if (filters.customer) params.set('customerId', filters.customer.id);
  if (filters.status) params.set('status', filters.status);
  const { data, isLoading, error } = useQuery({
    queryKey: ['quotes', 'list', establishmentId, params.toString()],
    queryFn: () => api.get<QuoteRow[]>(`/quotes${params.size ? `?${params}` : ''}`),
  });
  // Numéro : recherche sur les lignes reçues (l'API ne la propose pas).
  const term = filters.search.trim().toLowerCase();
  const rows = (data ?? []).filter((q) => !term || q.number.toLowerCase().includes(term));
  const estCode = (id: string) => me?.establishments.find((e) => e.id === id)?.code ?? '—';
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)_12rem_12rem] md:items-end">
        <Field label="Établissement">
          {establishmentId ? (
            <Input disabled value={`${estCode(establishmentId)} (menu)`} />
          ) : (
            <Select value={filters.estFilter} onChange={(e) => set.setEstFilter(e.target.value)}>
              <option value="">Tous</option>
              {readable.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.code} — {e.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div>
          <span className="mb-1 block text-sm font-medium text-stone-700">Client</span>
          <CustomerPicker establishmentId={establishmentId ?? ''} value={filters.customer} onChange={set.setCustomer} showCredit={false} />
        </div>
        <Field label="Statut" hint="« Expiré » : envoyé, validité dépassée">
          <Select value={filters.status} onChange={(e) => set.setStatus(e.target.value)}>
            <option value="">Tous les statuts</option>
            {Object.entries(QUOTE_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="N° de devis">
          <Input value={filters.search} onChange={(e) => set.setSearch(e.target.value)} placeholder="Rechercher…" />
        </Field>
      </div>
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{(error as ApiError).message}</Alert>
      ) : (
        <>
          <Table head={['N°', 'Créé le', 'Étab.', 'Client', 'Type', 'Valable jusqu’au', 'Total TTC', 'Statut', 'Commande']} empty={rows.length === 0}>
            {rows.map((q) => (
              <tr key={q.id} className="cursor-pointer hover:bg-stone-50" onClick={() => onOpen(q.id)}>
                <Td className="whitespace-nowrap font-mono text-xs font-semibold">{q.number}</Td>
                <Td className="whitespace-nowrap">{formatDate(q.createdAt)}</Td>
                <Td>{estCode(q.establishmentId)}</Td>
                <Td>{q.customer?.name ?? '—'}</Td>
                <Td>
                  {q.kind === 'EVENT' ? (
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge tone="blue">Événement</Badge>
                      {q.event && <span className="text-xs text-stone-500">{EVENT_TYPES[q.event.eventType]}</span>}
                    </span>
                  ) : (
                    CUSTOMER_DOCUMENT_KINDS.STANDARD
                  )}
                </Td>
                <Td className="whitespace-nowrap">{formatDate(q.validUntil)}</Td>
                <Td className="whitespace-nowrap font-semibold">{formatXOF(q.total)}</Td>
                <Td>
                  <QuoteStatusBadge q={q} />
                </Td>
                <Td className="whitespace-nowrap font-mono text-xs">{q.order?.number ?? '—'}</Td>
              </tr>
            ))}
          </Table>
          {data?.length === QUOTE_LIST_LIMIT && (
            <p className="mt-2 text-xs text-stone-500">
              {QUOTE_LIST_LIMIT} devis les plus récents reçus (limite du serveur, sans pagination) : affinez avec l’établissement, le client ou le statut.
            </p>
          )}
        </>
      )}
    </Card>
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
const newLine = (kind: 'PRODUCT' | 'FEE'): LineDraft => ({ key: `q${++lineSeq}`, kind, productId: '', quantity: '1', madeToOrder: false, label: '', unitPrice: '', taxRate: '0', note: '' });

/** Date-heure saisie (heure d'Abidjan = UTC) → ISO ; et l'inverse pour l'affichage dans le champ. */
const toIso = (local: string) => (local ? `${local}:00.000Z` : null);
const toLocal = (iso: string | null | undefined) => (iso ? iso.slice(0, 16) : '');
/** Date du jour à Abidjan (UTC), comme la contrôle le serveur pour la validité. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Brouillon de devis : POST /quotes (création), PATCH /quotes/:id (modification, brouillon
 * seulement). Prix, TVA et libellé d'une ligne produit viennent du catalogue côté serveur :
 * l'écran n'en montre qu'une estimation. Aucune commande ni réservation avant l'acceptation.
 */
function QuoteForm({ quoteId, onCancel, onSaved }: { quoteId: string | null; onCancel: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const { me, establishmentId: selected } = useAuth();
  // Même identifiant à chaque tentative de ce formulaire : jamais deux devis pour un double clic.
  const requestId = useRequestId();
  const existing = useQuery({ queryKey: ['quotes', 'detail', quoteId], queryFn: () => api.get<QuoteDetail>(`/quotes/${quoteId}`), enabled: !!quoteId });
  const q = existing.data;
  const editing = !!quoteId;

  const allowed = (me?.establishments ?? []).filter((e) => me?.globalPermissions.includes(QUOTE_WRITE) || e.permissions.includes(QUOTE_WRITE));
  const [estChoice, setEstChoice] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [kind, setKind] = useState<CustomerDocumentKind>('STANDARD');
  const [validUntil, setValidUntil] = useState('');
  const [desiredAt, setDesiredAt] = useState('');
  const [notes, setNotes] = useState('');
  const [event, setEvent] = useState({ eventType: 'BIRTHDAY' as EventType, eventDate: '', venue: '', guests: '', contactName: '', contactPhone: '', notes: '' });
  const [lines, setLines] = useState<LineDraft[]>([newLine('PRODUCT')]);
  // Brouillon existant : le formulaire reprend ses valeurs une fois chargé.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (q && loadedFor !== q.id) {
    setLoadedFor(q.id);
    setKind(q.kind);
    setValidUntil(q.validUntil.slice(0, 10));
    setDesiredAt(toLocal(q.desiredAt));
    setNotes(q.notes ?? '');
    if (q.event)
      setEvent({
        eventType: q.event.eventType,
        eventDate: toLocal(q.event.eventDate),
        venue: q.event.venue ?? '',
        guests: q.event.guests != null ? String(q.event.guests) : '',
        contactName: q.event.contactName ?? '',
        contactPhone: q.event.contactPhone ?? '',
        notes: q.event.notes ?? '',
      });
    setLines(
      q.lines.map((l) => ({
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
  const establishmentId = editing ? q?.establishmentId ?? '' : selected ?? estChoice;

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
      const x = Number(l.quantity);
      if (!(x > 0) || Math.round(x * 10000) !== x * 10000) return `Ligne ${i + 1} : quantité positive (4 décimales au plus).`;
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
      : !validUntil
        ? 'Date de validité obligatoire.'
        : validUntil < today()
          ? 'Date de validité déjà dépassée.'
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
        ? // Établissement, client et type ne se modifient pas (contrat PATCH /quotes/:id).
          api.patch<QuoteDetail>(`/quotes/${quoteId}`, {
            validUntil,
            desiredAt: toIso(desiredAt),
            notes: notes.trim() || null,
            ...(kind === 'EVENT' ? { event: payloadEvent() } : {}),
            lines: payloadLines(),
          })
        : api.post<QuoteDetail>('/quotes', {
            clientRequestId: requestId,
            establishmentId,
            customerId: customer!.id,
            kind,
            validUntil,
            ...(desiredAt ? { desiredAt: toIso(desiredAt) } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            ...(kind === 'EVENT' ? { event: payloadEvent() } : {}),
            lines: payloadLines(),
          }),
    onSuccess: (saved) => {
      // La réponse est la fiche du devis : elle s'affiche sans relecture.
      qc.setQueryData(['quotes', 'detail', saved.id], saved);
      qc.invalidateQueries({ queryKey: ['quotes', 'list'] });
      onSaved(saved.id);
    },
  });

  if (editing && existing.isLoading) return <Spinner />;
  if (editing && (existing.error || !q)) return <Alert>{(existing.error as ApiError | null)?.message ?? 'Devis introuvable'}</Alert>;
  if (editing && q && (q.status !== 'DRAFT' || !q.canManage))
    return (
      <div className="space-y-3">
        <Alert>{q.status !== 'DRAFT' ? `Devis ${q.number} ${QUOTE_STATUS[q.status].label.toLowerCase()} : il ne se modifie plus.` : 'Vous ne pouvez pas modifier ce devis.'}</Alert>
        <Button variant="ghost" onClick={onCancel}>
          <ArrowLeft className="size-4" /> Retour
        </Button>
      </div>
    );

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error && !save.isPending) save.mutate();
      }}
    >
      <Card title={editing ? `Modifier le brouillon ${q?.number}` : 'Nouveau devis client'}>
        <div className="grid gap-3 md:grid-cols-2">
          {editing ? (
            <div className="text-sm md:col-span-2">
              Établissement : <strong>{me?.establishments.find((e) => e.id === q?.establishmentId)?.name ?? '—'}</strong>
              <br />
              Client : <strong>{q?.customer?.name}</strong> · Type : <strong>{CUSTOMER_DOCUMENT_KINDS[q!.kind]}</strong>
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
              <Field label="Type de devis">
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
          <Field label="Valable jusqu’au">
            <Input type="date" required min={today()} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
          <Field label="Souhaité pour le (date et heure, facultatif)">
            <Input type="datetime-local" value={desiredAt} onChange={(e) => setDesiredAt(e.target.value)} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Notes (facultatif)">
              <Textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
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
        <Button type="button" variant="ghost" disabled={save.isPending} onClick={onCancel}>
          Annuler
        </Button>
        <Button type="submit" loading={save.isPending} disabled={!!error}>
          {editing ? 'Enregistrer le brouillon' : 'Créer le devis (brouillon)'}
        </Button>
      </div>
    </form>
  );
}

function QuoteView({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const [sending, setSending] = useState(false);
  const { data: q, isLoading, error } = useQuery({ queryKey: ['quotes', 'detail', id], queryFn: () => api.get<QuoteDetail>(`/quotes/${id}`) });
  // Envoi : brouillon → envoyé ; le serveur renvoie la fiche, affichée sans relecture.
  const send = useMutation({
    mutationFn: () => api.post<QuoteDetail>(`/quotes/${id}/send`),
    onSuccess: (updated) => {
      qc.setQueryData(['quotes', 'detail', id], updated);
      qc.invalidateQueries({ queryKey: ['quotes', 'list'] });
      setSending(false);
    },
  });
  // Acceptation : le serveur crée la commande, la confirme (réservation du stock) et renvoie les deux.
  const [accepting, setAccepting] = useState(false);
  const accept = useMutation({
    mutationFn: () => api.post<{ quote: QuoteDetail; order: CustomerOrderDetail }>(`/quotes/${id}/accept`),
    onSuccess: ({ quote, order }) => {
      qc.setQueryData(['quotes', 'detail', id], quote);
      qc.setQueryData(['customer-orders', 'detail', order.id], order);
      qc.invalidateQueries({ queryKey: ['quotes', 'list'] });
      qc.invalidateQueries({ queryKey: ['customer-orders', 'list'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
      setAccepting(false);
    },
  });
  // Refus : motif obligatoire (3 à 500 caractères), demandé avant tout appel.
  const reason = useReasonDialog();
  const refuse = useMutation({
    mutationFn: (r: string) => api.post<QuoteDetail>(`/quotes/${id}/refuse`, { reason: r }),
    onSuccess: (updated) => {
      qc.setQueryData(['quotes', 'detail', id], updated);
      qc.invalidateQueries({ queryKey: ['quotes', 'list'] });
    },
  });
  const busy = send.isPending || accept.isPending || refuse.isPending;
  const back = (
    <Button variant="ghost" onClick={onBack}>
      <ArrowLeft className="size-4" /> Retour à la liste
    </Button>
  );
  if (isLoading) return <Spinner />;
  if (error || !q)
    return (
      <div className="space-y-3">
        {back}
        <Alert>{(error as ApiError | null)?.message ?? 'Devis introuvable'}</Alert>
      </div>
    );
  const est = me?.establishments.find((e) => e.id === q.establishmentId);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {back}
        {q.status === 'DRAFT' && q.canManage && (
          <>
            <Button variant="secondary" disabled={send.isPending} onClick={onEdit}>
              <Pencil className="size-4" /> Modifier le brouillon
            </Button>
            <Button disabled={send.isPending} onClick={() => setSending(true)}>
              <Send className="size-4" /> Envoyer
            </Button>
          </>
        )}
        {q.status === 'SENT' && !q.expired && q.canManage && (
          <Button disabled={busy} onClick={() => setAccepting(true)}>
            <CheckCircle2 className="size-4" /> Accepter
          </Button>
        )}
        {q.status === 'SENT' && q.canManage && (
          <Button variant="secondary" loading={refuse.isPending} disabled={busy} onClick={() => reason.ask(`Refuser le devis ${q.number}`, (r) => !refuse.isPending && refuse.mutate(r))}>
            <Ban className="size-4" /> Refuser
          </Button>
        )}
      </div>
      {refuse.error && <Alert>{(refuse.error as ApiError).message}</Alert>}
      {reason.dialog}
      {accept.data && (
        <Alert tone="info">
          Devis accepté : commande {accept.data.order.number} créée ({CUSTOMER_ORDER_STATUS[accept.data.order.status].label.toLowerCase()}), à suivre dans « Commandes clients ».
        </Alert>
      )}
      <Modal open={accepting} title={`Accepter le devis ${q.number}`} onClose={() => !accept.isPending && setAccepting(false)}>
        <div className="space-y-3 text-sm">
          <p>
            Acceptation par <strong>{q.customer?.name}</strong> pour {formatXOF(q.total)}.
          </p>
          <p>L’acceptation crée immédiatement une commande client, aux prix du devis, et la confirme : le stock des produits est réservé. Elle est définitive.</p>
          {accept.error && <Alert>{(accept.error as ApiError).message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={accept.isPending} onClick={() => setAccepting(false)}>
              Retour
            </Button>
            <Button loading={accept.isPending} onClick={() => !accept.isPending && accept.mutate()}>
              Confirmer l’acceptation
            </Button>
          </div>
        </div>
      </Modal>
      <Modal open={sending} title={`Envoyer le devis ${q.number}`} onClose={() => !send.isPending && setSending(false)}>
        <div className="space-y-3 text-sm">
          <p>
            Envoi à <strong>{q.customer?.name}</strong>, valable jusqu’au {formatDate(q.validUntil)}, pour {formatXOF(q.total)}.
          </p>
          <p>Après l’envoi, le devis ne pourra plus être modifié : il pourra seulement être accepté ou refusé.</p>
          {send.error && <Alert>{(send.error as ApiError).message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={send.isPending} onClick={() => setSending(false)}>
              Retour
            </Button>
            <Button loading={send.isPending} onClick={() => !send.isPending && send.mutate()}>
              Confirmer l’envoi
            </Button>
          </div>
        </div>
      </Modal>
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            Devis {q.number} <QuoteStatusBadge q={q} />
            {q.kind === 'EVENT' && <Badge tone="blue">Événement</Badge>}
          </span>
        }
      >
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Info label="Client">
            <strong>{q.customer?.name ?? '—'}</strong>
            {q.customer?.phone ? ` · ${q.customer.phone}` : ''}
          </Info>
          <Info label="Établissement">{est ? `${est.code} — ${est.name}` : '—'}</Info>
          <Info label="Valable jusqu’au">{formatDate(q.validUntil)}</Info>
          <Info label="Souhaité pour le">{q.desiredAt ? formatDateTime(q.desiredAt) : '—'}</Info>
          <Info label="Créé le">{`${formatDateTime(q.createdAt)}${q.createdBy ? ` par ${q.createdBy}` : ''}`}</Info>
          <Info label="Envoyé le">{q.sentAt ? formatDateTime(q.sentAt) : '—'}</Info>
          {q.acceptedAt && <Info label="Accepté le">{formatDateTime(q.acceptedAt)}</Info>}
          {q.refusedAt && <Info label="Refusé le">{formatDateTime(q.refusedAt)}</Info>}
          {q.notes && <div className="text-stone-600 sm:col-span-2">{q.notes}</div>}
        </dl>
        {q.expired && (
          <div className="mt-3">
            <Alert tone="info">Date de validité dépassée : ce devis ne peut plus être accepté.</Alert>
          </div>
        )}
        {q.status === 'REFUSED' && q.refuseReason && (
          <div className="mt-3">
            <Alert>Refusé : {q.refuseReason}</Alert>
          </div>
        )}
      </Card>

      {q.order && (
        <Card title="Commande client issue du devis">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono font-semibold">{q.order.number}</span>
            <StatusBadge map={CUSTOMER_ORDER_STATUS} status={q.order.status} />
            <span className="text-stone-500">— à suivre dans « Commandes clients ».</span>
          </div>
        </Card>
      )}

      {q.event && (
        <Card title="Événement">
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <Info label="Type">{EVENT_TYPES[q.event.eventType]}</Info>
            <Info label="Date">{formatDateTime(q.event.eventDate)}</Info>
            {q.event.venue && <Info label="Lieu">{q.event.venue}</Info>}
            {q.event.guests != null && <Info label="Invités">{q.event.guests}</Info>}
            {(q.event.contactName || q.event.contactPhone) && <Info label="Contact sur place">{[q.event.contactName, q.event.contactPhone].filter(Boolean).join(' · ')}</Info>}
            {q.event.notes && <div className="text-stone-600 sm:col-span-2">{q.event.notes}</div>}
          </dl>
        </Card>
      )}

      <Card title="Lignes">
        <Table head={['Désignation', 'Qté', 'Prix TTC', 'TVA', 'Total TTC']} empty={q.lines.length === 0}>
          {q.lines.map((l) => (
            <tr key={l.id}>
              <Td>
                {l.label} {l.kind === 'FEE' && <Badge>Frais</Badge>} {l.madeToOrder && <Badge tone="orange">Fabriqué à la demande</Badge>}
                {l.productCode && <div className="font-mono text-xs text-stone-500">{l.productCode}</div>}
                {l.note && <div className="text-xs text-stone-500">{l.note}</div>}
              </Td>
              <Td>{qty(l.quantity)}</Td>
              <Td className="whitespace-nowrap">{formatXOF(l.unitPrice)}</Td>
              <Td className="whitespace-nowrap">{n(l.taxRate) > 0 ? `${n(l.taxRate)} %` : '—'}</Td>
              <Td className="whitespace-nowrap font-semibold">{formatXOF(l.lineTotal)}</Td>
            </tr>
          ))}
        </Table>
        <div className="mt-3 ml-auto max-w-sm space-y-1 text-sm">
          <div className="flex justify-between text-base font-bold">
            <span>Total TTC</span>
            <span>{formatXOF(q.total)}</span>
          </div>
          {n(q.taxTotal) > 0 && (
            <div className="flex justify-between">
              <span>dont TVA</span>
              <span>{formatXOF(q.taxTotal)}</span>
            </div>
          )}
        </div>
      </Card>

      <Card title="Historique">
        <Table head={['Date', 'Étape', 'Motif', 'Par']} empty={q.history.length === 0}>
          {q.history.map((h) => (
            <tr key={h.id}>
              <Td className="whitespace-nowrap">{formatDateTime(h.createdAt)}</Td>
              <Td>
                {h.fromStatus ? `${QUOTE_STATUS[h.fromStatus].label} → ` : ''}
                {QUOTE_STATUS[h.toStatus].label}
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
