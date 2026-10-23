import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import type { Product } from '../../lib/catalog-types';
import { formatXOF } from '../../lib/format';
import { Area, MenuEntry, Station } from '../../lib/restaurant-types';
import { LocationSelect, RequireEstablishment, RequirePermission, Tabs } from '../stock/shared';

/** Paramétrage du restaurant par le responsable (« Gérer salles et tables ») : salle, postes, carte, options. */
export function RestaurantSetupPage() {
  const [tab, setTab] = useState<'floor' | 'stations' | 'menu'>('floor');
  return (
    <>
      <PageHeader title="Paramétrage restaurant" subtitle="Zones et tables, postes cuisine / bar, carte et options" />
      <RequirePermission permission="restaurant.tables">
        <RequireEstablishment>
          {(establishmentId) => (
            <>
              <Tabs
                tabs={[
                  { id: 'floor', label: 'Zones et tables' },
                  { id: 'stations', label: 'Postes' },
                  { id: 'menu', label: 'Carte et options' },
                ]}
                value={tab}
                onChange={setTab}
              />
              {tab === 'floor' && <FloorSetup establishmentId={establishmentId} />}
              {tab === 'stations' && <StationsSetup establishmentId={establishmentId} />}
              {tab === 'menu' && <MenuSetup establishmentId={establishmentId} />}
            </>
          )}
        </RequireEstablishment>
      </RequirePermission>
    </>
  );
}

function useSave<T>(fn: (body: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['restaurant'] }) });
}

function FloorSetup({ establishmentId }: { establishmentId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['restaurant', 'floor', establishmentId], queryFn: () => api.get<Area[]>('/restaurant/floor') });
  const [area, setArea] = useState('');
  const [table, setTable] = useState({ areaId: '', code: '', capacity: '4' });
  const addArea = useSave(() => api.post('/restaurant/areas', { establishmentId, name: area }));
  const addTable = useSave(() => api.post('/restaurant/tables', { areaId: table.areaId, code: table.code, capacity: Number(table.capacity) }));
  const toggle = useSave((v: { id: string; isActive: boolean }) => api.patch(`/restaurant/tables/${v.id}`, { isActive: v.isActive }));
  if (isLoading) return <Spinner />;
  const err = [addArea, addTable, toggle].find((m) => m.error)?.error as ApiError | undefined;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Nouvelle zone">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addArea.mutate(undefined, { onSuccess: () => setArea('') });
          }}
        >
          <Input required minLength={2} maxLength={60} placeholder="ex. Terrasse" value={area} onChange={(e) => setArea(e.target.value)} />
          <Button type="submit" loading={addArea.isPending}>
            Ajouter
          </Button>
        </form>
      </Card>
      <Card title="Nouvelle table">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addTable.mutate(undefined, { onSuccess: () => setTable({ ...table, code: '' }) });
          }}
        >
          <Select required className="w-40" value={table.areaId} onChange={(e) => setTable({ ...table, areaId: e.target.value })}>
            <option value="">— Zone —</option>
            {(data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Input required className="w-24" maxLength={10} placeholder="Code" value={table.code} onChange={(e) => setTable({ ...table, code: e.target.value.toUpperCase() })} />
          <Input required className="w-24" type="number" min={1} max={100} value={table.capacity} onChange={(e) => setTable({ ...table, capacity: e.target.value })} aria-label="Places" />
          <Button type="submit" loading={addTable.isPending}>
            Ajouter
          </Button>
        </form>
      </Card>
      {err && <div className="lg:col-span-2"><Alert>{err.message}</Alert></div>}
      {(data ?? []).map((a) => (
        <Card key={a.id} title={a.name}>
          <div className="flex flex-wrap gap-2">
            {a.tables.map((t) => (
              <button
                key={t.id}
                onClick={() => toggle.mutate({ id: t.id, isActive: !t.isActive })}
                className={`rounded-lg border px-3 py-2 text-sm ${t.isActive ? 'border-stone-300 bg-white' : 'border-dashed border-stone-300 bg-stone-100 text-stone-400 line-through'}`}
                title={t.isActive ? 'Désactiver' : 'Réactiver'}
              >
                {t.code} · {t.capacity} pl.
              </button>
            ))}
            {a.tables.length === 0 && <span className="text-sm text-stone-500">Aucune table.</span>}
          </div>
        </Card>
      ))}
    </div>
  );
}

