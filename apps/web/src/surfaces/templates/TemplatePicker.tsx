// The template picker (parity module 64; R-PAR-24, R-PAR-25). Exported for ComposeBox's one optional prop
// (module 37): it inserts TEXT only. It never sends: the agent still taps Send, and the send-time check
// decides as for any message.
//
// Tap path from the composer (PARITY_PLAN §5): Templates → a template → Send = 3. The sheet lists the
// channel's templates (team first, then the agent's own); typing filters, Enter picks the first match
// (desktop: Templates → type → ↵ → Send). The template is rendered for THIS person by the server under
// the agent's own access, so the text that lands in the box already has their name in it. A field the
// person has no value for is named before the agent sends ("Needs their first name"), never "Hi ,".
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { type RenderedView, TEMPLATES_KEY, TEMPLATE_ERROR_MESSAGES, type TemplateChannel, type TemplateView, fieldWords } from './api.js';

export interface InsertedTemplate {
  channel: TemplateChannel;
  subject: string | null;
  body: string;
  templateId: string;
}

export interface TemplatePickerProps {
  contactId: string;
  channel: TemplateChannel;
  /** puts the rendered text into the composer (replacing what is there) */
  onInsert(t: InsertedTemplate): void;
}

export function TemplatePicker({ contactId, channel, onInsert }: TemplatePickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" icon="checklist" onClick={() => setOpen(true)} aria-haspopup="dialog">
        Templates
      </Button>
      {open ? <TemplateSheet contactId={contactId} channel={channel} onClose={() => setOpen(false)} onInsert={(t) => { onInsert(t); setOpen(false); }} /> : null}
    </>
  );
}

function TemplateSheet({ contactId, channel, onClose, onInsert }: TemplatePickerProps & { onClose(): void }) {
  const api = useApi();
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const list = useQuery<{ templates: TemplateView[] }, ApiError>({
    queryKey: [...TEMPLATES_KEY, channel],
    queryFn: ({ signal }) => api.get<{ templates: TemplateView[] }>(`/templates?channel=${channel}`, { signal }),
    staleTime: 30_000,
  });
  const shown = useMemo(() => {
    const all = list.data?.templates ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((t) => t.name.toLowerCase().includes(needle)) : all;
  }, [list.data, q]);

  const pick = async (t: TemplateView) => {
    setProblem(null);
    setBusy(t.id);
    try {
      const r = await api.post<{ rendered: RenderedView }>(`/templates/${t.id}/render`, { contactId });
      const v = r.rendered;
      if (v.missing.length > 0) {
        setProblem(`${t.name} needs ${v.missing.map(fieldWords).join(', ')}, which this person doesn't have. Add a fallback in the template, or write the message yourself.`);
        return;
      }
      onInsert({ channel: v.channel, subject: v.subject, body: v.body, templateId: v.templateId });
    } catch (e) {
      setProblem(messageFor(e as ApiError, TEMPLATE_ERROR_MESSAGES));
    } finally {
      setBusy(null);
    }
  };

  const team = shown.filter((t) => t.scope === 'team');
  const mine = shown.filter((t) => t.scope === 'personal');
  return (
    <Dialog title={channel === 'sms' ? 'Text templates' : 'Email templates'} onClose={onClose} initialFocus={search} description="Pick one to put it in your message. You still tap Send.">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const first = shown[0];
          if (first) void pick(first);
        }}
      >
        <label htmlFor={`${id}-q`} className="text-[15px] font-medium text-ink">
          Find a template
        </label>
        <input ref={search} id={`${id}-q`} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" enterKeyHint="go" className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
      </form>
      {problem ? <Notice tone="warn">{problem}</Notice> : null}
      {list.isPending ? <p className="py-3 text-[15px] text-ink-muted">Loading templates</p> : null}
      {list.isError ? <Notice tone="error">{messageFor(list.error, TEMPLATE_ERROR_MESSAGES)}</Notice> : null}
      {list.data && shown.length === 0 ? (
        <p className="py-3 text-[15px] text-ink-muted">{q ? 'No template matches.' : 'No templates yet. Add them under Templates in the menu.'}</p>
      ) : null}
      {[
        { label: 'Team templates', items: team },
        { label: 'Your templates', items: mine },
      ].map((g) =>
        g.items.length > 0 ? (
          <section key={g.label} aria-label={g.label} className="mt-1 flex flex-col gap-1">
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">{g.label}</h3>
            <ul className="flex flex-col gap-1">
              {g.items.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => void pick(t)}
                    disabled={busy !== null}
                    aria-busy={busy === t.id}
                    className="flex min-h-tap w-full flex-col items-start rounded-xl border border-line bg-surface px-3.5 py-2 text-left active:bg-surface-2 disabled:opacity-60"
                  >
                    <span className="text-[17px] font-medium text-ink">{t.name}</span>
                    <span className="line-clamp-2 text-[14px] text-ink-muted [overflow-wrap:anywhere]">{t.subject ? `${t.subject} · ` : ''}{t.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </Dialog>
  );
}
