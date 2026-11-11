// Connect MLS (Spark): the Owner/Admin page that stores the CRM's Spark access token, validates it
// and disconnects it (lane/spark-prep contract, apps/api integrations).
//
//   GET  /admin/integrations/mls/spark                  what this deployment does, and the connection
//   PUT  /admin/integrations/mls/spark/credential       save (or replace) the key   (re-auth)
//   POST /admin/integrations/mls/spark/validate         one test request to Spark   (re-auth)
//   POST /admin/integrations/connections/:id/disconnect revoke and purge the key    (re-auth)
//
// THE ACCESS TOKEN
// - It lives only in the password input's DOM value (an uncontrolled input: no React state, no
//   query or mutation cache, no storage, no URL, no logging). The input has no `name`, so even a
//   native form submit could not put it in a URL, and the form posts nowhere by itself.
// - On submit it is read once, the input is cleared at once, and the value exists only inside the
//   one request (and its one re-send after the password prompt) until that request settles.
// - Responses are copied field by field (types.ts pick*); nothing reads a token from a response.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Dialog, Notice, TextField } from '../../../design/index.js';
import { ApiError, type HttpMethod, messageFor, useApi, useWithReauth } from '../../../shell/index.js';
import { INTEGRATION_ERROR_MESSAGES } from './messages.js';
import { AUTH_SCHEMES, type AuthScheme, type SparkConnection, type SparkOverview, type ValidateResult, pickConnection, pickOverview, pickValidate } from './types.js';
import { LIVE_CALLS_OFF, TOKEN_HINT, deploymentWords, lastResultWords, providerWords, resultWords } from './words.js';

export const SPARK_KEY = ['integrations', 'mls', 'spark'] as const;
const BASE = '/admin/integrations/mls/spark';

/** 16..4096 printable ASCII, no spaces (the API's rule, checked here so a typo is not a round trip) */
const TOKEN_RE = /^[\x21-\x7E]{16,4096}$/;

type Outcome<R> = { ok: true; data: R } | { ok: false; message: string };

/** One request at a time; REAUTH_REQUIRED opens the shell's password prompt and re-sends once. */
function useRequest() {
  const api = useApi();
  const withReauth = useWithReauth();
  const [pending, setPending] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async <R,>(what: string, method: Exclude<HttpMethod, 'GET'>, path: string, body: unknown): Promise<Outcome<R>> => {
      setPending(what);
      try {
        return { ok: true, data: await withReauth(() => api.request<R>(method, path, body)) };
      } catch (e) {
        return { ok: false, message: messageFor(e instanceof ApiError ? e : 'INTERNAL_ERROR', INTEGRATION_ERROR_MESSAGES) };
      } finally {
        if (mounted.current) setPending(null);
      }
    },
    [api, withReauth],
  );
  return { run, pending };
}

