// Milestone templates (module 41, the transactions part; R-TXN-6, R-AUDIT-5). Owner/Admin only (the server authorizes
// every call: milestone_template.manage). Desktop-first; it works on a phone.
//
// Templates are the tenant's own data, per side and jurisdiction: nothing ships with the product, so no state's
// contract defaults are built in. Each template shows "Not reviewed by counsel" until an Owner or Admin states that
// counsel reviewed it (the statement is saved with the list and audited; VERIFY WITH COUNSEL what counts as
// reviewed). Invalid entries are listed by their position in the list. Editing a template moves no date that was
// already proposed or confirmed.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, Notice } from '../../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../../shell/index.js';
import { useAction, useAnnounce } from '../lib/hooks.js';
import { ADMIN_MESSAGES } from '../lib/messages.js';
import { Check, CounselBanner, ErrorLine, Loading, Pill, Section, StatusLine, TextArea } from '../lib/ui.js';
import { SIDE_LABEL, type TemplatesResponse, parseEditor, setReviewed } from './lib.js';

const KEY = ['admin', 'milestone-templates'] as const;

export default function MilestoneTemplatesPage() {
  const api = useApi();
  const [status, announce] = useAnnounce();
  const q = useQuery<TemplatesResponse, ApiError>({ queryKey: KEY, queryFn: ({ signal }) => api.get('/transactions/milestone-templates', { signal }) });
  const put = useAction<{ templates: unknown[] }, TemplatesResponse>('PUT', { invalidate: [[...KEY]] });
  const [text, setText] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data && text === null) setText(JSON.stringify(q.data.templates, null, 2));
  }, [q.data, text]);
  if (q.isPending) return <Loading />;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice>;
  const data = q.data;
  const editor = text ?? '[]';
  const serverInvalid = put.error?.code === 'MILESTONE_TEMPLATES_INVALID' ? ((put.error.details?.['invalid'] as { index: number; error: string }[] | undefined) ?? []) : [];
  const save = async () => {
    setLocalError(null);
    const p = parseEditor(editor);
    if (!p.ok) {
      setLocalError(p.error);
      return;
    }
    const r = await put.run('/transactions/milestone-templates', { templates: p.templates });
    if (r.ok) {
      setText(JSON.stringify(r.data.templates, null, 2));
      announce('Templates saved.');
    }
  };
  return (
    <div className="flex w-full flex-col gap-8">
      <StatusLine text={status} />
      <CounselBanner reviewed={false}>
        Business days are counted Monday to Friday and holidays are not counted. A date that lands on a weekend is shown with a note and never moved. Check each template against your contract forms.
      </CounselBanner>
      <Section title="Templates" description={`Offered for a deal's side and the jurisdictions you operate in (${data.jurisdictions.join(', ')}). Nothing is built in: each template here is your own.`}>
        {data.parsed.length === 0 ? <p className="text-[15px] text-ink-muted">No templates yet. Deals can still get dates one by one.</p> : null}
        <ul className="flex flex-col gap-3">
          {data.parsed.map((t) => {
            const key = `${t.id}@${t.version}`;
            return (
              <li key={key} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[16px] font-medium text-ink">{t.name}</span>
                  <Pill>{`${t.id} v${t.version}`}</Pill>
                  <Pill>{SIDE_LABEL[t.side] ?? t.side}</Pill>
                  <Pill>{t.jurisdiction}</Pill>
                  <span className="text-[14px] text-ink-muted">{t.rules === 1 ? '1 date' : `${t.rules} dates`}</span>
                </div>
                {t.reviewed ? <Notice tone="ok">An Owner or Admin stated that counsel reviewed this template.</Notice> : <Notice tone="warn" title="Not reviewed by counsel">Every date it proposes says so until counsel reviews it.</Notice>}
                <Check
                  label="Counsel reviewed this template (your statement)"
                  hint="Saved with the list below and recorded in the audit log."
                  checked={(() => {
                    const p = parseEditor(editor);
                    if (!p.ok) return t.reviewed;
                    const e = p.templates.find((x) => typeof x === 'object' && x !== null && `${String((x as { id?: unknown }).id)}@${String((x as { version?: unknown }).version)}` === key) as { reviewed?: unknown } | undefined;
                    return e?.reviewed === true;
                  })()}
                  onChange={(v) => {
                    const next = setReviewed(editor, key, v);
                    if (next !== null) setText(next);
                    else setLocalError('Fix the list below first: it is not valid JSON.');
                  }}
                />
              </li>
            );
          })}
        </ul>
        {data.invalid.length > 0 ? (
          <Notice tone="error" title="Stored templates with errors">
            <ul>
              {data.invalid.map((i) => (
                <li key={i.index}>{i.index < 0 ? i.error : `Entry ${i.index + 1}: ${i.error}`}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
      </Section>
      <Section title="Edit the list" description="One object per template: id, version, name, side (buy, sell, dual, lease), jurisdiction, reviewed, and rules (key, kind, offsetDays, dayCount calendar or business, optional responsible, label and reminderDaysBefore).">
        <TextArea label="Templates (JSON)" value={editor} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={18} className="font-mono" />
        <ErrorLine message={localError} />
        {serverInvalid.length > 0 ? (
          <Notice tone="error" title="These entries were not saved">
            <ul>
              {serverInvalid.map((i) => (
                <li key={`${i.index}-${i.error}`}>{`Entry ${i.index + 1}: ${i.error}`}</li>
              ))}
            </ul>
          </Notice>
        ) : put.error ? (
          <ErrorLine message={put.error.message} />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button pending={put.pending} onClick={() => void save()}>
            Save templates
          </Button>
          <Button variant="quiet" onClick={() => setText(JSON.stringify(data.templates, null, 2))}>
            Discard changes
          </Button>
        </div>
      </Section>
    </div>
  );
}
