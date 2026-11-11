// The agent's one-tap flows that need a sheet, shared by every agent page (feed, contact, thread,
// tasks, approvals): tap-to-call with the post-call outcome sheet, the appointment outcome sheet, and
// a toast. The sheets are design/Dialog (a bottom sheet on a phone, the rest of the page inert while
// open). The toast is seen in place and heard through design/Announce's one polite live region, so
// the app never has two live regions saying the same thing.
//
// Tap-to-call (ARCHITECTURE §9 path 3): Call → POST /contacts/:id/calls, which runs the dial-time
// check before the provider bridges the client leg; the agent's own phone rings first. The post-call
// outcome sheet opens with the call (A1: "post-call sheet auto-opens → outcome chip", 1 tap). A call
// the check blocks (the client asked not to be called, a suppressed or wrong number, ...) shows the
// server's sentence and nothing else: there is no "call anyway" (owner decision, core-compliance/2.0.0;
// an opt-out is never overridden).
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, GateBadge, Notice, announce as speak } from '../../../design/index.js';
import { REACHABILITY_KEY, useChannelState } from '../../../reasons/index.js';
import { useApi } from '../../../shell/index.js';
import { APPOINTMENT_RESULTS, CALL_OUTCOMES, firstName, formatDateTime } from './format.js';
import { useMutate } from './hooks.js';
import type { AppointmentResult, AppointmentView, CallOutcome, CallOutcomeResponse, CallResponse, ComposeResponse, DecisionView } from './types.js';

export interface AgentSheets {
  call(contact: { id: string; name: string }): void;
  logAppointment(appointmentId: string, label?: string): void;
  announce(text: string): void;
}

const Ctx = createContext<AgentSheets | null>(null);

export function useAgentSheets(): AgentSheets {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAgentSheets outside AgentSheetsProvider');
  return v;
}

type Open =
  | { kind: 'call'; contact: { id: string; name: string } }
  | { kind: 'appointment'; appointmentId: string; label?: string | undefined }
  | null;

export function AgentSheetsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open>(null);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = useCallback((text: string) => {
    speak(text);
    setToast(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const value = useMemo<AgentSheets>(
    () => ({
      call: (contact) => setOpen({ kind: 'call', contact }),
      logAppointment: (appointmentId, label) => setOpen({ kind: 'appointment', appointmentId, label }),
      announce,
    }),
    [announce],
  );
  const close = () => setOpen(null);
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* seen here, heard through announce(): aria-hidden so a screen reader does not meet it twice */}
      <div aria-hidden="true" data-testid="toast" className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+12px)] z-50 flex justify-center px-4 md:bottom-6">
        {toast ? <p className="pointer-events-auto max-w-md rounded-xl bg-ink px-4 py-3 text-[15px] font-medium text-surface shadow-lg">{toast}</p> : null}
      </div>
      {open?.kind === 'call' ? <CallSheet contact={open.contact} onClose={close} announce={announce} /> : null}
      {open?.kind === 'appointment' ? <AppointmentSheet appointmentId={open.appointmentId} label={open.label} onClose={close} announce={announce} /> : null}
    </Ctx.Provider>
  );
}

/** A visible way out of a sheet (Escape and the backdrop close it too): a phone has no Escape key. */
function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="secondary" block onClick={onClose}>
      Close
    </Button>
  );
}

// ---- tap-to-call + post-call outcome ------------------------------------------------------------

type CallState =
  | { step: 'dialing' }
  | { step: 'gate'; decision: DecisionView }
  | { step: 'failed'; message: string; decision?: DecisionView }
  | { step: 'live'; callId: string; decision: DecisionView };

const CALL_FAILED: Record<string, string> = {
  AGENT_PHONE_MISSING: 'Add your phone number in Account so calls can ring you first.',
  PROVIDER_UNAVAILABLE: "The phone service isn't answering right now. Try again in a moment.",
};

