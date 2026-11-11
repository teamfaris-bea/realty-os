// The People page (PARITY_PLAN §5, module 61): everyone the viewer can see, or a saved smart list,
// or an unsaved filter (a tapped tag chip). Phone: list chips across the top (People → list = 2
// taps); desktop: lists in a left column (1 click). Rows have checkboxes; selecting shows the bulk
// bar (Tag, Assign for Owner/Admin/Team Lead, Start plan, Remove tag, Stage, Email), which opens
// module 64's bulk sheet with the selection (the checked people, or the whole list after "Select all").
// Bulk tag 30 from a list: People → list → Select all → Tag → tag = 5 taps to the count sheet with the
// frozen target, then Confirm in the sheet: 6 to start, one over PARITY_PLAN §5's 5 (an owner decision;
// ARCHITECTURE, parity gaps). Bulk assign: People → list → Select all → Assign → person → Confirm = 6 on
// a phone, 5 on desktop (§5); the sheet lists only the people the viewer may assign to. Start plan:
// the same shape, the sheet listing only approved plans the viewer may start. On a phone the bar is one
// row that scrolls sideways, so Assign and Start plan come right after Tag: at 390 px Assign (and an
// agent's Start plan) is in view without a swipe; Remove tag, Stage, Email and Clear may need one.
//
// Filters (lane people-filters): "Filter" opens the builder (FilterBuilder.tsx: a bottom sheet on a phone, a
// side panel on desktop); active filters show as removable chips with "Clear all" above the results; the name
// box narrows by name (a personal / unsaved filter only: R-PAR-27). An unsaved filter lives in the URL
// (?f=<definition>&q=<name>), so Back, reload and "Next person" keep it; ?filter=open opens the builder (the
// Search page's "Filter people" link). The selection of "Select all" is the definition itself (bulk accepts it).
//
// Honest UI: the page always says "Showing people you can see" (R-PAR-28, E181); a count is exact to
// 10,000 and then says "10,000+"; a list that uses a protected tag says so before any send, and a bulk
// email, text or plan from it is refused at once (and by the server, which reads the list itself).
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, EmptyState, Icon, Notice, TextField, Dialog } from '../../design/index.js';
import { messageFor, useSession } from '../../shell/index.js';
import { relativeTime } from '../feed/lib/format.js';
import { useMutate, useNow } from '../feed/lib/hooks.js';
import { AgentSheetsProvider, useAgentSheets } from '../feed/lib/AgentSheets.js';
import {
  type Clause,
  type Definition,
  EVERYONE,
  LEAD_STAGE_LABEL,
  LISTS_KEY,
  type PersonView,
  type SmartListView,
  type Source,
  type TagView,
  chipClass,
  countText,
  selectionOf,
  sourceKey,
  tagSource,
  useSmartLists,
  usePeople,
  usePeopleCount,
  useFields,
  useFilterOptions,
  useStageLabels,
  useTags,
} from './api.js';
import { FilterBuilder } from './FilterBuilder.js';
import { type Catalogs, TEAM_TEXT_REFUSAL, clauseLabel, decodeDefinition, encodeDefinition, hasFreeText, isEmptyDefinition, loosenText, withNameSearch } from './filters.js';
import { mayBulkAssign, mayBulkEnroll } from '../bulk/index.js';
import { BULK_LABEL, BulkConfirmSheet, type BulkKind, type BulkRequest } from './bulkSlot.js';
import { LISTS_ERROR_MESSAGES } from './messages.js';
import { TagPicker } from './TagPicker.js';
import { startWork } from './workList.js';

export default function PeoplePage() {
  return (
    <AgentSheetsProvider>
      <People />
    </AgentSheetsProvider>
  );
}

/** The source named by the URL: ?list=<id>, ?f=<definition>, ?tag=<id>&name=<name>, or everyone. */
export function sourceFromParams(p: URLSearchParams): Source {
  const list = p.get('list');
  if (list) return { kind: 'list', listId: list };
  const f = decodeDefinition(p.get('f'));
  if (f && !isEmptyDefinition(f)) return { kind: 'definition', definition: f, label: 'Filtered people' };
  const tag = p.get('tag');
  if (tag) return tagSource({ id: tag, name: p.get('name') ?? 'tag' });
  return EVERYONE;
}

