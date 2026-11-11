// Settings → Gmail (module 69, D2; R-GMAIL-1, -2, -5, -6, -8, -13 UI side). Every staff member manages only
// their own Gmail link here; nobody else's mailbox, token or sync state is ever shown (the API returns
// only the caller's own link).
//
//   not available   pack not cleared / switch off / provider not configured: the server's sentence, no button
//   not connected   the disclosure (disclosure.json, word for word) and ONE "Connect Gmail" button:
//                   POST /me/mail-link/connect {disclosureSha256} → window.location.assign(authorizeUrl)
//   back from Google ?result=CODE in words; then "Sync Gmail with these clients?" with every suggestion
//                   pre-checked and ONE "Sync these clients" (POST /me/mail-sync-points). Later suggestions
//                   are a one-tap "Sync" each; a confirmed address has "Stop syncing this address".
//   connected       status in words, Import again, Disconnect (confirm sheet with the exact copy).
//
// Taps: Connect Gmail → [Google consent, out of band] → Sync these clients (2 in the app); a later
// suggestion: Sync (1); Disconnect → Disconnect Gmail (2).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, Dialog, Notice, safeUrl } from '../../../design/index.js';
import { ApiError, type HttpMethod, messageFor, useApi, useWithReauth } from '../../../shell/index.js';
import { DISCLOSURE_PARAGRAPHS, DISCLOSURE_TITLE, disclosureSha256 } from './disclosure.js';
import { MAIL_LINK_KEY, type MailLinkResponse, type MailLinkView, SYNC_POINTS_KEY, type SuggestedPoint, type SyncPointsResponse, isLive } from './types.js';
import { COPY, MAIL_ERROR_MESSAGES, backfillWords, resultWords, statusWords } from './words.js';

/** Leaving for Google's consent screen (a seam for tests: jsdom cannot navigate). */
export const browser = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

type Outcome<R> = { ok: true; data: R } | { ok: false; code: string; message: string };

/** One request at a time per page; REAUTH_REQUIRED opens the shell's password prompt and re-sends once. */
function useRequest() {
  const api = useApi();
  const withReauth = useWithReauth();
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async <R,>(what: string, method: Exclude<HttpMethod, 'GET'>, path: string, body?: unknown): Promise<Outcome<R> | null> => {
      if (busy.current) return null;
      busy.current = true;
      setPending(what);
      try {
        return { ok: true, data: await withReauth(() => api.request<R>(method, path, body)) };
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 0);
        return { ok: false, code: err.code, message: messageFor(err, MAIL_ERROR_MESSAGES) };
      } finally {
        busy.current = false;
        if (mounted.current) setPending(null);
      }
    },
    [api, withReauth],
  );
  return { run, pending };
}

