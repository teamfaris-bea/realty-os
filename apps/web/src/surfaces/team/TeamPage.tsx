// Team Lead live exception queue (BUILD_PLAN module 17 desktop-first surface; ARCHITECTURE §14 A5).
//
// - What is in the queue is decided by the server (R-ACC-1: derived only by core, kept per occurrence,
//   and live until its latest human event is resolved or verified). This page never hand-enters,
//   hides or re-derives an item. A live item whose condition already cleared says "Fixed late" and
//   still needs Resolve or Verify.
// - Each item shows its owner, its age and its evidence (source + where + a short explanation, with
//   "Check this" on anything flagged for review). Tapping evidence opens the call, text, task or lead.
// - Actions follow the server's per-item flags (Verify only for Team Lead/Admin/Owner, R-ACC-3):
//   Resolve needs a note; Verify and Reopen are one tap; Reassign is two taps (Reassign → the agent)
//   and goes through the ownership engine on the server, with the command id generated per tap.
// - The list refreshes every 30 s while open, so a change shows within the 60 s the plan allows; the
//   page says when it was last updated instead of pretending to be live.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, CheckThis, EmptyState, EvidenceLink, EvidenceRoutesProvider, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useCommand, useSession } from '../../shell/index.js';
import { formatAge, formatStamp } from '../admin/lib/format.js';
import { formatLocalDate } from '../feed/lib/format.js';
import { useAnnounce } from '../admin/lib/hooks.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';
import type { ExceptionItem, ExceptionType, ItemResponse, Member, MembersResponse, QueueResponse } from '../admin/lib/types.js';
import { Pill, Segmented, StatusLine, TextArea } from '../admin/lib/ui.js';
import { EVENT_LABEL, TYPES, TYPE_LABEL, TYPE_PLURAL, exceptionEvidenceView, ownerName, periodLabel } from './lib.js';

export const QUEUE_KEY = ['team', 'exceptions'] as const;
const REFRESH_MS = 30_000;

type View = 'live' | 'handled';