/** The definition behind a source (a saved list's own, once the lists have loaded). */
export function definitionOfSource(s: Source, lists: readonly SmartListView[] | undefined): Definition | null {
  if (s.kind === 'all') return { v: 1, all: [] };
  if (s.kind === 'definition') return s.definition;
  const l = lists?.find((x) => x.id === s.listId);
  return l ? { v: 1, all: l.definition.all ?? [], ...(l.definition.any && l.definition.any.length > 0 ? { any: l.definition.any } : {}) } : null;
}

/**
 * What the page runs: the URL's source, narrowed by the name box. A name search turns any source into an
 * unsaved definition (the list's own filters plus "name contains"), never a change to a saved list.
 */
export function effectiveSource(base: Source, q: string, lists: readonly SmartListView[] | undefined, title: string): Source {
  if (q.trim() === '') return base;
  const d = definitionOfSource(base, lists);
  if (!d) return base; // a saved list still loading: show it unnarrowed for that moment
  return { kind: 'definition', definition: withNameSearch(d, q), label: title };
}

export const SEARCH_DEBOUNCE_MS = 300;

function People() {
  const [params, setParams] = useSearchParams();
  const base = useMemo(() => sourceFromParams(params), [params]);
  const q = params.get('q') ?? '';
  const lists = useSmartLists();
  const { session } = useSession();
  const role = session?.tenant?.role;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allSelected, setAllSelected] = useState(false);
  const builderOpen = params.get('filter') === 'open';
  const activeList = base.kind === 'list' ? lists.data?.lists.find((l) => l.id === base.listId) : undefined;
  const title = base.kind === 'all' ? 'Everyone' : base.kind === 'list' ? (activeList?.name ?? 'List') : base.label;
  const source = useMemo(() => effectiveSource(base, q, lists.data?.lists, title), [base, q, lists.data, title]);
  const catalogs = useCatalogs(session?.user.id ?? null);
  useEffect(() => {
    setSelected(new Set());
    setAllSelected(false);
  }, [sourceKey(source)]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * URL params for a source, keeping the name search and the open builder of the LATEST URL unless told
   * otherwise. Every update is computed from the previous params (a functional update), so closing the builder
   * just after typing a name can never write back an older name.
   */
  const paramsFor = (s: Source, prev: URLSearchParams, o: { q?: string; filter?: boolean } = {}): Record<string, string> => {
    const out: Record<string, string> = {};
    if (s.kind === 'list') out['list'] = s.listId;
    else if (s.kind === 'definition') {
      const t = (s.definition.all?.length === 1 && !s.definition.any ? (s.definition.all[0] as { kind?: string; op?: string; tagIds?: string[] }) : null);
      if (t?.kind === 'tag' && t.op === 'any' && t.tagIds?.length === 1 && s.label.startsWith('Tag: ')) {
        out['tag'] = t.tagIds[0]!;
        out['name'] = s.label.replace(/^Tag: /, '');
      } else out['f'] = encodeDefinition(s.definition);
    }
    const nq = o.q ?? prev.get('q') ?? '';
    if (nq.trim() !== '') out['q'] = nq;
    if (o.filter ?? prev.get('filter') === 'open') out['filter'] = 'open';
    return out;
  };
  const go = (fn: (prev: URLSearchParams) => Record<string, string>, replace = false) => setParams((prev) => fn(prev), { replace });
  const open = (s: Source) => go((prev) => paramsFor(s, prev, { q: '', filter: false }));
  const applyFilters = (d: Definition) => go((prev) => paramsFor(isEmptyDefinition(d) ? EVERYONE : { kind: 'definition', definition: d, label: 'Filtered people' }, prev, { filter: false }));
  const setBuilder = (on: boolean) => go((prev) => paramsFor(sourceFromParams(prev), prev, { filter: on }), true);
  const setQuery = (text: string) => go((prev) => paramsFor(sourceFromParams(prev), prev, { q: text }), true);

  // the base definition's clauses as chips (a saved list's own filters too; removing one makes an unsaved copy)
  const baseDef = definitionOfSource(base, lists.data?.lists);
  const removeClause = (group: 'all' | 'any', i: number) => {
    if (!baseDef) return;
    const all = group === 'all' ? (baseDef.all ?? []).filter((_, j) => j !== i) : [...(baseDef.all ?? [])];
    let any = group === 'any' ? (baseDef.any ?? []).filter((_, j) => j !== i) : [...(baseDef.any ?? [])];
    // an OR group of one is just one more required filter
    if (any.length === 1) {
      all.push(any[0]!);
      any = [];
    }
    applyFilters({ v: 1, all, ...(any.length > 0 ? { any } : {}) });
  };
  const canManageTeam = role === 'owner' || role === 'admin' || role === 'team_lead';
  const editableList = activeList && (activeList.scope === 'personal' ? activeList.mine : canManageTeam) ? activeList : undefined;
  const qc = useQueryClient();
  const api = useApiClient();
  const sheets = useAgentSheets();

  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-6">
      <ListNav lists={lists.data?.lists ?? []} source={base} onOpen={open} />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <FilterBar
          q={q}
          onQ={setQuery}
          filterCount={baseDef ? (baseDef.all?.length ?? 0) + (baseDef.any?.length ?? 0) : 0}
          onFilter={() => setBuilder(true)}
          editLabel={base.kind === 'list' ? 'Edit filters' : 'Filter'}
        />
        {baseDef && catalogs.ready && !isEmptyDefinition(baseDef) ? (
          <Chips
            def={baseDef}
            catalogs={catalogs.value}
            onRemove={removeClause}
            onClear={() => setParams({})}
          />
        ) : null}
        <Rows
          key={sourceKey(source)}
          source={source}
          title={title}
          role={role ?? null}
          selected={selected}
          setSelected={setSelected}
          allSelected={allSelected}
          setAllSelected={setAllSelected}
          onTag={(t) => open(tagSource(t))}
          onClearFilter={() => open(EVERYONE)}
          saveable={source.kind === 'definition'}
          emptyText={loosenText([...(baseDef && catalogs.ready ? [...(baseDef.all ?? []), ...(baseDef.any ?? [])].map((c) => clauseLabel(c, catalogs.value)) : []), ...(q.trim() ? [`Name contains “${q.trim()}”`] : [])])}
        />
      </div>
      {builderOpen && catalogs.ready && (base.kind !== 'list' || activeList) ? (
        <FilterBuilder
          key={sourceKey(base)}
          initial={baseDef ?? { v: 1, all: [] }}
          catalogs={catalogs.value}
          teamList={editableList?.scope === 'team'}
          startAdding={base.kind === 'all'}
          onClose={() => setBuilder(false)}
          onApply={(d) => applyFilters(d)}
          {...(editableList
            ? {
                onSaveList: {
                  label: `Save changes to “${editableList.name}”`,
                  run: async (d: Definition) => {
                    const r = await api.patch(`/smart-lists/${editableList.id}`, { definition: d });
                    if (!r.ok) return r.message;
                    await qc.invalidateQueries({ queryKey: [...LISTS_KEY] });
                    await qc.invalidateQueries({ queryKey: ['people'] });
                    sheets.announce(`Saved "${editableList.name}"`);
                    // the list now holds other people: a hand-picked or "all" selection of the old filters is dropped
                    setSelected(new Set());
                    setAllSelected(false);
                    setBuilder(false);
                    return null;
                  },
                },
              }
            : {})}
        />
      ) : null}
    </div>
  );
}

