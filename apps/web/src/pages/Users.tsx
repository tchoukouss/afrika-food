import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { Role, User } from '../lib/types';

type Assignment = { roleId: string; establishmentId: string | null };

/** Éditeur des rôles : un rôle peut être donné pour un établissement ou pour tout le groupe. */
function RolesEditor({ value, onChange }: { value: Assignment[]; onChange: (v: Assignment[]) => void }) {
  const { me } = useAuth();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
  const groupManager = !!me?.globalPermissions.includes('users.manage');
  const establishments = (me?.establishments ?? []).filter((e) => groupManager || e.permissions.includes('users.manage'));
  const defaultEst = groupManager ? null : establishments[0]?.id ?? null;

  return (
    <div className="space-y-2">
      {value.map((a, i) => (
        <div key={i} className="flex gap-2">
          <Select value={a.roleId} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)))}>
            <option value="">— Rôle —</option>
            {roles.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
          <Select
            value={a.establishmentId ?? ''}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, establishmentId: e.target.value || null } : x)))}
          >
            {groupManager && <option value="">Tous les établissements</option>}
            {establishments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.code} — {e.name}
              </option>
            ))}
          </Select>
          <Button type="button" variant="ghost" aria-label="Retirer" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={() => onChange([...value, { roleId: '', establishmentId: defaultEst }])}>
        <Plus className="size-4" /> Ajouter un rôle
      </Button>
    </div>
  );
}

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ email: '', fullName: '', phone: '', password: '' });
  const [roles, setRoles] = useState<Assignment[]>([]);
  const save = useMutation({
    mutationFn: () =>
      api.post('/users', { ...f, phone: f.phone || undefined, roles: roles.filter((r) => r.roleId) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['users'] });
      onDone();
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <Field label="Nom complet">
        <Input required value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email (identifiant)">
          <Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Téléphone">
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
      </div>
      <Field label="Mot de passe provisoire" hint="L'utilisateur devra le changer à sa première connexion.">
        <Input required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
      </Field>
      <div>
        <div className="mb-1 text-sm font-medium text-stone-700">Rôles</div>
        <RolesEditor value={roles} onChange={setRoles} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Créer l’utilisateur
        </Button>
      </div>
    </form>
  );
}

function EditUser({ user, onDone }: { user: User; onDone: () => void }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const isSelf = me?.id === user.id;
  const [f, setF] = useState({ fullName: user.fullName, email: user.email, phone: user.phone ?? '' });
  const [roles, setRoles] = useState<Assignment[]>(user.userRoles.map((r) => ({ roleId: r.role.id, establishmentId: r.establishmentId })));
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const ok = (m: string) => async () => {
    setMessage(m);
    await refresh();
  };

  const profile = useMutation({ mutationFn: () => api.patch(`/users/${user.id}`, { ...f, phone: f.phone || null }), onSuccess: ok('Profil enregistré.') });
  const saveRoles = useMutation({ mutationFn: () => api.put(`/users/${user.id}/roles`, { roles: roles.filter((r) => r.roleId) }), onSuccess: ok('Rôles enregistrés.') });
  const reset = useMutation({
    mutationFn: () => api.post(`/users/${user.id}/reset-password`, { password }),
    onSuccess: async () => {
      setPassword('');
      await ok('Mot de passe réinitialisé : l’utilisateur devra le changer à la prochaine connexion.')();
    },
  });
  const unlock = useMutation({ mutationFn: () => api.post(`/users/${user.id}/unlock`), onSuccess: ok('Compte déverrouillé.') });
  const toggle = useMutation({
    mutationFn: () => api.patch(`/users/${user.id}`, { isActive: !user.isActive }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const error = [profile, saveRoles, reset, unlock, toggle].find((m) => m.error)?.error as ApiError | undefined;
  const locked = user.lockedUntil && new Date(user.lockedUntil) > new Date();

  return (
    <div className="space-y-5">
      {error && <Alert>{error.message}</Alert>}
      {message && !error && <Alert tone="success">{message}</Alert>}

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          profile.mutate();
        }}
      >
        <h3 className="font-semibold">Profil</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Nom complet">
            <Input required value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Téléphone">
            <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
        </div>
        <Button type="submit" variant="secondary" loading={profile.isPending}>
          Enregistrer le profil
        </Button>
      </form>

      {!isSelf && (
        <div className="space-y-2">
          <h3 className="font-semibold">Rôles</h3>
          <RolesEditor value={roles} onChange={setRoles} />
          <Button variant="secondary" loading={saveRoles.isPending} onClick={() => saveRoles.mutate()}>
            Enregistrer les rôles
          </Button>
        </div>
      )}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          reset.mutate();
        }}
      >
        <h3 className="font-semibold">Réinitialiser le mot de passe</h3>
        <div className="flex gap-2">
          <Input placeholder="Nouveau mot de passe provisoire" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <Button type="submit" variant="secondary" loading={reset.isPending}>
            Réinitialiser
          </Button>
        </div>
      </form>

      {!isSelf && (
        <div className="flex flex-wrap gap-2 border-t border-stone-200 pt-4">
          {locked && (
            <Button variant="secondary" loading={unlock.isPending} onClick={() => unlock.mutate()}>
              Déverrouiller
            </Button>
          )}
          <Button variant={user.isActive ? 'danger' : 'primary'} loading={toggle.isPending} onClick={() => toggle.mutate()}>
            {user.isActive ? 'Désactiver le compte' : 'Réactiver le compte'}
          </Button>
        </div>
      )}
    </div>
  );
}

