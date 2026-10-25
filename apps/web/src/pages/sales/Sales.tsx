import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { qty } from '../../lib/catalog-types';
import { formatDate, formatDateTime, formatXOF } from '../../lib/format';
import type { TraceUp } from '../../lib/production-types';
import { CashSessionDetail, LotSales, PRINT_STATUS, SALE_STATUS, SaleDetail, SaleRow, TicketText, PrintJob } from '../../lib/sales-types';
import { PAYMENT_METHODS } from '../../lib/stock-types';
import { RequirePermission, StatusBadge, Tabs, useReasonDialog, useRequestId } from '../stock/shared';
import { PrintStatus, printLines, TicketPreview } from './Ticket';

const method = (m: string | null) => (m ? PAYMENT_METHODS[m] ?? m : 'Réparti');
const n = (v: string | number) => Number(v);

export function SalesPage() {
  const [tab, setTab] = useState<'sales' | 'lots'>('sales');
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Ventes" subtitle="Tickets, annulations, remboursements et traçabilité lot ↔ vente" />
      <RequirePermission permission="sales.view">
        <Tabs
          tabs={[
            { id: 'sales', label: 'Tickets' },
            { id: 'lots', label: 'Lot → ventes' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'sales' ? <SalesList onOpen={setOpenId} /> : <LotSalesSearch onOpen={setOpenId} />}
        {openId && <SaleDialog id={openId} onClose={() => setOpenId(null)} />}
      </RequirePermission>
    </>
  );
}

function SalesList({ onOpen }: { onOpen: (id: string) => void }) {
  const { establishmentId } = useAuth();
  const [filters, setFilters] = useState({ from: '', to: '', status: '', number: '' });
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const { data, isLoading, error } = useQuery({ queryKey: ['sales', establishmentId, qs], queryFn: () => api.get<SaleRow[]>(`/sales${qs ? `?${qs}` : ''}`) });
  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });
  return (
    <Card>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input className="w-48" placeholder="N° de ticket" value={filters.number} onChange={set('number')} />
        <Input className="w-40" type="date" aria-label="Du" value={filters.from} onChange={set('from')} />
        <Input className="w-40" type="date" aria-label="Au" value={filters.to} onChange={set('to')} />
        <Select className="w-52" value={filters.status} onChange={set('status')} aria-label="Statut">
          <option value="">Tous les statuts</option>
          {Object.entries(SALE_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>
      {isLoading && <Spinner />}
      {error && <Alert>{(error as ApiError).message}</Alert>}
      {data && (
        <Table head={['Ticket', 'Date', 'Caisse', 'Caissier', 'Paiement', 'Total', 'Statut']} empty={data.length === 0}>
          {data.map((s) => (
            <tr key={s.id} className="cursor-pointer hover:bg-stone-50" onClick={() => onOpen(s.id)}>
              <Td className="font-mono text-xs font-semibold">{s.number}</Td>
              <Td>{formatDateTime(s.createdAt)}</Td>
              <Td>{s.register?.code}</Td>
              <Td>{s.cashier}</Td>
              <Td className="text-xs">
                {n(s.creditAmount) > 0
                  ? // Vente à crédit : montants encaissés par moyen + part à crédit.
                    [...s.payments.map((p) => `${method(p.method)} ${formatXOF(p.amount)}`), `Crédit ${formatXOF(s.creditAmount)}`].join(' + ')
                  : [...new Set(s.payments.map((p) => method(p.method)))].join(', ')}
              </Td>
              <Td className="whitespace-nowrap font-semibold">
                {formatXOF(s.total)}
                {n(s.refundedTotal) > 0 && <div className="text-xs font-normal text-red-700">−{formatXOF(s.refundedTotal)}</div>}
              </Td>
              <Td>
                <StatusBadge map={SALE_STATUS} status={s.status} />
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function SaleDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: s, isLoading, error } = useQuery({ queryKey: ['sales', 'detail', id], queryFn: () => api.get<SaleDetail>(`/sales/${id}`) });
  const [view, setView] = useState<'detail' | 'refund' | 'trace' | 'ticket'>('detail');
  const [printed, setPrinted] = useState<{ print: PrintJob; ticket: TicketText } | null>(null);
  const reason = useReasonDialog();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sales'] });
    qc.invalidateQueries({ queryKey: ['cash-sessions'] });
  };
  const cancel = useMutation({ mutationFn: (r: string) => api.post(`/sales/${id}/cancel`, { reason: r }), onSuccess: refresh });
  const reprint = useMutation({
    mutationFn: () => api.post<{ print: PrintJob; ticket: TicketText }>(`/sales/${id}/reprint`),
    onSuccess: (res) => {
      setPrinted(res);
      if (res.print.status === 'BROWSER') printLines(res.ticket.lines, res.ticket.width, `Duplicata ${s?.number}`);
      refresh();
    },
  });
  const ticket = useQuery({ queryKey: ['sales', 'ticket', id], queryFn: () => api.get<TicketText>(`/sales/${id}/ticket`), enabled: view === 'ticket' });
  return (
    <Modal open wide title={s ? `Ticket ${s.number}` : 'Ticket'} onClose={onClose}>
      {isLoading && <Spinner />}
      {error && <Alert>{(error as ApiError).message}</Alert>}
      {s && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge map={SALE_STATUS} status={s.status} />
            <span>{formatDateTime(s.createdAt)}</span>
            <span>
              {s.establishment?.code} · caisse {s.register?.code} · session {s.session?.number}
            </span>
            <span>Caissier : {s.cashier}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['detail', 'ticket', 'trace'] as const).map((v) => (
              <Button key={v} variant={view === v ? 'secondary' : 'ghost'} onClick={() => setView(v)}>
                {{ detail: 'Détail', ticket: 'Aperçu du ticket', trace: 'Traçabilité' }[v]}
              </Button>
            ))}
            <span className="flex-1" />
            {s.rights.reprint && (
              <Button variant="secondary" loading={reprint.isPending} onClick={() => reprint.mutate()}>
                <Printer className="size-4" /> Réimprimer (duplicata)
              </Button>
            )}
            {s.rights.refund && <Button variant="secondary" onClick={() => setView('refund')}>Rembourser</Button>}
            {s.rights.cancel && (
              <Button variant="danger" loading={cancel.isPending} onClick={() => reason.ask(`Annuler la vente ${s.number}`, (r) => cancel.mutate(r))}>
                Annuler la vente
              </Button>
            )}
          </div>
          {cancel.error && <Alert>{(cancel.error as ApiError).message}</Alert>}
          {reprint.error && <Alert>{(reprint.error as ApiError).message}</Alert>}
          {printed && <PrintStatus job={printed.print} ticket={printed.ticket} onDone={(print) => setPrinted({ ...printed, print })} />}
          {view === 'detail' && <SaleBody sale={s} />}
          {view === 'ticket' && (ticket.data ? <TicketPreview ticket={ticket.data} /> : <Spinner />)}
          {view === 'trace' && <SaleTrace id={id} />}
          {view === 'refund' && <RefundForm sale={s} onDone={() => setView('detail')} />}
          {reason.dialog}
        </div>
      )}
    </Modal>
  );
}

/**
 * Client et facture d'une vente à crédit, lus dans les factures de son établissement
 * (la vente ne les porte pas). Rien n'est affiché sans droit de lecture des factures.
 */
function CreditInvoice({ sale }: { sale: SaleDetail }) {
  const { data } = useQuery({
    queryKey: ['invoices', 'sale', sale.id],
    queryFn: () => api.get<{ id: string; number: string | null; saleId: string | null; customer: { id: string; name: string } | null }[]>(`/invoices?establishmentId=${sale.establishmentId}`),
  });
  const invoice = data?.find((i) => i.saleId === sale.id);
  if (!invoice) return null;
  return (
    <>
      {invoice.customer && <Row label="Client" value={invoice.customer.name} />}
      {invoice.number && <Row label="Facture" value={invoice.number} />}
    </>
  );
}

function SaleBody({ sale: s }: { sale: SaleDetail }) {
  return (
    <>
      <Table head={['Produit', 'Qté', 'Prix TTC', 'Remise', 'Total', 'Lots vendus']}>
        {s.items.map((i) => (
          <tr key={i.id}>
            <Td>
              {i.productName} {i.isMenu && <Badge>Menu</Badge>}
              {n(i.refundedQuantity) > 0 && <div className="text-xs text-red-700">Remboursé : {qty(i.refundedQuantity)}</div>}
            </Td>
            <Td>{qty(i.quantity)}</Td>
            <Td>{formatXOF(i.unitPrice)}</Td>
            <Td className="text-xs">
              {n(i.lineDiscount) + n(i.ticketDiscount) > 0 ? formatXOF(n(i.lineDiscount) + n(i.ticketDiscount)) : ''}
              {i.discountReason && <div className="text-stone-500">{i.discountReason}</div>}
            </Td>
            <Td className="font-semibold">{formatXOF(i.lineTotal)}</Td>
            <Td className="text-xs">
              {i.lots.map((l) => (
                <div key={l.id}>
                  <span className="font-mono">{l.lot?.lotNumber}</span> {i.isMenu && `(${l.product?.name})`} × {qty(l.quantity)}
                  {n(l.returnedQuantity) > 0 && <span className="text-stone-500"> · retour {qty(l.returnedQuantity)}</span>}
                </div>
              ))}
            </Td>
          </tr>
        ))}
      </Table>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1 text-sm">
          <Row label="Sous-total" value={formatXOF(s.grossTotal)} />
          {n(s.lineDiscountTotal) > 0 && <Row label="Remises lignes" value={`−${formatXOF(s.lineDiscountTotal)}`} />}
          {n(s.ticketDiscountAmount) > 0 && <Row label={`Remise ticket (${s.ticketDiscountReason})`} value={`−${formatXOF(s.ticketDiscountAmount)}`} />}
          <Row label="Total TTC" value={formatXOF(s.total)} strong />
          {n(s.taxTotal) > 0 && <Row label="dont TVA" value={formatXOF(s.taxTotal)} />}
          <Row label="Coût des lots vendus" value={formatXOF(Math.round(n(s.costTotal)))} />
        </div>
        <div className="space-y-1 text-sm">
          {s.payments.map((p) => (
            <Row key={p.id} label={`${method(p.method)}${p.reference ? ` — réf. ${p.reference}` : ''}`} value={formatXOF(p.amount)} />
          ))}
          {n(s.creditAmount) > 0 && <Row label="À crédit" value={formatXOF(s.creditAmount)} strong />}
          {n(s.changeGiven) > 0 && <Row label="Monnaie rendue" value={formatXOF(s.changeGiven)} />}
          {n(s.refundedTotal) > 0 && <Row label="Remboursé" value={`−${formatXOF(s.refundedTotal)}`} />}
          {n(s.creditAmount) > 0 && <CreditInvoice sale={s} />}
        </div>
      </div>
      {s.cancelledAt && (
        <Alert>
          Annulée le {formatDateTime(s.cancelledAt)} par {s.cancelledBy} : {s.cancelReason}
        </Alert>
      )}
      {s.returns.length > 0 && (
        <Table head={['Retour', 'Type', 'Moyen', 'Montant', 'Motif', 'Par']}>
          {s.returns.map((r) => (
            <tr key={r.id}>
              <Td className="font-mono text-xs">{r.number}</Td>
              <Td>{r.kind === 'CANCEL' ? 'Annulation' : 'Remboursement'}</Td>
              <Td>{r.kind === 'CANCEL' ? '—' : method(r.method)}</Td>
              <Td>{formatXOF(r.total)}</Td>
              <Td className="text-xs">{r.reason}</Td>
              <Td className="text-xs">
                {r.createdBy} · {formatDateTime(r.createdAt)}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {s.printJobs.length > 0 && (
        <p className="text-xs text-stone-500">
          Impressions :{' '}
          {s.printJobs.map((j) => `${j.kind === 'DUPLICATE' ? 'duplicata' : 'ticket'} ${PRINT_STATUS[j.status].label.toLowerCase()} (${formatDateTime(j.createdAt)}${j.requestedBy ? `, ${j.requestedBy}` : ''})`).join(' · ')}
        </p>
      )}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${strong ? 'text-base font-bold' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** Remboursement partiel ou total, depuis sa propre session ouverte (décision 7). */
function RefundForm({ sale, onDone }: { sale: SaleDetail; onDone: () => void }) {
  const qc = useQueryClient();
  const requestId = useRequestId();
  const current = useQuery({ queryKey: ['cash-sessions', 'current'], queryFn: () => api.get<{ session: CashSessionDetail | null }>('/cash-sessions/current', { noEstablishment: true }) });
  const [lines, setLines] = useState<Record<string, { quantity: string; disposition: 'RESTOCK' | 'LOSS' }>>({});
  const methods = [...new Set(sale.payments.map((p) => p.method))];
  const [split, setSplit] = useState<Record<string, string>>({ [methods.includes('CASH') ? 'CASH' : methods[0]]: '' });
  const [reason, setReason] = useState('');
  const chosen = Object.entries(lines).filter(([, l]) => n(l.quantity) > 0);
  // Estimation (le serveur calcule le montant exact au prorata).
  const estimate = chosen.reduce((s, [itemId, l]) => {
    const item = sale.items.find((i) => i.id === itemId)!;
    return s + Math.round((n(item.lineTotal) * n(l.quantity)) / n(item.quantity));
  }, 0);
  const refund = useMutation({
    mutationFn: () => {
      const parts = Object.entries(split).filter(([, a]) => a !== '');
      return api.post(`/sales/${sale.id}/refund`, {
        clientRequestId: requestId,
        sessionId: current.data?.session?.id,
        reason,
        lines: chosen.map(([saleItemId, l]) => ({ saleItemId, quantity: n(l.quantity), disposition: l.disposition })),
        ...(parts.length > 1 ? { refunds: parts.map(([m, a]) => ({ method: m, amount: n(a) })) } : { method: Object.keys(split)[0] }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales'] });
      qc.invalidateQueries({ queryKey: ['cash-sessions'] });
      onDone();
    },
  });
  if (current.isLoading) return <Spinner />;
  const session = current.data?.session;
  if (!session || session.establishmentId !== sale.establishmentId) {
    return <Alert tone="info">Pour rembourser, ouvrez votre propre session de caisse dans cet établissement (écran « Caisse ») : l’argent rendu sort de votre caisse.</Alert>;
  }
  return (
    <Card title={`Remboursement depuis la session ${session.number}`}>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          refund.mutate();
        }}
      >
        <Table head={['Produit', 'Vendu', 'Déjà remboursé', 'À rembourser', 'Produit rendu']}>
          {sale.items.map((i) => {
            const left = n(i.quantity) - n(i.refundedQuantity);
            const l = lines[i.id] ?? { quantity: '', disposition: 'RESTOCK' as const };
            const set = (patch: Partial<typeof l>) => setLines({ ...lines, [i.id]: { ...l, ...patch } });
            return (
              <tr key={i.id}>
                <Td>{i.productName}</Td>
                <Td>{qty(i.quantity)}</Td>
                <Td>{qty(i.refundedQuantity)}</Td>
                <Td>
                  <Input className="w-24" type="number" min={0} max={left} step="any" disabled={left <= 0} value={l.quantity} onChange={(e) => set({ quantity: e.target.value })} />
                </Td>
                <Td>
                  <Select value={l.disposition} onChange={(e) => set({ disposition: e.target.value as 'RESTOCK' | 'LOSS' })} disabled={left <= 0}>
                    <option value="RESTOCK">Remis en stock</option>
                    <option value="LOSS">Perte (retour client)</option>
                  </Select>
                </Td>
              </tr>
            );
          })}
        </Table>
        <p className="text-sm">
          Montant estimé : <strong>{formatXOF(estimate)}</strong> (calcul exact au prorata par le serveur)
        </p>
        <div className="flex flex-wrap items-end gap-2">
          {methods.map((m) => (
            <Field key={m} label={`${method(m)}${Object.keys(split).length > 1 ? ' (montant)' : ''}`}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={m in split} onChange={(e) => setSplit(e.target.checked ? { ...split, [m]: '' } : Object.fromEntries(Object.entries(split).filter(([k]) => k !== m)))} />
                {Object.keys(split).length > 1 && m in split && <Input className="w-32" type="number" min={1} step={1} required value={split[m]} onChange={(e) => setSplit({ ...split, [m]: e.target.value })} />}
              </div>
            </Field>
          ))}
        </div>
        <Field label="Motif">
          <Input required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {refund.error && <Alert>{(refund.error as ApiError).message}</Alert>}
        <Button type="submit" loading={refund.isPending} disabled={!chosen.length || !Object.keys(split).length}>
          Rembourser
        </Button>
      </form>
    </Card>
  );
}

function UpstreamTree({ node }: { node: TraceUp }) {
  return (
    <ul className="space-y-1 border-l-2 border-brand-200 pl-3 text-xs">
      {node.production && <li className="text-stone-500">Fabriqué par l’ordre {node.production.number}</li>}
      {!node.production && (node.supplier || node.receipt) && (
        <li className="text-stone-500">
          {node.supplier && `Fournisseur ${node.supplier.name}`}
          {node.supplierLotRef && ` · lot fournisseur ${node.supplierLotRef}`}
          {node.receipt && ` · réception ${node.receipt.number} du ${formatDate(node.receipt.receivedAt)}`}
        </li>
      )}
      {node.inputs.map((i) => (
        <li key={i.lot.lotId}>
          <span className="font-mono font-semibold">{i.lot.lotNumber}</span> · {i.lot.item?.name} × {qty(i.quantity)}
          <UpstreamTree node={i.lot} />
        </li>
      ))}
    </ul>
  );
}

/** Vente → lots vendus → production éventuelle → matières et fournisseurs. */
function SaleTrace({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['sales', 'trace', id],
    queryFn: () =>
      api.get<{ canTrace: boolean; items: { id: string; productName: string; quantity: string; lots: { id: string; quantity: string; lot: { lotNumber: string } | null; product: { name: string } | null; upstream: TraceUp | null }[] }[] }>(
        `/sales/${id}/trace`,
      ),
  });
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="space-y-3">
      {!data.canTrace && <Alert tone="info">Le détail amont (production, matières, fournisseurs) est réservé aux utilisateurs qui voient les stocks.</Alert>}
      {data.items.map((i) => (
        <div key={i.id}>
          <div className="font-semibold">
            {i.productName} × {qty(i.quantity)}
          </div>
          <ul className="ml-2 space-y-2">
            {i.lots.map((l) => (
              <li key={l.id} className="text-sm">
                <span className="font-mono font-semibold">{l.lot?.lotNumber}</span> · {l.product?.name} × {qty(l.quantity)}
                {data.canTrace && l.lot && (
                  <Link className="ml-2 text-xs text-brand-700 underline" to={`/tracabilite?lot=${l.lot.lotNumber}`}>
                    Traçabilité complète
                  </Link>
                )}
                {l.upstream && <UpstreamTree node={l.upstream} />}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Lot → produits finis fabriqués avec lui → tickets de vente. */
function LotSalesSearch({ onOpen }: { onOpen: (id: string) => void }) {
  const [input, setInput] = useState('');
  const [lot, setLot] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['sales', 'lot', lot],
    queryFn: () => api.get<LotSales>(`/traceability/sales?lotNumber=${encodeURIComponent(lot)}`),
    enabled: lot.length >= 3,
    retry: false,
  });
  return (
    <Card>
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setLot(input.trim().toUpperCase());
        }}
      >
        <Input className="max-w-xs" placeholder="N° de lot, ex. LOT-2026-000012" value={input} onChange={(e) => setInput(e.target.value)} />
        <Button type="submit">Rechercher les ventes</Button>
      </form>
      {isLoading && <Spinner />}
      {error && <Alert>{(error as ApiError).message}</Alert>}
      {data && (
        <div className="space-y-4">
          <div className="text-sm">
            {data.lots.map((l) => (
              <div key={l.id} style={{ marginLeft: l.depth * 16 }}>
                <span className="font-mono font-semibold">{l.lotNumber}</span> {l.product && `· ${l.product}`} {l.via && <span className="text-stone-500">(fabriqué par {l.via})</span>}
              </div>
            ))}
          </div>
          <Table head={['Ticket', 'Date', 'Site', 'Vendu comme', 'Article', 'Lot', 'Quantité', 'Statut']} empty={data.sales.length === 0}>
            {data.sales.map((s, i) => (
              <tr key={i} className="cursor-pointer hover:bg-stone-50" onClick={() => onOpen(s.saleId)}>
                <Td className="font-mono text-xs font-semibold">{s.number}</Td>
                <Td>{formatDateTime(s.createdAt)}</Td>
                <Td>{s.establishment?.code}</Td>
                <Td>{s.soldAs}</Td>
                <Td>{s.product}</Td>
                <Td className="font-mono text-xs">{s.lotNumber}</Td>
                <Td>
                  {qty(s.quantity)}
                  {n(s.returnedQuantity) > 0 && <div className="text-xs text-stone-500">retour {qty(s.returnedQuantity)}</div>}
                </Td>
                <Td>
                  <StatusBadge map={SALE_STATUS} status={s.status} />
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}