/** The builder's catalogs: stage labels, sources and members, tags, custom fields (all member-readable). */
function useCatalogs(meId: string | null): { ready: boolean; value: Catalogs } {
  const stages = useStageLabels();
  const options = useFilterOptions();
  const tags = useTags();
  const fields = useFields();
  const value = useMemo<Catalogs>(
    () => ({
      stageLabel: (k: string) => stages.data?.stages.find((s) => s.key === k)?.label ?? LEAD_STAGE_LABEL[k] ?? k,
      sources: options.data?.sources ?? [],
      members: options.data?.members ?? [],
      tags: tags.data?.tags ?? [],
      fields: fields.data?.fields ?? [],
      meId,
    }),
    [stages.data, options.data, tags.data, fields.data, meId],
  );
  // a catalog that failed still lets the builder open (its choices are just empty; the label falls back)
  const settled = (x: { isPending: boolean }) => !x.isPending;
  return { ready: settled(stages) && settled(options) && settled(tags) && settled(fields), value };
}

/** PATCH for "Save changes" with the plain sentence of a refusal (the builder shows it). */
function useApiClient() {
  const save = useMutate<{ definition: unknown }, unknown>('PATCH', { invalidate: [[...LISTS_KEY]] });
  return {
    async patch(path: string, body: { definition: unknown }): Promise<{ ok: true } | { ok: false; message: string }> {
      const r = await save.run(path, body);
      return r.ok ? { ok: true } : { ok: false, message: messageFor(r.code, LISTS_ERROR_MESSAGES) };
    },
  };
}

