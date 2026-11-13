// The thread's AI care (R-ISA-7, -29; E511, E533; docs/AI_ISA.md §10.2, §10.6):
// - AiThreadBanner above the messages: the state, the controls and the hold banner; it hosts the Undo toast; and it
//   says when an AI confirmation or holding message is still scheduled after a handoff, and what stops it
//   (the send check of 0080, as replaced by 0081 and 0083: a text from anyone on the team, or any call, since the handoff).
// - AI labels come from the turns route's message ids (V12: the timeline has no initiator). The verb follows the
//   message's own status ("Sent by", "Scheduled by … for", "Queued by", "Written by" when it did not go), then
//   "{Owner first}'s AI assistant" — the owner's name only for turns of the latest assignment whose owner is the
//   contact's owner, else "the AI assistant". Never a person's name alone, no avatar. A message outside the 100 turns
//   keeps "Sent automatically", which is true. Client-facing wording is pack data, out of scope (C-ISA-5).
import { type ReactNode, createContext, useContext, useId, useMemo, useState } from 'react';
import type { ContactFullView, TimelineItem } from '../feed/lib/types.js';
import { type PanelResponse, type TurnRow, useHandoff, usePanel, useTurns } from './api.js';
import { AiCareControls, HoldBanner, UndoToastHost, stateOfPanel, targetOfPanel, useHold, useViewer } from './Controls.js';
import { ownerNameOf } from './Person.js';
import { localTime } from './time.js';
import { confirmationWords, decisionCodeWords, endWords, escalationTopic, firstOf, messageVerb, pauseWords, statusWords, triggerWords } from './words.js';

// ---- labels ---------------------------------------------------------------------------------------------------------

interface LabelCtx {
  turns: Map<string, TurnRow>;
  /** the assistant's owner phrase for turns of the latest assignment ("Ava's AI assistant") */
  ownerPhrase: string | null;
  since: number | null;
}

const Ctx = createContext<LabelCtx | null>(null);

