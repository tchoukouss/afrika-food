import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, Plus, Split } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { CustomerPicker } from '../../components/CustomerPicker';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Customer } from '../../lib/customer-types';
import { formatDateTime, formatXOF } from '../../lib/format';
import { CUSTOMER_PAYMENT_STATUS, CustomerPaymentDetail, CustomerPaymentRow, INVOICE_LIST_LIMIT, INVOICE_STATUS, InvoiceDetail, InvoiceRow, PAYMENT_READ } from '../../lib/invoice-types';
import { CashSessionDetail, REFERENCE_REQUIRED } from '../../lib/sales-types';
import { PAYMENT_METHODS } from '../../lib/stock-types';
import { RequirePermission, StatusBadge, useReasonDialog, useRequestId } from '../stock/shared';

const n = (v: string | number) => Number(v);
/** Virement et chèque : enregistrés hors caisse ; tous les autres moyens passent par la session de caisse ouverte de l'encaisseur (règle du serveur). */
const OFF_REGISTER = new Set(['BANK_TRANSFER', 'CHEQUE']);
const MAX_AMOUNT = 1_000_000_000;
const method = (m: string) => PAYMENT_METHODS[m] ?? m;
/** Session : seul son identifiant est renvoyé ; sans session = virement ou chèque enregistré hors caisse. */
const sessionText = (sessionId: string | null) => (sessionId ? 'En caisse' : 'Hors caisse');

/** Module 7 — Paiements clients (lecture seule) : liste filtrée et détail des répartitions. */
export function CustomerPaymentsPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  // Filtres conservés au retour du détail.
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [methodFilter, setMethodFilter] = useState('');
  const [unallocatedOnly, setUnallocatedOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const { establishmentId, can, canAnywhere } = useAuth();
  const canCreate = establishmentId ? can('payments.manage') : canAnywhere('payments.manage');
  return (
    <>
      <PageHeader
        title="Paiements clients"
        subtitle="Paiements reçus et leur répartition sur les factures et acomptes"
        actions={
          canCreate &&
          !openId && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Nouveau paiement
            </Button>
          )
        }
      />
      {creating && (
        <NewPayment
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      )}
      <RequirePermission permission={PAYMENT_READ}>
        {openId ? (
          <PaymentView id={openId} onBack={() => setOpenId(null)} />
        ) : (
          <PaymentList
            customer={customer}
            setCustomer={setCustomer}
            methodFilter={methodFilter}
            setMethodFilter={setMethodFilter}
            unallocatedOnly={unallocatedOnly}
            setUnallocatedOnly={setUnallocatedOnly}
            onOpen={setOpenId}
          />
        )}
      </RequirePermission>
    </>
  );
}

