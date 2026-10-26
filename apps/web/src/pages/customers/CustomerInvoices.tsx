import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Ban, CheckCircle2, FileMinus, Pencil, PiggyBank, Plus, Printer, Send, Trash2, Wallet } from 'lucide-react';
import { ReactNode, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CustomerPicker } from '../../components/CustomerPicker';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { qty } from '../../lib/catalog-types';
import type { Customer } from '../../lib/customer-types';
import { DEPOSIT_STATUS, DepositDetail, DepositRow } from '../../lib/deposit-types';
import { formatDate, formatDateTime, formatXOF } from '../../lib/format';
import {
  INVOICE_LIST_LIMIT,
  INVOICE_PAYMENT_STATUS,
  INVOICE_READ,
  INVOICE_SOURCES,
  INVOICE_STATUS,
  CreditNoteSummary,
  InvoiceDetail,
  InvoicePaymentStatus,
  InvoiceRow,
  InvoiceStatus,
} from '../../lib/invoice-types';
import { CashSessionDetail, REFERENCE_REQUIRED } from '../../lib/sales-types';
import { PAYMENT_METHODS } from '../../lib/stock-types';
import { printLines } from '../sales/Ticket';
import { RequirePermission, StatusBadge, useRequestId } from '../stock/shared';

/** Virement et chèque : enregistrés hors caisse ; tous les autres moyens passent par la session de caisse ouverte de l'encaisseur (règle du serveur). */
const OFF_REGISTER = new Set(['BANK_TRANSFER', 'CHEQUE']);

const n = (v: string | number) => Number(v);

/**
 * Verrou synchrone contre le double clic : isPending n'est vrai qu'au rendu suivant, un second clic
 * rapide enverrait sinon une seconde requête. Libéré à la fin de la requête, succès ou erreur.
 */
function useSubmitLock() {
  const busy = useRef(false);
  return (start: (release: () => void) => void) => {
    if (busy.current) return;
    busy.current = true;
    start(() => {
      busy.current = false;
    });
  };
}

/** Statut du document + règlement (factures ouvertes) + retard. */
function InvoiceBadges({ status, paymentStatus, overdue }: { status: InvoiceStatus; paymentStatus: InvoicePaymentStatus | null; overdue: boolean }) {
  return (
    <span className="flex flex-wrap gap-1">
      <StatusBadge map={INVOICE_STATUS} status={status} />
      {paymentStatus && <StatusBadge map={INVOICE_PAYMENT_STATUS} status={paymentStatus} />}
      {overdue && <Badge tone="red">En retard</Badge>}
    </span>
  );
}

/** « Émettre / annuler des factures » : création et modification des brouillons (le serveur reste seul juge). */
const INVOICE_MANAGE = 'invoices.manage';

