// Admin → Stage labels (R-PAR-13): the fixed eight stages, each with an optional display label of 1-24
// characters (lists, code and imports keep the keys). The API is module 57's: GET /stage-labels (members)
// and PUT /stage-labels (Owner/Admin, settings.stage_labels; audited as settings.changed). Saving sends the
// whole set: a field left empty goes back to the stage's own name. A person's stage pill shows the label.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Notice, TextField } from '../../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../../shell/index.js';
import { useMutate } from '../../feed/lib/hooks.js';
import { AgentSheetsProvider, useAgentSheets } from '../../feed/lib/AgentSheets.js';
import { DEFAULT_GUIDE, STAGE_LABELS_KEY, type StageLabelsResponse } from '../../people/stageGuide.js';
import { LISTS_ERROR_MESSAGES } from '../../people/messages.js';

export { STAGE_LABELS_KEY };

export default function StageLabelsPage() {
  return (
    <AgentSheetsProvider>
      <StageLabels />
    </AgentSheetsProvider>
  );
}

function StageLabels() {
  const api = useApi();
  const q = useQuery<StageLabelsResponse, ApiError>({ queryKey: STAGE_LABELS_KEY, queryFn: ({ signal }) => api.get('/stage-labels', { signal }) });
  const [labels, setLabels] = useState<Record<string, string> | null>(null);
  // a person's page reads the labels with their details (the stage pill): refresh those too
  const save = useMutate<{ labels: Record<string, string> }, StageLabelsResponse>('PUT', { invalidate: [[...STAGE_LABELS_KEY], ['people', 'details']] });
  const sheets = useAgentSheets();
  const current = labels ?? q.data?.labels ?? {};
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[15px] text-ink-muted">Rename how a stage reads for your team (1-24 characters). The stages themselves stay the same eight, so lists and imports keep working.</p>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, LISTS_ERROR_MESSAGES)}</Notice> : null}
      {q.isSuccess ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const clean = Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''));
            const r = await save.run('/stage-labels', { labels: clean });
            if (r.ok) {
              setLabels(null);
              sheets.announce('Stage labels saved');
            }
          }}
        >
          {/* R-STG-1: each field is named by the stage's own (default) label and says what the stage means: a new name
              changes how it reads, never what it is */}
          {DEFAULT_GUIDE.map((s) => (
            <TextField key={s.key} label={s.label} hint={s.definition} value={current[s.key] ?? ''} placeholder={s.label} maxLength={24} onChange={(e) => setLabels({ ...current, [s.key]: e.target.value })} />
          ))}
          <Button type="submit" className="self-start" disabled={save.pending}>
            Save labels
          </Button>
          {save.error ? <Notice tone="error">{messageFor(save.error.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
        </form>
      ) : null}
    </div>
  );
}
