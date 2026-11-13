// AiCareControls, the hold banner and the one Undo toast (R-ISA-15, E496, E513; docs/AI_ISA.md §3.7, §10).
// - Pause and Take over: 1 tap. End: 2 (it sits behind "More"). Resume: 1 tap, the owner only, when allowed.
// - While the Undo window is open, viewers with control see Undo in place of Take over and End (anyone's window:
//   panel.undoUntil), and nobody sees Resume.
// - The toast says what Undo does ("keeps it paused"), takes focus, is reachable by Tab, closes on Escape without
//   undoing, and speaks through the one Announcer at the start and at 5 s. Its countdown is text, never animated.
// - Every result is said in words: the API's sentence, plus who is told and what may still reach the person.
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Notice, announce } from '../../design/index.js';
import { useApi, useSession } from '../../shell/index.js';
import type { TimelineResponse } from '../feed/lib/types.js';
import { type ControlResult, type HandoffView, type ListRow, type PanelResponse, isaKeys, useIsaAction, useIsaLive } from './api.js';
import { controlsFor } from './controls.js';
import { localSeconds, localTime } from './time.js';
import { closeUndo, getUndo, openUndo, registerHost, useIsFirstHost, useUndo, windowFromPanel, windowFromResponse } from './undoStore.js';
import { CHAIN_CODE_WORDS, NO_RECIPIENT_WORDS, type Viewer, endWords, firstOf, handoffHolder, pauseWords } from './words.js';

// ---- the viewer -----------------------------------------------------------------------------------------------------

export interface ViewerInfo extends Viewer {
  userId: string | null;
  role: ReturnType<typeof useRole>;
}

function useRole() {
  return useSession().session?.tenant?.role ?? null;
}

/** Who reads this: the owner ("you") or someone else ("{Owner first}"). */
export function useViewer(ownerUserId: string | null | undefined, ownerName: string | null | undefined): ViewerInfo {
  const { session } = useSession();
  const role = useRole();
  const userId = session?.user.id ?? null;
  return { userId, role, isOwner: !!userId && userId === ownerUserId, ownerFirst: firstOf(ownerName, 'the owner') };
}

export const cap = (s: string) => (s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s);

// ---- hold (V3: the shared query's holdSentence wins; a panel link hold adds the replies clause) ----------------------

export interface HoldState {
  sentence: string | null;
  /** a panel chain link says hold (ingest.ts:80: replies take the R-AST-9 path) */
  linkHold: boolean;
}

export function useHold(panel?: PanelResponse | null): HoldState {
  const live = useIsaLive();
  const link = panel?.chain.find((l) => l.effect === 'hold') ?? null;
  const fromLink = link ? (link.code && CHAIN_CODE_WORDS[link.code]) || link.sentence : null;
  return { sentence: live.data?.holdSentence ?? fromLink ?? null, linkHold: link !== null };
}

/** "{sentence} Nothing reaches {first} from this deployment." (+ "Their replies come to you as usual." on a link hold) */
export function holdText(h: HoldState, o: { first?: string; viewer?: Viewer; replies?: boolean }): string | null {
  if (!h.sentence) return null;
  const who = o.first ?? 'the people under AI care';
  const replies = o.replies !== false && h.linkHold ? (o.viewer && !o.viewer.isOwner ? ` Their replies go to ${o.viewer.ownerFirst} as usual.` : ' Their replies come to you as usual.') : '';
  return `${h.sentence} Nothing reaches ${who} from this deployment.${replies}`;
}

export function HoldBanner({ hold, first, viewer, replies }: { hold: HoldState; first?: string; viewer?: Viewer; replies?: boolean }) {
  const text = holdText(hold, { first, viewer, replies });
  if (!text) return null;
  return (
    <div data-testid="ai-hold">
      <Notice tone="warn" title="AI messages are held">
        {text}
      </Notice>
    </div>
  );
}

// ---- controls -------------------------------------------------------------------------------------------------------

