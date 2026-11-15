// b18 round 3 item 1 (owner boundary B18S-5; E728): imported source labels and the lead source each one means.
//
// A Follow Up Boss or CSV import keeps a person's source only as a label. The Owner maps a label, exactly as the import
// stored it, to a lead source (PUT /lead-sources/import-labels, 🔒: the shell asks for the password again); a source
// with "No automated contact for leads from this source" on then covers the people that label brought in. The import's
// preview and summary show the labels found (ImportLabelList, from GET /imports/:id/parity and /report), and the lead
// sources page shows every label in the CRM (ImportLabelsSection, from GET /lead-sources/import-labels). Each line is
// the API's sentence; only the Owner gets the choice, everyone else is told who makes it.
import { useQuery } from '@tanstack/react-query';
import { Card, Notice } from '../../design/index.js';
import { type ApiError, useApi, useSession } from '../../shell/index.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import { SelectField, StatusLine } from '../admin/lib/ui.js';
import { SOURCE_KEYS, useOverview } from './hooks.js';
import { sentenceFor } from './messages.js';
import { madeSafeWords } from './words.js';

export interface ImportLabelView {
  label: string;
  people: number;
  leadSourceId: string | null;
  leadSourceName: string | null;
  noAutomatedContact: boolean;
  sentence: string;
}

export const IMPORT_LABELS_KEY = ['lead-sources', 'import-labels'] as const;
export const OWNER_MAPS_LABELS = 'Only the Owner maps an imported source label to a lead source.';
const NOT_MAPPED = '';

/** The labels with their sentences; the Owner picks the lead source each one means (or none). */
export function ImportLabelList({ rows, onChanged, empty }: { rows: readonly ImportLabelView[]; onChanged(): void; empty?: string }) {
  const { session } = useSession();
  const owner = session?.tenant?.role === 'owner';
  const sources = useOverview(owner).data?.sources ?? [];
  const [status, announce] = useAnnounce(8000);
  const a = useAction<{ label: string; leadSourceId: string | null }, { label: ImportLabelView; pausing: number; stopping: number; withdrawn?: number }>('PUT', { invalidate: [[...IMPORT_LABELS_KEY], ...SOURCE_KEYS] });
  const choose = async (label: string, id: string) => {
    const r = await a.run('/lead-sources/import-labels', { label, leadSourceId: id === NOT_MAPPED ? null : id });
    if (!r.ok) return;
    onChanged();
    announce(`${r.data.label.sentence}${madeSafeWords(r.data)}`);
  };
  if (rows.length === 0) return empty ? <p className="text-[15px] text-ink-muted">{empty}</p> : null;
  return (
    <div className="flex flex-col gap-3">
      <StatusLine text={status} />
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.label} className="flex flex-col gap-2">
            <p className="text-[15px] text-ink">{r.sentence}</p>
            {owner ? (
              <SelectField label={`Lead source for "${r.label}"`} value={r.leadSourceId ?? NOT_MAPPED} disabled={a.pending} onChange={(e) => void choose(r.label, e.target.value)}>
                <option value={NOT_MAPPED}>Not mapped</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.noAiCare ? ' (no automated contact)' : ''}
                  </option>
                ))}
              </SelectField>
            ) : null}
          </li>
        ))}
      </ul>
      {owner ? null : <p className="text-[14px] text-ink-muted">{OWNER_MAPS_LABELS}</p>}
      {a.error ? <Notice tone="error">{sentenceFor(a.error)}</Notice> : null}
    </div>
  );
}

/** The lead sources page: every imported label in the CRM, mapped afterwards as at import time. */
export function ImportLabelsSection() {
  const api = useApi();
  const q = useQuery<{ labels: ImportLabelView[]; canChange: boolean }, ApiError>({ queryKey: IMPORT_LABELS_KEY, queryFn: ({ signal }) => api.get('/lead-sources/import-labels', { signal }) });
  if (q.isError) return <Notice tone="error">{sentenceFor(q.error)}</Notice>;
  if (!q.data || q.data.labels.length === 0) return null;
  return (
    <section aria-label="Imported source labels">
      <Card className="flex flex-col gap-3">
        <h2 className="text-[18px] font-semibold text-ink">Imported source labels</h2>
        <p className="text-[15px] text-ink-muted">People brought in from Follow Up Boss or a file carry their source as a label. A label counts as a lead source once it is mapped to one.</p>
        <ImportLabelList rows={q.data.labels} onChanged={() => void q.refetch()} />
      </Card>
    </section>
  );
}
