import { Badge, Card, PageHeader } from '../components/ui';
import { useAuth } from '../lib/auth';
import { ESTABLISHMENT_TYPES } from '../lib/types';

// Accueil : uniquement des informations réelles. Le tableau de bord direction
// (CA, stock critique, créances…) sera branché avec les modules Ventes et Stock.
export function HomePage() {
  const { me, establishmentId } = useAuth();
  if (!me) return null;
  const current = me.establishments.find((e) => e.id === establishmentId);

  return (
    <>
      <PageHeader title={`Bonjour ${me.fullName.split(' ')[0]}`} subtitle={current ? `${current.name} (${current.code})` : 'Vue groupe'} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Mes établissements">
          {me.establishments.length === 0 ? (
            <p className="text-sm text-stone-500">Aucun établissement actif pour le moment.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {me.establishments.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 py-2">
                  <div>
                    <div className="font-medium">{e.name}</div>
                    <div className="text-xs text-stone-500">
                      {e.code} · {ESTABLISHMENT_TYPES[e.type]}
                      {e.city ? ` · ${e.city}` : ''}
                    </div>
                  </div>
                  {e.id === establishmentId && <Badge tone="orange">Actif</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Mes droits">
          <p className="mb-2 text-sm text-stone-600">
            {me.globalPermissions.length > 0
              ? `${me.globalPermissions.length} permissions valables sur tout le groupe.`
              : 'Droits limités aux établissements attribués.'}
          </p>
          <div className="flex flex-wrap gap-1">
            {(current?.permissions ?? me.globalPermissions).map((p) => (
              <Badge key={p}>{p}</Badge>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
