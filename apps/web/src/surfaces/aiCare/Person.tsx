// The person page's AI care (R-ISA-22, -1, -16, -29; E511, E516, E539; docs/AI_ISA.md §10.2):
// - AiCareStrip: under the channel actions, the state in one line with its controls; on a phone a sticky bar with
//   Pause and Take over while care is live.
// - AiCarePanelSection (contact/sections.ts, order 1): what it may do, what it needs, quiet hours, the next message,
//   limits, the last decision, what was shared, held topics, the handoff, the pond date and the authorization chain,
//   each in words for this reader. It renders nothing without an assignment, a Start or a block, and nothing for a TC
//   or on a 403/404 (R-PERM-5).
// - StartSheet: the owner's 2-tap start ("Start AI care" → a side), naming the opt-in it relies on (Q12).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Button, ButtonLink, Card, Dialog, Notice, announce, useStickyBottom } from '../../design/index.js';
import { useAgentSheets } from '../feed/lib/AgentSheets.js';
import type { ContactFullView, TimelineResponse } from '../feed/lib/types.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { type PanelHandoff, type PanelResponse, type Side, type StartResult, isaKeys, useHandoff, useIsaAction, useMe, usePanel } from './api.js';
import { AiCareControls, HoldBanner, Section, type ViewerInfo, cap, stateOfPanel, targetOfPanel, useHold, useViewer, UndoToastHost } from './Controls.js';
import { capsWords, localDate, localTime, PAUSE_EXPIRY_MS, scheduledWords, zonesWords } from './time.js';
import {
  EFFECT_WORDS,
  LINK_NAME,
  NOT_LIFTABLE,
  OTHER_CHECK,
  SIDE_WORDS,
  SLA_HAS_DEADLINE,
  TEAM_REFUSALS,
  blockWords,
  capabilityLine,
  chainLinkWords,
  closedReasonWords,
  confirmationWords,
  decisionCodeWords,
  NO_RECIPIENT_WORDS,
  endWords,
  escalationSentence,
  escalationTopic,
  firstOf,
  handoffHolder,
  handoffWhy,
  isaMessage,
  noDeadlineWords,
  pauseWords,
  statusWords,
} from './words.js';

type Contact = Pick<ContactFullView, 'id' | 'displayName' | 'intent' | 'owner'>;

/** The owner's display name, when the contact's owner is the assignment's owner (else unknown here). */
export function ownerNameOf(contact: Contact, ownerUserId: string | null | undefined): string | null {
  return contact.owner && (!ownerUserId || contact.owner.userId === ownerUserId) ? contact.owner.displayName : null;
}

function useContactPanel(contact: Contact) {
  const q = usePanel(contact.id);
  const p = q.data ?? null;
  const ownerUserId = p?.assignment?.ownerUserId ?? contact.owner?.userId ?? null;
  const viewer = useViewer(ownerUserId, ownerNameOf(contact, ownerUserId));
  return { q, p, viewer, ownerName: ownerNameOf(contact, ownerUserId) };
}

// ---- the header strip -----------------------------------------------------------------------------------------------

