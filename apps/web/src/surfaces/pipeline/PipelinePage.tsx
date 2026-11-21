// Stage pipeline: the eight fixed contact stages as columns. Drag a card on desktop, or tap Move
// (the phone has no drag: a stage switcher and a list). Counts and the cards are the people the
// viewer can see (RLS). A saved smart list and an agent narrow both. A stage change goes through
// POST /contacts/:id/stage, with Undo. A locked stage says why before the tap.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type MutableRefObject, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Dialog, EmptyState, Notice } from '../../design/index.js';
import { ApiError, messageFor, useApi } from '../../shell/index.js';
import { intentLabel } from '../feed/lib/format.js';
import { AgentSheetsProvider } from '../feed/lib/AgentSheets.js';
import { PEOPLE_ERROR_MESSAGES } from '../people-edit/api.js';
import { useIsDesktop, useToast } from '../people-edit/hooks.js';
import { LOCKED_FOR_NOW, type StageResponse } from '../people-edit/stageFlow.js';
import { type PersonView, type SmartListView, useFilterOptions, usePeople, useSmartLists, useStageGuide } from '../people/api.js';
import { boardDefinition, countLabel, stageDefinition } from './board.js';

interface StageCount {
  stage: string;
  count: number;
  capped: boolean;
}

export default function PipelinePage() {
  return (
    <AgentSheetsProvider>
      <Pipeline />
    </AgentSheetsProvider>
  );
}

function Pipeline() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const desktop = useIsDesktop();
  const [params, setParams] = useSearchParams();
  const agent = params.get('agent');
  const listId = params.get('list');
  const phoneStage = params.get('stage') ?? 'new';
  const { stages, labelOf } = useStageGuide();
  const lists = useSmartLists();
  const options = useFilterOptions();
  const activeList = listId ? lists.data?.lists.find((l) => l.id === listId) : undefined;
  const board = boardDefinition(activeList ? { v: 1, all: activeList.definition.all ?? [], ...(activeList.definition.any ? { any: activeList.definition.any } : {}) } : null, agent);
  const counts = useQuery<{ counts: StageCount[] }, ApiError>({
    queryKey: ['people', 'stage-counts', listId ?? '', agent ?? ''],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams();
      if (listId) q.set('list', listId);
      if (agent) q.set('owner', agent);
      const s = q.toString();
      return api.get(`/people/stage-counts${s ? `?${s}` : ''}`, { signal });
    },
  });
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moving, setMoving] = useState<PersonView | null>(null);
  const drag = useRef<{ id: string; from: string } | null>(null);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const move = async (id: string, to: string, from: string) => {
    if (to === from) return;
    setMoveError(null);
    try {
      const data = await api.post<StageResponse>(`/contacts/${id}/stage`, { stage: to });
      await qc.invalidateQueries({ queryKey: ['people'] });
      await qc.invalidateQueries({ queryKey: ['timeline', id] });
      const eventId = data.eventId ?? null;
      toast({
        text: `Stage: ${data.stage.label}`,
        ...(eventId ? { undo: () => void undo(id, from, eventId, labelOf(from)) } : {}),
      });
      setMoving(null);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
      setMoveError(messageFor(err, PEOPLE_ERROR_MESSAGES));
    }
  };

  const undo = async (id: string, to: string, eventId: string, label: string) => {
    try {
      await api.post<StageResponse>(`/contacts/${id}/stage`, { stage: to, undoOf: eventId });
      await qc.invalidateQueries({ queryKey: ['people'] });
      await qc.invalidateQueries({ queryKey: ['timeline', id] });
      toast({ text: `Stage back to ${label}.` });
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
      toast({ text: messageFor(err, PEOPLE_ERROR_MESSAGES) });
    }
  };

  const countOf = (key: string) => counts.data?.counts.find((c) => c.stage === key);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <p className="text-[14px] text-ink-muted">Showing people you can see.</p>
      <FilterBar
        agent={agent}
        listId={listId}
        members={options.data?.members ?? []}
        lists={lists.data?.lists ?? []}
        onAgent={(id) => setParam('agent', id)}
        onList={(id) => setParam('list', id)}
      />
      {counts.isError ? <Notice tone="error">{messageFor(counts.error, PEOPLE_ERROR_MESSAGES)}</Notice> : null}
      {moveError ? <Notice tone="error">{moveError}</Notice> : null}
      {desktop ? (
        <div className="flex gap-3 overflow-x-auto pb-2" aria-label="Stages">
          {stages.map((s) => (
            <Column
              key={s.key}
              stage={s.key}
              label={s.label}
              count={countOf(s.key)}
              definition={stageDefinition(board, s.key)}
              drag={drag}
              onMove={(id, from) => void move(id, s.key, from)}
              onOpenMove={setMoving}
            />
          ))}
        </div>
      ) : (
        <PhoneBoard
          stages={stages}
          selected={phoneStage}
          countOf={countOf}
          definition={stageDefinition(board, stages.some((s) => s.key === phoneStage) ? phoneStage : 'new')}
          onSelect={(key) => setParam('stage', key)}
          onOpenMove={setMoving}
        />
      )}
      {moving ? <MoveDialog person={moving} labelOf={labelOf} onClose={() => setMoving(null)} onPick={(to) => void move(moving.id, to, moving.stage)} /> : null}
    </div>
  );
}