export default function MailSettingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const req = useRequest();
  const [params, setParams] = useSearchParams();
  // the callback's result is read once, then dropped from the URL (a reload must not repeat it)
  const [result] = useState(() => params.get('result'));
  useEffect(() => {
    if (params.has('result')) {
      const next = new URLSearchParams(params);
      next.delete('result');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const q = useQuery<MailLinkResponse, ApiError>({ queryKey: [...MAIL_LINK_KEY], queryFn: ({ signal }) => api.get<MailLinkResponse>('/me/mail-link', { signal }) });
  const live = isLive(q.data?.link);
  const points = useQuery<SyncPointsResponse, ApiError>({
    queryKey: [...SYNC_POINTS_KEY],
    queryFn: ({ signal }) => api.get<SyncPointsResponse>('/me/mail-sync-points', { signal }),
    enabled: live,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [...MAIL_LINK_KEY] });
    void qc.invalidateQueries({ queryKey: [...SYNC_POINTS_KEY] });
  };
  const said = (text: string) => setStatus(text);

  const connect = async () => {
    setError(null);
    setStatus(null);
    const sha = await disclosureSha256();
    const r = await req.run<{ authorizeUrl: string }>('connect', 'POST', '/me/mail-link/connect', { disclosureSha256: sha });
    if (!r) return;
    if (!r.ok) {
      setError(r.message);
      if (r.code === 'MAIL_ALREADY_CONNECTED' || r.code === 'MAIL_SYNC_OFF' || r.code === 'MAIL_PROVIDER_NOT_CONFIGURED') refresh();
      return;
    }
    const url = safeUrl(r.data.authorizeUrl, { allow: ['https:'] });
    if (!url) {
      setError(messageFor('BAD_RESPONSE'));
      return;
    }
    browser.assign(url);
  };

  const confirm = async (pointIds: string[]) => {
    setError(null);
    const r = await req.run<{ confirmed: number }>(pointIds.length === 1 ? `sync:${pointIds[0]}` : 'sync-all', 'POST', '/me/mail-sync-points', { pointIds });
    if (!r) return;
    refresh();
    if (!r.ok) return setError(r.message);
    said(r.data.confirmed === 1 ? 'Syncing Gmail with 1 client.' : `Syncing Gmail with ${r.data.confirmed} clients.`);
  };

  const stopSyncing = async (pointId: string, address: string) => {
    setError(null);
    const r = await req.run<{ removed: boolean }>(`stop:${pointId}`, 'DELETE', `/me/mail-sync-points/${encodeURIComponent(pointId)}`);
    if (!r) return;
    refresh();
    if (!r.ok) return setError(r.message);
    said(`Stopped syncing ${address}. Its copies left Realty OS.`);
  };

  const importAgain = async () => {
    setError(null);
    const r = await req.run<{ link: MailLinkView }>('import', 'POST', '/me/mail-link/import-again', {});
    if (!r) return;
    refresh();
    if (!r.ok) return setError(r.message);
    said('Importing again. Mail with your synced clients shows up in their conversations as it is copied.');
  };

  const disconnect = async () => {
    setError(null);
    // the sheet closes first: a password prompt (REAUTH_REQUIRED) must not open on top of another dialog
    setConfirmingDisconnect(false);
    const r = await req.run<{ link: MailLinkView }>('disconnect', 'DELETE', '/me/mail-link');
    if (!r) return;
    refresh();
    if (!r.ok) return setError(r.message);
    said('Gmail is disconnected. Your copies disappeared from Realty OS.');
  };

  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error, MAIL_ERROR_MESSAGES) : null}</Notice>;
  const d = q.data;
  const link = d.link;
  const back = resultWords(result);
  const busy = req.pending !== null;

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-6 md:mx-0">
      {back ? <Notice tone={back.tone}>{back.text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p role="status" aria-live="polite" className="min-h-[1px] text-[15px] font-medium text-ok">
        {status ?? ''}
      </p>

      {isLive(link) ? (
        <>
          <Section title="Your Gmail">
            <p className="text-[16px] text-ink [overflow-wrap:anywhere]">{statusWords(link)}</p>
            {backfillWords(link, d.backfillDays) ? <p className="text-[15px] text-ink-muted">{backfillWords(link, d.backfillDays)}</p> : null}
            <p className="text-[15px] text-ink-muted">Read-only: Realty OS never sends, labels or deletes in your Gmail.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" pending={req.pending === 'import'} pendingLabel="Starting" disabled={busy && req.pending !== 'import'} onClick={() => void importAgain()}>
                Import again
              </Button>
              <Button variant="quiet" pending={req.pending === 'disconnect'} pendingLabel="Disconnecting" disabled={busy && req.pending !== 'disconnect'} onClick={() => setConfirmingDisconnect(true)}>
                Disconnect
              </Button>
            </div>
          </Section>
          <SyncPoints q={points} pending={req.pending} onConfirm={(ids) => void confirm(ids)} onStop={(id, a) => void stopSyncing(id, a)} />
        </>
      ) : (
        <>
          {link ? (
            link.revokeReason === 'PROVIDER_REVOKED' ? (
              <Notice tone="warn">{COPY.providerRevoked}</Notice>
            ) : (
              <p className="text-[16px] text-ink">{statusWords(link)}</p>
            )
          ) : null}
          {d.available.canConnect ? (
            <Disclosure>
              <Button pending={req.pending === 'connect'} pendingLabel="Opening Google" onClick={() => void connect()}>
                Connect Gmail
              </Button>
            </Disclosure>
          ) : (
            <Section title="Gmail sync isn't available">
              <p className="text-[16px] text-ink">{d.available.sentence}</p>
            </Section>
          )}
        </>
      )}

      {confirmingDisconnect && live ? (
        <Dialog
          title="Disconnect Gmail?"
          description={COPY.disconnect}
          onClose={() => setConfirmingDisconnect(false)}
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" onClick={() => setConfirmingDisconnect(false)}>
                Go back
              </Button>
              <Button variant="danger" onClick={() => void disconnect()}>
                Disconnect Gmail
              </Button>
            </div>
          }
        >
          <p className="text-[16px] text-ink">Nothing changes in your Gmail. You can connect again later.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

/** The connect disclosure, exactly as disclosure.json says (its hash goes with the connect request). */
export function Disclosure({ children }: { children?: ReactNode }) {
  return (
    <Section title={DISCLOSURE_TITLE}>
      {DISCLOSURE_PARAGRAPHS.map((p) => (
        <p key={p} className="text-[16px] text-ink">
          {p}
        </p>
      ))}
      {children ? <div>{children}</div> : null}
    </Section>
  );
}

function SyncPoints({ q, pending, onConfirm, onStop }: { q: { data?: SyncPointsResponse | undefined; isPending: boolean; isError: boolean; error: ApiError | null }; pending: string | null; onConfirm(ids: string[]): void; onStop(pointId: string, address: string): void }) {
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading your clients</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error, MAIL_ERROR_MESSAGES) : null}</Notice>;
  const { confirmed, suggestions } = q.data;
  const first = confirmed.length === 0;
  const busy = pending !== null;
  return (
    <>
      {suggestions.length > 0 && first ? (
        <BulkConfirm key={suggestions.map((s) => s.pointId).join(',')} suggestions={suggestions} pending={pending === 'sync-all'} busy={busy} onConfirm={onConfirm} />
      ) : null}
      {suggestions.length > 0 && !first ? (
        <Section title="New clients you can sync" description={COPY.onlyConfirmed}>
          <ul className="flex flex-col divide-y divide-line">
            {suggestions.map((s) => (
              <li key={s.pointId} className="flex flex-wrap items-center gap-3 py-2">
                <PointName name={s.contactName} address={s.address} />
                <Button variant="secondary" aria-label={`Sync ${s.address}`} pending={pending === `sync:${s.pointId}`} pendingLabel="Syncing" disabled={busy && pending !== `sync:${s.pointId}`} onClick={() => onConfirm([s.pointId])}>
                  Sync
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {first && suggestions.length === 0 ? (
        <Section title="Clients you sync">
          <p className="text-[16px] text-ink">None of your clients has an email address on file yet. When one does, it shows up here to confirm.</p>
          <p className="text-[15px] text-ink-muted">{COPY.onlyConfirmed}</p>
        </Section>
      ) : null}
      {confirmed.length > 0 ? (
        <Section title="Clients you sync" description={COPY.onlyConfirmed}>
          <ul className="flex flex-col divide-y divide-line">
            {confirmed.map((c) => (
              <li key={c.pointId} className="flex flex-wrap items-center gap-3 py-2">
                <PointName name={c.contactName} address={c.address} />
                <Button variant="quiet" pending={pending === `stop:${c.pointId}`} pendingLabel="Stopping" disabled={busy && pending !== `stop:${c.pointId}`} onClick={() => onStop(c.pointId, c.address)}>
                  Stop syncing this address
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

function BulkConfirm({ suggestions, pending, busy, onConfirm }: { suggestions: SuggestedPoint[]; pending: boolean; busy: boolean; onConfirm(ids: string[]): void }) {
  // every suggestion starts checked: what the agent unticks is left out
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const id = useId();
  const chosen = suggestions.filter((s) => !unchecked.has(s.pointId)).map((s) => s.pointId);
  return (
    <Section title={COPY.confirmTitle} description={COPY.onlyConfirmed}>
      <ul className="flex flex-col divide-y divide-line">
        {suggestions.map((s) => (
          <li key={s.pointId} className="py-1">
            <label htmlFor={`${id}-${s.pointId}`} className="flex min-h-tap items-center gap-3">
              <input
                id={`${id}-${s.pointId}`}
                type="checkbox"
                className="h-[22px] w-[22px] shrink-0 accent-[var(--accent)]"
                checked={!unchecked.has(s.pointId)}
                onChange={(e) =>
                  setUnchecked((old) => {
                    const next = new Set(old);
                    if (e.target.checked) next.delete(s.pointId);
                    else next.add(s.pointId);
                    return next;
                  })
                }
              />
              <PointName name={s.contactName} address={s.address} />
            </label>
          </li>
        ))}
      </ul>
      <div>
        <Button pending={pending} pendingLabel="Syncing" disabled={chosen.length === 0 || (busy && !pending)} onClick={() => onConfirm(chosen)}>
          Sync these clients
        </Button>
      </div>
    </Section>
  );
}

function PointName({ name, address }: { name: string; address: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="text-[16px] font-medium text-ink [overflow-wrap:anywhere]">{name}</span>
      <span className="text-[14px] text-ink-muted [overflow-wrap:anywhere]">{address}</span>
    </span>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-[19px] font-semibold text-ink">
          {title}
        </h2>
        {description ? <p className="text-[15px] text-ink-muted">{description}</p> : null}
      </div>
      {children}
    </Card>
  );
}
