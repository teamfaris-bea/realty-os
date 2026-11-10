// The agent's one-tap flows that need a sheet, shared by every agent page (feed, contact, thread,
// tasks, approvals): tap-to-call with the post-call outcome sheet, the appointment outcome sheet, and
// a polite status announcer.
//
// Tap-to-call (ARCHITECTURE §9 path 3): Call → POST /contacts/:id/calls, which runs the dial-time
// check before the provider bridges the client leg; the agent's own phone rings first. The post-call
// outcome sheet opens with the call (A1: "post-call sheet auto-opens → outcome chip", 1 tap). A call
// the check blocks (the client asked not to be called, a suppressed or wrong number, ...) shows the
// server's sentence and nothing else: there is no "call anyway" (owner decision, core-compliance/2.0.0;
// an opt-out is never overridden).
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, GateBadge, Notice } from '../../../design/index.js';
import { useApi } from '../../../shell/index.js';
import { APPOINTMENT_RESULTS, CALL_OUTCOMES, firstName, formatDateTime } from './format.js';
import { useMutate } from './hooks.js';
import { Sheet } from './Sheet.js';
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
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+12px)] z-50 flex justify-center px-4 md:bottom-6">
        {toast ? <p className="pointer-events-auto max-w-md rounded-xl bg-ink px-4 py-3 text-[15px] font-medium text-surface shadow-lg">{toast}</p> : null}
      </div>
      {open?.kind === 'call' ? <CallSheet contact={open.contact} onClose={close} announce={announce} /> : null}
      {open?.kind === 'appointment' ? <AppointmentSheet appointmentId={open.appointmentId} label={open.label} onClose={close} announce={announce} /> : null}
    </Ctx.Provider>
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
  const outcome = useMutate<{ outcome: CallOutcome }, CallOutcomeResponse>('POST', { invalidate: [['feed'], ['timeline', contact.id], ['tasks']] });
  const who = firstName(contact.name);

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
    <Sheet title={`Call ${contact.name}`} onClose={onClose}>
      {state.step === 'dialing' ? <p className="text-[16px] text-ink-muted">Checking you can call {who} now…</p> : null}
      {state.step === 'gate' ? (
        <div className="flex flex-col gap-3">
          <GateBadge lead="Won't call" decision={state.decision} />
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
    </Sheet>
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
    <Sheet title={label ?? 'How did it go?'} onClose={onClose}>
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
    </Sheet>
  );
}

// ---- what happened to a send, in words ---------------------------------------------------------

export function sendOutcomeText(r: Pick<ComposeResponse, 'result' | 'decision' | 'message'>, contactName: string): { tone: 'ok' | 'warn' | 'error'; title: string; detail?: string } {
  const who = firstName(contactName);
  const until = r.message?.scheduledFor ?? null;
  switch (r.result) {
    case 'sent':
    case 'noop':
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
