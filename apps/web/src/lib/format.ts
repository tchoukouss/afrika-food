const xof = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** 250000 → « 250 000 FCFA » (le XOF n'a pas de centimes). */
export function formatXOF(amount: number | string | bigint | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  return `${xof.format(Number(amount))} FCFA`;
}

const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Abidjan' });
const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'Africa/Abidjan' });

export function formatDateTime(value: string | Date | null | undefined): string {
  return value ? dateTime.format(new Date(value)) : '—';
}

export function formatDate(value: string | Date | null | undefined): string {
  return value ? date.format(new Date(value)) : '—';
}
