// AI call answering (module 55 item 8; module 48's routes). Owner and Admin only (the shell keeps every other role
// out before anything mounts, so no /voice request is ever made for them: R-STAFF-6, E671).
//
// - The state is the API's: 'dark' | 'off' | 'on', every reason worded by its code (words.ts), the counsel review and
//   vendor check of the deployment's voice pack, the provider's status and the transfer rule in words, and the
//   playbook's state with a link to its (read-only) page. Nothing is inferred and no code is shown (R-STAFF-1, E660).
// - Settings: answer-after seconds and when, sent with the version read. Owners and Admins may narrow; only the Owner
//   may widen, confirming the API's attestationText verbatim (re-auth through the shell). An Admin sees why widening is
//   off (E661). VERSION_CONFLICT refetches and says so.
// - Turn on: the Owner only, only when the one reason left is the Owner's own choice; a dialog shows attestationText
//   and "I confirm and turn on" sends it verbatim. Turn off: Owner or Admin; OWNER_REQUIRED shows the server's sentence.
//   Every tap is one useAction request, never retried (R-STAFF-4).
// - Test call: a scripted caller against the playbook, in memory. The page shows the server's simulation sentence, the
//   lines by source, the ledger and the outcome in words, said through the Announcer (E660, E664).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Dialog, Notice, announce } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { useAction } from '../admin/lib/hooks.js';
import { formatDate } from '../admin/lib/format.js';
import { Check, Loading, Section, SelectField } from '../admin/lib/ui.js';
import { formatLocalDate } from '../feed/lib/format.js';
import type { AnsweringView, SettingsBody, TestCallResult } from './types.js';
import {
  ADMIN_WIDEN_REASON,
  ANSWERING_REASON_WORDS,
  ANSWER_AFTER_CHOICES,
  ANSWER_WHEN_WORDS,
  BOOKING_DRAFT_NOTE,
  CONFIRMATION_CHANNEL_WORDS,
  DARK_WIDEN_REASON,
  DEFAULT_SCRIPT,
  NO_PLAYBOOK_TO_SIMULATE,
  SCRIPT_CHOICES,
  STATE_WORDS,
  answerAfterWords,
  endReasonWords,
  isWidening,
  ledgerRowWords,
  lineSourceWords,
  outcomeWords,
  playbookWords,
  reasonWords,
  topicWords,
  withoutCodes,
} from './words.js';

export const ANSWERING_KEY = ['voice', 'answering'] as const;

export const VERSION_CONFLICT_WORDS = 'These settings changed since you opened them. The page now shows the current settings; make your change again if it still applies.';
export const UNKNOWN_SCRIPT_WORDS = 'That test script is not available.';

/** This page's refusals in words (surface-local: the shell's sentences stay the shell's). */
export const VOICE_PAGE_MESSAGES: Readonly<Record<string, string>> = {
  ...ANSWERING_REASON_WORDS,
  VERSION_CONFLICT: VERSION_CONFLICT_WORDS,
  OWNER_REQUIRED: 'Only the Owner can do this.',
  ATTESTATION_REQUIRED: 'This needs the Owner to confirm the sentence exactly as shown.',
  VOICE_FAKE_ON_REAL_TELEPHONY: 'The test voice service cannot answer real calls, so AI answering stays off.',
  PLAYBOOK_INVALID: 'The call-answering playbook has problems to fix before it can be simulated.',
  NOT_FOUND: NO_PLAYBOOK_TO_SIMULATE,
};

/** A refusal in words: the server's own sentence for OWNER_REQUIRED when it sent one (E661), else by code. */
export function failureWords(f: { code: string; details: Record<string, unknown> | null }): string {
  if (f.code === 'OWNER_REQUIRED' && typeof f.details?.['sentence'] === 'string' && f.details['sentence'].trim() !== '') return f.details['sentence'];
  if (f.code === 'VALIDATION_FAILED' && f.details?.['reason'] === 'UNKNOWN_SCRIPT') return UNKNOWN_SCRIPT_WORDS;
  return messageFor(f.code, VOICE_PAGE_MESSAGES);
}

