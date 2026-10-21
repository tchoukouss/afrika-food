import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useCatalogAccess } from '../../lib/catalog-access';
import { Product, qty, RawMaterial, Supplier, SupplierOffer } from '../../lib/catalog-types';
import { formatDate, formatXOF } from '../../lib/format';

const FIELDS: { key: keyof Supplier; label: string; type?: string; span?: boolean }[] = [
  { key: 'contactName', label: 'Contact' },
  { key: 'phone', label: 'Téléphone' },
  { key: 'phone2', label: 'Téléphone 2' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'city', label: 'Ville / commune' },
  { key: 'taxId', label: 'N° contribuable (NCC)' },
  { key: 'address', label: 'Adresse', span: true },
];

function SupplierForm({ initial, onDone }: { initial?: Supplier; onDone: (s: Supplier) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, string>>(() => ({
    code: initial?.code ?? '',
    name: initial?.name ?? '',
    paymentTermsDays: String(initial?.paymentTermsDays ?? 0),
    paymentTerms: initial?.paymentTerms ?? '',
    creditLimit: initial?.creditLimit ?? '',
    notes: initial?.notes ?? '',
    ...Object.fromEntries(FIELDS.map(({ key }) => [key, (initial?.[key] as string | null) ?? ''])),
  }));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...f,
        paymentTermsDays: Number(f.paymentTermsDays) || 0,
        creditLimit: f.creditLimit === '' ? null : Number(f.creditLimit),
      };
      return initial
        ? api.patch<Supplier>(`/suppliers/${initial.id}`, body)
        : api.post<Supplier>('/suppliers', body);
    },
    onSuccess: async (s) => {
      await qc.invalidateQueries({ queryKey: ['suppliers'] });
      onDone(s);
    },
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

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
        <Field label="Code" hint="Ex. GMA">
          <Input required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Raison sociale">
            <Input required value={f.name} onChange={set('name')} />
          </Field>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {FIELDS.map(({ key, label, type, span }) => (
          <div key={key} className={span ? 'sm:col-span-3' : ''}>
            <Field label={label}>
              <Input type={type} value={f[key]} onChange={set(key)} />
            </Field>
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Délai de paiement (jours)">
          <Input type="number" min={0} max={365} value={f.paymentTermsDays} onChange={set('paymentTermsDays')} />
        </Field>
        <Field label="Plafond de crédit (FCFA)" hint="Vide = non défini">
          <Input type="number" min={0} step={1} value={f.creditLimit} onChange={set('creditLimit')} />
        </Field>
        <Field label="Conditions de paiement">
          <Input value={f.paymentTerms} onChange={set('paymentTerms')} placeholder="50 % à la commande…" />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea rows={2} value={f.notes} onChange={set('notes')} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Enregistrer
        </Button>
      </div>
    </form>
  );
}

/** Ajout d'une offre : matière première OU produit revendu. */
function OfferForm({ supplierId, onDone }: { supplierId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'raw' | 'product'>('raw');
  const [itemId, setItemId] = useState('');
  const [f, setF] = useState({ brand: '', supplierRef: '', purchaseUnitLabel: '', quantityPerPurchaseUnit: '', unitPrice: '', isPreferred: false });
  const materials = useQuery({ queryKey: ['raw-materials', 'list', ''], queryFn: () => api.get<RawMaterial[]>('/raw-materials'), enabled: kind === 'raw' });
  const products = useQuery({ queryKey: ['products', 'resold'], queryFn: () => api.get<Product[]>('/products?type=RESOLD'), enabled: kind === 'product' });
  const material = materials.data?.find((m) => m.id === itemId);
  const unit = kind === 'raw' ? ({ KG: 'kg', L: 'L', U: 'unité(s)' } as const)[material?.baseUnitCode ?? 'U'] : 'unité(s)';

  const save = useMutation({
    mutationFn: () =>
      api.post('/supplier-products', {
        supplierId,
        ...(kind === 'raw' ? { rawMaterialId: itemId } : { productId: itemId }),
        ...f,
        quantityPerPurchaseUnit: Number(f.quantityPerPurchaseUnit),
        unitPrice: f.unitPrice === '' ? null : Number(f.unitPrice),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['suppliers'] });
      await qc.invalidateQueries({ queryKey: ['raw-materials'] });
      onDone();
    },
  });
  const perUnit = f.unitPrice && Number(f.quantityPerPurchaseUnit) > 0 ? Number(f.unitPrice) / Number(f.quantityPerPurchaseUnit) : null;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={kind === 'raw'} onChange={() => (setKind('raw'), setItemId(''))} /> Matière première
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={kind === 'product'} onChange={() => (setKind('product'), setItemId(''))} /> Produit revendu
        </label>
      </div>
      <Field label="Article">
        <Select
          required
          value={itemId}
          onChange={(e) => {
            setItemId(e.target.value);
            const m = materials.data?.find((x) => x.id === e.target.value);
            const pack = m?.packagings.find((p) => p.isDefault) ?? m?.packagings[0];
            // Pré-remplit avec le conditionnement par défaut de la matière.
            if (pack) setF((s) => ({ ...s, purchaseUnitLabel: pack.name, quantityPerPurchaseUnit: String(Number(pack.quantity)) }));
          }}
        >
          <option value="">— Choisir —</option>
          {(kind === 'raw' ? materials.data : products.data)?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.code} — {x.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Marque">
          <Input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} />
        </Field>
        <Field label="Référence fournisseur">
          <Input value={f.supplierRef} onChange={(e) => setF({ ...f, supplierRef: e.target.value })} />
        </Field>
        <Field label="Unité d'achat" hint="Telle que facturée : Sac 25 kg, Casier 24…">
          <Input required value={f.purchaseUnitLabel} onChange={(e) => setF({ ...f, purchaseUnitLabel: e.target.value })} />
        </Field>
        <Field label={`Contenu (en ${unit})`}>
          <Input required type="number" step="any" min="0" value={f.quantityPerPurchaseUnit} onChange={(e) => setF({ ...f, quantityPerPurchaseUnit: e.target.value })} />
        </Field>
        <Field label="Prix par unité d'achat (FCFA)" hint={perUnit !== null ? `soit ${formatXOF(Math.round(perUnit * 100) / 100)} par ${unit.replace('(s)', '')}` : undefined}>
          <Input type="number" min={0} step={1} value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={f.isPreferred} onChange={(e) => setF({ ...f, isPreferred: e.target.checked })} /> Offre préférée
        </label>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>
          Ajouter l’offre
        </Button>
      </div>
    </form>
  );
}

