import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChefHat, GitBranch, Plus, Printer, Send, SlidersHorizontal, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { qty } from '../../lib/catalog-types';
import { formatDateTime, formatXOF } from '../../lib/format';
import { Area, BILL_STATUS, ITEM_STATUS, LOSS_CAUSES_RESTAURANT, MenuEntry, newRequestId, ORDER_MODES, ORDER_STATUS, OrderDetail, OrderItem, OrderRow } from '../../lib/restaurant-types';
import { CashSessionDetail, PrintJob, REFERENCE_REQUIRED, SaleResult, TicketText } from '../../lib/sales-types';
import { PAYMENT_METHODS } from '../../lib/stock-types';
import { RequirePermission, StatusBadge, useRequestId } from '../stock/shared';
import { PrintStatus, printLines, TicketPreview } from '../sales/Ticket';

const n = (v: string | number) => Number(v);

export function OrderPage() {
  const { id } = useParams();
  return (
    <RequirePermission permission={['restaurant.orders', 'restaurant.kitchen']}>
      <OrderView id={id!} />
    </RequirePermission>
  );
}

function OrderView({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: o, isLoading, error } = useQuery({ queryKey: ['restaurant', 'order', id], queryFn: () => api.get<OrderDetail>(`/restaurant/orders/${id}`), refetchInterval: 10_000 });
  const [dialog, setDialog] = useState<null | 'transfer' | 'merge' | 'cancel' | 'trace'>(null);
  const [cancelling, setCancelling] = useState<OrderItem | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  // Même identifiant tant que l'envoi n'a pas réussi : un double clic ou un renvoi après coupure n'envoie qu'une fois.
  const [sendKey, setSendKey] = useState(newRequestId);
  const refresh = (data?: OrderDetail) => {
    if (data) qc.setQueryData(['restaurant', 'order', id], data);
    qc.invalidateQueries({ queryKey: ['restaurant'] });
  };
  const send = useMutation({
    mutationFn: () => api.post<OrderDetail>(`/restaurant/orders/${id}/send`, { clientRequestId: sendKey }),
    onSuccess: (d) => {
      refresh(d);
      setSendKey(newRequestId());
    },
  });
  const remove = useMutation({ mutationFn: (itemId: string) => api.post<OrderDetail>(`/restaurant/orders/${id}/items/${itemId}/remove`), onSuccess: refresh });
  const bill = useMutation({ mutationFn: (itemIds?: string[]) => api.post<OrderDetail>(`/restaurant/orders/${id}/bills`, itemIds ? { itemIds } : {}), onSuccess: refresh });
  const [selecting, setSelecting] = useState<Set<string> | null>(null);

  if (isLoading) return <Spinner />;
  if (error || !o) return <Alert>{(error as ApiError)?.message ?? 'Commande introuvable'}</Alert>;
  const open = o.status === 'OPEN';
  const drafts = o.items.filter((i) => i.status === 'DRAFT');
  const sent = o.items.filter((i) => !['DRAFT', 'REMOVED'].includes(i.status));
  const billable = sent.filter((i) => i.status !== 'CANCELLED' && !i.billId);
  const label = o.table ? `Table ${o.table.code}` : ORDER_MODES[o.mode];
  const mutationError = [send, remove, bill].find((m) => m.error)?.error as ApiError | undefined;

  return (
    <>
      <PageHeader
        title={`${label} — ${o.number}`}
        subtitle={`${o.covers ? `${o.covers} couvert(s) · ` : ''}${o.customerName ? `${o.customerName} · ` : ''}Serveur : ${o.waiter ?? '—'} · ouverte le ${formatDateTime(o.createdAt)}`}
        actions={
          <>
            <StatusBadge map={ORDER_STATUS} status={o.status} />
            {open && o.mode === 'TABLE' && o.rights.order && (
              <Button variant="secondary" onClick={() => setDialog('transfer')}>
                Changer de table
              </Button>
            )}
            {open && o.rights.order && (
              <Button variant="secondary" onClick={() => setDialog('merge')}>
                Regrouper
              </Button>
            )}
            <Button variant="secondary" onClick={() => setDialog('trace')}>
              <GitBranch className="size-4" /> Traçabilité
            </Button>
            {open && o.rights.order && (
              <Button variant="ghost" onClick={() => setDialog('cancel')}>
                Annuler la commande
              </Button>
            )}
            <Button variant="ghost" onClick={() => navigate(o.mode === 'TABLE' ? '/salle' : '/commandes')}>
              Retour
            </Button>
          </>
        }
      />
      {mutationError && <div className="mb-3"><Alert>{mutationError.message}</Alert></div>}
      <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
        {open && o.rights.order ? <MenuPicker order={o} onChange={refresh} /> : <Card><Alert tone="info">Commande {ORDER_STATUS[o.status]?.label.toLowerCase()}{o.cancelReason ? ` : ${o.cancelReason}` : ''}.</Alert></Card>}

        <div className="space-y-4">
          <Card
            title={`À envoyer (${drafts.length})`}
            actions={
              open &&
              drafts.length > 0 && (
                <Button loading={send.isPending} onClick={() => send.mutate()}>
                  <Send className="size-4" /> Envoyer
                </Button>
              )
            }
          >
            {drafts.length === 0 ? (
              <p className="text-sm text-stone-500">Aucun article en attente d’envoi.</p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {drafts.map((i) => (
                  <ItemLine key={i.id} item={i} child={!!i.parentItemId}>
                    <Button variant="ghost" className="px-2 py-1" aria-label="Retirer" onClick={() => remove.mutate(i.id)}>
                      <X className="size-4" />
                    </Button>
                  </ItemLine>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Envoyé"
            actions={
              open &&
              billable.length > 0 &&
              (selecting ? (
                <>
                  <Button variant="ghost" onClick={() => setSelecting(null)}>
                    Annuler
                  </Button>
                  <Button disabled={!selecting.size} loading={bill.isPending} onClick={() => bill.mutate([...selecting], { onSuccess: () => setSelecting(null) })}>
                    Addition de la sélection
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="secondary" onClick={() => setSelecting(new Set())}>
                    Séparer
                  </Button>
                  <Button loading={bill.isPending} onClick={() => bill.mutate(undefined)}>
                    Addition
                  </Button>
                </>
              ))
            }
          >
            {sent.length === 0 ? (
              <p className="text-sm text-stone-500">Rien n’a encore été envoyé.</p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {sent.map((i) => (
                  <ItemLine key={i.id} item={i} child={!!i.parentItemId}>
                    {selecting && billable.some((b) => b.id === i.id) && !i.parentItemId && (
                      <input
                        type="checkbox"
                        aria-label="Sélectionner"
                        checked={selecting.has(i.id)}
                        onChange={(e) => {
                          const s = new Set(selecting);
                          if (e.target.checked) s.add(i.id);
                          else s.delete(i.id);
                          setSelecting(s);
                        }}
                      />
                    )}
                    {i.paid && <Badge tone="green">Payé</Badge>}
                    {open && o.rights.edit && i.status !== 'CANCELLED' && !i.billId && (
                      <Button variant="ghost" className="px-2 py-1 text-red-700" onClick={() => setCancelling(i)}>
                        Annuler
                      </Button>
                    )}
                  </ItemLine>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Additions">
            <div className="mb-2 grid grid-cols-3 gap-2 text-center text-sm">
              <div className="rounded-lg bg-stone-50 p-2">
                Commandé<div className="font-bold">{formatXOF(o.totals.ordered)}</div>
              </div>
              <div className="rounded-lg bg-green-50 p-2">
                Payé<div className="font-bold">{formatXOF(o.totals.paid)}</div>
              </div>
              <div className="rounded-lg bg-amber-50 p-2">
                À facturer<div className="font-bold">{formatXOF(o.totals.toBill)}</div>
              </div>
            </div>
            {o.bills.length === 0 && <p className="text-sm text-stone-500">Aucune addition.</p>}
            <ul className="space-y-2">
              {o.bills.map((b) => (
                <li key={b.id} className="rounded-lg border border-stone-200 p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold">{b.number}</span>
                    <StatusBadge map={BILL_STATUS} status={b.status} />
                    <span className="font-semibold">{formatXOF(b.total)}</span>
                    {b.sale && <span className="text-xs text-stone-500">ticket {b.sale.number}</span>}
                  </div>
                  {b.status === 'OPEN' && <BillActions billId={b.id} canPay={o.rights.pay} onPay={() => setPaying(b.id)} onChange={refresh} />}
                  {b.cancelReason && <div className="text-xs text-stone-500">{b.cancelReason}</div>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
      {cancelling && <CancelItem order={o} item={cancelling} onClose={() => setCancelling(null)} onDone={refresh} />}
      {paying && <PayBill order={o} billId={paying} onClose={() => setPaying(null)} onDone={refresh} />}
      {dialog === 'transfer' && <Transfer order={o} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'merge' && <Merge order={o} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'cancel' && <CancelOrder order={o} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'trace' && <OrderTrace id={o.id} onClose={() => setDialog(null)} />}
    </>
  );
}

function ItemLine({ item: i, child, children }: { item: OrderItem; child: boolean; children?: React.ReactNode }) {
  return (
    <li className={`flex items-start gap-2 py-2 ${child ? 'pl-6' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          {child && '+ '}
          <strong>{qty(n(i.quantity) - n(i.cancelledQuantity))}</strong> × {i.productName} {i.isMenu && <Badge>Formule</Badge>}
          {n(i.cancelledQuantity) > 0 && i.status !== 'CANCELLED' && <span className="text-xs text-red-700"> ({qty(i.cancelledQuantity)} annulé)</span>}
        </div>
        {(i.options.length > 0 || i.note) && <div className="text-xs text-stone-600">{[...i.options, i.note].filter(Boolean).join(' · ')}</div>}
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-stone-500">
          <StatusBadge map={ITEM_STATUS} status={i.status} />
          {i.station && <span>{i.station.name}</span>}
          <span>{formatXOF(i.amount)}</span>
        </div>
      </div>
      <div className="flex items-center gap-1">{children}</div>
    </li>
  );
}

/** Carte : un appui ajoute 1 ; le bouton réglages ouvre options, note, suppléments et quantité. */
function MenuPicker({ order, onChange }: { order: OrderDetail; onChange: (d: OrderDetail) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['restaurant', 'menu', order.establishmentId], queryFn: () => api.get<MenuEntry[]>('/restaurant/menu') });
  const [category, setCategory] = useState('');
  const [custom, setCustom] = useState<MenuEntry | null>(null);
  const add = useMutation({
    mutationFn: (items: object[]) => api.post<OrderDetail>(`/restaurant/orders/${order.id}/items`, { clientRequestId: newRequestId(), items }),
    onSuccess: onChange,
  });
  const dishes = useMemo(() => (data ?? []).filter((m) => m.isAvailable && !m.isSupplement), [data]);
  const supplements = (data ?? []).filter((m) => m.isAvailable && m.isSupplement);
  const categories = [...new Map(dishes.filter((d) => d.product.category).map((d) => [d.product.category!.id, d.product.category!])).values()];
  if (isLoading) return <Spinner />;
  return (
    <Card title="Carte">
      <div className="mb-3 flex flex-wrap gap-1">
        <Button variant={category ? 'ghost' : 'secondary'} className="px-3 py-1" onClick={() => setCategory('')}>
          Tout
        </Button>
        {categories.map((c) => (
          <Button key={c.id} variant={category === c.id ? 'secondary' : 'ghost'} className="px-3 py-1" onClick={() => setCategory(c.id)}>
            {c.name}
          </Button>
        ))}
      </div>
      {add.error && <div className="mb-2"><Alert>{(add.error as ApiError).message}</Alert></div>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
        {dishes
          .filter((d) => !category || d.product.category?.id === category)
          .map((d) => (
            <div key={d.id} className="flex min-h-20 overflow-hidden rounded-lg border border-stone-200 bg-stone-50" style={d.product.category?.color ? { borderLeft: `4px solid ${d.product.category.color}` } : undefined}>
              <button className="flex flex-1 flex-col justify-between p-2 text-left hover:bg-brand-50" onClick={() => add.mutate([{ productId: d.productId, quantity: 1 }])}>
                <span className="text-sm font-medium leading-tight">{d.product.name}</span>
                <span className="text-sm font-semibold text-brand-700">{formatXOF(d.price)}</span>
              </button>
              <button className="border-l border-stone-200 px-2 text-stone-500 hover:bg-stone-100" aria-label="Personnaliser" onClick={() => setCustom(d)}>
                <SlidersHorizontal className="size-4" />
              </button>
            </div>
          ))}
        {dishes.length === 0 && <p className="col-span-full text-sm text-stone-500">La carte est vide : un responsable doit la configurer.</p>}
      </div>
      {custom && (
        <CustomItem
          entry={custom}
          supplements={supplements}
          loading={add.isPending}
          onClose={() => setCustom(null)}
          onAdd={(item) => add.mutate([item], { onSuccess: () => setCustom(null) })}
        />
      )}
    </Card>
  );
}

function CustomItem({ entry, supplements, loading, onClose, onAdd }: { entry: MenuEntry; supplements: MenuEntry[]; loading: boolean; onClose: () => void; onAdd: (item: object) => void }) {
  const [quantity, setQuantity] = useState('1');
  const [options, setOptions] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [sup, setSup] = useState<Record<string, number>>({});
  return (
    <Modal open title={entry.product.name} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd({
            productId: entry.productId,
            quantity: Number(quantity),
            options,
            note: note.trim() || null,
            supplements: Object.entries(sup)
              .filter(([, q]) => q > 0)
              .map(([productId, q]) => ({ productId, quantity: q })),
          });
        }}
      >
        <Field label="Quantité">
          <Input type="number" min={1} step={1} required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        {entry.options.filter((o) => o.isActive).length > 0 && (
          <div className="flex flex-wrap gap-3 text-sm">
            {entry.options
              .filter((o) => o.isActive)
              .map((o) => (
                <label key={o.id} className="flex items-center gap-1">
                  <input type="checkbox" checked={options.includes(o.label)} onChange={(e) => setOptions(e.target.checked ? [...options, o.label] : options.filter((x) => x !== o.label))} />
                  {o.label}
                </label>
              ))}
          </div>
        )}
        {supplements.length > 0 && (
          <div className="space-y-1">
            <div className="text-sm font-medium">Suppléments</div>
            {supplements.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {s.product.name} <span className="text-stone-500">{formatXOF(s.price)}</span>
                </span>
                <Input className="w-20 py-1" type="number" min={0} step={1} value={sup[s.productId] ?? 0} onChange={(e) => setSup({ ...sup, [s.productId]: Number(e.target.value) })} />
              </div>
            ))}
          </div>
        )}
        <Field label="Note pour la cuisine">
          <Input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="ex. peu de sel" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" loading={loading}>
            <Plus className="size-4" /> Ajouter
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Annulation d'un article envoyé : motif obligatoire ; cause de perte s'il est déjà en préparation (décision R14). */
function CancelItem({ order, item, onClose, onDone }: { order: OrderDetail; item: OrderItem; onClose: () => void; onDone: (d: OrderDetail) => void }) {
  const requestId = useRequestId();
  const open = n(item.quantity) - n(item.cancelledQuantity);
  const [quantity, setQuantity] = useState(String(open));
  const [reason, setReason] = useState('');
  const [cause, setCause] = useState('QUALITY');
  const loss = item.status !== 'NEW';
  const cancel = useMutation({
    mutationFn: () =>
      api.post<OrderDetail>(`/restaurant/orders/${order.id}/items/${item.id}/cancel`, { clientRequestId: requestId, quantity: Number(quantity), reason, ...(loss ? { lossCause: cause } : {}) }),
    onSuccess: (d) => {
      onDone(d);
      onClose();
    },
  });
  return (
    <Modal open title={`Annuler — ${item.productName}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          cancel.mutate();
        }}
      >
        <Alert tone="info">{loss ? 'Déjà en préparation : les ingrédients seront déclarés en perte.' : 'Pas encore préparé : les ingrédients reviennent en stock.'}</Alert>
        <Field label={`Quantité (au plus ${qty(open)})`}>
          <Input type="number" min={0.0001} max={open} step="any" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        {loss && (
          <Field label="Cause de la perte">
            <Select value={cause} onChange={(e) => setCause(e.target.value)}>
              {Object.entries(LOSS_CAUSES_RESTAURANT).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Motif">
          <Input required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {cancel.error && <Alert>{(cancel.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" variant="danger" loading={cancel.isPending}>
            Annuler l’article
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function BillActions({ billId, canPay, onPay, onChange }: { billId: string; canPay: boolean; onPay: () => void; onChange: (d: OrderDetail) => void }) {
  const qc = useQueryClient();
  const print = useMutation({
    mutationFn: () => api.post<{ print: PrintJob; lines: string[]; width: number }>(`/restaurant/bills/${billId}/print`, {}),
    onSuccess: (r) => {
      if (r.print.status === 'BROWSER') printLines(r.lines, r.width, 'Addition');
      qc.invalidateQueries({ queryKey: ['restaurant'] });
    },
  });
  const cancel = useMutation({ mutationFn: () => api.post<OrderDetail>(`/restaurant/bills/${billId}/cancel`, { reason: 'Addition modifiée' }), onSuccess: onChange });
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <Button variant="secondary" className="px-3 py-1" loading={print.isPending} onClick={() => print.mutate()}>
        <Printer className="size-4" /> Note
      </Button>
      {canPay && (
        <Button className="px-3 py-1" onClick={onPay}>
          Encaisser
        </Button>
      )}
      <Button variant="ghost" className="px-3 py-1" loading={cancel.isPending} onClick={() => cancel.mutate()}>
        Annuler l’addition
      </Button>
      {(print.error || cancel.error) && <Alert>{((print.error || cancel.error) as ApiError).message}</Alert>}
    </div>
  );
}

interface PayLine {
  method: string;
  amount: string;
  reference: string;
}

/**
 * Encaissement d'une addition par la caisse (module 5) : plusieurs paiements
 * sur le même ticket, partage en parts égales, monnaie sur les espèces.
 */
function PayBill({ order, billId, onClose, onDone }: { order: OrderDetail; billId: string; onClose: () => void; onDone: (d: OrderDetail) => void }) {
  const bill = order.bills.find((b) => b.id === billId)!;
  const requestId = useRequestId();
  const session = useQuery({ queryKey: ['cash-sessions', 'current'], queryFn: () => api.get<{ session: CashSessionDetail | null }>('/cash-sessions/current', { noEstablishment: true }) });
  const [discount, setDiscount] = useState({ amount: '', reason: '' });
  const total = n(bill.total) - (Number(discount.amount) || 0);
  const [lines, setLines] = useState<PayLine[]>([{ method: 'CASH', amount: String(bill.total), reference: '' }]);
  const [result, setResult] = useState<(SaleResult & { order: OrderDetail }) | null>(null);
  const [job, setJob] = useState<PrintJob | null>(null);
  const paid = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const cash = lines.filter((l) => l.method === 'CASH').reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const change = Math.max(0, paid - total);
  const split = (parts: number) => {
    const share = Math.floor(total / parts);
    setLines(Array.from({ length: parts }, (_, i) => ({ method: 'CASH', amount: String(i === parts - 1 ? total - share * (parts - 1) : share), reference: '' })));
  };
  const pay = useMutation({
    mutationFn: () =>
      api.post<SaleResult & { order: OrderDetail }>(`/restaurant/bills/${billId}/pay`, {
        clientRequestId: requestId,
        sessionId: session.data?.session?.id,
        payments: lines.filter((l) => Number(l.amount) > 0).map((l) => ({ method: l.method, amount: Math.round(Number(l.amount)), ...(l.reference.trim() ? { reference: l.reference.trim() } : {}) })),
        ...(Number(discount.amount) > 0 ? { ticketDiscountAmount: Math.round(Number(discount.amount)), ticketDiscountReason: discount.reason } : {}),
      }),
    onSuccess: (r) => {
      setResult(r);
      setJob(r.print);
      onDone(r.order);
      if (r.print?.status === 'BROWSER') printLines(r.ticket.lines, r.ticket.width, r.sale.number);
    },
  });
  if (session.isLoading) return null;
  const s = session.data?.session;
  return (
    <Modal open wide title={result ? `Ticket ${result.sale.number}` : `Encaisser l’addition ${bill.number}`} onClose={onClose}>
      {result ? (
        <div className="space-y-3">
          <div className="rounded-lg bg-green-50 p-3 text-center">
            Monnaie à rendre<div className="text-xl font-bold text-green-700">{formatXOF(result.sale.changeGiven)}</div>
          </div>
          <PrintStatus job={job} ticket={result.ticket as TicketText} onDone={setJob} />
          <TicketPreview ticket={result.ticket} />
          <div className="flex justify-end">
            <Button onClick={onClose}>Terminé</Button>
          </div>
        </div>
      ) : !s || s.establishmentId !== order.establishmentId ? (
        <Alert tone="info">
          Ouvrez votre session de caisse dans cet établissement pour encaisser (écran <Link className="underline" to="/caisse">Caisse</Link>).
        </Alert>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            pay.mutate();
          }}
        >
          <div className="text-sm">
            Session {s.number} — {s.register.code} · Total <strong>{formatXOF(total)}</strong>
          </div>
          {lines.map((l, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <Field label={`Paiement ${i + 1}`}>
                <Select value={l.method} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))} className="w-44">
                  {Object.entries(PAYMENT_METHODS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Montant">
                <Input className="w-32" type="number" min={0} step={1} value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              </Field>
              {l.method !== 'CASH' && (
                <Field label="Référence">
                  <Input className="w-40" required={REFERENCE_REQUIRED.has(l.method)} value={l.reference} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} />
                </Field>
              )}
              {lines.length > 1 && (
                <Button type="button" variant="ghost" aria-label="Retirer" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </Button>
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" onClick={() => setLines([...lines, { method: 'WAVE', amount: String(Math.max(0, total - paid)), reference: '' }])}>
              <Plus className="size-4" /> Autre paiement
            </Button>
            {[2, 3, 4].map((p) => (
              <Button key={p} type="button" variant="secondary" onClick={() => split(p)}>
                Partager en {p}
              </Button>
            ))}
          </div>
          {order.rights.discount && (
            <div className="flex flex-wrap gap-2">
              <Field label="Remise (FCFA)">
                <Input className="w-32" type="number" min={0} step={1} value={discount.amount} onChange={(e) => setDiscount({ ...discount, amount: e.target.value })} />
              </Field>
              <Field label="Motif de la remise">
                <Input className="w-64" required={Number(discount.amount) > 0} minLength={3} value={discount.reason} onChange={(e) => setDiscount({ ...discount, reason: e.target.value })} />
              </Field>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-stone-50 p-3 text-center text-sm">
            <div>
              Reçu<div className="font-bold">{formatXOF(paid)}</div>
            </div>
            <div>
              Reste<div className={`font-bold ${paid < total ? 'text-red-700' : ''}`}>{formatXOF(Math.max(0, total - paid))}</div>
            </div>
            <div>
              Monnaie<div className="font-bold text-green-700">{formatXOF(change)}</div>
            </div>
          </div>
          {change > cash && <Alert>La monnaie ne se rend qu’en espèces.</Alert>}
          {pay.error && <Alert>{(pay.error as ApiError).message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Retour
            </Button>
            <Button type="submit" loading={pay.isPending} disabled={paid < total || change > cash}>
              Valider l’encaissement
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Transfer({ order, onClose, onDone }: { order: OrderDetail; onClose: () => void; onDone: (d: OrderDetail) => void }) {
  const floor = useQuery({ queryKey: ['restaurant', 'floor', order.establishmentId], queryFn: () => api.get<Area[]>('/restaurant/floor') });
  const [tableId, setTableId] = useState('');
  const move = useMutation({
    mutationFn: () => api.post<OrderDetail>(`/restaurant/orders/${order.id}/transfer`, { tableId }),
    onSuccess: (d) => {
      onDone(d);
      onClose();
    },
  });
  const free = (floor.data ?? []).flatMap((a) => a.tables.filter((t) => t.isActive && (t.status === 'FREE' || t.status === 'RESERVED')).map((t) => ({ ...t, area: a.name })));
  return (
    <Modal open title="Changer de table" onClose={onClose}>
      <div className="space-y-3">
        <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
          <option value="">— Table libre —</option>
          {free.map((t) => (
            <option key={t.id} value={t.id}>
              {t.area} · {t.code} ({t.capacity} pl.){t.status === 'RESERVED' ? ' — réservée' : ''}
            </option>
          ))}
        </Select>
        {move.error && <Alert>{(move.error as ApiError).message}</Alert>}
        <div className="flex justify-end">
          <Button disabled={!tableId} loading={move.isPending} onClick={() => move.mutate()}>
            Transférer
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Merge({ order, onClose, onDone }: { order: OrderDetail; onClose: () => void; onDone: (d: OrderDetail) => void }) {
  const list = useQuery({ queryKey: ['restaurant', 'orders', 'OPEN'], queryFn: () => api.get<OrderRow[]>('/restaurant/orders?status=OPEN') });
  const [source, setSource] = useState('');
  const merge = useMutation({
    mutationFn: () => api.post<OrderDetail>(`/restaurant/orders/${order.id}/merge`, { sourceOrderId: source }),
    onSuccess: (d) => {
      onDone(d);
      onClose();
    },
  });
  return (
    <Modal open title="Regrouper une autre commande dans celle-ci" onClose={onClose}>
      <div className="space-y-3">
        <Select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">— Commande à regrouper —</option>
          {(list.data ?? [])
            .filter((x) => x.id !== order.id)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.table ? `Table ${x.table.code}` : ORDER_MODES[x.mode]} · {x.number} · {formatXOF(x.total)}
              </option>
            ))}
        </Select>
        {merge.error && <Alert>{(merge.error as ApiError).message}</Alert>}
        <div className="flex justify-end">
          <Button disabled={!source} loading={merge.isPending} onClick={() => merge.mutate()}>
            Regrouper
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CancelOrder({ order, onClose, onDone }: { order: OrderDetail; onClose: () => void; onDone: (d: OrderDetail) => void }) {
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api.post<OrderDetail>(`/restaurant/orders/${order.id}/cancel`, { reason }),
    onSuccess: (d) => {
      onDone(d);
      onClose();
    },
  });
  return (
    <Modal open title={`Annuler la commande ${order.number}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          cancel.mutate();
        }}
      >
        <Textarea required minLength={3} maxLength={500} rows={2} placeholder="Motif" value={reason} onChange={(e) => setReason(e.target.value)} />
        {cancel.error && <Alert>{(cancel.error as ApiError).message}</Alert>}
        <div className="flex justify-end">
          <Button type="submit" variant="danger" loading={cancel.isPending}>
            Annuler la commande
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface TraceNode {
  production: { number: string } | null;
  supplier: { name: string } | null;
  receipt: { number: string } | null;
  inputs: { quantity: string; lot: TraceNode & { lotId: string; lotNumber: string; item: { name: string } | null } }[];
}

function Upstream({ node }: { node: TraceNode }) {
  return (
    <ul className="space-y-1 border-l-2 border-brand-200 pl-3 text-xs">
      {node.production && <li className="text-stone-500">Fabriqué par l’ordre {node.production.number}</li>}
      {!node.production && (node.supplier || node.receipt) && (
        <li className="text-stone-500">
          {node.supplier && `Fournisseur ${node.supplier.name}`}
          {node.receipt && ` · réception ${node.receipt.number}`}
        </li>
      )}
      {node.inputs.map((i) => (
        <li key={i.lot.lotId}>
          <span className="font-mono font-semibold">{i.lot.lotNumber}</span> · {i.lot.item?.name} × {qty(i.quantity)}
          <Upstream node={i.lot} />
        </li>
      ))}
    </ul>
  );
}

/** Commande → lots consommés → production → matières premières et fournisseurs. */
function OrderTrace({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['restaurant', 'trace', id],
    queryFn: () =>
      api.get<{ canTrace: boolean; items: { id: string; productName: string; quantity: string; lots: { id: string; lotNumber: string | null; item: { name: string } | null; quantity: string; returned: string; lost: string; upstream: TraceNode | null }[] }[] }>(
        `/restaurant/orders/${id}/trace`,
      ),
  });
  return (
    <Modal open wide title="Traçabilité de la commande" onClose={onClose}>
      {isLoading || !data ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          {!data.canTrace && <Alert tone="info">Le détail amont (production, fournisseurs) est réservé aux utilisateurs qui voient les stocks.</Alert>}
          {data.items.map((i) => (
            <div key={i.id}>
              <div className="flex items-center gap-2 font-semibold">
                <ChefHat className="size-4" /> {i.productName} × {qty(i.quantity)}
              </div>
              <ul className="ml-6 space-y-2">
                {i.lots.map((l) => (
                  <li key={l.id} className="text-sm">
                    <span className="font-mono font-semibold">{l.lotNumber}</span> · {l.item?.name} × {qty(l.quantity)}
                    {n(l.returned) > 0 && <span className="text-xs text-stone-500"> · rendu {qty(l.returned)}</span>}
                    {n(l.lost) > 0 && <span className="text-xs text-red-700"> · perte {qty(l.lost)}</span>}
                    {l.upstream && <Upstream node={l.upstream} />}
                  </li>
                ))}
                {i.lots.length === 0 && <li className="text-xs text-stone-500">Aucun lot (article annulé avant envoi).</li>}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
