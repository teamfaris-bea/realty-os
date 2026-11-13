// AI care in the feed (R-ISA-14, R-ISA-30; E521, E533; docs/AI_ISA.md §10.3):
// - ai_isa_* cards render AiCareFeedCard, never the generic "Review" card;
// - activity: what happens to their reply, from the shared live query;
// - escalation: the held topic or the "check this", in words, with its one fix;
// - handoff: the full package (GET /ai-isa/handoffs/:id): why, the appointment and times offered when present, what
//   they told the AI (their quoted words), the lines the AI wrote and whether each went, what is unanswered, the next
//   steps, the notes and the deadline, naming who may meet it. "Got it" never meets it (R-ISA-30). There is no Cancel
//   for a scheduled confirmation (Q3): the sheet says what stops it. A met deadline says "Done" and the card stays
//   (V9, Q10: nothing in module 75 closes these cards yet).
// - every other card of a contact under live care gets the strip "AI care is on" with Pause, Take over and End.
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, Dialog, announce, useCountdownAnnouncement } from '../../design/index.js';
import { useSession } from '../../shell/index.js';
import { useContact } from '../contact/useContact.js';
import { useAgentSheets } from '../feed/lib/AgentSheets.js';
import { countdownWords, formatCountdown } from '../feed/lib/format.js';
import { useNow } from '../feed/lib/hooks.js';
import type { FeedCard } from '../feed/lib/types.js';
import { type AckResult, type HandoffView, type ListRow, useHandoff, useIsaAction, useLiveRow, usePanel } from './api.js';
import { AiCareControls, HoldBanner, type HoldState, UndoToastHost, type ViewerInfo, cap, stateOfPanel, targetOfPanel, targetOfRow, useHold, useViewer } from './Controls.js';
import { localTime } from './time.js';
import { CARE_STATE_WORDS, OTHER_CHECK, SLA_HAS_DEADLINE, UNBUILT_STEPS, bookedWhen, handoffHolder, ownerWho, bookedWords, closedReasonWords, escalationTopic, fillLine, firstOf, handoffWhy, messageVerb, nextStepWords, noDeadlineWords, noteWords } from './words.js';

export const isAiCareCard = (c: Pick<FeedCard, 'itemType'>) => c.itemType.startsWith('ai_isa_');

/** FeedPage's one element: an AI card, or the card as the feed draws it plus the strip when care is live. */
export function AiFeedItem({ card, render }: { card: FeedCard; render: (c: FeedCard) => ReactNode }) {
  if (isAiCareCard(card)) return <AiCareFeedCard card={card} />;
  return (
    <>
      {render(card)}
      <LiveStrip contactId={card.contact?.id ?? null} />
    </>
  );
}

function LiveStrip({ contactId }: { contactId: string | null }) {
  const row = useLiveRow(contactId);
  // batch 13 isa-4 F2: the hold banner on every AI care surface (the shared query's holdSentence; no panel here, so no
  // replies clause)
  const hold = useHold(null);
  if (!row) return null;
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2" data-testid="ai-feed-strip">
      <p className="text-[15px] font-semibold text-ink">AI care is on</p>
      <HoldBanner hold={hold} first={firstOf(row.name, 'them')} replies={false} />
      <AiCareControls target={targetOfRow(row)} label={`AI care for ${row.name}`} />
    </div>
  );
}

function useOwner(contactId: string | null, row: ListRow | null) {
  const c = useContact(contactId ?? '');
  const full = c.data?.contact.view === 'full' ? c.data.contact : null;
  const ownerUserId = row?.ownerUserId ?? full?.owner?.userId ?? null;
  const ownerName = row?.ownerName ?? full?.owner?.displayName ?? null;
  return { ownerUserId, ownerName, contact: full };
}

const LABEL: Record<string, string> = { ai_isa_handoff: 'AI care handed back', ai_isa_escalation: 'The AI assistant needs you', ai_isa_activity: 'AI care' };

