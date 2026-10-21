import { useQuery } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { Alert, Badge, Button, Card, Input, Modal, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Product, RawMaterial, Supplier } from '../../lib/catalog-types';
import type { StockLocation } from '../../lib/stock-types';

/** Établissement de travail ; les opérations de stock exigent un établissement précis. */
export function useEstablishment() {
  const { me, establishmentId, can } = useAuth();
  const current = me?.establishments.find((e) => e.id === establishmentId) ?? null;
  return { establishment: current, establishmentId, can };
}

export function RequireEstablishment({ children }: { children: (establishmentId: string) => ReactNode }) {
  const { establishmentId } = useEstablishment();
  if (!establishmentId) {
    return (
      <Card>
        <Alert tone="info">Choisissez un établissement dans le menu (en haut à gauche) pour travailler sur son stock et ses achats.</Alert>
      </Card>
    );
  }
  return <>{children(establishmentId)}</>;
}

export interface PickableItem {
  key: string;
  rawMaterialId: string | null;
  productId: string | null;
  code: string;
  name: string;
  unit: string;
  isPerishable: boolean;
}

/** Articles stockables : matières premières + produits revendus / fabriqués (option : achetables seulement). */
export function useStockItems(opts: { purchasable?: boolean } = {}) {
  const raws = useQuery({ queryKey: ['raw-materials', 'list', ''], queryFn: () => api.get<RawMaterial[]>('/raw-materials') });
  const products = useQuery({ queryKey: ['products', 'list', 'stockable'], queryFn: () => api.get<Product[]>('/products') });
  const items: PickableItem[] = [
    ...(raws.data ?? []).map((m) => ({ key: `r:${m.id}`, rawMaterialId: m.id, productId: null, code: m.code, name: m.name, unit: m.baseUnitCode, isPerishable: m.isPerishable })),
    ...(products.data ?? [])
      .filter((p) => (opts.purchasable ? p.type === 'RESOLD' : p.type !== 'MENU'))
      .map((p) => ({ key: `p:${p.id}`, rawMaterialId: null, productId: p.id, code: p.code, name: p.name, unit: p.saleUnitCode, isPerishable: false })),
  ].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return { items, isLoading: raws.isLoading || products.isLoading };
}

export function ItemSelect({ items, value, onChange, required }: { items: PickableItem[]; value: string; onChange: (item: PickableItem | null) => void; required?: boolean }) {
  return (
    <Select required={required} value={value} onChange={(e) => onChange(items.find((i) => i.key === e.target.value) ?? null)}>
      <option value="">— Article —</option>
      {items.map((i) => (
        <option key={i.key} value={i.key}>
          {i.code} — {i.name}
        </option>
      ))}
    </Select>
  );
}

export const itemPayload = (i: PickableItem | null) => (i ? (i.rawMaterialId ? { rawMaterialId: i.rawMaterialId } : { productId: i.productId }) : {});

export function useLocations(establishmentId: string | null) {
  return useQuery({
    queryKey: ['stock-locations', establishmentId],
    queryFn: () => api.get<StockLocation[]>(`/stock-locations?establishmentId=${establishmentId}`),
    enabled: !!establishmentId,
  });
}

export function LocationSelect({ establishmentId, value, onChange, label = true }: { establishmentId: string; value: string; onChange: (id: string) => void; label?: boolean }) {
  const { data } = useLocations(establishmentId);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Emplacement">
      {label && <option value="">Emplacement par défaut</option>}
      {data
        ?.filter((l) => l.isActive)
        .map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
            {l.openInventory ? ` (inventaire ${l.openInventory} en cours)` : ''}
          </option>
        ))}
    </Select>
  );
}

export function useSuppliers() {
  return useQuery({ queryKey: ['suppliers', 'list', ''], queryFn: () => api.get<Supplier[]>('/suppliers') });
}

export function StatusBadge({ map, status }: { map: Record<string, { label: string; tone: 'neutral' | 'blue' | 'orange' | 'green' | 'red' }>; status: string }) {
  const s = map[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Onglets simples. */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b border-stone-200">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${value === t.id ? 'border-brand-600 font-semibold text-brand-700' : 'border-transparent text-stone-600 hover:text-stone-900'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Fenêtre de saisie d'un motif (annulation, refus, clôture…).
 * Usage : const reason = useReasonDialog(); reason.ask('Motif', (r) => mutate(r)); puis rendre {reason.dialog}.
 */
export function useReasonDialog() {
  const [state, setState] = useState<{ title: string; onConfirm: (reason: string) => void } | null>(null);
  const [value, setValue] = useState('');
  const ask = (title: string, onConfirm: (reason: string) => void) => {
    setValue('');
    setState({ title, onConfirm });
  };
  const dialog = (
    <Modal open={!!state} onClose={() => setState(null)} title={state?.title ?? ''}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          state?.onConfirm(value.trim());
          setState(null);
        }}
      >
        <Input autoFocus required minLength={3} maxLength={500} placeholder="Motif (3 caractères minimum)" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setState(null)}>
            Annuler
          </Button>
          <Button type="submit">Confirmer</Button>
        </div>
      </form>
    </Modal>
  );
  return { ask, dialog };
}

/** UUID v4, y compris hors HTTPS (tablettes sur le réseau local), où randomUUID n'existe pas. */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Identifiant stable d'un formulaire : renvoyé à chaque tentative d'envoi,
 * il garantit côté serveur qu'un double clic ou un renvoi après coupure
 * réseau ne crée pas deux documents.
 */
export function useRequestId() {
  const [id] = useState(uuid);
  return id;
}

/**
 * Protection d'écran : si l'utilisateur arrive sur la page (lien direct, autre
 * établissement sélectionné…) sans la permission, un message remplace le contenu.
 * Le serveur reste seul juge : cette protection évite seulement un écran d'erreurs.
 */
export function RequirePermission({ permission, children }: { permission: string | string[]; children: ReactNode }) {
  const { establishmentId, can, canAnywhere } = useAuth();
  const list = Array.isArray(permission) ? permission : [permission];
  const allowed = list.some((p) => (establishmentId ? can(p) : canAnywhere(p)));
  if (!allowed) {
    return (
      <Card>
        <Alert>Accès refusé : votre rôle ne donne pas accès à cet écran{establishmentId ? ' dans cet établissement' : ''}.</Alert>
      </Card>
    );
  }
  return <>{children}</>;
}

/** Peut déclarer une perte : magasin (« Ajuster le stock ») ou production. */
export function useCanDeclareLoss() {
  const { can } = useAuth();
  return can('stock.adjust') || can('production.manage');
}
