// Website chat (module 41, web/admin-p2): Owner/Admin create chat widgets for a lead source, see them, rotate a
// widget's key, choose the websites it may run on, copy the embed code, and disconnect a widget.
//
//   GET  /admin/web-chat/widgets                          the widgets (never a key)
//   GET  /lead-sources                                    the lead sources a widget can feed
//   POST /admin/web-chat/widgets                          create (re-auth); the key comes back ONCE
//   POST /admin/web-chat/widgets/:id/rotate               a new key (re-auth), ONCE; the old embed stops at once
//   PUT  /admin/web-chat/widgets/:id/origins              allowed websites (re-auth)
//   GET  /admin/web-chat/widgets/:id/embed                brokerage name + disclosure for the embed code
//   POST /admin/integrations/connections/:id/disconnect   disconnect (re-auth; the integrations route)
//
// THE WIDGET KEY is shown once: only the one-time panel's component state holds it (never the query cache,
// storage, the URL or a log). "Done" or leaving the page drops it; nothing can show it again (the server keeps
// only its hash), so the page says to rotate the key to get new embed code.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Button, ButtonLink, Card, Dialog, Notice, TextField } from '../../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../../shell/index.js';
import { useRequest } from '../integrations/request.js';
import { Pill, SelectField, StatusLine, TextArea } from '../lib/ui.js';
import { type Embed, type LeadSource, type Widget, pickEmbed, pickKeyed, pickSources, pickWidgets } from './types.js';
import { ERROR_MESSAGES, STATUS_LABEL, embedSnippet, isLive, parseWebsites, websitesWords } from './words.js';

export const WIDGETS_KEY = ['admin', 'web-chat', 'widgets'] as const;
const SOURCES_KEY = ['admin', 'web-chat', 'lead-sources'] as const;

interface Fresh {
  widget: Widget;
  key: string;
  why: 'created' | 'rotated';
}

type Confirm = { kind: 'rotate' | 'disconnect'; widget: Widget };

