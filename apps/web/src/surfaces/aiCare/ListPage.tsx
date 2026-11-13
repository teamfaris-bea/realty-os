// "Under AI care" (/ai-care; R-ISA-22, R-ISA-30; E521, E522): everyone the viewer may see under AI care, with Pause
// and Take over in one tap on each row, End behind More, and Resume on paused rows for their owner.
// - "Mine" and "Everyone you can see" (the API's team scope returns the same rows as all, V7, so it is not offered);
//   Live, Paused, Ended, All (no Held: the API's held filter filters nothing, V7); Owner/Admin also get "Overdue
//   handoffs", filtered here over ended rows, with "Showing k of n" when the API's 200-row limit cuts rows.
// - One row per person (the newest): every row's chip is the contact's latest assignment's (routes.ts:151-152).
// - lastAction and caps are omitted until the API fills them (V7). Times are the viewer's (R-ISA-29).
import { Link, useSearchParams } from 'react-router-dom';
import { Card, EmptyState, Icon, Notice } from '../../design/index.js';
import { type ListRow, type ListScope, type ListState, useAdmin, useIsaList } from './api.js';
import { AiCareControls, HoldBanner, UndoToastHost, targetOfRow, useHold, useViewer } from './Controls.js';
import { localDate, localTime } from './time.js';
import { SIDE_WORDS, endWords, escalationTopic, firstOf, isaMessage, pauseWords } from './words.js';

const STATES: { key: ListState; label: string }[] = [
  { key: 'live', label: 'Live' },
  { key: 'paused', label: 'Paused' },
  { key: 'ended', label: 'Ended' },
  { key: 'any', label: 'All' },
];

/** One row per contact, the newest first (the API orders by start). */
export function onePerContact(rows: readonly ListRow[]): ListRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.contactId) ? false : (seen.add(r.contactId), true)));
}

const tail = (s: string, re: RegExp) => re.exec(s)?.[1]?.trim().replace(/ /g, '_') ?? '';

/** The row's chip in words for this reader (never the API's "Waiting on you" to a non-owner, V5). */
export function chipWords(r: ListRow, isOwner: boolean): string {
  const c = r.chip;
  switch (c.kind) {
    case 'ended':
      return `Ended: ${endWords(tail(c.sentence, /^Ended:\s*(.*)$/))}`;
    case 'paused':
      return `Paused: nobody is following up automatically · ${pauseWords(tail(c.sentence, /^Paused:\s*(.*?)\s*\(nobody/))}`;
    case 'waiting_on_agent': {
      const topic = escalationTopic(tail(c.sentence, /^Waiting on [^:]*:\s*(.*)$/));
      return isOwner ? `Waiting on you: ${topic}` : `Waiting on ${firstOf(r.ownerName, 'the owner')}: ${topic}`;
    }
    case 'waiting_reply':
      return 'Waiting for their reply';
    case 'scheduling':
      return 'Scheduling';
    case 'reply_scheduled':
      return 'Reply planned';
    case 'held':
      return 'Held: sending is off or a daily limit is reached';
    default:
      return 'Active';
  }
}

