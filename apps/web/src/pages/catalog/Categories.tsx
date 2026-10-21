import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useCatalogAccess } from '../../lib/catalog-access';
import type { Category } from '../../lib/catalog-types';

type Kind = 'raw' | 'product';
const ENDPOINT: Record<Kind, string> = { raw: '/raw-material-categories', product: '/product-categories' };

function CategoryForm({ kind, initial, onDone }: { kind: Kind; initial?: Category; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? '');
  const [sortOrder, setSortOrder] = useState(String(initial?.sortOrder ?? 0));
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name };
      if (kind === 'product') Object.assign(body, { color: color || null, sortOrder: Number(sortOrder) || 0 });
      return initial
        ? api.patch(`${ENDPOINT[kind]}/${initial.id}`, body, { noEstablishment: true })
        : api.post(ENDPOINT[kind], body, { noEstablishment: true });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['categories', kind] });
      onDone();
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <Field label="Nom">
        <Input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {kind === 'product' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Couleur (boutons de caisse)">
            <div className="flex gap-2">
              <input type="color" value={color || '#c2410c'} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 rounded border border-stone-300" />
              <Input value={color} placeholder="#C2410C" onChange={(e) => setColor(e.target.value)} />
            </div>
          </Field>
          <Field label="Ordre d'affichage">
            <Input type="number" min={0} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Enregistrer
        </Button>
      </div>
    </form>
  );
}

function CategoryList({ kind, title }: { kind: Kind; title: string }) {
  const qc = useQueryClient();
  const { manageCatalog } = useCatalogAccess();
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['categories', kind, 'all'],
    queryFn: () => api.get<Category[]>(`${ENDPOINT[kind]}?includeInactive=true`),
  });
  const toggle = useMutation({
    mutationFn: (c: Category) => api.patch(`${ENDPOINT[kind]}/${c.id}`, { isActive: !c.isActive }, { noEstablishment: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories', kind] }),
  });
  const count = (c: Category) => (kind === 'raw' ? c._count?.rawMaterials : c._count?.products) ?? 0;

  return (
    <Card
      title={title}
      actions={
        manageCatalog && (
          <Button variant="secondary" onClick={() => setEditing('new')}>
            <Plus className="size-4" /> Ajouter
          </Button>
        )
      }
    >
      {toggle.error && <Alert>{(toggle.error as ApiError).message}</Alert>}
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Alert>{(error as ApiError).message}</Alert>
      ) : (
        <Table head={['Nom', 'Articles', 'Statut', '']} empty={data?.length === 0}>
          {data?.map((c) => (
            <tr key={c.id}>
              <Td>
                <span className="flex items-center gap-2">
                  {c.color && <span className="size-3 rounded-full" style={{ background: c.color }} />}
                  {c.name}
                </span>
              </Td>
              <Td>{count(c)}</Td>
              <Td>{c.isActive ? <Badge tone="green">Active</Badge> : <Badge>Archivée</Badge>}</Td>
              <Td className="whitespace-nowrap text-right">
                {manageCatalog && (
                  <>
                    <Button variant="ghost" onClick={() => setEditing(c)}>
                      Modifier
                    </Button>
                    <Button variant="ghost" loading={toggle.isPending && toggle.variables?.id === c.id} onClick={() => toggle.mutate(c)}>
                      {c.isActive ? 'Archiver' : 'Réactiver'}
                    </Button>
                  </>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Nouvelle catégorie' : 'Modifier la catégorie'}>
        {editing && <CategoryForm kind={kind} initial={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </Card>
  );
}

export function CategoriesPage() {
  return (
    <>
      <PageHeader title="Catégories" subtitle="Classement des matières premières et des produits, commun à tout le groupe" />
      <div className="grid gap-4 lg:grid-cols-2">
        <CategoryList kind="raw" title="Matières premières" />
        <CategoryList kind="product" title="Produits" />
      </div>
    </>
  );
}