export default function WebChatPage() {
  const api = useApi();
  const qc = useQueryClient();
  const req = useRequest(ERROR_MESSAGES);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const widgets = useQuery<Widget[], ApiError>({ queryKey: WIDGETS_KEY, queryFn: async ({ signal }) => pickWidgets(await api.get<unknown>('/admin/web-chat/widgets', { signal })) });
  const sources = useQuery<LeadSource[], ApiError>({ queryKey: SOURCES_KEY, queryFn: async ({ signal }) => pickSources(await api.get<unknown>('/lead-sources', { signal })) });
  const refresh = () => void qc.invalidateQueries({ queryKey: WIDGETS_KEY });
  const clear = () => {
    setStatus(null);
    setError(null);
  };

  const create = async (body: { displayName: string; leadSourceId: string; allowedOrigins: string[] }): Promise<boolean> => {
    clear();
    setFresh(null);
    const r = await req.run<unknown>('create', 'POST', '/admin/web-chat/widgets', body);
    refresh();
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    const k = pickKeyed(r.data);
    if (!k.key) {
      setError(messageFor('BAD_RESPONSE'));
      return true;
    }
    setFresh({ widget: k.widget, key: k.key, why: 'created' });
    return true;
  };

  const rotate = async (w: Widget) => {
    clear();
    setFresh(null);
    // closed first: the shell's password prompt may open next, and two dialogs must never trap focus at once
    setConfirm(null);
    setStatus(`Making a new key for ${w.displayName}`);
    const r = await req.run<unknown>('rotate', 'POST', `/admin/web-chat/widgets/${encodeURIComponent(w.id)}/rotate`);
    setStatus(null);
    refresh();
    if (!r.ok) return setError(r.message);
    const k = pickKeyed(r.data);
    if (!k.key) return setError(messageFor('BAD_RESPONSE'));
    setFresh({ widget: k.widget, key: k.key, why: 'rotated' });
  };

  const disconnect = async (w: Widget) => {
    clear();
    setConfirm(null);
    setStatus(`Disconnecting ${w.displayName}`);
    const r = await req.run('disconnect', 'POST', `/admin/integrations/connections/${encodeURIComponent(w.id)}/disconnect`);
    setStatus(null);
    refresh();
    if (fresh?.widget.id === w.id) setFresh(null);
    if (r.ok) setStatus(`${w.displayName} is disconnected. The chat window on your website now says chat is unavailable.`);
    else setError(r.message);
  };

  const saveWebsites = async (w: Widget, origins: string[]): Promise<boolean> => {
    clear();
    const r = await req.run('origins', 'PUT', `/admin/web-chat/widgets/${encodeURIComponent(w.id)}/origins`, { allowedOrigins: origins });
    refresh();
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    setStatus(`Websites saved for ${w.displayName}.`);
    return true;
  };

  const activeSources = sources.data?.filter((s) => s.active) ?? [];
  const sourceName = (id: string | null) => sources.data?.find((s) => s.id === id)?.name ?? 'Unknown lead source';

  return (
    <div className="flex w-full min-w-0 max-w-3xl flex-col gap-8">
      <StatusLine text={status} />
      {error ? <Notice tone="error">{error}</Notice> : null}
      {fresh ? <KeyOnce fresh={fresh} onDone={() => setFresh(null)} /> : null}

      <Block title="Add a chat widget" description="A widget puts a chat window on your website. New chats become leads of the lead source you choose.">
        {sources.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
        {sources.isError ? <Notice tone="error">{messageFor(sources.error, ERROR_MESSAGES)}</Notice> : null}
        {sources.data && activeSources.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-[16px] text-ink">A widget needs a lead source, and there is no active one yet.</p>
            <div>
              <ButtonLink variant="secondary" to="/admin/routing">
                Add a lead source on Lead routing
              </ButtonLink>
            </div>
          </div>
        ) : null}
        {activeSources.length > 0 ? <CreateForm sources={activeSources} pending={req.pending === 'create'} busy={req.pending !== null} onCreate={create} /> : null}
      </Block>

      <Block title="Your widgets">
        {widgets.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
        {widgets.isError ? <Notice tone="error">{messageFor(widgets.error, ERROR_MESSAGES)}</Notice> : null}
        {widgets.data && widgets.data.length === 0 ? <p className="text-[16px] text-ink">No chat widgets yet.</p> : null}
        {widgets.data && widgets.data.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {widgets.data.map((w) => (
              <WidgetCard key={w.id} w={w} source={sourceName(w.leadSourceId)} busy={req.pending !== null} savingWebsites={req.pending === 'origins'} onRotate={() => setConfirm({ kind: 'rotate', widget: w })} onDisconnect={() => setConfirm({ kind: 'disconnect', widget: w })} onSaveWebsites={(o) => saveWebsites(w, o)} />
            ))}
          </ul>
        ) : null}
      </Block>

      {confirm?.kind === 'rotate' ? (
        <Dialog
          title={`Get a new key for ${confirm.widget.displayName}?`}
          description="The old key stops working at once."
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" onClick={() => setConfirm(null)}>
                Go back
              </Button>
              <Button pending={req.pending === 'rotate'} pendingLabel="Making a new key" onClick={() => void rotate(confirm.widget)}>
                Make a new key
              </Button>
            </div>
          }
        >
          <p className="text-[16px] text-ink">The chat window stops working on every website that has the old embed code until you replace it with the new code, which is shown once.</p>
        </Dialog>
      ) : null}
      {confirm?.kind === 'disconnect' ? (
        <Dialog
          title={`Disconnect ${confirm.widget.displayName}?`}
          description="The chat window on your website will say chat is unavailable."
          onClose={() => setConfirm(null)}
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" onClick={() => setConfirm(null)}>
                Go back
              </Button>
              <Button variant="danger" pending={req.pending === 'disconnect'} pendingLabel="Disconnecting" onClick={() => void disconnect(confirm.widget)}>
                Disconnect
              </Button>
            </div>
          }
        >
          <p className="text-[16px] text-ink">No reply goes out through it any more. Chat history and contacts stay. A disconnected widget cannot be turned back on; add a new one instead.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function CreateForm({ sources, pending, busy, onCreate }: { sources: LeadSource[]; pending: boolean; busy: boolean; onCreate(b: { displayName: string; leadSourceId: string; allowedOrigins: string[] }): Promise<boolean> }) {
  const [name, setName] = useState('Website chat');
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [websites, setWebsites] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    const sites = parseWebsites(websites);
    setNameError(n.length >= 1 && n.length <= 120 ? null : 'Give the widget a name of up to 120 characters.');
    setSiteError(sites.ok ? null : sites.message);
    if (!sites.ok || n.length < 1 || n.length > 120) return;
    const ok = await onCreate({ displayName: n, leadSourceId: sourceId || sources[0]!.id, allowedOrigins: sites.origins });
    if (ok) {
      setName('Website chat');
      setWebsites('');
    }
  };

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
      <TextField label="Widget name" hint="Only your team sees this name." value={name} maxLength={120} onChange={(e) => setName(e.target.value)} error={nameError} required />
      <SelectField label="Lead source" hint="Chats from this widget become leads of this source." value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </SelectField>
      <WebsitesBox value={websites} onChange={setWebsites} error={siteError} />
      <div>
        <Button type="submit" pending={pending} pendingLabel="Adding" disabled={busy && !pending}>
          Add widget
        </Button>
      </div>
    </form>
  );
}