function OfferRow({ offer, canManage }: { offer: SupplierOffer; canManage: boolean }) {
  const qc = useQueryClient();
  const [price, setPrice] = useState(offer.unitPrice ?? '');
  const patch = useMutation({
    mutationFn: (body: object) => api.patch(`/supplier-products/${offer.id}`, body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['suppliers'] });
      await qc.invalidateQueries({ queryKey: ['raw-materials'] });
    },
  });
  const item = offer.rawMaterial ?? offer.product;
  const unit = offer.rawMaterial ? ({ KG: 'kg', L: 'L', U: 'u' } as const)[offer.rawMaterial.baseUnitCode as 'KG' | 'L' | 'U'] : 'u';
  return (
    <tr className={offer.isActive ? '' : 'text-stone-400'}>
      <Td>
        {item?.name}
        {patch.error && <div className="text-xs text-red-600">{(patch.error as ApiError).message}</div>}
      </Td>
      <Td>{offer.brand ?? '—'}</Td>
      <Td>
        {offer.purchaseUnitLabel} ({qty(offer.quantityPerPurchaseUnit)} {unit})
      </Td>
      <Td className="whitespace-nowrap">
        {canManage ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              patch.mutate({ unitPrice: price === '' ? null : Number(price) });
            }}
          >
            <Input className="w-28" type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
            {price !== (offer.unitPrice ?? '') && (
              <Button type="submit" variant="secondary" loading={patch.isPending}>
                OK
              </Button>
            )}
          </form>
        ) : (
          formatXOF(offer.unitPrice)
        )}
        <div className="text-xs text-stone-500">
          {offer.pricePerBaseUnit !== null && `${formatXOF(offer.pricePerBaseUnit)} / ${unit}`}
          {offer.priceUpdatedAt && ` · maj ${formatDate(offer.priceUpdatedAt)}`}
        </div>
      </Td>
      <Td>{offer.isPreferred && <Badge tone="green">Préférée</Badge>}</Td>
      <Td className="whitespace-nowrap text-right">
        {canManage && (
          <>
            {!offer.isPreferred && offer.isActive && (
              <Button variant="ghost" onClick={() => patch.mutate({ isPreferred: true })}>
                Préférer
              </Button>
            )}
            <Button variant="ghost" onClick={() => patch.mutate({ isActive: !offer.isActive })}>
              {offer.isActive ? 'Désactiver' : 'Réactiver'}
            </Button>
          </>
        )}
      </Td>
    </tr>
  );
}

function SupplierDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { manageSuppliers } = useCatalogAccess();
  const [editing, setEditing] = useState(false);
  const [addingOffer, setAddingOffer] = useState(false);
  const { data: s, isLoading } = useQuery({ queryKey: ['suppliers', id], queryFn: () => api.get<Supplier>(`/suppliers/${id}`) });
  const toggle = useMutation({
    mutationFn: () => api.patch(`/suppliers/${id}`, { isActive: !s!.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suppliers'] }),
  });
  if (isLoading || !s) return <Spinner />;
  if (editing) return <SupplierForm initial={s} onDone={() => setEditing(false)} />;

  return (
    <div className="space-y-5">
      {toggle.error && <Alert>{(toggle.error as ApiError).message}</Alert>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            <dt className="inline text-stone-500">Code : </dt>
            <dd className="inline font-mono font-semibold">{s.code}</dd>
          </div>
          {FIELDS.map(({ key, label }) =>
            s[key] ? (
              <div key={key}>
                <dt className="inline text-stone-500">{label} : </dt>
                <dd className="inline">{String(s[key])}</dd>
              </div>
            ) : null,
          )}
          <div>
            <dt className="inline text-stone-500">Paiement : </dt>
            <dd className="inline">
              {s.paymentTermsDays > 0 ? `${s.paymentTermsDays} jours` : 'comptant'}
              {s.paymentTerms ? ` · ${s.paymentTerms}` : ''}
            </dd>
          </div>
          <div>
            <dt className="inline text-stone-500">Plafond de crédit : </dt>
            <dd className="inline">{s.creditLimit ? formatXOF(s.creditLimit) : 'non défini'}</dd>
          </div>
          {s.notes && <div className="sm:col-span-2 text-stone-600">{s.notes}</div>}
        </dl>
        {manageSuppliers && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Modifier
            </Button>
            <Button variant={s.isActive ? 'danger' : 'primary'} loading={toggle.isPending} onClick={() => toggle.mutate()}>
              {s.isActive ? 'Archiver' : 'Réactiver'}
            </Button>
          </div>
        )}
      </div>
      <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500">
        L’historique des achats, les factures, les paiements et le solde fournisseur arrivent avec le module 3 (achats).
      </p>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Articles fournis</h3>
          {manageSuppliers && (
            <Button variant="secondary" onClick={() => setAddingOffer(true)}>
              <Plus className="size-4" /> Ajouter une offre
            </Button>
          )}
        </div>
        <Table head={['Article', 'Marque', 'Unité d’achat', 'Prix de référence', '', '']} empty={!s.products?.length}>
          {s.products?.map((o) => <OfferRow key={o.id} offer={o} canManage={manageSuppliers} />)}
        </Table>
      </div>
      <Modal open={addingOffer} onClose={() => setAddingOffer(false)} title={`Nouvelle offre — ${s.name}`}>
        {addingOffer && <OfferForm supplierId={s.id} onDone={() => setAddingOffer(false)} />}
      </Modal>
    </div>
  );
}

export function SuppliersPage() {
  const { manageSuppliers } = useCatalogAccess();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  if (showArchived) params.set('includeInactive', 'true');
  const { data, isLoading, error } = useQuery({ queryKey: ['suppliers', 'list', params.toString()], queryFn: () => api.get<Supplier[]>(`/suppliers?${params}`) });
  const opened = data?.find((s) => s.id === openId);

  return (
    <>
      <PageHeader
        title="Fournisseurs"
        subtitle="Fichier commun au groupe, avec les articles fournis et les prix négociés"
        actions={
          manageSuppliers && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> Nouveau fournisseur
            </Button>
          )
        }
      />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input className="max-w-xs" placeholder="Rechercher (nom, code, téléphone)…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archivés
          </label>
        </div>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Alert>{(error as ApiError).message}</Alert>
        ) : (
          <Table head={['Code', 'Nom', 'Contact', 'Téléphone', 'Paiement', 'Articles', '']} empty={data?.length === 0}>
            {data?.map((s) => (
              <tr key={s.id} className="cursor-pointer hover:bg-stone-50" onClick={() => setOpenId(s.id)}>
                <Td className="font-mono font-semibold">{s.code}</Td>
                <Td>
                  {s.name} {!s.isActive && <Badge tone="red">Archivé</Badge>}
                </Td>
                <Td>{s.contactName ?? '—'}</Td>
                <Td className="whitespace-nowrap">{s.phone ?? '—'}</Td>
                <Td>{s.paymentTermsDays > 0 ? `${s.paymentTermsDays} j` : 'comptant'}</Td>
                <Td>{s._count?.products ?? 0}</Td>
                <Td className="text-right text-brand-700">Voir</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal open={creating} onClose={() => setCreating(false)} title="Nouveau fournisseur" wide>
        {creating && (
          <SupplierForm
            onDone={(s) => {
              setCreating(false);
              setOpenId(s.id);
            }}
          />
        )}
      </Modal>
      <Modal open={!!openId} onClose={() => setOpenId(null)} title={opened?.name ?? 'Fournisseur'} wide>
        {openId && <SupplierDetail key={openId} id={openId} />}
      </Modal>
    </>
  );
}
