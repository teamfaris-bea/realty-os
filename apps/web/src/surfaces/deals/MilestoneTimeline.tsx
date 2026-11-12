// The deal page's milestone timeline (module 39; R-TXN-1..6, R-ACC-6). Phone-first: one screen holds the acceptance
// date, the template, the proposed list with a Confirm chip per date (1 tap), each date's rule, non-business-day note
// and "not reviewed by counsel" where true, each recipient's update status, each date's risk status, and the Team
// Lead queue's risk cards for callers who may read them. It replaces Phase 1's "Contract dates" and keeps its Done.
// Nothing here decides a date: the server plans, confirms and computes; the screen shows what it stored.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Button, Card, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { formatDateTime, formatLocalDate } from '../feed/lib/format.js';
import { useMutate } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import { type DealMilestones, type MilestoneDate, MILESTONE_ERROR_MESSAGES, RESPONSIBLE_LABEL, ROLE_LABEL, reviewWarnings, statusLabel, timelineOrder, updatesLine } from './milestones.js';

const MESSAGES = { ...AGENT_ERROR_MESSAGES, ...MILESTONE_ERROR_MESSAGES };

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h2>
      {children}
    </Card>
  );
}

const UPDATE_TONE: Record<string, string> = {
  sent: 'text-ok',
  blocked: 'text-danger',
  failed: 'text-danger',
  drafted: 'text-warn',
  skipped: 'text-ink-muted',
  not_planned: 'text-ink-muted',
  scheduled: 'text-ink',
  waiting: 'text-ink',
};

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function MilestoneTimeline({ dealId }: { dealId: string }) {
  const api = useApi();
  const key = ['deal', dealId, 'milestones'];
  const q = useQuery<DealMilestones, ApiError>({ queryKey: key, queryFn: ({ signal }) => api.get<DealMilestones>(`/deals/${dealId}/milestones`, { signal }) });
  const invalidate = [key, ['deal', dealId], ['feed'], ['transactions', 'board']];
  const plan = useMutate<{ acceptanceDate: string; templateId: string; templateVersion: number }>('POST', { invalidate });
  const confirm = useMutate<Record<string, never>>('POST', { invalidate });
  const done = useMutate<{ completed: boolean }>('PATCH', { invalidate });
  const [acceptance, setAcceptance] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  if (q.isPending) return <Section title="Milestones"><p className="text-[15px] text-ink-muted">Loading</p></Section>;
  if (q.isError) return <Section title="Milestones"><Notice tone="error">{messageFor(q.error, MESSAGES)}</Notice></Section>;
  const m = q.data;
  const chosen = m.templates.find((t) => `${t.id}@${t.version}` === templateKey) ?? m.templates[0] ?? null;
  const accDate = acceptance ?? m.acceptanceDate ?? todayLocal();
  const proposed = m.dates.filter((d) => d.status === 'proposed' && !d.completedAt);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (chosen && accDate) void plan.run(`/deals/${dealId}/milestones/plan`, { acceptanceDate: accDate, templateId: chosen.id, templateVersion: chosen.version });
  };
  return (
    <Section title="Milestones">
      <p className="text-[15px] text-ink-muted">{updatesLine(m.updates)}</p>
      {m.templates.length === 0 ? (
        <p className="text-[15px] text-ink-muted">No milestone templates for this deal yet. An Owner or Admin adds them under Milestone templates; you can still enter dates one by one.</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-2" aria-label="Propose dates from a template">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
              Acceptance date
              <input type="date" required value={accDate} onChange={(e) => setAcceptance(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
            </label>
            {m.templates.length > 1 ? (
              <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
                Template
                <select value={chosen ? `${chosen.id}@${chosen.version}` : ''} onChange={(e) => setTemplateKey(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink">
                  {m.templates.map((t) => (
                    <option key={`${t.id}@${t.version}`} value={`${t.id}@${t.version}`}>
                      {t.name} (v{t.version})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button type="submit" pending={plan.pending} disabled={!chosen}>
              {proposed.length > 0 ? 'Update proposed dates' : 'Propose dates'}
            </Button>
          </div>
          {m.templates.length === 1 && chosen ? <p className="text-[14px] text-ink-muted">Template: {chosen.name} (v{chosen.version})</p> : null}
          {reviewWarnings(m, chosen?.id ?? null).map((w) => (
            <Notice key={w} tone="warn">
              {w}
            </Notice>
          ))}
          {plan.error ? <Notice tone="error">{MESSAGES[plan.error.code] ?? plan.error.message}</Notice> : null}
          <p className="text-[14px] text-ink-muted">Proposed dates drive nothing until a person confirms them. The acceptance date is kept with each proposal, not as a date of its own.</p>
        </form>
      )}

      {m.riskItems.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="In the Team Lead queue">
          {m.riskItems.map((r) => (
            <li key={r.id}>
              <Notice tone="warn" title="In the Team Lead queue">
                {r.text}
                {r.conditionCleared ? ' (no longer at risk; waiting to be handled)' : ''}
              </Notice>
            </li>
          ))}
        </ul>
      ) : null}

      {m.dates.length === 0 ? <p className="text-[15px] text-ink-muted">No dates yet.</p> : null}
      <ol className="flex flex-col gap-3" aria-label="Dates">
        {timelineOrder(m.dates).map((d) => (
          <DateRow
            key={d.id}
            d={d}
            confirming={confirm.pending}
            completing={done.pending}
            onConfirm={() => void confirm.run(`/deal-dates/${d.id}/confirm`, {})}
            onDone={() => void done.run(`/deal-dates/${d.id}`, { completed: true })}
          />
        ))}
      </ol>
      {confirm.error ? <Notice tone="error">{MESSAGES[confirm.error.code] ?? confirm.error.message}</Notice> : null}
      {done.error ? <Notice tone="error">{MESSAGES[done.error.code] ?? done.error.message}</Notice> : null}
    </Section>
  );
}

function DateRow({ d, confirming, completing, onConfirm, onDone }: { d: MilestoneDate; confirming: boolean; completing: boolean; onConfirm: () => void; onDone: () => void }) {
  const chip = statusLabel(d);
  const headId = useId();
  return (
    <li aria-labelledby={headId} className="flex flex-col gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex min-h-tap flex-wrap items-center gap-2">
        <span id={headId} className="flex-1 text-[16px] font-medium text-ink">
          {d.label} · {formatLocalDate(d.dueOn)}
        </span>
        <span className={`rounded-lg px-2 py-0.5 text-[13px] ${d.status === 'proposed' ? 'bg-warn-soft text-ink' : d.completedAt ? 'bg-ok-soft text-ink' : 'bg-surface-2 text-ink-muted'}`}>{chip}</span>
        {d.status === 'proposed' && !d.completedAt ? (
          <Button variant="primary" disabled={confirming} onClick={onConfirm} aria-label={`Confirm ${d.label} on ${formatLocalDate(d.dueOn)}`}>
            Confirm
          </Button>
        ) : null}
        {d.status === 'confirmed' && !d.completedAt ? (
          <Button variant="secondary" disabled={completing} onClick={onDone} aria-label={`Mark ${d.label} done`}>
            Done
          </Button>
        ) : null}
      </div>
      {d.risk ? (
        <p className="text-[15px] font-medium text-danger">
          {d.risk.text}
        </p>
      ) : null}
      {d.responsible ? <p className="text-[14px] text-ink-muted">Responsible: {RESPONSIBLE_LABEL[d.responsible] ?? d.responsible}</p> : null}
      {d.basis.rule ? <p className="text-[14px] text-ink-muted">Rule: {d.basis.rule}</p> : null}
      {d.basis.nonBusinessDayNote ? <p className="text-[14px] text-warn">{d.basis.nonBusinessDayNote}</p> : null}
      {d.basis.templateReviewed === false ? <p className="text-[14px] text-ink-muted">Template not reviewed by counsel.</p> : null}
      {d.basis.calendarNote ? <p className="text-[14px] text-ink-muted">{d.basis.calendarNote}</p> : null}
      {d.status === 'confirmed' && d.reminderAt ? <p className="text-[14px] text-ink-muted">Reminder: {formatDateTime(d.reminderAt, d.basis.zone)}</p> : null}
      {d.status === 'confirmed' && d.updates.length > 0 ? (
        <ul className="flex flex-col gap-0.5" aria-label={`Updates for ${d.label}`}>
          {d.updates.map((u) => (
            <li key={u.contactId} className="text-[14px]">
              <span className="text-ink">{u.name ?? 'Contact'}</span>
              <span className="text-ink-muted"> ({u.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}): </span>
              <span className={UPDATE_TONE[u.status] ?? 'text-ink'}>{u.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