export interface ControlTarget {
  contactId: string;
  contactName: string;
  ownerUserId: string;
  ownerName: string | null;
  state: 'live' | 'paused' | 'ended';
  undoUntil: string | null;
  /** panel.canResume; null on a list row (the row's owner decides) */
  canResume: boolean | null;
  pauseReason?: string | null;
}

export function stateOfPanel(p: PanelResponse): 'live' | 'paused' | 'ended' | null {
  const a = p.assignment;
  if (!a) return null;
  return a.endedAt ? 'ended' : a.pausedAt ? 'paused' : 'live';
}

export function targetOfPanel(p: PanelResponse, contactName: string, ownerName: string | null): ControlTarget | null {
  const s = stateOfPanel(p);
  if (!s || !p.assignment) return null;
  return { contactId: p.contactId, contactName, ownerUserId: p.assignment.ownerUserId, ownerName, state: s, undoUntil: p.assignment.undoUntil, canResume: p.canResume, pauseReason: p.assignment.pauseReason };
}

export function targetOfRow(r: ListRow): ControlTarget {
  const state = r.chip.kind === 'ended' ? 'ended' : r.chip.kind === 'paused' ? 'paused' : 'live';
  return { contactId: r.contactId, contactName: r.name, ownerUserId: r.ownerUserId, ownerName: r.ownerName, state, undoUntil: null, canResume: null };
}

function lastInboundChannel(qc: QueryClient, contactId: string): 'sms' | 'email' {
  const t = qc.getQueryData<TimelineResponse>(['timeline', contactId]);
  for (const i of t?.items ?? []) {
    const [channel, direction] = (i.detail ?? '').split(':');
    if (i.type === 'message' && direction === 'inbound') return channel === 'email' ? 'email' : 'sms';
  }
  return 'sms';
}

/** Re-reads the panel after a refusal and says the fresh state ("AI care already ended: …"). */
async function freshState(qc: QueryClient, api: ReturnType<typeof useApi>, contactId: string): Promise<PanelResponse | null> {
  try {
    const p = await api.get<PanelResponse>(`/contacts/${contactId}/ai-isa`);
    qc.setQueryData(isaKeys.panel(contactId), p);
    return p;
  } catch {
    return null;
  }
}

function freshSentence(p: PanelResponse | null): string {
  const a = p?.assignment;
  if (!a) return 'AI care is not on for this person.';
  if (a.endedAt) return `AI care already ended: ${endWords(a.endReason)}`;
  if (a.pausedAt) return `AI care is paused: ${pauseWords(a.pauseReason)}`;
  return 'AI care is on.';
}