// ---- the search box and the Filter button --------------------------------------------------------

function FilterBar({ q, onQ, filterCount, onFilter, editLabel }: { q: string; onQ: (q: string) => void; filterCount: number; onFilter: () => void; editLabel: string }) {
  const id = useId();
  const [text, setText] = useState(q);
  const last = useRef(q);
  useEffect(() => {
    // the URL changed from elsewhere (a list opened, Clear all): show it
    if (q !== last.current) {
      last.current = q;
      setText(q);
    }
  }, [q]);
  useEffect(() => {
    if (text === last.current) return;
    const t = setTimeout(() => {
      last.current = text;
      onQ(text);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex items-end gap-2">
      <form role="search" className="relative min-w-0 flex-1" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor={`${id}-q`} className="sr-only">
          Search people by name
        </label>
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">
          <Icon name="search" size={20} />
        </span>
        <input
          id={`${id}-q`}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={60}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search by name"
          className="min-h-tap w-full rounded-xl border border-line bg-surface pl-10 pr-3.5 text-[17px] text-ink placeholder:text-ink-muted"
        />
      </form>
      {/* the name is the visible words (WCAG 2.5.3): "Filter, 2 active" with the comma and "active" for screen readers only */}
      <Button variant="secondary" className="shrink-0" onClick={onFilter}>
        {editLabel}
        {filterCount > 0 ? (
          <>
            <span className="sr-only">, </span>
            <span className="ml-1 rounded-full bg-accent px-2 text-[14px] text-accent-ink">{filterCount}</span>
            <span className="sr-only"> active</span>
          </>
        ) : null}
      </Button>
    </div>
  );
}

function Chips({ def, catalogs, onRemove, onClear }: { def: Definition; catalogs: Catalogs; onRemove: (g: 'all' | 'any', i: number) => void; onClear: () => void }) {
  const chip = (g: 'all' | 'any', c: Clause, i: number) => {
    const label = clauseLabel(c, catalogs);
    return (
      <li key={`${g}${i}`}>
        <button type="button" onClick={() => onRemove(g, i)} className="inline-flex min-h-tap items-center gap-2 rounded-full bg-accent-soft px-3 text-[14px] font-medium text-ink" aria-label={`Remove filter ${label}`}>
          {label}
          <span aria-hidden="true">✕</span>
        </button>
      </li>
    );
  };
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label="Active filters" className="flex flex-wrap items-center gap-2">
        {(def.all ?? []).map((c, i) => chip('all', c, i))}
        {(def.any ?? []).length > 0 ? <li className="text-[14px] font-medium text-ink-muted">and any of:</li> : null}
        {(def.any ?? []).map((c, i) => chip('any', c, i))}
        <li>
          <Button variant="quiet" onClick={onClear}>
            Clear all
          </Button>
        </li>
      </ul>
    </div>
  );
}

// ---- the list picker: chips on a phone, a column on desktop -------------------------------------

function ListNav({ lists, source, onOpen }: { lists: SmartListView[]; source: Source; onOpen: (s: Source) => void }) {
  const mine = lists.filter((l) => l.scope === 'personal');
  const team = lists.filter((l) => l.scope === 'team');
  const current = (s: Source) => sourceKey(s) === sourceKey(source);
  const Item = ({ s, label }: { s: Source; label: string }) => (
    <li className="shrink-0 md:shrink">
      <button
        type="button"
        onClick={() => onOpen(s)}
        aria-current={current(s) ? 'true' : undefined}
        className={`inline-flex min-h-tap w-full items-center whitespace-nowrap rounded-full px-4 text-left text-[15px] font-medium md:rounded-lg md:px-3 ${current(s) ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink md:bg-transparent md:hover:bg-surface-2'}`}
      >
        {label}
      </button>
    </li>
  );
  return (
    <nav aria-label="Lists" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:w-60 md:shrink-0 md:overflow-visible md:px-0">
      <ul className="flex gap-2 md:flex-col md:gap-1">
        <Item s={EVERYONE} label="Everyone" />
        {mine.length > 0 ? <li className="hidden px-3 pt-3 text-[13px] font-semibold uppercase tracking-wide text-ink-muted md:block">My lists</li> : null}
        {mine.map((l) => (
          <Item key={l.id} s={{ kind: 'list', listId: l.id }} label={l.name} />
        ))}
        {team.length > 0 ? <li className="hidden px-3 pt-3 text-[13px] font-semibold uppercase tracking-wide text-ink-muted md:block">Team lists</li> : null}
        {team.map((l) => (
          <Item key={l.id} s={{ kind: 'list', listId: l.id }} label={l.name} />
        ))}
      </ul>
    </nav>
  );
}

// ---- rows, selection and the bulk bar --------------------------------------------------------------

function Rows(p: {
  source: Source;
  title: string;
  role: string | null;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  allSelected: boolean;
  setAllSelected: (b: boolean) => void;
  onTag: (t: { id: string; name: string }) => void;
  onClearFilter: () => void;
  saveable: boolean;
  emptyText: string;
}) {
  const q = usePeople(p.source);
  const count = usePeopleCount(p.source);
  const nav = useNavigate();
  const hid = useId();
  const people = useMemo(() => q.data?.pages.flatMap((x) => x.people) ?? [], [q.data]);
  const last = q.data?.pages.at(-1);
  const audienceProtected = q.data?.pages[0]?.audienceProtected ?? false;
  const [bulk, setBulk] = useState<BulkRequest | null>(null);
  const [tagFor, setTagFor] = useState<BulkKind | null>(null);
  const [saving, setSaving] = useState(false);
  const selCount = p.allSelected ? (count.data?.count ?? people.length) : p.selected.size;
  const selection = p.allSelected ? selectionOf(p.source) : { contactIds: [...p.selected] };
  // R-PAR-8: people hand-picked from a list built on a protected tag are still that list's audience, so the
  // list itself goes with the ids and the server reads its tags (nothing the page has to load first)
  const audienceSource = !p.allSelected && p.source.kind !== 'all' ? selectionOf(p.source) : null;

  const toggle = (id: string) => {
    const next = new Set(p.selected);
    if (p.allSelected) {
      p.setAllSelected(false);
      for (const x of people) next.add(x.id);
    }
    if (next.has(id)) next.delete(id);
    else next.add(id);
    p.setSelected(next);
  };
  const openPerson = (id: string) => {
    startWork(p.source, people.map((x) => x.id), last?.nextCursor ?? null);
    nav(`/people/work/${id}`);
  };
  const ask = (kind: BulkKind, tag?: TagView) =>
    setBulk({ kind, selection, count: selCount, countCapped: p.allSelected && (count.data?.capped ?? false), audienceProtected, ...(audienceSource ? { audienceSource } : {}), ...(tag ? { tag: { id: tag.id, name: tag.name, protected: tag.protected } } : {}) });

  const canBulk = p.role !== 'tc';
  // DATA_MODEL §12: bulk.run (Start plan) is every role but the TC; bulk.assign is Owner/Admin/Team Lead only
  const canEnroll = mayBulkEnroll(p.role);
  const canAssign = mayBulkAssign(p.role);
  const anySelected = selCount > 0;

  return (
    <section aria-labelledby={hid} className="flex flex-col gap-3 pb-24 md:pb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={hid} className="text-[22px] font-semibold text-ink">
          {p.title}
        </h2>
        <p className="text-[15px] text-ink-muted" aria-live="polite">
          {count.isSuccess ? countText(count.data) : count.isError ? 'Count unavailable' : 'Counting…'} · Showing people you can see
        </p>
      </div>
      {p.source.kind === 'definition' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={p.onClearFilter} icon="back">
            Everyone
          </Button>
          {p.saveable ? (
            <Button variant="quiet" onClick={() => setSaving(true)}>
              Save as list
            </Button>
          ) : null}
        </div>
      ) : null}
      {audienceProtected ? <Notice tone="info">This list uses a protected tag. You can view it and work it one person at a time; it can't be the audience of a bulk email, text or plan.</Notice> : null}

      {q.isPending ? <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, LISTS_ERROR_MESSAGES)}</Notice> : null}
      {q.isSuccess && people.length === 0 ? (
        <EmptyState icon="people" title={p.source.kind === 'all' ? 'Nobody here yet' : 'No one matches'}>
          {p.emptyText}
        </EmptyState>
      ) : null}

      {people.length > 0 && canBulk ? (
        <label className="inline-flex min-h-tap cursor-pointer items-center gap-3 self-start text-[15px] font-medium text-ink">
          <input
            type="checkbox"
            className="size-5 accent-[var(--accent)]"
            checked={p.allSelected}
            onChange={(e) => {
              p.setAllSelected(e.target.checked);
              p.setSelected(new Set());
            }}
          />
          Select all{count.isSuccess ? ` ${countText(count.data)}` : ''}
        </label>
      ) : null}

      <ul aria-label="People" className={`flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface ${people.length === 0 ? 'hidden' : ''}`}>
        {people.map((x) => (
          <PersonRow key={x.id} person={x} checked={p.allSelected || p.selected.has(x.id)} onToggle={canBulk ? () => toggle(x.id) : null} onOpen={() => openPerson(x.id)} onTag={p.onTag} />
        ))}
      </ul>
      {q.hasNextPage ? (
        <Button variant="secondary" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading' : 'Show more'}
        </Button>
      ) : null}

      {anySelected ? (
        <div role="region" aria-label="Bulk actions" className="fixed inset-x-0 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] z-40 border-t border-line bg-surface px-4 py-2 md:sticky md:bottom-4 md:rounded-2xl md:border md:shadow-lg">
          {/* phone: one row that scrolls sideways; desktop: it wraps, so no action hides behind a scroll.
              Assign (§5 bulk assign: 6 taps on a phone) and Start plan come right after Tag, so a phone shows
              them without a swipe (the e2e asserts it); the rest follow and may sit behind the scroll there */}
          <div className="flex items-center gap-2 overflow-x-auto md:flex-wrap md:overflow-x-visible">
            <p className="shrink-0 pr-2 text-[15px] font-semibold text-ink">{p.allSelected && count.data?.capped ? `${count.data.count.toLocaleString('en-US')}+` : selCount.toLocaleString('en-US')} selected</p>
            <Button variant="primary" className="shrink-0 whitespace-nowrap" onClick={() => setTagFor('tag')}>
              {BULK_LABEL.tag}
            </Button>
            {/* Assign and Start plan: module 64's sheet asks for the person or the plan (only what this viewer may pick) */}
            {canAssign ? (
              <Button variant="secondary" className="shrink-0 whitespace-nowrap" onClick={() => ask('assign')}>
                {BULK_LABEL.assign}
              </Button>
            ) : null}
            {canEnroll ? (
              <Button variant="secondary" className="shrink-0 whitespace-nowrap" onClick={() => ask('enroll')}>
                {BULK_LABEL.enroll}
              </Button>
            ) : null}
            <Button variant="secondary" className="shrink-0 whitespace-nowrap" onClick={() => setTagFor('untag')}>
              {BULK_LABEL.untag}
            </Button>
            <Button variant="secondary" className="shrink-0 whitespace-nowrap" onClick={() => ask('stage')}>
              {BULK_LABEL.stage}
            </Button>
            <Button variant="secondary" className="shrink-0 whitespace-nowrap" onClick={() => ask('email')}>
              {BULK_LABEL.email}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                p.setSelected(new Set());
                p.setAllSelected(false);
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {tagFor ? (
        <TagPicker
          title={`${BULK_LABEL[tagFor]} · ${selCount.toLocaleString('en-US')} ${selCount === 1 ? 'person' : 'people'}`}
          allowCreate={false}
          onClose={() => setTagFor(null)}
          onPick={(t) => {
            const kind = tagFor;
            setTagFor(null);
            ask(kind, t);
          }}
        />
      ) : null}
      {bulk ? (
        <BulkConfirmSheet
          request={bulk}
          onClose={() => setBulk(null)}
          onDone={() => {
            // started: the selection is used up (the sheet stays open with its progress link until Done)
            p.setSelected(new Set());
            p.setAllSelected(false);
          }}
        />
      ) : null}
      {saving && p.source.kind === 'definition' ? <SaveListSheet source={p.source} onClose={() => setSaving(false)} role={p.role} /> : null}
    </section>
  );
}

function PersonRow({ person, checked, onToggle, onOpen, onTag }: { person: PersonView; checked: boolean; onToggle: (() => void) | null; onOpen: () => void; onTag: (t: { id: string; name: string }) => void }) {
  const now = useNow(60_000);
  const meta = [LEAD_STAGE_LABEL[person.stage] ?? person.stage, person.owner?.displayName ? `Owner ${person.owner.displayName}` : 'No owner', person.lastActivityAt ? `Active ${relativeTime(Date.parse(person.lastActivityAt), now)}` : 'No activity yet'];
  return (
    <li className="flex items-start gap-1 px-2 py-2 md:px-3">
      {onToggle ? (
        <label className="inline-flex min-h-tap min-w-tap shrink-0 cursor-pointer items-center justify-center">
          <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={checked} onChange={onToggle} aria-label={`Select ${person.displayName}`} />
        </label>
      ) : null}
      <div className="min-w-0 flex-1">
        <Link
          to={`/people/work/${person.id}`}
          onClick={(e) => {
            e.preventDefault();
            onOpen();
          }}
          className="inline-flex min-h-tap items-center text-[17px] font-semibold text-ink hover:underline"
        >
          {person.displayName}
        </Link>
        <p className="text-[14px] text-ink-muted">{meta.join(' · ')}</p>
        {person.tags.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-2" aria-label={`Tags of ${person.displayName}`}>
            {person.tags.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => onTag(t)} className={`inline-flex min-h-tap items-center rounded-full px-3 text-[14px] font-medium ${chipClass(t.color)}`} aria-label={`Tag ${t.name}, show everyone with it`}>
                  {t.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Icon name="chevron" size={18} className="mt-3 shrink-0 text-ink-muted" />
    </li>
  );
}

// ---- save an unsaved filter as a list ----------------------------------------------------------------

function SaveListSheet({ source, onClose, role }: { source: Extract<Source, { kind: 'definition' }>; onClose: () => void; role: string | null }) {
  const [name, setName] = useState(source.label === 'Filtered people' ? '' : source.label);
  const [scope, setScope] = useState<'personal' | 'team'>('personal');
  const qc = useQueryClient();
  const sheets = useAgentSheets();
  const [, setParams] = useSearchParams();
  const save = useMutate<{ scope: string; name: string; definition: unknown }, { list: { id: string } }>('POST', { invalidate: [[...LISTS_KEY]] });
  const team = role === 'owner' || role === 'admin' || role === 'team_lead';
  // R-PAR-27: typed text (a name search, a text field value) never goes into a team list; said before the tap
  const textInTeam = scope === 'team' && hasFreeText(source.definition);
  return (
    <Dialog
      title="Save as list"
      onClose={onClose}
      footer={
        <Button
          disabled={save.pending || name.trim() === '' || textInTeam}
          onClick={async () => {
            const r = await save.run('/smart-lists', { scope, name: name.trim(), definition: source.definition });
            if (r.ok) {
              await qc.invalidateQueries({ queryKey: [...LISTS_KEY] });
              sheets.announce(`Saved "${name.trim()}"`);
              onClose();
              setParams({ list: r.data.list.id });
            }
          }}
        >
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        {team ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="text-[15px] font-medium text-ink">Who sees it</legend>
            {(['personal', 'team'] as const).map((s) => (
              <label key={s} className="inline-flex min-h-tap items-center gap-3 text-[15px] text-ink">
                <input type="radio" name="scope" checked={scope === s} onChange={() => setScope(s)} />
                {s === 'personal' ? 'Only me' : 'My team (each person sees only their own people)'}
              </label>
            ))}
          </fieldset>
        ) : null}
        {textInTeam ? <Notice tone="error">{TEAM_TEXT_REFUSAL}</Notice> : null}
        {save.error ? <Notice tone="error">{messageFor(save.error.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
      </div>
    </Dialog>
  );
}