/** "Attested by the Owner on 2026-11-13." with the date in words. */
function datesInWords(s: string): string {
  return withoutCodes(s.replace(/\b\d{4}-\d\d-\d\d\b/g, (d) => formatLocalDate(d)));
}

export default function VoiceAnsweringPage() {
  const api = useApi();
  const { session } = useSession();
  const role = session?.tenant?.role;
  const q = useQuery<AnsweringView, ApiError>({ queryKey: ANSWERING_KEY, queryFn: ({ signal }) => api.get<AnsweringView>('/voice/answering', { signal }) });
  if (q.isPending) return <Loading />;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, VOICE_PAGE_MESSAGES)}</Notice>;
  const view = q.data;
  const isOwner = role === 'owner';
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <StateSection view={view} isOwner={isOwner} />
      <SettingsSection view={view} isOwner={isOwner} />
      <TestCallSection />
    </div>
  );
}

function StateSection({ view, isOwner }: { view: AnsweringView; isOwner: boolean }) {
  const qc = useQueryClient();
  const enable = useAction<{ attestation: string }, AnsweringView>('POST', { invalidate: [[...ANSWERING_KEY]] });
  const disable = useAction<Record<string, never>, AnsweringView>('POST', { invalidate: [[...ANSWERING_KEY]] });
  const [dialog, setDialog] = useState<'on' | 'off' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = useId();
  const onlyOwnerChoiceLeft = view.state === 'off' && view.reasons.length === 1 && view.reasons[0]!.code === 'VOICE_ANSWERING_OFF';

  const turnOn = async () => {
    setDialog(null);
    setProblem(null);
    // the attestation exactly as the API sent it (R-STAFF-4)
    const r = await enable.run('/voice/answering/enable', { attestation: view.attestationText });
    if (r.ok) {
      qc.setQueryData(ANSWERING_KEY, r.data);
      announce(STATE_WORDS[r.data.state]);
    } else setProblem(failureWords(r));
  };
  const turnOff = async () => {
    setDialog(null);
    setProblem(null);
    const r = await disable.run('/voice/answering/disable', {});
    if (r.ok) {
      qc.setQueryData(ANSWERING_KEY, r.data);
      announce(STATE_WORDS[r.data.state]);
    } else setProblem(failureWords(r));
  };

  return (
    <Section title="Status">
      <p className="text-[17px] font-semibold text-ink">{STATE_WORDS[view.state]}</p>
      {view.enabled.on ? <p className="text-[15px] text-ink">{datesInWords(view.enabled.sentence)}</p> : null}
      {view.reasons.length > 0 ? (
        <ul aria-label="What keeps it off" className="flex list-disc flex-col gap-1 pl-5 text-[15px] text-ink">
          {view.reasons.map((r) => (
            <li key={r.code}>{reasonWords(r)}</li>
          ))}
        </ul>
      ) : null}
      <ul aria-label="Checks" className="flex flex-col gap-1 text-[15px] text-ink-muted">
        <li>{view.pack.reviewedByCounselAt ? `Counsel review recorded on ${formatDate(view.pack.reviewedByCounselAt)}.` : 'Counsel review: not recorded on this deployment.'}</li>
        <li>{view.pack.vendorReady ? 'Voice vendor check recorded.' : 'Voice vendor check: not recorded on this deployment.'}</li>
        <li>{withoutCodes(view.provider.statusText)}</li>
        <li>{withoutCodes(view.transfers)}</li>
        <li>
          {view.playbook ? (
            <>
              {playbookWords(view.playbook.state)}{' '}
              <Link to={`/settings/playbooks/${encodeURIComponent(view.playbook.id)}`} className="inline-flex min-h-tap items-center font-medium text-accent underline">
                Open the playbook
              </Link>
            </>
          ) : (
            'No call-answering playbook yet.'
          )}
        </li>
      </ul>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        {view.enabled.on ? (
          <Button variant="secondary" pending={disable.pending} pendingLabel="Turning off" onClick={() => setDialog('off')}>
            Turn off AI answering
          </Button>
        ) : view.state === 'dark' ? null : isOwner ? (
          <>
            <Button pending={enable.pending} pendingLabel="Turning on" disabled={!onlyOwnerChoiceLeft} aria-describedby={onlyOwnerChoiceLeft ? undefined : noteId} onClick={() => setDialog('on')}>
              Turn on AI answering
            </Button>
            {onlyOwnerChoiceLeft ? null : (
              <p id={noteId} className="text-[14px] text-ink-muted">
                Turn on becomes available once only your choice is left.
              </p>
            )}
          </>
        ) : (
          <p className="text-[15px] text-ink-muted">Only the Owner can turn AI answering on.</p>
        )}
      </div>
      {dialog === 'on' ? (
        <Dialog
          title="Turn on AI answering"
          description="As the Owner, you confirm this sentence. It is recorded with the change."
          onClose={() => setDialog(null)}
          footer={
            <div className="flex gap-3">
              <Button variant="secondary" block onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button block onClick={() => void turnOn()}>
                I confirm and turn on
              </Button>
            </div>
          }
        >
          <blockquote className="whitespace-pre-wrap rounded-xl bg-surface-2 px-3.5 py-2.5 text-[16px] text-ink">{view.attestationText}</blockquote>
        </Dialog>
      ) : null}
      {dialog === 'off' ? (
        <Dialog
          title="Turn off AI answering?"
          description="The assistant stops answering new calls. A call it is already on finishes."
          onClose={() => setDialog(null)}
          footer={
            <div className="flex gap-3">
              <Button variant="secondary" block onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="danger" block onClick={() => void turnOff()}>
                Turn off
              </Button>
            </div>
          }
        >
          <p className="text-[15px] text-ink">Missed calls go to voicemail again.</p>
        </Dialog>
      ) : null}
    </Section>
  );
}

