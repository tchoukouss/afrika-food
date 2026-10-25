import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, Plus, Undo2, UserCheck } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { CustomerPicker } from '../../components/CustomerPicker';
import { Alert, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Customer } from '../../lib/customer-types';
import { DEPOSIT_LIST_LIMIT, DEPOSIT_READ, DEPOSIT_STATUS, DepositDetail, DepositReceipt, DepositRow } from '../../lib/deposit-types';
import { formatDateTime, formatXOF } from '../../lib/format';
import { CUSTOMER_ORDER_STATUS, CustomerOrderRow } from '../../lib/order-types';
import { CashSessionDetail, REFERENCE_REQUIRED } from '../../lib/sales-types';
import { PAYMENT_METHODS } from '../../lib/stock-types';
import { RequirePermission, StatusBadge, useRequestId } from '../stock/shared';

const n = (v: string | number) => Number(v);
const PAY = 'payments.manage';
/** Virement et chèque : enregistrés hors caisse ; tous les autres moyens passent par la session de caisse ouverte de l'encaisseur (règle du serveur). */
const OFF_REGISTER = new Set(['BANK_TRANSFER', 'CHEQUE']);
const MAX_AMOUNT = 1_000_000_000;
/** Commandes qui acceptent un acompte (ni livrée, ni annulée, ni terminée) : règle du serveur. */
const DEPOSIT_ORDER_STATUSES = ['DRAFT', 'CONFIRMED', 'IN_PREPARATION', 'READY'];
const method = (m: string) => PAYMENT_METHODS[m] ?? m;
/** Session : seul son identifiant est renvoyé ; sans session = virement ou chèque hors caisse. */
const sessionText = (sessionId: string | null) => (sessionId ? 'En caisse' : 'Hors caisse');

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="inline text-stone-500">{label} : </dt>
      <dd className="inline">{children}</dd>
    </div>
  );
}

/** Module 7 — Acomptes clients : avances hors chiffre d'affaires, reçu ACP ; création par encaissement immédiat. */
export function CustomerDepositsPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Filtres conservés au retour de la fiche.
  const [estFilter, setEstFilter] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const { establishmentId, can, canAnywhere } = useAuth();
  const canCreate = establishmentId ? can(PAY) : canAnywhere(PAY);
  return (
    <>
      <PageHeader
        title="Acomptes clients"
        subtitle="Avances reçues des clients, imputées ensuite sur leurs factures (reçu ACP, hors chiffre d’affaires)"
        actions={
          canCreate &&
          !openId && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Nouvel acompte
            </Button>
          )
        }
      />
      {creating && (
        <NewDeposit
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      )}
      <RequirePermission permission={DEPOSIT_READ}>
        {openId ? (
          <DepositView id={openId} onBack={() => setOpenId(null)} />
        ) : (
          <DepositList filters={{ estFilter, customer, status, search }} set={{ setEstFilter, setCustomer, setStatus, setSearch }} onOpen={setOpenId} />
        )}
      </RequirePermission>
    </>
  );
}

