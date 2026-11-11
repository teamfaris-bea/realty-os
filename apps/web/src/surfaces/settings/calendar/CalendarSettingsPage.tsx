// Calendar settings (module 41's calendar page, over module 34 api/calendar). The signed-in person connects
// THEIR OWN Google or Outlook calendar, sees the connection's state in plain words (connected, needs
// reconnect, not set up on this platform), disconnects it, and reads what syncs (one way, Realty OS → calendar).
// Nobody else's calendar is ever shown here: the API is self-only (R-CAL-1).
//
// Taps: connect = 1 tap here (then the provider's approval screen); disconnect = 2 taps (Disconnect, then
// "Yes, disconnect"), so one stray tap never revokes the grant.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, Notice } from '../../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../../shell/index.js';
import { formatDateTime } from '../../feed/lib/format.js';

export type LinkState = 'connected' | 'degraded' | 'needs_reconnect' | 'not_connected' | 'not_configured';

export interface ProviderView {
  provider: 'google_calendar' | 'microsoft_calendar';
  name: string;
  state: LinkState;
  sentence: string;
  canConnect: boolean;
  canDisconnect: boolean;
  blockedSentence: string | null;
  lastSyncedAt: string | null;
}

export interface CalendarView {
  adapterMode: 'fake' | 'unconfigured' | 'real';
  syncSentence: string;
  privacySentence: string;
  providers: ProviderView[];
  detached: { appointmentId: string; kind: string; startsAt: string; sentence: string }[];
}

export const CALENDAR_KEY = ['me', 'calendar'] as const;

const STATE_LABEL: Record<LinkState, string> = {
  connected: 'Connected',
  degraded: 'Connected, last update failed',
  needs_reconnect: 'Needs reconnect',
  not_connected: 'Not connected',
  not_configured: 'Not set up on this platform',
};

const STATE_TONE: Record<LinkState, string> = {
  connected: 'bg-ok-soft text-ok',
  degraded: 'bg-warn-soft text-warn',
  needs_reconnect: 'bg-warn-soft text-warn',
  not_connected: 'border border-line text-ink',
  not_configured: 'border border-line text-ink',
};

const KIND_LABEL: Record<string, string> = { buyer_consult: 'Buyer consult', listing_appointment: 'Listing appointment', consult: 'Consult', other: 'Appointment' };

/** What the provider redirect (`?result=`) means, in words. */
export const RESULT_SENTENCES: Record<string, { tone: 'ok' | 'error' | 'info'; text: string }> = {
  CONNECTED: { tone: 'ok', text: 'Your calendar is connected. New and changed appointments will appear there.' },
  CANCELLED: { tone: 'info', text: 'Nothing was connected: the approval was cancelled.' },
  STATE_EXPIRED: { tone: 'error', text: 'That approval took too long. Tap Connect to try again.' },
  STATE_STALE: { tone: 'error', text: 'That approval was already used. Tap Connect to try again.' },
  STATE_INVALID: { tone: 'error', text: 'That approval could not be checked, so nothing was connected. Tap Connect to try again while signed in as yourself.' },
  NOT_CONFIGURED: { tone: 'error', text: 'Calendars are not set up on this platform yet, so nothing was connected.' },
  ALREADY_CONNECTED: { tone: 'error', text: 'You already have a calendar connected. Disconnect it first to use another one.' },
  PROVIDER_REFUSED: { tone: 'error', text: 'The calendar provider did not accept the approval, so nothing was connected. Try again in a moment.' },
  SCOPE_MISMATCH: { tone: 'error', text: 'The approval did not match the access Realty OS asks for (adding events and reading busy times only), so nothing was connected and the access was handed back. Try again and allow both.' },
};

const MESSAGES: Record<string, string> = {
  CALENDAR_ALREADY_CONNECTED: 'You already have a calendar connected. Disconnect it first to use another one.',
  INTEGRATION_NOT_CONFIGURED: 'Calendars are not set up on this platform yet.',
};

