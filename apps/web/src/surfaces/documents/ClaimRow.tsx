// One proposed contract date (module 55 item 7; R-STAFF-2, E675). Its text, page and quoted evidence line as the API
// words them; a needs-review claim shows the API's reviewNote and has no Confirm (the database never lets it become a
// date); a conflicting claim shows the API's conflictNote and no target is chosen for it. Confirm and Not right are
// the only decisions, claim by claim, through useCommand (their bodies take a commandId). Never an /assistant route.
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button, Notice } from '../../design/index.js';
import { messageFor, useCommand } from '../../shell/index.js';
import type { ClaimDecisionResponse, ClaimView, ExtractionResponse } from './types.js';
import { DOC_MESSAGES, docKeys, localDateWords } from './words.js';

const DECIDED: Record<Exclude<ClaimView['reviewStatus'], 'unreviewed'>, string> = {
  confirmed: 'Confirmed: on the deal timeline.',
  corrected: 'Confirmed with a change: on the deal timeline.',
  rejected: 'Marked not right: not added.',
};

type Target = { kind: 'new' } | { kind: 'existing'; dateId: string };

export function evidenceLine(e: ClaimView['evidence'][number]): string {
  if (e.line) return e.line;
  return e.snippet ? `“${e.snippet}” in the document` : 'From the document';
}

export function ClaimRow({ documentId, dealId, claim, canConfirm, open }: { documentId: string; dealId: string | null; claim: ClaimView; canConfirm: boolean; open: boolean }) {
  const qc = useQueryClient();
  const name = useId();
  const heading = useId();
  const reminderId = useId();
  const key = docKeys.extraction(documentId);
  // E675: nothing is preselected when this claim conflicts with another or could replace a live date
  const [choice, setChoice] = useState<string | null>(claim.liveDates.length === 0 && claim.conflictsWith.length === 0 ? 'new' : null);
  const [reminder, setReminder] = useState('');
  const invalidate = [key, ...(dealId ? [['deal', dealId, 'milestones'], ['documents', 'deal', dealId], ['deal', dealId]] : [])];
  const onSuccess = (data: ClaimDecisionResponse) => {
    const { dateId: _dateId, ...view } = data;
    qc.setQueryData<ExtractionResponse>(key, view);
  };
  const confirm = useCommand<{ target: Target; reminderDaysBefore?: number | null }, ClaimDecisionResponse>(`/documents/${documentId}/extraction/claims/${claim.id}/confirm`, { invalidate, onSuccess });
  const reject = useCommand<Record<string, never>, ClaimDecisionResponse>(`/documents/${documentId}/extraction/claims/${claim.id}/reject`, { invalidate, onSuccess });
  const error = confirm.error ?? reject.error;
  const days = reminder.trim() === '' ? null : Number(reminder);
  const reminderOk = days === null || (Number.isInteger(days) && days >= 0 && days <= 60);
  const decidable = open && canConfirm && claim.reviewStatus === 'unreviewed';
  const label = claim.milestone?.label ?? 'date';
  const run = () => {
    if (!choice || !reminderOk) return;
    const target: Target = choice === 'new' ? { kind: 'new' } : { kind: 'existing', dateId: choice };
    void confirm.run({ target, ...(days === null ? {} : { reminderDaysBefore: days }) });
  };
  return (
    <article aria-labelledby={heading} className="flex flex-col gap-2 rounded-xl border border-line p-3" data-needs-review={claim.needsReview || undefined}>
      <h3 id={heading} className="text-[16px] font-semibold text-ink">
        {/* the API's claim text carries the date as stored ("Closing: 2027-02-12 (page 3)"); the heading says it in words */}
        {claim.milestone && localDateWords(claim.milestone.dueOn) !== '' ? `${claim.milestone.label}: ${localDateWords(claim.milestone.dueOn)}` : claim.text}
      </h3>
      {claim.page !== null ? <p className="text-[14px] text-ink-muted">Page {claim.page}</p> : null}
      {claim.evidence.length > 0 ? (
        <ul aria-label="Evidence" className="flex flex-col gap-1">
          {claim.evidence.map((e, i) => (
            <li key={`${e.locator.start}:${i}`} className="text-[15px] text-ink">
              {evidenceLine(e)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[14px] text-ink-muted">No quote found for this.</p>
      )}
      {claim.reviewNote ? <Notice tone="warn">{claim.reviewNote}</Notice> : null}
      {claim.conflictNote ? <Notice tone="warn">{claim.conflictNote}</Notice> : null}
      {claim.reviewStatus !== 'unreviewed' ? <p className="text-[15px] text-ink">{DECIDED[claim.reviewStatus]}</p> : null}
      {claim.appliedNote ? <p className="text-[14px] text-ink-muted">{claim.appliedNote}</p> : null}
      {decidable ? (
        <div className="flex flex-col gap-2">
          {!claim.needsReview ? (
            <>
              <fieldset className="flex flex-col gap-1">
                <legend className="text-[15px] font-medium text-ink">Where does this date go?</legend>
                <label className="flex min-h-tap items-center gap-2 text-[15px] text-ink">
                  <input type="radio" name={name} value="new" checked={choice === 'new'} onChange={() => setChoice('new')} />
                  Add as a new date
                </label>
                {claim.liveDates.map((x) => (
                  <label key={x.dateId} className="flex min-h-tap items-center gap-2 text-[15px] text-ink">
                    <input type="radio" name={name} value={x.dateId} checked={choice === x.dateId} onChange={() => setChoice(x.dateId)} />
                    Replace {x.label ?? label} on {localDateWords(x.dueOn)}
                  </label>
                ))}
              </fieldset>
              <label htmlFor={reminderId} className="flex flex-col gap-1 text-[15px] font-medium text-ink">
                Reminder, days before (optional, 0 to 60)
                <input id={reminderId} inputMode="numeric" value={reminder} onChange={(e) => setReminder(e.target.value)} aria-invalid={!reminderOk || undefined} className="min-h-tap w-28 rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
              </label>
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!claim.needsReview ? (
              <Button pending={confirm.pending} disabled={!choice || !reminderOk || reject.pending} onClick={run}>
                Confirm
              </Button>
            ) : null}
            <Button variant="secondary" pending={reject.pending} disabled={confirm.pending} onClick={() => void reject.run({})}>
              Not right
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <Notice tone="error">{messageFor(error, DOC_MESSAGES)}</Notice> : null}
    </article>
  );
}