export function AiCareControls({ target, inThread = false, layout = 'row', label }: { target: ControlTarget; inThread?: boolean; layout?: 'row' | 'bar'; label?: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const viewer = useViewer(target.ownerUserId, target.ownerName);
  const toast = useUndo();
  const [now, setNow] = useState(() => Date.now());
  const undoFromPanel = target.undoUntil !== null && Date.parse(target.undoUntil) > now;
  const undoOpen = (toast !== null && toast.contactId === target.contactId) || undoFromPanel;
  useEffect(() => {
    if (!target.undoUntil) return;
    const left = Date.parse(target.undoUntil) - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), left + 50);
    return () => clearTimeout(t);
  }, [target.undoUntil]);
  // a reload inside someone's window restores the toast for viewers with control (E496)
  const c = controlsFor({ role: viewer.role, viewerUserId: viewer.userId, ownerUserId: target.ownerUserId, state: target.state, undoOpen, canResume: target.canResume });
  useEffect(() => {
    if (undoFromPanel && c.undo && getUndo() === null)
      openUndo({ contactId: target.contactId, kind: 'end', closesAt: windowFromPanel(target.undoUntil!, Date.now()), returnFocus: null, fresh: false, composeAfter: false, ownerUserId: target.ownerUserId, ownerName: target.ownerName });
  }, [undoFromPanel, c.undo, target.contactId, target.undoUntil, target.ownerUserId, target.ownerName]);
  const [more, setMore] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const moreId = useId();
  const id = target.contactId;
  const pause = useIsaAction<{ reason?: 'user' }, ControlResult>('POST', { kind: 'pause', contactId: id });
  const take = useIsaAction<Record<string, never>, ControlResult>('POST', { kind: 'take_over', contactId: id });
  const end = useIsaAction<Record<string, never>, ControlResult>('POST', { kind: 'end', contactId: id });
  const resume = useIsaAction<Record<string, never>, ControlResult>('POST', { kind: 'resume', contactId: id });
  const say = (t: string) => {
    setLine(t);
    announce(t);
  };
  const refused = async (code: string, message: string) => {
    if (code === 'AI_ISA_NOT_LIVE' || code === 'AI_ISA_NOT_PAUSED') return say(freshSentence(await freshState(qc, api, id)));
    say(message);
  };
  const inFlightLines = (r: ControlResult) => r.inFlight.map((m) => `1 message was already on its way at ${localSeconds(m.at)}. It may still reach ${firstOf(target.contactName, 'them')}.`);

  const doPause = async () => {
    const r = await pause.run(`/contacts/${id}/ai-isa/pause`, {});
    if (!r.ok) return refused(r.code, r.message);
    say([r.data.sentence, viewer.isOwner ? null : `${cap(viewer.ownerFirst)} is told and can resume it.`, ...inFlightLines(r.data)].filter(Boolean).join(' '));
  };
  const doFinal = async (kind: 'take_over' | 'end', el: HTMLElement | null) => {
    const a = kind === 'take_over' ? take : end;
    const sentAt = Date.now();
    const r = await a.run(`/contacts/${id}/ai-isa/${kind === 'take_over' ? 'take-over' : 'end'}`, {});
    const receivedAt = Date.now();
    if (!r.ok) return refused(r.code, r.message);
    const composeAfter = kind === 'take_over' && !inThread;
    openUndo({ contactId: id, kind, closesAt: windowFromResponse(sentAt, receivedAt, r.data.undoUntil), returnFocus: composeAfter ? null : el, fresh: true, composeAfter: kind === 'take_over', ownerUserId: target.ownerUserId, ownerName: target.ownerName });
    const lines = inFlightLines(r.data);
    if (lines.length > 0) setLine(lines.join(' '));
    if (composeAfter) navigate(`/contacts/${id}/thread?compose=${lastInboundChannel(qc, id)}`, { state: { aiTakeOver: r.data, receivedAt } });
  };
  const doResume = async () => {
    const r = await resume.run(`/contacts/${id}/ai-isa/resume`, {});
    if (!r.ok) return refused(r.code, r.message);
    say(r.data.sentence === 'AI care resumed.' ? 'AI care resumed.' : r.data.sentence);
  };

  const any = c.pause || c.takeOver || c.end || c.resume || c.undo;
  const resumeNote = target.state === 'paused' && !viewer.isOwner && !undoOpen ? `${cap(viewer.ownerFirst)} can resume.` : null;
  if (!any && !resumeNote && !line) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="ai-controls">
      <div role="group" aria-label={label ?? `AI care for ${target.contactName}`} className={`flex flex-wrap items-center gap-2 ${layout === 'bar' ? 'justify-stretch [&>*]:flex-1' : ''}`}>
        {c.pause ? (
          <Button variant="secondary" pending={pause.pending} onClick={() => void doPause()}>
            Pause
          </Button>
        ) : null}
        {c.resume ? (
          <Button variant="primary" pending={resume.pending} onClick={() => void doResume()}>
            Resume AI care
          </Button>
        ) : null}
        {c.takeOver ? (
          <Button variant="secondary" pending={take.pending} onClick={(e) => void doFinal('take_over', e.currentTarget)}>
            Take over
          </Button>
        ) : null}
        {c.undo && !(toast && toast.contactId === id) ? <UndoButton contactId={id} viewer={viewer} /> : null}
        {c.end && layout === 'row' ? (
          <Button variant="quiet" aria-expanded={more} aria-controls={moreId} onClick={() => setMore((m) => !m)}>
            More
          </Button>
        ) : null}
      </div>
      {more && c.end && layout === 'row' ? (
        <div id={moreId}>
          <Button variant="danger" pending={end.pending} onClick={(e) => void doFinal('end', e.currentTarget)}>
            End AI care
          </Button>
        </div>
      ) : null}
      {resumeNote ? <p className="text-[14px] text-ink-muted">{resumeNote}</p> : null}
      {line ? <p className="text-[14px] text-ink" data-testid="ai-control-line">{line}</p> : null}
    </div>
  );
}