export function AiCareStrip({ contact }: { contact: Contact }) {
  const { p, viewer, ownerName } = useContactPanel(contact);
  const bar = useStickyBottom<HTMLDivElement>();
  const hold = useHold(p);
  if (!p || !p.assignment) return null;
  const a = p.assignment;
  const state = stateOfPanel(p)!;
  const target = targetOfPanel(p, contact.displayName, ownerName)!;
  const undo = a.undoUntil !== null && Date.parse(a.undoUntil) > Date.now();
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2" data-testid="ai-strip">
      {state === 'live' ? (
        <>
          <p className="text-[15px] font-semibold text-ink">AI assistant is handling this conversation</p>
          <p className="text-[14px] text-ink-muted">Calling or texting them yourself pauses AI care.</p>
          {/* b13 review F8-ui: the header says a hold too (the full banner is in the panel below) */}
          {hold.sentence ? <p className="text-[14px] font-medium text-warn" data-testid="ai-strip-hold">AI messages are held: nothing reaches {firstOf(contact.displayName, 'them')} from this deployment.</p> : null}
        </>
      ) : state === 'paused' ? (
        <p className="text-[15px] text-ink">
          <span className="font-semibold">Paused: nobody is following up automatically</span> · {pauseWords(a.pauseReason)}
        </p>
      ) : (
        <p className="text-[15px] text-ink">
          <span className="font-semibold">AI care ended:</span> {endWords(a.endReason)}{' '}
          {p.handoff ? <HandoffLink handoffId={p.handoff.id} viewer={viewer} ownerUserId={a.ownerUserId} currentOwner={contact.owner} tookOver={a.pauseReason === 'taking_over' || p.handoff.reason === 'taken_over'} /> : null}
        </p>
      )}
      {state !== 'ended' || undo ? <AiCareControls target={target} /> : null}
      <UndoToastHost ownerUserId={a.ownerUserId} ownerName={ownerName} />
      {state === 'live' && !undo ? (
        <>
          {/* b13 review F3-ui: stacked above the person page's Note · Log bar (its height, --person-bar-h; 0 when it is not
              mounted), never over it; its own page-end spacer, as that bar has one */}
          <div ref={bar} data-sticky className="fixed inset-x-0 z-40 border-t border-line bg-canvas/95 px-4 py-2 backdrop-blur md:hidden bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+var(--person-bar-h,0px))]" data-testid="ai-phone-bar">
            <AiCareControls target={target} layout="bar" label={`AI care for ${contact.displayName} (bar)`} />
          </div>
          {typeof document !== 'undefined' && document.querySelector('main') ? createPortal(<div aria-hidden="true" data-sticky-spacer className="h-16 md:hidden" />, document.querySelector('main')!) : null}
        </>
      ) : null}
    </div>
  );
}

/** Who has the handoff (batch 13 isa-4 F4): the reader, the owner, the lead's new owner or whoever took over (ISA-2b Q1). */
function HandoffLink({ handoffId, viewer, ownerUserId, currentOwner, tookOver }: { handoffId: string; viewer: ViewerInfo; ownerUserId: string; currentOwner: Contact['owner']; tookOver: boolean }) {
  const h = useHandoff(handoffId);
  if (!h.data) return null;
  const who = handoffHolder({ recipientUserId: h.data.recipientUserId, viewerUserId: viewer.userId, ownerUserId, ownerFirst: viewer.ownerFirst, currentOwner, tookOver: tookOver || h.data.reason === 'taken_over' });
  if (who === 'you')
    return (
      <Link to="/" className="font-medium text-accent underline">
        The handoff is in your feed.
      </Link>
    );
  return <span className="text-ink-muted">{who ? `${cap(who)} got the handoff.` : NO_RECIPIENT_WORDS}</span>;
}

// ---- the panel section ----------------------------------------------------------------------------------------------

export function AiCarePanelSection({ contact }: { contact: ContactFullView }) {
  const { p, viewer } = useContactPanel(contact);
  if (!p) return null;
  const showStart = p.canStart || (p.startRefusal !== null && p.assignment?.endedAt !== null);
  if (!p.assignment && !showStart && !p.block && !p.earlierHandoff) return null;
  return (
    <Card className="flex flex-col gap-3" aria-labelledby="ai-care-title">
      <h2 id="ai-care-title" className="text-[19px] font-semibold text-ink">
        AI care
      </h2>
      <PanelBody p={p} contact={contact} viewer={viewer} />
    </Card>
  );
}

