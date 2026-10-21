import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, formatXOF } from '../../lib/format';
import { CASH_MOVEMENT_TYPES, CashSessionDetail, CashSessionRow, SALE_STATUS, SESSION_STATUS, ZReport } from '../../lib/sales-types';
import { PAYMENT_METHODS } from '../../lib/stock-types';
import { RequirePermission, StatusBadge, useRequestId } from '../stock/shared';
import { printLines } from './Ticket';

const method = (m: string) => PAYMENT_METHODS[m] ?? m;
const n = (v: string | number) => Number(v);

/** Sessions de caisse : les siennes (caissier) ou toutes celles de l'établissement (« voir toutes les caisses »). */
export function SessionsPage() {
  const { establishmentId } = useAuth();
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['cash-sessions', 'list', establishmentId, status],
    queryFn: () => api.get<CashSessionRow[]>(`/cash-sessions${status ? `?status=${status}` : ''}`),
  });
  return (
    <>
      <PageHeader title="Sessions de caisse" subtitle="Fond de caisse, mouvements, clôture, validation et rapport Z" />
      <RequirePermission permission={['cash.operate', 'cash.view_all']}>
        <Card
          actions={
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48" aria-label="Statut">
              <option value="">Tous les statuts</option>
              {Object.entries(SESSION_STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          }
        >
          {isLoading && <Spinner />}
          {error && <Alert>{(error as ApiError).message}</Alert>}
          {data && (
            <Table head={['N°', 'Caisse', 'Caissier', 'Ouverte', 'Clôturée', 'Ventes', 'Statut']} empty={data.length === 0}>
              {data.map((s) => (
                <tr key={s.id} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpenId(s.id)}>
                  <Td className="font-mono text-xs font-semibold">{s.number}</Td>
                  <Td>{s.register.code}</Td>
                  <Td>{s.cashier}</Td>
                  <Td>{formatDateTime(s.openedAt)}</Td>
                  <Td>{formatDateTime(s.closedAt)}</Td>
                  <Td>
                    {s.salesCount} · {formatXOF(s.salesTotal)}
                  </Td>
                  <Td>
                    <StatusBadge map={SESSION_STATUS} status={s.status} />
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        {openId && <SessionDialog id={openId} onClose={() => setOpenId(null)} />}
      </RequirePermission>
    </>
  );
}

function SessionDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useAuth();
  const { data: s, isLoading } = useQuery({ queryKey: ['cash-sessions', id], queryFn: () => api.get<CashSessionDetail>(`/cash-sessions/${id}`) });
  const [panel, setPanel] = useState<'movement' | 'close' | 'validate' | 'report' | null>(null);
  if (isLoading || !s) return null;
  const mine = s.cashierId === me?.id;
  return (
    <Modal open wide title={`Session ${s.number}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge map={SESSION_STATUS} status={s.status} />
          <span>
            {s.register.code} — {s.register.name}
          </span>
          <span>Caissier : {s.cashier}</span>
          <span>Ouverte le {formatDateTime(s.openedAt)}</span>
          {s.validatedBy && (
            <span>
              Validée par {s.validatedBy} le {formatDateTime(s.validatedAt)}
            </span>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {s.expected.map((e) => (
            <div key={e.method} className="rounded-lg bg-stone-50 p-3 text-sm">
              {method(e.method)} attendu
              <div className="text-lg font-bold">{formatXOF(e.amount)}</div>
            </div>
          ))}
        </div>
        {s.closures.length > 0 && (
          <Table head={['Moyen', 'Attendu', 'Compté', 'Écart']}>
            {s.closures.map((c) => (
              <tr key={c.method}>
                <Td>{method(c.method)}</Td>
                <Td>{formatXOF(c.expected)}</Td>
                <Td>{formatXOF(c.counted)}</Td>
                <Td className={n(c.difference) < 0 ? 'font-semibold text-red-700' : n(c.difference) > 0 ? 'font-semibold text-sky-700' : ''}>{formatXOF(c.difference)}</Td>
              </tr>
            ))}
          </Table>
        )}
        {s.closingNote && <p className="text-sm text-stone-600">Note de clôture : {s.closingNote}</p>}
        {s.validationNote && <p className="text-sm text-stone-600">Note de validation : {s.validationNote}</p>}

        <div className="flex flex-wrap gap-2">
          {s.canMoveCash && (
            <Button variant="secondary" onClick={() => setPanel('movement')}>
              Entrée / sortie d’espèces
            </Button>
          )}
          {s.status === 'OPEN' && mine && <Button onClick={() => setPanel('close')}>Compter et clôturer</Button>}
          {s.canValidate && <Button onClick={() => setPanel('validate')}>Valider la clôture</Button>}
          <Button variant="secondary" onClick={() => setPanel('report')}>
            Rapport Z
          </Button>
        </div>
        {panel === 'movement' && <MovementForm session={s} onDone={() => setPanel(null)} />}
        {panel === 'close' && <CloseForm session={s} onDone={() => setPanel(null)} />}
        {panel === 'validate' && <ValidateForm session={s} onDone={() => setPanel(null)} />}
        {panel === 'report' && <Report id={s.id} />}

        <h3 className="font-semibold">Mouvements</h3>
        <Table head={['Date', 'Type', 'Moyen', 'Montant', 'Détail', 'Par']} empty={s.movements.length === 0}>
          {s.movements.map((m) => (
            <tr key={m.id}>
              <Td>{formatDateTime(m.createdAt)}</Td>
              <Td>{CASH_MOVEMENT_TYPES[m.type] ?? m.type}</Td>
              <Td>{method(m.method)}</Td>
              <Td className={n(m.amount) < 0 ? 'text-red-700' : ''}>{formatXOF(m.amount)}</Td>
              <Td className="text-xs">{m.saleNumber ?? m.reason}</Td>
              <Td className="text-xs">{m.user}</Td>
            </tr>
          ))}
        </Table>
      </div>
    </Modal>
  );
}

function useRefresh(id: string, done: () => void) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['cash-sessions'] });
    qc.invalidateQueries({ queryKey: ['cash-sessions', id] });
    done();
  };
}

function MovementForm({ session, onDone }: { session: CashSessionDetail; onDone: () => void }) {
  const requestId = useRequestId();
  const refresh = useRefresh(session.id, onDone);
  const [type, setType] = useState<'MANUAL_IN' | 'MANUAL_OUT'>('MANUAL_OUT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/cash-sessions/${session.id}/movements`, { clientRequestId: requestId, type, amount: Number(amount), reason }),
    onSuccess: refresh,
  });
  return (
    <Card title="Mouvement manuel d’espèces">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as 'MANUAL_IN' | 'MANUAL_OUT')}>
            <option value="MANUAL_OUT">Sortie</option>
            <option value="MANUAL_IN">Entrée</option>
          </Select>
        </Field>
        <Field label="Montant (FCFA)">
          <Input type="number" min={1} step={1} required value={amount} onChange={(e) => setAmount(e.target.value)} className="w-36" />
        </Field>
        <Field label="Motif">
          <Input required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className="w-64" />
        </Field>
        <Button type="submit" loading={save.isPending}>
          Enregistrer
        </Button>
      </form>
      {save.error && <div className="mt-2"><Alert>{(save.error as ApiError).message}</Alert></div>}
    </Card>
  );
}

/** Comptage par moyen de paiement ; l'écart est enregistré sans bloquer (décision 6). */
function CloseForm({ session, onDone }: { session: CashSessionDetail; onDone: () => void }) {
  const refresh = useRefresh(session.id, onDone);
  const methods = [...new Set(['CASH', ...session.expected.filter((e) => n(e.amount) !== 0).map((e) => e.method)])];
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const close = useMutation({
    mutationFn: () => api.post(`/cash-sessions/${session.id}/close`, { counts: methods.map((m) => ({ method: m, counted: Number(counts[m] ?? 0) })), note }),
    onSuccess: refresh,
  });
  return (
    <Card title="Comptage de la caisse">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          close.mutate();
        }}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          {methods.map((m) => (
            <Field key={m} label={`${method(m)} compté`}>
              <Input type="number" min={0} step={1} required value={counts[m] ?? ''} onChange={(e) => setCounts({ ...counts, [m]: e.target.value })} />
            </Field>
          ))}
        </div>
        <Field label="Note (facultative)">
          <Textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {close.error && <Alert>{(close.error as ApiError).message}</Alert>}
        <Button type="submit" loading={close.isPending}>
          Clôturer la session
        </Button>
      </form>
    </Card>
  );
}

