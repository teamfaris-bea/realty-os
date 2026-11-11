// Admin → Stage labels (R-PAR-13): the fixed eight stages, each with an optional display label of 1-24
// characters (lists, code and imports keep the keys). The API is module 57's (lane L1, "stage + labels");
// this page talks to GET/PUT /settings/stage-labels and, until that lane merges, says plainly that
// labels cannot be saved yet instead of pretending.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Notice, TextField } from '../../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../../shell/index.js';
import { useMutate } from '../../feed/lib/hooks.js';
import { AgentSheetsProvider, useAgentSheets } from '../../feed/lib/AgentSheets.js';
import { LEAD_STAGE_LABEL } from '../../people/api.js';
import { LISTS_ERROR_MESSAGES } from '../../people/messages.js';

export const STAGE_KEYS = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const;

export default function StageLabelsPage() {
  return (
    <AgentSheetsProvider>
      <StageLabels />
    </AgentSheetsProvider>
  );
}

function StageLabels() {
  const api = useApi();
  const q = useQuery<{ labels: Record<string, string> }, ApiError>({ queryKey: ['settings', 'stage-labels'], queryFn: ({ signal }) => api.get('/settings/stage-labels', { signal }), retry: false });
  const [labels, setLabels] = useState<Record<string, string> | null>(null);
  const save = useMutate<{ labels: Record<string, string> }, unknown>('PUT', { invalidate: [['settings', 'stage-labels']] });
  const sheets = useAgentSheets();
  const current = labels ?? q.data?.labels ?? {};
  const unavailable = q.isError && q.error.code === 'NOT_FOUND';
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[15px] text-ink-muted">Rename how a stage reads for your team (1-24 characters). The stages themselves stay the same eight, so lists and imports keep working.</p>
      {unavailable ? <Notice tone="info" title="Stage labels can't be saved yet">They arrive with the people and notes update. The default names below are in use.</Notice> : null}
      {q.isError && !unavailable ? <Notice tone="error">{messageFor(q.error, LISTS_ERROR_MESSAGES)}</Notice> : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const clean = Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''));
          const r = await save.run('/settings/stage-labels', { labels: clean });
          if (r.ok) sheets.announce('Stage labels saved');
        }}
      >
        {STAGE_KEYS.map((k) => (
          <TextField key={k} label={LEAD_STAGE_LABEL[k]!} value={current[k] ?? ''} placeholder={LEAD_STAGE_LABEL[k]} maxLength={24} disabled={unavailable} onChange={(e) => setLabels({ ...current, [k]: e.target.value })} />
        ))}
        <Button type="submit" className="self-start" disabled={unavailable || save.pending}>
          Save labels
        </Button>
        {save.error ? <Notice tone="error">{messageFor(save.error.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
      </form>
    </div>
  );
}