export function AiCareFeedCard({ card }: { card: FeedCard }) {
  const contactId = card.contact?.id ?? null;
  const row = useLiveRow(contactId);
  const o = useOwner(contactId, row);
  const viewer = useViewer(o.ownerUserId, o.ownerName);
  const name = card.contact?.name ?? 'This person';
  // batch 13 isa-4 F2: every AI card carries the hold banner; an escalation card reads the panel (its body does too, one
  // query), so a panel link hold adds the replies clause there
  const escalation = card.itemType === 'ai_isa_escalation';
  const panel = usePanel(contactId ?? '', escalation);
  const hold = useHold(escalation ? panel.data : null);
  return (
    <Card as="article" aria-labelledby={`ai-card-${card.id}`} className="flex flex-col gap-3 border-accent/50" data-testid={`ai-card-${card.itemType}`}>
      <div>
        <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">{LABEL[card.itemType] ?? 'AI care'}</p>
        <h3 id={`ai-card-${card.id}`} className="truncate text-[19px] font-semibold text-ink">
          {card.contact ? (
            <Link to={`/contacts/${card.contact.id}`} className="inline-flex min-h-tap items-center hover:underline">
              {card.contact.name}
            </Link>
          ) : (
            name
          )}
        </h3>
      </div>
      <HoldBanner hold={hold} first={firstOf(card.contact?.name, 'them')} viewer={viewer} />
      {card.itemType === 'ai_isa_handoff' ? <HandoffBody card={card} viewer={viewer} ownerUserId={o.ownerUserId} /> : escalation ? <EscalationBody card={card} viewer={viewer} ownerName={o.ownerName} /> : <ActivityBody card={card} row={row} hold={hold} viewer={viewer} />}
      <UndoToastHost ownerUserId={o.ownerUserId ?? undefined} ownerName={o.ownerName} />
    </Card>
  );
}

function OpenThread({ contactId }: { contactId: string }) {
  return (
    <Link to={`/contacts/${contactId}/thread`} className="inline-flex min-h-tap items-center text-[15px] font-medium text-accent underline">
      Open thread
    </Link>
  );
}

function ActivityBody({ card, row, hold, viewer }: { card: FeedCard; row: ListRow | null; hold: HoldState; viewer: ViewerInfo }) {
  const id = card.contact?.id ?? '';
  if (!row)
    return (
      <p className="text-[15px] text-ink">
        They replied while AI care was on. AI care isn't live now; open the person to see why.
      </p>
    );
  return (
    <>
      <p className="text-[15px] text-ink">
        {hold.sentence
          ? // batch 13 isa-4 F2: nothing implies a live send while a hold applies
            `They replied. Nothing the AI assistant writes reaches ${firstOf(row.name, 'them')} from this deployment; if it can't answer, it hands the reply to ${ownerWho(viewer)}.`
          : `They replied. The AI assistant takes this turn, or hands it to ${ownerWho(viewer)} if it can't.`}
      </p>
      <AiCareControls target={targetOfRow(row)} label={`AI care for ${row.name}`} />
      <OpenThread contactId={id} />
    </>
  );
}

export type EscalationType = 'hold_topic' | 'check_this' | 'booked_after_end' | 'booked_not_handed_back' | null;

/**
 * "AI_ISA_HOLD_TOPIC:pricing_negotiation" → { type, class }. ISA-2b's booking cards (isa/booking/book.ts bookedCardInTx)
 * carry AI_ISA_BOOKED_AFTER_END or AI_ISA_BOOKED_NOT_HANDED_BACK with the booked time in their sentence (batch 13 isa-4
 * F1); any other code is an unknown check (type null), said as "Another check" with no claim.
 */
export function escalationOf(card: Pick<FeedCard, 'reasons'>): { type: EscalationType; cls: string; when: string | null } {
  const r = card.reasons.find((x) => x.code.startsWith('AI_ISA_'));
  const code = r?.code ?? '';
  if (code === 'AI_ISA_BOOKED_AFTER_END') return { type: 'booked_after_end', cls: '', when: bookedWhen(r?.label) };
  if (code === 'AI_ISA_BOOKED_NOT_HANDED_BACK') return { type: 'booked_not_handed_back', cls: '', when: bookedWhen(r?.label) };
  const m = /^AI_ISA_(HOLD_TOPIC|CHECK_THIS):([a-z_]+)$/.exec(code);
  return m ? { type: m[1] === 'HOLD_TOPIC' ? 'hold_topic' : 'check_this', cls: m[2]!, when: null } : { type: null, cls: '', when: null };
}

