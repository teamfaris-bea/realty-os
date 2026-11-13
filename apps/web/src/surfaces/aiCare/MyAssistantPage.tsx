// "My AI assistant" (/settings/ai-assistant; Owner, Admin, Team Lead, Agent; R-ISA-32; E524; docs/AI_ISA.md §3.3).
// The agent's own opt-in: every capability unchecked except "Talk with them by text and email (required)"; unbuilt
// capabilities disabled with "Not available yet on this deployment" (Q6); booking needs a connected calendar; the
// server's attestation text shown verbatim, ticked before Save (the body carries none: the server writes it,
// settings.ts:127-130); the password on a create or a wider choice (REAUTH_REQUIRED). Saving any change while care is
// on ends that care today (V19), so the form says so first (Q13). Re-attest after the team approved a new version,
// "Pause all my leads" and "Turn off for all my leads" (revoke).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Dialog, Notice, announce } from '../../design/index.js';
import { type AvailabilityWindow, type Channel, type MeView, type OptInBody, type OptInResult, type ReattestResult, useIsaAction, useIsaList, useMe } from './api.js';
import { HoldBanner, useHold } from './Controls.js';
import { BUILT, EMAIL_SENDER_CHECKS } from './built.js';
import { viewerZone } from './time.js';
import { CAPABILITY_WORDS, isaMessage } from './words.js';

const ALL_CAPS = ['converse', 'share_listings', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'book_appointments'] as const;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const BOOKING_KINDS = [
  { key: 'buyer_consult', label: 'Buyer consultation' },
  { key: 'listing_appointment', label: 'Listing appointment' },
  { key: 'consult', label: 'Consultation' },
] as const;
const FALLBACK_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'];

function zones(): string[] {
  try {
    const z = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (z && z.length > 0) return z;
  } catch {
    /* fall through */
  }
  return FALLBACK_ZONES;
}

export function windowsValid(w: readonly AvailabilityWindow[]): boolean {
  return w.length <= 28 && w.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x.start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(x.end) && x.end > x.start && x.weekday >= 1 && x.weekday <= 7);
}

export default function MyAssistantPage() {
  const me = useMe();
  if (me.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (me.isError) return me.error.status === 404 || me.error.status === 403 ? null : <Notice tone="error">{isaMessage(me.error)}</Notice>;
  return <Mine me={me.data} />;
}

function Mine({ me }: { me: MeView }) {
  const hold = useHold(null);
  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <p className="text-[15px] text-ink">{me.sentence}</p>
      {me.optIn ? <p className="text-[15px] text-ink">AI care for {me.underCare} of your leads.</p> : null}
      <HoldBanner hold={hold} replies={false} first="your leads" />
      {!me.policy ? (
        <p className="text-[15px] text-ink">Your team has no approved AI assistant policy yet. Nothing is sent for your leads.</p>
      ) : (
        <>
          {me.needsReattest ? <Reattest me={me} /> : null}
          {!me.needsReattest ? <OptInForm me={me} /> : null}
          {me.optIn ? <MyLeadsControls me={me} /> : null}
        </>
      )}
    </div>
  );
}