// ---- Undo -----------------------------------------------------------------------------------------------------------

function useUndoAction(contactId: string, viewer: Viewer) {
  const api = useApi();
  const qc = useQueryClient();
  const undo = useIsaAction<Record<string, never>, ControlResult>('POST', { kind: 'undo', contactId });
  const run = async (): Promise<string> => {
    const r = await undo.run(`/contacts/${contactId}/ai-isa/undo`, {});
    if (r.ok) return `Undone. AI care stays paused until ${viewer.isOwner ? 'you' : viewer.ownerFirst} resume${viewer.isOwner ? '' : 's'} it.`;
    if (r.code === 'AI_ISA_UNDO_EXPIRED') {
      const p = await freshState(qc, api, contactId);
      const a = p?.assignment;
      if (a && !a.endedAt && a.undoUntil === null) return 'Someone already undid this. AI care stays paused.';
      return 'Too late to undo: AI care ended.';
    }
    return r.message;
  };
  return { run, pending: undo.pending };
}

function UndoButton({ contactId, viewer }: { contactId: string; viewer: Viewer }) {
  const u = useUndoAction(contactId, viewer);
  return (
    <Button
      variant="primary"
      pending={u.pending}
      onClick={async () => {
        const t = await u.run();
        closeUndo();
        announce(t);
      }}
    >
      Undo
    </Button>
  );
}

/**
 * The toast. Mount it wherever controls can open one (the thread banner, the person page strip, the list, feed cards):
 * the first mounted host renders it, the rest stay empty.
 */
export function UndoToastHost({ ownerUserId, ownerName }: { ownerUserId?: string; ownerName?: string | null }) {
  const me = useMemo(() => Symbol('undo-host'), []);
  useEffect(() => registerHost(me), [me]);
  const first = useIsFirstHost(me);
  const t = useUndo();
  const [after, setAfter] = useState<{ contactId: string; until: number; text: string; ownerUserId?: string; ownerName?: string | null } | null>(null);
  if (!first) return null;
  // batch 13 isa-4 F14: the toast's own owner (stored with it) wins over the host's, so a host with none (the list) still
  // says "until you resume it" to the owner
  return (
    <>
      {t ? (
        <ToastView
          key={`${t.contactId}:${t.closesAt}`}
          ownerUserId={t.ownerUserId ?? ownerUserId}
          ownerName={t.ownerUserId ? (t.ownerName ?? null) : ownerName}
          onExpired={(cid) => setAfter({ contactId: cid, until: Date.now() + 10_000, text: 'Finishing…', ownerUserId: t.ownerUserId, ownerName: t.ownerName })}
        />
      ) : null}
      {after && !t ? <AfterWindow state={after} ownerUserId={after.ownerUserId ?? ownerUserId} ownerName={after.ownerUserId ? (after.ownerName ?? null) : ownerName} onDone={() => setAfter(null)} /> : null}
    </>
  );
}

const TOAST_POS = 'fixed inset-x-0 z-50 flex justify-center px-4 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+var(--sticky-bottom-h,0px)+12px)] md:bottom-[calc(var(--sticky-bottom-h,0px)+24px)]';