function ProviderCard({ p, onChanged }: { p: ProviderView; onChanged: (v: CalendarView, text: string) => void }) {
  const api = useApi();
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<'connect' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setPending('connect');
    setError(null);
    try {
      const r = await api.request<{ authorizeUrl: string }>('POST', `/me/calendar/${p.provider}/connect`, {});
      window.location.assign(r.authorizeUrl);
    } catch (e) {
      setError(messageFor(e as ApiError, MESSAGES));
      setPending(null);
    }
  };
  const disconnect = async () => {
    setPending('disconnect');
    setError(null);
    try {
      const v = await api.request<CalendarView>('POST', `/me/calendar/${p.provider}/disconnect`, {});
      setConfirming(false);
      onChanged(v, `${p.name} is disconnected. Nothing more is sent to it. Events already added stay in your calendar, and your appointments in Realty OS are unchanged.`);
    } catch (e) {
      setError(messageFor(e as ApiError, MESSAGES));
    } finally {
      setPending(null);
    }
  };

  const live = p.state === 'connected' || p.state === 'degraded';
  return (
    <Card aria-labelledby={`${id}-name`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-name`} className="text-[19px] font-semibold text-ink">
          {p.name}
        </h2>
        <span className={`rounded-full px-2.5 py-1 text-[14px] font-medium ${STATE_TONE[p.state]}`}>{STATE_LABEL[p.state]}</span>
      </div>
      <p className="text-[15px] text-ink">{p.sentence}</p>
      {p.lastSyncedAt && live ? <p className="text-[14px] text-ink-muted">Last update sent {formatDateTime(p.lastSyncedAt)}</p> : null}
      {p.blockedSentence ? <p className="text-[14px] text-ink-muted">{p.blockedSentence}</p> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        {p.canConnect ? (
          <Button icon="calendar" pending={pending === 'connect'} pendingLabel="Opening" onClick={() => void connect()}>
            {p.state === 'needs_reconnect' ? `Reconnect ${p.name}` : `Connect ${p.name}`}
          </Button>
        ) : null}
        {p.canDisconnect && !confirming ? (
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            {`Disconnect ${p.name}`}
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <div role="group" aria-label={`Disconnect ${p.name}?`} className="flex flex-col gap-2 rounded-xl border border-line p-3">
          <p className="text-[15px] text-ink">Realty OS stops adding appointments to {p.name} and deletes its access right away. Events already added stay in your calendar.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" pending={pending === 'disconnect'} pendingLabel="Disconnecting" onClick={() => void disconnect()}>
              Yes, disconnect
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Keep connected
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default function CalendarSettingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const id = useId();
  const [params, setParams] = useSearchParams();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(() => {
    const r = params.get('result');
    return r ? (RESULT_SENTENCES[r] ?? { tone: 'error', text: 'Nothing was connected. Tap Connect to try again.' }) : null;
  });
  useEffect(() => {
    if (params.has('result')) setParams({}, { replace: true });
  }, [params, setParams]);
  const q = useQuery<CalendarView, ApiError>({ queryKey: [...CALENDAR_KEY], queryFn: ({ signal }) => api.get<CalendarView>('/me/calendar', { signal }) });

  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error) : null}</Notice>;
  const v = q.data;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 md:mx-0">
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <Card aria-labelledby={`${id}-sync`} className="flex flex-col gap-2">
        <h2 id={`${id}-sync`} className="text-[19px] font-semibold text-ink">
          What syncs
        </h2>
        <p className="text-[15px] text-ink">{v.syncSentence}</p>
        <p className="text-[15px] text-ink-muted">{v.privacySentence}</p>
      </Card>
      {v.providers.map((p) => (
        <ProviderCard
          key={p.provider}
          p={p}
          onChanged={(next, text) => {
            qc.setQueryData([...CALENDAR_KEY], next);
            setMsg({ tone: 'ok', text });
          }}
        />
      ))}
      {v.detached.length > 0 ? (
        <Card aria-labelledby={`${id}-detached`} className="flex flex-col gap-2">
          <h2 id={`${id}-detached`} className="text-[19px] font-semibold text-ink">
            No longer updated in your calendar
          </h2>
          <ul className="flex flex-col gap-2">
            {v.detached.map((d) => (
              <li key={d.appointmentId} className="flex flex-col gap-0.5 border-t border-line pt-2 first:border-t-0 first:pt-0">
                <span className="text-[15px] font-medium text-ink">
                  {KIND_LABEL[d.kind] ?? 'Appointment'}, {formatDateTime(d.startsAt)}
                </span>
                <span className="text-[14px] text-ink-muted">{d.sentence}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