function OptInForm({ me }: { me: MeView }) {
  const policy = me.policy!;
  const o = me.optIn;
  const [caps, setCaps] = useState<Set<string>>(() => new Set(o ? o.capabilities : ['converse']));
  const [channels, setChannels] = useState<Set<Channel>>(() => new Set((o?.channels ?? policy.channels) as Channel[]));
  const [tz, setTz] = useState(o?.timezone ?? viewerZone());
  const [windows, setWindows] = useState<AvailabilityWindow[]>(o?.availability ?? []);
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(o?.bookingKinds ?? []));
  const [agree, setAgree] = useState(false);
  const [warn, setWarn] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const save = useIsaAction<OptInBody, OptInResult>('PUT', { kind: 'optin' });
  const offered = ALL_CAPS.filter((c) => policy.capabilities.includes(c) || c === 'converse');
  const booking = caps.has('book_appointments');
  const valid = channels.size > 0 && windowsValid(windows);
  const careOn = o !== null && me.underCare > 0;
  const body = (): OptInBody => ({
    versionId: policy.versionId,
    capabilities: ['converse', ...[...caps].filter((c) => c !== 'converse')],
    channels: [...channels],
    timezone: tz,
    availability: windows,
    bookingKinds: booking ? ([...kinds] as OptInBody['bookingKinds']) : [],
  });
  const doSave = async () => {
    setWarn(false);
    const r = await save.run('/me/ai-isa/opt-in', body());
    const t = r.ok ? (r.data.change === 'created' ? 'You are opted in.' : r.data.change === 'narrowed' ? 'Narrowed.' : 'Updated: your password confirmed the wider choices.') : r.message;
    setLine(t);
    announce(t);
  };
  const toggle = <T,>(set: Set<T>, v: T, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(v);
    else n.delete(v);
    return n;
  };
  const allZones = zones();
  return (
    <Card className="flex flex-col gap-4" aria-labelledby="optin-title">
      <h2 id="optin-title" className="text-[19px] font-semibold">
        {o ? 'Your opt-in' : 'Opt in'}
      </h2>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-[15px] font-semibold">What it may do for your leads</legend>
        {offered.map((c) => {
          const required = c === 'converse';
          const built = BUILT.has(c);
          const needsCal = c === 'book_appointments' && !me.calendarLive;
          const id = `cap-${c}`;
          return (
            <div key={c} className="flex flex-col gap-0.5">
              <label htmlFor={id} className="flex min-h-tap items-center gap-2 text-[15px]">
                <input id={id} type="checkbox" className="h-5 w-5" checked={required || caps.has(c)} disabled={required || !built || needsCal} onChange={(e) => setCaps(toggle(caps, c, e.target.checked))} />
                <span>
                  {required ? 'Talk with them by text and email (required)' : CAPABILITY_WORDS[c]}
                </span>
              </label>
              {!required && !built ? <p className="pl-7 text-[14px] text-ink-muted">Not available yet on this deployment</p> : null}
              {built && needsCal ? (
                <p className="pl-7 text-[14px]">
                  <Link to="/settings/calendar" className="font-medium text-accent underline">
                    Connect your calendar first
                  </Link>
                </p>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-[15px] font-semibold">Channels</legend>
        {(['sms', 'email'] as const)
          .filter((ch) => policy.channels.includes(ch))
          .map((ch) => (
            <div key={ch} className="flex flex-col gap-0.5">
              <label className="flex min-h-tap items-center gap-2 text-[15px]">
                <input type="checkbox" className="h-5 w-5" checked={channels.has(ch)} onChange={(e) => setChannels(toggle(channels, ch, e.target.checked))} />
                <span>{ch === 'sms' ? 'Texts' : 'Email'}</span>
              </label>
              {ch === 'email' && !EMAIL_SENDER_CHECKS ? <p className="pl-7 text-[14px] text-ink-muted">Their email replies pause AI care and come to you for now: sender checks for email are not wired yet.</p> : null}
            </div>
          ))}
        {channels.size === 0 ? <p className="text-[14px] text-danger">Choose at least one channel.</p> : null}
      </fieldset>
      <label className="flex flex-col gap-1 text-[15px] font-semibold" htmlFor="optin-tz">
        Your time zone
        <select id="optin-tz" value={tz} onChange={(e) => setTz(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[16px] font-normal">
          {(allZones.includes(tz) ? allZones : [tz, ...allZones]).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-[15px] font-semibold">When you are available (for booking)</legend>
        {windows.map((w, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-[14px]">
              Day
              <select value={w.weekday} onChange={(e) => setWindows(windows.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))} className="min-h-tap rounded-xl border border-line bg-surface px-2">
                {WEEKDAYS.map((d, k) => (
                  <option key={d} value={k + 1}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-[14px]">
              From
              <input type="time" value={w.start} onChange={(e) => setWindows(windows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} className="min-h-tap rounded-xl border border-line bg-surface px-2" />
            </label>
            <label className="flex flex-col text-[14px]">
              To
              <input type="time" value={w.end} onChange={(e) => setWindows(windows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} className="min-h-tap rounded-xl border border-line bg-surface px-2" />
            </label>
            <Button variant="quiet" onClick={() => setWindows(windows.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        {!windowsValid(windows) ? <p className="text-[14px] text-danger">Each window ends after it starts, and there are at most 28.</p> : null}
        {windows.length < 28 ? (
          <div>
            <Button variant="secondary" onClick={() => setWindows([...windows, { weekday: 1, start: '09:00', end: '17:00' }])}>
              Add a window
            </Button>
          </div>
        ) : null}
      </fieldset>
      {booking ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-[15px] font-semibold">What it may book</legend>
          {BOOKING_KINDS.map((k) => (
            <label key={k.key} className="flex min-h-tap items-center gap-2 text-[15px]">
              <input type="checkbox" className="h-5 w-5" checked={kinds.has(k.key)} onChange={(e) => setKinds(toggle(kinds, k.key, e.target.checked))} />
              <span>{k.label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <Attestation text={me.attestationText} agree={agree} setAgree={setAgree} />
      <div>
        <Button variant="primary" pending={save.pending} disabled={!agree || !valid} onClick={() => (careOn ? setWarn(true) : void doSave())}>
          Save
        </Button>
      </div>
      {line ? (
        <p role="status" className="text-[15px]" data-testid="optin-line">
          {line}
        </p>
      ) : null}
      {warn ? (
        <Dialog title="Save your opt-in" onClose={() => setWarn(false)}>
          <div className="flex flex-col gap-3 text-[15px]">
            <p>Saving any change ends AI care for your {me.underCare} leads under AI care. Each comes back to you with a handoff, and you can start them again.</p>
            <Button variant="primary" pending={save.pending} onClick={() => void doSave()}>
              Save and end that care
            </Button>
            <Button variant="secondary" onClick={() => setWarn(false)}>
              Keep it as it is
            </Button>
          </div>
        </Dialog>
      ) : null}
    </Card>
  );
}

function Attestation({ text, agree, setAgree }: { text: string | null; agree: boolean; setAgree(v: boolean): void }) {
  if (!text) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="rounded-xl border border-line bg-surface-2 p-3 text-[15px] [overflow-wrap:anywhere]" data-testid="attestation">
        {text}
      </p>
      <label className="flex min-h-tap items-center gap-2 text-[15px]">
        <input type="checkbox" className="h-5 w-5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>I have read this and agree</span>
      </label>
    </div>
  );
}

function Reattest({ me }: { me: MeView }) {
  const [agree, setAgree] = useState(false);
  const [lines, setLines] = useState<string[] | null>(null);
  const act = useIsaAction<{ versionId: string }, ReattestResult>('POST', { kind: 'continue' });
  const list = useIsaList('mine', 'any');
  const nameOf = (id: string) => list.data?.rows.find((r) => r.contactId === id)?.name ?? 'a lead';
  return (
    <Card className="flex flex-col gap-3" aria-labelledby="reattest-title">
      <h2 id="reattest-title" className="text-[19px] font-semibold">
        Re-attest
      </h2>
      <Notice tone="warn">Your team approved a new version of the AI rules. Re-attest to start AI care on new leads. Leads paused by the change say so on their page and continue when you re-attest.</Notice>
      <Attestation text={me.attestationText} agree={agree} setAgree={setAgree} />
      <div>
        <Button
          variant="primary"
          disabled={!agree}
          pending={act.pending}
          onClick={async () => {
            const r = await act.run('/me/ai-isa/re-attest', { versionId: me.policy!.versionId });
            if (!r.ok) return setLines([r.message]);
            const out = [
              r.data.continued.length > 0 ? `Continued: ${r.data.continued.map((c) => nameOf(c.contactId)).join(', ')}.` : 'No paused leads to continue.',
              ...r.data.notContinued.map((n) => `${nameOf(n.contactId)}. Not continued: ${isaMessage(n.code)}`),
            ];
            setLines(out);
            announce(out.join(' '));
          }}
        >
          Re-attest
        </Button>
      </div>
      {lines ? (
        <ul role="status" className="flex flex-col gap-1 text-[15px]">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function MyLeadsControls({ me }: { me: MeView }) {
  const pause = useIsaAction<Record<string, never>, { paused: number }>('POST', { kind: 'pause_all' });
  const revoke = useIsaAction<Record<string, never>, { ended: number }>('POST', { kind: 'revoke' });
  const [confirm, setConfirm] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const say = (t: string) => {
    setLine(t);
    announce(t);
  };
  return (
    <Card className="flex flex-col gap-3" aria-labelledby="myleads-title">
      <h2 id="myleads-title" className="text-[19px] font-semibold">
        All my leads
      </h2>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          pending={pause.pending}
          onClick={async () => {
            const r = await pause.run('/me/ai-isa/pause-all', {});
            say(r.ok ? `Paused ${r.data.paused}. Resume each lead from its page.` : r.message);
          }}
        >
          Pause all my leads
        </Button>
        <Button variant="danger" onClick={() => setConfirm(true)}>
          Turn off for all my leads
        </Button>
      </div>
      {line ? <p role="status" className="text-[15px]">{line}</p> : null}
      {confirm ? (
        <Dialog title="Turn off for all my leads" onClose={() => setConfirm(false)}>
          <div className="flex flex-col gap-3 text-[15px]">
            <p>This ends AI care for your {me.underCare} leads now and withdraws your opt-in. Each comes back to you with a handoff.</p>
            <Button
              variant="danger"
              pending={revoke.pending}
              onClick={async () => {
                const r = await revoke.run('/me/ai-isa/opt-in/revoke', {});
                setConfirm(false);
                say(r.ok ? `Your opt-in is withdrawn. AI care ended for ${r.data.ended} leads.` : r.message);
              }}
            >
              Turn off
            </Button>
          </div>
        </Dialog>
      ) : null}
    </Card>
  );
}