function StationsSetup({ establishmentId }: { establishmentId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['restaurant', 'stations', establishmentId], queryFn: () => api.get<Station[]>('/restaurant/stations') });
  const [editing, setEditing] = useState<Station | 'new' | null>(null);
  if (isLoading) return <Spinner />;
  return (
    <Card
      actions={
        <Button onClick={() => setEditing('new')}>
          <Plus className="size-4" /> Nouveau poste
        </Button>
      }
    >
      <Table head={['Poste', 'Type', 'Imprimante', '']} empty={!data?.length}>
        {(data ?? []).map((s) => (
          <tr key={s.id}>
            <Td className="font-medium">
              {s.name} {!s.isActive && <Badge tone="red">Inactif</Badge>}
            </Td>
            <Td>{s.kind === 'KITCHEN' ? 'Cuisine' : 'Bar'}</Td>
            <Td className="text-xs">{s.printerType === 'NETWORK' ? `Réseau ${s.printerHost}:${s.printerPort}` : s.printerType === 'BROWSER' ? 'Navigateur' : 'Écran seulement'}</Td>
            <Td>
              <Button variant="ghost" onClick={() => setEditing(s)}>
                Modifier
              </Button>
            </Td>
          </tr>
        ))}
      </Table>
      {editing && <StationForm establishmentId={establishmentId} station={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function StationForm({ establishmentId, station, onClose }: { establishmentId: string; station: Station | null; onClose: () => void }) {
  const [form, setForm] = useState({
    name: station?.name ?? '',
    kind: station?.kind ?? 'KITCHEN',
    stockLocationId: station?.stockLocationId ?? '',
    printerType: station?.printerType ?? 'NONE',
    printerHost: station?.printerHost ?? '',
    printerPort: String(station?.printerPort ?? 9100),
    paperWidth: String(station?.paperWidth ?? 80),
    isActive: station?.isActive ?? true,
  });
  const save = useSave(() => {
    const body = {
      name: form.name,
      ...(form.stockLocationId ? { stockLocationId: form.stockLocationId } : {}),
      printerType: form.printerType,
      printerHost: form.printerType === 'NETWORK' ? form.printerHost : null,
      printerPort: Number(form.printerPort),
      paperWidth: Number(form.paperWidth),
    };
    return station ? api.patch(`/restaurant/stations/${station.id}`, { ...body, isActive: form.isActive }) : api.post('/restaurant/stations', { ...body, establishmentId, kind: form.kind });
  });
  return (
    <Modal open title={station ? `Poste ${station.name}` : 'Nouveau poste'} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined, { onSuccess: onClose });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nom">
            <Input required minLength={2} maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Type">
            <Select disabled={!!station} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'KITCHEN' | 'BAR' })}>
              <option value="KITCHEN">Cuisine</option>
              <option value="BAR">Bar</option>
            </Select>
          </Field>
        </div>
        <Field label="Stock consommé" hint="Emplacement d’où sortent les ingrédients et produits envoyés à ce poste.">
          <LocationSelect establishmentId={establishmentId} value={form.stockLocationId} onChange={(v) => setForm({ ...form, stockLocationId: v })} />
        </Field>
        <Field label="Impression des bons">
          <Select value={form.printerType} onChange={(e) => setForm({ ...form, printerType: e.target.value as Station['printerType'] })}>
            <option value="NONE">Écran cuisine seulement</option>
            <option value="NETWORK">Imprimante thermique réseau</option>
            <option value="BROWSER">Navigateur</option>
          </Select>
        </Field>
        {form.printerType === 'NETWORK' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Adresse IP" hint="Réseau local">
              <Input required value={form.printerHost} onChange={(e) => setForm({ ...form, printerHost: e.target.value.trim() })} />
            </Field>
            <Field label="Port">
              <Input type="number" min={1} max={65535} value={form.printerPort} onChange={(e) => setForm({ ...form, printerPort: e.target.value })} />
            </Field>
            <Field label="Papier">
              <Select value={form.paperWidth} onChange={(e) => setForm({ ...form, paperWidth: e.target.value })}>
                <option value="80">80 mm</option>
                <option value="58">58 mm</option>
              </Select>
            </Field>
          </div>
        )}
        {station && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Poste actif
          </label>
        )}
        {save.error && <Alert>{(save.error as ApiError).message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" loading={save.isPending}>
            Enregistrer
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Carte : produit du catalogue → préparation (à la commande / depuis le stock), poste, supplément, options. */
function MenuSetup({ establishmentId }: { establishmentId: string }) {
  const menu = useQuery({ queryKey: ['restaurant', 'menu', establishmentId], queryFn: () => api.get<MenuEntry[]>('/restaurant/menu') });
  const products = useQuery({ queryKey: ['products', 'list', 'restaurant'], queryFn: () => api.get<Product[]>('/products') });
  const stations = useQuery({ queryKey: ['restaurant', 'stations', establishmentId], queryFn: () => api.get<Station[]>('/restaurant/stations') });
  const save = useSave((body: object) => api.put('/restaurant/menu', { establishmentId, ...body }));
  const [optionsFor, setOptionsFor] = useState<MenuEntry | null>(null);
  if (menu.isLoading || products.isLoading) return <Spinner />;
  const entries = new Map((menu.data ?? []).map((m) => [m.productId, m]));
  const rows = (products.data ?? []).filter((p) => p.isActive || entries.has(p.id));
  return (
    <Card>
      {save.error && <div className="mb-3"><Alert>{(save.error as ApiError).message}</Alert></div>}
      <Table head={['Produit', 'Prix', 'À la carte', 'Préparation', 'Poste', 'Supplément', 'Options']} empty={!rows.length}>
        {rows.map((p) => {
          const m = entries.get(p.id);
          const on = !!m?.isActive;
          return (
            <tr key={p.id}>
              <Td className="font-medium">
                {p.name}
                <div className="text-xs text-stone-500">{p.type === 'MENU' ? 'Formule' : p.type === 'MANUFACTURED' ? 'Fabriqué' : 'Revendu'}</div>
              </Td>
              <Td>{formatXOF(p.price ?? p.basePrice)}</Td>
              <Td>
                <input type="checkbox" aria-label="À la carte" checked={on} onChange={(e) => save.mutate({ productId: p.id, isActive: e.target.checked })} />
              </Td>
              <Td>
                {p.type !== 'MENU' && (
                  <Select className="w-44 py-1" disabled={!m} value={m?.preparation ?? 'FROM_STOCK'} onChange={(e) => save.mutate({ productId: p.id, preparation: e.target.value })}>
                    <option value="FROM_STOCK">Depuis le stock</option>
                    {p.type === 'MANUFACTURED' && <option value="TO_ORDER">À la commande (recette)</option>}
                  </Select>
                )}
              </Td>
              <Td>
                <Select className="w-36 py-1" disabled={!m} value={m?.stationId ?? ''} onChange={(e) => save.mutate({ productId: p.id, stationId: e.target.value || null })}>
                  <option value="">Service direct</option>
                  {(stations.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Td>
              <Td>
                <input type="checkbox" aria-label="Supplément" disabled={!m} checked={!!m?.isSupplement} onChange={(e) => save.mutate({ productId: p.id, isSupplement: e.target.checked })} />
              </Td>
              <Td>
                {m && (
                  <Button variant="ghost" className="px-2 py-1" onClick={() => setOptionsFor(m)}>
                    {m.options.filter((o) => o.isActive).length} option(s)
                  </Button>
                )}
              </Td>
            </tr>
          );
        })}
      </Table>
      {optionsFor && <OptionsDialog entry={(menu.data ?? []).find((m) => m.id === optionsFor.id) ?? optionsFor} establishmentId={establishmentId} onClose={() => setOptionsFor(null)} />}
    </Card>
  );
}

function OptionsDialog({ entry, establishmentId, onClose }: { entry: MenuEntry; establishmentId: string; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const add = useSave(() => api.post('/restaurant/options', { establishmentId, productId: entry.productId, label }));
  const toggle = useSave((v: { id: string; isActive: boolean }) => api.patch(`/restaurant/options/${v.id}`, { isActive: v.isActive }));
  return (
    <Modal open title={`Options — ${entry.product.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {entry.options.map((o) => (
            <button
              key={o.id}
              onClick={() => toggle.mutate({ id: o.id, isActive: !o.isActive })}
              className={`rounded-full border px-3 py-1 text-sm ${o.isActive ? 'border-brand-300 bg-brand-50' : 'border-stone-300 text-stone-400 line-through'}`}
            >
              {o.label}
            </button>
          ))}
          {entry.options.length === 0 && <span className="text-sm text-stone-500">Aucune option.</span>}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined, { onSuccess: () => setLabel('') });
          }}
        >
          <Input required maxLength={60} placeholder="ex. Bien cuit" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button type="submit" loading={add.isPending}>
            Ajouter
          </Button>
        </form>
        {(add.error || toggle.error) && <Alert>{((add.error || toggle.error) as ApiError).message}</Alert>}
      </div>
    </Modal>
  );
}
