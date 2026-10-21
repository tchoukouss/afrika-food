import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Permission, Role } from '../lib/types';

function PermissionMatrix({ catalog, value, onChange, readOnly }: { catalog: Permission[]; value: Set<string>; onChange: (v: Set<string>) => void; readOnly: boolean }) {
  const modules = useMemo(() => {
    const map = new Map<string, Permission[]>();
    catalog.forEach((p) => map.set(p.module, [...(map.get(p.module) ?? []), p]));
    return [...map.entries()];
  }, [catalog]);
  const toggle = (code: string) => {
    const next = new Set(value);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange(next);
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {modules.map(([module, perms]) => (
        <fieldset key={module} className="rounded-lg border border-stone-200 p-3">
          <legend className="px-1 text-sm font-semibold text-brand-700">{module}</legend>
          {perms.map((p) => (
            <label key={p.code} className="flex items-start gap-2 py-0.5 text-sm">
              <input type="checkbox" className="mt-0.5" disabled={readOnly} checked={value.has(p.code)} onChange={() => toggle(p.code)} />
              <span>{p.label}</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

export function RolesPage() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const canManage = !!me?.globalPermissions.includes('roles.manage');
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
  const catalog = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Permission[]>('/permissions') });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = roles.data?.find((r) => r.id === selectedId) ?? roles.data?.[0];
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState({ name: '', description: '' });
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ code: '', name: '', description: '' });

  useEffect(() => {
    if (selected) {
      setPerms(new Set(selected.permissions));
      setMeta({ name: selected.name, description: selected.description ?? '' });
    }
  }, [selected]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['roles'] });
  const save = useMutation({
    mutationFn: () => api.patch(`/roles/${selected!.id}`, { ...meta, permissions: [...perms] }, { noEstablishment: true }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/roles/${selected!.id}`, { noEstablishment: true }),
    onSuccess: async () => {
      setSelectedId(null);
      await refresh();
    },
  });
  const create = useMutation({
    mutationFn: () => api.post<Role>('/roles', { ...newRole, description: newRole.description || undefined, permissions: [] }, { noEstablishment: true }),
    onSuccess: async (r) => {
      await refresh();
      setSelectedId(r.id);
      setCreating(false);
      setNewRole({ code: '', name: '', description: '' });
    },
  });

  if (roles.isLoading || catalog.isLoading) return <Spinner />;
  if (roles.error) return <Alert>{(roles.error as ApiError).message}</Alert>;

  return (
    <>
      <PageHeader
        title="Rôles & permissions"
        subtitle="Un rôle regroupe des permissions ; il est attribué à un utilisateur pour un établissement ou pour tout le groupe."
        actions={
          canManage && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Nouveau rôle
            </Button>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card>
          <ul className="-m-2 space-y-1">
            {roles.data?.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${r.id === selected?.id ? 'bg-brand-100 font-semibold text-brand-800' : 'hover:bg-stone-100'}`}
                >
                  <span>{r.name}</span>
                  <span className="text-xs text-stone-500">{r.assignmentCount}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {selected && (
          <Card
            title={
              <span className="flex items-center gap-2">
                {selected.name} {selected.isSystem && <Badge>Système</Badge>}
              </span>
            }
            actions={
              canManage && (
                <>
                  {!selected.isSystem && (
                    <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()} disabled={selected.assignmentCount > 0} title={selected.assignmentCount > 0 ? 'Rôle encore attribué' : undefined}>
                      Supprimer
                    </Button>
                  )}
                  <Button loading={save.isPending} onClick={() => save.mutate()}>
                    Enregistrer
                  </Button>
                </>
              )
            }
          >
            <div className="space-y-4">
              {(save.error || remove.error) && <Alert>{((save.error || remove.error) as ApiError).message}</Alert>}
              {save.isSuccess && <Alert tone="success">Rôle enregistré. Le changement est tracé dans le journal d’audit.</Alert>}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Nom">
                  <Input disabled={!canManage} value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
                </Field>
                <Field label="Description">
                  <Input disabled={!canManage} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
                </Field>
              </div>
              <p className="text-sm text-stone-500">
                {perms.size} permission(s) sélectionnée(s) · code <span className="font-mono">{selected.code}</span>
              </p>
              <PermissionMatrix catalog={catalog.data ?? []} value={perms} onChange={setPerms} readOnly={!canManage} />
            </div>
          </Card>
        )}
      </div>
      <Modal open={creating} onClose={() => setCreating(false)} title="Nouveau rôle">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          {create.error && <Alert>{(create.error as ApiError).message}</Alert>}
          <Field label="Code" hint="Majuscules et _ , ex. CHEF_PATISSIER">
            <Input required value={newRole.code} onChange={(e) => setNewRole({ ...newRole, code: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Nom">
            <Input required value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} />
          </Field>
          <Field label="Description">
            <Input value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} />
          </Field>
          <p className="text-xs text-stone-500">Les permissions se cochent ensuite dans la matrice.</p>
          <div className="flex justify-end">
            <Button type="submit" loading={create.isPending}>
              Créer
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