export default function TeamPage() {
  const api = useApi();
  const [view, setView] = useState<View>('live');
  const [type, setType] = useState<ExceptionType | 'all'>('all');
  const [status, announce] = useAnnounce();
  // a card's failure is shown here, above the list, because the refetch that follows a conflict can
  // remove the card (someone else resolved it) and the explanation must not vanish with it
  const [failure, setFailure] = useState<string | null>(null);
  const done = (text: string) => {
    setFailure(null);
    announce(text);
  };
  const q = useQuery<QueueResponse, ApiError>({
    queryKey: [...QUEUE_KEY, view],
    queryFn: ({ signal }) => api.get<QueueResponse>(`/team/exceptions?state=${view}&limit=200`, { signal }),
    refetchInterval: REFRESH_MS,
  });
  const items = (q.data?.items ?? []).filter((i) => type === 'all' || i.itemType === type);
  const counts = q.data?.counts;

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <Segmented<View>
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: 'live', label: 'Needs attention' },
            { value: 'handled', label: 'Handled' },
          ]}
        />
        {q.data ? <p className="text-[14px] text-ink-muted md:ml-auto">Updated {formatStamp(q.data.generatedAt)}</p> : null}
      </div>
      {view === 'live' && counts ? (
        <Segmented<ExceptionType | 'all'>
          label="Type"
          value={type}
          onChange={setType}
          options={[{ value: 'all', label: `All ${counts.live}` }, ...TYPES.map((t) => ({ value: t, label: `${TYPE_PLURAL[t]} ${counts.byType[t] ?? 0}` }))]}
        />
      ) : null}
      <StatusLine text={status} />
      {failure ? (
        <Notice
          tone="error"
          action={
            <Button variant="quiet" onClick={() => setFailure(null)}>
              Dismiss
            </Button>
          }
        >
          {failure}
        </Notice>
      ) : null}
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {q.data && view === 'live' && counts && q.data.items.length < counts.live ? (
        <p className="text-[14px] text-ink-muted">
          Showing the oldest {q.data.items.length} of {counts.live}.
        </p>
      ) : null}
      {q.data && items.length === 0 ? (
        <EmptyState icon="check" title={view === 'live' ? 'Nothing needs attention' : 'Nothing handled yet'}>
          {view === 'live' ? 'Untouched leads, overdue promises, undelivered messages, consults without an outcome and dates at risk on deals show up here.' : null}
        </EmptyState>
      ) : null}
      <ul className="flex flex-col gap-3">
        {items.map((i) => (
          <li key={i.dedupeKey}>
            <ExceptionCard item={i} onDone={done} onFailure={setFailure} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function keyPath(item: ExceptionItem, verb: string): string {
  return `/team/exceptions/${encodeURIComponent(item.dedupeKey)}/${verb}`;
}

export function ExceptionCard({ item, onDone, onFailure }: { item: ExceptionItem; onDone(text: string): void; onFailure(message: string): void }) {
  const [mode, setMode] = useState<'idle' | 'resolve' | 'reassign'>('idle');
  const opts = { invalidate: [[...QUEUE_KEY]] };
  const resolve = useCommand<{ note: string }, ItemResponse>(keyPath(item, 'resolve'), opts);
  const verify = useCommand<Record<string, never>, ItemResponse>(keyPath(item, 'verify'), opts);
  const reopen = useCommand<Record<string, never>, ItemResponse>(keyPath(item, 'reopen'), opts);
  const reassign = useCommand<{ toUserId: string; expectedSeq?: number }, ItemResponse>(keyPath(item, 'reassign'), opts);
  // a withdrawn item (the current rules make its period no item) is never live and never a late fix
  const withdrawn = item.withdrawn === true;
  const fixedLate = item.live && !withdrawn && item.conditionClearedAt !== null;
  const deal = item.deal ?? null;
  // b8 deals ui/F7: a milestone item names its deal and date (it has no contact), so the announcement says which
  const subject = item.contact?.name ?? (deal ? `${deal.name} (${deal.dateLabel})` : null);
  // R-PAR-32 / one period per card: an untouched lead's facts are its owner's period, labelled as earlier once it ended
  const period = periodLabel(item);

  const doVerify = async () => {
    const r = await verify.run({});
    if (r.ok) onDone(`Verified: ${TYPE_LABEL[item.itemType]}${subject ? ` for ${subject}` : ''}`);
    else onFailure(r.message);
  };
  const doReopen = async () => {
    const r = await reopen.run({});
    if (r.ok) onDone(`Reopened: ${TYPE_LABEL[item.itemType]}${subject ? ` for ${subject}` : ''}`);
    else onFailure(r.message);
  };

  return (
    <Card as="article" className="flex flex-col gap-3" aria-labelledby={`x-${item.id}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id={`x-${item.id}`} className="text-[17px] font-semibold text-ink">
            {TYPE_LABEL[item.itemType]}
            {item.contact ? (
              <>
                {' · '}
                <Link to={`/contacts/${item.contact.id}`} className="text-accent underline">
                  {item.contact.name}
                </Link>
              </>
            ) : null}
            {deal ? (
              <>
                {' · '}
                <Link to={`/deals/${deal.id}`} className="text-accent underline">
                  {deal.name}
                </Link>
                {` · ${deal.dateLabel}, ${formatLocalDate(deal.dueOn)}`}
              </>
            ) : null}
          </h2>
          <p className="text-[14px] text-ink-muted">
            {ownerName(item)} · open {formatAge(item.ageSeconds)}
            {item.dueAt ? ` · was due ${formatStamp(item.dueAt)}` : ''}
          </p>
        </div>
        {fixedLate ? <Pill tone="warn">Fixed late</Pill> : null}
        {withdrawn ? <Pill tone="neutral">No longer counted</Pill> : null}
        {!item.live && item.latestEvent ? <Pill tone="ok">{EVENT_LABEL[item.latestEvent.action]}</Pill> : null}
      </div>
      {fixedLate ? <p className="text-[14px] text-ink">This was put right after it was due. It stays here until someone resolves or verifies it.</p> : null}
      {withdrawn ? <p className="text-[14px] text-ink">Under the current rules this period is not a miss, so it no longer counts. Why is below.</p> : null}

      {period ? <p className="text-[14px] font-medium text-ink">{period}</p> : null}
      <ul aria-label="Evidence" className="flex flex-col gap-1 border-l-2 border-line pl-3">
        {item.evidence.map((e, n) => {
          const view = exceptionEvidenceView(e, { owner: item.itemType === 'untouched_lead' ? (item.owner?.name ?? null) : null });
          const link = <EvidenceLink evidence={view} />;
          return (
            <li key={`${e.sourceType}:${e.sourceId}:${n}`} className="flex flex-wrap items-center gap-2 text-ink-muted">
              {/* evidence the server could not link (source hidden from this viewer or not openable) renders as text */}
              {e.link ? link : <EvidenceRoutesProvider routes={{}}>{link}</EvidenceRoutesProvider>}
              {e.needsReview ? <CheckThis reason="The assistant wasn't sure about this. Check it before acting on it." /> : null}
            </li>
          );
        })}
      </ul>

      {item.latestEvent ? (
        <p className="text-[14px] text-ink-muted">
          {EVENT_LABEL[item.latestEvent.action]} by {item.latestEvent.actor.name ?? 'a former member'} · {formatStamp(item.latestEvent.at)}
          {item.latestEvent.note ? `: “${item.latestEvent.note}”` : ''}
        </p>
      ) : null}

      {mode === 'resolve' ? (
        <ResolveForm
          pending={resolve.pending}
          onCancel={() => setMode('idle')}
          onSubmit={async (note) => {
            const r = await resolve.run({ note });
            if (r.ok) {
              setMode('idle');
              onDone(`Resolved: ${TYPE_LABEL[item.itemType]}${subject ? ` for ${subject}` : ''}`);
            } else onFailure(r.message);
          }}
        />
      ) : mode === 'reassign' ? (
        <ReassignPicker
          item={item}
          pending={reassign.pending}
          onCancel={() => setMode('idle')}
          onPick={async (m) => {
            // the stale-UI fence: if the lead moved since this queue was read, the server refuses (LEAD_STATE_CHANGED)
            const r = await reassign.run({ toUserId: m.userId, ...(item.contactOwnershipSeq !== null ? { expectedSeq: item.contactOwnershipSeq } : {}) });
            if (r.ok) {
              setMode('idle');
              onDone(`Reassigned ${subject ?? 'the lead'} to ${m.name}`);
            } else onFailure(r.message);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {item.actions.resolve ? (
            <Button variant="secondary" onClick={() => setMode('resolve')}>
              Resolve
            </Button>
          ) : null}
          {item.actions.reassign ? (
            <Button variant="secondary" onClick={() => setMode('reassign')}>
              Reassign
            </Button>
          ) : null}
          {item.actions.verify ? (
            <Button variant="secondary" icon="check" pending={verify.pending} onClick={() => void doVerify()}>
              Verify
            </Button>
          ) : null}
          {item.actions.reopen ? (
            <Button variant="quiet" pending={reopen.pending} onClick={() => void doReopen()}>
              Reopen
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function ResolveForm({ pending, onSubmit, onCancel }: { pending: boolean; onSubmit(note: string): Promise<void>; onCancel(): void }) {
  const [note, setNote] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (note.trim()) void onSubmit(note.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <TextArea label="What was done?" hint="A note is required to resolve." value={note} maxLength={500} autoFocus onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <Button type="submit" pending={pending} disabled={note.trim().length === 0}>
          Resolve
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export interface Candidate {
  userId: string;
  name: string;
}

const OFFERABLE = new Set(['agent', 'team_lead', 'isa']);

/** Who a lead can be reassigned to: Owner/Admin pick from active members; a Team Lead from their team. */
export function useReassignCandidates(enabled: boolean) {
  const api = useApi();
  const { session } = useSession();
  const tenantWide = session?.tenant?.role === 'owner' || session?.tenant?.role === 'admin';
  return useQuery<Candidate[], ApiError>({
    queryKey: ['team', 'candidates', tenantWide],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      if (tenantWide) {
        const r = await api.get<MembersResponse>('/members', { signal });
        return r.members.filter((m: Member) => m.status === 'active' && OFFERABLE.has(m.role) && m.acceptingLeads).map((m) => ({ userId: m.userId, name: m.displayName }));
      }
      const r = await api.get<{ members: { userId: string; name: string | null }[] }>('/team/scoreboard?range=today', { signal });
      return r.members.map((m) => ({ userId: m.userId, name: m.name ?? 'Unnamed member' }));
    },
  });
}

function ReassignPicker({ item, pending, onPick, onCancel }: { item: ExceptionItem; pending: boolean; onPick(c: Candidate): Promise<void>; onCancel(): void }) {
  const q = useReassignCandidates(true);
  const list = (q.data ?? []).filter((c) => c.userId !== item.owner?.userId);
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Reassign to">
      <p className="text-[15px] font-medium text-ink">Reassign {item.contact?.name ?? 'this lead'} to</p>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {q.data && list.length === 0 ? <p className="text-[15px] text-ink-muted">There is no one else who can take this lead.</p> : null}
      <div className="flex flex-wrap gap-2">
        {list.map((c) => (
          <Button key={c.userId} variant="secondary" disabled={pending} onClick={() => void onPick(c)}>
            {c.name}
          </Button>
        ))}
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
