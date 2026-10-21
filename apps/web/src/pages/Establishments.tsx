import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Establishment, ESTABLISHMENT_TYPES, EstablishmentType } from '../lib/types';

type FormState = Omit<Establishment, 'id' | 'modules'>;

const empty: FormState = {
  code: '',
  name: '',
  type: 'PATISSERIE',
  address: '',
  city: '',
  phone: '',
  email: '',
  receiptHeader: '',
  receiptFooter: '',
  isActive: true,
};

function EstablishmentForm({ initial, onDone }: { initial?: Establishment; onDone: () => void }) {
  const qc = useQueryClient();
  const { reload } = useAuth();
  // On ne reprend que les champs du formulaire (l'API refuse les champs inconnus).
  const [f, setF] = useState<FormState>(() =>
    initial ? (Object.fromEntries(Object.keys(empty).map((k) => [k, initial[k as keyof FormState] ?? ''])) as FormState) : empty,
  );
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      // En modification, un champ vidé est effacé (null) ; en création il est simplement omis.
      if (initial) {
        const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' ? null : v]));
        return api.patch(`/establishments/${initial.id}`, body, { noEstablishment: true });
      }
      const body = Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== '' && v !== null && k !== 'isActive'));
      return api.post('/establishments', body, { noEstablishment: true });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['establishments'] });
      await reload();
      onDone();
    },
  });

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
      className="space-y-3"
    >
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code" hint="2 à 6 caractères, ex. PLT">
          <Input required value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} maxLength={6} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Nom">
            <Input required value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
        </div>
      </div>
      <Field label="Type d'établissement" hint="Détermine les modules disponibles (restaurant, production…).">
        <Select value={f.type} onChange={(e) => set('type', e.target.value as EstablishmentType)}>
          {Object.entries(ESTABLISHMENT_TYPES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Adresse">
          <Input value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} />
        </Field>
        <Field label="Ville / commune">
          <Input value={f.city ?? ''} onChange={(e) => set('city', e.target.value)} placeholder="Abidjan Plateau" />
        </Field>
        <Field label="Téléphone">
          <Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} placeholder="+225 …" />
        </Field>
        <Field label="Email">
          <Input type="email" value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </Field>
      </div>
      <Field label="En-tête du ticket">
        <Textarea rows={2} value={f.receiptHeader ?? ''} onChange={(e) => set('receiptHeader', e.target.value)} />
      </Field>
      <Field label="Pied du ticket">
        <Textarea rows={2} value={f.receiptFooter ?? ''} onChange={(e) => set('receiptFooter', e.target.value)} placeholder="Merci de votre visite !" />
      </Field>
      {initial && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />
          Établissement actif
        </label>
      )}
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Enregistrer
        </Button>
      </div>
    </form>
  );
}

export function EstablishmentsPage() {
  const { me } = useAuth();
  const canManage = !!me?.globalPermissions.includes('establishments.manage');
  const [editing, setEditing] = useState<Establishment | 'new' | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['establishments'],
    queryFn: () => api.get<Establishment[]>('/establishments', { noEstablishment: true }),
  });

  return (
    <>
      <PageHeader
        title="Établissements"
        subtitle="Pâtisseries, boulangeries et restaurants du groupe"
        actions={
          canManage && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" /> Nouvel établissement
            </Button>
          )
        }
      />
      <Card>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Alert>{(error as ApiError).message}</Alert>
        ) : (
          <Table head={['Code', 'Nom', 'Type', 'Ville', 'Téléphone', 'Statut', '']} empty={data?.length === 0}>
            {data?.map((e) => (
              <tr key={e.id} className="hover:bg-stone-50">
                <Td className="font-mono font-semibold">{e.code}</Td>
                <Td>{e.name}</Td>
                <Td>{ESTABLISHMENT_TYPES[e.type]}</Td>
                <Td>{e.city ?? '—'}</Td>
                <Td>{e.phone ?? '—'}</Td>
                <Td>{e.isActive ? <Badge tone="green">Actif</Badge> : <Badge tone="red">Inactif</Badge>}</Td>
                <Td className="text-right">
                  {canManage && (
                    <Button variant="ghost" onClick={() => setEditing(e)}>
                      Modifier
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Nouvel établissement' : 'Modifier l’établissement'}>
        {editing && <EstablishmentForm initial={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </>
  );
}