export function UsersPage() {
  const { canAnywhere } = useAuth();
  const canManage = canAnywhere('users.manage');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter((u) => !q || u.fullName.toLowerCase().includes(q) || u.email.includes(q));
  }, [data, search]);
  const editing = data?.find((u) => u.id === editingId);

  return (
    <>
      <PageHeader
        title="Utilisateurs"
        subtitle="Comptes, rôles par établissement et accès"
        actions={
          canManage && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Nouvel utilisateur
            </Button>
          )
        }
      />
      <Card>
        <Input placeholder="Rechercher par nom ou email…" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-3 max-w-sm" />
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Alert>{(error as ApiError).message}</Alert>
        ) : (
          <Table head={['Nom', 'Email', 'Rôles', 'Dernière connexion', 'Statut', '']} empty={filtered.length === 0}>
            {filtered.map((u) => (
              <tr key={u.id} className="hover:bg-stone-50">
                <Td className="font-medium">{u.fullName}</Td>
                <Td>{u.email}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {u.userRoles.map((r) => (
                      <Badge key={r.id} tone={r.establishment ? 'neutral' : 'orange'}>
                        {r.role.name} · {r.establishment?.code ?? 'Groupe'}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td className="whitespace-nowrap">{formatDateTime(u.lastLoginAt)}</Td>
                <Td>
                  {!u.isActive ? (
                    <Badge tone="red">Désactivé</Badge>
                  ) : u.lockedUntil && new Date(u.lockedUntil) > new Date() ? (
                    <Badge tone="red">Verrouillé</Badge>
                  ) : u.mustChangePassword ? (
                    <Badge tone="blue">Mot de passe provisoire</Badge>
                  ) : (
                    <Badge tone="green">Actif</Badge>
                  )}
                </Td>
                <Td className="text-right">
                  {canManage && (
                    <Button variant="ghost" onClick={() => setEditingId(u.id)}>
                      Gérer
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} title="Nouvel utilisateur" wide>
        {creating && <CreateUserForm onDone={() => setCreating(false)} />}
      </Modal>
      <Modal open={!!editing} onClose={() => setEditingId(null)} title={editing ? editing.fullName : ''} wide>
        {editing && <EditUser key={editing.id} user={editing} onDone={() => setEditingId(null)} />}
      </Modal>
    </>
  );
}
