import { useQuery } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { currentMonth, DateRange, periodQuery } from '../../components/DateRange';
import { Alert, Badge, Button, Card, PageHeader, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { CUSTOMER_TYPES, CustomerType } from '../../lib/customer-types';
import { formatDate, formatXOF } from '../../lib/format';
import { AdvancesReport, AGING_BUCKETS, CustomerDetailsReport, CustomerRef, CustomersKpi, Period, ReceivablesReport } from '../../lib/reporting-types';
import { RequirePermission } from '../stock/shared';

const n = (v: string | number | null | undefined) => Number(v ?? 0);
/** Permissions serveur : synthèses (« Tableau de bord direction ») ; détail nominatif (rapports + créances). */
const DASHBOARD = 'dashboard.view';
const DETAIL = ['reports.view', 'receivables.view'];

function Kpi({ title, value, tone, children }: { title: string; value: ReactNode; tone?: 'red' | 'green'; children?: ReactNode }) {
  return (
    <Card>
      <div className="text-sm text-stone-500">{title}</div>
      <div className={`text-2xl font-bold ${tone === 'red' ? 'text-red-700' : tone === 'green' ? 'text-green-700' : 'text-stone-900'}`}>{value}</div>
      {children && <div className="mt-2 space-y-0.5 text-xs text-stone-600">{children}</div>}
    </Card>
  );
}

function Line({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span>{label}</span>
      <span className="font-medium text-stone-800">{value}</span>
    </div>
  );
}

/** Module 7 — Créances et relances clients (lecture seule) : synthèses /pilotage/receivables, /customers, /advances et détail nominatif. */
export function CustomerReceivablesPage() {
  const [period, setPeriod] = useState<Period>(currentMonth);
  return (
    <>
      <PageHeader title="Créances clients" subtitle="Encours, ancienneté des retards, clients à relancer et avances disponibles" />
      <RequirePermission permission={DASHBOARD}>
        <Card className="mb-4">
          <DateRange value={period} onChange={setPeriod} />
          <p className="mt-2 text-xs text-stone-500">Situation à la fin du dernier jour de la période ; établissement : celui du menu (« Tout le groupe » = établissements autorisés).</p>
        </Card>
        <ReceivablesBody period={period} />
      </RequirePermission>
    </>
  );
}

function ReceivablesBody({ period }: { period: Period }) {
  const { establishmentId } = useAuth();
  const q = periodQuery(period);
  const key = [establishmentId, period.from, period.to];
  const receivables = useQuery({ queryKey: ['pilotage', 'receivables', ...key], queryFn: () => api.get<ReceivablesReport>(`/pilotage/receivables?${q}`) });
  const customers = useQuery({ queryKey: ['pilotage', 'customers', ...key], queryFn: () => api.get<CustomersKpi>(`/pilotage/customers?${q}`) });
  const advances = useQuery({ queryKey: ['pilotage', 'advances', ...key], queryFn: () => api.get<AdvancesReport>(`/pilotage/advances?${q}`) });
  // Détail nominatif : droits supplémentaires ; un refus n'empêche pas l'affichage des synthèses.
  const details = useQuery({ queryKey: ['pilotage', 'customers-details', ...key], queryFn: () => api.get<CustomerDetailsReport>(`/pilotage/customers/details?${q}`), retry: false });

  if (receivables.isLoading || customers.isLoading || advances.isLoading) return <Spinner />;
  const error = receivables.error ?? customers.error ?? advances.error;
  if (error) return <Alert>{(error as ApiError).message}</Alert>;
  const r = receivables.data!;
  const c = customers.data!;
  const a = advances.data!;
  if (r.byEstablishment.length === 0) return <Alert tone="info">Aucun établissement accessible pour ces créances.</Alert>;
  const t = r.total;
  const adv = a.total.closing;

  return (
    <div className="space-y-4">
      <p className="text-xs text-stone-500">
        Au {formatDate(r.asOf)} · montants TTC en FCFA · {r.byEstablishment.map((e) => e.establishment.code).join(', ')}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi title="Reste dû (créances ouvertes)" value={formatXOF(t.open.balance)}>
          <Line label="Factures ouvertes" value={t.open.count} />
          <Line label="Montant facturé" value={formatXOF(t.open.billed)} />
          <Line label="Déjà encaissé" value={formatXOF(t.open.paid)} />
          {n(t.open.credited) > 0 && <Line label="Avoirs" value={formatXOF(t.open.credited)} />}
        </Kpi>
        <Kpi title="En retard (échu)" value={formatXOF(t.overdue.balance)} tone={n(t.overdue.balance) > 0 ? 'red' : 'green'}>
          <Line label="Factures en retard" value={t.overdue.count} />
          <Line label="Non échu" value={formatXOF(t.notDue.balance)} />
        </Kpi>
        <Kpi title="Clients à suivre" value={`${c.customersOverdue} en retard`} tone={c.customersOverdue > 0 ? 'red' : undefined}>
          <Line label="Clients avec créance" value={c.customersWithReceivables} />
          <Line label="Clients actifs" value={c.activeCustomers} />
          {c.concentration.top5ReceivablesShare !== null && <Line label="Part des 5 premiers dans l’encours" value={`${c.concentration.top5ReceivablesShare.toLocaleString('fr-FR')} %`} />}
        </Kpi>
        <Kpi title="Avances disponibles" value={formatXOF(adv.totalAdvances)}>
          <Line label="Acomptes disponibles" value={formatXOF(adv.deposits.available)} />
          <Line label="· sur commandes" value={formatXOF(adv.deposits.availableOnOrders)} />
          <Line label="· convertis en crédit client" value={formatXOF(adv.deposits.convertedToCustomerCredit)} />
          <Line label="Paiements non répartis" value={formatXOF(adv.unappliedPayments)} />
        </Kpi>
      </div>

      <Card title="Ancienneté des créances">
        <Table head={['Tranche', 'Factures', 'Facturé', 'Encaissé', 'Avoirs', 'Reste dû']}>
          {t.aging.map((b) => (
            <tr key={b.bucket} className={b.bucket !== 'NOT_DUE' && n(b.balance) > 0 ? 'text-red-700' : ''}>
              <Td>{AGING_BUCKETS[b.bucket]}</Td>
              <Td>{b.count}</Td>
              <Td className="whitespace-nowrap">{formatXOF(b.billed)}</Td>
              <Td className="whitespace-nowrap">{formatXOF(b.paid)}</Td>
              <Td className="whitespace-nowrap">{n(b.credited) > 0 ? formatXOF(b.credited) : '—'}</Td>
              <Td className="whitespace-nowrap font-semibold">{formatXOF(b.balance)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      {r.byEstablishment.length > 1 && (
        <Card title="Par établissement">
          <Table head={['Établissement', 'Facturé', 'Encaissé', 'Reste dû', 'Dont en retard']}>
            {r.byEstablishment.map((e) => (
              <tr key={e.establishment.id}>
                <Td>
                  {e.establishment.code} — {e.establishment.name}
                </Td>
                <Td className="whitespace-nowrap">{formatXOF(e.open.billed)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(e.open.paid)}</Td>
                <Td className="whitespace-nowrap font-semibold">{formatXOF(e.open.balance)}</Td>
                <Td className={`whitespace-nowrap ${n(e.overdue.balance) > 0 ? 'text-red-700' : ''}`}>{formatXOF(e.overdue.balance)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <CustomerDetails query={details} />

      <div className="space-y-1 text-xs text-stone-500">
        {[...r.notes, ...a.notes].map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
    </div>
  );
}

/** Détail nominatif (GET /pilotage/customers/details) : clients par encours et factures échues, avec ouverture d'un client. */
function CustomerDetails({ query }: { query: { data?: CustomerDetailsReport; isLoading: boolean; error: unknown } }) {
  const [selected, setSelected] = useState<CustomerRef | null>(null);
  const [overdueOnly, setOverdueOnly] = useState(false);
  if (query.isLoading) return <Spinner />;
  if (query.error) {
    const e = query.error as ApiError;
    return (
      <Card title="Clients à relancer">
        <p className="text-sm text-stone-500">{e.status === 403 ? `Détail nominatif réservé : droits « ${DETAIL.join(' » + « ')} » requis sur le périmètre.` : e.message}</p>
      </Card>
    );
  }
  const d = query.data!;
  const top = d.topByReceivables.filter((x) => !overdueOnly || n(x.overdue) > 0);
  const invoicesOf = (id: string) => d.overdueInvoices.filter((i) => i.customer?.id === id);
  const row = selected ? d.topByReceivables.find((x) => x.customer?.id === selected.id) : undefined;

  return (
    <>
      <Card
        title="Clients par encours"
        actions={
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> En retard seulement
          </label>
        }
      >
        <Table head={['Client', 'Type', 'Reste dû', 'Dont en retard', 'Factures échues', '']} empty={top.length === 0}>
          {top.map((x) => (
            <tr key={x.customer?.id ?? 'inconnu'} className={`cursor-pointer hover:bg-stone-50 ${selected?.id === x.customer?.id ? 'bg-brand-50' : ''}`} onClick={() => x.customer && setSelected(x.customer)}>
              <Td className="font-medium">{x.customer?.name ?? '—'}</Td>
              <Td className="text-xs">{x.customer ? CUSTOMER_TYPES[x.customer.type as CustomerType] ?? x.customer.type : '—'}</Td>
              <Td className="whitespace-nowrap font-semibold">{formatXOF(x.receivables)}</Td>
              <Td className={`whitespace-nowrap ${n(x.overdue) > 0 ? 'font-semibold text-red-700' : ''}`}>{n(x.overdue) > 0 ? formatXOF(x.overdue) : '—'}</Td>
              <Td>{x.customer ? invoicesOf(x.customer.id).length : 0}</Td>
              <Td>{n(x.overdue) > 0 && <Badge tone="red">À relancer</Badge>}</Td>
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-xs text-stone-500">Les 10 clients au plus fort encours (limite du serveur). Cliquez sur un client pour voir ses factures échues.</p>
      </Card>

      {selected && (
        <Card
          title={`Client : ${selected.name}`}
          actions={
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Fermer
            </Button>
          }
        >
          <div className="mb-3 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              Reste dû<div className="text-lg font-bold">{formatXOF(row?.receivables ?? 0)}</div>
            </div>
            <div>
              Dont en retard<div className={`text-lg font-bold ${n(row?.overdue) > 0 ? 'text-red-700' : ''}`}>{formatXOF(row?.overdue ?? 0)}</div>
            </div>
            <div>
              Factures échues<div className="text-lg font-bold">{invoicesOf(selected.id).length}</div>
            </div>
          </div>
          <Table head={['Facture', 'Établissement', 'Échéance', 'Retard', 'Reste dû']} empty={invoicesOf(selected.id).length === 0}>
            {invoicesOf(selected.id).map((i) => (
              <tr key={i.invoiceId}>
                <Td className="font-mono text-xs font-semibold">{i.number}</Td>
                <Td>{i.establishment?.code ?? '—'}</Td>
                <Td className="whitespace-nowrap">{formatDate(i.dueDate)}</Td>
                <Td className="whitespace-nowrap text-red-700">{i.daysOverdue} j</Td>
                <Td className="whitespace-nowrap font-semibold">{formatXOF(i.balance)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card title="Factures échues à relancer">
        <Table head={['Facture', 'Client', 'Établissement', 'Échéance', 'Retard', 'Reste dû']} empty={d.overdueInvoices.length === 0}>
          {d.overdueInvoices.map((i) => (
            <tr key={i.invoiceId} className="cursor-pointer hover:bg-stone-50" onClick={() => i.customer && setSelected(i.customer)}>
              <Td className="font-mono text-xs font-semibold">{i.number}</Td>
              <Td>{i.customer?.name ?? '—'}</Td>
              <Td>{i.establishment?.code ?? '—'}</Td>
              <Td className="whitespace-nowrap">{formatDate(i.dueDate)}</Td>
              <Td className="whitespace-nowrap text-red-700">{i.daysOverdue} j</Td>
              <Td className="whitespace-nowrap font-semibold">{formatXOF(i.balance)}</Td>
            </tr>
          ))}
        </Table>
        {d.overdueInvoices.length === 100 && <p className="mt-2 text-xs text-stone-500">100 factures les plus en retard (limite du serveur).</p>}
      </Card>
    </>
  );
}