function SettingsSection({ view, isOwner }: { view: AnsweringView; isOwner: boolean }) {
  const qc = useQueryClient();
  const save = useAction<SettingsBody, AnsweringView>('PUT', { invalidate: [[...ANSWERING_KEY]] });
  const cur = view.settings;
  const [after, setAfter] = useState(cur.answerAfterSeconds);
  const [when, setWhen] = useState(cur.answerWhen);
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reasonId = useId();
  // the form follows the server's settings whenever they change (a save, a refetch after a conflict)
  useEffect(() => {
    setAfter(cur.answerAfterSeconds);
    setWhen(cur.answerWhen);
    setConfirmed(false);
  }, [cur.answerAfterSeconds, cur.answerWhen, cur.version]);

  const next = { answerAfterSeconds: after, answerWhen: when };
  const changed = after !== cur.answerAfterSeconds || when !== cur.answerWhen;
  const widening = isWidening(cur, next);
  const blocked = widening ? (!isOwner ? ADMIN_WIDEN_REASON : view.state === 'dark' ? DARK_WIDEN_REASON : null) : null;
  const needsConfirm = widening && blocked === null;
  const choices = [...new Set<number>([...ANSWER_AFTER_CHOICES, cur.answerAfterSeconds])].sort((a, b) => a - b);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed || blocked !== null || (needsConfirm && !confirmed)) return;
    setProblem(null);
    const r = await save.run('/voice/answering/settings', { answerAfterSeconds: after, answerWhen: when, version: cur.version, ...(needsConfirm ? { attestation: view.attestationText } : {}) });
    if (r.ok) {
      qc.setQueryData(ANSWERING_KEY, r.data);
      announce('Call answering settings saved.');
    } else setProblem(failureWords(r));
  };

  return (
    <Section title="When the assistant answers" description="It answers only a call nobody picked up. Answering later, or in fewer hours, is always allowed; answering sooner or in more hours is the Owner's choice.">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <SelectField label="Answer a missed call" value={String(after)} onChange={(e) => setAfter(Number(e.target.value))} className="md:w-80">
          {choices.map((n) => (
            <option key={n} value={n}>
              {answerAfterWords(n)}
            </option>
          ))}
        </SelectField>
        <SelectField label="Which calls" value={when} onChange={(e) => setWhen(e.target.value as typeof when)} className="md:w-80">
          {(Object.keys(ANSWER_WHEN_WORDS) as (keyof typeof ANSWER_WHEN_WORDS)[]).map((k) => (
            <option key={k} value={k}>
              {ANSWER_WHEN_WORDS[k]}
            </option>
          ))}
        </SelectField>
        {needsConfirm ? <Check label={view.attestationText} checked={confirmed} onChange={setConfirmed} /> : null}
        {blocked ? (
          <p id={reasonId} className="text-[15px] text-ink-muted">
            {blocked}
          </p>
        ) : null}
        <div>
          <Button type="submit" pending={save.pending} pendingLabel="Saving" disabled={!changed || blocked !== null || (needsConfirm && !confirmed)} aria-describedby={blocked ? reasonId : undefined}>
            Save
          </Button>
        </div>
        {problem ? <Notice tone="error">{problem}</Notice> : null}
      </form>
    </Section>
  );
}