function WebsitesBox({ value, onChange, error }: { value: string; onChange(v: string): void; error: string | null }) {
  return (
    <div className="flex flex-col gap-1.5">
      <TextArea
        label="Allowed websites"
        hint="One address per line, like https://www.example.com. Up to 10. Leave it empty to let the chat run on any website that has the embed code."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p role="alert" className="text-[14px] font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function WidgetCard({ w, source, busy, savingWebsites, onRotate, onDisconnect, onSaveWebsites }: { w: Widget; source: string; busy: boolean; savingWebsites: boolean; onRotate(): void; onDisconnect(): void; onSaveWebsites(o: string[]): Promise<boolean> }) {
  const hid = useId();
  const live = isLive(w.status);
  const s = STATUS_LABEL[w.status] ?? { label: 'State unknown', tone: 'warn' as const };
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [siteError, setSiteError] = useState<string | null>(null);

  const startEdit = () => {
    setText(w.allowedOrigins.join('\n'));
    setSiteError(null);
    setEditing(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const sites = parseWebsites(text);
    setSiteError(sites.ok ? null : sites.message);
    if (!sites.ok) return;
    if (await onSaveWebsites(sites.origins)) setEditing(false);
  };

  return (
    <Card as="li" aria-labelledby={hid} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={hid} className="text-[17px] font-semibold text-ink">
          {w.displayName}
        </h3>
        <Pill tone={s.tone}>{s.label}</Pill>
      </div>
      <p className="text-[15px] text-ink">{w.sentence}</p>
      <dl className="flex flex-col gap-2">
        <Fact label="Lead source">{source}</Fact>
        <Fact label="Allowed websites">{websitesWords(w.allowedOrigins)}</Fact>
        <Fact label="Embed code">{live ? 'Shown once, when the widget was added or its key last changed. To get it again, make a new key.' : 'None: the widget is disconnected.'}</Fact>
      </dl>
      {live && editing ? (
        <form className="flex flex-col gap-3" noValidate onSubmit={(e) => void save(e)}>
          <WebsitesBox value={text} onChange={setText} error={siteError} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={savingWebsites} pendingLabel="Saving" disabled={busy && !savingWebsites}>
              Save websites
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {live && !editing ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy} onClick={startEdit}>
            Change websites
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onRotate}>
            Make a new key
          </Button>
          <Button variant="quiet" disabled={busy} onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** The one-time panel: the key and the embed code, until "Done". */
function KeyOnce({ fresh, onDone }: { fresh: Fresh; onDone(): void }) {
  const api = useApi();
  const embed = useQuery<Embed, ApiError>({
    queryKey: ['admin', 'web-chat', 'embed', fresh.widget.id],
    queryFn: async ({ signal }) => pickEmbed(await api.get<unknown>(`/admin/web-chat/widgets/${encodeURIComponent(fresh.widget.id)}/embed`, { signal })),
  });
  const [copied, setCopied] = useState<string | null>(null);
  const keyId = useId();
  const snipId = useId();
  const e = embed.data;
  const snippet = e?.disclosure ? embedSnippet(window.location.origin, fresh.key, { ...e, disclosure: e.disclosure }) : null;

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`${what} copied.`);
    } catch {
      setCopied(`Couldn't copy automatically. Select the ${what.toLowerCase()} and copy it yourself.`);
    }
  };

  return (
    <section aria-labelledby={`${keyId}-h`} className="flex flex-col gap-3 rounded-2xl border-2 border-accent bg-surface p-4">
      <h2 id={`${keyId}-h`} className="text-[20px] font-semibold text-ink">
        {fresh.why === 'created' ? `${fresh.widget.displayName} is added` : `New key for ${fresh.widget.displayName}`}
      </h2>
      <Notice tone="warn" title="Shown only this once">
        Copy the embed code now and put it on your website. This key is not shown again; if you lose it, make a new key.
        {fresh.why === 'rotated' ? ' The old embed code has stopped working.' : ''}
      </Notice>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={keyId} className="text-[15px] font-medium text-ink">
          Widget key
        </label>
        <input id={keyId} readOnly value={fresh.key} autoComplete="off" spellCheck={false} className="min-h-tap w-full rounded-xl border border-line bg-surface-2 px-3.5 font-mono text-[15px] text-ink" onFocus={(ev) => ev.currentTarget.select()} />
      </div>
      {embed.isPending ? <p className="text-[15px] text-ink-muted">Loading the embed code</p> : null}
      {embed.isError ? <Notice tone="error">{`${messageFor(embed.error, ERROR_MESSAGES)} The key above works, but the embed code could not be built. Copy the key, or make a new key to try again.`}</Notice> : null}
      {e && !e.disclosure ? (
        <Notice tone="warn" title="The chat window won't appear yet">
          This widget's lead source has no consent disclosure, and the chat window never opens without one. Use a lead source that has a consent disclosure (set when the lead source is created on Lead routing), then add a widget for it.
        </Notice>
      ) : null}
      {snippet ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={snipId} className="text-[15px] font-medium text-ink">
            Embed code
          </label>
          <textarea id={snipId} aria-describedby={`${snipId}-hint`} readOnly value={snippet} rows={5} spellCheck={false} className="w-full rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 font-mono text-[14px] text-ink" onFocus={(ev) => ev.currentTarget.select()} />
          <p id={`${snipId}-hint`} className="text-[14px] text-ink-muted">
            Paste it just before the closing body tag of each page that should show the chat. It shows your brokerage name and your consent disclosure before the first message.
          </p>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="min-h-[1px] text-[15px] text-ok">
        {copied ?? ''}
      </p>
      <div className="flex flex-wrap gap-2">
        {snippet ? <Button onClick={() => void copy('Embed code', snippet)}>Copy embed code</Button> : null}
        <Button variant="secondary" onClick={() => void copy('Key', fresh.key)}>
          Copy key
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Done, hide the key
        </Button>
      </div>
    </section>
  );
}

function Block({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
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
      <dt className="text-[15px] text-ink-muted sm:w-40 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-words text-[16px] text-ink">{children}</dd>
    </div>
  );
}
