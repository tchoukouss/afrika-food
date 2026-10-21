import { Printer, RotateCcw } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { PRINT_STATUS, PrintJob, TicketText } from '../../lib/sales-types';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Impression par le navigateur (repli de l'imprimante réseau, décision 12) :
 * le ticket est rendu dans un cadre invisible à la largeur du papier, puis
 * la fenêtre d'impression du système s'ouvre.
 */
export function printLines(lines: string[], width: number, title = 'Ticket') {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const paper = width <= 32 ? '58mm' : '80mm';
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>@page{size:${paper} auto;margin:2mm}body{margin:0;font-family:'Courier New',monospace;font-size:${width <= 32 ? 10 : 11}px;line-height:1.25}pre{margin:0;white-space:pre}</style>
</head><body><pre>${escape(lines.join('\n'))}</pre></body></html>`);
  doc.close();
  const win = frame.contentWindow!;
  const cleanup = () => setTimeout(() => frame.remove(), 1000);
  win.onafterprint = cleanup;
  setTimeout(() => {
    win.focus();
    win.print();
    cleanup();
  }, 50);
}

export function TicketPreview({ ticket }: { ticket: TicketText }) {
  return (
    <pre className="mx-auto max-h-96 w-fit overflow-auto rounded-lg border border-stone-200 bg-stone-50 p-3 font-mono text-[11px] leading-tight text-stone-800">
      {ticket.lines.join('\n')}
    </pre>
  );
}

/** État d'une impression avec relance (imprimante réseau) ou repli navigateur. */
export function PrintStatus({ job, ticket, onDone }: { job: PrintJob | null; ticket: TicketText; onDone?: (job: PrintJob) => void }) {
  const qc = useQueryClient();
  const action = useMutation({
    mutationFn: (kind: 'retry' | 'browser') => api.post<{ print: PrintJob; ticket: TicketText }>(`/print-jobs/${job!.id}/${kind}`),
    onSuccess: (res, kind) => {
      if (kind === 'browser') printLines(res.ticket.lines, res.ticket.width);
      qc.invalidateQueries({ queryKey: ['sales'] });
      onDone?.(res.print);
    },
  });
  if (!job) {
    return (
      <Button variant="secondary" onClick={() => printLines(ticket.lines, ticket.width)}>
        <Printer className="size-4" /> Imprimer le ticket
      </Button>
    );
  }
  const s = PRINT_STATUS[job.status];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        Ticket : <Badge tone={s.tone}>{s.label}</Badge>
        {job.status === 'BROWSER' && (
          <Button variant="secondary" onClick={() => printLines(ticket.lines, ticket.width)}>
            <Printer className="size-4" /> Imprimer
          </Button>
        )}
      </div>
      {job.status === 'FAILED' && (
        <>
          <Alert>{job.lastError ?? 'Impression impossible'}</Alert>
          <div className="flex flex-wrap gap-2">
            <Button loading={action.isPending && action.variables === 'retry'} onClick={() => action.mutate('retry')}>
              <RotateCcw className="size-4" /> Relancer l’imprimante
            </Button>
            <Button variant="secondary" loading={action.isPending && action.variables === 'browser'} onClick={() => action.mutate('browser')}>
              <Printer className="size-4" /> Imprimer via le navigateur
            </Button>
          </div>
        </>
      )}
      {action.error && <Alert>{(action.error as ApiError).message}</Alert>}
    </div>
  );
}