function DepositList({
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
  const readable = (me?.establishments ?? []).filter((e) => DEPOSIT_READ.some((p) => me?.globalPermissions.includes(p) || e.permissions.includes(p)));
  const params = new URLSearchParams();
  if (!establishmentId && filters.estFilter) params.set('establishmentId', filters.estFilter);
  if (filters.customer) params.set('customerId', filters.customer.id);
  if (filters.status) params.set('status', filters.status);
  const { data, isLoading, error } = useQuery({
    queryKey: ['deposits', 'list', establishmentId, params.toString()],
    queryFn: () => api.get<DepositRow[]>(`/deposits${params.size ? `?${params}` : ''}`),
  });
  // N° d'acompte ou de commande : recherche sur les lignes reçues (l'API ne filtre la commande que par identifiant).
  const term = filters.search.trim().toLowerCase();
  const rows = (data ?? []).filter((d) => !term || d.number.toLowerCase().includes(term) || !!d.order?.number.toLowerCase().includes(term));
  const estCode = (id: string) => me?.establishments.find((e) => e.id === id)?.code ?? '—';
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)_12rem_14rem] md:items-end">
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
        <Field label="Statut">
          <Select value={filters.status} onChange={(e) => set.setStatus(e.target.value)}>
            <option value="">Tous les statuts</option>
            {Object.entries(DEPOSIT_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="N° d’acompte ou de commande">
          <Input value={filters.search} onChange={(e) => set.setSearch(e.target.value)} placeholder="Rechercher…" />
        </Field>
      </div>
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{(error as ApiError).message}</Alert>
      ) : (
        <>
          <Table head={['N°', 'Date', 'Étab.', 'Client', 'Commande', 'Montant', 'Remboursé', 'Statut']} empty={rows.length === 0}>
            {rows.map((d) => (
              <tr key={d.id} className={`cursor-pointer hover:bg-stone-50 ${d.status === 'CANCELLED' ? 'text-stone-400' : ''}`} onClick={() => onOpen(d.id)}>
                <Td className="whitespace-nowrap font-mono text-xs font-semibold">{d.number}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(d.createdAt)}</Td>
                <Td>{estCode(d.establishmentId)}</Td>
                <Td>{d.customer?.name ?? '—'}</Td>
                <Td className="whitespace-nowrap font-mono text-xs">{d.order?.number ?? '—'}</Td>
                <Td className="whitespace-nowrap font-semibold">{formatXOF(d.amount)}</Td>
                <Td className="whitespace-nowrap">{n(d.refundedAmount) > 0 ? formatXOF(d.refundedAmount) : '—'}</Td>
                <Td>
                  <StatusBadge map={DEPOSIT_STATUS} status={d.status} />
                </Td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-xs text-stone-500">La part imputée sur les factures et le disponible figurent dans la fiche de chaque acompte.</p>
          {data?.length === DEPOSIT_LIST_LIMIT && (
            <p className="mt-1 text-xs text-stone-500">
              {DEPOSIT_LIST_LIMIT} acomptes les plus récents reçus (limite du serveur, sans pagination) ; la recherche porte sur ces lignes : affinez avec l’établissement, le client ou le statut.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Acompte encaissé maintenant (POST /deposits avec « payment ») : le serveur enregistre le
 * paiement PAY (mouvement de caisse sauf virement et chèque) et l'affecte à l'acompte ACP.
 */
function NewDeposit({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const { me, establishmentId: selected } = useAuth();
  // Même identifiant à chaque tentative de ce formulaire : jamais deux acomptes pour un double clic.
  const requestId = useRequestId();
  // Établissements où l'utilisateur peut encaisser ; « Tout le groupe » : choix obligatoire.
  const allowed = (me?.establishments ?? []).filter((e) => me?.globalPermissions.includes(PAY) || e.permissions.includes(PAY));
  const [estChoice, setEstChoice] = useState('');
  const establishmentId = selected ?? estChoice;
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [orderId, setOrderId] = useState('');
  const [f, setF] = useState({ method: 'CASH', amount: '', reference: '', notes: '' });
  const offRegister = OFF_REGISTER.has(f.method);
  const session = useQuery({
    queryKey: ['cash-sessions', 'current'],
    queryFn: () => api.get<{ session: CashSessionDetail | null }>('/cash-sessions/current', { noEstablishment: true }),
    enabled: !offRegister,
  });
  const s = session.data?.session;
  const sessionOk = !!s && !!establishmentId && s.establishmentId === establishmentId;
  // Commandes en cours du client dans l'établissement (lecture des commandes requise ; sinon acompte sans commande).
  const orders = useQuery({
    queryKey: ['customer-orders', 'list', 'deposit', customer?.id],
    queryFn: () => api.get<CustomerOrderRow[]>(`/customer-orders?customerId=${customer!.id}`),
    enabled: !!customer,
    retry: false,
  });
  const eligible = (orders.data ?? []).filter((o) => o.establishmentId === establishmentId && DEPOSIT_ORDER_STATUSES.includes(o.status));
  const amount = Number(f.amount);
  const referenceRequired = REFERENCE_REQUIRED.has(f.method);
  const error = !establishmentId
    ? 'Choisissez l’établissement.'
    : !customer
      ? 'Choisissez le client.'
      : f.amount.trim() === '' || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT
        ? `Montant en FCFA entier, de 1 à ${formatXOF(MAX_AMOUNT)}.`
        : referenceRequired && !f.reference.trim()
          ? `Référence de la transaction obligatoire pour ${PAYMENT_METHODS[f.method]}.`
          : !offRegister && !sessionOk
            ? 'Session de caisse requise.'
            : null;
  const create = useMutation({
    mutationFn: () =>
      api.post<DepositDetail>('/deposits', {
        clientRequestId: requestId,
        establishmentId,
        customerId: customer!.id,
        ...(orderId ? { orderId } : {}),
        ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
        payment: {
          method: f.method,
          amount,
          // Référence : sans objet pour les espèces ; session : jamais pour virement et chèque.
          ...(f.method !== 'CASH' && f.reference.trim() ? { reference: f.reference.trim() } : {}),
          ...(offRegister ? {} : { sessionId: s?.id }),
        },
      }),
    onSuccess: (d) => {
      // La réponse est la fiche de l'acompte : elle s'affiche sans relecture.
      qc.setQueryData(['deposits', 'detail', d.id], d);
      qc.invalidateQueries({ queryKey: ['deposits', 'list'] });
      qc.invalidateQueries({ queryKey: ['customer-payments', 'list'] });
      if (d.orderId) qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', d.orderId] });
      if (!offRegister) qc.invalidateQueries({ queryKey: ['cash-sessions'] });
      onCreated(d.id);
    },
  });
  return (
    <Modal open title="Nouvel acompte client" onClose={() => !create.isPending && onClose()}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error && !create.isPending) create.mutate();
        }}
      >
        {selected ? (
          <div className="text-sm">
            Établissement : <strong>{me?.establishments.find((e) => e.id === selected)?.name ?? '—'}</strong>
          </div>
        ) : (
          <Field label="Établissement">
            <Select
              required
              value={estChoice}
              onChange={(e) => {
                setEstChoice(e.target.value);
                setOrderId('');
              }}
            >
              <option value="">— Choisir —</option>
              {allowed.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.code} — {e.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div>
          <span className="mb-1 block text-sm font-medium text-stone-700">Client</span>
          <CustomerPicker
            establishmentId={establishmentId}
            value={customer}
            onChange={(c) => {
              setCustomer(c);
              setOrderId('');
            }}
            showCredit={false}
          />
        </div>
        {customer && (
          <Field label="Commande (facultatif)">
            <Select value={orderId} disabled={orders.isLoading || !!orders.error} onChange={(e) => setOrderId(e.target.value)}>
              <option value="">{orders.isLoading ? 'Chargement…' : 'Sans commande (avance libre)'}</option>
              {eligible.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.number} — {CUSTOMER_ORDER_STATUS[o.status].label} — {formatXOF(o.total)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {customer && orders.error && <p className="text-xs text-stone-500">Commandes non consultables avec vos droits : acompte sans commande.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Moyen de paiement">
            <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              {Object.entries(PAYMENT_METHODS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Montant (FCFA)">
            <Input type="number" min={1} max={MAX_AMOUNT} step={1} required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
        </div>
        {f.method !== 'CASH' && (
          <Field label={referenceRequired ? 'Référence (obligatoire)' : 'Référence'}>
            <Input required={referenceRequired} maxLength={100} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="N° de transaction, de chèque…" />
          </Field>
        )}
        <Field label="Notes (facultatif)">
          <Textarea rows={2} maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        {offRegister ? (
          <Alert tone="info">{PAYMENT_METHODS[f.method]} : acompte encaissé hors caisse, sans session.</Alert>
        ) : !establishmentId ? null : session.isLoading ? (
          <Spinner />
        ) : session.error ? (
          <Alert>{(session.error as ApiError).message}</Alert>
        ) : sessionOk ? (
          <p className="text-sm text-stone-600">
            Encaissé sur votre session {s!.number} — caisse {s!.register.code}.
          </p>
        ) : (
          <Alert tone="info">
            {PAYMENT_METHODS[f.method]} : une session de caisse ouverte à votre nom dans cet établissement est obligatoire. Ouvrez-la depuis l’écran Caisse, ou choisissez virement ou chèque.
          </Alert>
        )}
        <p className="text-xs text-stone-500">Avance du client, hors chiffre d’affaires : elle ne réduit l’encours qu’une fois imputée sur une facture.</p>
        {error && error !== 'Session de caisse requise.' && (customer || f.amount) && <Alert tone="info">{error}</Alert>}
        {create.error && <Alert>{(create.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={create.isPending} onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!!error}>
            Encaisser l’acompte
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Acomptes remboursables (règle du serveur) : reçus ou conservés en crédit client. */
const REFUNDABLE = ['RECEIVED', 'CUSTOMER_CREDIT'];

/**
 * Remboursement de l'acompte (POST /deposits/:id/refund), total ou partiel, dans la limite du
 * disponible : par la session de caisse ouverte de l'utilisateur (mouvement « remboursement client »),
 * ou hors caisse pour le virement et le chèque.
 */
function RefundDeposit({ deposit, onClose }: { deposit: DepositDetail; onClose: () => void }) {
  const qc = useQueryClient();
  // Même identifiant à chaque tentative de ce formulaire : jamais deux remboursements pour un double clic.
  const requestId = useRequestId();
  const available = n(deposit.available);
  const [f, setF] = useState({ method: 'CASH', amount: String(available), reference: '', reason: 'TEST remboursement frontend - client a renonce' });
  const offRegister = OFF_REGISTER.has(f.method);
  const session = useQuery({
    queryKey: ['cash-sessions', 'current'],
    queryFn: () => api.get<{ session: CashSessionDetail | null }>('/cash-sessions/current', { noEstablishment: true }),
    enabled: !offRegister,
  });
  const s = session.data?.session;
  const sessionOk = !!s && s.establishmentId === deposit.establishmentId;
  const amount = Number(f.amount);
  const referenceRequired = REFERENCE_REQUIRED.has(f.method);
  const reasonLength = f.reason.trim().length;
  const error =
    f.amount.trim() === '' || !Number.isInteger(amount) || amount < 1
      ? 'Montant en FCFA entier, au moins 1.'
      : amount > available
        ? `Le montant ne peut pas dépasser le disponible (${formatXOF(available)}).`
        : referenceRequired && !f.reference.trim()
          ? `Référence de la transaction obligatoire pour ${PAYMENT_METHODS[f.method]}.`
          : reasonLength < 3 || reasonLength > 500
            ? 'Motif obligatoire (3 à 500 caractères).'
            : !offRegister && !sessionOk
              ? 'Session de caisse requise.'
              : null;
  const refund = useMutation({
    mutationFn: () =>
      api.post<DepositDetail>(`/deposits/${deposit.id}/refund`, {
        clientRequestId: requestId,
        method: f.method,
        amount,
        // Référence : sans objet pour les espèces ; session : jamais pour virement et chèque.
        ...(f.method !== 'CASH' && f.reference.trim() ? { reference: f.reference.trim() } : {}),
        ...(offRegister ? {} : { sessionId: s?.id }),
        reason: f.reason.trim(),
      }),
    onSuccess: (updated) => {
      // La réponse est la fiche de l'acompte : elle s'affiche sans relecture.
      qc.setQueryData(['deposits', 'detail', deposit.id], updated);
      qc.invalidateQueries({ queryKey: ['deposits', 'list'] });
      qc.invalidateQueries({ queryKey: ['deposits', 'receipt', deposit.id] });
      qc.invalidateQueries({ queryKey: ['cash-sessions'] });
      onClose();
    },
  });
  return (
    <Modal open title={`Rembourser l’acompte ${deposit.number}`} onClose={() => !refund.isPending && onClose()}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error && !refund.isPending) refund.mutate();
        }}
      >
        <div className="text-sm">
          {deposit.customer?.name} · disponible <strong>{formatXOF(available)}</strong>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Moyen de remboursement">
            <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              {Object.entries(PAYMENT_METHODS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Montant (FCFA)">
            <Input type="number" min={1} max={available} step={1} required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
        </div>
        {f.method !== 'CASH' && (
          <Field label={referenceRequired ? 'Référence (obligatoire)' : 'Référence'}>
            <Input required={referenceRequired} maxLength={100} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="N° de transaction, de chèque…" />
          </Field>
        )}
        <Field label="Motif">
          <Textarea rows={2} required minLength={3} maxLength={500} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
        {offRegister ? (
          <Alert tone="info">{PAYMENT_METHODS[f.method]} : remboursement hors caisse, sans session.</Alert>
        ) : session.isLoading ? (
          <Spinner />
        ) : session.error ? (
          <Alert>{(session.error as ApiError).message}</Alert>
        ) : sessionOk ? (
          <p className="text-sm text-stone-600">
            Rendu sur votre session {s!.number} — caisse {s!.register.code}.
          </p>
        ) : (
          <Alert tone="info">
            {PAYMENT_METHODS[f.method]} : une session de caisse ouverte à votre nom dans l’établissement de l’acompte est obligatoire. Ouvrez-la depuis l’écran Caisse, ou choisissez virement ou chèque.
          </Alert>
        )}
        {error && error !== 'Session de caisse requise.' && <Alert tone="info">{error}</Alert>}
        {refund.error && <Alert>{(refund.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={refund.isPending} onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" loading={refund.isPending} disabled={!!error}>
            Rembourser {error ? '' : formatXOF(amount)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Passage en crédit client (POST /deposits/:id/credit { reason }) : l'avance n'est plus rattachée
 * à sa commande et reste disponible pour les factures du client. Aucun mouvement de caisse ;
 * le serveur ne l'accepte que pour un acompte « Reçu ».
 */
function CreditDeposit({ deposit, onClose }: { deposit: DepositDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const length = reason.trim().length;
  const error = length < 3 || length > 500 ? 'Motif obligatoire (3 à 500 caractères).' : null;
  const credit = useMutation({
    mutationFn: () => api.post<DepositDetail>(`/deposits/${deposit.id}/credit`, { reason: reason.trim() }),
    onSuccess: (updated) => {
      // La réponse est la fiche de l'acompte : elle s'affiche sans relecture.
      qc.setQueryData(['deposits', 'detail', deposit.id], updated);
      qc.invalidateQueries({ queryKey: ['deposits', 'list'] });
      qc.invalidateQueries({ queryKey: ['deposits', 'receipt', deposit.id] });
      qc.invalidateQueries({ queryKey: ['customer-credit'] });
      if (deposit.orderId) qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', deposit.orderId] });
      onClose();
    },
  });
  return (
    <Modal open title={`Créditer le client — acompte ${deposit.number}`} onClose={() => !credit.isPending && onClose()}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error && !credit.isPending) credit.mutate();
        }}
      >
        <p className="text-sm">
          <strong>{formatXOF(deposit.available)}</strong> disponibles sur cet acompte deviennent un crédit de <strong>{deposit.customer?.name}</strong>
          {deposit.order ? `, détaché de la commande ${deposit.order.number}` : ''}. Ce crédit reste imputable sur ses factures ou remboursable ; aucun mouvement de caisse.
        </p>
        <Field label="Motif">
          <Textarea rows={2} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Commande annulée, avance conservée…" />
        </Field>
        {error && reason && <Alert tone="info">{error}</Alert>}
        {credit.error && <Alert>{(credit.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={credit.isPending} onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" loading={credit.isPending} disabled={!!error}>
            Créditer {formatXOF(deposit.available)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Annulation d'une saisie erronée (POST /deposits/:id/cancel { reason }) : les paiements qui
 * financent l'acompte redeviennent « non répartis » ; aucun mouvement de caisse (l'argent reste
 * encaissé, à répartir ou à annuler côté paiement). Refusée par le serveur si l'acompte est en
 * partie remboursé ou imputé sur une facture. Pas d'identifiant d'idempotence dans le contrat.
 */
function CancelDeposit({ deposit, onClose }: { deposit: DepositDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const length = reason.trim().length;
  const error = length < 3 || length > 500 ? 'Motif obligatoire (3 à 500 caractères).' : null;
  const payments = [...new Set(deposit.allocations.filter((a) => a.target === 'DEPOSIT' && !a.releasedAt).map((a) => a.payment.number))];
  const cancel = useMutation({
    mutationFn: () => api.post<DepositDetail>(`/deposits/${deposit.id}/cancel`, { reason: reason.trim() }),
    onSuccess: (updated) => {
      // La réponse est la fiche de l'acompte : elle s'affiche sans relecture.
      qc.setQueryData(['deposits', 'detail', deposit.id], updated);
      qc.invalidateQueries({ queryKey: ['deposits', 'list'] });
      qc.invalidateQueries({ queryKey: ['deposits', 'receipt', deposit.id] });
      qc.invalidateQueries({ queryKey: ['customer-payments'] });
      qc.invalidateQueries({ queryKey: ['cash-sessions'] });
      qc.invalidateQueries({ queryKey: ['customer-credit'] });
      if (deposit.orderId) qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', deposit.orderId] });
      onClose();
    },
  });
  return (
    <Modal open title={`Annuler l’acompte ${deposit.number}`} onClose={() => !cancel.isPending && onClose()}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error && !cancel.isPending) cancel.mutate();
        }}
      >
        <p className="text-sm">
          Annulation de l’acompte de <strong>{formatXOF(deposit.amount)}</strong> de {deposit.customer?.name} (saisie erronée). L’annulation est définitive.
        </p>
        <p className="text-sm text-stone-600">
          Aucun mouvement de caisse : l’argent reste encaissé et redevient « à répartir » sur {payments.length > 1 ? 'les paiements' : 'le paiement'} {payments.join(', ') || '—'}, à répartir sur une facture ou à annuler depuis
          « Paiements clients ».
        </p>
        <Field label="Motif">
          <Textarea rows={2} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Saisie erronée…" />
        </Field>
        {error && reason && <Alert tone="info">{error}</Alert>}
        {cancel.error && <Alert>{(cancel.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={cancel.isPending} onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" variant="danger" loading={cancel.isPending} disabled={!!error}>
            Annuler l’acompte
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DepositView({ id, onBack }: { id: string; onBack: () => void }) {
  const { me } = useAuth();
  const [refunding, setRefunding] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const { data: d, isLoading, error } = useQuery({ queryKey: ['deposits', 'detail', id], queryFn: () => api.get<DepositDetail>(`/deposits/${id}`) });
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
        <Alert>{(error as ApiError | null)?.message ?? 'Acompte introuvable'}</Alert>
      </div>
    );
  const est = me?.establishments.find((e) => e.id === d.establishmentId);
  // Répartitions : financement de l'acompte par des paiements, et imputations sur des factures.
  const funding = d.allocations.filter((a) => a.target === 'DEPOSIT');
  const applications = d.allocations.filter((a) => a.target === 'INVOICE');
  // Remboursement : reçu ou crédit client, disponible, « Encaisser paiements et acomptes » (canManage) + « Effectuer un remboursement » dans son établissement.
  const hasHere = (perm: string) => !!me?.globalPermissions.includes(perm) || !!est?.permissions.includes(perm);
  const canRefund = REFUNDABLE.includes(d.status) && n(d.available) > 0 && d.canManage && hasHere('sales.refund');
  // Crédit client : acompte « Reçu » seulement (règle du serveur), disponible, « Encaisser paiements et acomptes » dans son établissement.
  const canCredit = d.status === 'RECEIVED' && n(d.available) > 0 && d.canManage && hasHere('payments.manage');
  // Annulation : reçu ou crédit client, rien de remboursé ni d'imputé, « Encaisser paiements et acomptes » + « Annuler une vente » (règles du serveur).
  const canCancel = REFUNDABLE.includes(d.status) && n(d.refundedAmount) === 0 && n(d.applied) === 0 && d.canManage && hasHere('sales.cancel');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <div className="flex flex-wrap gap-2">
          {canCredit && (
            <Button variant="secondary" onClick={() => setCrediting(true)}>
              <UserCheck className="size-4" /> Créditer le client
            </Button>
          )}
          {canRefund && (
            <Button variant="secondary" onClick={() => setRefunding(true)}>
              <Undo2 className="size-4" /> Rembourser
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              <Ban className="size-4" /> Annuler
            </Button>
          )}
        </div>
      </div>
      {refunding && <RefundDeposit deposit={d} onClose={() => setRefunding(false)} />}
      {crediting && <CreditDeposit deposit={d} onClose={() => setCrediting(false)} />}
      {cancelling && <CancelDeposit deposit={d} onClose={() => setCancelling(false)} />}
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            Acompte {d.number} <StatusBadge map={DEPOSIT_STATUS} status={d.status} />
          </span>
        }
      >
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Info label="Client">
            <strong>{d.customer?.name ?? '—'}</strong>
            {d.customer?.phone ? ` · ${d.customer.phone}` : ''}
          </Info>
          <Info label="Établissement">{est ? `${est.code} — ${est.name}` : '—'}</Info>
          <Info label="Commande">
            {d.order ? (
              <>
                <span className="font-mono">{d.order.number}</span> ({CUSTOMER_ORDER_STATUS[d.order.status].label.toLowerCase()}, {formatXOF(d.order.total)})
              </>
            ) : (
              'Aucune (avance libre)'
            )}
          </Info>
          <Info label="Reçu le">{`${formatDateTime(d.createdAt)}${d.createdBy ? ` par ${d.createdBy}` : ''}`}</Info>
          {d.creditedAt && <Info label="Passé en crédit client le">{formatDateTime(d.creditedAt)}</Info>}
          {d.cancelledAt && <Info label="Annulé le">{`${formatDateTime(d.cancelledAt)}${d.cancelledBy ? ` par ${d.cancelledBy}` : ''}`}</Info>}
          {d.notes && <div className="text-stone-600 sm:col-span-2">{d.notes}</div>}
        </dl>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
          <div>
            Montant initial<div className="text-lg font-bold">{formatXOF(d.amount)}</div>
          </div>
          <div>
            Remboursé<div className="text-lg font-bold">{formatXOF(d.refundedAmount)}</div>
          </div>
          <div>
            Imputé sur factures<div className="text-lg font-bold">{formatXOF(d.applied)}</div>
          </div>
          <div>
            Disponible<div className={`text-lg font-bold ${n(d.available) > 0 ? 'text-brand-700' : ''}`}>{formatXOF(d.available)}</div>
          </div>
        </div>
        {d.status === 'CUSTOMER_CREDIT' && d.creditReason && (
          <div className="mt-3">
            <Alert tone="info">Conservé en crédit du client : {d.creditReason}</Alert>
          </div>
        )}
        {d.status === 'CANCELLED' && (
          <div className="mt-3">
            <Alert>Acompte annulé : {d.cancelReason}</Alert>
          </div>
        )}
      </Card>

      <Card title="Financement (paiements reçus)">
        <Table head={['Date', 'Paiement', 'Moyen', 'Référence', 'Montant', 'État']} empty={funding.length === 0}>
          {funding.map((a) => (
            <tr key={a.id} className={a.releasedAt ? 'text-stone-400' : ''}>
              <Td className="whitespace-nowrap">{formatDateTime(a.createdAt)}</Td>
              <Td className="font-mono text-xs font-semibold">{a.payment.number}</Td>
              <Td>{method(a.payment.method)}</Td>
              <Td className="text-xs">{a.payment.reference ?? '—'}</Td>
              <Td className="whitespace-nowrap">{formatXOF(a.amount)}</Td>
              <Td className="text-xs">{a.releasedAt ? `Libéré le ${formatDateTime(a.releasedAt)}${a.releaseReason ? ` : ${a.releaseReason}` : ''}` : 'Actif'}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Imputations sur factures">
        <Table head={['Date', 'Paiement d’origine', 'Montant', 'État']} empty={applications.length === 0}>
          {applications.map((a) => (
            <tr key={a.id} className={a.releasedAt ? 'text-stone-400' : ''}>
              <Td className="whitespace-nowrap">{formatDateTime(a.createdAt)}</Td>
              <Td className="font-mono text-xs">{a.payment.number}</Td>
              <Td className="whitespace-nowrap">{formatXOF(a.amount)}</Td>
              <Td className="text-xs">{a.releasedAt ? `Libéré le ${formatDateTime(a.releasedAt)}${a.releaseReason ? ` : ${a.releaseReason}` : ''}` : 'Actif'}</Td>
            </tr>
          ))}
        </Table>
        {applications.length > 0 && <p className="mt-1 text-xs text-stone-500">Le numéro de la facture n’est pas renvoyé par le serveur pour l’acompte : il figure dans la fiche de la facture.</p>}
      </Card>

      <Card title="Remboursements">
        <Table head={['Date', 'Moyen', 'Référence', 'Caisse', 'Montant', 'Motif', 'Par']} empty={d.refunds.length === 0}>
          {d.refunds.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap">{formatDateTime(r.createdAt)}</Td>
              <Td>{method(r.method)}</Td>
              <Td className="text-xs">{r.reference ?? '—'}</Td>
              <Td className="text-xs">{sessionText(r.sessionId)}</Td>
              <Td className="whitespace-nowrap font-semibold">{formatXOF(r.amount)}</Td>
              <Td className="text-xs">{r.reason}</Td>
              <Td className="text-xs">{r.createdBy ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <DepositReceiptCard id={d.id} />
    </div>
  );
}

/** Données du reçu ACP (GET /deposits/:id/receipt), affichées telles que renvoyées ; pas d'impression ici. */
function DepositReceiptCard({ id }: { id: string }) {
  const { data: r, isLoading, error } = useQuery({
    queryKey: ['deposits', 'receipt', id],
    queryFn: () => api.get<DepositReceipt>(`/deposits/${id}/receipt`),
    retry: false,
  });
  return (
    <Card title="Reçu d’acompte">
      {isLoading ? (
        <Spinner />
      ) : error || !r ? (
        <p className="text-sm text-stone-500">{(error as ApiError | null)?.message ?? 'Reçu indisponible.'}</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="font-semibold">
            {r.title} {r.number} — {formatDateTime(r.date)}
          </div>
          <div>
            {r.company} · {r.establishment.code} — {r.establishment.name}
            {r.establishment.address ? ` · ${r.establishment.address}` : ''}
            {r.establishment.phone ? ` · ${r.establishment.phone}` : ''}
          </div>
          <div>
            Client : {r.customer?.name ?? '—'}
            {r.order ? ` · Commande ${r.order.number} (${formatXOF(r.order.total)})` : ''}
          </div>
          <div>
            Montant : <strong>{formatXOF(r.amount)}</strong>
            {n(r.refundedAmount) > 0 ? ` · Remboursé : ${formatXOF(r.refundedAmount)}` : ''}
            {n(r.applied) > 0 ? ` · Imputé : ${formatXOF(r.applied)}` : ''}
          </div>
          {r.payments.length > 0 && (
            <ul className="list-inside list-disc text-xs text-stone-600">
              {r.payments.map((p) => (
                <li key={p.number}>
                  {p.number} — {p.method}
                  {p.reference ? ` (${p.reference})` : ''} : {formatXOF(p.amount)}
                </li>
              ))}
            </ul>
          )}
          {r.receivedBy && <div className="text-xs text-stone-500">Reçu par {r.receivedBy}</div>}
          <div className="text-xs italic text-stone-500">{r.mention}</div>
        </div>
      )}
    </Card>
  );
}
