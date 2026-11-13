// What the CMA is for (R-CMA-9, SoP 11-1; E606, E607): the purpose chips (one tap each), the inspection and its date,
// the agent's notes for the report and, for a purpose other than a listing price or a buyer's offer, the five
// disclosure items. Saved with PATCH; the draft re-runs. VERIFY WITH COUNSEL: the labels and hints (words.ts).
import { type FormEvent, useId, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../design/index.js';
import { CMA_INSPECTIONS, CMA_PURPOSES, type CmaInspection, type CmaPurpose, type CmaView, DISCLOSURE_FIELDS, type DisclosureField, type PatchBody, day } from './lib.js';
import { DISCLOSURE_WORDS, INSPECTION_WORDS, PURPOSE_WORDS, W } from './words.js';

const selectClass = 'min-h-tap w-full rounded-xl border border-line bg-surface px-3 text-[17px] text-ink';
const textareaClass = 'min-h-[96px] w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink';

type Draft = { inspection: CmaInspection; inspectedOn: string; notes: string } & Record<DisclosureField, string>;
const draftOf = (v: CmaView): Draft => ({
  inspection: v.inspection,
  inspectedOn: v.inspectedOn ?? '',
  notes: v.notes ?? '',
  ...(Object.fromEntries(DISCLOSURE_FIELDS.map((f) => [f, v.disclosure[f] ?? ''])) as Record<DisclosureField, string>),
});

/** The PATCH body of what changed (empty text is null). */
export function purposeBody(v: CmaView, d: Draft): PatchBody {
  const b: PatchBody = {};
  if (d.inspection !== v.inspection) b.inspection = d.inspection;
  const on = d.inspection === 'none' ? '' : d.inspectedOn;
  if (d.inspection !== 'none' && (on || null) !== v.inspectedOn) b.inspectedOn = on || null;
  if ((d.notes.trim() || null) !== (v.notes ?? null)) b.notes = d.notes.trim() || null;
  if (v.purpose === 'other') {
    const disclosure: Partial<Record<DisclosureField, string | null>> = {};
    for (const f of DISCLOSURE_FIELDS) if ((d[f].trim() || null) !== (v.disclosure[f] ?? null)) disclosure[f] = d[f].trim() || null;
    if (Object.keys(disclosure).length > 0) b.disclosure = disclosure;
  }
  return b;
}

export function Purpose({ view, busy, error, onSave }: { view: CmaView; busy: boolean; error: string | null; onSave: (b: PatchBody) => Promise<boolean> }) {
  const hid = useId();
  const groupId = useId();
  const inspId = useId();
  const notesId = useId();
  const notesHint = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(view));
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [seen, setSeen] = useState(view.updatedAt);
  if (seen !== view.updatedAt) {
    // the draft re-ran (here or from another control): start from what is stored
    setSeen(view.updatedAt);
    setDraft(draftOf(view));
  }
  const edit = view.canEdit;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setSavedAt(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const pick = async (p: CmaPurpose) => {
    if (p === view.purpose || busy) return;
    await onSave({ purpose: p });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const b = purposeBody(view, draft);
    if (Object.keys(b).length === 0) return;
    if (await onSave(b)) setSavedAt(view.updatedAt);
  };
  const missing = new Set(view.disclosureMissing);

  return (
    <Card className="flex flex-col gap-3" aria-labelledby={hid}>
      <h2 id={hid} className="text-[17px] font-semibold text-ink">
        {W.purposeHeading}
      </h2>
      <div role="group" aria-labelledby={groupId} className="flex flex-col gap-1.5">
        <p id={groupId} className="text-[15px] font-medium text-ink">
          {W.purposeGroup}
        </p>
        <div className="flex flex-wrap gap-2">
          {CMA_PURPOSES.map((p) => (
            <Button key={p} variant={p === view.purpose ? 'primary' : 'secondary'} aria-pressed={p === view.purpose} disabled={!edit} onClick={() => void pick(p)}>
              {PURPOSE_WORDS[p]}
            </Button>
          ))}
        </div>
      </div>
      {edit ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={inspId} className="text-[15px] font-medium text-ink">
              {W.inspectionLabel}
            </label>
            <select id={inspId} className={selectClass} value={draft.inspection} onChange={(e) => set('inspection', e.target.value as CmaInspection)}>
              {CMA_INSPECTIONS.map((i) => (
                <option key={i} value={i}>
                  {INSPECTION_WORDS[i]}
                </option>
              ))}
            </select>
          </div>
          {draft.inspection !== 'none' ? (
            <TextField label={W.inspectedOnLabel} type="date" value={draft.inspectedOn} onChange={(e) => set('inspectedOn', e.target.value)} error={missing.has('inspectedOn') ? W.neededBeforeSharing : null} />
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={notesId} className="text-[15px] font-medium text-ink">
              {W.notesLabel}
            </label>
            <textarea id={notesId} aria-describedby={notesHint} className={textareaClass} maxLength={4000} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
            <p id={notesHint} className="text-[14px] text-ink-muted">
              {W.notesHint}
            </p>
          </div>
          {view.purpose === 'other' ? (
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-[15px] text-ink-muted">{W.sopIntro}</legend>
              {DISCLOSURE_FIELDS.map((f) => (
                <TextField key={f} label={DISCLOSURE_WORDS[f].label} hint={DISCLOSURE_WORDS[f].hint} maxLength={2000} value={draft[f]} onChange={(e) => set(f, e.target.value)} error={missing.has(f) ? W.neededBeforeSharing : null} />
              ))}
            </fieldset>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          {savedAt !== null && !error ? <Notice tone="ok">{W.saved}</Notice> : null}
          <Button type="submit" className="self-start" pending={busy}>
            {W.savePurpose}
          </Button>
        </form>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[15px]">
          <dt className="text-ink-muted">{W.inspectionLabel}</dt>
          <dd className="text-ink">
            {INSPECTION_WORDS[view.inspection]}
            {view.inspectedOn ? `, ${day(view.inspectedOn)}` : ''}
          </dd>
          {view.notes ? (
            <>
              <dt className="text-ink-muted">{W.notesLabel}</dt>
              <dd className="whitespace-pre-wrap text-ink">{view.notes}</dd>
            </>
          ) : null}
        </dl>
      )}
    </Card>
  );
}
