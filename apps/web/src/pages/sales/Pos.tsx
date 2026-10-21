import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Percent, Plus, Search, X } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Product } from '../../lib/catalog-types';
import { formatXOF } from '../../lib/format';
import { CashRegister, CashSessionDetail, REFERENCE_REQUIRED, SaleResult } from '../../lib/sales-types';
import { PAYMENT_METHODS } from '../../lib/stock-types';
import { RequireEstablishment, RequirePermission, useRequestId } from '../stock/shared';
import { PrintStatus, printLines, TicketPreview } from './Ticket';

interface Discount {
  percent?: number;
  amount?: number;
  reason?: string;
}

interface CartLine extends Discount {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

const round = (v: number) => Math.round(v);
const discountValue = (base: number, d: Discount) => (d.percent ? round((base * d.percent) / 100) : d.amount ?? 0);
const lineGross = (l: CartLine) => round(l.price * l.quantity);
const lineNet = (l: CartLine) => lineGross(l) - discountValue(lineGross(l), l);

/** Caisse : vente au comptoir sur la session ouverte du caissier. */
export function PosPage() {
  return (
    <>
      <PageHeader title="Caisse" subtitle="Vente au comptoir, encaissement et ticket" />
      <RequirePermission permission="cash.operate">
        <RequireEstablishment>{(establishmentId) => <Pos establishmentId={establishmentId} />}</RequireEstablishment>
      </RequirePermission>
    </>
  );
}

function Pos({ establishmentId }: { establishmentId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cash-sessions', 'current'],
    queryFn: () => api.get<{ session: CashSessionDetail | null }>('/cash-sessions/current', { noEstablishment: true }),
  });
  if (isLoading) return <Spinner />;
  if (error) return <Alert>{(error as ApiError).message}</Alert>;
  const session = data?.session;
  if (!session) return <OpenSession establishmentId={establishmentId} />;
  if (session.establishmentId !== establishmentId) {
    return (
      <Card>
        <Alert tone="info">
          Votre session {session.number} est ouverte dans un autre établissement. Sélectionnez-le, ou clôturez-la depuis <Link className="underline" to="/sessions-caisse">Sessions de caisse</Link>.
        </Alert>
      </Card>
    );
  }
  return <Register session={session} establishmentId={establishmentId} />;
}

