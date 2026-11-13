// The subject's facts, each with where it came from (MLS sales, the team's listing, entered by the agent, or not
// known; R-CMA-8, E373), and the editor that re-runs the draft (PATCH subjectFacts). Only property, size and
// structure facts exist here: the request body is strict, so nothing about people can be entered (R-CMA-2).
import { type FormEvent, useId, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../design/index.js';
import { CMA_PROPERTY_TYPES, type CmaPropertyType, type CmaView, type Fact, type SubjectFactsBody, day, fullAddress, integer, money, tenths } from './lib.js';
import { FACT_WORDS, LISTING_STATUS_WORDS, PROPERTY_TYPE_WORDS, W, sourceWords } from './words.js';

type FactKey = keyof Omit<CmaView['subject']['facts'], 'agentEnteredSqft' | 'mapLocation'>;
const ORDER: FactKey[] = ['propertyType', 'sqft', 'beds', 'bathsX10', 'yearBuilt', 'lotSqft', 'garageSpacesX10', 'storiesX10', 'poolPrivate', 'subdivision'];

function valueWords(k: FactKey, f: Fact<unknown>): string {
  const v = f.value;
  if (v === null || v === undefined) return W.notKnown;
  switch (k) {
    case 'propertyType':
      return PROPERTY_TYPE_WORDS[v as CmaPropertyType] ?? String(v);
    case 'sqft':
      return `${integer(v as number)} sq ft`;
    case 'lotSqft':
      return `${integer(v as number)} sq ft`;
    case 'bathsX10':
    case 'garageSpacesX10':
    case 'storiesX10':
      return tenths(v as number) ?? W.notKnown;
    case 'poolPrivate':
      return v ? W.yes : W.no;
    default:
      return String(v);
  }
}

/** The editor's text for a fact (tenths as a decimal); '' when not known. */
function draftOf(k: FactKey, f: Fact<unknown>): string {
  if (f.value === null || f.value === undefined) return '';
  if (k === 'bathsX10' || k === 'garageSpacesX10' || k === 'storiesX10') return tenths(f.value as number) ?? '';
  if (k === 'poolPrivate') return f.value ? 'yes' : 'no';
  return String(f.value);
}

const BOUNDS: Partial<Record<FactKey, [number, number, boolean]>> = {
  // [min, max, tenths]
  sqft: [100, 100_000, false],
  beds: [0, 50, false],
  bathsX10: [0, 500, true],
  yearBuilt: [1600, 2100, false],
  lotSqft: [0, 1e9, false],
  garageSpacesX10: [0, 500, true],
  storiesX10: [0, 500, true],
};

/** The PATCH body of the changed facts, or the keys that do not parse. Pure (SubjectFacts.test via CmaPage tests). */
export function factsBody(facts: CmaView['subject']['facts'], draft: Record<FactKey, string>): { body: SubjectFactsBody; invalid: FactKey[] } {
  const body: Record<string, unknown> = {};
  const invalid: FactKey[] = [];
  for (const k of ORDER) {
    const before = draftOf(k, facts[k] as Fact<unknown>);
    const now = draft[k].trim();
    if (now === before) continue;
    if (k === 'propertyType') {
      if (now) body[k] = now;
      continue;
    }
    if (k === 'poolPrivate') {
      body[k] = now === 'yes' ? true : now === 'no' ? false : null;
      continue;
    }
    if (k === 'subdivision') {
      if (now.length > 120) invalid.push(k);
      else body[k] = now || null;
      continue;
    }
    const b = BOUNDS[k]!;
    if (now === '') {
      if (k === 'sqft') invalid.push(k);
      else body[k] = null;
      continue;
    }
    const n = Number(now);
    const v = b[2] ? Math.round(n * 10) : n;
    if (!Number.isFinite(n) || !Number.isInteger(v) || v < b[0] || v > b[1]) invalid.push(k);
    else body[k] = v;
  }
  return { body: body as SubjectFactsBody, invalid };
}

const selectClass = 'min-h-tap w-full rounded-xl border border-line bg-surface px-3 text-[17px] text-ink';

export function SubjectFacts({ view, busy, error, onSave }: { view: CmaView; busy: boolean; error: string | null; onSave: (b: SubjectFactsBody) => Promise<boolean> }) {
  const hid = useId();
  const typeId = useId();
  const poolId = useId();
  const facts = view.subject.facts;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<FactKey, string>>(() => Object.fromEntries(ORDER.map((k) => [k, draftOf(k, facts[k] as Fact<unknown>)])) as Record<FactKey, string>);
  const [invalid, setInvalid] = useState<FactKey[]>([]);
  const start = () => {
    setDraft(Object.fromEntries(ORDER.map((k) => [k, draftOf(k, facts[k] as Fact<unknown>)])) as Record<FactKey, string>);
    setInvalid([]);
    setEditing(true);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = factsBody(facts, draft);
    setInvalid(r.invalid);
    if (r.invalid.length > 0) return;
    if (Object.keys(r.body).length === 0) {
      setEditing(false);
      return;
    }
    if (await onSave(r.body)) setEditing(false);
  };
  const set = (k: FactKey) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const err = (k: FactKey) => (invalid.includes(k) ? W.numberInvalid : null);

  return (
    <Card className="flex flex-col gap-3" aria-labelledby={hid}>
      <h2 id={hid} className="text-[17px] font-semibold text-ink">
        {W.subjectHeading}
      </h2>
      <p className="text-[15px] text-ink [overflow-wrap:anywhere]">{fullAddress(view.subject.address)}</p>
      {view.subject.sizeSentence ? <p className="text-[14px] text-ink-muted">{view.subject.sizeSentence}</p> : null}
      {!editing ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[15px]">
            {ORDER.map((k) => {
              const f = facts[k] as Fact<unknown>;
              return (
                <div key={k} className="contents">
                  <dt className="text-ink-muted">{FACT_WORDS[k]}</dt>
                  <dd className="text-ink">
                    {valueWords(k, f)} {f.value !== null ? <span className="text-[14px] text-ink-muted">({sourceWords(f.source)})</span> : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="text-[14px] text-ink-muted">{facts.mapLocation.known ? W.mapKnown : W.mapUnknown}</p>
          {view.subject.factSentences.map((s) => (
            <p key={s} className="text-[14px] text-ink-muted">
              {s}
            </p>
          ))}
          {view.subject.saleHistory.length > 0 ? (
            <div>
              <p className="text-[14px] font-medium text-ink-muted">{W.saleHistoryHeading}</p>
              <ul className="text-[14px] text-ink">
                {view.subject.saleHistory.map((h) => (
                  <li key={h.listingId}>{W.saleHistoryLine(LISTING_STATUS_WORDS[h.status] ?? h.status, money(h.closePriceCents), day(h.closeDate))}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.canEdit ? (
            <Button variant="secondary" className="self-start" onClick={start}>
              {W.editFacts}
            </Button>
          ) : null}
        </>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={typeId} className="text-[15px] font-medium text-ink">
              {W.typeLabel}
            </label>
            <select id={typeId} className={selectClass} value={draft.propertyType} onChange={(e) => set('propertyType')(e.target.value)}>
              {draft.propertyType === '' ? <option value="">{W.notKnown}</option> : null}
              {CMA_PROPERTY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PROPERTY_TYPE_WORDS[t]}
                </option>
              ))}
            </select>
          </div>
          <TextField label={`${FACT_WORDS.sqft} (sq ft)`} inputMode="numeric" value={draft.sqft} onChange={(e) => set('sqft')(e.target.value)} hint={W.sizeHint} error={err('sqft')} />
          <div className="grid grid-cols-2 gap-3">
            <TextField label={FACT_WORDS.beds!} inputMode="numeric" value={draft.beds} onChange={(e) => set('beds')(e.target.value)} error={err('beds')} />
            <TextField label={FACT_WORDS.bathsX10!} inputMode="decimal" value={draft.bathsX10} onChange={(e) => set('bathsX10')(e.target.value)} error={err('bathsX10')} />
            <TextField label={FACT_WORDS.yearBuilt!} inputMode="numeric" value={draft.yearBuilt} onChange={(e) => set('yearBuilt')(e.target.value)} error={err('yearBuilt')} />
            <TextField label={`${FACT_WORDS.lotSqft} (sq ft)`} inputMode="numeric" value={draft.lotSqft} onChange={(e) => set('lotSqft')(e.target.value)} error={err('lotSqft')} />
            <TextField label={FACT_WORDS.garageSpacesX10!} inputMode="decimal" value={draft.garageSpacesX10} onChange={(e) => set('garageSpacesX10')(e.target.value)} error={err('garageSpacesX10')} />
            <TextField label={FACT_WORDS.storiesX10!} inputMode="decimal" value={draft.storiesX10} onChange={(e) => set('storiesX10')(e.target.value)} error={err('storiesX10')} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={poolId} className="text-[15px] font-medium text-ink">
              {FACT_WORDS.poolPrivate}
            </label>
            <select id={poolId} className={selectClass} value={draft.poolPrivate} onChange={(e) => set('poolPrivate')(e.target.value)}>
              <option value="">{W.notKnown}</option>
              <option value="yes">{W.yes}</option>
              <option value="no">{W.no}</option>
            </select>
          </div>
          <TextField label={FACT_WORDS.subdivision!} value={draft.subdivision} maxLength={120} onChange={(e) => set('subdivision')(e.target.value)} error={invalid.includes('subdivision') ? W.numberInvalid : null} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={busy}>
              {W.saveFacts}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              {W.cancel}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
