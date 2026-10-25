import { useEffect, useState } from 'react';
import type { Period } from '../lib/reporting-types';
import { Field, Input } from './ui';

/** Même limite que l'API de pilotage (bornes incluses). */
const MAX_DAYS = 366;
const DAY = 86_400_000;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Date AAAA-MM-JJ réelle (Abidjan = UTC+0), sinon null. */
function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || isoDay(d) !== value ? null : d;
}

/** Message d'erreur de la période, ou null si elle est valide. */
export function validatePeriod(p: Period): string | null {
  const from = parseDay(p.from);
  const to = parseDay(p.to);
  if (!from || !to) return 'Dates invalides (AAAA-MM-JJ)';
  if (to < from) return 'La fin de période précède son début';
  if ((to.getTime() - from.getTime()) / DAY + 1 > MAX_DAYS) return `Période limitée à ${MAX_DAYS} jours`;
  return null;
}

/** Du 1er du mois en cours à aujourd'hui. */
export function currentMonth(): Period {
  const today = new Date();
  return { from: isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: isoDay(today) };
}

/** « from=…&to=… » pour les routes /pilotage (l'établissement suit l'en-tête courant). */
export const periodQuery = (p: Period) => `from=${p.from}&to=${p.to}`;

/**
 * Période du… au… : `onChange` n'est appelé qu'avec une période valide,
 * l'erreur locale est affichée sinon (aucune requête sur une période fausse).
 */
export function DateRange({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const [draft, setDraft] = useState(value);
  // Période changée par le parent (raccourci, réinitialisation) : le brouillon la reprend.
  useEffect(() => setDraft({ from: value.from, to: value.to }), [value.from, value.to]);
  const error = validatePeriod(draft);
  const set = (k: keyof Period) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = { ...draft, [k]: e.target.value };
    setDraft(next);
    if (!validatePeriod(next)) onChange(next);
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Du">
          <Input className="w-40" type="date" required value={draft.from} max={draft.to || undefined} onChange={set('from')} />
        </Field>
        <Field label="Au">
          <Input className="w-40" type="date" required value={draft.to} min={draft.from || undefined} onChange={set('to')} />
        </Field>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
