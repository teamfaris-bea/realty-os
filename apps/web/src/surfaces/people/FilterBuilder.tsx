// The People filter builder (lane people-filters, PARITY_PLAN §5 "Filter by stage"): a bottom sheet on a phone,
// a side panel beside the results on desktop. Add filter → pick a field → pick an operator → pick values →
// "Show N people" (a live count of exactly what will be shown). Every value comes from the team's own
// catalogs (stage labels, lead sources, tags, members, custom fields). "Match any of" is the one OR group of a
// definition, kept behind "More options". The definition it makes is SmartListDefinition v1; the server checks
// it again and runs it under the viewer's RLS (only people the viewer may see in detail).
//
// Tap counts (phone from the People tab, desktop from the People page):
//   filter by stage       People → Filter → Stage → choose → Show = 5 · Filter → Stage → choose → Show = 4
//   exclude a source      People → Filter → Source → is not → choose → Show = 6 · 5
//   tags has none of      People → Filter → Tags → has none of → choose → Show = 6 · 5
//   each further filter   + "Add another" → field → (operator) → choose: 3-4 more
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Notice, TextField } from '../../design/index.js';
import { messageFor } from '../../shell/index.js';
import { type Clause, type Definition, countText, useDefinitionCount } from './api.js';
import {
  type Catalogs,
  type DraftValue,
  EMPTY_VALUE,
  type FieldSpec,
  type FilterField,
  MAX_ALL,
  MAX_ANY,
  TEAM_TEXT_REFUSAL,
  buildClause,
  choicesOf,
  clauseLabel,
  clauseToDraft,
  definitionOf,
  fieldSpecs,
  isEmptyDefinition,
  isFreeTextClause,
} from './filters.js';
import { LISTS_ERROR_MESSAGES } from './messages.js';

type Group = 'all' | 'any';
interface Editing {
  group: Group;
  /** the clause being edited, or null for a new one */
  index: number | null;
  field: FilterField | null;
  op: string;
  value: DraftValue;
}

export interface FilterBuilderProps {
  initial: Definition;
  catalogs: Catalogs;
  /** "Save changes" writes a team list: typed-text filters cannot be saved there (R-PAR-27); Show still applies them as an unsaved filter */
  teamList: boolean;
  onApply: (d: Definition) => void;
  /** "Save changes" of a saved list the viewer may edit (PATCH /smart-lists/:id); absent: none */
  onSaveList?: { label: string; run: (d: Definition) => Promise<string | null> };
  onClose: () => void;
  /** open straight on the field list (the global Search page's "Filter people" link, an empty filter) */
  startAdding?: boolean;
}