export default function ListPage() {
  const [params, setParams] = useSearchParams();
  const { role } = useViewer(null, null);
  const admin = role === 'owner' || role === 'admin';
  const overdueOnly = params.get('filter') === 'overdue' && admin;
  const scope: ListScope = params.get('scope') === 'mine' ? 'mine' : 'all';
  const state: ListState = overdueOnly ? 'ended' : ((STATES.find((s) => s.key === params.get('state'))?.key ?? 'live') as ListState);
  const q = useIsaList(scope, state);
  const adminView = useAdmin(admin && overdueOnly);
  const hold = useHold(null);
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(params);
    if (v === null) n.delete(k);
    else n.set(k, v);
    setParams(n, { replace: true });
  };
  const rows = onePerContact(q.data?.rows ?? []).filter((r) => !overdueOnly || r.handoffOverdue);
  const pill = (on: boolean) => `inline-flex min-h-tap items-center rounded-full border px-3 text-[15px] font-medium ${on ? 'border-accent bg-accent-soft text-ink' : 'border-line bg-surface text-ink'}`;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 md:mx-0">
      <HoldBanner hold={hold} replies={false} />
      <div role="group" aria-label="Whose leads" className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={scope === 'mine'} className={pill(scope === 'mine')} onClick={() => set('scope', 'mine')}>
          Mine
        </button>
        <button type="button" aria-pressed={scope === 'all'} className={pill(scope === 'all')} onClick={() => set('scope', null)}>
          Everyone you can see
        </button>
      </div>
      <div role="group" aria-label="State" className="flex flex-wrap gap-2">
        {STATES.map((s) => (
          <button key={s.key} type="button" aria-pressed={!overdueOnly && state === s.key} className={pill(!overdueOnly && state === s.key)} onClick={() => setParams(new URLSearchParams({ ...(scope === 'mine' ? { scope: 'mine' } : {}), state: s.key }), { replace: true })}>
            {s.label}
          </button>
        ))}
        {admin ? (
          <button type="button" aria-pressed={overdueOnly} className={pill(overdueOnly)} onClick={() => set('filter', overdueOnly ? null : 'overdue')}>
            Overdue handoffs
          </button>
        ) : null}
      </div>
      {overdueOnly && adminView.data && rows.length < adminView.data.overdueHandoffs ? (
        <p className="text-[15px] text-ink-muted">
          Showing {rows.length} of {adminView.data.overdueHandoffs}
        </p>
      ) : null}
      {q.isPending ? <p className="py-6 text-center text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError && !(q.error.status === 403 || q.error.status === 404) ? <Notice tone="error">{isaMessage(q.error)}</Notice> : null}
      {q.data && rows.length === 0 ? <EmptyState icon="message" title="Nobody is under AI care." /> : null}
      {rows.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label="Under AI care">
          {rows.map((r) => (
            <li key={r.assignmentId}>
              <Row row={r} held={hold.sentence !== null} />
            </li>
          ))}
        </ul>
      ) : null}
      <UndoToastHost />
    </div>
  );
}

function Row({ row, held }: { row: ListRow; held: boolean }) {
  const viewer = useViewer(row.ownerUserId, row.ownerName);
  return (
    <Card as="article" className="flex flex-col gap-2" aria-labelledby={`ai-row-${row.assignmentId}`}>
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 id={`ai-row-${row.assignmentId}`} className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">
          <Link to={`/contacts/${row.contactId}`} aria-label={row.name} className="inline-flex min-h-tap max-w-full items-center truncate hover:underline">
            {row.name}
          </Link>
        </h2>
        <span className="shrink-0 text-[14px] text-ink-muted">{SIDE_WORDS[row.side] ?? ''}</span>
      </div>
      <p className="text-[15px] text-ink">{chipWords(row, viewer.isOwner)}</p>
      <ul className="flex flex-col gap-0.5 text-[14px] text-ink-muted">
        {row.nextTouchAt && row.chip.kind !== 'ended' ? <li>{held ? `Next follow-up planned for ${localTime(row.nextTouchAt)}, if sending is allowed then` : `Next follow-up ${localTime(row.nextTouchAt)}`}</li> : null}
        {row.inactivityReleaseAt ? <li>Returns to the pond on {localDate(row.inactivityReleaseAt)}. AI messages don't reset this.</li> : null}
        <li>Owner: {viewer.isOwner ? 'you' : row.ownerName || 'not named'}</li>
        {row.handoffOverdue ? (
          <li className="flex items-center gap-1 font-medium text-danger">
            <Icon name="alert" size={16} /> Handoff overdue
          </li>
        ) : null}
      </ul>
      {row.chip.kind !== 'ended' ? <AiCareControls target={targetOfRow(row)} label={`AI care for ${row.name}`} /> : null}
    </Card>
  );
}
