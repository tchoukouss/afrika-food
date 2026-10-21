import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCatalogAccess } from '../../lib/catalog-access';
import { Category, PriceHistoryRow, Product, PRODUCT_TYPES, ProductDetail, ProductType, qty, Unit } from '../../lib/catalog-types';
import { formatDateTime, formatXOF } from '../../lib/format';

const TYPE_TONE: Record<ProductType, 'orange' | 'blue' | 'green'> = { MANUFACTURED: 'orange', RESOLD: 'blue', MENU: 'green' };

const invalidateProducts = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ queryKey: ['products'] });

function ProductForm({ initial, onDone }: { initial?: ProductDetail; onDone: (p: ProductDetail) => void }) {
  const qc = useQueryClient();
  const { manageBasePrice } = useCatalogAccess();
  const categories = useQuery({ queryKey: ['categories', 'product', 'active'], queryFn: () => api.get<Category[]>('/product-categories') });
  const units = useQuery({ queryKey: ['units'], queryFn: () => api.get<Unit[]>('/units'), staleTime: Infinity });
  const [f, setF] = useState({
    code: initial?.code ?? '',
    name: initial?.name ?? '',
    categoryId: initial?.categoryId ?? '',
    type: initial?.type ?? ('MANUFACTURED' as ProductType),
    saleUnitCode: initial?.saleUnitCode ?? 'U',
    barcode: initial?.barcode ?? '',
    taxRate: initial ? String(Number(initial.taxRate)) : '0',
    imageUrl: initial?.imageUrl ?? '',
    description: initial?.description ?? '',
    basePrice: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = useMutation({
    mutationFn: () => {
      const { basePrice, ...rest } = f;
      const body = { ...rest, categoryId: f.categoryId || null, taxRate: Number(f.taxRate) || 0 };
      if (initial) return api.patch<ProductDetail>(`/products/${initial.id}`, body, { noEstablishment: true });
      return api.post<ProductDetail>('/products', { ...body, ...(basePrice !== '' ? { basePrice: Number(basePrice) } : {}) }, { noEstablishment: true });
    },
    onSuccess: async (p) => {
      await invalidateProducts(qc);
      onDone(p);
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
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code" hint="Ex. CRO-BEURRE">
          <Input required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Nom">
            <Input required minLength={2} value={f.name} onChange={set('name')} />
          </Field>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type">
          <Select value={f.type} onChange={set('type')}>
            {Object.entries(PRODUCT_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Catégorie">
          <Select value={f.categoryId} onChange={set('categoryId')}>
            <option value="">—</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Vendu à">
          <Select value={f.saleUnitCode} onChange={set('saleUnitCode')}>
            {units.data?.map((u) => (
              <option key={u.code} value={u.code}>
                {u.code === 'U' ? "l'unité / la pièce" : `${u.name.toLowerCase()} (${u.symbol})`}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code-barres">
          <Input value={f.barcode} onChange={set('barcode')} />
        </Field>
        <Field label="TVA incluse (%)" hint="0 si l'entreprise n'est pas assujettie">
          <Input type="number" min={0} max={100} step="0.01" value={f.taxRate} onChange={set('taxRate')} />
        </Field>
        {!initial && manageBasePrice && (
          <Field label="Prix de vente TTC (FCFA)" hint="Prix de base du groupe">
            <Input type="number" min={0} step={1} value={f.basePrice} onChange={set('basePrice')} />
          </Field>
        )}
      </div>
      <Field label="Photo (URL)">
        <Input type="url" value={f.imageUrl} onChange={set('imageUrl')} placeholder="https://…" />
      </Field>
      <Field label="Description">
        <Textarea rows={2} value={f.description} onChange={set('description')} />
      </Field>
      {f.type === 'MANUFACTURED' && <p className="text-xs text-stone-500">La recette et le coût de revient seront rattachés au module 4 (recettes & production).</p>}
      {f.type === 'MENU' && !initial && <p className="text-xs text-stone-500">La composition du menu se définit ensuite dans sa fiche.</p>}
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Enregistrer
        </Button>
      </div>
    </form>
  );
}

function PriceEditor({ label, current, onSave, onRemove, loading }: { label?: string; current: string | null; onSave: (price: number, reason: string) => void; onRemove?: () => void; loading: boolean }) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(current ?? '');
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <span className="flex flex-wrap gap-1">
        <Button variant="ghost" onClick={() => setOpen(true)}>
          {label ?? 'Modifier'}
        </Button>
        {onRemove && (
          <Button variant="ghost" loading={loading} onClick={onRemove}>
            Retirer
          </Button>
        )}
      </span>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(Number(price), reason);
        setOpen(false);
      }}
    >
      <Input className="w-28" required type="number" min={0} step={1} value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
      <Input className="w-40" placeholder="Motif (facultatif)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button type="submit" variant="secondary" loading={loading}>
        OK
      </Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
        Annuler
      </Button>
    </form>
  );
}

function PricesSection({ product }: { product: ProductDetail }) {
  const qc = useQueryClient();
  const { manageBasePrice, canLocalPrice, canAvailability } = useCatalogAccess();
  const [showHistory, setShowHistory] = useState(false);
  const history = useQuery({
    queryKey: ['products', product.id, 'history'],
    queryFn: () => api.get<PriceHistoryRow[]>(`/products/${product.id}/price-history`),
    enabled: showHistory,
  });
  const done = () => invalidateProducts(qc);
  const setPrice = useMutation({
    mutationFn: (b: { price: number; reason: string; establishmentId: string | null }) =>
      api.put(`/products/${product.id}/price`, { ...b, reason: b.reason || null }, { noEstablishment: true }),
    onSuccess: done,
  });
  const removeLocal = useMutation({
    mutationFn: (estId: string) => api.delete(`/products/${product.id}/price/${estId}`, { noEstablishment: true }),
    onSuccess: done,
  });
  const availability = useMutation({
    mutationFn: (b: { establishmentId: string; isAvailable: boolean }) => api.put(`/products/${product.id}/availability`, b, { noEstablishment: true }),
    onSuccess: done,
  });
  const error = (setPrice.error || removeLocal.error || availability.error) as ApiError | null;

  return (
    <div className="space-y-3">
      <h3 className="font-semibold">Prix de vente TTC et disponibilité</h3>
      {error && <Alert>{error.message}</Alert>}
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-brand-50 px-3 py-2">
        <span className="text-sm text-stone-600">Prix de base (groupe)</span>
        <span className="text-lg font-bold">{product.basePrice !== null ? formatXOF(product.basePrice) : 'Non défini'}</span>
        {product.basePriceSince && <span className="text-xs text-stone-500">depuis le {formatDateTime(product.basePriceSince)}</span>}
        {manageBasePrice && (
          <PriceEditor
            label={product.basePrice === null ? 'Définir' : 'Modifier'}
            current={product.basePrice}
            loading={setPrice.isPending}
            onSave={(price, reason) => setPrice.mutate({ price, reason, establishmentId: null })}
          />
        )}
      </div>
      <Table head={['Établissement', 'Prix appliqué', 'Prix spécifique', 'Disponible', '']} empty={product.establishments.length === 0}>
        {product.establishments.map((e) => (
          <tr key={e.id}>
            <Td>
              <span className="font-mono text-xs">{e.code}</span> {e.name}
            </Td>
            <Td className="whitespace-nowrap font-semibold">{formatXOF(e.price)}</Td>
            <Td className="whitespace-nowrap">{e.localPrice !== null ? <Badge tone="orange">{formatXOF(e.localPrice)}</Badge> : <span className="text-stone-400">prix de base</span>}</Td>
            <Td>
              {canAvailability(e.id) ? (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={e.isAvailable} onChange={(ev) => availability.mutate({ establishmentId: e.id, isAvailable: ev.target.checked })} />
                  {e.isAvailable ? 'Oui' : 'Non'}
                </label>
              ) : e.isAvailable ? (
                <Badge tone="green">Oui</Badge>
              ) : (
                <Badge tone="red">Non</Badge>
              )}
            </Td>
            <Td>
              {canLocalPrice(e.id) && (
                <PriceEditor
                  label={e.localPrice === null ? 'Prix spécifique' : 'Modifier'}
                  current={e.localPrice ?? product.basePrice}
                  loading={setPrice.isPending || removeLocal.isPending}
                  onSave={(price, reason) => setPrice.mutate({ price, reason, establishmentId: e.id })}
                  onRemove={e.localPrice !== null ? () => removeLocal.mutate(e.id) : undefined}
                />
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <Button variant="ghost" onClick={() => setShowHistory(!showHistory)}>
        {showHistory ? 'Masquer' : 'Voir'} l’historique des prix
      </Button>
      {showHistory &&
        (history.isLoading ? (
          <Spinner />
        ) : (
          <Table head={['Périmètre', 'Prix', 'Du', 'Au', 'Par', 'Motif']} empty={history.data?.length === 0}>
            {history.data?.map((h) => (
              <tr key={h.id}>
                <Td>{h.establishment ? h.establishment.code : 'Groupe'}</Td>
                <Td className="whitespace-nowrap">{formatXOF(h.price)}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(h.validFrom)}</Td>
                <Td className="whitespace-nowrap">{h.validTo ? formatDateTime(h.validTo) : <Badge tone="green">En vigueur</Badge>}</Td>
                <Td>{h.createdBy?.fullName ?? '—'}</Td>
                <Td>{h.reason ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        ))}
    </div>
  );
}

function ComponentsSection({ product }: { product: ProductDetail }) {
  const qc = useQueryClient();
  const { manageCatalog } = useCatalogAccess();
  const [rows, setRows] = useState(product.menuComponents.map((c) => ({ productId: c.component.id, quantity: String(Number(c.quantity)) })));
  const candidates = useQuery({ queryKey: ['products', 'list', 'components'], queryFn: () => api.get<Product[]>('/products'), enabled: manageCatalog });
  const save = useMutation({
    mutationFn: () => api.put(`/products/${product.id}/components`, { components: rows.filter((r) => r.productId).map((r) => ({ ...r, quantity: Number(r.quantity) })) }, { noEstablishment: true }),
    onSuccess: () => invalidateProducts(qc),
  });
  const options = (candidates.data ?? []).filter((p) => p.type !== 'MENU' && p.id !== product.id);

  if (!manageCatalog) {
    return (
      <div className="space-y-2">
        <h3 className="font-semibold">Composition</h3>
        <ul className="list-inside list-disc text-sm">
          {product.menuComponents.map((c) => (
            <li key={c.id}>
              {qty(c.quantity)} × {c.component.name}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">Composition du menu</h3>
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      {save.isSuccess && <Alert tone="success">Composition enregistrée.</Alert>}
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Input className="w-20" type="number" min="0" step="any" value={r.quantity} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
          <Select value={r.productId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
            <option value="">— Produit —</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} — {p.name}
              </option>
            ))}
          </Select>
          <Button variant="ghost" aria-label="Retirer" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => setRows([...rows, { productId: '', quantity: '1' }])}>
          <Plus className="size-4" /> Composant
        </Button>
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Enregistrer la composition
        </Button>
      </div>
    </div>
  );
}

function ProductDetailView({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { manageCatalog } = useCatalogAccess();
  const [editing, setEditing] = useState(false);
  const { data: p, isLoading } = useQuery({ queryKey: ['products', id], queryFn: () => api.get<ProductDetail>(`/products/${id}`) });
  const archive = useMutation({
    mutationFn: () => api.patch(`/products/${id}`, { isActive: !p!.isActive }, { noEstablishment: true }),
    onSuccess: async () => {
      await invalidateProducts(qc);
      onClose();
    },
  });
  if (isLoading || !p) return <Spinner />;
  if (editing) return <ProductForm initial={p} onDone={() => setEditing(false)} />;

  return (
    <div className="space-y-6">
      {archive.error && <Alert>{(archive.error as ApiError).message}</Alert>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          {p.imageUrl && <img src={p.imageUrl} alt="" className="size-20 rounded-lg object-cover" />}
          <div className="space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold">{p.code}</span>
              <Badge tone={TYPE_TONE[p.type]}>{PRODUCT_TYPES[p.type]}</Badge>
              {!p.isActive && <Badge tone="red">Archivé</Badge>}
            </div>
            <div className="text-stone-600">
              {p.category?.name ?? 'Sans catégorie'} · vendu {p.saleUnitCode === 'U' ? "à l'unité" : `au ${p.saleUnit.symbol}`} · TVA incluse {qty(p.taxRate)} %
              {p.barcode && ` · code-barres ${p.barcode}`}
            </div>
            {p.description && <p className="text-stone-600">{p.description}</p>}
            {p.usedInMenus.length > 0 && <div className="text-xs text-stone-500">Inclus dans : {p.usedInMenus.map((m) => m.menu.name).join(', ')}</div>}
          </div>
        </div>
        {manageCatalog && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Modifier
            </Button>
            <Button variant={p.isActive ? 'danger' : 'primary'} loading={archive.isPending} onClick={() => archive.mutate()}>
              {p.isActive ? 'Archiver' : 'Réactiver'}
            </Button>
          </div>
        )}
      </div>
      <PricesSection product={p} />
      {p.type === 'MENU' && <ComponentsSection key={p.menuComponents.map((c) => c.id).join()} product={p} />}
      {p.type === 'RESOLD' && (
        <div className="space-y-2">
          <h3 className="font-semibold">Approvisionnement</h3>
          <Table head={['Fournisseur', 'Unité d’achat', 'Prix', 'Prix unitaire', '']} empty={p.supplierProducts.length === 0}>
            {p.supplierProducts.map((o) => (
              <tr key={o.id}>
                <Td>{o.supplier?.name}</Td>
                <Td>
                  {o.purchaseUnitLabel} ({qty(o.quantityPerPurchaseUnit)})
                </Td>
                <Td>{formatXOF(o.unitPrice)}</Td>
                <Td>{o.pricePerBaseUnit !== null ? formatXOF(o.pricePerBaseUnit) : '—'}</Td>
                <Td>{o.isPreferred && <Badge tone="green">Préférée</Badge>}</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </div>
  );
}

export function ProductsPage() {
  const { establishmentId, me } = useAuth();
  const { manageCatalog } = useCatalogAccess();
  const categories = useQuery({ queryKey: ['categories', 'product', 'active'], queryFn: () => api.get<Category[]>('/product-categories') });
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [type, setType] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set('search', search.trim());
    if (categoryId) p.set('categoryId', categoryId);
    if (type) p.set('type', type);
    if (showArchived) p.set('includeInactive', 'true');
    return p.toString();
  }, [search, categoryId, type, showArchived]);
  const { data, isLoading, error } = useQuery({ queryKey: ['products', 'list', params, establishmentId], queryFn: () => api.get<Product[]>(`/products?${params}`) });
  const current = me?.establishments.find((e) => e.id === establishmentId);
  const opened = data?.find((p) => p.id === openId);

  return (
    <>
      <PageHeader
        title="Produits"
        subtitle={current ? `Prix et disponibilité pour ${current.name}` : 'Prix de base du groupe'}
        actions={
          manageCatalog && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Nouveau produit
            </Button>
          )
        }
      />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input className="max-w-xs" placeholder="Rechercher (nom, code, code-barres)…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select className="max-w-[12rem]" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Toutes catégories</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select className="max-w-[12rem]" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Tous types</option>
            {Object.entries(PRODUCT_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archivés
          </label>
        </div>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Alert>{(error as ApiError).message}</Alert>
        ) : (
          <Table head={['Code', 'Nom', 'Catégorie', 'Type', 'Prix TTC', ...(current ? ['Dispo.'] : []), '']} empty={data?.length === 0}>
            {data?.map((p) => (
              <tr key={p.id} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpenId(p.id)}>
                <Td className="font-mono font-semibold">{p.code}</Td>
                <Td>
                  {p.name} {!p.isActive && <Badge tone="red">Archivé</Badge>}
                </Td>
                <Td>
                  {p.category ? (
                    <span className="flex items-center gap-1">
                      {p.category.color && <span className="size-2.5 rounded-full" style={{ background: p.category.color }} />}
                      {p.category.name}
                    </span>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td>
                  <Badge tone={TYPE_TONE[p.type]}>{PRODUCT_TYPES[p.type]}</Badge>
                </Td>
                <Td className="whitespace-nowrap">
                  {p.price ? formatXOF(p.price) : <span className="text-red-600">Sans prix</span>}
                  {p.localPrice && <div className="text-xs text-brand-700">prix du site</div>}
                  {p.saleUnitCode !== 'U' && <span className="text-xs text-stone-500"> / {p.saleUnit.symbol}</span>}
                </Td>
                {current && <Td>{p.isAvailable ? <Badge tone="green">Oui</Badge> : <Badge tone="red">Non</Badge>}</Td>}
                <Td className="text-right text-brand-700">Voir</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} title="Nouveau produit" wide>
        {creating && (
          <ProductForm
            onDone={(p) => {
              setCreating(false);
              setOpenId(p.id);
            }}
          />
        )}
      </Modal>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title={opened?.name ?? 'Produit'} wide>
        {openId && <ProductDetailView key={openId} id={openId} onClose={() => setOpenId(null)} />}
      </Modal>
    </>
  );
}