function EscalationBody({ card, viewer, ownerName }: { card: FeedCard; viewer: ViewerInfo; ownerName: string | null }) {
  const contactId = card.contact?.id ?? '';
  const panel = usePanel(contactId);
  const { type, cls, when } = escalationOf(card);
  const resolve = useIsaAction<{ class: string }, { cleared: string }>('POST', { kind: 'resolve', contactId });
  const [line, setLine] = useState<string | null>(null);
  const p = panel.data;
  const target = p ? targetOfPanel(p, card.contact?.name ?? 'them', ownerName) : null;
  const ended = p ? stateOfPanel(p) === 'ended' : false;
  if (type === 'hold_topic')
    return (
      <>
        <p className="text-[15px] text-ink">
          Waiting on {viewer.isOwner ? 'you' : viewer.ownerFirst}: {escalationTopic(cls)}. The AI assistant is staying off this topic.
        </p>
        {!ended ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              pending={resolve.pending}
              onClick={async () => {
                const r = await resolve.run(`/ai-isa/escalations/${card.subjectId}/resolve`, { class: cls });
                const t = r.ok ? 'Marked handled. The AI assistant may continue the conversation, and still stays off this topic.' : r.message;
                setLine(t);
                announce(t);
              }}
            >
              I've handled it; the AI may continue
            </Button>
          </div>
        ) : null}
        {target && !ended ? <AiCareControls target={target} /> : null}
        {line ? <p className="text-[14px]">{line}</p> : null}
        <OpenThread contactId={contactId} />
      </>
    );
  if (type === 'booked_after_end' || type === 'booked_not_handed_back') {
    // batch 13 isa-4 F1: what was booked and where to confirm or cancel it; the state care is in comes from the panel
    // (care ended before the booking, or the booking paused it), never assumed
    const state = p ? stateOfPanel(p) : null;
    const now = state === null || (type === 'booked_after_end' && state === 'ended') ? null : CARE_STATE_WORDS[state];
    return (
      <>
        <p className="text-[15px] text-ink">{bookedWords(type, when)}</p>
        {now ? <p className="text-[15px] text-ink">{now}</p> : null}
        <Link to="/tasks" className="inline-flex min-h-tap items-center text-[15px] font-medium text-accent underline">
          Confirm or cancel it in Tasks
        </Link>
        {target && !ended ? <AiCareControls target={target} /> : null}
        <OpenThread contactId={contactId} />
      </>
    );
  }
  if (type === null)
    return (
      <>
        <p className="text-[15px] text-ink">{OTHER_CHECK}.</p>
        {target && !ended ? <AiCareControls target={target} /> : null}
        <OpenThread contactId={contactId} />
      </>
    );
  return (
    <>
      <p className="text-[15px] text-ink">Check this: {escalationTopic(cls)}. AI care is paused.</p>
      {target && !ended ? <AiCareControls target={target} /> : null}
      {cls === 'other_agent' ? <p className="text-[14px] text-ink-muted">Ending AI care records no "has an agent" block.</p> : null}
      <OpenThread contactId={contactId} />
    </>
  );
}

// ---- the handoff ----------------------------------------------------------------------------------------------------

function Deadline({ dueAt, label }: { dueAt: string; label: string }) {
  const now = useNow(1000);
  const due = Date.parse(dueAt);
  const left = formatCountdown(due, now);
  useCountdownAnnouncement(label, due - now);
  return (
    <span className="flex flex-wrap items-center gap-2 text-[15px]">
      Respond by {localTime(dueAt)}
      {left === null ? (
        <span className="font-semibold text-danger">Overdue</span>
      ) : (
        <span role="timer" aria-label={`${label}: ${countdownWords(due, now)}`} className="font-semibold tabular-nums text-warn">
          {left} left
        </span>
      )}
    </span>
  );
}

function pendingLine(m: NonNullable<HandoffView['pendingMessage']>): string {
  const v = messageVerb(m.status);
  if (v === 'sent') return 'went out';
  if (v === 'scheduled') return m.scheduledFor ? `scheduled for ${localTime(m.scheduledFor)}` : 'scheduled';
  if (v === 'queued') return 'queued';
  return m.kind === 'confirmation' ? 'not sent: confirm by hand' : 'not sent';
}

