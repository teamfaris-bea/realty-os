// Stages, tags and custom fields of an import (PARITY_PLAN module 65; R-PAR-46, R-PAR-18).
//
// Before the contacts are approved the Admin sees, in plain words:
//   - every stage of the source with how many people are in it, and picks one of the eight stages for each
//     (a label nobody picked blocks the approval: a stage never silently becomes New);
//   - whether each source stage is kept as the tag "FUB stage: <label>" (default on, Q-PAR-1);
//   - the tag plan (already here, new, over the limit, protected, and how many DNC-looking tags become real opt-outs);
//   - each custom field with a suggested type: create it, map it onto an existing field, or keep it as text.
//     A field that reads like a protected attribute can only be kept as text.
// Saving resets the contacts check, which then has to be run (and approved) again.
import { useState } from 'react';
import { Button, Card, Notice } from '../../design/index.js';
import { plural } from '../admin/lib/format.js';
import { useAction } from '../admin/lib/hooks.js';
import type { ImportBatch } from '../admin/lib/types.js';
import { ErrorLine, Section, SelectField } from '../admin/lib/ui.js';
import { FIELD_TYPE_LABEL, type FieldActionView, PARITY_STAGES, type ParityResponse, STAGE_KEY_LABEL } from './lib.js';

type FieldChoice = 'skip' | `create:${string}` | `existing:${string}`;

function choiceOf(a: FieldActionView): FieldChoice {
  return a.action === 'skip' ? 'skip' : a.action === 'create' ? `create:${a.type}` : `existing:${a.fieldId}`;
}

export function ParityMapping({ batch, data, onDone, refetch }: { batch: ImportBatch; data: ParityResponse; onDone(t: string): void; refetch(): void }) {
  const [stageMap, setStageMap] = useState<Record<string, string>>(() => Object.fromEntries(data.stages.map((s) => [s.label, s.mapped ?? ''])));
  const [keep, setKeep] = useState(data.options.keepStageAsTag);
  const [fields, setFields] = useState<Record<string, FieldChoice>>(() => Object.fromEntries(data.fields.map((f) => [f.sourceKey, choiceOf(f.action)])));
  const a = useAction<Record<string, unknown>, ParityResponse>('PUT', { invalidate: [['imports', batch.id]] });
  const source = batch.source === 'csv' ? 'your file' : 'Follow Up Boss';
  const unmapped = data.stages.filter((s) => !stageMap[s.label]).length;

  const save = async () => {
    const body = {
      stageMap: Object.fromEntries(Object.entries(stageMap).filter(([, v]) => v !== '')),
      keepStageAsTag: keep,
      fields: Object.fromEntries(
        data.fields.map((f) => {
          const c = fields[f.sourceKey] ?? 'skip';
          if (c === 'skip' || f.protected) return [f.sourceKey, { action: 'skip' }];
          const [kind, rest] = c.split(':') as [string, string];
          return [f.sourceKey, kind === 'create' ? { action: 'create', type: rest, label: f.label } : { action: 'existing', fieldId: rest }];
        }),
      ),
    };
    const r = await a.run(`/imports/${batch.id}/parity`, body);
    if (r.ok) {
      refetch();
      onDone(r.data.blockers.length === 0 ? 'Saved. Run the contacts check again.' : 'Saved. Some choices are still needed.');
    }
  };

  return (
    <Section title="Stages, tags and custom fields" description={`How what's in ${source} lands here. Saving resets the contacts check; run it again before approving.`}>
      <Card className="flex flex-col gap-1">
        <ul className="flex flex-col gap-1 text-[15px] text-ink">
          {data.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Card>

      <Card className="flex flex-col gap-3">
        <h3 className="text-[16px] font-semibold text-ink">Stages</h3>
        {data.stages.length === 0 ? <p className="text-[15px] text-ink-muted">No stages in {source}: everyone starts as New.</p> : null}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.stages.map((s) => (
            <SelectField key={s.label} label={`${s.label} (${plural(s.people, 'person', 'people')})`} value={stageMap[s.label] ?? ''} onChange={(e) => setStageMap((m) => ({ ...m, [s.label]: e.target.value }))}>
              <option value="">Pick a stage</option>
              {PARITY_STAGES.map((k) => (
                <option key={k} value={k}>
                  {STAGE_KEY_LABEL[k]}
                  {s.suggested === k ? ' (suggested)' : ''}
                </option>
              ))}
            </SelectField>
          ))}
        </div>
        {unmapped > 0 ? <Notice tone="warn">{plural(unmapped, 'stage still needs', 'stages still need')} a match before the contacts can be approved.</Notice> : null}
        <label className="flex min-h-tap items-center gap-3 text-[16px] text-ink">
          <input type="checkbox" className="h-5 w-5" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          Also keep each {batch.source === 'csv' ? 'original' : 'Follow Up Boss'} stage as a tag
        </label>
      </Card>

      <Card className="flex flex-col gap-2">
        <h3 className="text-[16px] font-semibold text-ink">Tags</h3>
        <p className="text-[15px] text-ink">
          {data.tags.distinct === 0 ? `No tags in ${source}.` : `${plural(data.tags.distinct, 'tag')}: ${data.tags.existing} already here, ${data.tags.toCreate} new${data.tags.overLimit > 0 ? `, ${data.tags.overLimit} over the limit` : ''}.`}
        </p>
        {data.tags.overLimitNames.length > 0 ? <p className="text-[14px] text-ink-muted">Over the limit (kept as text on each person): {data.tags.overLimitNames.join(', ')}</p> : null}
        <p className="text-[14px] text-ink-muted">Tags never decide who can be contacted. A tag like "DNC" or "Opted out" is also recorded as a real opt-out.</p>
      </Card>

      {data.fields.length > 0 ? (
        <Card className="flex flex-col gap-3">
          <h3 className="text-[16px] font-semibold text-ink">Custom fields</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {data.fields.map((f) => (
              <div key={f.sourceKey} className="flex flex-col gap-1">
                <SelectField
                  label={`${f.label} (${plural(f.people, 'value')})`}
                  value={f.protected ? 'skip' : (fields[f.sourceKey] ?? 'skip')}
                  disabled={f.protected}
                  onChange={(e) => setFields((m) => ({ ...m, [f.sourceKey]: e.target.value as FieldChoice }))}
                >
                  <option value="skip">Keep as text only</option>
                  {(['text', 'number', 'date', 'single_select', 'multi_select'] as const).map((t) => (
                    <option key={t} value={`create:${t}`}>
                      New field: {FIELD_TYPE_LABEL[t]}
                      {f.suggestedType === t ? ' (suggested)' : ''}
                    </option>
                  ))}
                  {data.existingFields.map((x) => (
                    <option key={x.id} value={`existing:${x.id}`}>
                      Existing field: {x.label}
                    </option>
                  ))}
                </SelectField>
                {f.protected ? <p className="text-[14px] text-ink-muted">Reads like a protected attribute, so it stays as text on the person and never becomes a field.</p> : null}
                {!f.protected && f.misfit > 0 ? <p className="text-[14px] text-ink-muted">{plural(f.misfit, 'value does', 'values do')} not fit and will stay as text.</p> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <ErrorLine message={a.error?.message} />
      <div>
        <Button variant="secondary" pending={a.pending} onClick={() => void save()}>
          Save stages, tags and fields
        </Button>
      </div>
    </Section>
  );
}