function CallSheet({ contact, onClose, announce }: { contact: { id: string; name: string }; onClose: () => void; announce: (t: string) => void }) {
  const api = useApi();
  const [state, setState] = useState<CallState>({ step: 'dialing' });
  const started = useRef(false);
  const outcome = useMutate<{ outcome: CallOutcome }, CallOutcomeResponse>('POST', { invalidate: [['feed'], ['timeline', contact.id], ['tasks'], [...REACHABILITY_KEY]] });
  const who = firstName(contact.name);
  // the exact reason a refused call rests on ("Asked not to be called (recorded by Avery Brooks on Oct 3)")
  const voice = useChannelState(contact.id, 'voice');

  const dial = useCallback(
    async () => {
      setState({ step: 'dialing' });
      try {
        const r = await api.post<CallResponse>(`/contacts/${contact.id}/calls`, {});
        if (r.result === 'dialing' && r.callId) setState({ step: 'live', callId: r.callId, decision: r.decision });
        else if (r.result === 'gate') setState({ step: 'gate', decision: r.decision });
        else setState({ step: 'failed', message: CALL_FAILED[r.reason ?? ''] ?? "The call didn't go through. Nothing was dialed.", decision: r.decision });
      } catch (e) {
        const code = (e as { code?: string }).code ?? '';
        setState({ step: 'failed', message: CALL_FAILED[code] ?? "The call didn't go through. Check your connection, then try again." });
      }
    },
    [api, contact.id],
  );

  // one tap = one dial; StrictMode's double effect must not dial twice
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void dial();
  }, [dial]);

  const log = async (o: CallOutcome) => {
    if (state.step !== 'live') return;
    const r = await outcome.run(`/calls/${state.callId}/outcome`, { outcome: o });
    if (!r.ok) return;
    onClose();
    announce(r.data.recordedAs === 'task_for_current_owner' ? `${who} was reassigned during the call, so your outcome was saved as a task for the new owner.` : 'Call outcome saved.');
  };

  return (
    <Dialog title={`Call ${contact.name}`} onClose={onClose} footer={<CloseButton onClose={onClose} />}>
      {state.step === 'dialing' ? <p className="text-[16px] text-ink-muted">Checking you can call {who} now…</p> : null}
      {state.step === 'gate' ? (
        <div className="flex flex-col gap-3">
          <GateBadge lead="Won't call" decision={voice.blocked && voice.sentence ? { outcome: 'deny', explanation: voice.sentence } : state.decision} />
          <p className="text-[15px] text-ink-muted">Nothing was dialed.</p>
        </div>
      ) : null}
      {state.step === 'failed' ? (
        <Notice tone="error" title="Not called">
          {state.message}
        </Notice>
      ) : null}
      {state.step === 'live' ? (
        <div className="flex flex-col gap-4">
          <p className="text-[16px] text-ink">Your phone will ring first. Answer it and you're connected to {who}.</p>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[15px] font-semibold text-ink">When you hang up: how did it go?</legend>
            <div className="flex flex-wrap gap-2">
              {CALL_OUTCOMES.map((o) => (
                <Button key={o.value} variant="secondary" disabled={outcome.pending} onClick={() => void log(o.value)}>
                  {o.label}
                </Button>
              ))}
            </div>
          </fieldset>
          {outcome.error ? <Notice tone="error">{outcome.error.message}</Notice> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

// ---- appointment outcome ----------------------------------------------------------------------

function AppointmentSheet({ appointmentId, label, onClose, announce }: { appointmentId: string; label?: string | undefined; onClose: () => void; announce: (t: string) => void }) {
  const m = useMutate<{ result: AppointmentResult; note?: string }, { appointment: AppointmentView }>('POST', { invalidate: [['feed'], ['appointments'], ['tasks']] });
  const [note, setNote] = useState('');
  const pick = async (result: AppointmentResult) => {
    const r = await m.run(`/appointments/${appointmentId}/outcome`, note.trim() ? { result, note: note.trim() } : { result });
    if (!r.ok) return;
    onClose();
    announce('Outcome saved.');
  };
  return (
    <Dialog title={label ?? 'How did it go?'} onClose={onClose} footer={<CloseButton onClose={onClose} />}>
      <div className="flex flex-col gap-4">
        <fieldset>
          <legend className="mb-2 text-[15px] font-semibold text-ink">Outcome</legend>
          <div className="flex flex-wrap gap-2">
            {APPOINTMENT_RESULTS.map((o) => (
              <Button key={o.value} variant="secondary" disabled={m.pending} onClick={() => void pick(o.value)}>
                {o.label}
              </Button>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1.5 text-[15px] font-medium text-ink">
          Note (optional)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink" />
        </label>
        {m.error ? <Notice tone="error">{m.error.message}</Notice> : null}
      </div>
    </Dialog>
  );
}

// ---- what happened to a send, in words ---------------------------------------------------------

/** What a message's status says a send did (a replay's only source: it carries no new result of its own). */
const BY_STATUS: Record<string, string> = {
  sent: 'sent',
  delivered: 'sent',
  queued: 'queued',
  dispatching: 'queued',
  scheduled: 'scheduled',
  dispatch_unknown: 'dispatch_unknown',
  failed: 'failed',
  undelivered: 'failed',
  bounced: 'failed',
  blocked: 'blocked',
  canceled: 'blocked',
};

/**
 * What a send, an approval or a re-tap actually did. A replay (result 'noop': the same idempotency key or commandId
 * again, as after an automatic retry of a lost answer) has no effect of its own; what the first attempt did is in its
 * message's status (`message.status`, or an approval's `messageStatus`), so a blocked, failed or canceled message is
 * never shown as sent (finding F1). A replay whose message is unknown stays 'noop': nobody can say it went out.
 */
export function sentResult(r: { result: string; message?: { status: string } | null; messageStatus?: string | null }): string {
  if (r.result !== 'noop') return r.result;
  const status = r.messageStatus ?? r.message?.status ?? null;
  return (status !== null ? BY_STATUS[status] : undefined) ?? 'noop';
}

/** The outcomes after which the text is on its way (the box clears; "Sent to Jane." / "Sending" / "Sends at"). */
export const WENT_OUT: ReadonlySet<string> = new Set(['sent', 'queued', 'scheduled']);

export function sendOutcomeText(r: Pick<ComposeResponse, 'result' | 'decision' | 'message'> & { messageStatus?: string | null }, contactName: string): { tone: 'ok' | 'warn' | 'error'; title: string; detail?: string } {
  const who = firstName(contactName);
  const until = r.message?.scheduledFor ?? null;
  switch (sentResult(r)) {
    case 'sent':
      return { tone: 'ok', title: `Sent to ${who}.` };
    case 'queued':
      return { tone: 'ok', title: `Sending to ${who}.` };
    case 'scheduled':
    case 'not_due':
      return { tone: 'ok', title: until ? `Sends ${formatDateTime(until)}.` : 'Scheduled.' };
    case 'dispatch_unknown':
      return { tone: 'warn', title: "We can't confirm it was delivered yet.", detail: "The phone service didn't answer in time. We'll check and tell you; it won't be sent twice." };
    case 'failed':
      return { tone: 'error', title: "It didn't send.", detail: 'The phone service refused it. Nothing reached them.' };
    case 'blocked':
    case 'not_created':
      return { tone: 'error', title: 'Not sent.', ...(r.decision?.explanation ? { detail: r.decision.explanation } : {}) };
    case 'needs_retap':
      return { tone: 'warn', title: `Not sent: ${who} replied since it was scheduled.`, detail: 'Read the reply, then send again if it still fits.' };
    case 'acknowledged':
      return { tone: 'ok', title: 'Marked as reviewed.' };
    default:
      return { tone: 'warn', title: 'Saved.', detail: "We couldn't tell what happened next. Check the conversation." };
  }
}

export function SendOutcome({ result, contactName }: { result: Pick<ComposeResponse, 'result' | 'decision' | 'message'>; contactName: string }) {
  const t = sendOutcomeText(result, contactName);
  if (result.decision && result.decision.outcome === 'deny' && (result.result === 'blocked' || result.result === 'not_created')) return <GateBadge lead="Not sent" decision={result.decision} />;
  return (
    <Notice tone={t.tone} title={t.title}>
      {t.detail}
    </Notice>
  );
}

/** Formats an appointment for the outcome sheet title. */
export function appointmentLabel(a: Pick<AppointmentView, 'kind' | 'startsAt' | 'contact'>): string {
  const kind = a.kind === 'buyer_consult' ? 'Buyer consult' : a.kind === 'listing_appointment' ? 'Listing appointment' : a.kind === 'consult' ? 'Consult' : 'Appointment';
  return `${kind}${a.contact ? ` with ${a.contact.name}` : ''} · ${formatDateTime(a.startsAt)}`;
}
