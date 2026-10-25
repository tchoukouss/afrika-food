import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCustomerCredit } from '../../components/CustomerPicker';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { CreditOverride, Customer, CustomerDetail, CUSTOMER_TYPES, CustomerType, OVERRIDE_STATUS } from '../../lib/customer-types';
import { formatDateTime, formatXOF } from '../../lib/format';
import { RequirePermission, StatusBadge, useReasonDialog, useRequestId } from '../stock/shared';

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all(['customers', 'customer-credit', 'customer-credit-overrides'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

/**
 * Droits côté interface (le serveur reste seul juge) : fichier clients commun
 * au groupe, permission vérifiée dans l'établissement sélectionné, sinon dans
 * au moins un établissement (vue groupe).
 */
function useCustomerAccess() {
  const { me, establishmentId, can, canAnywhere } = useAuth();
  const has = (p: string) => (establishmentId ? can(p) : canAnywhere(p));
  const inEst = (estId: string, p: string) => (me?.globalPermissions.includes(p) ?? false) || !!me?.establishments.find((e) => e.id === estId)?.permissions.includes(p);
  return {
    establishmentId,
    manage: has('customers.manage'),
    // Limite et délai de paiement : contrôle serveur assertCreditRights = credit.override au niveau groupe
    // ou dans au moins un établissement, quel que soit l'établissement sélectionné.
    setCreditTerms: canAnywhere('credit.override'),
    override: !!establishmentId && can('credit.override'),
    canCancelOverride: (o: CreditOverride) => has('credit.override') && inEst(o.establishmentId, 'credit.override'),
    establishmentLabel: (id: string) => {
      const e = me?.establishments.find((x) => x.id === id);
      return e ? e.code : '—';
    },
  };
}

function CustomerForm({ initial, onDone }: { initial?: CustomerDetail; onDone: (c: CustomerDetail) => void }) {
  const qc = useQueryClient();
  const { setCreditTerms } = useCustomerAccess();
  const requestId = useRequestId();
  const [f, setF] = useState({
    type: initial?.type ?? ('INDIVIDUAL' as CustomerType),
    name: initial?.name ?? '',
    phone: initial?.phone ?? '',
    email: initial?.email ?? '',
    address: initial?.address ?? '',
    taxId: initial?.taxId ?? '',
    creditLimit: initial?.creditLimit ?? '',
    paymentTermDays: String(initial?.paymentTermDays ?? 0),
    notes: initial?.notes ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const { creditLimit, paymentTermDays, ...rest } = f;
      const limit = creditLimit === '' ? null : Number(creditLimit);
      const days = Number(paymentTermDays) || 0;
      if (!initial) {
        // Création : conditions de crédit envoyées seulement si renseignées (le serveur exige alors credit.override).
        return api.post<CustomerDetail>('/customers', { clientRequestId: requestId, ...rest, ...(limit !== null ? { creditLimit: limit } : {}), ...(days > 0 ? { paymentTermDays: days } : {}) });
      }
      // Modification : seuls les champs changés partent (un champ texte vidé est envoyé vide, le serveur le remet à null).
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== ((initial[k as keyof typeof rest] as string | null) ?? '')) body[k] = v;
      if (limit !== (initial.creditLimit === null ? null : Number(initial.creditLimit))) body.creditLimit = limit;
      if (days !== initial.paymentTermDays) body.paymentTermDays = days;
      return Object.keys(body).length ? api.patch<CustomerDetail>(`/customers/${initial.id}`, body) : Promise.resolve(initial);
    },
    onSuccess: async (c) => {
      await invalidate(qc);
      onDone(c);
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type">
          <Select value={f.type} onChange={set('type')}>
            {Object.entries(CUSTOMER_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Nom ou raison sociale">
            <Input required minLength={2} maxLength={150} value={f.name} onChange={set('name')} />
          </Field>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Téléphone" hint="Unique dans l’entreprise">
          <Input maxLength={30} value={f.phone} onChange={set('phone')} placeholder="07 00 00 00 00" />
        </Field>
        <Field label="Email">
          <Input type="email" maxLength={150} value={f.email} onChange={set('email')} />
        </Field>
        <Field label="N° contribuable (NCC)">
          <Input maxLength={50} value={f.taxId} onChange={set('taxId')} />
        </Field>
      </div>
      <Field label="Adresse">
        <Input maxLength={300} value={f.address} onChange={set('address')} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Plafond de crédit (FCFA)" hint={setCreditTerms ? 'Vide = aucun crédit sans autorisation' : 'Réservé à un responsable habilité au crédit'}>
          <Input type="number" min={0} step={1} disabled={!setCreditTerms} value={f.creditLimit} onChange={set('creditLimit')} />
        </Field>
        <Field label="Délai de paiement (jours)">
          <Input type="number" min={0} max={365} step={1} disabled={!setCreditTerms} value={f.paymentTermDays} onChange={set('paymentTermDays')} />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea rows={2} maxLength={1000} value={f.notes} onChange={set('notes')} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Enregistrer
        </Button>
      </div>
    </form>
  );
}

/** Pré-autorisation de dépassement : établissement sélectionné, montant maximal, valable 1 heure. */
function OverrideForm({ customer, establishmentId, onDone }: { customer: CustomerDetail; establishmentId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const requestId = useRequestId();
  const [f, setF] = useState({ maxAmount: '', reason: '' });
  const grant = useMutation({
    mutationFn: () => api.post<CreditOverride>(`/customers/${customer.id}/credit-overrides`, { clientRequestId: requestId, establishmentId, maxAmount: Math.round(Number(f.maxAmount)), reason: f.reason.trim() }),
    onSuccess: async () => {
      await invalidate(qc);
      onDone();
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        grant.mutate();
      }}
    >
      {grant.error && <Alert>{(grant.error as ApiError).message}</Alert>}
      <Alert tone="info">Valable 1 heure, une seule fois, dans l’établissement sélectionné, jusqu’au montant indiqué.</Alert>
      <Field label="Montant maximal à crédit (FCFA)">
        <Input type="number" required min={1} step={1} value={f.maxAmount} onChange={(e) => setF({ ...f, maxAmount: e.target.value })} />
      </Field>
      <Field label="Motif">
        <Input required minLength={3} maxLength={500} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={grant.isPending}>
          Autoriser
        </Button>
      </div>
    </form>
  );
}

/** Situation lue par GET /customers/:id/credit, qui exige l'établissement d'où le crédit serait accordé. */
function CreditSection({ customer, establishmentId }: { customer: CustomerDetail; establishmentId: string | null }) {
  const { establishmentLabel } = useCustomerAccess();
  const credit = useCustomerCredit(establishmentId ? customer.id : null, establishmentId ?? '');
  if (!establishmentId) return <Alert tone="info">Sélectionnez un établissement dans le menu pour voir la situation de crédit de ce client.</Alert>;
  if (credit.isLoading) return <Spinner />;
  if (credit.error) return <Alert>{(credit.error as ApiError).message}</Alert>;
  const c = credit.data!;
  return (
    <div className="space-y-1">
      <p className="text-xs text-stone-500">
        Établissement {establishmentLabel(establishmentId)} · {c.activeOverrides} autorisation(s) de dépassement active(s) dans cet établissement
      </p>
    <div className="grid grid-cols-2 gap-2 rounded-lg bg-stone-50 p-3 text-center text-sm sm:grid-cols-4">
      <div>
        Encours<div className="text-lg font-bold">{formatXOF(c.outstanding)}</div>
      </div>
      <div>
        Plafond<div className="text-lg font-bold">{c.creditLimit === null ? 'Aucun' : formatXOF(c.creditLimit)}</div>
      </div>
      <div>
        Disponible<div className={`text-lg font-bold ${Number(c.available) > 0 ? 'text-green-700' : 'text-red-700'}`}>{formatXOF(c.available)}</div>
      </div>
      <div>
        Délai de paiement<div className="text-lg font-bold">{c.paymentTermDays > 0 ? `${c.paymentTermDays} j` : 'comptant'}</div>
      </div>
    </div>
    </div>
  );
}

function Overrides({ customer }: { customer: CustomerDetail }) {
  const qc = useQueryClient();
  const access = useCustomerAccess();
  const reason = useReasonDialog();
  const [granting, setGranting] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['customer-credit-overrides', customer.id],
    queryFn: () => api.get<CreditOverride[]>(`/customers/${customer.id}/credit-overrides`),
  });
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post<CreditOverride>(`/credit-overrides/${id}/cancel`, { reason }),
    onSuccess: () => invalidate(qc),
  });
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Autorisations de dépassement</h3>
        {access.override && customer.isActive && (
          <Button variant="secondary" onClick={() => setGranting(true)}>
            <Plus className="size-4" /> Autoriser un dépassement
          </Button>
        )}
      </div>
      {!access.establishmentId && <Alert tone="info">Sélectionnez un établissement pour accorder une autorisation : elle ne vaut que pour cet établissement.</Alert>}
      {cancel.error && <Alert>{(cancel.error as ApiError).message}</Alert>}
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{(error as ApiError).message}</Alert>
      ) : (
        <Table head={['Accordée le', 'Étab.', 'Montant max', 'Motif', 'Statut', 'Utilisation', '']} empty={data?.length === 0}>
          {data?.map((o) => (
            <tr key={o.id}>
              <Td className="whitespace-nowrap">
                {formatDateTime(o.createdAt)}
                <div className="text-xs text-stone-500">{o.approvedBy ?? '—'}</div>
              </Td>
              <Td>{access.establishmentLabel(o.establishmentId)}</Td>
              <Td className="whitespace-nowrap">{formatXOF(o.maxAmount)}</Td>
              <Td>{o.reason}</Td>
              <Td>
                <StatusBadge map={OVERRIDE_STATUS} status={o.status} />
                {o.status === 'ACTIVE' && <div className="text-xs text-stone-500">jusqu’à {formatDateTime(o.expiresAt)}</div>}
              </Td>
              <Td className="text-xs">
                {o.usedAt && (
                  <>
                    {formatXOF(o.usedAmount)} · {o.usedReference ?? '—'}
                    <div className="text-stone-500">
                      {formatDateTime(o.usedAt)} · {o.usedBy ?? '—'}
                    </div>
                  </>
                )}
                {o.cancelledAt && (
                  <div className="text-stone-500">
                    Annulée le {formatDateTime(o.cancelledAt)} · {o.cancelledBy ?? '—'}
                  </div>
                )}
              </Td>
              <Td className="text-right">
                {o.status === 'ACTIVE' && access.canCancelOverride(o) && (
                  <Button variant="ghost" loading={cancel.isPending && cancel.variables?.id === o.id} onClick={() => reason.ask('Annuler l’autorisation', (r) => cancel.mutate({ id: o.id, reason: r }))}>
                    Annuler
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {reason.dialog}
      <Modal open={granting} onClose={() => setGranting(false)} title={`Dépassement de crédit — ${customer.name}`}>
        {granting && access.establishmentId && <OverrideForm customer={customer} establishmentId={access.establishmentId} onDone={() => setGranting(false)} />}
      </Modal>
    </div>
  );
}

function CustomerView({ id }: { id: string }) {
  const qc = useQueryClient();
  const access = useCustomerAccess();
  const [editing, setEditing] = useState(false);
  const { data: c, isLoading, error } = useQuery({ queryKey: ['customers', 'detail', id], queryFn: () => api.get<CustomerDetail>(`/customers/${id}`) });
  const toggle = useMutation({
    mutationFn: () => api.patch<CustomerDetail>(`/customers/${id}`, { isActive: !c!.isActive }),
    onSuccess: () => invalidate(qc),
  });
  if (isLoading) return <Spinner />;
  if (error || !c) return <Alert>{(error as ApiError | null)?.message ?? 'Client introuvable'}</Alert>;
  if (editing) return <CustomerForm initial={c} onDone={() => setEditing(false)} />;

  const info: [string, string | null][] = [
    ['Type', CUSTOMER_TYPES[c.type]],
    ['Téléphone', c.phone],
    ['Email', c.email],
    ['Adresse', c.address],
    ['N° contribuable', c.taxId],
    ['Créé le', `${formatDateTime(c.createdAt)}${c.createdBy ? ` par ${c.createdBy}` : ''}`],
  ];
  return (
    <div className="space-y-5">
      {toggle.error && <Alert>{(toggle.error as ApiError).message}</Alert>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {info.map(([label, v]) =>
            v ? (
              <div key={label}>
                <dt className="inline text-stone-500">{label} : </dt>
                <dd className="inline">{v}</dd>
              </div>
            ) : null,
          )}
          {!c.isActive && (
            <div>
              <Badge tone="red">Désactivé</Badge>
            </div>
          )}
          {c.notes && <div className="text-stone-600 sm:col-span-2">{c.notes}</div>}
        </dl>
        {access.manage && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Modifier
            </Button>
            <Button variant={c.isActive ? 'danger' : 'primary'} loading={toggle.isPending} onClick={() => toggle.mutate()}>
              {c.isActive ? 'Désactiver' : 'Réactiver'}
            </Button>
          </div>
        )}
      </div>
      <div className="space-y-2">
        <h3 className="font-semibold">Situation de crédit</h3>
        <CreditSection customer={c} establishmentId={access.establishmentId} />
      </div>
      <Overrides customer={c} />
    </div>
  );
}

function CustomersList() {
  const { manage } = useCustomerAccess();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Recherche envoyée après 300 ms sans frappe (même délai que CustomerPicker) : une requête par saisie, pas par caractère.
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (type) params.set('type', type);
  if (showInactive) params.set('includeInactive', 'true');
  const { data, isLoading, error } = useQuery({ queryKey: ['customers', 'list', params.toString()], queryFn: () => api.get<Customer[]>(`/customers?${params}`) });
  const opened = data?.find((c) => c.id === openId);

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle="Fichier commun au groupe ; crédit suivi au niveau du groupe"
        actions={
          manage && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Nouveau client
            </Button>
          )
        }
      />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input className="max-w-xs" placeholder="Rechercher (nom, téléphone, email)…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select className="w-48" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
            <option value="">Tous les types</option>
            {Object.entries(CUSTOMER_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Désactivés
          </label>
        </div>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Alert>{(error as ApiError).message}</Alert>
        ) : (
          // Liste : seulement les champs de GET /customers ; encours et disponible sont sur la fiche (établissement requis).
          <Table head={['Nom', 'Téléphone', 'Type', 'Statut', 'Plafond', '']} empty={data?.length === 0}>
            {data?.map((c) => (
              <tr key={c.id} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpenId(c.id)}>
                <Td className="font-medium">{c.name}</Td>
                <Td className="whitespace-nowrap">{c.phone ?? '—'}</Td>
                <Td>{CUSTOMER_TYPES[c.type]}</Td>
                <Td>{c.isActive ? <Badge tone="green">Actif</Badge> : <Badge tone="red">Désactivé</Badge>}</Td>
                <Td className="whitespace-nowrap">{c.creditLimit === null ? 'Aucun' : formatXOF(c.creditLimit)}</Td>
                <Td className="text-right text-brand-700">Voir</Td>
              </tr>
            ))}
          </Table>
        )}
        {data?.length === 200 && <p className="mt-2 text-xs text-stone-500">200 premiers clients affichés : affinez la recherche.</p>}
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} title="Nouveau client" wide>
        {creating && (
          <CustomerForm
            onDone={(c) => {
              setCreating(false);
              setOpenId(c.id);
            }}
          />
        )}
      </Modal>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title={opened?.name ?? 'Client'} wide>
        {openId && <CustomerView key={openId} id={openId} />}
      </Modal>
    </>
  );
}

/** Module 7 — Clients : fichier, conditions et situation de crédit, autorisations de dépassement. */
export function CustomersPage() {
  return (
    <RequirePermission permission="customers.view">
      <CustomersList />
    </RequirePermission>
  );
}