function HandoffBody({ card, viewer, ownerUserId }: { card: FeedCard; viewer: ViewerInfo; ownerUserId: string | null }) {
  const h = useHandoff(card.subjectId);
  const { session } = useSession();
  const team = session?.tenant?.name ?? 'the team';
  const contactId = card.contact?.id ?? '';
  const first = firstOf(card.contact?.name, 'them');
  const [sheet, setSheet] = useState<AckResult | null>(null);
  const ack = useIsaAction<Record<string, never>, AckResult>('POST', { kind: 'ack', contactId });
  if (h.isError) return <p className="text-[15px] text-ink">Full handoff details are not available.</p>;
  if (!h.data) return <p className="text-[15px] text-ink-muted">Loading</p>;
  const d = h.data;
  const pkg = d.package;
  const agent = viewer.isOwner ? firstOf(session?.user.displayName, 'your agent') : viewer.ownerFirst;
  // batch 13 isa-4 F4: who besides Owner/Admin may mark it seen: the recipient as ISA-2b routes it (Q1), named when known
  const holder = handoffHolder({ recipientUserId: d.recipientUserId, viewerUserId: viewer.userId, ownerUserId, ownerFirst: viewer.ownerFirst, tookOver: d.reason === 'taken_over' });
  return (
    <div className="flex flex-col gap-3">
      <Block title="Why">{handoffWhy(d.reason, pkg.escalation ?? null)}</Block>
      {pkg.appointment ? <Block title="Appointment">An appointment was booked. {pkg.appointment.confirmationQueued ? 'A confirmation was queued.' : 'No confirmation was queued.'}</Block> : null}
      {pkg.openOffer && pkg.openOffer.slots.length > 0 ? (
        <Block title="Times offered">
          <ul>
            {pkg.openOffer.slots.map((s) => (
              <li key={s.startsAt}>{localTime(s.startsAt)}</li>
            ))}
          </ul>
        </Block>
      ) : null}
      {(pkg.claims ?? []).length > 0 ? (
        <Block title="What they told the AI">
          <ul className="flex flex-col gap-1">
            {pkg.claims!.map((c) => (
              <li key={c.claimId}>
                <span className="font-medium">{c.field.replace(/_/g, ' ').replace(/ stated$/, '')}:</span> {String(c.value)}
                {/financ/.test(c.field) ? ' (as stated by the client)' : ''} · “{c.quote}”{' '}
                <Link to={`/contacts/${contactId}/thread#${c.messageId}`} className="text-accent underline">
                  Their message
                </Link>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}
      {(pkg.commitments ?? []).length > 0 || (pkg.factsSent ?? []).length > 0 ? (
        <Block title="Lines the AI wrote with this handoff">
          <ul className="flex flex-col gap-1">
            {(pkg.commitments ?? []).map((l) => {
              const text = fillLine(l, agent, team);
              return text ? (
                <li key={l}>
                  “{text}”{d.pendingMessage ? ` · ${pendingLine(d.pendingMessage)}` : ''}
                </li>
              ) : null;
            })}
            {(pkg.factsSent ?? []).length > 0 ? <li>{pkg.factsSent!.length} facts shared earlier.</li> : null}
          </ul>
        </Block>
      ) : null}
      {(pkg.unansweredInbound ?? []).length > 0 ? (
        <Block title="Not answered yet">
          {pkg.unansweredInbound!.length} message{pkg.unansweredInbound!.length === 1 ? '' : 's'} from them {pkg.unansweredInbound!.length === 1 ? 'has' : 'have'} no answer.
        </Block>
      ) : null}
      {(pkg.nextSteps ?? []).length > 0 ? (
        <Block title="Next steps">
          <div className="flex flex-wrap gap-2">
            {pkg.nextSteps!.map((s) => (
              <NextStep key={s} step={s} contactId={contactId} name={card.contact?.name ?? 'them'} />
            ))}
          </div>
        </Block>
      ) : null}
      {(pkg.notes ?? []).length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-[15px]">
          {[...new Set(pkg.notes!.map(noteWords))].map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <Link to={`/contacts/${contactId}/thread`} className="inline-flex min-h-tap items-center text-[15px] font-medium text-accent underline">
        Read the conversation
      </Link>
      {d.slaMetAt ? (
        <p className="text-[15px] font-semibold text-ok">
          Done: {first} was reached at {localTime(d.slaMetAt)}
        </p>
      ) : d.closedReason ? (
        // batch 13 merge (0081, b12 recheck R19): the system closed it, so it is done and has no deadline left
        <p className="text-[15px] font-semibold text-ok">{closedReasonWords(d.closedReason)}</p>
      ) : !SLA_HAS_DEADLINE[d.slaClass] ? (
        // 0081 (b12 review B12X-2): no human touch can clear it, so there is no deadline to count down
        <p className="text-[15px] text-ink">{noDeadlineWords(first)}</p>
      ) : (
        <>
          <Deadline dueAt={d.slaDueAt} label={`Handoff for ${card.contact?.name ?? 'this lead'}`} />
          <p className="text-[14px] text-ink-muted">
            Got it doesn't meet the deadline: a call, text or email to {first} from {viewer.isOwner ? 'you' : viewer.ownerFirst} or a collaborator does.
          </p>
        </>
      )}
      {d.acknowledgedAt ? <p className="text-[14px] text-ink-muted">Seen at {localTime(d.acknowledgedAt)}.</p> : null}
      {d.canAcknowledge && !d.acknowledgedAt ? (
        <div>
          <Button
            variant="secondary"
            pending={ack.pending}
            onClick={async () => {
              const r = await ack.run(`/ai-isa/handoffs/${d.id}/ack`, {});
              if (r.ok) setSheet(r.data);
              else announce(r.message);
            }}
          >
            Got it
          </Button>
        </div>
      ) : !d.canAcknowledge ? (
        <p className="text-[14px] text-ink-muted">Only {holder && holder !== 'you' ? `${holder} or Owner/Admin` : 'Owner/Admin'} can mark this seen.</p>
      ) : null}
      {sheet ? (
        <Dialog title="Handoff seen" onClose={() => setSheet(null)}>
          <div className="flex flex-col gap-3 text-[15px]">
            {/* batch 13 merge (0081): an acknowledgement closes a no-deadline handoff (closedReason); only a deadline "still runs" */}
            <p>
              Seen at {localTime(sheet.acknowledgedAt)}.{sheet.closedReason ? ` ${closedReasonWords(sheet.closedReason)}` : SLA_HAS_DEADLINE[d.slaClass] ? ' The deadline still runs.' : ''}
            </p>
            {d.pendingMessage && (d.pendingMessage.status === 'scheduled' || d.pendingMessage.status === 'queued') ? (
              <p>
                An AI {d.pendingMessage.kind === 'confirmation' ? 'confirmation' : 'holding message'} is {pendingLine(d.pendingMessage)}. A text from anyone on the team, or any call with {first}, before then stops it.
              </p>
            ) : null}
            <Button variant="secondary" onClick={() => setSheet(null)}>
              Close
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">{title}</p>
      <div className="text-[15px] text-ink">{children}</div>
    </div>
  );
}

function NextStep({ step, contactId, name }: { step: string; contactId: string; name: string }) {
  const navigate = useNavigate();
  const { call } = useAgentSheets();
  const label = nextStepWords(step);
  switch (step) {
    case 'call_now':
      return (
        <Button variant="primary" icon="phone" onClick={() => call({ id: contactId, name })}>
          {label}
        </Button>
      );
    case 'answer_pricing_question':
    case 'reply_to_complaint':
    case 'review_fair_housing_question':
      return (
        <Button variant="secondary" icon="message" onClick={() => navigate(`/contacts/${contactId}/thread?compose=sms`)}>
          {label}
        </Button>
      );
    case 'review_consent':
      return (
        <Button variant="secondary" onClick={() => navigate(`/contacts/${contactId}`)}>
          {label}
        </Button>
      );
    case 'review_saved_search':
    case 'approve_saved_search':
      return (
        <Button variant="secondary" onClick={() => navigate(`/contacts/${contactId}?review=searches#searches`)}>
          {label}
        </Button>
      );
    case 'confirm_appointment':
      return (
        <Button variant="secondary" icon="calendar" onClick={() => navigate('/tasks')}>
          {label}
        </Button>
      );
    default:
      // batch 13 isa-4 F5: only a step known to be unbuilt says "not available yet"; an unknown one makes no claim
      return <span className="inline-flex min-h-tap items-center text-[15px] text-ink-muted">{UNBUILT_STEPS.has(step) ? `${cap(label)}: not available yet.` : label}</span>;
  }
}