export function AiLabelsProvider({ contact, children }: { contact: Pick<ContactFullView, 'id' | 'owner'>; children: ReactNode }) {
  const turns = useTurns(contact.id);
  const panel = usePanel(contact.id);
  const value = useMemo<LabelCtx>(() => {
    const m = new Map<string, TurnRow>();
    for (const t of turns.data?.turns ?? []) if (t.messageId) m.set(t.messageId, t);
    const a = panel.data?.assignment ?? null;
    const named = a !== null && contact.owner !== null && contact.owner.userId === a.ownerUserId && !!contact.owner.displayName;
    return { turns: m, ownerPhrase: named ? `${firstOf(contact.owner!.displayName)}'s AI assistant` : null, since: a ? Date.parse(a.startedAt) : null };
  }, [turns.data, panel.data, contact.owner]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export interface AiLabel {
  label: string;
  why: ReactNode;
}

/** The pure part: the label of one AI message. */
export function aiLabelText(t: TurnRow, status: string | null | undefined, ctx: Pick<LabelCtx, 'ownerPhrase' | 'since'>): string {
  const mine = ctx.ownerPhrase !== null && ctx.since !== null && Date.parse(t.createdAt) >= ctx.since;
  const who = mine ? ctx.ownerPhrase! : 'the AI assistant';
  switch (messageVerb(status)) {
    case 'sent':
      return `Sent by ${who}`;
    case 'scheduled':
      return t.notBefore ? `Scheduled by ${who} for ${localTime(t.notBefore)}` : `Scheduled by ${who}`;
    case 'queued':
      return `Queued by ${who}`;
    default:
      return `Written by ${who}`;
  }
}

export function whyWords(t: TurnRow): string[] {
  const out = [triggerWords(t.triggerKind)];
  const esc = Array.isArray(t.decision.escalations) ? (t.decision.escalations as unknown[]).map(String) : [];
  if (esc.length > 0) out.push(`Holding line: ${escalationTopic(esc[0]!)}`);
  out.push(statusWords(t.status));
  for (const w of new Set(t.denied.map(decisionCodeWords))) out.push(w);
  return out;
}

/** For MessageRow: the AI label of an outbound message the turns route covers, else null. */
export function useAiLabel(item: Pick<TimelineItem, 'id' | 'status'>): AiLabel | null {
  const ctx = useContext(Ctx);
  const t = ctx?.turns.get(item.id) ?? null;
  if (!ctx || !t) return null;
  return { label: aiLabelText(t, item.status, ctx), why: <WhyButton turn={t} /> };
}

function WhyButton({ turn }: { turn: TurnRow }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="flex flex-col items-end px-1">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="inline-flex min-h-tap items-center text-[13px] font-medium text-accent">
        Why
      </button>
      {open ? (
        <span id={id} className="text-right text-[13px] text-ink-muted">
          {whyWords(turn).join(' · ')}
        </span>
      ) : null}
    </span>
  );
}

// ---- the banner -----------------------------------------------------------------------------------------------------

export function AiThreadBanner({ contact }: { contact: ContactFullView }) {
  const panel = usePanel(contact.id);
  const p = panel.data ?? null;
  const ownerUserId = p?.assignment?.ownerUserId ?? contact.owner?.userId ?? null;
  const ownerName = ownerNameOf(contact, ownerUserId);
  const viewer = useViewer(ownerUserId, ownerName);
  const hold = useHold(p);
  if (!p || !p.assignment) return <UndoToastHost ownerUserId={ownerUserId ?? undefined} ownerName={ownerName} />;
  const state = stateOfPanel(p)!;
  const a = p.assignment;
  const first = firstOf(contact.displayName, 'them');
  const target = targetOfPanel(p, contact.displayName, ownerName)!;
  const undo = a.undoUntil !== null && Date.parse(a.undoUntil) > Date.now();
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2" data-testid="ai-thread-banner">
      <p className="text-[15px] text-ink">
        {state === 'live' ? (
          <span className="font-semibold">AI assistant is handling this conversation</span>
        ) : state === 'paused' ? (
          <>
            <span className="font-semibold">Paused: nobody is following up automatically</span> · {pauseWords(a.pauseReason)}
          </>
        ) : (
          <>
            <span className="font-semibold">AI care ended:</span> {endWords(a.endReason)}
          </>
        )}
      </p>
      {state !== 'ended' ? <HoldBanner hold={hold} first={first} viewer={viewer} /> : null}
      {state !== 'ended' || undo ? <AiCareControls target={target} inThread /> : null}
      {p.handoff ? <PendingAfterHandoff panel={p} first={first} /> : null}
      <UndoToastHost ownerUserId={a.ownerUserId} ownerName={ownerName} />
    </div>
  );
}

function PendingAfterHandoff({ panel, first }: { panel: PanelResponse; first: string }) {
  const h = useHandoff(panel.handoff?.id);
  const m = h.data?.pendingMessage;
  if (!m) return null;
  const what = m.kind === 'confirmation' ? 'confirmation' : 'holding message';
  if ((m.status === 'scheduled' || m.status === 'queued') && m.scheduledFor && Date.parse(m.scheduledFor) > Date.now())
    return (
      <p className="text-[14px] text-ink" data-testid="ai-pending-after-handoff">
        An AI {what} is scheduled for {localTime(m.scheduledFor)}. A text from anyone on the team, or any call with {first}, before then stops it.
      </p>
    );
  // b13 review B13S-3: why a confirmation did not go out is the API's (keep or cancel when D1 leaves no channel)
  if (m.status === 'canceled' || m.status === 'blocked' || m.status === 'failed')
    return <p className="text-[14px] text-ink">{m.kind === 'confirmation' ? confirmationWords('refused', h.data?.confirmationNotSent ?? null) : 'The AI holding message was not sent.'}</p>;
  return null;
}