/** Module 7 — Factures clients : liste filtrée, fiche détaillée, facture manuelle et brouillons. */
export function CustomerInvoicesPage() {
  const { establishmentId, can, canAnywhere } = useAuth();
  const [openId, setOpenId] = useState<string | null>(null);
  // Formulaire : nouvelle facture manuelle, ou modification d'un brouillon (identifiant).
  const [editing, setEditing] = useState<'new' | string | null>(null);
  // Filtres conservés au retour de la fiche.
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [status, setStatus] = useState('');
  const [overdue, setOverdue] = useState(false);
  const canCreate = establishmentId ? can(INVOICE_MANAGE) : canAnywhere(INVOICE_MANAGE);
  return (
    <>
      <PageHeader
        title="Factures clients"
        subtitle="Factures émises, règlements et avoirs"
        actions={
          canCreate &&
          !editing && (
            <Button
              onClick={() => {
                setOpenId(null);
                setEditing('new');
              }}
            >
              <Plus className="size-4" /> Facture manuelle
            </Button>
          )
        }
      />
      <RequirePermission permission={INVOICE_READ}>
        {editing ? (
          <InvoiceForm
            invoiceId={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={(id) => {
              setEditing(null);
              setOpenId(id);
            }}
          />
        ) : openId ? (
          <InvoiceView id={openId} onBack={() => setOpenId(null)} onEdit={() => setEditing(openId)} />
        ) : (
          <InvoiceList customer={customer} setCustomer={setCustomer} status={status} setStatus={setStatus} overdue={overdue} setOverdue={setOverdue} onOpen={setOpenId} />
        )}
      </RequirePermission>
    </>
  );
}

function InvoiceList({
  customer,
  setCustomer,
  status,
  setStatus,
  overdue,
  setOverdue,
  onOpen,
}: {
  customer: Customer | null;
  setCustomer: (c: Customer | null) => void;
  status: string;
  setStatus: (s: string) => void;
  overdue: boolean;
  setOverdue: (v: boolean) => void;
  onOpen: (id: string) => void;
}) {
  // Établissement : celui du menu (en-tête de requête) ; vue groupe = établissements autorisés.
  const { establishmentId } = useAuth();
  const params = new URLSearchParams();
  if (customer) params.set('customerId', customer.id);
  if (status) params.set('status', status);
  if (overdue) params.set('overdue', 'true');
  const { data, isLoading, error } = useQuery({
    queryKey: ['invoices', 'list', establishmentId, params.toString()],
    queryFn: () => api.get<InvoiceRow[]>(`/invoices${params.size ? `?${params}` : ''}`),
  });
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem_auto] md:items-end">
        <div>
          <span className="mb-1 block text-sm font-medium text-stone-700">Client</span>
          <CustomerPicker establishmentId={establishmentId ?? ''} value={customer} onChange={setCustomer} showCredit={false} />
        </div>
        <Field label="Statut">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tous les statuts</option>
            {Object.entries(INVOICE_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> En retard uniquement
        </label>
      </div>
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{(error as ApiError).message}</Alert>
      ) : (
        <>
          <Table head={['N°', 'Client', 'Date', 'Échéance', 'Total TTC', 'Payé', 'Reste dû', 'Statut']} empty={data?.length === 0}>
            {data?.map((i) => (
              <tr key={i.id} className="cursor-pointer hover:bg-stone-50" onClick={() => onOpen(i.id)}>
                <Td className="whitespace-nowrap font-mono text-xs font-semibold">{i.number ?? 'Brouillon'}</Td>
                <Td>{i.customer?.name ?? '—'}</Td>
                <Td className="whitespace-nowrap">{formatDate(i.issuedAt ?? i.createdAt)}</Td>
                <Td className="whitespace-nowrap">{formatDate(i.dueDate)}</Td>
                <Td className="whitespace-nowrap font-semibold">{formatXOF(i.total)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(i.paid)}</Td>
                <Td className={`whitespace-nowrap font-semibold ${n(i.balance) > 0 && i.paymentStatus ? 'text-red-700' : ''}`}>{formatXOF(i.balance)}</Td>
                <Td>
                  <InvoiceBadges status={i.status} paymentStatus={i.paymentStatus} overdue={i.overdue} />
                </Td>
              </tr>
            ))}
          </Table>
          {data?.length === INVOICE_LIST_LIMIT && (
            <p className="mt-2 text-xs text-stone-500">
              {INVOICE_LIST_LIMIT} factures les plus récentes affichées (limite du serveur, sans pagination) : affinez avec le client ou le statut.
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

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: string }) {
  return (
    <div className={`flex justify-between gap-2 ${strong ? 'text-base font-bold' : ''} ${tone ?? ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * Encaissement direct d'une facture (POST /invoices/:id/payments) : le serveur
 * enregistre le paiement, le mouvement de caisse éventuel et sa répartition sur
 * la facture, et renvoie la fiche à jour.
 */
function PayInvoice({ inv, onClose }: { inv: InvoiceDetail; onClose: () => void }) {
  const qc = useQueryClient();
  // Même identifiant à chaque tentative de ce formulaire : jamais deux paiements pour un double clic.
  const requestId = useRequestId();
  const due = n(inv.balance);
  const [f, setF] = useState({ method: 'CASH', amount: String(due), reference: '' });
  const offRegister = OFF_REGISTER.has(f.method);
  const session = useQuery({
    queryKey: ['cash-sessions', 'current'],
    queryFn: () => api.get<{ session: CashSessionDetail | null }>('/cash-sessions/current', { noEstablishment: true }),
    enabled: !offRegister,
  });
  const s = session.data?.session;
  const sessionOk = !!s && s.establishmentId === inv.establishmentId;
  const amount = Number(f.amount);
  const amountError =
    f.amount.trim() === '' || !Number.isInteger(amount) ? 'Montant en FCFA entier.' : amount <= 0 ? 'Le montant doit être positif.' : amount > due ? `Le montant ne peut pas dépasser le reste dû (${formatXOF(due)}).` : null;
  const pay = useMutation({
    mutationFn: () =>
      api.post<InvoiceDetail>(`/invoices/${inv.id}/payments`, {
        clientRequestId: requestId,
        method: f.method,
        amount,
        ...(f.reference.trim() ? { reference: f.reference.trim() } : {}),
        ...(offRegister ? {} : { sessionId: s?.id }),
      }),
    onSuccess: (updated) => {
      // La réponse est la fiche à jour : aucune relecture de la facture.
      qc.setQueryData(['invoices', 'detail', inv.id], updated);
      qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
      qc.invalidateQueries({ queryKey: ['customer-credit'] });
      if (!offRegister) qc.invalidateQueries({ queryKey: ['cash-sessions'] });
      onClose();
    },
  });
  const lock = useSubmitLock();
  return (
    <Modal open title={`Encaisser la facture ${inv.number}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          lock((release) => pay.mutate(undefined, { onSettled: release }));
        }}
      >
        <div className="text-sm">
          {inv.customer?.name} · reste dû <strong>{formatXOF(due)}</strong>
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
            <Input type="number" min={1} max={due} step={1} required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
        </div>
        {f.method !== 'CASH' && (
          <Field label={REFERENCE_REQUIRED.has(f.method) ? 'Référence (obligatoire)' : 'Référence'}>
            <Input required={REFERENCE_REQUIRED.has(f.method)} maxLength={100} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="N° de transaction, de chèque…" />
          </Field>
        )}
        {offRegister ? (
          <Alert tone="info">{PAYMENT_METHODS[f.method]} : paiement enregistré hors caisse, sans session.</Alert>
        ) : session.isLoading ? (
          <Spinner />
        ) : session.error ? (
          <Alert>{(session.error as ApiError).message}</Alert>
        ) : sessionOk ? (
          <p className="text-sm text-stone-600">
            Encaissé sur votre session {s!.number} — caisse {s!.register.code}.
          </p>
        ) : (
          <Alert tone="info">
            {PAYMENT_METHODS[f.method]} : une session de caisse ouverte dans l’établissement de la facture est obligatoire. Ouvrez-la depuis l’écran{' '}
            <Link className="underline" to="/caisse">
              Caisse
            </Link>
            , ou choisissez virement ou chèque.
          </Alert>
        )}
        {amountError && f.amount.trim() !== '' && <Alert tone="info">{amountError}</Alert>}
        {pay.error && <Alert>{(pay.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" loading={pay.isPending} disabled={!!amountError || (!offRegister && !sessionOk)}>
            Encaisser {amountError ? '' : formatXOF(amount)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Acomptes encore utilisables (règle du serveur) : reçus ou conservés en crédit client. */
const DEPOSIT_USABLE = ['RECEIVED', 'CUSTOMER_CREDIT'];

/**
 * Imputation d'un acompte sur la facture (POST /invoices/:id/allocations { depositId, amount }) :
 * l'argent déjà reçu passe de l'acompte à la facture, sans mouvement de caisse. Acomptes du même
 * client et du même établissement ; le disponible vient de la fiche de chaque acompte (la liste
 * ne le renvoie pas). Le contrat n'a pas d'identifiant d'idempotence : l'envoi est bloqué pendant l'appel.
 */
function ApplyDeposit({ inv, onClose, onApplied }: { inv: InvoiceDetail; onClose: () => void; onApplied: (r: { deposit: string; amount: number; balance: string }) => void }) {
  const qc = useQueryClient();
  const due = Math.max(0, n(inv.balance));
  const list = useQuery({
    queryKey: ['deposits', 'list', 'invoice', inv.customerId, inv.establishmentId],
    queryFn: () => api.get<DepositRow[]>(`/deposits?customerId=${inv.customerId}&establishmentId=${inv.establishmentId}`),
    retry: false,
  });
  const candidates = (list.data ?? []).filter((d) => d.customerId === inv.customerId && d.establishmentId === inv.establishmentId && DEPOSIT_USABLE.includes(d.status));
  const details = useQueries({
    queries: candidates.map((d) => ({ queryKey: ['deposits', 'detail', d.id], queryFn: () => api.get<DepositDetail>(`/deposits/${d.id}`) })),
  });
  const loadingDetails = details.some((q) => q.isLoading);
  const usable = details.map((q) => q.data).filter((d): d is DepositDetail => !!d && n(d.available) > 0);
  const [depositId, setDepositId] = useState('');
  const [amountText, setAmountText] = useState('');
  const chosen = usable.find((d) => d.id === depositId);
  const max = chosen ? Math.min(n(chosen.available), due) : 0;
  const amount = Number(amountText);
  const amountError = !chosen
    ? 'Choisissez l’acompte.'
    : amountText.trim() === '' || !Number.isInteger(amount)
      ? 'Montant en FCFA entier.'
      : amount <= 0
        ? 'Le montant doit être positif.'
        : amount > n(chosen.available)
          ? `L’acompte ${chosen.number} n’a que ${formatXOF(chosen.available)} disponibles.`
          : amount > due
            ? `Le montant ne peut pas dépasser le reste dû (${formatXOF(due)}).`
            : null;
  const apply = useMutation({
    mutationFn: () => api.post<InvoiceDetail>(`/invoices/${inv.id}/allocations`, { depositId, amount }),
    onSuccess: (updated) => {
      // La réponse est la fiche de la facture : elle s'affiche sans relecture.
      qc.setQueryData(['invoices', 'detail', inv.id], updated);
      qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
      qc.invalidateQueries({ queryKey: ['deposits'] });
      qc.invalidateQueries({ queryKey: ['customer-payments'] });
      qc.invalidateQueries({ queryKey: ['customer-credit'] });
      onApplied({ deposit: chosen!.number, amount, balance: updated.balance });
    },
  });
  const lock = useSubmitLock();
  return (
    <Modal open title={`Imputer un acompte — facture ${inv.number}`} onClose={() => !apply.isPending && onClose()}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!amountError && !apply.isPending) lock((release) => apply.mutate(undefined, { onSettled: release }));
        }}
      >
        <div className="text-sm">
          {inv.customer?.name} · reste dû <strong>{formatXOF(due)}</strong>
        </div>
        {list.isLoading || loadingDetails ? (
          <Spinner />
        ) : list.error ? (
          <Alert>{(list.error as ApiError).message}</Alert>
        ) : usable.length === 0 ? (
          <Alert tone="info">Aucun acompte disponible pour ce client dans l’établissement de la facture.</Alert>
        ) : (
          <Table head={['', 'Acompte', 'Montant', 'Imputé', 'Remboursé', 'Disponible', 'Statut']}>
            {usable.map((d) => (
              <tr
                key={d.id}
                className="cursor-pointer hover:bg-stone-50"
                onClick={() => {
                  setDepositId(d.id);
                  setAmountText(String(Math.min(n(d.available), due)));
                }}
              >
                <Td>
                  <input type="radio" name="deposit" checked={depositId === d.id} readOnly aria-label={`Acompte ${d.number}`} />
                </Td>
                <Td className="font-mono text-xs font-semibold">{d.number}</Td>
                <Td className="whitespace-nowrap">{formatXOF(d.amount)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(d.applied)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(d.refundedAmount)}</Td>
                <Td className="whitespace-nowrap font-semibold">{formatXOF(d.available)}</Td>
                <Td>
                  <StatusBadge map={DEPOSIT_STATUS} status={d.status} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {chosen && (
          <Field label={`Montant à imputer (FCFA), ${formatXOF(max)} au plus`}>
            <Input type="number" min={1} max={max} step={1} required value={amountText} onChange={(e) => setAmountText(e.target.value)} />
          </Field>
        )}
        <p className="text-xs text-stone-500">Argent déjà encaissé : aucun mouvement de caisse. Le reste dû de la facture diminue du montant imputé.</p>
        {amountError && chosen && amountText.trim() !== '' && <Alert tone="info">{amountError}</Alert>}
        {apply.error && <Alert>{(apply.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={apply.isPending} onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" loading={apply.isPending} disabled={!!amountError}>
            Imputer {amountError ? '' : formatXOF(amount)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Réponse de POST /invoices/:id/credit-notes : l'avoir créé (et non la facture). */
type CreatedCreditNote = CreditNoteSummary & { invoice: { id: string; number: string | null } };
/** GET /credit-notes/:id : même forme (avoir, lignes, remboursements, facture d'origine). */
type CreditNoteDetail = CreatedCreditNote;

/** Largeur d'impression en caractères (papier 80 mm, comme les reçus et les tickets de caisse). */
const PRINT_WIDTH = 42;
/** En-tête d'impression : société et établissement de la session (GET /auth/me). */
interface PrintHeader {
  company: string;
  establishment: string | null;
}

/** Outils de mise en page texte à largeur fixe. */
function textLayout() {
  const W = PRINT_WIDTH;
  const out: string[] = [];
  // Les montants formatés contiennent des espaces insécables : remplacés pour un alignement fixe.
  const money = (v: string | number) => formatXOF(v).replace(/\s/g, ' ');
  const wrap = (text: string) => {
    let line = '';
    for (const w of text.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + w.length > W) {
        out.push(line);
        line = w;
      } else line = line ? `${line} ${w}` : w;
    }
    if (line) out.push(line);
  };
  const center = (text: string) => (text.length >= W ? wrap(text) : out.push(' '.repeat(Math.floor((W - text.length) / 2)) + text));
  const pair = (label: string, value: string) => {
    if (label.length + value.length + 1 > W) {
      wrap(label);
      out.push(value.padStart(W));
    } else out.push(label + value.padStart(W - label.length));
  };
  const rule = (c = '-') => out.push(c.repeat(W));
  const header = (h: PrintHeader) => {
    center(h.company.toUpperCase());
    if (h.establishment) center(h.establishment);
    rule('=');
  };
  const banner = (title: string, details: [string, string | null | undefined][], reason?: string | null) => {
    rule('*');
    center(`*** ${title} ***`);
    for (const [label, value] of details) if (value) pair(label, value);
    if (reason) wrap(`Motif : ${reason}`);
    rule('*');
  };
  return { out, money, wrap, center, pair, rule, header, banner };
}

/** Facture imprimée à partir des seules données de GET /invoices/:id. */
function invoicePrintLines(inv: InvoiceDetail, h: PrintHeader): string[] {
  const { out, money, wrap, center, pair, rule, header, banner } = textLayout();
  header(h);
  center(inv.status === 'DRAFT' ? 'FACTURE (BROUILLON)' : 'FACTURE');
  if (inv.number) center(`N° ${inv.number}`);
  if (inv.status === 'DRAFT') banner('BROUILLON — NON ÉMISE', [['Créée le :', formatDateTime(inv.createdAt)]]);
  if (inv.status === 'CANCELLED') banner('ANNULÉE', [['Annulée le :', inv.cancelledAt && formatDateTime(inv.cancelledAt)], ['Par :', inv.cancelledBy]], inv.cancelReason);
  if (inv.status === 'DISPUTED') banner('EN LITIGE', [['Depuis le :', inv.disputedAt && formatDateTime(inv.disputedAt)]], inv.disputeReason);
  rule();
  if (inv.issuedAt) pair('Émise le :', formatDateTime(inv.issuedAt));
  if (inv.dueDate) pair('Échéance :', `${formatDate(inv.dueDate)}${inv.paymentTermDays === 0 ? ' (comptant)' : ''}`);
  if (inv.order) pair('Commande :', inv.order.number);
  if (inv.sale) pair('Ticket :', inv.sale.number);
  rule();
  pair('Client :', inv.customer?.name ?? '—');
  if (inv.customer?.phone) pair('Tél. :', inv.customer.phone);
  if (inv.customer?.address) wrap(`Adresse : ${inv.customer.address}`);
  if (inv.customer?.taxId) pair('N° CC :', inv.customer.taxId);
  rule();
  for (const l of inv.lines) {
    wrap(l.label);
    pair(`  ${qty(l.quantity)} x ${money(l.unitPrice)}${n(l.taxRate) > 0 ? ` (TVA ${qty(l.taxRate)} %)` : ''}`, money(l.lineTotal));
    if (n(l.credited) > 0) pair('  Corrigé par avoir', `-${money(l.credited)}`);
  }
  rule();
  pair('TOTAL TTC', money(inv.total));
  if (n(inv.taxTotal) > 0) pair('dont TVA', money(inv.taxTotal));
  if (inv.status === 'ISSUED' || inv.status === 'DISPUTED') {
    if (n(inv.credited) > 0) pair('Avoirs :', `-${money(inv.credited)}`);
    pair('Payé :', money(inv.paid));
    pair(n(inv.balance) < 0 ? 'Trop-perçu :' : 'RESTE DÛ :', money(Math.abs(n(inv.balance))));
    if (inv.paymentStatus) pair('État :', INVOICE_PAYMENT_STATUS[inv.paymentStatus].label + (inv.overdue ? ' — en retard' : ''));
  }
  const allocations = inv.allocations.filter((a) => !a.releasedAt);
  if (allocations.length) {
    rule();
    out.push('Règlements :');
    for (const a of allocations) pair(`${formatDate(a.createdAt)} ${a.deposit ? `Acompte ${a.deposit.number}` : a.methodLabel}`, money(a.amount));
  }
  if (inv.creditNotes.length) {
    rule();
    out.push('Avoirs :');
    for (const c of inv.creditNotes) pair(`${formatDate(c.createdAt)} ${c.number}`, `-${money(c.total)}`);
  }
  if (inv.notes) {
    rule();
    wrap(inv.notes);
  }
  rule();
  if (inv.issuedBy) pair('Émise par :', inv.issuedBy);
  return out;
}

/** Avoir imprimé à partir de GET /credit-notes/:id (client : fiche de la facture d'origine). */
function creditNotePrintLines(cn: CreditNoteDetail, inv: InvoiceDetail, h: PrintHeader): string[] {
  const { out, money, wrap, center, pair, rule, header } = textLayout();
  header(h);
  center('AVOIR');
  center(`N° ${cn.number}`);
  center(formatDateTime(cn.createdAt));
  rule();
  pair('Sur facture :', cn.invoice.number ?? '—');
  pair('Client :', inv.customer?.name ?? '—');
  if (inv.customer?.phone) pair('Tél. :', inv.customer.phone);
  if (inv.customer?.taxId) pair('N° CC :', inv.customer.taxId);
  rule();
  wrap(`Motif : ${cn.reason}`);
  rule();
  for (const l of cn.lines) {
    wrap(l.label);
    pair(`  ${l.quantity !== null ? `${qty(l.quantity)} unité(s)` : 'Montant'}${n(l.taxRate) > 0 ? ` (TVA ${qty(l.taxRate)} %)` : ''}`, `-${money(l.amount)}`);
  }
  rule();
  pair('TOTAL AVOIR TTC', `-${money(cn.total)}`);
  if (n(cn.taxTotal) > 0) pair('dont TVA', money(cn.taxTotal));
  rule();
  pair('Déduit du reste dû :', money(cn.reducedDue));
  if (n(cn.customerCredit) > 0) pair('Crédit client :', money(cn.customerCredit));
  if (n(cn.refundAmount) > 0) pair('Remboursé :', money(cn.refundAmount));
  for (const r of cn.refunds) pair(`  ${PAYMENT_METHODS[r.method] ?? r.method}${r.reference ? ` ${r.reference}` : ''}`, money(r.amount));
  return out;
}

const EXCESS_NO_RIGHT = 'Excédent : son règlement exige le droit « Encaisser paiements et acomptes » (crédit client), et « Effectuer un remboursement » pour un remboursement, dans l’établissement de la facture.';
const EXCESS_CHOOSE = 'Choisissez le règlement de l’excédent.';
/** Moyens de remboursement acceptés par le serveur (même liste que les paiements). */
const REFUND_METHODS = ['CASH', 'ORANGE_MONEY', 'MTN_MONEY', 'MOOV_MONEY', 'WAVE', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'OTHER'];

/**
 * Avoir sur une facture ouverte (POST /invoices/:id/credit-notes). La part au-delà
 * du reste dû (facture déjà payée) se règle ici en crédit client (le serveur libère
 * des répartitions de la facture, l'argent redevient une avance du client) ou en
 * remboursement (virement et chèque hors caisse, autres moyens par la session de caisse).
 */
function CreateCreditNote({
  inv,
  canCustomerCredit,
  canRefund,
  canOperateCash,
  onClose,
  onCreated,
}: {
  inv: InvoiceDetail;
  canCustomerCredit: boolean;
  canRefund: boolean;
  canOperateCash: boolean;
  onClose: () => void;
  onCreated: (cn: CreatedCreditNote) => void;
}) {
  const qc = useQueryClient();
  // Même identifiant à chaque tentative de ce formulaire : jamais deux avoirs pour un double clic.
  const requestId = useRequestId();
  const [mode, setMode] = useState<'partial' | 'full'>('partial');
  // Une entrée par ligne cochée : une ligne ne peut donc pas être citée deux fois.
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  // Règlement de l'excédent : crédit client ou remboursement (moyen, référence, session de caisse).
  const [settlementMode, setSettlementMode] = useState<'' | 'CUSTOMER_CREDIT' | 'REFUND'>('');
  const [refund, setRefund] = useState({ method: 'CASH', reference: '' });
  const refundOffRegister = OFF_REGISTER.has(refund.method);
  const refundNeedsSession = settlementMode === 'REFUND' && !refundOffRegister;
  const session = useQuery({
    queryKey: ['cash-sessions', 'current'],
    queryFn: () => api.get<{ session: CashSessionDetail | null }>('/cash-sessions/current', { noEstablishment: true }),
    enabled: refundNeedsSession,
  });
  const s = session.data?.session;
  const sessionOk = !!s && s.establishmentId === inv.establishmentId;
  const refundReferenceRequired = REFERENCE_REQUIRED.has(refund.method);
  const remaining = (l: InvoiceDetail['lines'][number]) => n(l.lineTotal) - n(l.credited);
  const correctableLines = inv.lines.filter((l) => remaining(l) > 0);
  const due = Math.max(0, n(inv.balance));

  const selected = Object.entries(amounts);
  const lineErrors = selected
    .map(([lineId, v]) => {
      const l = inv.lines.find((x) => x.id === lineId)!;
      const a = Number(v);
      if (v.trim() === '' || !Number.isInteger(a) || a < 1) return `« ${l.label} » : montant entier d’au moins 1 FCFA.`;
      if (a > remaining(l)) return `« ${l.label} » : au plus ${formatXOF(remaining(l))} corrigeables.`;
      return null;
    })
    .filter((e): e is string => !!e);
  // Avoir total : tout le corrigeable de chaque ligne (règle du serveur).
  const total = mode === 'full' ? correctableLines.reduce((s, l) => s + remaining(l), 0) : selected.reduce((s, [, v]) => s + (Number.isInteger(Number(v)) ? Number(v) : 0), 0);
  const reducedDue = Math.min(total, due);
  const excess = total - reducedDue;
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;
  const error =
    mode === 'partial' && selected.length === 0
      ? 'Cochez au moins une ligne.'
      : lineErrors[0] ??
        (total <= 0
          ? 'Montant de l’avoir nul.'
          : total > n(inv.correctable)
            ? `Avoir supérieur au montant corrigeable (${formatXOF(inv.correctable)}).`
            : excess > 0 && !canCustomerCredit && !canRefund
              ? EXCESS_NO_RIGHT
              : excess > 0 && !settlementMode
                ? EXCESS_CHOOSE
                : excess > 0 && settlementMode === 'REFUND' && refundReferenceRequired && !refund.reference.trim()
                  ? `Référence de la transaction obligatoire pour ${PAYMENT_METHODS[refund.method]}.`
                  : excess > 0 && refundNeedsSession && !canOperateCash
                    ? 'Remboursement par la caisse : droit « Encaisser à sa caisse » requis dans cet établissement ; ou choisissez virement ou chèque.'
                    : excess > 0 && refundNeedsSession && !sessionOk
                      ? 'Session de caisse requise.'
                      : !reasonOk
                        ? 'Motif obligatoire (3 à 500 caractères).'
                        : null);

  const create = useMutation({
    mutationFn: () => {
      const target = mode === 'full' ? { full: true } : { lines: selected.map(([invoiceLineId, v]) => ({ invoiceLineId, amount: Number(v) })) };
      // Règlement envoyé seulement s'il y a un excédent (le serveur refuse un règlement sans excédent).
      return api.post<CreatedCreditNote>(`/invoices/${inv.id}/credit-notes`, {
        reason: reason.trim(),
        ...target,
        ...(excess > 0
          ? {
              settlement:
                settlementMode === 'REFUND'
                  ? {
                      mode: 'REFUND',
                      // Montant fixé par le serveur : exactement l'excédent.
                      refund: {
                        method: refund.method,
                        amount: excess,
                        ...(refund.reference.trim() ? { reference: refund.reference.trim() } : {}),
                        ...(refundOffRegister ? {} : { sessionId: s?.id }),
                      },
                    }
                  : { mode: 'CUSTOMER_CREDIT' },
            }
          : {}),
        clientRequestId: requestId,
      });
    },
    onSuccess: (cn) => {
      // La réponse est l'avoir : la facture (soldes, avoirs, statut) est relue une fois.
      qc.invalidateQueries({ queryKey: ['invoices', 'detail', inv.id] });
      qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
      qc.invalidateQueries({ queryKey: ['customer-credit'] });
      // Crédit client : des répartitions sont libérées ; remboursement : le payé des factures change.
      if (n(cn.customerCredit) > 0 || n(cn.refundAmount) > 0) qc.invalidateQueries({ queryKey: ['customer-payments'] });
      // Remboursement par la caisse : mouvement CUSTOMER_REFUND dans la session.
      if (n(cn.refundAmount) > 0 && cn.refunds.some((r) => !OFF_REGISTER.has(r.method))) qc.invalidateQueries({ queryKey: ['cash-sessions'] });
      onCreated(cn);
    },
  });
  const lock = useSubmitLock();

  return (
    <Modal open wide title={`Avoir sur la facture ${inv.number}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error && !create.isPending) lock((release) => create.mutate(undefined, { onSettled: release }));
        }}
      >
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'partial'} onChange={() => setMode('partial')} /> Avoir partiel
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'full'} onChange={() => setMode('full')} /> Avoir total
          </label>
        </div>
        <Table head={[mode === 'partial' ? 'Corriger' : '', 'Ligne', 'Total TTC', 'Déjà corrigé', 'Corrigeable', 'Montant de l’avoir']}>
          {correctableLines.map((l) => {
            const checked = l.id in amounts;
            return (
              <tr key={l.id}>
                <Td>
                  {mode === 'partial' && (
                    <input
                      type="checkbox"
                      aria-label={`Corriger ${l.label}`}
                      checked={checked}
                      onChange={(e) =>
                        setAmounts((a) => {
                          const next = { ...a };
                          if (e.target.checked) next[l.id] = '';
                          else delete next[l.id];
                          return next;
                        })
                      }
                    />
                  )}
                </Td>
                <Td>{l.label}</Td>
                <Td className="whitespace-nowrap">{formatXOF(l.lineTotal)}</Td>
                <Td className="whitespace-nowrap">{n(l.credited) > 0 ? formatXOF(l.credited) : '—'}</Td>
                <Td className="whitespace-nowrap">{formatXOF(remaining(l))}</Td>
                <Td>
                  {mode === 'full' ? (
                    <span className="font-semibold">{formatXOF(remaining(l))}</span>
                  ) : checked ? (
                    <Input
                      className="w-32"
                      type="number"
                      min={1}
                      max={remaining(l)}
                      step={1}
                      required
                      value={amounts[l.id]}
                      onChange={(e) => setAmounts((a) => ({ ...a, [l.id]: e.target.value }))}
                    />
                  ) : (
                    '—'
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-stone-50 p-3 text-center text-sm sm:grid-cols-4">
          <div>
            Total de l’avoir<div className="text-lg font-bold">{formatXOF(total)}</div>
          </div>
          <div>
            Reste dû actuel<div className="text-lg font-bold">{formatXOF(due)}</div>
          </div>
          <div>
            Réduit le dû<div className="text-lg font-bold text-green-700">{formatXOF(reducedDue)}</div>
          </div>
          <div>
            Excédent<div className={`text-lg font-bold ${excess > 0 ? 'text-red-700' : ''}`}>{formatXOF(excess)}</div>
          </div>
        </div>
        {mode === 'full' && <p className="text-xs text-stone-500">Un avoir total annule la facture.</p>}
        {excess > 0 && (
          <div className="space-y-2 rounded-lg border border-stone-200 p-3 text-sm">
            <div className="font-semibold">Règlement de l’excédent ({formatXOF(excess)})</div>
            {canCustomerCredit && (
              <label className="flex items-start gap-2">
                <input type="radio" name="settlement" className="mt-1" checked={settlementMode === 'CUSTOMER_CREDIT'} onChange={() => setSettlementMode('CUSTOMER_CREDIT')} />
                <span>
                  Crédit client
                  <span className="block text-xs text-stone-500">
                    {formatXOF(excess)} déjà payés sur cette facture redeviennent une avance disponible du client, à répartir sur une autre facture. Aucun mouvement de caisse.
                  </span>
                </span>
              </label>
            )}
            {canRefund && (
              <label className="flex items-start gap-2">
                <input type="radio" name="settlement" className="mt-1" checked={settlementMode === 'REFUND'} onChange={() => setSettlementMode('REFUND')} />
                <span>
                  Remboursement
                  <span className="block text-xs text-stone-500">{formatXOF(excess)} rendus au client (espèces et mobile money par votre caisse ; virement et chèque hors caisse).</span>
                </span>
              </label>
            )}
            {!canCustomerCredit && !canRefund && <p className="text-stone-600">{EXCESS_NO_RIGHT}</p>}
            {settlementMode === 'REFUND' && (
              <div className="space-y-2 border-t border-stone-200 pt-2">
                <div>
                  Montant remboursé : <strong>{formatXOF(excess)}</strong> <span className="text-xs text-stone-500">(égal à l’excédent, non modifiable)</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Moyen de remboursement">
                    <Select value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })}>
                      {REFUND_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {PAYMENT_METHODS[m]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {refund.method !== 'CASH' && (
                    <Field label={refundReferenceRequired ? 'Référence (obligatoire)' : 'Référence'}>
                      <Input
                        required={refundReferenceRequired}
                        maxLength={100}
                        value={refund.reference}
                        onChange={(e) => setRefund({ ...refund, reference: e.target.value })}
                        placeholder="N° de transaction, de chèque…"
                      />
                    </Field>
                  )}
                </div>
                {refundOffRegister ? (
                  <p className="text-xs text-stone-600">{PAYMENT_METHODS[refund.method]} : remboursement hors caisse, sans session.</p>
                ) : session.isLoading ? (
                  <Spinner />
                ) : session.error ? (
                  <Alert>{(session.error as ApiError).message}</Alert>
                ) : sessionOk ? (
                  <p className="text-xs text-stone-600">
                    Remboursé depuis votre session {s!.number} — caisse {s!.register.code}.
                  </p>
                ) : (
                  <Alert tone="info">
                    {PAYMENT_METHODS[refund.method]} : une session de caisse ouverte à votre nom dans l’établissement de la facture est obligatoire. Ouvrez-la depuis l’écran Caisse, ou choisissez virement ou chèque.
                  </Alert>
                )}
              </div>
            )}
          </div>
        )}
        <Field label="Motif (obligatoire)">
          <Textarea rows={2} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && (selected.length > 0 || mode === 'full' || reason) && <Alert tone={error === EXCESS_NO_RIGHT ? 'error' : 'info'}>{error}</Alert>}
        {create.error && <Alert>{(create.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!!error}>
            Créer l’avoir {error ? '' : formatXOF(total)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface FeeDraft {
  key: string;
  label: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  note: string;
}

let feeSeq = 0;
const newFee = (): FeeDraft => ({ key: `f${++feeSeq}`, label: '', quantity: '1', unitPrice: '', taxRate: '0', note: '' });

/**
 * Facture manuelle (POST /invoices, source MANUAL : frais seulement, aucun produit ni stock) et
 * modification d'un brouillon (PATCH /invoices/:id) : notes pour tout brouillon, lignes pour une
 * facture manuelle seulement. Le brouillon reste sans numéro ni effet financier jusqu'à son émission.
 */
function InvoiceForm({ invoiceId, onCancel, onSaved }: { invoiceId: string | null; onCancel: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient();
  const { me, establishmentId: selected } = useAuth();
  // Même identifiant à chaque tentative de ce formulaire : jamais deux factures pour un double clic.
  const requestId = useRequestId();
  const existing = useQuery({ queryKey: ['invoices', 'detail', invoiceId], queryFn: () => api.get<InvoiceDetail>(`/invoices/${invoiceId}`), enabled: !!invoiceId });
  const inv = existing.data;
  const editing = !!invoiceId;

  const allowed = (me?.establishments ?? []).filter((e) => me?.globalPermissions.includes(INVOICE_MANAGE) || e.permissions.includes(INVOICE_MANAGE));
  const [estChoice, setEstChoice] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<FeeDraft[]>([newFee()]);
  // Brouillon existant : le formulaire reprend ses valeurs une fois chargé.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (inv && loadedFor !== inv.id) {
    setLoadedFor(inv.id);
    setNotes(inv.notes ?? '');
    setLines(
      inv.lines.map((l) => ({
        ...newFee(),
        label: l.label,
        quantity: String(n(l.quantity)),
        unitPrice: String(n(l.unitPrice)),
        taxRate: String(n(l.taxRate)),
        note: l.note ?? '',
      })),
    );
  }
  const establishmentId = editing ? inv?.establishmentId ?? '' : selected ?? estChoice;
  // Lignes : saisies pour une nouvelle facture ou un brouillon manuel ; celles d'une commande ou d'un ticket viennent de leur document.
  const linesEditable = !editing || inv?.source === 'MANUAL';

  const lineTotal = (l: FeeDraft) => Math.round((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0));
  const total = lines.reduce((s, l) => s + lineTotal(l), 0);
  const update = (key: string, patch: Partial<FeeDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const lineError = !linesEditable
    ? null
    : lines
        .map((l, i) => {
          const q = Number(l.quantity);
          if (!(q > 0 && q <= 1e6) || Math.round(q * 10000) !== q * 10000) return `Ligne ${i + 1} : quantité positive (4 décimales au plus).`;
          const label = l.label.trim().length;
          if (label < 2 || label > 150) return `Ligne ${i + 1} : libellé de 2 à 150 caractères.`;
          if (l.unitPrice.trim() === '' || !Number.isInteger(Number(l.unitPrice)) || Number(l.unitPrice) < 0) return `Ligne ${i + 1} : prix TTC entier en FCFA.`;
          const t = Number(l.taxRate);
          if (!(t >= 0 && t <= 100) || Math.round(t * 100) !== t * 100) return `Ligne ${i + 1} : TVA entre 0 et 100 % (2 décimales au plus).`;
          return null;
        })
        .find((e) => e);
  const error = !establishmentId
    ? 'Choisissez l’établissement.'
    : !editing && !customer
      ? 'Choisissez le client.'
      : linesEditable && lines.length === 0
        ? 'Ajoutez au moins une ligne.'
        : lineError ?? null;

  const payloadLines = () =>
    lines.map((l) => ({
      kind: 'FEE',
      label: l.label.trim(),
      quantity: Number(l.quantity),
      unitPrice: Number(l.unitPrice),
      taxRate: Number(l.taxRate) || 0,
      ...(l.note.trim() ? { note: l.note.trim() } : {}),
    }));

  const save = useMutation({
    mutationFn: () =>
      editing
        ? // Établissement, client et origine ne se modifient pas (règle du serveur).
          api.patch<InvoiceDetail>(`/invoices/${invoiceId}`, { notes: notes.trim() || null, ...(linesEditable ? { lines: payloadLines() } : {}) })
        : api.post<InvoiceDetail>('/invoices', {
            clientRequestId: requestId,
            source: 'MANUAL',
            establishmentId,
            customerId: customer!.id,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            lines: payloadLines(),
          }),
    onSuccess: (saved) => {
      // La réponse est la fiche de la facture : elle s'affiche sans relecture.
      qc.setQueryData(['invoices', 'detail', saved.id], saved);
      qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
      onSaved(saved.id);
    },
  });

  const lock = useSubmitLock();

  if (editing && existing.isLoading) return <Spinner />;
  if (editing && (existing.error || !inv)) return <Alert>{(existing.error as ApiError | null)?.message ?? 'Facture introuvable'}</Alert>;
  if (editing && inv && inv.status !== 'DRAFT') return <Alert>Facture {inv.number ?? ''} {inv.status === 'CANCELLED' ? 'abandonnée' : 'émise'} : elle ne se modifie plus (correction par avoir).</Alert>;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error && !save.isPending) lock((release) => save.mutate(undefined, { onSettled: release }));
      }}
    >
      <Card title={editing ? 'Modifier le brouillon de facture' : 'Nouvelle facture manuelle'}>
        <div className="grid gap-3 md:grid-cols-2">
          {editing ? (
            <div className="text-sm">
              Établissement : <strong>{me?.establishments.find((e) => e.id === inv?.establishmentId)?.name ?? '—'}</strong>
              <br />
              Client : <strong>{inv?.customer?.name}</strong> · Origine : <strong>{inv ? INVOICE_SOURCES[inv.source] : ''}</strong>
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
              <div className="md:col-span-2">
                <span className="mb-1 block text-sm font-medium text-stone-700">Client</span>
                <CustomerPicker establishmentId={establishmentId} value={customer} onChange={setCustomer} showCredit={false} />
              </div>
            </>
          )}
          <Field label="Notes (facultatif)">
            <Textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </Card>

      {linesEditable ? (
        <Card
          title="Lignes (frais)"
          actions={
            <Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, newFee()])}>
              <Plus className="size-4" /> Ligne
            </Button>
          }
        >
          <div className="space-y-3">
            {lines.map((l, i) => (
              <div key={l.key} className="grid gap-2 rounded-lg border border-stone-200 p-3 md:grid-cols-[2fr_6rem_8rem_6rem_8rem_auto] md:items-end">
                <Field label={`Ligne ${i + 1} — libellé`}>
                  <Input maxLength={150} value={l.label} onChange={(e) => update(l.key, { label: e.target.value })} placeholder="Prestation, location, service…" />
                </Field>
                <Field label="Quantité">
                  <Input type="number" min={0.0001} step="any" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                </Field>
                <Field label="Prix TTC (FCFA)">
                  <Input type="number" min={0} step={1} value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} />
                </Field>
                <Field label="TVA (%)">
                  <Input type="number" min={0} max={100} step={0.01} value={l.taxRate} onChange={(e) => update(l.key, { taxRate: e.target.value })} />
                </Field>
                <div className="text-sm">
                  <span className="block text-sm font-medium text-stone-700">Total TTC</span>
                  <span className="block py-2 font-semibold">{formatXOF(lineTotal(l))}</span>
                </div>
                <Button type="button" variant="ghost" aria-label="Retirer la ligne" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Trash2 className="size-4" />
                </Button>
                <div className="md:col-span-6">
                  <Input maxLength={500} value={l.note} onChange={(e) => update(l.key, { note: e.target.value })} placeholder="Note de ligne (facultatif)" />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end text-base font-bold">Total TTC estimé : {formatXOF(total)}</div>
          <p className="mt-1 text-right text-xs text-stone-500">Une facture manuelle ne contient que des frais ; un produit se facture depuis sa commande ou son ticket. Total arrondi par le serveur.</p>
        </Card>
      ) : (
        <Alert tone="info">Les lignes de ce brouillon viennent de {inv?.order ? `la commande ${inv.order.number}` : inv?.sale ? `du ticket ${inv.sale.number}` : 'leur document'} : seules les notes se modifient ici.</Alert>
      )}

      {!editing && <p className="text-xs text-stone-500">La facture est créée en brouillon, sans numéro : aucun encaissement ni effet sur le crédit client avant son émission.</p>}
      {error && <Alert tone="info">{error}</Alert>}
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={save.isPending} onClick={onCancel}>
          Annuler
        </Button>
        <Button type="submit" loading={save.isPending} disabled={!!error}>
          {editing ? 'Enregistrer le brouillon' : 'Créer le brouillon'}
        </Button>
      </div>
    </form>
  );
}

function InvoiceView({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: () => void }) {
  const { me } = useAuth();
  const [paying, setPaying] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [lastCreditNote, setLastCreditNote] = useState<CreatedCreditNote | null>(null);
  const [applying, setApplying] = useState(false);
  const [lastApplied, setLastApplied] = useState<{ deposit: string; amount: number; balance: string } | null>(null);
  const { data: inv, isLoading, error } = useQuery({ queryKey: ['invoices', 'detail', id], queryFn: () => api.get<InvoiceDetail>(`/invoices/${id}`) });
  // Émission : numéro FAC et échéance attribués par le serveur, facture figée ; la réponse est la fiche à jour.
  const qc = useQueryClient();
  const [issuing, setIssuing] = useState(false);
  const issue = useMutation({
    mutationFn: () => api.post<InvoiceDetail>(`/invoices/${id}/issue`),
    onSuccess: (updated) => {
      qc.setQueryData(['invoices', 'detail', id], updated);
      qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
      qc.invalidateQueries({ queryKey: ['customer-credit'] });
      if (updated.orderId) qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', updated.orderId] });
      setIssuing(false);
    },
  });
  // Abandon d'un brouillon (POST /invoices/:id/cancel { reason }) : jamais numéroté ni supprimé ; la commande redevient facturable.
  const [abandoning, setAbandoning] = useState(false);
  const [abandonReason, setAbandonReason] = useState('');
  const abandonLength = abandonReason.trim().length;
  const abandonError = abandonLength < 3 || abandonLength > 500 ? 'Motif obligatoire (3 à 500 caractères).' : null;
  const abandon = useMutation({
    mutationFn: () => api.post<InvoiceDetail>(`/invoices/${id}/cancel`, { reason: abandonReason.trim() }),
    onSuccess: (updated) => {
      qc.setQueryData(['invoices', 'detail', id], updated);
      qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
      if (updated.orderId) qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', updated.orderId] });
      setAbandoning(false);
    },
  });
  // Litige (POST /invoices/:id/dispute ou /resolve-dispute, { reason } obligatoire) : émise ⇄ en litige, la réponse est la fiche à jour.
  const [disputeMode, setDisputeMode] = useState<'open' | 'resolve' | null>(null);
  const [disputeText, setDisputeText] = useState('');
  const disputeLength = disputeText.trim().length;
  const disputeError = disputeLength < 3 || disputeLength > 500 ? 'Motif obligatoire (3 à 500 caractères).' : null;
  const dispute = useMutation({
    mutationFn: (mode: 'open' | 'resolve') => api.post<InvoiceDetail>(`/invoices/${id}/${mode === 'open' ? 'dispute' : 'resolve-dispute'}`, { reason: disputeText.trim() }),
    onSuccess: (updated) => {
      qc.setQueryData(['invoices', 'detail', id], updated);
      qc.invalidateQueries({ queryKey: ['invoices', 'list'] });
      if (updated.orderId) qc.invalidateQueries({ queryKey: ['customer-orders', 'detail', updated.orderId] });
      setDisputeMode(null);
    },
  });
  const issueLock = useSubmitLock();
  const abandonLock = useSubmitLock();
  const disputeLock = useSubmitLock();
  const openDispute = (mode: 'open' | 'resolve') => {
    setDisputeText('');
    dispute.reset();
    setDisputeMode(mode);
  };
  // Impression : lecture seule, un GET au clic (GET /invoices/:id ou /credit-notes/:id), puis impression par le navigateur.
  // L'avoir reprend le client de la fiche facture déjà chargée.
  const [printing, setPrinting] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const print = async (creditNoteId?: string) => {
    if (printing || !me || !inv) return;
    setPrinting(creditNoteId ?? 'invoice');
    setPrintError(null);
    const place = me.establishments.find((e) => e.id === inv.establishmentId);
    const h: PrintHeader = { company: me.company.name, establishment: place ? `${place.code} — ${place.name}` : null };
    try {
      if (creditNoteId) {
        const cn = await api.get<CreditNoteDetail>(`/credit-notes/${creditNoteId}`);
        printLines(creditNotePrintLines(cn, inv, h), PRINT_WIDTH, `Avoir ${cn.number}`);
      } else {
        const fresh = await api.get<InvoiceDetail>(`/invoices/${id}`);
        printLines(invoicePrintLines(fresh, h), PRINT_WIDTH, fresh.number ? `Facture ${fresh.number}` : 'Facture brouillon');
      }
    } catch (e) {
      setPrintError(e instanceof ApiError ? `Impression impossible : ${e.message}` : 'Impression impossible : le document n’a pas pu être préparé.');
    } finally {
      setPrinting(null);
    }
  };
  const back = (
    <Button variant="ghost" onClick={onBack}>
      <ArrowLeft className="size-4" /> Retour à la liste
    </Button>
  );
  if (isLoading) return <Spinner />;
  if (error || !inv)
    return (
      <div className="space-y-3">
        {back}
        <Alert>{(error as ApiError | null)?.message ?? 'Facture introuvable'}</Alert>
      </div>
    );
  // Émission : brouillon, « Émettre / annuler des factures » dans son établissement (canManage, calculé par le serveur).
  const canIssue = inv.status === 'DRAFT' && inv.canManage;
  const est = me?.establishments.find((e) => e.id === inv.establishmentId);
  const origin = inv.source === 'ORDER' && inv.order ? `${INVOICE_SOURCES.ORDER} ${inv.order.number}` : inv.source === 'SALE' && inv.sale ? `Ticket ${inv.sale.number} (vente à crédit)` : INVOICE_SOURCES[inv.source];
  const activeAllocations = inv.allocations.filter((a) => !a.releasedAt);
  // Encaissement : facture émise ou en litige, reste dû, « Encaisser paiements et acomptes » dans son établissement (le serveur reste seul juge).
  const hasHere = (perm: string) => !!me?.globalPermissions.includes(perm) || !!est?.permissions.includes(perm);
  const canPayHere = hasHere('payments.manage');
  const canPay = (inv.status === 'ISSUED' || inv.status === 'DISPUTED') && n(inv.balance) > 0 && canPayHere;
  // Avoir : facture émise ou en litige, montant encore corrigeable, « Émettre / annuler des factures » (canManage, calculé par le serveur).
  const canCredit = (inv.status === 'ISSUED' || inv.status === 'DISPUTED') && n(inv.correctable) > 0 && inv.canManage;
  // Litige : émise → en litige, en litige → émise, « Émettre / annuler des factures » (canManage, calculé par le serveur).
  const canDispute = inv.status === 'ISSUED' && inv.canManage;
  const canResolve = inv.status === 'DISPUTED' && inv.canManage;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={printing === 'invoice'} disabled={!!printing} onClick={() => print()}>
            <Printer className="size-4" /> Imprimer
          </Button>
          {canIssue && (
            <Button
              variant="danger"
              disabled={issue.isPending || abandon.isPending}
              onClick={() => {
                setAbandonReason('');
                abandon.reset();
                setAbandoning(true);
              }}
            >
              <Ban className="size-4" /> Abandonner le brouillon
            </Button>
          )}
          {canIssue && (
            <Button variant="secondary" disabled={issue.isPending || abandon.isPending} onClick={onEdit}>
              <Pencil className="size-4" /> Modifier
            </Button>
          )}
          {canIssue && (
            <Button disabled={issue.isPending} onClick={() => setIssuing(true)}>
              <Send className="size-4" /> Émettre la facture
            </Button>
          )}
          {canDispute && (
            <Button variant="secondary" disabled={dispute.isPending} onClick={() => openDispute('open')}>
              <AlertTriangle className="size-4" /> Mettre en litige
            </Button>
          )}
          {canResolve && (
            <Button variant="secondary" disabled={dispute.isPending} onClick={() => openDispute('resolve')}>
              <CheckCircle2 className="size-4" /> Lever le litige
            </Button>
          )}
          {canCredit && (
            <Button variant="secondary" onClick={() => setCrediting(true)}>
              <FileMinus className="size-4" /> Créer un avoir
            </Button>
          )}
          {canPay && (
            <Button variant="secondary" onClick={() => setApplying(true)}>
              <PiggyBank className="size-4" /> Imputer un acompte
            </Button>
          )}
          {canPay && (
            <Button onClick={() => setPaying(true)}>
              <Wallet className="size-4" /> Encaisser
            </Button>
          )}
        </div>
      </div>
      {printError && <Alert>{printError}</Alert>}
      {issue.data && (
        <Alert tone="success">
          Facture émise : <strong>{issue.data.number}</strong>, échéance le {formatDate(issue.data.dueDate)}.
        </Alert>
      )}
      <Modal open={abandoning} title="Abandonner le brouillon de facture" onClose={() => !abandon.isPending && setAbandoning(false)}>
        <form
          className="space-y-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (!abandonError && !abandon.isPending) abandonLock((release) => abandon.mutate(undefined, { onSettled: release }));
          }}
        >
          <p>
            Brouillon de <strong>{inv.customer?.name}</strong> pour <strong>{formatXOF(inv.total)}</strong>
            {inv.order ? `, commande ${inv.order.number}` : ''}. Il est conservé comme « annulé », sans numéro FAC (aucun numéro consommé)
            {inv.order ? ' ; la commande pourra être facturée à nouveau' : ''}.
          </p>
          <Field label="Motif">
            <Textarea rows={2} required minLength={3} maxLength={500} value={abandonReason} onChange={(e) => setAbandonReason(e.target.value)} placeholder="Facture créée par erreur…" />
          </Field>
          {abandonError && abandonReason && <Alert tone="info">{abandonError}</Alert>}
          {abandon.error && <Alert>{(abandon.error as ApiError).message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={abandon.isPending} onClick={() => setAbandoning(false)}>
              Retour
            </Button>
            <Button type="submit" variant="danger" loading={abandon.isPending} disabled={!!abandonError}>
              Abandonner le brouillon
            </Button>
          </div>
        </form>
      </Modal>
      {dispute.data && !disputeMode && (
        <Alert tone="success">
          {dispute.data.status === 'DISPUTED' ? (
            <>
              Facture <strong>{dispute.data.number}</strong> mise en litige.
            </>
          ) : (
            <>
              Litige levé : la facture <strong>{dispute.data.number}</strong> est de nouveau émise.
            </>
          )}
        </Alert>
      )}
      <Modal
        open={disputeMode !== null}
        title={disputeMode === 'resolve' ? `Lever le litige — facture ${inv.number}` : `Mettre en litige — facture ${inv.number}`}
        onClose={() => !dispute.isPending && setDisputeMode(null)}
      >
        <form
          className="space-y-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (disputeMode && !disputeError && !dispute.isPending) disputeLock((release) => dispute.mutate(disputeMode, { onSettled: release }));
          }}
        >
          {disputeMode === 'resolve' ? (
            <p>
              Litige ouvert le {formatDateTime(inv.disputedAt)} : {inv.disputeReason}. La facture redevient « émise ».
            </p>
          ) : (
            <p>
              Facture de <strong>{inv.customer?.name}</strong> pour <strong>{formatXOF(inv.total)}</strong>. Elle passe « en litige » : elle reste due et peut toujours être encaissée ou corrigée par un avoir.
            </p>
          )}
          <Field label="Motif">
            <Textarea
              rows={2}
              required
              minLength={3}
              maxLength={500}
              value={disputeText}
              onChange={(e) => setDisputeText(e.target.value)}
              placeholder={disputeMode === 'resolve' ? 'Accord trouvé avec le client…' : 'Quantité livrée contestée par le client…'}
            />
          </Field>
          {disputeError && disputeText && <Alert tone="info">{disputeError}</Alert>}
          {dispute.error && <Alert>{(dispute.error as ApiError).message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={dispute.isPending} onClick={() => setDisputeMode(null)}>
              Retour
            </Button>
            <Button type="submit" loading={dispute.isPending} disabled={!!disputeError}>
              {disputeMode === 'resolve' ? 'Lever le litige' : 'Mettre en litige'}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal open={issuing} title="Émettre la facture" onClose={() => !issue.isPending && setIssuing(false)}>
        <div className="space-y-3 text-sm">
          <p>
            Facture de <strong>{inv.customer?.name}</strong> pour <strong>{formatXOF(inv.total)}</strong>.
          </p>
          <p>À l’émission, un numéro FAC est attribué et l’échéance calculée selon les conditions du client. La facture est alors figée : elle ne se corrige plus que par un avoir.</p>
          {issue.error && <Alert>{(issue.error as ApiError).message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={issue.isPending} onClick={() => setIssuing(false)}>
              Retour
            </Button>
            <Button loading={issue.isPending} onClick={() => !issue.isPending && issueLock((release) => issue.mutate(undefined, { onSettled: release }))}>
              Émettre la facture
            </Button>
          </div>
        </div>
      </Modal>
      {lastApplied && (
        <Alert tone="success">
          Acompte <strong>{lastApplied.deposit}</strong> imputé : {formatXOF(lastApplied.amount)}. Nouveau reste dû : <strong>{formatXOF(Math.max(0, n(lastApplied.balance)))}</strong>.
        </Alert>
      )}
      {applying && (
        <ApplyDeposit
          inv={inv}
          onClose={() => setApplying(false)}
          onApplied={(r) => {
            setApplying(false);
            setLastApplied(r);
          }}
        />
      )}
      {lastCreditNote && (
        <Alert tone="success">
          Avoir <strong>{lastCreditNote.number}</strong> créé : {formatXOF(lastCreditNote.total)} ({formatXOF(lastCreditNote.reducedDue)} déduits du reste dû
          {n(lastCreditNote.customerCredit) > 0 ? `, ${formatXOF(lastCreditNote.customerCredit)} devenus crédit client` : ''}
          {n(lastCreditNote.refundAmount) > 0 ? `, ${formatXOF(lastCreditNote.refundAmount)} remboursés` : ''}).
        </Alert>
      )}
      {paying && <PayInvoice inv={inv} onClose={() => setPaying(false)} />}
      {crediting && (
        <CreateCreditNote
          inv={inv}
          canCustomerCredit={canPayHere}
          canRefund={canPayHere && hasHere('sales.refund')}
          canOperateCash={hasHere('cash.operate')}
          onClose={() => setCrediting(false)}
          onCreated={(cn) => {
            setCrediting(false);
            setLastCreditNote(cn);
          }}
        />
      )}
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            {inv.number ? `Facture ${inv.number}` : inv.status === 'CANCELLED' ? 'Facture annulée (sans numéro)' : 'Facture (brouillon, sans numéro)'} <InvoiceBadges status={inv.status} paymentStatus={inv.paymentStatus} overdue={inv.overdue} />
          </span>
        }
      >
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Info label="Client">
            <strong>{inv.customer?.name ?? '—'}</strong>
            {inv.customer?.phone ? ` · ${inv.customer.phone}` : ''}
          </Info>
          {inv.customer?.taxId && <Info label="N° contribuable">{inv.customer.taxId}</Info>}
          {inv.customer?.address && <Info label="Adresse">{inv.customer.address}</Info>}
          <Info label="Établissement">{est ? `${est.code} — ${est.name}` : '—'}</Info>
          <Info label="Origine">{origin}</Info>
          <Info label="Émise le">{inv.issuedAt ? `${formatDateTime(inv.issuedAt)}${inv.issuedBy ? ` par ${inv.issuedBy}` : ''}` : 'non émise'}</Info>
          <Info label="Échéance">
            {formatDate(inv.dueDate)}
            {inv.paymentTermDays !== null ? ` (${inv.paymentTermDays > 0 ? `${inv.paymentTermDays} j` : 'comptant'})` : ''}
          </Info>
          <Info label="Créée le">{`${formatDateTime(inv.createdAt)}${inv.createdBy ? ` par ${inv.createdBy}` : ''}`}</Info>
          {inv.notes && <div className="text-stone-600 sm:col-span-2">{inv.notes}</div>}
        </dl>
        {inv.status === 'DISPUTED' && (
          <div className="mt-3">
            <Alert tone="info">
              En litige depuis le {formatDateTime(inv.disputedAt)} : {inv.disputeReason}
            </Alert>
          </div>
        )}
        {inv.status === 'CANCELLED' && inv.cancelledAt && (
          <div className="mt-3">
            <Alert>
              Annulée le {formatDateTime(inv.cancelledAt)}
              {inv.cancelledBy ? ` par ${inv.cancelledBy}` : ''} : {inv.cancelReason}
            </Alert>
          </div>
        )}
      </Card>

      <Card title="Lignes">
        <Table head={['Désignation', 'Qté', 'Prix TTC', 'TVA', 'Total TTC', 'Corrigé par avoir']} empty={inv.lines.length === 0}>
          {inv.lines.map((l) => (
            <tr key={l.id}>
              <Td>
                {l.label} {l.kind === 'FEE' && <Badge>Frais</Badge>}
                {l.productCode && <div className="font-mono text-xs text-stone-500">{l.productCode}</div>}
                {l.note && <div className="text-xs text-stone-500">{l.note}</div>}
              </Td>
              <Td>{qty(l.quantity)}</Td>
              <Td className="whitespace-nowrap">{formatXOF(l.unitPrice)}</Td>
              <Td className="whitespace-nowrap">{n(l.taxRate) > 0 ? `${n(l.taxRate)} %` : '—'}</Td>
              <Td className="whitespace-nowrap font-semibold">{formatXOF(l.lineTotal)}</Td>
              <Td className="whitespace-nowrap text-xs">{n(l.credited) > 0 ? `−${formatXOF(l.credited)}` : ''}</Td>
            </tr>
          ))}
        </Table>
        <div className="mt-3 ml-auto max-w-sm space-y-1 text-sm">
          <Row label="Total TTC" value={formatXOF(inv.total)} strong />
          {n(inv.taxTotal) > 0 && <Row label="dont TVA" value={formatXOF(inv.taxTotal)} />}
          {n(inv.credited) > 0 && <Row label="Avoirs" value={`−${formatXOF(inv.credited)}`} />}
          {n(inv.posPaidAmount) > 0 && <Row label="dont réglé au ticket" value={formatXOF(inv.posPaidAmount)} tone="text-stone-500" />}
          <Row label="Payé" value={formatXOF(inv.paid)} />
          <Row label="Reste dû" value={formatXOF(inv.balance)} strong tone={n(inv.balance) > 0 && inv.paymentStatus ? 'text-red-700' : ''} />
        </div>
      </Card>

      <Card title="Paiements répartis sur la facture">
        {inv.allocations.length === 0 ? (
          <p className="text-sm text-stone-500">
            Aucun paiement réparti{n(inv.posPaidAmount) > 0 ? ` (réglé au ticket : ${formatXOF(inv.posPaidAmount)})` : ''}.
          </p>
        ) : (
          <Table head={['Date', 'Paiement', 'Moyen', 'Référence', 'Acompte', 'Montant', 'État']}>
            {inv.allocations.map((a) => (
              <tr key={a.id} className={a.releasedAt ? 'text-stone-400' : ''}>
                <Td className="whitespace-nowrap">{formatDateTime(a.createdAt)}</Td>
                <Td className="font-mono text-xs">{a.payment.number}</Td>
                <Td>{a.methodLabel}</Td>
                <Td className="text-xs">{a.payment.reference ?? '—'}</Td>
                <Td className="font-mono text-xs">{a.deposit?.number ?? '—'}</Td>
                <Td className="whitespace-nowrap font-semibold">{formatXOF(a.amount)}</Td>
                <Td className="text-xs">{a.releasedAt ? `Libérée le ${formatDateTime(a.releasedAt)}${a.releaseReason ? ` : ${a.releaseReason}` : ''}` : <Badge tone="green">Active</Badge>}</Td>
              </tr>
            ))}
          </Table>
        )}
        {activeAllocations.length > 0 && (
          <p className="mt-2 text-xs text-stone-500">Total réparti actif : {formatXOF(activeAllocations.reduce((s, a) => s + n(a.amount), 0))}</p>
        )}
      </Card>

      {inv.creditNotes.length > 0 && (
        <Card title="Avoirs">
          <Table head={['Avoir', 'Date', 'Motif', 'Total', 'Réduit le dû', 'Crédit client', 'Remboursé', '']}>
            {inv.creditNotes.map((c) => (
              <tr key={c.id}>
                <Td className="font-mono text-xs font-semibold">{c.number}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(c.createdAt)}</Td>
                <Td className="text-xs">
                  {c.reason}
                  {c.lines.length > 0 && <div className="text-stone-500">{c.lines.map((l) => `${l.label} −${formatXOF(l.amount)}`).join(' · ')}</div>}
                </Td>
                <Td className="whitespace-nowrap font-semibold">{formatXOF(c.total)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(c.reducedDue)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(c.customerCredit)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(c.refundAmount)}</Td>
                <Td>
                  <Button variant="ghost" className="px-2 py-1 text-xs" loading={printing === c.id} disabled={!!printing} onClick={() => print(c.id)}>
                    <Printer className="size-3.5" /> Imprimer
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
