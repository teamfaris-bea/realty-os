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
// Honest UI: the page always says "Showing people you can see" (R-PAR-28, E181); a count is exact to
// 10,000 and then says "10,000+"; a list that uses a protected tag says so before any send, and a bulk
// email, text or plan from it is refused at once (and by the server, which reads the list itself).
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, EmptyState, Icon, Notice, TextField, Dialog } from '../../design/index.js';
import { messageFor, useSession } from '../../shell/index.js';
import { relativeTime } from '../feed/lib/format.js';
import { useMutate, useNow } from '../feed/lib/hooks.js';
import { AgentSheetsProvider, useAgentSheets } from '../feed/lib/AgentSheets.js';
import {
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
} from './api.js';
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

/** The source named by the URL: ?list=<id>, ?tag=<id>&name=<name>, or everyone. */
export function sourceFromParams(p: URLSearchParams): Source {
  const list = p.get('list');
  if (list) return { kind: 'list', listId: list };
  const tag = p.get('tag');
  if (tag) return tagSource({ id: tag, name: p.get('name') ?? 'tag' });
  return EVERYONE;
}

function People() {
  const [params, setParams] = useSearchParams();
  const source = useMemo(() => sourceFromParams(params), [params]);
  const lists = useSmartLists();
  const { session } = useSession();
  const role = session?.tenant?.role;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allSelected, setAllSelected] = useState(false);
  useEffect(() => {
    setSelected(new Set());
    setAllSelected(false);
  }, [sourceKey(source)]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (s: Source) => {
    if (s.kind === 'all') setParams({});
    else if (s.kind === 'list') setParams({ list: s.listId });
    else {
      const t = (s.definition.all?.[0] as { tagIds?: string[] } | undefined)?.tagIds?.[0];
      if (t) setParams({ tag: t, name: s.label.replace(/^Tag: /, '') });
    }
  };
  const activeList = source.kind === 'list' ? lists.data?.lists.find((l) => l.id === source.listId) : undefined;
  const title = source.kind === 'all' ? 'Everyone' : source.kind === 'list' ? (activeList?.name ?? 'List') : source.label;

  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-6">
      <ListNav lists={lists.data?.lists ?? []} source={source} onOpen={open} />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
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
        />
      </div>
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
        <EmptyState icon="people" title="Nobody here yet">
          No one you can see matches this list.
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

      <ul aria-label="People" className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
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
  const [name, setName] = useState(source.label);
  const [scope, setScope] = useState<'personal' | 'team'>('personal');
  const qc = useQueryClient();
  const sheets = useAgentSheets();
  const [, setParams] = useSearchParams();
  const save = useMutate<{ scope: string; name: string; definition: unknown }, { list: { id: string } }>('POST', { invalidate: [[...LISTS_KEY]] });
  const team = role === 'owner' || role === 'admin' || role === 'team_lead';
  return (
    <Dialog
      title="Save as list"
      onClose={onClose}
      footer={
        <Button
          disabled={save.pending || name.trim() === ''}
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
        {save.error ? <Notice tone="error">{messageFor(save.error.code, LISTS_ERROR_MESSAGES)}</Notice> : null}
      </div>
    </Dialog>
  );
}
