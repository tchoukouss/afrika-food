import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Printer } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { CashRegister, PRINTER_TYPES, PrinterType } from '../../lib/sales-types';
import { LocationSelect, RequireEstablishment, RequirePermission } from '../stock/shared';

/** Caisses de l'établissement : emplacement de stock et imprimante (décisions 1, 12 et 17). */
export function RegistersPage() {
  return (
    <>
      <PageHeader title="Caisses" subtitle="Postes de caisse, emplacement de stock vendu et imprimante de tickets" />
      <RequirePermission permission="cash.movements">
        <RequireEstablishment>{(establishmentId) => <Registers establishmentId={establishmentId} />}</RequireEstablishment>
      </RequirePermission>
    </>
  );
}

function Registers({ establishmentId }: { establishmentId: string }) {
  const { can } = useAuth();
  const canManage = can('cash.view_all') && can('cash.movements');
  const { data, isLoading, error } = useQuery({ queryKey: ['cash-registers', establishmentId], queryFn: () => api.get<CashRegister[]>('/cash-registers') });
  const [editing, setEditing] = useState<CashRegister | 'new' | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const testPrint = useMutation({ mutationFn: (id: string) => api.post<{ ok: boolean; message: string }>(`/cash-registers/${id}/test-print`), onSuccess: setTest });
  return (
    <Card
      actions={
        canManage && (
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" /> Nouvelle caisse
          </Button>
        )
      }
    >
      {isLoading && <Spinner />}
      {error && <Alert>{(error as ApiError).message}</Alert>}
      {test && <div className="mb-3"><Alert tone={test.ok ? 'success' : 'error'}>{test.message}</Alert></div>}
      {testPrint.error && <div className="mb-3"><Alert>{(testPrint.error as ApiError).message}</Alert></div>}
      {data && (
        <Table head={['Code', 'Nom', 'Stock vendu', 'Imprimante', 'Session', '']} empty={data.length === 0}>
          {data.map((r) => (
            <tr key={r.id}>
              <Td className="font-semibold">
                {r.code} {!r.isActive && <Badge tone="red">Désactivée</Badge>}
              </Td>
              <Td>{r.name}</Td>
              <Td>{r.stockLocation?.name}</Td>
              <Td className="text-xs">
                {PRINTER_TYPES[r.printerType]}
                {r.printerType === 'NETWORK' && ` — ${r.printerHost}:${r.printerPort}`} · {r.paperWidth} mm{r.autoPrint ? '' : ' · manuelle'}
              </Td>
              <Td className="text-xs">{r.openSession ? `${r.openSession.number} (${r.openSession.cashier})` : '—'}</Td>
              <Td className="whitespace-nowrap">
                {r.canManage && (
                  <>
                    <Button variant="ghost" onClick={() => setEditing(r)}>
                      Modifier
                    </Button>
                    {r.printerType === 'NETWORK' && (
                      <Button variant="ghost" loading={testPrint.isPending && testPrint.variables === r.id} onClick={() => testPrint.mutate(r.id)}>
                        <Printer className="size-4" /> Test
                      </Button>
                    )}
                  </>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {editing && <RegisterForm establishmentId={establishmentId} register={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function RegisterForm({ establishmentId, register, onClose }: { establishmentId: string; register: CashRegister | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    code: register?.code ?? '',
    name: register?.name ?? '',
    stockLocationId: register?.stockLocationId ?? '',
    printerType: (register?.printerType ?? 'BROWSER') as PrinterType,
    printerHost: register?.printerHost ?? '',
    printerPort: String(register?.printerPort ?? 9100),
    paperWidth: String(register?.paperWidth ?? 80),
    autoPrint: register?.autoPrint ?? true,
    isActive: register?.isActive ?? true,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        ...(form.stockLocationId ? { stockLocationId: form.stockLocationId } : {}),
        printerType: form.printerType,
        printerHost: form.printerType === 'NETWORK' ? form.printerHost : null,
        printerPort: Number(form.printerPort),
        paperWidth: Number(form.paperWidth),
        autoPrint: form.autoPrint,
      };
      return register ? api.patch(`/cash-registers/${register.id}`, { ...body, isActive: form.isActive }) : api.post('/cash-registers', { ...body, establishmentId, code: form.code });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-registers'] });
      onClose();
    },
  });
  return (
    <Modal open title={register ? `Caisse ${register.code}` : 'Nouvelle caisse'} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code">
            <Input required disabled={!!register} maxLength={12} value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} />
          </Field>
          <Field label="Nom">
            <Input required minLength={2} maxLength={60} value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
        </div>
        <Field label="Emplacement de stock vendu" hint="Les produits vendus à cette caisse sortent de cet emplacement.">
          <LocationSelect establishmentId={establishmentId} value={form.stockLocationId} onChange={(v) => set('stockLocationId', v)} />
        </Field>
        <Field label="Impression des tickets">
          <Select value={form.printerType} onChange={(e) => set('printerType', e.target.value as PrinterType)}>
            {Object.entries(PRINTER_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        {form.printerType === 'NETWORK' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Adresse IP de l’imprimante" hint="Réseau local, ex. 192.168.1.50">
              <Input required value={form.printerHost} onChange={(e) => set('printerHost', e.target.value.trim())} />
            </Field>
            <Field label="Port">
              <Input type="number" min={1} max={65535} required value={form.printerPort} onChange={(e) => set('printerPort', e.target.value)} />
            </Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Largeur du papier">
            <Select value={form.paperWidth} onChange={(e) => set('paperWidth', e.target.value)}>
              <option value="80">80 mm</option>
              <option value="58">58 mm</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 pt-6 text-sm">
            <input type="checkbox" checked={form.autoPrint} onChange={(e) => set('autoPrint', e.target.checked)} /> Imprimer automatiquement après chaque vente
          </label>
        </div>
        {register && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} /> Caisse active
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
