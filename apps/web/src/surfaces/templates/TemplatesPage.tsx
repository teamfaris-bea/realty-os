// The template library (parity module 64; R-PAR-23..R-PAR-26, Q-PAR-4) and the email signature.
//
// Team templates are shared wording: everyone reads them, the Owner and Admins write them. Your own
// templates are yours alone. A Team Lead (or anyone) copies a team template to change it. Edits are
// version-checked, so two people editing at once never overwrite each other silently. Merge fields are
// a closed list, shown as buttons that insert them; a fallback (`{{contact.first_name|there}}`) is the
// honest way to say what happens when a value is missing.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Button, Card, Dialog, EmptyState, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { MERGE_FIELD_HELP, TEMPLATES_KEY, TEMPLATE_ERROR_MESSAGES, type TemplateChannel, type TemplateView } from './api.js';

const CHANNEL_LABEL: Record<TemplateChannel, string> = { sms: 'Text', email: 'Email' };

export default function TemplatesPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { session } = useSession();
  const role = session?.tenant?.role;
  const canTeam = role === 'owner' || role === 'admin';
  const [editing, setEditing] = useState<TemplateView | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useQuery<{ templates: TemplateView[] }, ApiError>({ queryKey: [...TEMPLATES_KEY, 'all'], queryFn: ({ signal }) => api.get<{ templates: TemplateView[] }>('/templates', { signal }) });
  const refresh = () => void qc.invalidateQueries({ queryKey: [...TEMPLATES_KEY] });

  const act = async (t: TemplateView, verb: 'copy' | 'archive') => {
    try {
      await api.post(`/templates/${t.id}/${verb}`, {});
      setNotice(verb === 'copy' ? `Copied “${t.name}” to your templates.` : `Archived “${t.name}”.`);
      refresh();
    } catch (e) {
      setNotice(messageFor(e as ApiError, TEMPLATE_ERROR_MESSAGES));
    }
  };

  const all = list.data?.templates ?? [];
  const groups = [
    { key: 'team', title: 'Team templates', hint: canTeam ? 'Everyone on the team can use these. You can edit them.' : 'Everyone on the team can use these. Copy one to change it.', items: all.filter((t) => t.scope === 'team') },
    { key: 'mine', title: 'Your templates', hint: 'Only you see these.', items: all.filter((t) => t.scope === 'personal') },
  ];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 md:mx-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-[15px] text-ink-muted">Saved wording for texts and emails. Pick one from the composer with Templates.</p>
        <Button icon="checklist" onClick={() => setEditing('new')}>
          New template
        </Button>
      </div>
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {list.isPending ? <p className="text-[15px] text-ink-muted">Loading templates</p> : null}
      {list.isError ? <Notice tone="error">{messageFor(list.error, TEMPLATE_ERROR_MESSAGES)}</Notice> : null}
      {list.data && all.length === 0 ? <EmptyState icon="checklist" title="No templates yet">Write the messages you send most, once.</EmptyState> : null}
      {list.data && all.length > 0
        ? groups.map((g) => (
            <section key={g.key} aria-labelledby={`tpl-${g.key}`} className="flex flex-col gap-2">
              <h2 id={`tpl-${g.key}`} className="text-[19px] font-semibold text-ink">
                {g.title}
              </h2>
              <p className="text-[14px] text-ink-muted">{g.hint}</p>
              {g.items.length === 0 ? <p className="text-[15px] text-ink-muted">None yet.</p> : null}
              <ul className="flex flex-col gap-2">
                {g.items.map((t) => (
                  <li key={t.id}>
                    <Card as="div" className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <h3 className="text-[17px] font-semibold text-ink [overflow-wrap:anywhere]">{t.name}</h3>
                        <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[13px] text-ink-muted">{CHANNEL_LABEL[t.channel]}</span>
                        <span className="text-[13px] text-ink-muted">Version {t.version}</span>
                      </div>
                      {t.subject ? <p className="text-[15px] font-medium text-ink [overflow-wrap:anywhere]">{t.subject}</p> : null}
                      <p className="whitespace-pre-wrap text-[15px] text-ink [overflow-wrap:anywhere]">{t.body}</p>
                      <div className="flex flex-wrap gap-2">
                        {t.editable ? (
                          <Button variant="secondary" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                            Edit
                          </Button>
                        ) : null}
                        {t.scope === 'team' ? (
                          <Button variant="secondary" onClick={() => void act(t, 'copy')} aria-label={`Copy to mine: ${t.name}`}>
                            Copy to mine
                          </Button>
                        ) : null}
                        {t.editable ? (
                          <Button variant="quiet" onClick={() => void act(t, 'archive')} aria-label={`Archive ${t.name}`}>
                            Archive
                          </Button>
                        ) : null}
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          ))
        : null}
      <SignatureCard />
      {editing ? <TemplateEditor template={editing === 'new' ? null : editing} canTeam={canTeam} onClose={() => setEditing(null)} onSaved={(name) => { setEditing(null); setNotice(`Saved “${name}”.`); refresh(); }} /> : null}
    </div>
  );
}

function TemplateEditor({ template, canTeam, onClose, onSaved }: { template: TemplateView | null; canTeam: boolean; onClose(): void; onSaved(name: string): void }) {
  const api = useApi();
  const id = useId();
  const body = useRef<HTMLTextAreaElement>(null);
  const [scope, setScope] = useState<'team' | 'personal'>(template?.scope ?? 'personal');
  const [channel, setChannel] = useState<TemplateChannel>(template?.channel ?? 'sms');
  const [name, setName] = useState(template?.name ?? '');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [text, setText] = useState(template?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const insert = (field: string) => {
    const el = body.current;
    const token = `{{${field}}}`;
    const at = el?.selectionStart ?? text.length;
    const next = text.slice(0, at) + token + text.slice(el?.selectionEnd ?? at);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (template) await api.request('PATCH', `/templates/${template.id}`, { version: template.version, name, body: text, ...(template.channel === 'email' ? { subject } : {}) });
      else await api.post('/templates', { scope, channel, name, body: text, ...(channel === 'email' ? { subject } : { subject: null }) });
      onSaved(name.trim());
    } catch (err) {
      setError(messageFor(err as ApiError, TEMPLATE_ERROR_MESSAGES));
    } finally {
      setPending(false);
    }
  };

  const limit = channel === 'sms' ? 1600 : 20000;
  return (
    <Dialog
      title={template ? `Edit ${template.name}` : 'New template'}
      onClose={onClose}
      dismissible={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} pending={pending} pendingLabel="Saving">
            Save
          </Button>
        </div>
      }
    >
      <form id={`${id}-form`} className="flex flex-col gap-3" onSubmit={(e) => void save(e)}>
        {!template ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="text-[15px] font-medium text-ink">Kind</legend>
            <div className="flex gap-1 self-start rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Channel">
              {(['sms', 'email'] as const).map((c) => (
                <button key={c} type="button" role="radio" aria-checked={channel === c} onClick={() => setChannel(c)} className={`min-h-tap rounded-lg px-3 text-[15px] font-medium ${channel === c ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted'}`}>
                  {CHANNEL_LABEL[c]}
                </button>
              ))}
            </div>
            {canTeam ? (
              <div className="mt-1 flex gap-1 self-start rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Who can use it">
                {(['personal', 'team'] as const).map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={scope === s} onClick={() => setScope(s)} className={`min-h-tap rounded-lg px-3 text-[15px] font-medium ${scope === s ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted'}`}>
                    {s === 'personal' ? 'Just me' : 'Whole team'}
                  </button>
                ))}
              </div>
            ) : null}
          </fieldset>
        ) : null}
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        {channel === 'email' ? <TextField label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /> : null}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-body`} className="text-[15px] font-medium text-ink">
            Message
          </label>
          <textarea ref={body} id={`${id}-body`} value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={limit} aria-describedby={`${id}-hint`} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink" />
          <p id={`${id}-hint`} className="text-[14px] text-ink-muted">
            {text.length} of {limit.toLocaleString()} characters. Add a fallback after a bar for people without a value: {'{{contact.first_name|there}}'}.
            {channel === 'email' ? ' Your signature and the brokerage footer are added when it is sent.' : ''}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-[15px] font-medium text-ink">Insert a merge field</p>
          <div className="flex flex-wrap gap-1.5">
            {MERGE_FIELD_HELP.map((m) => (
              <button key={m.field} type="button" onClick={() => insert(m.field)} className="min-h-tap rounded-lg border border-line bg-surface px-3 text-[15px] text-ink active:bg-surface-2">
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}

function SignatureCard() {
  const api = useApi();
  const qc = useQueryClient();
  const id = useId();
  const sig = useQuery<{ signature: string | null }, ApiError>({ queryKey: ['email-signature'], queryFn: ({ signal }) => api.get<{ signature: string | null }>('/email-signature', { signal }) });
  const [draft, setDraft] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const value = draft ?? sig.data?.signature ?? '';
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api.request<{ signature: string | null }>('PUT', '/email-signature', { signature: value.trim() ? value : null });
      qc.setQueryData(['email-signature'], r);
      setDraft(null);
      setMsg({ tone: 'ok', text: r.signature ? 'Signature saved. It is added to your emails, above the brokerage footer.' : 'Signature removed.' });
    } catch (err) {
      setMsg({ tone: 'error', text: messageFor(err as ApiError, TEMPLATE_ERROR_MESSAGES) });
    }
  };
  return (
    <Card aria-labelledby={`${id}-h`}>
      <form className="flex flex-col gap-2" onSubmit={(e) => void save(e)}>
        <h2 id={`${id}-h`} className="text-[19px] font-semibold text-ink">
          Email signature
        </h2>
        <label htmlFor={`${id}-sig`} className="text-[15px] text-ink-muted">
          Plain text, added to every email you send.
        </label>
        <textarea id={`${id}-sig`} value={value} onChange={(e) => setDraft(e.target.value)} rows={3} maxLength={1000} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink" />
        {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
        <Button type="submit" variant="secondary" className="self-start" disabled={draft === null}>
          Save signature
        </Button>
      </form>
    </Card>
  );
}