export function FilterBuilder(p: FilterBuilderProps) {
  const [all, setAll] = useState<Clause[]>(() => [...(p.initial.all ?? [])]);
  const [any, setAny] = useState<Clause[]>(() => [...(p.initial.any ?? [])]);
  const [more, setMore] = useState(() => (p.initial.any ?? []).length > 0);
  const [editing, setEditing] = useState<Editing | null>(() => (p.startAdding && isEmptyDefinition(p.initial) ? { group: 'all', index: null, field: null, op: '', value: EMPTY_VALUE } : null));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const specs = useMemo(() => fieldSpecs(p.catalogs.fields), [p.catalogs.fields]);
  const spec = editing?.field ? specs.find((s) => s.field === editing.field) : undefined;
  const opSpec = spec?.operators.find((o) => o.op === editing?.op);
  const pending = editing?.field && editing.op ? buildClause(editing.field, editing.op, editing.value) : null;

  /** the groups with the edited clause put in (when it is complete) */
  const withPending = (): { all: Clause[]; any: Clause[] } => {
    if (!editing || !pending?.ok) return { all, any };
    const put = (xs: Clause[]) => (editing.index === null ? [...xs, pending.clause] : xs.map((c, i) => (i === editing.index ? pending.clause : c)));
    return editing.group === 'all' ? { all: put(all), any } : { all, any: put(any) };
  };
  const next = withPending();
  const draft = definitionOf(next.all, next.any);
  const count = useDefinitionCount(draft);
  const textInTeam = p.teamList && [...next.all, ...next.any].some(isFreeTextClause);
  const tooMany = draft.all!.length > MAX_ALL || (draft.any?.length ?? 0) > MAX_ANY;
  // the number on the button is always the count of exactly this draft; while it is being counted it says so
  const showLabel = count.isSuccess && !count.isStale ? `Show ${countText(count.data)}` : 'Show people';
  const statusText = count.isError ? 'Count unavailable' : count.isSuccess && !count.isStale ? `${countText(count.data)} match` : 'Counting…';
  const step = !editing ? 'list' : !editing.field ? 'field' : 'value';
  const body = useRef<HTMLDivElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    // the Dialog focuses its first control when it opens; each later step does the same, so focus never falls
    // to <body> when the control that was tapped goes away (review: keyboard and screen-reader users)
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    const panel = body.current?.closest<HTMLElement>('[role="dialog"]');
    const target = panel?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [href]') ?? panel;
    target?.focus();
  }, [step, editing?.field]);
  // the live count, spoken (the page's own count sits behind the inert sheet)
  const live = (
    <p role="status" aria-live="polite" className="sr-only">
      {statusText}
    </p>
  );

  const commit = (): { all: Clause[]; any: Clause[] } => {
    const n = withPending();
    setAll(n.all);
    setAny(n.any);
    setEditing(null);
    return n;
  };
  const apply = () => {
    const n = editing ? commit() : { all, any };
    p.onApply(definitionOf(n.all, n.any));
  };
  const remove = (g: Group, i: number) => (g === 'all' ? setAll(all.filter((_, j) => j !== i)) : setAny(any.filter((_, j) => j !== i)));
  const startAdd = (g: Group) => setEditing({ group: g, index: null, field: null, op: '', value: EMPTY_VALUE });
  const startEdit = (g: Group, i: number) => {
    const c = (g === 'all' ? all : any)[i]!;
    const d = clauseToDraft(c);
    if (d) setEditing({ group: g, index: i, ...d });
  };
  const pickField = (s: FieldSpec) => setEditing((e) => (e ? { ...e, field: s.field, op: s.operators[0]!.op, value: EMPTY_VALUE } : e));

  const title = !editing ? 'Filters' : !editing.field ? 'Add a filter' : (spec?.label ?? 'Filter');
  const countLine = count.isError ? <Notice tone="error">{messageFor(count.error, LISTS_ERROR_MESSAGES)}</Notice> : null;

  // ---- step 1: the list of filters --------------------------------------------------------------
  if (!editing) {
    return (
      <Dialog
        title={title}
        placement="side"
        onClose={p.onClose}
        footer={
          <div className="flex flex-col gap-2">
            <Button block onClick={apply} disabled={tooMany}>
              {showLabel}
            </Button>
            {p.onSaveList ? (
              <Button
                block
                variant="secondary"
                pending={saving}
                disabled={textInTeam || tooMany}
                onClick={async () => {
                  setSaving(true);
                  const err = await p.onSaveList!.run(draft);
                  setSaving(false);
                  setSaveError(err);
                }}
              >
                {p.onSaveList.label}
              </Button>
            ) : null}
            <Button block variant="quiet" onClick={p.onClose}>
              Close
            </Button>
          </div>
        }
      >
        <div ref={body} className="flex flex-col gap-4">
          {live}
          {all.length + any.length === 0 ? <p className="text-[15px] text-ink-muted">No filters yet: everyone you can see is shown.</p> : null}
          <Rows group="all" heading={any.length > 0 || more ? 'Match all of' : null} clauses={all} catalogs={p.catalogs} onEdit={startEdit} onRemove={remove} />
          <Button variant="secondary" onClick={() => startAdd('all')} disabled={all.length >= MAX_ALL}>
            Add filter
          </Button>
          {more ? (
            <section aria-label="Match any of" className="flex flex-col gap-2 rounded-2xl border border-line p-3">
              <h3 className="text-[15px] font-semibold text-ink">Match any of</h3>
              <p className="text-[14px] text-ink-muted">People who match at least one of these (and every filter above). With one filter here, it works like the filters above.</p>
              <Rows group="any" heading={null} clauses={any} catalogs={p.catalogs} onEdit={startEdit} onRemove={remove} />
              <Button variant="secondary" onClick={() => startAdd('any')} disabled={any.length >= MAX_ANY}>
                Add to “any of”
              </Button>
            </section>
          ) : (
            <Button variant="quiet" onClick={() => setMore(true)}>
              More options: match any of
            </Button>
          )}
          {all.length + any.length > 0 ? (
            <Button
              variant="quiet"
              onClick={() => {
                setAll([]);
                setAny([]);
              }}
            >
              Clear all filters
            </Button>
          ) : null}
          {textInTeam && p.onSaveList ? <Notice tone="error">{TEAM_TEXT_REFUSAL}</Notice> : null}
          {tooMany ? <Notice tone="error">A list holds at most {MAX_ALL} filters, and at most {MAX_ANY} in “any of”. Remove some first.</Notice> : null}
          {saveError ? <Notice tone="error">{saveError}</Notice> : null}
          {countLine}
        </div>
      </Dialog>
    );
  }

  // ---- step 2: pick a field ---------------------------------------------------------------------
  if (!editing.field) {
    return (
      <Dialog title={title} placement="side" onClose={p.onClose} footer={<Button variant="secondary" block icon="back" onClick={() => setEditing(null)}>Back to filters</Button>}>
        <div ref={body}>{live}</div>
        <ul aria-label="Fields" className="flex flex-col divide-y divide-line rounded-2xl border border-line">
          {specs.map((s) => {
            const textOnly = p.teamList && p.onSaveList !== undefined && s.operators.every((o) => o.freeText);
            return (
              <li key={s.field}>
                <button type="button" onClick={() => pickField(s)} className="flex min-h-tap w-full items-center justify-between gap-3 px-4 text-left text-[17px] text-ink">
                  <span>{s.label}</span>
                  {textOnly ? <span className="text-[14px] text-ink-muted">Can't be saved to a team list</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </Dialog>
    );
  }

  // ---- step 3: operator and values ----------------------------------------------------------------
  const addAnother = editing.index === null && p.onSaveList === undefined;
  return (
    <Dialog
      title={title}
      placement="side"
      onClose={p.onClose}
      footer={
        <div className="flex flex-col gap-2">
          <Button block onClick={apply} disabled={!pending?.ok || tooMany}>
            {showLabel}
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" icon="back" onClick={() => setEditing(editing.index === null ? { ...editing, field: null } : null)}>
              {editing.index === null ? 'Back' : 'Cancel'}
            </Button>
            <Button
              variant="secondary"
              className="flex-1"
              disabled={!pending?.ok}
              onClick={() => {
                // a new filter on an unsaved filter: "Add another" goes straight to the field list (one tap less per
                // filter); a changed filter, or any filter of a saved list being edited: "Done" back to the list (Save changes)
                const n = commit();
                if (addAnother && (editing.group === 'all' ? n.all.length < MAX_ALL : n.any.length < MAX_ANY)) startAdd(editing.group);
              }}
            >
              {addAnother ? 'Add another' : 'Done'}
            </Button>
          </div>
        </div>
      }
    >
      <div ref={body} className="flex flex-col gap-4">
        {live}
        <Operators spec={spec!} op={editing.op} onPick={(op) => setEditing({ ...editing, op, value: { ...editing.value } })} />
        {opSpec ? <ValueInput field={editing.field} op={opSpec} value={editing.value} catalogs={p.catalogs} onChange={(value) => setEditing({ ...editing, value })} /> : null}
        {pending && !pending.ok && !(opSpec?.value === 'choices' && editing.value.choices.length === 0) ? <p className="text-[14px] text-ink-muted">{pending.message}</p> : null}
        {opSpec?.freeText && p.teamList && p.onSaveList ? <Notice tone="info">{TEAM_TEXT_REFUSAL}</Notice> : null}
        {countLine}
      </div>
    </Dialog>
  );
}

function Rows({ group, heading, clauses, catalogs, onEdit, onRemove }: { group: Group; heading: string | null; clauses: Clause[]; catalogs: Catalogs; onEdit: (g: Group, i: number) => void; onRemove: (g: Group, i: number) => void }) {
  if (clauses.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {heading ? <h3 className="text-[15px] font-semibold text-ink">{heading}</h3> : null}
      <ul aria-label={group === 'all' ? 'Filters' : 'Any of'} className="flex flex-col gap-2">
        {clauses.map((c, i) => {
          const label = clauseLabel(c, catalogs);
          const editable = clauseToDraft(c) !== null;
          return (
            <li key={`${i}-${label}`} className="flex items-center gap-1 rounded-xl bg-surface-2">
              <button type="button" disabled={!editable} onClick={() => onEdit(group, i)} className="min-h-tap flex-1 px-3 text-left text-[16px] text-ink" aria-label={`Change filter ${label}`}>
                {label}
              </button>
              <button type="button" onClick={() => onRemove(group, i)} className="inline-flex min-h-tap min-w-tap items-center justify-center text-[18px] text-ink-muted" aria-label={`Remove filter ${label}`}>
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Operators({ spec, op, onPick }: { spec: FieldSpec; op: string; onPick: (op: string) => void }) {
  const name = useId();
  if (spec.operators.length === 1) return <p className="text-[15px] text-ink-muted">{spec.label} {spec.operators[0]!.label}</p>;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{spec.label}</legend>
      <div className="flex flex-wrap gap-2">
        {spec.operators.map((o) => {
          return (
            <label key={o.op} className={`inline-flex min-h-tap cursor-pointer items-center gap-2 rounded-full border px-4 text-[15px] font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${op === o.op ? 'border-accent bg-accent-soft text-ink' : 'border-line bg-surface text-ink'}`}>
              <input type="radio" name={name} className="sr-only" checked={op === o.op} onChange={() => onPick(o.op)} />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ValueInput({ field, op, value, catalogs, onChange }: { field: FilterField; op: { op: string; label: string; value: string }; value: DraftValue; catalogs: Catalogs; onChange: (v: DraftValue) => void }) {
  const [q, setQ] = useState('');
  switch (op.value) {
    case 'none':
      return null;
    case 'days':
    case 'days0':
      return (
        <TextField
          label={field === 'next_task' ? 'Days from now' : op.op.includes('next') || op.op === 'coming_up' ? 'Days from today' : 'Days'}
          inputMode="numeric"
          value={value.days}
          onChange={(e) => onChange({ ...value, days: e.target.value.replace(/\D/g, '').slice(0, 4) })}
          placeholder={op.value === 'days0' ? '14' : '30'}
          autoComplete="off"
        />
      );
    case 'number':
      return <TextField label="Number" inputMode="decimal" value={value.number} onChange={(e) => onChange({ ...value, number: e.target.value })} autoComplete="off" />;
    case 'date':
      return <TextField label="Date" type="date" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} />;
    case 'text':
      return <TextField label={field === 'name' ? 'Name contains' : 'Text'} value={value.text} maxLength={60} onChange={(e) => onChange({ ...value, text: e.target.value })} autoComplete="off" />;
    default: {
      const choices = choicesOf(field, catalogs);
      const key = q.trim().toLowerCase();
      const shown = key === '' ? choices : choices.filter((c) => c.label.toLowerCase().includes(key) || value.choices.includes(c.id));
      const toggle = (id: string) => onChange({ ...value, choices: value.choices.includes(id) ? value.choices.filter((x) => x !== id) : [...value.choices, id] });
      return (
        <div className="flex flex-col gap-2">
          {choices.length > 8 ? <TextField label="Find" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" /> : null}
          {choices.length === 0 ? <p className="text-[15px] text-ink-muted">{field === 'source' ? 'Your team has no lead sources yet.' : field === 'tag' ? 'Your team has no tags yet.' : 'Nothing to pick from yet.'}</p> : null}
          <ul aria-label="Values" className="flex flex-col divide-y divide-line rounded-2xl border border-line">
            {shown.slice(0, 60).map((c) => (
              <li key={c.id}>
                <label className="flex min-h-tap cursor-pointer items-center gap-3 px-4 text-[17px] text-ink">
                  <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={value.choices.includes(c.id)} onChange={() => toggle(c.id)} />
                  <span className={c.muted ? 'text-ink-muted' : ''}>{c.label}</span>
                </label>
              </li>
            ))}
          </ul>
          {shown.length > 60 ? <p className="text-[14px] text-ink-muted">Type to find more.</p> : null}
        </div>
      );
    }
  }
}
