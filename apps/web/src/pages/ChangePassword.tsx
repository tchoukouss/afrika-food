import { FormEvent, useState } from 'react';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function ChangePasswordPage({ forced }: { forced?: boolean }) {
  const { reload, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError('Les deux mots de passe ne correspondent pas.');
    setLoading(true);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next }, { noEstablishment: true });
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur');
    } finally {
      setLoading(false);
    }
  }

  const form = (
    <form onSubmit={submit} className="space-y-4">
      {forced && <Alert tone="info">Première connexion : choisissez votre mot de passe personnel.</Alert>}
      {error && <Alert>{error}</Alert>}
      {done && !forced && <Alert tone="success">Mot de passe modifié. Vos autres appareils ont été déconnectés.</Alert>}
      <Field label="Mot de passe actuel">
        <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="Nouveau mot de passe" hint="8 caractères minimum, avec au moins une lettre et un chiffre.">
        <Input type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Confirmer le nouveau mot de passe">
        <Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" loading={loading}>
          Enregistrer
        </Button>
        {forced && (
          <Button type="button" variant="ghost" onClick={logout}>
            Déconnexion
          </Button>
        )}
      </div>
    </form>
  );

  if (forced) {
    return (
      <div className="flex min-h-full items-center justify-center bg-stone-100 p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <div className="mb-4 text-center text-xl font-extrabold text-brand-700">AFRIKA FOOD</div>
          {form}
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-md">
      <Card title="Changer mon mot de passe">{form}</Card>
    </div>
  );
}
