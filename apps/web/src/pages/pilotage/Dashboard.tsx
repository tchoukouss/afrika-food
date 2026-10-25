import { useQuery } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { currentMonth, DateRange, periodQuery } from '../../components/DateRange';
import { Alert, Badge, Card, PageHeader, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, formatXOF } from '../../lib/format';
import { AGING_BUCKETS, Dashboard, isUnavailable, Period } from '../../lib/reporting-types';
import { PAYMENT_METHODS } from '../../lib/stock-types';
import { RequirePermission } from '../stock/shared';

const n = (v: string | number | null | undefined) => Number(v ?? 0);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toLocaleString('fr-FR')} %`);
const qtyText = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

/** Carte d'indicateur : valeur principale et détails, au style des cartes existantes. */
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

/** Module 8 — Tableau de bord de pilotage (lecture seule) : synthèse de GET /pilotage/dashboard. */
export function DashboardPage() {
  const [period, setPeriod] = useState<Period>(currentMonth);
  return (
    <>
      <PageHeader title="Tableau de bord" subtitle="Pilotage — chiffre d’affaires, encaissements, créances, achats, stock, production" />
      <RequirePermission permission="dashboard.view">
        <Card className="mb-4">
          <DateRange value={period} onChange={setPeriod} />
        </Card>
        <DashboardBody period={period} />
      </RequirePermission>
    </>
  );
}

function DashboardBody({ period }: { period: Period }) {
  // Établissement : celui du menu (en-tête de requête) ; vue groupe = établissements autorisés.
  const { establishmentId } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['pilotage', 'dashboard', establishmentId, period.from, period.to],
    queryFn: () => api.get<Dashboard>(`/pilotage/dashboard?${periodQuery(period)}`),
  });
  if (isLoading) return <Spinner />;
  if (error) return <Alert>{(error as ApiError).message}</Alert>;
  if (!data) return null;
  if (data.establishments.length === 0) return <Alert tone="info">Aucun établissement accessible pour ce tableau de bord.</Alert>;

  const s = data.summary;
  const m = s.margin;
  return (
    <div className="space-y-4">
      <p className="text-xs text-stone-500">
        Du {formatDate(data.period.from)} au {formatDate(data.period.to)} · montants TTC en FCFA · {data.establishments.map((e) => e.code).join(', ')}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Kpi title="Chiffre d’affaires TTC" value={formatXOF(s.revenue.ttc)}>
          {s.revenue.excludingTax !== null ? <Line label="Hors taxes" value={formatXOF(s.revenue.excludingTax)} /> : <div>{s.revenue.taxNote}</div>}
          {s.revenue.tax !== null && n(s.revenue.tax) > 0 && <Line label="TVA" value={formatXOF(s.revenue.tax)} />}
          <Line label="Écart CA − encaissements" value={formatXOF(s.revenueCollectionsGap)} />
        </Kpi>

        <Kpi title="Encaissements" value={formatXOF(s.collections.total)}>
          <Line label="Tickets" value={formatXOF(s.collections.tickets)} />
          <Line label="Clients (factures, acomptes)" value={formatXOF(s.collections.customers)} />
          {s.collections.byMethod
            .filter((b) => n(b.amount) !== 0)
            .map((b) => (
              <Line key={b.method} label={`· ${PAYMENT_METHODS[b.method] ?? b.method}`} value={formatXOF(b.amount)} />
            ))}
        </Kpi>

        <Kpi title="Créances clients" value={formatXOF(s.receivables.balance)} tone={n(s.receivables.overdue) > 0 ? 'red' : undefined}>
          <Line label="Non échu" value={formatXOF(s.receivables.notDue)} />
          <Line label="En retard" value={formatXOF(s.receivables.overdue)} />
          {s.receivables.aging
            .filter((a) => a.bucket !== 'NOT_DUE' && n(a.balance) > 0)
            .map((a) => (
              <Line key={a.bucket} label={`· ${AGING_BUCKETS[a.bucket]}`} value={formatXOF(a.balance)} />
            ))}
          <Line label="Clients actifs / avec créance / en retard" value={`${s.customers.active} / ${s.customers.withReceivables} / ${s.customers.overdue}`} />
        </Kpi>

        <Kpi title="Avances clients" value={formatXOF(s.advances.total)}>
          <Line label="Acomptes disponibles" value={formatXOF(s.advances.deposits)} />
          <Line label="Crédit client" value={formatXOF(s.advances.customerCredit)} />
          <Line label="Paiements non répartis" value={formatXOF(s.advances.unappliedPayments)} />
        </Kpi>

        <Kpi title="Achats nets" value={formatXOF(s.purchases.net)}>
          <Line label="Réceptions" value={formatXOF(s.purchases.receipts)} />
          <Line label="Retours fournisseurs" value={formatXOF(s.purchases.returns)} />
        </Kpi>

        <Kpi title="Stock (valeur actuelle)" value={formatXOF(s.stock.value)} tone={s.stock.outOfStock > 0 ? 'red' : undefined}>
          <Line label="Articles en rupture" value={s.stock.outOfStock} />
          <Line label="Articles sous le seuil" value={s.stock.belowThreshold} />
          <Line label="Articles avec stock réservé" value={s.stock.withReservedStock} />
        </Kpi>

        <Kpi title="Production" value={`${qtyText(s.production.produced)} produits`}>
          <Line label="Prévu (ordres terminés)" value={qtyText(s.production.completedPlanned)} />
          <Line label="Taux de réalisation" value={pct(s.production.realizationRate)} />
          <Line label="Prévu (ordres créés)" value={qtyText(s.production.plannedQuantity)} />
          <Line label="Ordres en cours en fin de période" value={s.production.inProgressAtEnd} />
        </Kpi>

        {isUnavailable(m) ? (
          <Kpi title="Marge brute" value={<span className="text-base text-stone-500">Section réservée</span>}>
            <div>Droits requis : {m.requires.join(' + ')}</div>
          </Kpi>
        ) : (
          <Kpi title="Marge brute" value={formatXOF(m.grossMargin)}>
            <Line label="Taux de marge" value={pct(m.rate)} />
            <Line label="CA avec coût connu" value={formatXOF(m.revenueWithCost)} />
            <Line label="Coût des ventes" value={formatXOF(m.cogs)} />
            <Line label="Couverture du CA" value={pct(m.coverage)} />
            {n(m.uncovered) > 0 && <Line label="CA sans coût connu" value={formatXOF(m.uncovered)} />}
          </Kpi>
        )}

        <Kpi title="Écarts de caisse" value={formatXOF(s.cash.totalDifference)} tone={n(s.cash.totalDifference) !== 0 ? 'red' : 'green'}>
          <Line label="Sessions clôturées avec écart" value={s.cash.sessionsWithDifference} />
          <Line label="Sessions ouvertes en fin de période" value={s.cash.openAtEnd} />
        </Kpi>
      </div>

      {data.byEstablishment.length > 0 && (
        <Card title="Par établissement">
          <Table head={['Établissement', 'Chiffre d’affaires', 'Encaissements', 'Créances', 'Achats nets', 'Valeur du stock']}>
            {data.byEstablishment.map((e) => (
              <tr key={e.establishment.id}>
                <Td>
                  {e.establishment.code} — {e.establishment.name}
                </Td>
                <Td className="whitespace-nowrap">{formatXOF(e.revenue)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(e.collections)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(e.receivables)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(e.netPurchases)}</Td>
                <Td className="whitespace-nowrap">{formatXOF(e.stockValue)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {data.establishments.length > 1 && <Badge>{data.establishments.length} établissements consolidés</Badge>}
    </div>
  );
}