export default function SparkPage() {
  const api = useApi();
  const qc = useQueryClient();
  const req = useRequest();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<ValidateResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const q = useQuery<SparkOverview, ApiError>({ queryKey: SPARK_KEY, queryFn: async ({ signal }) => pickOverview(await api.get<unknown>(BASE, { signal })) });
  const d = q.data;

  const setConnection = (c: SparkConnection | null) => {
    if (c) qc.setQueryData<SparkOverview>(SPARK_KEY, (old) => (old ? { ...old, connection: c } : old));
    void qc.invalidateQueries({ queryKey: SPARK_KEY });
  };

  const save = async (body: { accessToken: string; keyLabel: string; authScheme: AuthScheme }): Promise<boolean> => {
    setError(null);
    setStatus(null);
    setChecked(null);
    const r = await req.run<unknown>('save', 'PUT', `${BASE}/credential`, body);
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    setConnection(pickConnection((r.data as { connection?: unknown } | null)?.connection));
    setStatus('Key saved. It is stored encrypted and is never shown again. Validate it to finish connecting.');
    return true;
  };

  const validate = async () => {
    setError(null);
    setStatus(null);
    setChecked(null);
    const r = await req.run<unknown>('validate', 'POST', `${BASE}/validate`, {});
    if (!r.ok) {
      setError(r.message);
      return;
    }
    const v = pickValidate(r.data);
    setChecked(v.result);
    setConnection(v.connection);
    if (!v.result) setError(messageFor('BAD_RESPONSE'));
  };

  const disconnect = async (id: string) => {
    setError(null);
    setStatus(null);
    setChecked(null);
    // closed first: the shell's password prompt may open next, and two dialogs must never trap focus at once
    setConfirming(false);
    const r = await req.run<unknown>('disconnect', 'POST', `/admin/integrations/connections/${encodeURIComponent(id)}/disconnect`, {});
    void qc.invalidateQueries({ queryKey: SPARK_KEY });
    if (!r.ok) setError(r.message);
    else setStatus('Disconnected. The saved Spark key was removed for good.');
  };

  return (
    <div className="flex w-full min-w-0 max-w-3xl flex-col gap-8">
      <p role="status" aria-live="polite" className="min-h-[1px] text-[15px] text-ok">
        {status ?? ''}
      </p>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, INTEGRATION_ERROR_MESSAGES)}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {d ? (
        <>
          <Section title="This deployment">
            <dl className="flex flex-col gap-2">
              <Fact label="Provider">{providerWords(d.provider)}</Fact>
            </dl>
            <Notice tone={d.liveCalls ? 'info' : 'warn'}>{deploymentWords(d)}</Notice>
          </Section>

          <Section title="Connection">
            {d.connection ? (
              <>
                <p className="text-[16px] text-ink">{d.connection.statusSentence}</p>
                <dl className="flex flex-col gap-2">
                  <Fact label="Key label">{d.connection.keyLabel ?? 'No key saved'}</Fact>
                  <Fact label="Last check">{lastResultWords(d.connection.lastResult)}</Fact>
                  {d.connection.connectedAt ? <Fact label="Connected since">{formatStamp(d.connection.connectedAt)}</Fact> : null}
                </dl>
              </>
            ) : (
              <p className="text-[16px] text-ink">No MLS connection is set up yet.</p>
            )}
            {checked ? <Notice tone={resultWords(checked).tone}>{resultWords(checked).text}</Notice> : null}
            {d.provider === 'spark' && d.connection ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" pending={req.pending === 'validate'} pendingLabel="Validating" disabled={req.pending !== null && req.pending !== 'validate'} onClick={() => void validate()}>
                  Validate
                </Button>
                <Button variant="quiet" disabled={req.pending !== null} onClick={() => setConfirming(true)}>
                  Disconnect
                </Button>
              </div>
            ) : null}
            {d.provider === 'spark' && d.connection && !d.liveCalls ? <p className="text-[14px] text-ink-muted">{LIVE_CALLS_OFF}, so Validate does not send anything to Spark.</p> : null}
          </Section>

          {d.provider === 'spark' ? (
            <KeyForm key={d.connection?.id ?? 'none'} replacing={d.connection?.credentialSaved === true} defaultScheme={d.authSchemeDefault} pending={req.pending === 'save'} busy={req.pending !== null} onSave={save} />
          ) : (
            <Section title="Spark key">
              <p className="text-[16px] text-ink">This deployment uses built-in test listings instead of Spark, so there is no key to enter here. Once the deployment is switched to Spark, this page asks for the key.</p>
            </Section>
          )}
        </>
      ) : null}
      {confirming && d?.connection ? (
        <Dialog
          title="Disconnect the MLS?"
          description="Spark listings stop updating in the CRM."
          onClose={() => setConfirming(false)}
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                Go back
              </Button>
              <Button variant="danger" pending={req.pending === 'disconnect'} pendingLabel="Disconnecting" onClick={() => void disconnect(d.connection!.id)}>
                Disconnect and remove the key
              </Button>
            </div>
          }
        >
          <p className="text-[16px] text-ink">The saved Spark key is removed for good. To connect again, paste a key on this page again.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function KeyForm({ replacing, defaultScheme, pending, busy, onSave }: { replacing: boolean; defaultScheme: AuthScheme; pending: boolean; busy: boolean; onSave(body: { accessToken: string; keyLabel: string; authScheme: AuthScheme }): Promise<boolean> }) {
  // the token is NOT state: it stays in the input's DOM value until submit
  const tokenRef = useRef<HTMLInputElement>(null);
  const [keyLabel, setKeyLabel] = useState('');
  const [scheme, setScheme] = useState<AuthScheme>(defaultScheme);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const schemeId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = tokenRef.current;
    if (!input || busy) return;
    const label = keyLabel.trim();
    const tokenOk = TOKEN_RE.test(input.value.trim());
    setTokenError(tokenOk ? null : 'Paste the whole access token: 16 to 4,096 characters, with no spaces.');
    setLabelError(label.length >= 1 && label.length <= 80 ? null : 'Give the key a label of up to 80 characters.');
    if (!tokenOk || label.length < 1 || label.length > 80) return;
    const accessToken = input.value.trim();
    // cleared before the request leaves, so the field is empty whatever the outcome
    input.value = '';
    const ok = await onSave({ accessToken, keyLabel: label, authScheme: scheme });
    if (tokenRef.current) tokenRef.current.value = '';
    if (ok) setKeyLabel('');
  };

  return (
    <Section title={replacing ? 'Replace the Spark key' : 'Save a Spark key'} description={replacing ? 'Saving a new key removes the old one at once. Validate the new key to connect again.' : 'The key is stored encrypted for this team and is never shown again after you save it.'}>
      <form className="flex flex-col gap-4" method="post" noValidate onSubmit={(e) => void submit(e)}>
        <TextField
          ref={tokenRef}
          label="Access token"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          hint={TOKEN_HINT}
          error={tokenError}
          defaultValue=""
          maxLength={4096}
          required
        />
        <TextField label="Key label" hint="A name to recognize this key by. It is not secret and is shown on this page." value={keyLabel} maxLength={80} onChange={(e) => setKeyLabel(e.target.value)} error={labelError} required />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={schemeId} className="text-[15px] font-medium text-ink">
            Auth scheme
          </label>
          <select id={schemeId} aria-describedby={`${schemeId}-hint`} className="min-h-tap w-full rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" value={scheme} onChange={(e) => setScheme(e.target.value === 'OAuth' ? 'OAuth' : 'Bearer')}>
            {AUTH_SCHEMES.map((s) => (
              <option key={s} value={s}>
                {s === defaultScheme ? `${s} (default)` : s}
              </option>
            ))}
          </select>
          <p id={`${schemeId}-hint`} className="text-[14px] text-ink-muted">
            {/* VERIFY with Spark which scheme the CRM's key takes (markers stay in comments; the Owner sees plain words) */}
            Not yet confirmed with Spark: their documentation shows both Bearer and OAuth. Keep the default unless Spark tells you otherwise.
          </p>
        </div>
        <div>
          <Button type="submit" pending={pending} pendingLabel="Saving" disabled={busy && !pending}>
            {replacing ? 'Replace key' : 'Save key'}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div>
        <h2 id={id} className="text-[20px] font-semibold text-ink">
          {title}
        </h2>
        {description ? <p className="text-[15px] text-ink-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="text-[15px] text-ink-muted sm:w-48 sm:shrink-0">{label}</dt>
      <dd className="text-[16px] text-ink">{children}</dd>
    </div>
  );
}

function formatStamp(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return 'Unknown';
  return t.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
