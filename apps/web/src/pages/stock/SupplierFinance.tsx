import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { formatDate, formatDateTime, formatXOF } from '../../lib/format';
import { INVOICE_STATUS, PAYMENT_METHODS } from '../../lib/stock-types';
import { RequireEstablishment, RequirePermission, StatusBadge, Tabs, useEstablishment, useReasonDialog, useRequestId, useSuppliers } from './shared';

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all(['supplier-invoices', 'supplier-payments', 'supplier-account', 'goods-receipts'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

interface InvoiceRec {
  id: string;
  number: string;
  supplierRef: string;
  invoiceDate: string;
  dueDate: string;
  amount: string;
  receivedValue: string;
  paidAmount: string;
  remaining: string;
  variance: string;
  status: string;
  isOverdue: boolean;
  cancelReason: string | null;
  supplier: { name: string } | null;
  receipts: { id: string; number: string }[];
}

interface PaymentRec {
  id: string;
  number: string;
  amount: string;
  method: string;
  reference: string | null;
  paidAt: string;
  unallocated: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  supplierId: string;
  supplier: { name: string } | null;
  createdBy: string | null;
  allocations: { id: string; amount: string; invoice: { number: string; supplierRef: string } }[];
}

interface Account {
  supplier: { id: string; name: string; paymentTermsDays: number; creditLimit: string | null };
  invoiced: string;
  paid: string;
  credited: string;
  balance: string;
  advances: string;
  unappliedCredits: string;
  overdue: string;
  openInvoices: { id: string; number: string; supplierRef: string; dueDate: string; amount: string; paidAmount: string; remaining: string; status: string }[];
  uninvoicedReceipts: { id: string; number: string; receivedAt: string; totalValue: string }[];
  uninvoicedValue: string;
  purchaseHistory: { id: string; number: string; receivedAt: string; totalValue: string; lines: number; invoice: string | null; purchaseOrder: { number: string } | null }[];
  returns: { id: string; number: string; createdAt: string; reason: string; totalValue: string; creditNote: { number: string } | null }[];
}

function useAccount(supplierId: string) {
  return useQuery({ queryKey: ['supplier-account', supplierId], queryFn: () => api.get<Account>(`/suppliers/${supplierId}/account`), enabled: !!supplierId });
}

function SupplierPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const suppliers = useSuppliers();
  return (
    <Select required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Fournisseur —</option>
      {suppliers.data?.map((s) => (
        <option key={s.id} value={s.id}>
          {s.code} — {s.name}
        </option>
      ))}
    </Select>
  );
}

function InvoiceForm({ establishmentId, onDone }: { establishmentId: string; onDone: () => void }) {
  const requestId = useRequestId();
  const qc = useQueryClient();
  const [supplierId, setSupplierId] = useState('');
  const account = useAccount(supplierId);
  const [receiptIds, setReceiptIds] = useState<string[]>([]);
  const [f, setF] = useState({ supplierRef: '', invoiceDate: new Date().toISOString().slice(0, 10), dueDate: '', amount: '', notes: '' });
  const receivedValue = (account.data?.uninvoicedReceipts ?? []).filter((r) => receiptIds.includes(r.id)).reduce((s, r) => s + Number(r.totalValue), 0);
  const variance = Number(f.amount || 0) - receivedValue;
  const save = useMutation({
    mutationFn: () => api.post('/supplier-invoices', { clientRequestId: requestId, establishmentId, supplierId, ...f, dueDate: f.dueDate || undefined, amount: Number(f.amount), receiptIds, notes: f.notes || null }),
    onSuccess: async () => {
      await invalidate(qc);
      onDone();
    },
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <Field label="Fournisseur">
        <SupplierPicker value={supplierId} onChange={(id) => (setSupplierId(id), setReceiptIds([]))} />
      </Field>
      {supplierId && (
        <div className="space-y-1">
          <div className="text-sm font-medium text-stone-700">Réceptions facturées</div>
          {account.data?.uninvoicedReceipts.length === 0 && <p className="text-sm text-stone-500">Aucune réception non facturée pour ce fournisseur.</p>}
          {account.data?.uninvoicedReceipts.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={receiptIds.includes(r.id)} onChange={(e) => setReceiptIds(e.target.checked ? [...receiptIds, r.id] : receiptIds.filter((x) => x !== r.id))} />
              {r.number} — {formatDate(r.receivedAt)} — {formatXOF(r.totalValue)}
            </label>
          ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="N° de la facture du fournisseur">
          <Input required value={f.supplierRef} onChange={(e) => setF({ ...f, supplierRef: e.target.value })} />
        </Field>
        <Field label="Montant TTC (FCFA)">
          <Input required type="number" min="1" step="1" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label="Date de facture">
          <Input required type="date" value={f.invoiceDate} onChange={(e) => setF({ ...f, invoiceDate: e.target.value })} />
        </Field>
        <Field label="Échéance" hint={`Vide = date + délai du fournisseur (${account.data?.supplier.paymentTermsDays ?? 0} j)`}>
          <Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
        </Field>
      </div>
      {receiptIds.length > 0 && f.amount && (
        <Alert tone={variance === 0 ? 'success' : 'info'}>
          Valeur des réceptions : {formatXOF(receivedValue)} · écart avec la facture : <strong>{variance > 0 ? '+' : ''}{formatXOF(variance)}</strong>
        </Alert>
      )}
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending} disabled={!supplierId}>
          Enregistrer la facture
        </Button>
      </div>
    </form>
  );
}

function PaymentForm({ establishmentId, onDone }: { establishmentId: string; onDone: () => void }) {
  const requestId = useRequestId();
  const qc = useQueryClient();
  const [supplierId, setSupplierId] = useState('');
  const account = useAccount(supplierId);
  const [f, setF] = useState({ amount: '', method: 'CASH', reference: '', paidAt: '', notes: '' });
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const allocated = Object.values(alloc).reduce((s, v) => s + Number(v || 0), 0);
  const advance = Number(f.amount || 0) - allocated;
  const save = useMutation({
    mutationFn: () =>
      api.post('/supplier-payments', {
        clientRequestId: requestId,
        establishmentId,
        supplierId,
        amount: Number(f.amount),
        method: f.method,
        reference: f.reference || null,
        paidAt: f.paidAt ? new Date(f.paidAt).toISOString() : undefined,
        notes: f.notes || null,
        allocations: Object.entries(alloc)
          .filter(([, v]) => Number(v) > 0)
          .map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) })),
      }),
    onSuccess: async () => {
      await invalidate(qc);
      onDone();
    },
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <Field label="Fournisseur">
        <SupplierPicker value={supplierId} onChange={(id) => (setSupplierId(id), setAlloc({}))} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Montant payé (FCFA)">
          <Input required type="number" min="1" step="1" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label="Mode de paiement">
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {Object.entries(PAYMENT_METHODS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Référence (n° transaction, chèque…)">
          <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
      </div>
      {supplierId && (
        <div className="space-y-1">
          <div className="text-sm font-medium text-stone-700">Répartition sur les factures</div>
          {account.data?.openInvoices.length === 0 && <p className="text-sm text-stone-500">Aucune facture ouverte : le paiement sera enregistré comme avance.</p>}
          {account.data?.openInvoices.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-64">
                {i.number} ({i.supplierRef}) · reste <strong>{formatXOF(i.remaining)}</strong> · échéance {formatDate(i.dueDate)}
              </span>
              <Input className="w-36" type="number" min="0" max={Number(i.remaining)} step="1" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} />
              <Button type="button" variant="ghost" onClick={() => setAlloc({ ...alloc, [i.id]: String(Math.min(Number(i.remaining), Math.max(0, advance + Number(alloc[i.id] || 0)))) })}>
                Solder
              </Button>
            </div>
          ))}
        </div>
      )}
      {f.amount && (
        <Alert tone={advance < 0 ? 'error' : 'info'}>
          Affecté : {formatXOF(allocated)} · {advance >= 0 ? `avance (non affectée) : ${formatXOF(advance)}` : 'la répartition dépasse le montant payé'}
        </Alert>
      )}
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending} disabled={!supplierId || advance < 0}>
          Enregistrer le paiement
        </Button>
      </div>
    </form>
  );
}