function ToastView({ ownerUserId, ownerName, onExpired }: { ownerUserId?: string; ownerName?: string | null; onExpired(contactId: string): void }) {
  const t = getUndo()!;
  const viewer = useViewer(ownerUserId, ownerName);
  const u = useUndoAction(t.contactId, viewer);
  const btn = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((t.closesAt - now) / 1000));
  const said5 = useRef(false);
  // batch 13 isa-4 F14: a toast restored after a reload says the seconds it had left when it opened, never "10"
  const [opened] = useState(() => Math.max(1, Math.ceil((t.closesAt - Date.now()) / 1000)));
  const secs = t.fresh ? 10 : opened;
  const inSecs = `${secs} second${secs === 1 ? '' : 's'}`;
  const text = t.kind === 'take_over' ? `You took over. AI care ends in ${inSecs}; Undo keeps it paused instead.` : `AI care ends in ${inSecs}. Undo keeps it paused instead.`;
  const finishing = t.closesAt <= now;
  const close = (focusBack: boolean) => {
    const el = t.returnFocus;
    closeUndo();
    if (focusBack && el && document.contains(el)) el.focus();
  };
  useEffect(() => {
    if (t.fresh) {
      announce(`${text} Undo is focused.`);
      btn.current?.focus();
    }
    const i = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!said5.current && left <= 5 && left > 0) {
      said5.current = true;
      announce(`${left} seconds left to undo.`);
    }
    if (finishing) {
      const cid = t.contactId;
      close(true);
      onExpired(cid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, finishing]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(!t.composeAfter);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={TOAST_POS} data-testid="ai-undo-toast">
      <div role="group" aria-label="Undo AI care change" className="pointer-events-auto flex max-w-md flex-wrap items-center gap-3 rounded-xl bg-ink px-4 py-3 text-[15px] font-medium text-surface shadow-lg">
        <p className="min-w-0 flex-1">{text}</p>
        <span role="timer" aria-label={`${left} seconds left to undo`} className="tabular-nums">
          {left} s
        </span>
        <Button
          ref={btn}
          variant="secondary"
          pending={u.pending}
          onClick={async () => {
            const r = await u.run();
            close(!t.composeAfter);
            announce(r);
          }}
        >
          Undo
        </Button>
      </div>
    </div>
  );
}

/** After the window: poll the panel for up to 10 s; say who has the handoff once care has ended. */
function AfterWindow({ state, ownerUserId, ownerName, onDone }: { state: { contactId: string; until: number; text: string }; ownerUserId?: string; ownerName?: string | null; onDone(): void }) {
  const api = useApi();
  const qc = useQueryClient();
  const viewer = useViewer(ownerUserId, ownerName);
  const [text, setText] = useState('Finishing…');
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      while (!stop && Date.now() < state.until) {
        const p = await freshState(qc, api, state.contactId);
        if (p?.assignment?.endedAt) {
          let who = NO_RECIPIENT_WORDS;
          if (p.handoff) {
            try {
              const h = await api.get<HandoffView>(`/ai-isa/handoffs/${p.handoff.id}`);
              // batch 13 isa-4 F4: the recipient as ISA-2b routes it (the owner, the lead's new owner, or whoever took over)
              const a = p.assignment;
              const holder = handoffHolder({ recipientUserId: h.recipientUserId, viewerUserId: viewer.userId, ownerUserId: a.ownerUserId,
                ownerFirst: !ownerUserId || ownerUserId === a.ownerUserId ? viewer.ownerFirst : 'the owner', tookOver: a.pauseReason === 'taking_over' || h.reason === 'taken_over' });
              who = holder === 'you' ? 'The handoff is in your feed.' : holder ? `${cap(holder)} gets the handoff.` : NO_RECIPIENT_WORDS;
            } catch {
              /* not visible: keep the general sentence */
            }
          }
          const t = `AI care ended. ${who}`;
          setText(t);
          announce(t);
          void qc.invalidateQueries({ queryKey: ['ai-isa'] });
          void qc.invalidateQueries({ queryKey: ['feed'] });
          setTimeout(onDone, 6000);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!stop) setTimeout(onDone, 4000);
    };
    void tick();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={TOAST_POS} data-testid="ai-after-toast">
      <p className="pointer-events-auto max-w-md rounded-xl bg-ink px-4 py-3 text-[15px] font-medium text-surface shadow-lg">{text}</p>
    </div>
  );
}

export function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  const h = useId();
  return (
    <section aria-labelledby={h} id={id} className="flex flex-col gap-1">
      <h3 id={h} className="text-[15px] font-semibold text-ink">
        {title}
      </h3>
      <div className="text-[15px] text-ink">{children}</div>
    </section>
  );
}

export { localTime };
