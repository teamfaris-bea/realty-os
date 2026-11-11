// The System page (lane ops-observability): what is stuck or failing behind the scenes, in plain
// words, for the Owner and Admin. Reads GET /system/overview; Retry and Cancel on a job ask first.
//
// - Jobs that need attention: dead and retrying background jobs, the plain reason, tries "3 of 10",
//   when it stopped / tries next, a collapsed technical detail for support, Retry / Cancel.
// - Messages stuck while sending: channel, status and age only. The API never sends bodies, addresses
//   or names, and this page never asks for them; the conversation link opens the thread the role can
//   already see.
// - Timers that fired late in the window, with the denominator ("2 of 40 timers ...").
// - Provider health: last-hour send results per channel, texting registrations, integrations.
// The page says when the data was read; it does not claim to update by itself.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ButtonLink, Card, Dialog, Notice, Ratio } from '../../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../../shell/index.js';
import { registrationWords } from '../NumbersPage.js';
import { formatAge, formatDuration, formatStamp, plural } from '../lib/format.js';
import { useAction, useAnnounce } from '../lib/hooks.js';
import { ADMIN_MESSAGES } from '../lib/messages.js';
import { ErrorLine, Loading, Pill, Section, StatusLine } from '../lib/ui.js';
import type { JobCommandResponse, JobView, StuckMessage, SystemOverview } from './types.js';
import { channelWords, connectionKindWords, connectionStatusWords, registrationKindWords, stuckStatusWords, summaryWords } from './words.js';

export const SYSTEM_KEY = ['admin', 'system', 'overview'] as const;

type Pending = { job: JobView; action: 'retry' | 'cancel' } | null;

