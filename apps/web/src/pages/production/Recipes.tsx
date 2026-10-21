import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Product, qty, Unit } from '../../lib/catalog-types';
import { formatDateTime, formatXOF } from '../../lib/format';
import { COST_SOURCES, RecipeListRow, RecipeRec, RecipeVersionRec, VersionCost } from '../../lib/production-types';
import { unitLabel } from '../../lib/stock-types';
import { ItemSelect, itemPayload, PickableItem, RequirePermission, useStockItems } from '../stock/shared';

const VERSION_STATUS = {
  DRAFT: <Badge tone="orange">Brouillon</Badge>,
  ACTIVE: <Badge tone="green">Active</Badge>,
  ARCHIVED: <Badge>Archivée</Badge>,
};

const invalidate = (qc: ReturnType<typeof useQueryClient>) => Promise.all(['recipes', 'costing'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

function useUnits() {
  return useQuery({ queryKey: ['units'], queryFn: () => api.get<Unit[]>('/units'), staleTime: Infinity });
}

/** Recettes : écriture réservée au niveau groupe (décision G). */
function useCanManageRecipes() {
  const { me } = useAuth();
  return !!me?.globalPermissions.includes('recipes.manage');
}

interface LineState {
  item: PickableItem | null;
  quantity: string;
  unitCode: string;
  lossPercent: string;
}

function RecipeEditor({ recipe, version, onDone }: { recipe?: RecipeRec; version?: RecipeVersionRec; onDone: (r: RecipeRec) => void }) {
  const qc = useQueryClient();
  const units = useUnits();
  const { items } = useStockItems();
  const products = useQuery({ queryKey: ['products', 'list', 'manufactured'], queryFn: () => api.get<Product[]>('/products?type=MANUFACTURED'), enabled: !recipe });
  const recipes = useQuery({ queryKey: ['recipes', 'list'], queryFn: () => api.get<RecipeListRow[]>('/recipes'), enabled: !recipe });
  const [productId, setProductId] = useState(recipe?.productId ?? '');
  const [f, setF] = useState({
    yieldQuantity: version ? String(Number(version.yieldQuantity)) : '',
    shelfLifeDays: version?.shelfLifeDays != null ? String(version.shelfLifeDays) : '',
    instructions: version?.instructions ?? '',
    notes: version?.notes ?? '',
  });
  const [lines, setLines] = useState<LineState[]>(() =>
    version
      ? version.items.map((i) => ({
          item: items.find((x) => (i.rawMaterialId ? x.rawMaterialId === i.rawMaterialId : x.productId === i.productId)) ?? {
            key: i.rawMaterialId ? `r:${i.rawMaterialId}` : `p:${i.productId}`,
            rawMaterialId: i.rawMaterialId,
            productId: i.productId,
            code: i.item?.code ?? '',
            name: i.item?.name ?? '',
            unit: i.item?.unit ?? '',
            isPerishable: false,
          },
          quantity: String(Number(i.quantity)),
          unitCode: i.unitCode,
          lossPercent: Number(i.lossPercent) ? String(Number(i.lossPercent)) : '',
        }))
      : [{ item: null, quantity: '', unitCode: '', lossPercent: '' }],
  );
  const setLine = (i: number, patch: Partial<LineState>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const unitsFor = (itemUnit?: string) => {
    const dim = units.data?.find((u) => u.code === itemUnit)?.dimension;
    return (units.data ?? []).filter((u) => !dim || u.dimension === dim);
  };
  const available = (products.data ?? []).filter((p) => p.isActive && !recipes.data?.some((r) => r.product?.id === p.id));
  const saleUnit = recipe?.product?.saleUnitCode ?? products.data?.find((p) => p.id === productId)?.saleUnitCode;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        yieldQuantity: Number(f.yieldQuantity),
        shelfLifeDays: f.shelfLifeDays === '' ? null : Number(f.shelfLifeDays),
        instructions: f.instructions || null,
        notes: f.notes || null,
        items: lines
          .filter((l) => l.item)
          .map((l) => ({ ...itemPayload(l.item), quantity: Number(l.quantity), unitCode: l.unitCode, lossPercent: l.lossPercent === '' ? 0 : Number(l.lossPercent) })),
      };
      return version ? api.patch<RecipeRec>(`/recipe-versions/${version.id}`, body, { noEstablishment: true }) : api.post<RecipeRec>('/recipes', { ...body, productId }, { noEstablishment: true });
    },
    onSuccess: async (r) => {
      await invalidate(qc);
      onDone(r);
    },
  });

  return (
    <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        {!recipe && (
          <Field label="Produit fabriqué">
            <Select required value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">—</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={`Rendement (${unitLabel(saleUnit) || 'unité de vente'})`} hint="Quantité obtenue avec ces ingrédients">
          <Input required type="number" min="0" step="any" value={f.yieldQuantity} onChange={(e) => setF({ ...f, yieldQuantity: e.target.value })} />
        </Field>
        <Field label="Conservation (jours)" hint="Fixe la péremption du lot produit">
          <Input type="number" min="0" max="3650" step="1" value={f.shelfLifeDays} onChange={(e) => setF({ ...f, shelfLifeDays: e.target.value })} />
        </Field>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium text-stone-700">Ingrédients</div>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <div className="min-w-[14rem] flex-1">
              <ItemSelect
                required
                items={items}
                value={l.item?.key ?? ''}
                onChange={(item) => setLine(i, { item, unitCode: item ? (item.unit === 'KG' ? 'G' : item.unit === 'L' ? 'ML' : item.unit) : '' })}
              />
            </div>
            <Input className="w-24" required type="number" min="0" step="any" placeholder="Qté" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
            <Select className="w-24" required value={l.unitCode} onChange={(e) => setLine(i, { unitCode: e.target.value })} aria-label="Unité">
              <option value="">—</option>
              {unitsFor(l.item?.unit).map((u) => (
                <option key={u.code} value={u.code}>
                  {u.symbol}
                </option>
              ))}
            </Select>
            <Input className="w-24" type="number" min="0" max="99.99" step="any" placeholder="Perte %" value={l.lossPercent} onChange={(e) => setLine(i, { lossPercent: e.target.value })} />
            <Button type="button" variant="ghost" aria-label="Retirer" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="secondary" onClick={() => setLines([...lines, { item: null, quantity: '', unitCode: '', lossPercent: '' }])}>
          <Plus className="size-4" /> Ingrédient
        </Button>
        <p className="text-xs text-stone-500">Un produit fabriqué peut servir de sous-préparation (pâte, crème…) ; les boucles sont refusées.</p>
      </div>
      <Field label="Mode opératoire">
        <Textarea rows={3} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
      </Field>
      <Field label="Notes de version">
        <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          {version ? 'Enregistrer le brouillon' : 'Créer la recette (brouillon)'}
        </Button>
      </div>
    </form>
  );
}

function CostCard({ versionId, saleUnit }: { versionId: string; saleUnit?: string }) {
  const { establishmentId, me } = useAuth();
  const current = me?.establishments.find((e) => e.id === establishmentId);
  const { data, isLoading, error } = useQuery({
    queryKey: ['recipes', 'cost', versionId, establishmentId],
    queryFn: () => api.get<VersionCost>(`/recipe-versions/${versionId}/cost${establishmentId ? `?establishmentId=${establishmentId}` : ''}`),
  });
  if (isLoading) return <Spinner />;
  if (error) return <Alert>{(error as ApiError).message}</Alert>;
  if (!data) return null;
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">Coût de revient {current ? `— ${current.name}` : '(derniers prix d’achat)'}</h3>
      {!data.complete && <Alert>Coût incomplet : au moins un ingrédient n’a aucun prix connu.</Alert>}
      <Table head={['Ingrédient', 'Recette', 'Perte', 'À sortir du stock', 'Coût unitaire', 'Coût', 'Base']}>
        {data.lines.map((l) => (
          <tr key={l.itemId}>
            <Td>{l.name}</Td>
            <Td className="whitespace-nowrap">
              {qty(l.quantity)} {unitLabel(l.unitCode)}
            </Td>
            <Td>{Number(l.lossPercent) ? `${qty(l.lossPercent)} %` : '—'}</Td>
            <Td className="whitespace-nowrap">
              {qty(l.stockQuantity)} {unitLabel(l.stockUnit)}
            </Td>
            <Td className="whitespace-nowrap">{l.unitCost ? `${formatXOF(Math.round(Number(l.unitCost) * 100) / 100)} / ${unitLabel(l.stockUnit)}` : '—'}</Td>
            <Td className="whitespace-nowrap font-semibold">{l.cost ? formatXOF(Math.round(Number(l.cost))) : '—'}</Td>
            <Td className="text-xs text-stone-500">{COST_SOURCES[l.source] ?? l.source}</Td>
          </tr>
        ))}
      </Table>
      <div className="grid gap-2 text-sm sm:grid-cols-4">
        <div className="rounded-lg bg-stone-50 p-3">
          <div className="text-stone-500">Coût total (rendement {qty(data.yieldQuantity)} {unitLabel(saleUnit)})</div>
          <div className="text-lg font-bold">{formatXOF(Math.round(Number(data.totalCost)))}</div>
        </div>
        <div className="rounded-lg bg-stone-50 p-3">
          <div className="text-stone-500">Coût par {unitLabel(saleUnit) || 'unité'}</div>
          <div className="text-lg font-bold">{data.unitCost ? formatXOF(Math.round(Number(data.unitCost) * 100) / 100) : '—'}</div>
        </div>
        <div className="rounded-lg bg-stone-50 p-3">
          <div className="text-stone-500">Prix de vente</div>
          <div className="text-lg font-bold">{data.priceTtc ? formatXOF(data.priceTtc) : 'Sans prix'}</div>
          {data.priceHt && <div className="text-xs text-stone-500">HT {formatXOF(Math.round(Number(data.priceHt)))}</div>}
        </div>
        <div className={`rounded-lg p-3 ${data.margin && Number(data.margin) < 0 ? 'bg-red-50' : 'bg-green-50'}`}>
          <div className="text-stone-500">Marge (sur HT)</div>
          <div className="text-lg font-bold">{data.margin ? formatXOF(Math.round(Number(data.margin))) : '—'}</div>
          {data.marginRate && <div className="text-xs">{qty(data.marginRate)} %</div>}
        </div>
      </div>
    </div>
  );
}

function RecipeDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const canManage = useCanManageRecipes();
  const [confirm, setConfirm] = useState(false);
  const { data: r, isLoading } = useQuery({ queryKey: ['recipes', id], queryFn: () => api.get<RecipeRec>(`/recipes/${id}`) });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const act = useMutation({
    mutationFn: ({ url }: { url: string }) => api.post<RecipeRec>(url, undefined, { noEstablishment: true }),
    onSuccess: async (rec) => {
      setConfirm(false);
      await invalidate(qc);
      setSelected(rec.versions[0]?.id ?? null);
    },
  });
  if (isLoading || !r) return <Spinner />;
  const version = r.versions.find((v) => v.id === selected) ?? r.versions.find((v) => v.status === 'ACTIVE') ?? r.versions[0];
  const hasDraft = r.versions.some((v) => v.status === 'DRAFT');
  if (editing && version.status === 'DRAFT') return <RecipeEditor recipe={r} version={version} onDone={() => setEditing(false)} />;

  return (
    <div className="space-y-5">
      {act.error && <Alert>{(act.error as ApiError).message}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        {r.versions.map((v) => (
          <button
            key={v.id}
            onClick={() => setSelected(v.id)}
            className={`rounded-lg border px-3 py-1 text-sm ${v.id === version.id ? 'border-brand-600 bg-brand-50 font-semibold' : 'border-stone-200 hover:bg-stone-50'}`}
          >
            v{v.version} {VERSION_STATUS[v.status]}
          </button>
        ))}
        {canManage && !hasDraft && (
          <Button variant="secondary" loading={act.isPending} onClick={() => act.mutate({ url: `/recipes/${r.id}/versions` })}>
            <Plus className="size-4" /> Nouvelle version
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
        <div className="space-y-1">
          <div>
            Version {version.version} {VERSION_STATUS[version.status]} · rendement <strong>{qty(version.yieldQuantity)} {unitLabel(r.product?.saleUnitCode)}</strong>
            {version.shelfLifeDays != null && ` · conservation ${version.shelfLifeDays} j`}
          </div>
          <div className="text-xs text-stone-500">
            Créée par {version.createdBy} le {formatDateTime(version.createdAt)}
            {version.activatedAt && ` · activée par ${version.activatedBy} le ${formatDateTime(version.activatedAt)}`}
            {version.archivedAt && ` · archivée le ${formatDateTime(version.archivedAt)}`}
          </div>
          {version.notes && <div className="text-stone-600">{version.notes}</div>}
        </div>
        {canManage && version.status === 'DRAFT' && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Modifier
            </Button>
            <Button loading={act.isPending} onClick={() => act.mutate({ url: `/recipe-versions/${version.id}/activate` })}>
              Activer
            </Button>
            <Button variant={confirm ? 'danger' : 'ghost'} onClick={() => (confirm ? act.mutate({ url: `/recipe-versions/${version.id}/archive` }) : setConfirm(true))}>
              {confirm ? 'Confirmer l’abandon' : 'Abandonner'}
            </Button>
          </div>
        )}
        {canManage && version.status === 'ACTIVE' && (
          <Button variant={confirm ? 'danger' : 'ghost'} onClick={() => (confirm ? act.mutate({ url: `/recipe-versions/${version.id}/archive` }) : setConfirm(true))}>
            {confirm ? 'Confirmer : plus aucune production possible' : 'Retirer la version active'}
          </Button>
        )}
      </div>
      {version.status !== 'DRAFT' && <p className="text-xs text-stone-500">Version publiée : figée. Pour la modifier, créez une nouvelle version.</p>}
      {version.instructions && (
        <div className="rounded-lg bg-stone-50 p-3 text-sm whitespace-pre-line">
          <div className="mb-1 font-semibold">Mode opératoire</div>
          {version.instructions}
        </div>
      )}
      <CostCard versionId={version.id} saleUnit={r.product?.saleUnitCode} />
    </div>
  );
}

export function RecipesPage() {
  const canManage = useCanManageRecipes();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ['recipes', 'list'], queryFn: () => api.get<RecipeListRow[]>('/recipes') });
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (data ?? []).filter((r) => !s || r.product?.name.toLowerCase().includes(s) || r.product?.code.toLowerCase().includes(s));
  }, [data, search]);
  const opened = data?.find((r) => r.id === openId);

  return (
    <>
      <PageHeader
        title="Recettes"
        subtitle="Fiches techniques versionnées, communes au groupe"
        actions={
          canManage && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Nouvelle recette
            </Button>
          )
        }
      />
      <RequirePermission permission="recipes.view">
        <Card>
          <Input className="mb-3 max-w-xs" placeholder="Rechercher un produit…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {isLoading ? (
            <Spinner />
          ) : error ? (
            <Alert>{(error as ApiError).message}</Alert>
          ) : (
            <Table head={['Produit', 'Version active', 'Rendement', 'Ingrédients', 'Versions', '']} empty={rows.length === 0}>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpenId(r.id)}>
                  <Td>
                    <div className="font-medium">{r.product?.name}</div>
                    <div className="font-mono text-xs text-stone-500">{r.product?.code}</div>
                  </Td>
                  <Td>{r.activeVersion ? `v${r.activeVersion.version}` : <Badge tone="red">Aucune</Badge>}</Td>
                  <Td>{r.activeVersion ? `${qty(r.activeVersion.yieldQuantity)} ${unitLabel(r.product?.saleUnitCode)}` : '—'}</Td>
                  <Td>{r.activeVersion?.items ?? '—'}</Td>
                  <Td>
                    {r.versions} {r.hasDraft && <Badge tone="orange">Brouillon</Badge>}
                  </Td>
                  <Td className="text-right text-brand-700">Voir</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </RequirePermission>
      <Modal open={creating} onClose={() => setCreating(false)} title="Nouvelle recette" wide>
        {creating && (
          <RecipeEditor
            onDone={(r) => {
              setCreating(false);
              setOpenId(r.id);
            }}
          />
        )}
      </Modal>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title={opened?.product?.name ?? 'Recette'} wide>
        {openId && <RecipeDetail key={openId} id={openId} />}
      </Modal>
    </>
  );
}
