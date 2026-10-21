import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useCatalogAccess } from '../../lib/catalog-access';
import { Category, qty, RAW_MATERIAL_KINDS, RawMaterial, RawMaterialKind } from '../../lib/catalog-types';
import { formatXOF } from '../../lib/format';

const UNIT_LABEL = { KG: 'kg', L: 'L', U: 'unité' } as const;

function useRawCategories() {
  return useQuery({ queryKey: ['categories', 'raw', 'active'], queryFn: () => api.get<Category[]>('/raw-material-categories') });
}

/** Meilleur prix de référence par unité de base parmi les offres actives. */
function bestOffer(m: RawMaterial) {
  const priced = m.supplierProducts.filter((o) => o.pricePerBaseUnit !== null);
  if (priced.length === 0) return null;
  return priced.reduce((a, b) => (b.pricePerBaseUnit! < a.pricePerBaseUnit! ? b : a));
}

function RawMaterialForm({ initial, onDone }: { initial?: RawMaterial; onDone: (m: RawMaterial) => void }) {
  const qc = useQueryClient();
  const categories = useRawCategories();
  const [f, setF] = useState({
    code: initial?.code ?? '',
    name: initial?.name ?? '',
    categoryId: initial?.categoryId ?? '',
    kind: initial?.kind ?? ('INGREDIENT' as RawMaterialKind),
    baseUnitCode: initial?.baseUnitCode ?? ('KG' as RawMaterial['baseUnitCode']),
    isPerishable: initial?.isPerishable ?? false,
    trackLots: initial?.trackLots ?? true,
    description: initial?.description ?? '',
  });
  // Conditionnements saisis à la création (ensuite gérés un par un).
  const [packagings, setPackagings] = useState<{ name: string; quantity: string; isDefault: boolean }[]>([]);
  const unitLocked = !!initial && (initial.packagings.length > 0 || initial.supplierProducts.length > 0);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, categoryId: f.categoryId || null };
      if (initial) return api.patch<RawMaterial>(`/raw-materials/${initial.id}`, body, { noEstablishment: true });
      return api.post<RawMaterial>(
        '/raw-materials',
        { ...body, packagings: packagings.filter((p) => p.name).map((p) => ({ ...p, quantity: Number(p.quantity) })) },
        { noEstablishment: true },
      );
    },
    onSuccess: async (m) => {
      await qc.invalidateQueries({ queryKey: ['raw-materials'] });
      onDone(m);
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
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code" hint="Ex. FAR-T55">
          <Input required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Désignation" hint="Sans la marque : elle se renseigne sur l'offre fournisseur et le lot.">
            <Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Farine T55" />
          </Field>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Catégorie">
          <Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            <option value="">—</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Nature">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as RawMaterialKind })}>
            {Object.entries(RAW_MATERIAL_KINDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Unité de stock" hint={unitLocked ? 'Verrouillée : utilisée par des conditionnements ou offres.' : 'Le stock sera tenu dans cette unité.'}>
          <Select disabled={unitLocked} value={f.baseUnitCode} onChange={(e) => setF({ ...f, baseUnitCode: e.target.value as RawMaterial['baseUnitCode'] })}>
            <option value="KG">Kilogramme (kg)</option>
            <option value="L">Litre (L)</option>
            <option value="U">Unité / pièce</option>
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.isPerishable} onChange={(e) => setF({ ...f, isPerishable: e.target.checked })} />
          Périssable (date limite suivie)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.trackLots} onChange={(e) => setF({ ...f, trackLots: e.target.checked })} />
          Suivi par lot
        </label>
      </div>
      <Field label="Description">
        <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      {!initial && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-stone-700">Conditionnements (facultatif)</div>
          {packagings.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input className="max-w-[12rem]" placeholder="Sac 25 kg" value={p.name} onChange={(e) => setPackagings(packagings.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input
                className="max-w-[8rem]"
                type="number"
                step="any"
                min="0"
                placeholder="25"
                value={p.quantity}
                onChange={(e) => setPackagings(packagings.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
              />
              <span className="text-sm text-stone-500">{UNIT_LABEL[f.baseUnitCode]}</span>
              <label className="flex items-center gap-1 text-sm">
                <input type="radio" name="default-pack" checked={p.isDefault} onChange={() => setPackagings(packagings.map((x, j) => ({ ...x, isDefault: j === i })))} />
                par défaut
              </label>
            </div>
          ))}
          <Button type="button" variant="secondary" onClick={() => setPackagings([...packagings, { name: '', quantity: '', isDefault: packagings.length === 0 }])}>
            <Plus className="size-4" /> Conditionnement
          </Button>
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

function PackagingsEditor({ material }: { material: RawMaterial }) {
  const qc = useQueryClient();
  const { manageCatalog } = useCatalogAccess();
  const [draft, setDraft] = useState({ name: '', quantity: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['raw-materials'] });
  const add = useMutation({
    mutationFn: () => api.post(`/raw-materials/${material.id}/packagings`, { name: draft.name, quantity: Number(draft.quantity) }, { noEstablishment: true }),
    onSuccess: async () => {
      setDraft({ name: '', quantity: '' });
      await refresh();
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) => api.patch(`/raw-material-packagings/${id}`, body, { noEstablishment: true }),
    onSuccess: refresh,
  });
  const unit = UNIT_LABEL[material.baseUnitCode];
  const error = (add.error || patch.error) as ApiError | null;

  return (
    <div className="space-y-2">
      <h3 className="font-semibold">Conditionnements</h3>
      {error && <Alert>{error.message}</Alert>}
      <Table head={['Nom', 'Contenu', '', '']} empty={material.packagings.length === 0}>
        {material.packagings.map((p) => (
          <tr key={p.id} className={p.isActive ? '' : 'text-stone-400'}>
            <Td>{p.name}</Td>
            <Td>
              {qty(p.quantity)} {unit}
            </Td>
            <Td>{p.isDefault && <Badge tone="orange">Par défaut</Badge>}</Td>
            <Td className="whitespace-nowrap text-right">
              {manageCatalog && (
                <>
                  {!p.isDefault && p.isActive && (
                    <Button variant="ghost" onClick={() => patch.mutate({ id: p.id, body: { isDefault: true } })}>
                      Par défaut
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => patch.mutate({ id: p.id, body: { isActive: !p.isActive } })}>
                    {p.isActive ? 'Archiver' : 'Réactiver'}
                  </Button>
                </>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {manageCatalog && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Input className="max-w-[12rem]" required placeholder="Sac 50 kg" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Input className="max-w-[8rem]" required type="number" step="any" min="0" placeholder="50" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
          <span className="text-sm text-stone-500">{unit}</span>
          <Button type="submit" variant="secondary" loading={add.isPending}>
            Ajouter
          </Button>
        </form>
      )}
    </div>
  );
}

function RawMaterialDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { manageCatalog } = useCatalogAccess();
  const [editing, setEditing] = useState(false);
  const { data: m, isLoading } = useQuery({ queryKey: ['raw-materials', id], queryFn: () => api.get<RawMaterial>(`/raw-materials/${id}`) });
  const archive = useMutation({
    mutationFn: () => api.patch(`/raw-materials/${id}`, { isActive: !m!.isActive }, { noEstablishment: true }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['raw-materials'] });
      onClose();
    },
  });
  if (isLoading || !m) return <Spinner />;
  if (editing) return <RawMaterialForm initial={m} onDone={() => setEditing(false)} />;
  const unit = UNIT_LABEL[m.baseUnitCode];

  return (
    <div className="space-y-5">
      {archive.error && <Alert>{(archive.error as ApiError).message}</Alert>}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1 text-sm">
          <div>
            <span className="font-mono font-semibold">{m.code}</span> · {RAW_MATERIAL_KINDS[m.kind]} · {m.category?.name ?? 'Sans catégorie'}
          </div>
          <div className="text-stone-600">
            Stock tenu en <strong>{unit}</strong>
            {m.isPerishable && ' · périssable'}
            {m.trackLots && ' · suivi par lot'}
          </div>
          {m.description && <p className="text-stone-600">{m.description}</p>}
          {!m.isActive && <Badge tone="red">Archivée</Badge>}
        </div>
        {manageCatalog && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Modifier
            </Button>
            <Button variant={m.isActive ? 'danger' : 'primary'} loading={archive.isPending} onClick={() => archive.mutate()}>
              {m.isActive ? 'Archiver' : 'Réactiver'}
            </Button>
          </div>
        )}
      </div>
      <PackagingsEditor material={m} />
      <div className="space-y-2">
        <h3 className="font-semibold">Offres fournisseurs</h3>
        <p className="text-xs text-stone-500">Prix de référence négociés. Les offres se gèrent depuis la fiche du fournisseur.</p>
        <Table head={['Fournisseur', 'Marque', 'Unité d’achat', 'Prix', `Prix / ${unit}`, '']} empty={m.supplierProducts.length === 0}>
          {m.supplierProducts.map((o) => (
            <tr key={o.id}>
              <Td>{o.supplier?.name}</Td>
              <Td>{o.brand ?? '—'}</Td>
              <Td>
                {o.purchaseUnitLabel} ({qty(o.quantityPerPurchaseUnit)} {unit})
              </Td>
              <Td className="whitespace-nowrap">{formatXOF(o.unitPrice)}</Td>
              <Td className="whitespace-nowrap">{o.pricePerBaseUnit !== null ? formatXOF(o.pricePerBaseUnit) : '—'}</Td>
              <Td>{o.isPreferred && <Badge tone="green">Préférée</Badge>}</Td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  );
}

export function RawMaterialsPage() {
  const { manageCatalog } = useCatalogAccess();
  const categories = useRawCategories();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set('search', search.trim());
    if (categoryId) p.set('categoryId', categoryId);
    if (showArchived) p.set('includeInactive', 'true');
    return p.toString();
  }, [search, categoryId, showArchived]);
  const { data, isLoading, error } = useQuery({ queryKey: ['raw-materials', 'list', params], queryFn: () => api.get<RawMaterial[]>(`/raw-materials?${params}`) });
  const opened = data?.find((m) => m.id === openId);

  return (
    <>
      <PageHeader
        title="Matières premières"
        subtitle="Farines, sucres, beurres, emballages… avec leurs conditionnements et prix fournisseurs"
        actions={
          manageCatalog && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Nouvelle matière
            </Button>
          )
        }
      />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input className="max-w-xs" placeholder="Rechercher (nom ou code)…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select className="max-w-[14rem]" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Toutes catégories</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archivées
          </label>
        </div>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Alert>{(error as ApiError).message}</Alert>
        ) : (
          <Table head={['Code', 'Désignation', 'Catégorie', 'Unité', 'Conditionnement', 'Meilleur prix', '']} empty={data?.length === 0}>
            {data?.map((m) => {
              const best = bestOffer(m);
              const pack = m.packagings.find((p) => p.isDefault) ?? m.packagings[0];
              return (
                <tr key={m.id} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpenId(m.id)}>
                  <Td className="font-mono font-semibold">{m.code}</Td>
                  <Td>
                    {m.name} {!m.isActive && <Badge tone="red">Archivée</Badge>}
                  </Td>
                  <Td>{m.category?.name ?? '—'}</Td>
                  <Td>{UNIT_LABEL[m.baseUnitCode]}</Td>
                  <Td>{pack ? `${pack.name} (${qty(pack.quantity)} ${UNIT_LABEL[m.baseUnitCode]})` : '—'}</Td>
                  <Td className="whitespace-nowrap">
                    {best ? (
                      <>
                        {formatXOF(best.pricePerBaseUnit)} / {UNIT_LABEL[m.baseUnitCode]}
                        {pack && <div className="text-xs text-stone-500">soit {formatXOF(Math.round(best.pricePerBaseUnit! * Number(pack.quantity)))} / {pack.name}</div>}
                      </>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="text-right text-brand-700">Voir</Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} title="Nouvelle matière première" wide>
        {creating && (
          <RawMaterialForm
            onDone={(m) => {
              setCreating(false);
              setOpenId(m.id);
            }}
          />
        )}
      </Modal>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title={opened ? opened.name : 'Matière première'} wide>
        {openId && <RawMaterialDetail key={openId} id={openId} onClose={() => setOpenId(null)} />}
      </Modal>
    </>
  );
}