export default function SystemPage() {
  const api = useApi();
  const [status, announce] = useAnnounce(8000);
  const [pending, setPending] = useState<Pending>(null);
  const q = useQuery<SystemOverview, ApiError>({ queryKey: SYSTEM_KEY, queryFn: ({ signal }) => api.get('/system/overview', { signal }) });
  const d = q.data;
  return (
    <div className="flex w-full min-w-0 flex-col gap-8">
      <StatusLine text={status} />
      {q.isPending ? <Loading /> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {d ? (
        <>
          <Summary overview={d} />
          <Jobs overview={d} onAsk={setPending} />
          <Messages messages={d.messages} />
          <Timers timers={d.timers} />
          <Health overview={d} />
        </>
      ) : null}
      {pending ? (
        <ConfirmJob
          key={`${pending.action}:${pending.job.id}`}
          job={pending.job}
          action={pending.action}
          onClose={() => setPending(null)}
          onDone={(text) => {
            setPending(null);
            announce(text);
          }}
        />
      ) : null}
    </div>
  );
}

function Summary({ overview }: { overview: SystemOverview }) {
  const s = summaryWords(overview);
  return (
    <div className="flex flex-col gap-1">
      <Notice tone={s.clear ? 'ok' : 'warn'}>{s.text}</Notice>
      <p className="text-[14px] text-ink-muted">Updated {formatStamp(overview.generatedAt)}. Reload the page to check again.</p>
    </div>
  );
}

// ---- jobs ------------------------------------------------------------------------------------------

function Jobs({ overview, onAsk }: { overview: SystemOverview; onAsk(p: Pending): void }) {
  const { counts, dead, retrying } = overview.jobs;
  const jobs = [...dead, ...retrying];
  const total = counts.dead + counts.retrying;
  return (
    <Section title="Jobs that need attention" description="Background work (sending, checking with providers, lead timers) that failed. Each one says why, in words.">
      {total === 0 ? <p className="text-[15px] text-ink">No background jobs have failed. Nothing is waiting to be retried.</p> : null}
      {jobs.length < total ? <p className="text-[14px] text-ink-muted">Showing {jobs.length} of {total} jobs, newest first.</p> : null}
      {jobs.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {jobs.map((j) => (
            <li key={j.id}>
              <JobCard job={j} onAsk={onAsk} />
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function JobCard({ job, onAsk }: { job: JobView; onAsk(p: Pending): void }) {
  const dead = job.state === 'dead';
  return (
    <Card as="article" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 basis-48 text-[17px] font-semibold text-ink">{job.kindLabel}</h3>
        <Pill tone={dead ? 'danger' : 'warn'}>{dead ? 'Stopped retrying' : 'Will try again'}</Pill>
      </div>
      <p className="text-[16px] text-ink">{job.reason.sentence}</p>
      {!job.reason.retryHelps ? <p className="text-[15px] text-ink-muted">A retry is unlikely to fix this on its own.</p> : null}
      <p className="text-[15px] text-ink-muted">
        Tries: <Ratio value={job.attempts} of={job.maxAttempts} label="allowed" />
        {job.finishedAt ? ` · Last failed ${formatStamp(job.finishedAt)}` : ''}
        {job.nextRunAt ? ` · Next try ${formatStamp(job.nextRunAt)}` : ''}
      </p>
      <details className="rounded-xl bg-surface-2 px-3">
        <summary className="flex min-h-tap cursor-pointer items-center text-[15px] font-medium text-ink">Technical detail</summary>
        <dl className="flex flex-col gap-1 pb-3 text-[14px] text-ink">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-muted">Reason code</dt>
            <dd className="break-all font-mono">{job.reason.code}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-muted">Error</dt>
            <dd className="min-w-0 break-all font-mono">{job.detail ?? 'None recorded'}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-muted">Job</dt>
            <dd className="break-all font-mono">
              {job.kind} #{job.id}
            </dd>
          </div>
        </dl>
      </details>
      {job.canRetry || job.canCancel ? (
        <div className="flex flex-wrap gap-2">
          {job.canRetry ? (
            <Button variant="secondary" onClick={() => onAsk({ job, action: 'retry' })}>
              Retry<span className="sr-only">: {job.kindLabel}</span>
            </Button>
          ) : null}
          {job.canCancel ? (
            <Button variant="quiet" onClick={() => onAsk({ job, action: 'cancel' })}>
              Cancel job<span className="sr-only">: {job.kindLabel}</span>
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function ConfirmJob({ job, action, onClose, onDone }: { job: JobView; action: 'retry' | 'cancel'; onClose(): void; onDone(text: string): void }) {
  const a = useAction<Record<string, never>, JobCommandResponse>('POST', { invalidate: [[...SYSTEM_KEY]] });
  const retry = action === 'retry';
  const go = async () => {
    const r = await a.run(`/system/jobs/${encodeURIComponent(job.id)}/${action}`, {});
    if (r.ok) onDone(retry ? `${job.kindLabel}: retried. It runs again as soon as a worker is free.` : `${job.kindLabel}: cancelled.`);
  };
  return (
    <Dialog
      title={retry ? 'Retry this job?' : 'Cancel this job?'}
      description={job.kindLabel}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Go back
          </Button>
          <Button variant={retry ? 'primary' : 'danger'} pending={a.pending} pendingLabel={retry ? 'Retrying' : 'Cancelling'} onClick={() => void go()}>
            {retry ? 'Retry now' : 'Cancel the job'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-[16px] text-ink">
        {retry ? (
          <>
            <p>{job.state === 'dead' ? 'It goes back in line with its tries counted from zero.' : 'It runs now instead of waiting for its next try.'}</p>
            <p>Retrying never sends a message twice: a message that already left, or may have left, is never sent again by a retry.</p>
          </>
        ) : (
          <>
            <p>It will not run again.</p>
            <p>If it is a lead timer whose deadline is still due, the system picks that deadline up again automatically, so nothing is skipped.</p>
          </>
        )}
        <ErrorLine message={a.error?.message} />
      </div>
    </Dialog>
  );
}

// ---- messages --------------------------------------------------------------------------------------

function Messages({ messages }: { messages: StuckMessage[] }) {
  return (
    <Section title="Messages stuck while sending" description="Messages that started sending but are not confirmed yet. They are never sent twice automatically.">
      {messages.length === 0 ? (
        <p className="text-[15px] text-ink">No messages are stuck while sending.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {messages.map((m) => (
            <li key={m.id}>
              <Card as="article" className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 flex-1 basis-48 text-[17px] font-semibold text-ink">{channelWords(m.channel)}</h3>
                  <Pill tone={m.status === 'dispatching' ? 'warn' : 'danger'}>{stuckStatusWords(m.status)}</Pill>
                </div>
                <p className="text-[15px] text-ink-muted">Started sending {formatAge(m.ageSeconds)} ago{m.reconcile.nextStepAt ? ` · Next check ${formatStamp(m.reconcile.nextStepAt)}` : ''}</p>
                <p className="text-[16px] text-ink">{m.reconcile.sentence}</p>
                <div>
                  <ButtonLink variant="secondary" to={`/contacts/${encodeURIComponent(m.contactId)}/thread`}>
                    Open conversation
                  </ButtonLink>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---- timers ----------------------------------------------------------------------------------------

function Timers({ timers }: { timers: SystemOverview['timers'] }) {
  const { windowHours, thresholdSeconds, fired, lateCount, late } = timers;
  return (
    <Section title={`Timers that fired late (last ${windowHours} hours)`} description="Lead timers (offer expiry, first-touch deadlines, auto-release) should fire on time.">
      {fired === 0 ? (
        <p className="text-[15px] text-ink">No lead timers fired in the last {plural(windowHours, 'hour')}.</p>
      ) : (
        <p className="text-[16px] text-ink">
          <Ratio value={lateCount} of={fired} label={`timers fired more than ${thresholdSeconds} seconds late`} />
        </p>
      )}
      {late.length > 0 && late.length < lateCount ? <p className="text-[14px] text-ink-muted">Showing {late.length} of {lateCount} late timers.</p> : null}
      {late.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {late.map((t) => (
            <li key={`${t.contactId}:${t.kind}:${t.dueAt}`}>
              <Card as="div" className="flex min-w-0 flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-[16px] font-semibold text-ink">{t.label}</p>
                  <p className="text-[15px] text-ink-muted">
                    {formatDuration(t.lateSeconds)} late · due {formatStamp(t.dueAt)}, fired {formatStamp(t.firedAt)}
                  </p>
                </div>
                <ButtonLink variant="secondary" to={`/contacts/${encodeURIComponent(t.contactId)}`}>
                  Open contact
                </ButtonLink>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

// ---- provider health -------------------------------------------------------------------------------

function Health({ overview }: { overview: SystemOverview }) {
  const { channels, registrations, connections } = overview;
  return (
    <Section title="Provider health" description="How sending went in the last hour, and the state of texting registrations and integrations.">
      <h3 className="text-[17px] font-semibold text-ink">Sending in the last hour</h3>
      {channels.length === 0 ? (
        <p className="text-[15px] text-ink">No messages were sent in the last hour, so there is nothing to report.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {channels.map((c) => (
            <li key={c.channel} className="text-[16px] text-ink">
              <span className="font-semibold">{channelWords(c.channel)}:</span> {c.sent} sent, {c.failed} failed in the last hour
              {c.inFlight > 0 ? `, ${c.inFlight} not confirmed yet` : ''}
            </li>
          ))}
        </ul>
      )}
      <h3 className="text-[17px] font-semibold text-ink">Texting registrations</h3>
      {registrations.length === 0 ? (
        <p className="text-[15px] text-ink">No texting registration has been started. Numbers can text clients only once a registration is approved.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {registrations.map((r) => {
            const w = registrationWords(r.status);
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-[16px] text-ink">
                <span className="min-w-0">{registrationKindWords(r.kind)}</span>
                <Pill tone={w.tone}>{w.text}</Pill>
                <span className="text-[14px] text-ink-muted">since {formatStamp(r.changedAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <h3 className="text-[17px] font-semibold text-ink">Integrations</h3>
      {connections.length === 0 ? (
        <p className="text-[15px] text-ink">No integrations are set up.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {connections.map((c) => {
            const w = connectionStatusWords(c.status);
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-2 text-[16px] text-ink">
                <span className="min-w-0 break-words">
                  {connectionKindWords(c.kind)} · {c.name}
                </span>
                <Pill tone={w.tone}>{w.text}</Pill>
                {c.lastSyncedAt ? <span className="text-[14px] text-ink-muted">last synced {formatStamp(c.lastSyncedAt)}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
