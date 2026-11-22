// Deal stages of a Follow Up Boss import. Every stage name in the snapshot, how many deals
// are in it, and the Realty OS stage it lands as (or "Don't import"). A name with no match
// waits in review. Saving writes the waiting deals, and does not write a deal that is already here.
import { useState } from 'react';
import { Button, Card, Notice } from '../../design/index.js';
import { plural } from '../admin/lib/format.js';
import { useAction } from '../admin/lib/hooks.js';
import type { ImportBatch } from '../admin/lib/types.js';
import { ErrorLine, Section, SelectField } from '../admin/lib/ui.js';
import { DEAL_STAGES, DEAL_STAGE_LABEL, type DealStagesResponse } from './lib.js';

export function DealStageMap({ batch, data, onDone, refetch }: { batch: ImportBatch; data: DealStagesResponse; onDone(t: string): void; refetch(): void }) {
  const [choices, setChoices] = useState<Record<string, string> | null>(null);
  const a = useAction<Record<string, unknown>, DealStagesResponse>('PUT', { invalidate: [['imports', batch.id]] });
  const current = choices ?? Object.fromEntries(data.stages.map((s) => [s.label, s.choice ?? '']));
  const waiting = data.stages.filter((s) => !s.suggested && !current[s.label]).length;

  const save = async () => {
    const dealStageMap = Object.fromEntries(Object.entries(current).filter(([, v]) => v !== ''));
    const r = await a.run(`/imports/${batch.id}/deal-stages`, { dealStageMap });
    if (!r.ok) return;
    setChoices(null);
    refetch();
    const parts = ['Saved.'];
    if (r.data.importedNow > 0) parts.push(`${plural(r.data.importedNow, 'deal that was waiting is in', 'deals that were waiting are in')}.`);
    if (r.data.plannedNow > 0) parts.push(`${plural(r.data.plannedNow, 'deal will come in when you import deals', 'deals will come in when you import deals')}.`);
    if (r.data.ignoredNow > 0) parts.push(`${plural(r.data.ignoredNow, 'deal was left out', 'deals were left out')}.`);
    if (r.data.approvalCleared) parts.push('Approve the deals step again before importing it.');
    onDone(parts.join(' '));
  };

  return (
    <Section title="Deal stages" description="Each Follow Up Boss deal stage lands as one stage here, or is left out. A stage with no match waits until you choose. Saving applies that to the deals that are waiting, and does not add a deal that is already here.">
      {data.stages.length === 0 ? <p className="text-[15px] text-ink-muted">No deal stages in Follow Up Boss.</p> : null}
      {data.stages.length > 0 ? (
        <Card className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {data.stages.map((s) => (
              <SelectField key={s.label} label={`${s.label} (${plural(s.deals, 'deal')})`} value={current[s.label] ?? ''} onChange={(e) => setChoices({ ...current, [s.label]: e.target.value })}>
                <option value="">{s.suggested ? `Use the built-in match (${DEAL_STAGE_LABEL[s.suggested as keyof typeof DEAL_STAGE_LABEL] ?? s.suggested})` : 'Pick a stage'}</option>
                {DEAL_STAGES.map((k) => (
                  <option key={k} value={k}>
                    {DEAL_STAGE_LABEL[k]}
                    {s.suggested === k ? ' (suggested)' : ''}
                  </option>
                ))}
                <option value="ignore">Don't import</option>
              </SelectField>
            ))}
          </div>
          {data.unmappedDeals > 0 ? <Notice tone="warn">{plural(data.unmappedDeals, 'deal is waiting', 'deals are waiting')} because the stage is not mapped.</Notice> : null}
          {data.unmappedDeals === 0 && waiting > 0 ? <Notice tone="warn">{plural(waiting, 'stage still needs', 'stages still need')} a match. Until then, those deals wait.</Notice> : null}
        </Card>
      ) : null}
      <ErrorLine message={a.error?.message} />
      <div>
        <Button variant="secondary" pending={a.pending} onClick={() => void save()}>
          Save deal stages
        </Button>
      </div>
    </Section>
  );
}
