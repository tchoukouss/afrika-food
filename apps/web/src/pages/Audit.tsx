import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Alert, Button, Card, Input, PageHeader, Spinner, Table, Td } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { AuditLog, Paged } from '../lib/types';

const ACTION_LABELS: Record<string, string> = {
  LOGIN: 'Connexion',
  LOGOUT: 'Déconnexion',
  PASSWORD_CHANGED: 'Mot de passe changé',
  USER_CREATED: 'Utilisateur créé',
  USER_UPDATED: 'Utilisateur modifié',
  USER_DEACTIVATED: 'Utilisateur désactivé',
  USER_REACTIVATED: 'Utilisateur réactivé',
  USER_ROLES_CHANGED: 'Rôles modifiés',
  USER_PASSWORD_RESET: 'Mot de passe réinitialisé',
  USER_UNLOCKED: 'Compte déverrouillé',
  ROLE_CREATED: 'Rôle créé',
  ROLE_UPDATED: 'Rôle modifié',
  ROLE_PERMISSIONS_CHANGED: 'Permissions modifiées',
  ROLE_DELETED: 'Rôle supprimé',
  ESTABLISHMENT_CREATED: 'Établissement créé',
  ESTABLISHMENT_UPDATED: 'Établissement modifié',
  ESTABLISHMENT_DEACTIVATED: 'Établissement désactivé',
  COMPANY_UPDATED: 'Entreprise modifiée',
};

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ action: '', from: '', to: '' });
  const [open, setOpen] = useState<string | null>(null);
  const params = new URLSearchParams({ page: String(page), pageSize: '50' });
  if (filters.action) params.set('action', filters.action);
  if (filters.from) params.set('from', new Date(filters.from).toISOString());
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59`).toISOString());

  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', params.toString()],
    queryFn: () => api.get<Paged<AuditLog>>(`/audit-logs?${params}`),
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const update = (k: keyof typeof filters, v: string) => {
    setFilters({ ...filters, [k]: v });
    setPage(1);
  };

  return (
    <>
      <PageHeader title="Journal d'audit" subtitle="Toutes les opérations sensibles, en lecture seule et non modifiables." />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <Input className="max-w-xs" placeholder="Action (ex. USER, ROLE…)" value={filters.action} onChange={(e) => update('action', e.target.value.toUpperCase())} />
          <Input className="max-w-[11rem]" type="date" value={filters.from} onChange={(e) => update('from', e.target.value)} aria-label="Du" />
          <Input className="max-w-[11rem]" type="date" value={filters.to} onChange={(e) => update('to', e.target.value)} aria-label="Au" />
        </div>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Alert>{(error as ApiError).message}</Alert>
        ) : (
          <>
            <Table head={['Date', 'Utilisateur', 'Action', 'Élément', 'Établissement', 'IP']} empty={data?.items.length === 0}>
              {data?.items.map((l) => (
                <Fragment key={l.id}>
                  <tr className="cursor-pointer hover:bg-stone-50" onClick={() => setOpen(open === l.id ? null : l.id)}>
                    <Td className="whitespace-nowrap">{formatDateTime(l.createdAt)}</Td>
                    <Td>{l.user?.fullName ?? 'Système'}</Td>
                    <Td className="font-medium">{ACTION_LABELS[l.action] ?? l.action}</Td>
                    <Td className="text-stone-500">
                      {l.entityType} <span className="font-mono text-xs">{l.entityId?.slice(0, 8)}</span>
                    </Td>
                    <Td>{l.establishment?.name ?? '—'}</Td>
                    <Td className="font-mono text-xs">{l.ipAddress ?? '—'}</Td>
                  </tr>
                  {open === l.id && (
                    <tr>
                      <td colSpan={6} className="bg-stone-50 px-4 py-3">
                        <div className="grid gap-3 text-xs md:grid-cols-2">
                          <div>
                            <div className="mb-1 font-semibold text-stone-600">Ancienne valeur</div>
                            <pre className="overflow-x-auto rounded bg-white p-2">{JSON.stringify(l.oldValues, null, 2) ?? '—'}</pre>
                          </div>
                          <div>
                            <div className="mb-1 font-semibold text-stone-600">Nouvelle valeur</div>
                            <pre className="overflow-x-auto rounded bg-white p-2">{JSON.stringify(l.newValues, null, 2) ?? '—'}</pre>
                          </div>
                          {l.reason && <div className="md:col-span-2">Motif : {l.reason}</div>}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </Table>
            <div className="mt-3 flex items-center justify-between text-sm text-stone-600">
              <span>{data?.total ?? 0} entrée(s)</span>
              <div className="flex items-center gap-2">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Précédent
                </Button>
                <span>
                  {page} / {pages}
                </span>
                <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  Suivant
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
