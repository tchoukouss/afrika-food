import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, PageHeader, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Company {
  name: string;
  legalName: string | null;
  taxId: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  currency: string;
}

const FIELDS: { key: keyof Company; label: string; type?: string }[] = [
  { key: 'name', label: 'Nom commercial' },
  { key: 'legalName', label: 'Raison sociale' },
  { key: 'taxId', label: 'N° compte contribuable (NCC)' },
  { key: 'phone', label: 'Téléphone' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'address', label: 'Adresse du siège' },
];

export function CompanyPage() {
  const qc = useQueryClient();
  const { reload } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['company'], queryFn: () => api.get<Company>('/company', { noEstablishment: true }) });
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) setF(Object.fromEntries(FIELDS.map(({ key }) => [key, (data[key] as string) ?? ''])));
  }, [data]);

  const save = useMutation({
    // Champ vidé → null (effacement), sauf le nom qui est obligatoire.
    mutationFn: () => api.patch('/company', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' && k !== 'name' ? null : v])), { noEstablishment: true }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['company'] });
      await reload();
    },
  });

  if (isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title="Entreprise" subtitle={`Devise : ${data?.currency ?? 'XOF'} (FCFA)`} />
      <Card className="max-w-2xl">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
          {save.isSuccess && <Alert tone="success">Informations enregistrées.</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map(({ key, label, type }) => (
              <Field key={key} label={label}>
                <Input type={type} required={key === 'name'} value={f[key] ?? ''} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
              </Field>
            ))}
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              Enregistrer
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