function FilterBar({
  agent,
  listId,
  members,
  lists,
  onAgent,
  onList,
}: {
  agent: string | null;
  listId: string | null;
  members: { userId: string; name: string; active: boolean }[];
  lists: SmartListView[];
  onAgent: (id: string | null) => void;
  onList: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex max-w-xs flex-col gap-1 text-[15px] font-medium text-ink">
        Agent
        <select value={agent ?? ''} onChange={(e) => onAgent(e.target.value || null)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink">
          <option value="">Everyone I can see</option>
          {members
            .filter((m) => m.active)
            .map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
        </select>
      </label>
      <div role="group" aria-label="Lists" className="flex gap-2 overflow-x-auto pb-1">
        <ListChip pressed={!listId} onClick={() => onList(null)}>
          Everyone
        </ListChip>
        {lists.map((l) => (
          <ListChip key={l.id} pressed={listId === l.id} onClick={() => onList(l.id)}>
            {l.name}
          </ListChip>
        ))}
      </div>
    </div>
  );
}

function ListChip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className={`inline-flex min-h-tap shrink-0 items-center rounded-full border px-4 text-[15px] font-medium ${pressed ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface text-ink'}`}>
      {children}
    </button>
  );
}

function Column({
  stage,
  label,
  count,
  definition,
  drag,
  onMove,
  onOpenMove,
}: {
  stage: string;
  label: string;
  count: StageCount | undefined;
  definition: ReturnType<typeof stageDefinition>;
  drag: MutableRefObject<{ id: string; from: string } | null>;
  onMove: (id: string, from: string) => void;
  onOpenMove: (p: PersonView) => void;
}) {
  const q = usePeople({ kind: 'definition', definition, label });
  const people = q.data?.pages.flatMap((p) => p.people) ?? [];
  const n = count ? countLabel(count.count, count.capped) : '…';
  return (
    <section
      aria-label={`${label}, ${n}`}
      className="flex w-72 shrink-0 flex-col gap-2 rounded-2xl bg-surface-2 p-2"
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const d = drag.current;
        drag.current = null;
        if (d && d.from !== stage) onMove(d.id, d.from);
      }}
    >
      <h2 className="flex items-baseline justify-between gap-2 px-1 text-[15px] font-semibold text-ink">
        <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
        <span className="text-[13px] font-medium text-ink-muted">{n}</span>
      </h2>
      {q.isError ? <Notice tone="error">{messageFor(q.error, PEOPLE_ERROR_MESSAGES)}</Notice> : null}
      {q.data && people.length === 0 ? <p className="px-1 py-2 text-[14px] text-ink-muted">No one here.</p> : null}
      <ul className="flex flex-col gap-2">
        {people.map((p) => (
          <li key={p.id}>
            <PersonCard
              person={p}
              draggable
              onDragStart={() => {
                drag.current = { id: p.id, from: stage };
              }}
              onMove={() => onOpenMove(p)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PhoneBoard({
  stages,
  selected,
  countOf,
  definition,
  onSelect,
  onOpenMove,
}: {
  stages: readonly { key: string; label: string }[];
  selected: string;
  countOf: (key: string) => StageCount | undefined;
  definition: ReturnType<typeof stageDefinition>;
  onSelect: (key: string) => void;
  onOpenMove: (p: PersonView) => void;
}) {
  const current = stages.find((s) => s.key === selected) ?? stages[0];
  const q = usePeople({ kind: 'definition', definition, label: current?.label ?? 'Stage' });
  const people = q.data?.pages.flatMap((p) => p.people) ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Stages" className="flex gap-2 overflow-x-auto pb-1">
        {stages.map((s) => {
          const c = countOf(s.key);
          const n = c ? countLabel(c.count, c.capped) : '…';
          const on = s.key === (current?.key ?? selected);
          return (
            <button key={s.key} type="button" role="tab" aria-selected={on} onClick={() => onSelect(s.key)} className={`inline-flex min-h-tap shrink-0 items-center gap-2 rounded-full border px-4 text-[15px] font-medium ${on ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface text-ink'}`}>
              {s.label}
              <span className={on ? 'text-accent-ink' : 'text-ink-muted'}>{n}</span>
            </button>
          );
        })}
      </div>
      {q.isError ? <Notice tone="error">{messageFor(q.error, PEOPLE_ERROR_MESSAGES)}</Notice> : null}
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.data && people.length === 0 ? <EmptyState icon="people" title="No one in this stage" /> : null}
      <ul className="flex flex-col gap-2">
        {people.map((p) => (
          <li key={p.id}>
            <PersonCard person={p} onMove={() => onOpenMove(p)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function PersonCard({ person, draggable = false, onDragStart, onMove }: { person: PersonView; draggable?: boolean; onDragStart?: () => void; onMove: () => void }) {
  const intent = intentLabel(person.intent);
  return (
    <article
      draggable={draggable}
      onDragStart={onDragStart}
      className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <Link to={`/contacts/${person.id}`} className="min-w-0 flex-1 text-[16px] font-medium text-ink underline-offset-2 hover:underline [overflow-wrap:anywhere]">
          {person.displayName}
        </Link>
        <Button variant="quiet" className="shrink-0" onClick={onMove} aria-label={`Move ${person.displayName}`}>
          Move
        </Button>
      </div>
      <p className="text-[14px] text-ink-muted">{[intent, person.owner?.displayName].filter(Boolean).join(' · ') || 'No owner'}</p>
    </article>
  );
}

function MoveDialog({ person, labelOf, onClose, onPick }: { person: PersonView; labelOf: (key: string) => string; onClose: () => void; onPick: (stage: string) => void }) {
  const api = useApi();
  const why = useId();
  const q = useQuery<{ details: { stage: { locked: string[] } } }, ApiError>({
    queryKey: ['people', 'details', person.id],
    queryFn: ({ signal }) => api.get(`/contacts/${person.id}/details`, { signal }),
  });
  const { stages } = useStageGuide();
  const locked = new Set(q.data?.details.stage.locked ?? []);
  return (
    <Dialog title={`Move ${person.displayName}`} onClose={onClose} footer={<Button variant="secondary" block onClick={onClose}>Cancel</Button>}>
      <p className="mb-2 text-[14px] text-ink-muted">Now in {labelOf(person.stage)}.</p>
      {locked.size > 0 ? (
        <p id={why} className="mb-3 rounded-xl bg-warn-soft px-3 py-2 text-[15px] text-ink">
          {PEOPLE_ERROR_MESSAGES.STAGE_NEEDS_CONTACT ?? LOCKED_FOR_NOW}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1" aria-label="Stages">
        {stages.map((s) => {
          const isLocked = locked.has(s.key);
          const current = s.key === person.stage;
          return (
            <li key={s.key}>
              <button
                type="button"
                disabled={isLocked || current || q.isPending}
                aria-describedby={isLocked ? why : undefined}
                onClick={() => onPick(s.key)}
                className="flex min-h-tap w-full items-center justify-between rounded-xl border border-line bg-surface px-3 text-left text-[16px] font-medium text-ink disabled:opacity-60"
              >
                <span>{s.label}</span>
                <span className="text-[13px] font-normal text-ink-muted">{current ? 'Current' : isLocked ? 'Locked' : ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