function OpenSession({ establishmentId }: { establishmentId: string }) {
  const qc = useQueryClient();
  const requestId = useRequestId();
  const registers = useQuery({ queryKey: ['cash-registers', establishmentId], queryFn: () => api.get<CashRegister[]>('/cash-registers') });
  const [registerId, setRegisterId] = useState('');
  const [float, setFloat] = useState('0');
  const open = useMutation({
    mutationFn: () => api.post('/cash-sessions', { clientRequestId: requestId, registerId, openingFloat: Number(float) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cash-sessions'] }),
  });
  const free = (registers.data ?? []).filter((r) => r.isActive && r.establishmentId === establishmentId);
  return (
    <Card title="Ouvrir une session de caisse" className="max-w-lg">
      {registers.isLoading ? (
        <Spinner />
      ) : free.length === 0 ? (
        <Alert tone="info">Aucune caisse active dans cet établissement. Un responsable doit en créer une (menu « Caisses »).</Alert>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            open.mutate();
          }}
        >
          <Field label="Caisse">
            <Select required value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
              <option value="">— Choisir —</option>
              {free.map((r) => (
                <option key={r.id} value={r.id} disabled={!!r.openSession}>
                  {r.code} — {r.name}
                  {r.openSession ? ` (occupée par ${r.openSession.cashier})` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fond de caisse (espèces, FCFA)">
            <Input type="number" min={0} step={1} required value={float} onChange={(e) => setFloat(e.target.value)} />
          </Field>
          {open.error && <Alert>{(open.error as ApiError).message}</Alert>}
          <Button type="submit" loading={open.isPending}>
            Ouvrir la session
          </Button>
        </form>
      )}
    </Card>
  );
}

function Register({ session, establishmentId }: { session: CashSessionDetail; establishmentId: string }) {
  const { can } = useAuth();
  const canDiscount = can('sales.discount');
  const products = useQuery({ queryKey: ['products', 'pos', establishmentId], queryFn: () => api.get<Product[]>('/products') });
  const sellable = useMemo(() => (products.data ?? []).filter((p) => p.isActive && p.isAvailable !== false && p.price != null), [products.data]);
  const categories = useMemo(() => [...new Map(sellable.filter((p) => p.category).map((p) => [p.category!.id, p.category!])).values()], [sellable]);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [ticketDiscount, setTicketDiscount] = useState<Discount>({});
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);
  const [paying, setPaying] = useState(0); // clé du formulaire de paiement (nouvel identifiant à chaque vente)
  const [done, setDone] = useState<SaleResult | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const add = (p: Product) =>
    setCart((c) => {
      const i = c.findIndex((l) => l.productId === p.id && !l.percent && !l.amount);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { productId: p.id, name: p.name, price: Number(p.price), quantity: 1 }];
    });
  const setQty = (i: number, q: number) => setCart((c) => (q <= 0 ? c.filter((_, j) => j !== i) : c.map((l, j) => (j === i ? { ...l, quantity: q } : l))));

  const shown = sellable.filter(
    (p) => (!category || p.category?.id === category) && (!search || `${p.code} ${p.name} ${p.barcode ?? ''}`.toLowerCase().includes(search.toLowerCase())),
  );
  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    // Lecteur de code-barres ou code produit exact : ajout direct.
    const exact = sellable.find((p) => p.barcode === search.trim() || p.code.toLowerCase() === search.trim().toLowerCase());
    if (exact) {
      add(exact);
      setSearch('');
    } else if (shown.length === 1) {
      add(shown[0]);
      setSearch('');
    }
  };

  const subtotal = cart.reduce((s, l) => s + lineNet(l), 0);
  const total = subtotal - discountValue(subtotal, ticketDiscount);
  const reset = () => {
    setCart([]);
    setTicketDiscount({});
    searchRef.current?.focus();
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            {session.register.code} — {session.register.name} <Badge tone="green">Session {session.number}</Badge>
          </span>
        }
        actions={
          <Link to="/sessions-caisse" className="text-sm text-brand-700 underline">
            Gérer la session
          </Link>
        }
      >
        <form onSubmit={onSearch} className="mb-3 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 size-4 text-stone-400" />
            <Input ref={searchRef} autoFocus className="pl-9" placeholder="Rechercher ou scanner un code-barres" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </form>
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
        {products.isLoading ? (
          <Spinner />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {shown.map((p) => (
              <button
                key={p.id}
                onClick={() => add(p)}
                className="flex min-h-20 flex-col justify-between rounded-lg border border-stone-200 bg-stone-50 p-2 text-left hover:border-brand-400 hover:bg-brand-50"
                style={p.category?.color ? { borderLeft: `4px solid ${p.category.color}` } : undefined}
              >
                <span className="text-sm font-medium leading-tight">{p.name}</span>
                <span className="text-sm font-semibold text-brand-700">{formatXOF(p.price)}</span>
              </button>
            ))}
            {shown.length === 0 && <p className="col-span-full py-6 text-center text-sm text-stone-500">Aucun produit à vendre.</p>}
          </div>
        )}
      </Card>

      <Card title="Ticket en cours" className="lg:sticky lg:top-0 lg:self-start">
        {cart.length === 0 ? (
          <p className="py-6 text-center text-sm text-stone-500">Touchez un produit pour l’ajouter.</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {cart.map((l, i) => (
              <li key={i} className="py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium">{l.name}</div>
                  <div className="text-sm font-semibold">{formatXOF(lineNet(l))}</div>
                </div>
                <div className="mt-1 flex items-center gap-1">
                  <Button variant="secondary" className="px-2 py-1" aria-label="Moins" onClick={() => setQty(i, l.quantity - 1)}>
                    <Minus className="size-3" />
                  </Button>
                  <Input className="w-16 py-1 text-center" type="number" min={0} step="any" value={l.quantity} onChange={(e) => setQty(i, Number(e.target.value))} aria-label="Quantité" />
                  <Button variant="secondary" className="px-2 py-1" aria-label="Plus" onClick={() => setQty(i, l.quantity + 1)}>
                    <Plus className="size-3" />
                  </Button>
                  <span className="ml-1 text-xs text-stone-500">× {formatXOF(l.price)}</span>
                  <span className="flex-1" />
                  {canDiscount && (
                    <Button variant="ghost" className="px-2 py-1" aria-label="Remise sur la ligne" onClick={() => setEditing({ index: i })}>
                      <Percent className="size-3" />
                    </Button>
                  )}
                  <Button variant="ghost" className="px-2 py-1" aria-label="Retirer" onClick={() => setQty(i, 0)}>
                    <X className="size-3" />
                  </Button>
                </div>
                {(l.percent || l.amount) && (
                  <div className="mt-1 text-xs text-brand-700">
                    Remise {l.percent ? `${l.percent} %` : formatXOF(l.amount)} — {l.reason}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 space-y-1 border-t border-stone-200 pt-3 text-sm">
          {(ticketDiscount.percent || ticketDiscount.amount) && (
            <div className="flex justify-between text-brand-700">
              <span>Remise ticket ({ticketDiscount.reason})</span>
              <span>−{formatXOF(discountValue(subtotal, ticketDiscount))}</span>
            </div>
          )}
          <div className="flex justify-between text-lg font-bold">
            <span>Total TTC</span>
            <span>{formatXOF(total)}</span>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button className="flex-1 py-3 text-base" disabled={!cart.length || total < 0} onClick={() => setPaying((k) => k + 1)}>
            Encaisser
          </Button>
          {canDiscount && (
            <Button variant="secondary" disabled={!cart.length} onClick={() => setEditing({ index: null })}>
              Remise ticket
            </Button>
          )}
          <Button variant="ghost" disabled={!cart.length} onClick={reset}>
            Vider
          </Button>
        </div>
      </Card>

      {editing && (
        <DiscountDialog
          title={editing.index === null ? 'Remise sur le ticket' : `Remise — ${cart[editing.index].name}`}
          initial={editing.index === null ? ticketDiscount : cart[editing.index]}
          onClose={() => setEditing(null)}
          onSave={(d) => {
            if (editing.index === null) setTicketDiscount(d);
            else setCart((c) => c.map((l, j) => (j === editing.index ? { ...l, percent: d.percent, amount: d.amount, reason: d.reason } : l)));
            setEditing(null);
          }}
        />
      )}
      {paying > 0 && (
        <PaymentDialog
          key={paying}
          sessionId={session.id}
          cart={cart}
          ticketDiscount={ticketDiscount}
          total={total}
          onClose={() => setPaying(0)}
          onSold={(res) => {
            setPaying(0);
            setDone(res);
            reset();
          }}
        />
      )}
      {done && <SaleDone result={done} onClose={() => setDone(null)} />}
    </div>
  );
}

/** Remise en % ou en montant, motif obligatoire (décision 8). */
function DiscountDialog({ title, initial, onClose, onSave }: { title: string; initial: Discount; onClose: () => void; onSave: (d: Discount) => void }) {
  const [mode, setMode] = useState<'percent' | 'amount'>(initial.amount ? 'amount' : 'percent');
  const [value, setValue] = useState(String(initial.percent ?? initial.amount ?? ''));
  const [reason, setReason] = useState(initial.reason ?? '');
  return (
    <Modal open title={title} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(value);
          onSave(!v ? {} : mode === 'percent' ? { percent: v, reason: reason.trim() } : { amount: Math.round(v), reason: reason.trim() });
        }}
      >
        <div className="flex gap-2">
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'percent' | 'amount')} className="w-36">
            <option value="percent">En %</option>
            <option value="amount">En FCFA</option>
          </Select>
          <Input type="number" min={0} max={mode === 'percent' ? 100 : undefined} step={mode === 'percent' ? 0.01 : 1} value={value} onChange={(e) => setValue(e.target.value)} placeholder="0 = aucune remise" />
        </div>
        <Field label="Motif (obligatoire)">
          <Input required={Number(value) > 0} minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit">Appliquer</Button>
        </div>
      </form>
    </Modal>
  );
}

interface PaymentLine {
  method: string;
  amount: string;
  reference: string;
}

/** Encaissement : plusieurs moyens possibles, monnaie rendue sur les espèces uniquement (décision 11). */
function PaymentDialog({
  sessionId,
  cart,
  ticketDiscount,
  total,
  onClose,
  onSold,
}: {
  sessionId: string;
  cart: CartLine[];
  ticketDiscount: Discount;
  total: number;
  onClose: () => void;
  onSold: (r: SaleResult) => void;
}) {
  const qc = useQueryClient();
  // Même identifiant à chaque tentative de ce formulaire : jamais deux ventes pour un double clic.
  const requestId = useRequestId();
  const [payments, setPayments] = useState<PaymentLine[]>([{ method: 'CASH', amount: String(total), reference: '' }]);
  const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const cash = payments.filter((p) => p.method === 'CASH').reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const rest = total - paid;
  const change = Math.max(0, paid - total);
  const update = (i: number, patch: Partial<PaymentLine>) => setPayments((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const sale = useMutation({
    mutationFn: () =>
      api.post<SaleResult>('/sales', {
        clientRequestId: requestId,
        sessionId,
        lines: cart.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          ...(l.percent ? { discountPercent: l.percent, discountReason: l.reason } : {}),
          ...(l.amount ? { discountAmount: l.amount, discountReason: l.reason } : {}),
        })),
        ...(ticketDiscount.percent ? { ticketDiscountPercent: ticketDiscount.percent, ticketDiscountReason: ticketDiscount.reason } : {}),
        ...(ticketDiscount.amount ? { ticketDiscountAmount: ticketDiscount.amount, ticketDiscountReason: ticketDiscount.reason } : {}),
        payments: payments
          .filter((p) => Number(p.amount) > 0)
          .map((p) => ({ method: p.method, amount: Math.round(Number(p.amount)), ...(p.reference.trim() ? { reference: p.reference.trim() } : {}) })),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['cash-sessions'] });
      qc.invalidateQueries({ queryKey: ['sales'] });
      onSold(res);
    },
  });
  const quick = [...new Set([total, Math.ceil(total / 500) * 500, Math.ceil(total / 1000) * 1000, Math.ceil(total / 5000) * 5000, 10000])].filter((v) => v >= total).slice(0, 4);
  return (
    <Modal open wide title={`Encaisser ${formatXOF(total)}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          sale.mutate();
        }}
      >
        {payments.map((p, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Field label="Moyen">
              <Select value={p.method} onChange={(e) => update(i, { method: e.target.value })} className="w-44">
                {Object.entries(PAYMENT_METHODS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Montant reçu">
              <Input className="w-36" type="number" min={0} step={1} required value={p.amount} onChange={(e) => update(i, { amount: e.target.value })} />
            </Field>
            {p.method !== 'CASH' && (
              <Field label={REFERENCE_REQUIRED.has(p.method) ? 'Référence (obligatoire)' : 'Référence'}>
                <Input className="w-48" required={REFERENCE_REQUIRED.has(p.method)} maxLength={100} value={p.reference} onChange={(e) => update(i, { reference: e.target.value })} placeholder="N° de transaction" />
              </Field>
            )}
            {payments.length > 1 && (
              <Button type="button" variant="ghost" aria-label="Retirer ce paiement" onClick={() => setPayments((ps) => ps.filter((_, j) => j !== i))}>
                <X className="size-4" />
              </Button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          {quick.map((v) => (
            <Button key={v} type="button" variant="secondary" onClick={() => setPayments([{ method: 'CASH', amount: String(v), reference: '' }])}>
              {formatXOF(v)} espèces
            </Button>
          ))}
          <Button type="button" variant="ghost" onClick={() => setPayments((ps) => [...ps, { method: 'WAVE', amount: String(Math.max(0, rest)), reference: '' }])}>
            <Plus className="size-4" /> Autre moyen
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-stone-50 p-3 text-center text-sm">
          <div>
            Reçu
            <div className="text-lg font-bold">{formatXOF(paid)}</div>
          </div>
          <div>
            Reste à payer
            <div className={`text-lg font-bold ${rest > 0 ? 'text-red-700' : ''}`}>{formatXOF(Math.max(0, rest))}</div>
          </div>
          <div>
            Monnaie à rendre
            <div className="text-lg font-bold text-green-700">{formatXOF(change)}</div>
          </div>
        </div>
        {change > cash && <Alert>La monnaie ne se rend qu’en espèces : les autres moyens ne peuvent pas dépasser le total.</Alert>}
        {sale.error && <Alert>{(sale.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Retour
          </Button>
          <Button type="submit" className="py-3" loading={sale.isPending} disabled={rest > 0 || change > cash}>
            Valider l’encaissement
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SaleDone({ result, onClose }: { result: SaleResult; onClose: () => void }) {
  const [job, setJob] = useState(result.print);
  const printed = useRef(false);
  useEffect(() => {
    // Caisse configurée pour le navigateur : le ticket s'imprime aussitôt.
    if (!printed.current && result.print?.status === 'BROWSER' && result.print.kind === 'TICKET') {
      printed.current = true;
      printLines(result.ticket.lines, result.ticket.width, result.sale.number);
    }
  }, [result]);
  return (
    <Modal open title={`Vente ${result.sale.number}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="rounded-lg bg-stone-50 p-3">
            Total
            <div className="text-xl font-bold">{formatXOF(result.sale.total)}</div>
          </div>
          <div className="rounded-lg bg-green-50 p-3">
            Monnaie à rendre
            <div className="text-xl font-bold text-green-700">{formatXOF(result.sale.changeGiven)}</div>
          </div>
        </div>
        <PrintStatus job={job} ticket={result.ticket} onDone={setJob} />
        <TicketPreview ticket={result.ticket} />
        <div className="flex justify-end">
          <Button autoFocus onClick={onClose}>
            Nouvelle vente
          </Button>
        </div>
      </div>
    </Modal>
  );
}