function ValidateForm({ session, onDone }: { session: CashSessionDetail; onDone: () => void }) {
  const refresh = useRefresh(session.id, onDone);
  const [note, setNote] = useState('');
  const validate = useMutation({ mutationFn: () => api.post(`/cash-sessions/${session.id}/validate`, { note }), onSuccess: refresh });
  return (
    <Card title="Validation de la clôture">
      <div className="space-y-3">
        <Field label="Commentaire (écart expliqué…)">
          <Textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {validate.error && <Alert>{(validate.error as ApiError).message}</Alert>}
        <Button loading={validate.isPending} onClick={() => validate.mutate()}>
          Valider
        </Button>
      </div>
    </Card>
  );
}

function Report({ id }: { id: string }) {
  const { data: z, isLoading } = useQuery({ queryKey: ['cash-sessions', id, 'report'], queryFn: () => api.get<ZReport>(`/cash-sessions/${id}/report`) });
  if (isLoading || !z) return <Spinner />;
  const lines = [
    `RAPPORT Z — ${z.establishment.code} ${z.establishment.name}`,
    `Session ${z.session.number} — caisse ${z.session.register.code}`,
    `Caissier : ${z.session.cashier ?? ''}`,
    `Ouverture : ${formatDateTime(z.session.openedAt)}`,
    `Clôture   : ${formatDateTime(z.session.closedAt)}`,
    '----------------------------------------',
    ...z.salesByStatus.map((r) => `${SALE_STATUS[r.status]?.label ?? r.status} : ${r.count} — ${formatXOF(r.total)}`),
    '----------------------------------------',
    `Chiffre brut TTC : ${formatXOF(z.totals.gross)}`,
    `Remises          : ${formatXOF(z.totals.discounts)}`,
    `Total TTC        : ${formatXOF(z.totals.total)}`,
    `dont TVA         : ${formatXOF(z.totals.tax)}`,
    '----------------------------------------',
    ...z.movements.map((m) => `${CASH_MOVEMENT_TYPES[m.type] ?? m.type} ${method(m.method)} (${m.count}) : ${formatXOF(m.amount)}`),
    ...z.returns.map((r) => `${r.kind === 'CANCEL' ? 'Annulations' : 'Remboursements'} (${r.count}) : ${formatXOF(r.total)}`),
    '----------------------------------------',
    ...z.session.closures.map((c) => `${method(c.method)} : attendu ${formatXOF(c.expected)}, compté ${formatXOF(c.counted)}, écart ${formatXOF(c.difference)}`),
  ];
  return (
    <Card title="Rapport Z" actions={<Button variant="secondary" onClick={() => printLines(lines, 48, `Rapport Z ${z.session.number}`)}><Printer className="size-4" /> Imprimer</Button>}>
      <pre className="overflow-x-auto font-mono text-xs leading-relaxed">{lines.join('\n')}</pre>
    </Card>
  );
}