function PaymentList({
  customer,
  setCustomer,
  methodFilter,
  setMethodFilter,
  unallocatedOnly,
  setUnallocatedOnly,
  onOpen,
}: {
  customer: Customer | null;
  setCustomer: (c: Customer | null) => void;
  methodFilter: string;
  setMethodFilter: (m: string) => void;
  unallocatedOnly: boolean;
  setUnallocatedOnly: (v: boolean) => void;
  onOpen: (id: string) => void;
}) {
  // Établissement : celui du menu (en-tête de requête) ; vue groupe = établissements autorisés.
  const { me, establishmentId } = useAuth();
  const params = new URLSearchParams();
  if (customer) params.set('customerId', customer.id);
  const { data, isLoading, error } = useQuery({
    queryKey: ['customer-payments', 'list', establishmentId, params.toString()],
    queryFn: () => api.get<CustomerPaymentRow[]>(`/customer-payments${params.size ? `?${params}` : ''}`),
  });
  // Moyen et reste à répartir : filtrés ici, l'API ne les propose pas (sur les lignes reçues).
  const rows = (data ?? []).filter((p) => (!methodFilter || p.method === methodFilter) && (!unallocatedOnly || n(p.unallocated) > 0));
  const estCode = (id: string) => me?.establishments.find((e) => e.id === id)?.code ?? '—';
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem_auto] md:items-end">
        <div>
          <span className="mb-1 block text-sm font-medium text-stone-700">Client</span>
          <CustomerPicker establishmentId={establishmentId ?? ''} value={customer} onChange={setCustomer} showCredit={false} />
        </div>
        <Field label="Moyen de paiement">
          <Select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}>
            <option value="">Tous les moyens</option>
            {Object.entries(PAYMENT_METHODS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={unallocatedOnly} onChange={(e) => setUnallocatedOnly(e.target.checked)} /> Avec reste à répartir
        </label>
      </div>
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{(error as ApiError).message}</Alert>
      ) : (
        <>
          <Table head={['N°', 'Date', 'Étab.', 'Client', 'Moyen', 'Référence', 'Caisse', 'Montant', 'Réparti', 'Reste à répartir', 'Statut']} empty={rows.length === 0}>
            {rows.map((p) => (
              <tr key={p.id} className={`cursor-pointer hover:bg-stone-50 ${p.status === 'CANCELLED' ? 'text-stone-400' : ''}`} onClick={() => onOpen(p.id)}>
                <Td className="whitespace-nowrap font-mono text-xs font-semibold">{p.number}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(p.createdAt)}</Td>
                <Td>{estCode(p.establishmentId)}</Td>
                <Td>{p.customer?.name ?? '—'}</Td>
                <Td>{method(p.method)}</Td>
                <Td className="text-xs">{p.reference ?? '—'}</Td>
                <Td className="text-xs">{sessionText(p.sessionId)}</Td>
                <Td className="whitespace-nowrap font-semibold">{formatXOF(p.amount)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(p.allocated)}</Td>
                <Td className={`whitespace-nowrap ${n(p.unallocated) > 0 ? 'font-semibold text-brand-700' : ''}`}>{formatXOF(p.unallocated)}</Td>
                <Td>
                  <StatusBadge map={CUSTOMER_PAYMENT_STATUS} status={p.status} />
                </Td>
              </tr>
            ))}
          </Table>
          {data?.length === INVOICE_LIST_LIMIT && (
            <p className="mt-2 text-xs text-stone-500">
              {INVOICE_LIST_LIMIT} paiements les plus récents reçus (limite du serveur, sans pagination) ; les filtres « moyen » et « reste à répartir » portent sur ces lignes : affinez avec le client.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Paiement libre (POST /customer-payments) : enregistré sans répartition ; il se
 * répartit ensuite sur une facture depuis son détail.
 */
function NewPayment({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const { me, establishmentId: selected } = useAuth();
  // Même identifiant à chaque tentative de ce formulaire : jamais deux paiements pour un double clic.
  const requestId = useRequestId();
  // Établissements où l'utilisateur peut encaisser ; « Tout le groupe » : choix obligatoire.
  const allowed = (me?.establishments ?? []).filter((e) => me?.globalPermissions.includes('payments.manage') || e.permissions.includes('payments.manage'));
  const [estChoice, setEstChoice] = useState('');
  const establishmentId = selected ?? estChoice;
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [f, setF] = useState({ method: 'CASH', amount: '', reference: '', notes: '' });
  const offRegister = OFF_REGISTER.has(f.method);
  const session = useQuery({
    queryKey: ['cash-sessions', 'current'],
    queryFn: () => api.get<{ session: CashSessionDetail | null }>('/cash-sessions/current', { noEstablishment: true }),
    enabled: !offRegister,
  });
  const s = session.data?.session;
  const sessionOk = !!s && !!establishmentId && s.establishmentId === establishmentId;
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
      api.post<CustomerPaymentDetail>('/customer-payments', {
        clientRequestId: requestId,
        establishmentId,
        customerId: customer!.id,
        method: f.method,
        amount,
        // Référence : sans objet pour les espèces ; session : jamais pour virement et chèque.
        ...(f.method !== 'CASH' && f.reference.trim() ? { reference: f.reference.trim() } : {}),
        ...(offRegister ? {} : { sessionId: s?.id }),
        ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
      }),
    onSuccess: (p) => {
      // La réponse est le détail du paiement : il s'affiche sans relecture.
      qc.setQueryData(['customer-payments', 'detail', p.id], p);
      qc.invalidateQueries({ queryKey: ['customer-payments', 'list'] });
      if (!offRegister) qc.invalidateQueries({ queryKey: ['cash-sessions'] });
      onCreated(p.id);
    },
  });
  return (
    <Modal open title="Nouveau paiement client" onClose={onClose}>
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
        <div>
          <span className="mb-1 block text-sm font-medium text-stone-700">Client</span>
          <CustomerPicker establishmentId={establishmentId} value={customer} onChange={setCustomer} showCredit={false} />
        </div>
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
          <Alert tone="info">{PAYMENT_METHODS[f.method]} : paiement enregistré hors caisse, sans session.</Alert>
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
        <p className="text-xs text-stone-500">Ce paiement ne réduit l’encours qu’une fois réparti sur une facture.</p>
        {error && error !== 'Session de caisse requise.' && (customer || f.amount) && <Alert tone="info">{error}</Alert>}
        {create.error && <Alert>{(create.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!!error}>
            Enregistrer le paiement
          </Button>
        </div>
      </form>
    </Modal>
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

/**
 * Répartition du reste d'un paiement sur une facture ouverte du même client et
 * du même établissement : POST /invoices/:id/allocations { paymentId, amount }
 * (route réelle du serveur, qui renvoie la fiche de la facture).
 */
function AllocatePayment({ payment, onClose }: { payment: CustomerPaymentDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const available = n(payment.unallocated);
  const [invoiceId, setInvoiceId] = useState('');
  const [amountInput, setAmountInput] = useState('');
  // Factures éligibles selon les règles du serveur : même client, même établissement, émise ou en litige, reste dû > 0.
  const invoices = useQuery({
    queryKey: ['invoices', 'list', 'allocatable', payment.customerId, payment.establishmentId],
    queryFn: () => api.get<InvoiceRow[]>(`/invoices?customerId=${payment.customerId}&establishmentId=${payment.establishmentId}`),
  });
  const eligible = (invoices.data ?? []).filter((i) => (i.status === 'ISSUED' || i.status === 'DISPUTED') && n(i.balance) > 0);
  const invoice = eligible.find((i) => i.id === invoiceId) ?? null;
  const due = invoice ? n(invoice.balance) : 0;
  const amount = Number(amountInput);
  const amountError = !invoice
    ? 'Choisissez la facture.'
    : amountInput.trim() === '' || !Number.isInteger(amount)
      ? 'Montant en FCFA entier.'
      : amount <= 0
        ? 'Le montant doit être positif.'
        : amount > available
          ? `Le montant ne peut pas dépasser le reste à répartir (${formatXOF(available)}).`
          : amount > due
            ? `Le montant ne peut pas dépasser le reste dû de la facture (${formatXOF(due)}).`
            : null;
  const allocate = useMutation({
    mutationFn: () => api.post<InvoiceDetail>(`/invoices/${invoiceId}/allocations`, { paymentId: payment.id, amount }),
    onSuccess: (updatedInvoice) => {
      // La réponse est la fiche de la facture : elle la met à jour ; le paiement (reste à répartir, répartitions) est relu une fois.
      qc.setQueryData(['invoices', 'detail', updatedInvoice.id], updatedInvoice);
      qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
      qc.invalidateQueries({ queryKey: ['customer-payments'] });
      qc.invalidateQueries({ queryKey: ['customer-credit'] });
      onClose();
    },
  });
  return (
    <Modal open title={`Répartir le paiement ${payment.number}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!amountError && !allocate.isPending) allocate.mutate();
        }}
      >
        <div className="text-sm">
          {payment.customer?.name} · reste à répartir <strong>{formatXOF(available)}</strong>
        </div>
        {invoices.isLoading ? (
          <Spinner />
        ) : invoices.error ? (
          <Alert>{(invoices.error as ApiError).message}</Alert>
        ) : eligible.length === 0 ? (
          <Alert tone="info">Aucune facture ouverte avec un reste dû pour ce client dans cet établissement.</Alert>
        ) : (
          <>
            <Field label="Facture">
              <Select
                required
                value={invoiceId}
                onChange={(e) => {
                  const inv = eligible.find((i) => i.id === e.target.value);
                  setInvoiceId(e.target.value);
                  // Proposition : le plus petit des deux restes.
                  setAmountInput(inv ? String(Math.min(available, n(inv.balance))) : '');
                }}
              >
                <option value="">— Choisir une facture —</option>
                {eligible.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.number} · reste dû {formatXOF(i.balance)}
                    {i.status === 'DISPUTED' ? ' · en litige' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {invoice && (
              <div className="grid grid-cols-3 gap-2 rounded-lg bg-stone-50 p-3 text-center text-sm">
                <div>
                  À répartir<div className="font-bold">{formatXOF(available)}</div>
                </div>
                <div>
                  Reste dû facture<div className="font-bold">{formatXOF(due)}</div>
                </div>
                <div>
                  Après répartition<div className="font-bold">{amountError ? '—' : formatXOF(due - amount)}</div>
                </div>
              </div>
            )}
            <Field label="Montant à répartir (FCFA)">
              <Input type="number" min={1} max={Math.min(available, due || available)} step={1} required value={amountInput} onChange={(e) => setAmountInput(e.target.value)} />
            </Field>
          </>
        )}
        {amountError && invoice && <Alert tone="info">{amountError}</Alert>}
        {allocate.error && <Alert>{(allocate.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Retour
          </Button>
          {/* Le serveur ne reçoit pas d'identifiant de requête pour cette route : bouton bloqué pendant l'envoi contre le double clic. */}
          <Button type="submit" loading={allocate.isPending} disabled={!!amountError}>
            Répartir {amountError ? '' : formatXOF(amount)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PaymentView({ id, onBack }: { id: string; onBack: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const reason = useReasonDialog();
  const [allocating, setAllocating] = useState(false);
  const { data: p, isLoading, error } = useQuery({ queryKey: ['customer-payments', 'detail', id], queryFn: () => api.get<CustomerPaymentDetail>(`/customer-payments/${id}`) });
  // Annulation (correction d'une erreur d'encaissement) : le serveur passe le mouvement inverse dans la session d'origine et renvoie le paiement à jour.
  const cancel = useMutation({
    mutationFn: (r: string) => api.post<CustomerPaymentDetail>(`/customer-payments/${id}/cancel`, { reason: r }),
    onSuccess: (updated) => {
      qc.setQueryData(['customer-payments', 'detail', id], updated);
      qc.invalidateQueries({ queryKey: ['customer-payments', 'list'] });
      qc.invalidateQueries({ queryKey: ['cash-sessions'] });
    },
  });
  const back = (
    <Button variant="ghost" onClick={onBack}>
      <ArrowLeft className="size-4" /> Retour à la liste
    </Button>
  );
  if (isLoading) return <Spinner />;
  if (error || !p)
    return (
      <div className="space-y-3">
        {back}
        <Alert>{(error as ApiError | null)?.message ?? 'Paiement introuvable'}</Alert>
      </div>
    );
  const est = me?.establishments.find((e) => e.id === p.establishmentId);
  // Répartir : paiement actif, reste à répartir, droit « Encaisser paiements et acomptes » dans son établissement (canManage, calculé par le serveur).
  const canAllocate = p.status === 'RECORDED' && n(p.unallocated) > 0 && p.canManage;
  // Annuler : paiement actif, rien de réparti (le serveur refuse dès qu'une répartition est active),
  // « Encaisser paiements et acomptes » + « Annuler une vente » dans son établissement (ou au niveau groupe).
  const hasHere = (perm: string) => !!me?.globalPermissions.includes(perm) || !!est?.permissions.includes(perm);
  const canCancel = p.status === 'RECORDED' && n(p.unallocated) > 0 && n(p.allocated) === 0 && hasHere('payments.manage') && hasHere('sales.cancel');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <div className="flex flex-wrap gap-2">
          {canAllocate && (
            <Button onClick={() => setAllocating(true)} disabled={cancel.isPending}>
              <Split className="size-4" /> Répartir
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" loading={cancel.isPending} onClick={() => reason.ask(`Annuler le paiement ${p.number}`, (r) => cancel.mutate(r))}>
              <Ban className="size-4" /> Annuler
            </Button>
          )}
        </div>
      </div>
      {cancel.error && <Alert>{(cancel.error as ApiError).message}</Alert>}
      {reason.dialog}
      {allocating && <AllocatePayment payment={p} onClose={() => setAllocating(false)} />}
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            Paiement {p.number} <StatusBadge map={CUSTOMER_PAYMENT_STATUS} status={p.status} />
          </span>
        }
      >
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Info label="Client">
            <strong>{p.customer?.name ?? '—'}</strong>
            {p.customer?.phone ? ` · ${p.customer.phone}` : ''}
          </Info>
          <Info label="Établissement">{est ? `${est.code} — ${est.name}` : '—'}</Info>
          <Info label="Date">{`${formatDateTime(p.createdAt)}${p.createdBy ? ` par ${p.createdBy}` : ''}`}</Info>
          <Info label="Moyen">{p.methodLabel}</Info>
          <Info label="Référence">{p.reference ?? '—'}</Info>
          <Info label="Caisse">{p.sessionId ? 'Encaissé sur une session de caisse' : 'Hors caisse (virement, chèque)'}</Info>
          {p.notes && <Info label="Notes">{p.notes}</Info>}
        </dl>
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-stone-50 p-3 text-center text-sm">
          <div>
            Montant<div className="text-lg font-bold">{formatXOF(p.amount)}</div>
          </div>
          <div>
            Réparti<div className="text-lg font-bold">{formatXOF(p.allocated)}</div>
          </div>
          <div>
            Reste à répartir<div className={`text-lg font-bold ${n(p.unallocated) > 0 ? 'text-brand-700' : ''}`}>{formatXOF(p.unallocated)}</div>
          </div>
        </div>
        {p.status === 'RECORDED' && n(p.unallocated) > 0 && (
          <div className="mt-3">
            <Alert tone="info">Ce paiement ne réduit l’encours qu’une fois réparti sur une facture.</Alert>
          </div>
        )}
        {p.status === 'CANCELLED' && (
          <div className="mt-3">
            <Alert>
              Annulé le {formatDateTime(p.cancelledAt)}
              {p.cancelledBy ? ` par ${p.cancelledBy}` : ''} : {p.cancelReason}
            </Alert>
          </div>
        )}
      </Card>

      <Card title="Répartitions">
        <Table head={['Date', 'Sur', 'Document', 'Montant', 'État']} empty={p.allocations.length === 0}>
          {p.allocations.map((a) => (
            <tr key={a.id} className={a.releasedAt ? 'text-stone-400' : ''}>
              <Td className="whitespace-nowrap">{formatDateTime(a.createdAt)}</Td>
              <Td>{a.target === 'INVOICE' ? 'Facture' : 'Acompte'}</Td>
              <Td className="font-mono text-xs">
                {a.target === 'INVOICE' ? (
                  <span className="flex flex-wrap items-center gap-1">
                    {a.invoice?.number ?? 'Brouillon'} {a.invoice && <StatusBadge map={INVOICE_STATUS} status={a.invoice.status} />}
                  </span>
                ) : (
                  a.deposit?.number ?? '—'
                )}
              </Td>
              <Td className="whitespace-nowrap font-semibold">{formatXOF(a.amount)}</Td>
              <Td className="text-xs">{a.releasedAt ? `Libérée le ${formatDateTime(a.releasedAt)}${a.releaseReason ? ` : ${a.releaseReason}` : ''}` : <Badge tone="green">Active</Badge>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