function InvoicesTab({ establishmentId }: { establishmentId: string }) {
  const qc = useQueryClient();
  const { can } = useEstablishment();
  const reason = useReasonDialog();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['supplier-invoices', establishmentId, status],
    queryFn: () => api.get<InvoiceRec[]>(`/supplier-invoices?establishmentId=${establishmentId}${status ? `&status=${status}` : ''}`),
  });
  const cancel = useMutation({ mutationFn: ({ id, r }: { id: string; r: string }) => api.post(`/supplier-invoices/${id}/cancel`, { reason: r }), onSuccess: () => invalidate(qc) });
  const manage = can('supplier_payments.manage');
  return (
    <Card
      title="Factures fournisseurs"
      actions={
        manage && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Saisir une facture
          </Button>
        )
      }
    >
      {reason.dialog}
      {cancel.error && <Alert>{(cancel.error as ApiError).message}</Alert>}
      <Select className="mb-3 max-w-[14rem]" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">Tous les statuts</option>
        {Object.entries(INVOICE_STATUS).map(([k, v]) => (
          <option key={k} value={k}>
            {v.label}
          </option>
        ))}
      </Select>
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['N°', 'Fournisseur / réf.', 'Date', 'Échéance', 'Montant', 'Écart / réceptions', 'Reste', 'Statut', '']} empty={data?.length === 0}>
          {data?.map((i) => (
            <tr key={i.id}>
              <Td className="font-mono text-xs">{i.number}</Td>
              <Td>
                {i.supplier?.name}
                <div className="text-xs text-stone-500">
                  {i.supplierRef} · {i.receipts.map((r) => r.number).join(', ') || 'sans réception'}
                </div>
              </Td>
              <Td>{formatDate(i.invoiceDate)}</Td>
              <Td className="whitespace-nowrap">
                {formatDate(i.dueDate)} {i.isOverdue && <Badge tone="red">Échue</Badge>}
              </Td>
              <Td className="whitespace-nowrap">{formatXOF(i.amount)}</Td>
              <Td className="whitespace-nowrap">{Number(i.variance) === 0 ? <Badge tone="green">0</Badge> : <Badge tone="orange">{Number(i.variance) > 0 ? '+' : ''}{formatXOF(i.variance)}</Badge>}</Td>
              <Td className="whitespace-nowrap font-semibold">{i.status === 'CANCELLED' ? '—' : formatXOF(i.remaining)}</Td>
              <Td>
                <StatusBadge map={INVOICE_STATUS} status={i.status} />
                {i.cancelReason && <div className="text-xs text-stone-500">{i.cancelReason}</div>}
              </Td>
              <Td>
                {manage && i.status === 'OPEN' && (
                  <Button variant="ghost" onClick={() => reason.ask(`Annuler la facture ${i.number}`, (r) => cancel.mutate({ id: i.id, r }))}>
                    Annuler
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Saisir une facture fournisseur" wide>
        {creating && <InvoiceForm establishmentId={establishmentId} onDone={() => setCreating(false)} />}
      </Modal>
    </Card>
  );
}

function AllocateAdvance({ payment, onDone }: { payment: PaymentRec; onDone: () => void }) {
  const qc = useQueryClient();
  const account = useAccount(payment.supplierId);
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/supplier-payments/${payment.id}/allocations`, { invoiceId, amount: Number(amount) }),
    onSuccess: async () => {
      await invalidate(qc);
      onDone();
    },
  });
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <p className="text-sm">Avance disponible : {formatXOF(payment.unallocated)}</p>
      <Select required value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
        <option value="">— Facture —</option>
        {account.data?.openInvoices.map((i) => (
          <option key={i.id} value={i.id}>
            {i.number} ({i.supplierRef}) — reste {formatXOF(i.remaining)}
          </option>
        ))}
      </Select>
      <Input required type="number" min="1" step="1" placeholder="Montant" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Affecter
        </Button>
      </div>
    </form>
  );
}

function PaymentsTab({ establishmentId }: { establishmentId: string }) {
  const qc = useQueryClient();
  const { can } = useEstablishment();
  const reason = useReasonDialog();
  const [creating, setCreating] = useState(false);
  const [allocating, setAllocating] = useState<PaymentRec | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['supplier-payments', establishmentId], queryFn: () => api.get<PaymentRec[]>(`/supplier-payments?establishmentId=${establishmentId}`) });
  const cancel = useMutation({ mutationFn: ({ id, r }: { id: string; r: string }) => api.post(`/supplier-payments/${id}/cancel`, { reason: r }), onSuccess: () => invalidate(qc) });
  const manage = can('supplier_payments.manage');
  return (
    <Card
      title="Paiements fournisseurs"
      actions={
        manage && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Enregistrer un paiement
          </Button>
        )
      }
    >
      {reason.dialog}
      {cancel.error && <Alert>{(cancel.error as ApiError).message}</Alert>}
      {isLoading ? (
        <Spinner />
      ) : (
        <Table head={['N°', 'Date', 'Fournisseur', 'Montant', 'Mode', 'Affectations', 'Avance', '']} empty={data?.length === 0}>
          {data?.map((p) => (
            <tr key={p.id} className={p.cancelledAt ? 'text-stone-400 line-through' : ''}>
              <Td className="font-mono text-xs">{p.number}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(p.paidAt)}</Td>
              <Td>{p.supplier?.name}</Td>
              <Td className="whitespace-nowrap">{formatXOF(p.amount)}</Td>
              <Td>
                {PAYMENT_METHODS[p.method]}
                {p.reference && <div className="text-xs">{p.reference}</div>}
              </Td>
              <Td>
                {p.allocations.map((a) => (
                  <div key={a.id} className="text-xs">
                    {a.invoice.number} : {formatXOF(a.amount)}
                  </div>
                ))}
              </Td>
              <Td className="whitespace-nowrap">{Number(p.unallocated) > 0 ? <Badge tone="blue">{formatXOF(p.unallocated)}</Badge> : '—'}</Td>
              <Td className="whitespace-nowrap no-underline">
                {p.cancelledAt ? (
                  <span className="text-xs no-underline">Annulé : {p.cancelReason}</span>
                ) : (
                  manage && (
                    <>
                      {Number(p.unallocated) > 0 && (
                        <Button variant="ghost" onClick={() => setAllocating(p)}>
                          Affecter
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => reason.ask(`Annuler le paiement ${p.number}`, (r) => cancel.mutate({ id: p.id, r }))}>
                        Annuler
                      </Button>
                    </>
                  )
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Paiement fournisseur" wide>
        {creating && <PaymentForm establishmentId={establishmentId} onDone={() => setCreating(false)} />}
      </Modal>
      <Modal open={!!allocating} onClose={() => setAllocating(null)} title="Affecter une avance">
        {allocating && <AllocateAdvance payment={allocating} onDone={() => setAllocating(null)} />}
      </Modal>
    </Card>
  );
}

function AccountsTab() {
  const [supplierId, setSupplierId] = useState('');
  const { data, isLoading } = useAccount(supplierId);
  return (
    <Card title="Compte fournisseur (tout le groupe)">
      <div className="mb-4 max-w-sm">
        <SupplierPicker value={supplierId} onChange={setSupplierId} />
      </div>
      {supplierId && (isLoading || !data) ? (
        <Spinner />
      ) : data ? (
        <div className="space-y-4">
          <div className="grid gap-2 text-sm sm:grid-cols-4">
            {[
              ['Facturé', data.invoiced],
              ['Payé', data.paid],
              ['Avoirs', data.credited],
              ['Solde dû', data.balance],
            ].map(([label, v]) => (
              <div key={label} className={`rounded-lg p-3 ${label === 'Solde dû' ? 'bg-brand-50' : 'bg-stone-50'}`}>
                <div className="text-stone-500">{label}</div>
                <div className="text-lg font-bold">{formatXOF(v)}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            {Number(data.overdue) > 0 && <Badge tone="red">Échu : {formatXOF(data.overdue)}</Badge>}
            {Number(data.advances) > 0 && <Badge tone="blue">Avances non affectées : {formatXOF(data.advances)}</Badge>}
            {Number(data.unappliedCredits) > 0 && <Badge tone="blue">Avoirs non imputés : {formatXOF(data.unappliedCredits)}</Badge>}
            {Number(data.uninvoicedValue) > 0 && <Badge tone="orange">Réceptions non facturées : {formatXOF(data.uninvoicedValue)}</Badge>}
            {data.supplier.creditLimit && <Badge>Plafond accordé : {formatXOF(data.supplier.creditLimit)}</Badge>}
          </div>
          <Table head={['Facture', 'Réf.', 'Échéance', 'Montant', 'Réglé', 'Reste']} empty={data.openInvoices.length === 0}>
            {data.openInvoices.map((i) => (
              <tr key={i.id}>
                <Td className="font-mono text-xs">{i.number}</Td>
                <Td>{i.supplierRef}</Td>
                <Td>{formatDate(i.dueDate)}</Td>
                <Td>{formatXOF(i.amount)}</Td>
                <Td>{formatXOF(i.paidAmount)}</Td>
                <Td className="font-semibold">{formatXOF(i.remaining)}</Td>
              </tr>
            ))}
          </Table>
          <h3 className="font-semibold">Historique des achats (30 dernières réceptions)</h3>
          <Table head={['Réception', 'Date', 'Commande', 'Lignes', 'Valeur', 'Facture']} empty={data.purchaseHistory.length === 0}>
            {data.purchaseHistory.map((r) => (
              <tr key={r.id}>
                <Td className="font-mono text-xs">{r.number}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(r.receivedAt)}</Td>
                <Td>{r.purchaseOrder?.number ?? <Badge>Directe</Badge>}</Td>
                <Td>{r.lines}</Td>
                <Td className="whitespace-nowrap">{formatXOF(r.totalValue)}</Td>
                <Td>{r.invoice ?? <Badge tone="orange">Non facturée</Badge>}</Td>
              </tr>
            ))}
          </Table>
          {data.returns.length > 0 && (
            <>
              <h3 className="font-semibold">Retours</h3>
              <Table head={['Retour', 'Date', 'Motif', 'Valeur', 'Avoir']}>
                {data.returns.map((r) => (
                  <tr key={r.id}>
                    <Td className="font-mono text-xs">{r.number}</Td>
                    <Td className="whitespace-nowrap">{formatDateTime(r.createdAt)}</Td>
                    <Td>{r.reason}</Td>
                    <Td className="whitespace-nowrap">{formatXOF(r.totalValue)}</Td>
                    <Td className="font-mono text-xs">{r.creditNote?.number}</Td>
                  </tr>
                ))}
              </Table>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

type Tab = 'invoices' | 'payments' | 'accounts';

export function SupplierFinancePage() {
  const { establishment } = useEstablishment();
  const [tab, setTab] = useState<Tab>('invoices');
  return (
    <>
      <PageHeader title="Factures & paiements fournisseurs" subtitle={establishment ? establishment.name : undefined} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'invoices', label: 'Factures' },
          { id: 'payments', label: 'Paiements' },
          { id: 'accounts', label: 'Comptes fournisseurs' },
        ]}
      />
      <RequirePermission permission="purchases.view">
      {tab === 'accounts' ? (
        <AccountsTab />
      ) : (
        <RequireEstablishment>{(establishmentId) => (tab === 'invoices' ? <InvoicesTab establishmentId={establishmentId} /> : <PaymentsTab establishmentId={establishmentId} />)}</RequireEstablishment>
      )}
      </RequirePermission>
    </>
  );
}