function PanelBody({ p, contact, viewer }: { p: PanelResponse; contact: ContactFullView; viewer: ViewerInfo }) {
  const hold = useHold(p);
  const first = firstOf(contact.displayName, 'them');
  const a = p.assignment;
  const live = a !== null && a.endedAt === null;
  const now = Date.now();
  const who = (you: string, them: string) => (viewer.isOwner ? you : them);
  return (
    <div className="flex flex-col gap-3">
      {/* b13 review F8-ui: also after care ended while a post-handoff message is still pending: under the hold it never goes */}
      {live || pendingAfterHandoff(p) ? <HoldBanner hold={hold} first={first} viewer={viewer} /> : null}
      {a && a.pausedAt && !a.endedAt ? <PausedLines p={p} viewer={viewer} contact={contact} /> : null}
      {p.block ? <BlockLines block={p.block} viewer={viewer} contactId={contact.id} /> : null}
      {a && live ? (
        <>
          <Section title="What it may do">
            <ul className="flex flex-col gap-0.5">
              {p.capabilities.map((c) => (
                <li key={c.capability}>{capabilityLine(c, viewer)}</li>
              ))}
            </ul>
            {a.side !== 'buyer' ? <SellerFacts /> : null}
          </Section>
          <Section title="What it needs before it may text or email">
            <ul className="flex flex-col gap-0.5">
              {p.consent.map((c) => (
                <li key={c.channel}>{c.sentence.replace(/\bon file\b/gi, 'recorded')}</li>
              ))}
            </ul>
            <p className="text-[13px] text-ink-muted">Engineering defaults, VERIFY WITH COUNSEL.</p>
          </Section>
          <Section title="Quiet hours">{zonesWords(p.zones)}</Section>
          {p.nextAllowedSendAt && Date.parse(p.nextAllowedSendAt) > now ? <Section title="Next AI message">{scheduledWords(p.nextAllowedSendAt, p.zones, { hold: hold.sentence !== null })}</Section> : null}
          {p.capsSentence ? <Section title="Limits">{capsWords(p.capsSentence)}</Section> : null}
          {p.lastDecision ? (
            <Section title="Last decision">
              {statusWords(p.lastDecision.status)} <span className="text-ink-muted">({localTime(p.lastDecision.at)})</span>
              {p.lastDecision.codes.length > 0 ? (
                <ul className="list-disc pl-5">
                  {[...new Set(p.lastDecision.codes.map(decisionCodeWords))].map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </Section>
          ) : null}
          <Section title="Shared with them">
            {p.factsSent.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {p.factsSent.map((f, i) => (
                  <li key={`${f.factKind}:${i}`}>
                    {f.listingId ? (
                      <Link to={`/listings/${f.listingId}`} className="font-medium text-accent underline">
                        A listing
                      </Link>
                    ) : (
                      'A fact'
                    )}{' '}
                    · {localTime(f.sentAt)}
                    {f.source ? ` · from ${f.source}` : ''}
                    {f.asOf ? ` · as of ${localDate(f.asOf)}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              'Nothing yet.'
            )}
          </Section>
          <Section title="Times offered">
            {p.openOffer ? (
              <ul>
                {p.openOffer.slots.map((s) => (
                  // batch 13 isa-4 F14: both zones when theirs is explicit (R-ISA-29; brief item 6)
                  <li key={s.startsAt}>
                    {localTime(s.startsAt)}
                    {p.zones.source === 'explicit' && p.zones.zones.length === 1 ? ` (${localTime(s.startsAt, p.zones.zones[0]!)}, their time)` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              'None offered.'
            )}
          </Section>
          {p.heldTopics.length > 0 ? <HeldTopics p={p} viewer={viewer} contactId={contact.id} /> : null}
        </>
      ) : null}
      {a && a.endedAt ? <p className="text-[15px] text-ink">AI care ended: {endWords(a.endReason)}</p> : null}
      {p.handoff ? <HandoffLines h={p.handoff} viewer={viewer} first={first} held={hold.sentence !== null} /> : null}
      {/* batch 13 isa-4 (b12 recheck R16 follow-up): an earlier handoff a restart left open still has its deadline */}
      {p.earlierHandoff ? <HandoffLines h={p.earlierHandoff} viewer={viewer} first={first} held={hold.sentence !== null} title="An earlier handoff is still open" /> : null}
      {p.inactivityReleaseAt && live ? (
        <p className="text-[15px] text-ink">
          Returns to the pond on {localDate(p.inactivityReleaseAt)} unless {who('you reach them', `${viewer.ownerFirst} reaches them`)}. AI messages don't reset this.
        </p>
      ) : null}
      {a && live && p.chain.length > 0 ? (
        <details>
          <summary className="inline-flex min-h-tap cursor-pointer items-center text-[15px] font-medium text-accent">Authorization</summary>
          <ul className="flex flex-col gap-1 pt-1 text-[15px]">
            {p.chain.map((l) => (
              <li key={l.link}>
                <span className="font-medium">{LINK_NAME[l.link] ?? OTHER_CHECK}</span> · {EFFECT_WORDS[l.effect] ?? OTHER_CHECK}: {chainLinkWords(l, viewer)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {(!a || a.endedAt) && !p.block ? <StartArea p={p} contact={contact} viewer={viewer} /> : null}
    </div>
  );
}

/**
 * E534 (b13 review B13S-2): what reaches a seller, once. ISA-3 builds both: competing listings go out with their asking
 * prices before platform:cma (E534); recent sales wait for platform:cma, platform:ai_isa_seller_data and the licence's
 * ai_isa_comps. The capability lines above say what this owner's opt-in allows.
 */
export const SELLER_FACTS = 'Seller facts: competing listings go out with their asking prices only. Recent sales wait for counsel review of platform:cma and platform:ai_isa_seller_data, and for the MLS licence to allow the AI seller-data use.';
export function SellerFacts() {
  return <p className="pt-1 text-[14px] text-ink-muted">{SELLER_FACTS}</p>;
}

function PausedLines({ p, viewer, contact }: { p: PanelResponse; viewer: ViewerInfo; contact: ContactFullView }) {
  const a = p.assignment!;
  const reason = a.pauseReason;
  const expiry = a.pausedAt ? new Date(Date.parse(a.pausedAt) + PAUSE_EXPIRY_MS).toISOString() : null;
  return (
    <div className="flex flex-col gap-2">
      {reason === 'reinquiry' ? <ContinueCare contact={contact} viewer={viewer} /> : null}
      {(reason === 'policy_updated' || reason === 'approval_revoked') && viewer.isOwner ? (
        <p className="text-[15px]">
          The team changed the AI rules.{' '}
          <Link to="/settings/ai-assistant" className="font-medium text-accent underline">
            Re-attest in My AI assistant
          </Link>{' '}
          to continue.
        </p>
      ) : null}
      {expiry && !a.undoUntil ? <p className="text-[14px] text-ink-muted">If nobody resumes it, AI care ends around {localTime(expiry)} with a handoff.</p> : null}
    </div>
  );
}

function ContinueCare({ contact, viewer }: { contact: ContactFullView; viewer: ViewerInfo }) {
  const act = useIsaAction<Record<string, never>, StartResult>('POST', { kind: 'continue', contactId: contact.id });
  const [line, setLine] = useState<string | null>(null);
  const first = firstOf(contact.displayName, 'They');
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[15px]">{first} inquired again. AI care is paused so you can see the new inquiry.</p>
      {viewer.isOwner ? (
        <div>
          <Button
            variant="secondary"
            pending={act.pending}
            onClick={async () => {
              const r = await act.run(`/contacts/${contact.id}/ai-isa/continue`, {});
              const t = r.ok ? r.data.sentence : r.message;
              setLine(t);
              announce(t);
            }}
          >
            Continue AI care
          </Button>
        </div>
      ) : null}
      {line ? <p className="text-[14px]">{line}</p> : null}
    </div>
  );
}

function BlockLines({ block, viewer, contactId }: { block: NonNullable<PanelResponse['block']>; viewer: ViewerInfo; contactId: string }) {
  const [open, setOpen] = useState(false);
  const liftable = !NOT_LIFTABLE.has(block.reason) && viewer.isOwner;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[15px] text-ink" data-testid="ai-block">
        {blockWords(block.reason)}
      </p>
      {liftable ? (
        <div>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Lift the block
          </Button>
          {open ? <LiftSheet contactId={contactId} since={block.since} onClose={() => setOpen(false)} /> : null}
        </div>
      ) : null}
    </div>
  );
}

const LIFT_EXAMPLE = 'Example: They texted on Nov 12 asking us to keep sending listings, so I am lifting the block.';

/** The owner lifts a liftable block: one of their messages since the block, and a confirmation the owner types (≥ 20 characters). */
function LiftSheet({ contactId, since, onClose }: { contactId: string; since: string; onClose(): void }) {
  const api = useApi();
  // the thread's own timeline query (same key and request as thread/ThreadPage.tsx useTimeline)
  const t = useQuery<TimelineResponse, ApiError>({ queryKey: ['timeline', contactId], queryFn: ({ signal }) => api.get<TimelineResponse>(`/contacts/${contactId}/timeline?limit=100`, { signal }) });
  const act = useIsaAction<{ inboundMessageId: string; attestation: string }, { lifted: boolean }>('POST', { kind: 'lift', contactId });
  const [pick, setPick] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const inbound = (t.data?.items ?? []).filter((i) => i.type === 'message' && (i.detail ?? '').endsWith(':inbound') && Date.parse(i.occurredAt) > Date.parse(since));
  const ok = pick !== null && text.trim().length >= 20;
  return (
    <Dialog title="Lift the block" onClose={onClose}>
      <div className="flex flex-col gap-3 text-[15px]">
        {done ? (
          <p role="status">{done}</p>
        ) : t.isPending ? (
          <p className="text-ink-muted">Loading</p>
        ) : inbound.length === 0 ? (
          <p>A restart needs a new message from them first. None has arrived since the block.</p>
        ) : (
          <>
            <fieldset className="flex flex-col gap-1">
              <legend className="font-semibold">Their message since the block</legend>
              {inbound.map((i) => (
                <label key={i.id} className="flex min-h-tap items-start gap-2">
                  <input type="radio" name="lift-inbound" className="mt-1 h-5 w-5" checked={pick === i.id} onChange={() => setPick(i.id)} />
                  <span>
                    “{i.preview ?? ''}” <span className="text-ink-muted">· {localTime(i.occurredAt)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1 font-semibold" htmlFor="lift-attestation">
              Why you are lifting it, in your words
              <textarea id="lift-attestation" aria-describedby="lift-example" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} className="rounded-xl border border-line bg-surface px-3 py-2 font-normal" />
            </label>
            <p id="lift-example" className="text-[14px] text-ink-muted">
              {LIFT_EXAMPLE} At least 20 characters.
            </p>
            <Button
              variant="primary"
              disabled={!ok}
              pending={act.pending}
              onClick={async () => {
                const r = await act.run(`/contacts/${contactId}/ai-isa/lift-block`, { inboundMessageId: pick!, attestation: text.trim() });
                const msg = r.ok ? 'Lifted. You can start AI care again.' : r.message;
                setDone(msg);
                announce(msg);
              }}
            >
              Lift the block
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}

function HeldTopics({ p, viewer, contactId }: { p: PanelResponse; viewer: ViewerInfo; contactId: string }) {
  const act = useIsaAction<{ class: string }, { cleared: string }>('POST', { kind: 'resolve', contactId });
  const [line, setLine] = useState<string | null>(null);
  return (
    <Section title={`Waiting on ${viewer.isOwner ? 'you' : viewer.ownerFirst}`}>
      <ul className="flex flex-col gap-2">
        {p.heldTopics.map((t) => (
          <li key={t.class} className="flex flex-col gap-1">
            <span>
              {escalationSentence(t.class)} <span className="text-ink-muted">Since {localTime(t.since)}.</span>
            </span>
            <span>
              <Button
                variant="secondary"
                pending={act.pending}
                onClick={async () => {
                  const r = await act.run(`/ai-isa/escalations/${p.assignment!.id}/resolve`, { class: t.class });
                  const s = r.ok ? `Marked handled: ${escalationTopic(t.class)}. The AI assistant may continue the conversation.` : r.message;
                  setLine(s);
                  announce(s);
                }}
              >
                I've handled it; the AI may continue
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {line ? <p className="text-[14px]">{line}</p> : null}
    </Section>
  );
}

/** b13 review F8-ui: a handoff whose post-handoff message (confirmation or holding line) is still to go out. */
const pendingAfterHandoff = (p: PanelResponse) => [p.handoff, p.earlierHandoff].some((h) => h !== null && (h.confirmationStatus === 'scheduled' || h.confirmationStatus === 'queued'));
/** Under a hold a pending confirmation never goes out (dispatch refuses it): it is said as what would happen. */
export const HELD_CONFIRMATION = 'A confirmation would go out if sending were allowed. AI messages are held, so confirm it yourself.';

function HandoffLines({ h, viewer, first, title = 'Handoff', held = false }: { h: PanelHandoff; viewer: ViewerInfo; first: string; title?: string; held?: boolean }) {
  return (
    <Section title={title}>
      <p>{handoffWhy(h.reason)}</p>
      {h.slaMetAt ? (
        <p>
          Done: {first} was reached at {localTime(h.slaMetAt)}.
        </p>
      ) : h.closedReason ? (
        <p>{closedReasonWords(h.closedReason)}</p>
      ) : !SLA_HAS_DEADLINE[h.slaClass] ? (
        <p>{noDeadlineWords(first)}</p>
      ) : (
        <p>
          Respond by {localTime(h.slaDueAt)}
          {h.overdue ? ' · Overdue' : ''}. A call, text or email to {first} from {viewer.isOwner ? 'you' : viewer.ownerFirst} or a collaborator meets it.
        </p>
      )}
      <p className="text-ink-muted">{held && (h.confirmationStatus === 'scheduled' || h.confirmationStatus === 'queued') ? HELD_CONFIRMATION : confirmationWords(h.confirmationStatus, h.confirmationNotSent)}</p>
    </Section>
  );
}

// ---- start ----------------------------------------------------------------------------------------------------------

function StartArea({ p, contact, viewer }: { p: PanelResponse; contact: ContactFullView; viewer: ViewerInfo }) {
  const [open, setOpen] = useState(false);
  if (p.canStart && viewer.isOwner)
    return (
      <div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Start AI care
        </Button>
        {open ? <StartSheet contact={contact} onClose={() => setOpen(false)} /> : null}
      </div>
    );
  if (p.startRefusal) return <Refusal refusal={p.startRefusal} viewer={viewer} contact={contact} block={p.block} />;
  return null;
}

export function Refusal({ refusal, viewer, contact, block }: { refusal: { code: string; sentence: string }; viewer: ViewerInfo; contact: Pick<ContactFullView, 'id' | 'displayName'>; block?: PanelResponse['block'] }) {
  const { call } = useAgentSheets();
  const navigate = useNavigate();
  const admin = viewer.role === 'owner' || viewer.role === 'admin';
  if (TEAM_REFUSALS.has(refusal.code))
    return (
      <p className="text-[15px] text-ink" data-testid="ai-refusal">
        {isaMessage(refusal.code)}{' '}
        {admin ? (
          <Link to="/settings/ai-assistant/team" className="font-medium text-accent underline">
            Open AI assistant (ISA) settings
          </Link>
        ) : null}
      </p>
    );
  if (!viewer.isOwner)
    return (
      <p className="text-[15px] text-ink" data-testid="ai-refusal">
        Only {viewer.ownerFirst} can start AI care for this lead.
      </p>
    );
  let fix: ReactNode = null;
  if (refusal.code === 'AI_ISA_NO_OPTIN')
    fix = (
      <ButtonLink to="/settings/ai-assistant" variant="secondary">
        Open My AI assistant
      </ButtonLink>
    );
  if (refusal.code === 'AI_ISA_FIRST_TOUCH_PENDING')
    fix = (
      <span className="flex flex-wrap gap-2">
        <Button variant="secondary" icon="phone" onClick={() => call({ id: contact.id, name: contact.displayName })}>
          Call
        </Button>
        <Button variant="secondary" icon="message" onClick={() => navigate(`/contacts/${contact.id}/thread?compose=sms`)}>
          Text
        </Button>
      </span>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="ai-refusal">
      <p className="text-[15px] text-ink">{refusal.code === 'AI_ISA_PERSON_DECLINED' && block ? blockWords(block.reason) : isaMessage(refusal.code)}</p>
      {fix}
    </div>
  );
}

export function StartSheet({ contact, onClose, fromHandbackId }: { contact: Pick<ContactFullView, 'id' | 'displayName' | 'intent' | 'owner'>; onClose(): void; fromHandbackId?: string }) {
  const qc = useQueryClient();
  const me = useMe();
  const panel = usePanel(contact.id);
  const viewer = useViewer(contact.owner?.userId, contact.owner?.displayName);
  const hold = useHold(panel.data);
  const act = useIsaAction<{ side: Side; fromHandbackId?: string }, StartResult>('POST', { kind: 'start', contactId: contact.id });
  const [done, setDone] = useState<string | null>(null);
  const first = firstOf(contact.displayName, 'They');
  const sides: Side[] = contact.intent === 'seller' ? ['seller', 'buyer', 'both'] : ['buyer', 'seller', 'both'];
  const start = async (side: Side) => {
    const r = await act.run(`/contacts/${contact.id}/ai-isa/start`, fromHandbackId ? { side, fromHandbackId } : { side });
    if (!r.ok) {
      if (r.code === 'AI_ISA_ALREADY_ACTIVE') void qc.invalidateQueries({ queryKey: isaKeys.panel(contact.id) });
      setDone(r.message);
      return;
    }
    const t = [r.data.sentence, r.data.supersededProposals > 0 ? `Withdrew ${r.data.supersededProposals} drafts and handbacks.` : null].filter(Boolean).join(' ');
    setDone(t);
    announce(t);
  };
  const p = panel.data;
  const canStart = p?.canStart === true;
  return (
    <Dialog title="Start AI care" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {done ? (
          <>
            <p className="text-[15px]" role="status" data-testid="start-result">
              {done}
            </p>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </>
        ) : !p ? (
          <p className="text-[15px] text-ink-muted">Loading</p>
        ) : !canStart ? (
          p.startRefusal ? <Refusal refusal={p.startRefusal} viewer={viewer} contact={contact} block={p.block} /> : <p className="text-[15px]">AI care can't start right now.</p>
        ) : (
          <>
            <p className="text-[15px]">
              {first} gets texts and emails from your AI assistant under your opt-in of {me.data?.optIn ? localDate(me.data.optIn.createdAt) : 'your current opt-in'}. You stay responsible for this lead.
            </p>
            <HoldBanner hold={hold} first={first} viewer={viewer} />
            <div className="flex flex-col gap-2">
              {sides.map((s, i) => (
                <Button key={s} variant={i === 0 ? 'primary' : 'secondary'} pending={act.pending} block onClick={() => void start(s)}>
                  {s === 'both' ? 'Start as both' : `Start as a ${s}`}
                </Button>
              ))}
            </div>
            <p className="text-[14px] text-ink-muted">With sellers it may share competing listings (their asking prices) when your opt-in allows it. Recent sales wait for counsel review of platform:cma and platform:ai_isa_seller_data.</p>
            {act.error ? <Notice tone="error">{act.error.message}</Notice> : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

export const sideWords = (s: string) => SIDE_WORDS[s] ?? OTHER_CHECK;