function TestCallSection() {
  const run = useAction<{ script: string }, TestCallResult>('POST');
  const [script, setScript] = useState<string>(DEFAULT_SCRIPT);
  const [result, setResult] = useState<TestCallResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const go = async () => {
    setProblem(null);
    const r = await run.run('/voice/test-call', { script });
    if (r.ok) {
      setResult(r.data);
      announce(`${r.data.sentence} ${outcomeWords(r.data.handback.outcome)}`);
    } else {
      setResult(null);
      setProblem(r.code === 'NOT_FOUND' ? NO_PLAYBOOK_TO_SIMULATE : failureWords(r));
      announce(r.code === 'NOT_FOUND' ? NO_PLAYBOOK_TO_SIMULATE : failureWords(r));
    }
  };

  return (
    <Section title="Test call" description="A scripted caller talks to the playbook here on the page. No call is placed and nothing is saved.">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField label="Caller script" value={script} onChange={(e) => setScript(e.target.value)} className="min-w-0 flex-1 basis-64 md:max-w-md">
          {SCRIPT_CHOICES.map((s) => (
            <option key={s.name} value={s.name}>
              {s.label}
            </option>
          ))}
        </SelectField>
        <Button pending={run.pending} pendingLabel="Running" onClick={() => void go()}>
          Run
        </Button>
      </div>
      {problem ? <Notice tone="warn">{problem}</Notice> : null}
      {result ? <TestCallOutcome result={result} /> : null}
    </Section>
  );
}

function TestCallOutcome({ result }: { result: TestCallResult }) {
  const h = result.handback;
  const channel = h.confirmationChannel === 'sms' || h.confirmationChannel === 'email' ? CONFIRMATION_CHANNEL_WORDS[h.confirmationChannel] : null;
  return (
    <div className="flex flex-col gap-4" data-testid="test-call-result">
      <Notice tone="info">{result.sentence}</Notice>
      <div className="flex flex-col gap-2">
        <h3 className="text-[17px] font-semibold text-ink">What the caller would hear</h3>
        <ol className="flex flex-col gap-2">
          {result.lines.map((l, i) => (
            <li key={i} className="flex flex-col">
              <span className="text-[13px] font-medium text-ink-muted">{lineSourceWords(l.source)}</span>
              <span className="text-[16px] text-ink">{l.text}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-[17px] font-semibold text-ink">What the assistant asked to do</h3>
        {result.ledger.length === 0 ? (
          <p className="text-[15px] text-ink-muted">Nothing.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[15px] text-ink">
            {result.ledger.map((x) => (
              <li key={x.seq}>{ledgerRowWords(x)}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1 text-[15px] text-ink">
        <h3 className="text-[17px] font-semibold text-ink">How it would end</h3>
        <p>{outcomeWords(h.outcome)}</p>
        <p>{endReasonWords(h.endReason)}</p>
        {h.messageTopics.length > 0 ? <p>{`Message about ${h.messageTopics.map(topicWords).join(', ')}.`}</p> : null}
        {channel ? <p>{channel}</p> : null}
        {h.noPhoneCallback ? <p>The caller would not be called back by phone.</p> : null}
        {h.critical ? <p>The agent would get an urgent alert.</p> : null}
        {h.outcome === 'booked' ? <p className="font-medium">{BOOKING_DRAFT_NOTE}</p> : null}
      </div>
    </div>
  );
}
