// The source review (R-LSRC-8, R-LSRC-9, R-LSRC-10; owner decision 2026-11-14; E728 to E747): every imported source
// label, exactly as imported, and each import's people with no label, with the lead source each one means.
//
// A Follow Up Boss or CSV import keeps a person's source only as a label. Until the Owner chooses the lead source a
// label means, the people imported with it are "in review": nothing automatic goes to them (the server's
// SOURCE_UNCLASSIFIED), while anyone on the team may still call, text or email them one to one. The review is shown as a
// step of every import (ImportsPages.tsx ReviewSourcesStep, from GET /imports/:id/parity, and its summary from
// /report) and on the Lead sources page (ReviewSourcesSection, from GET /lead-sources/import-labels).
//
// Each row is the API's own sentence, a state chip, where the label first came in and who last changed it. Only the
// Owner gets controls (the server refuses everyone else); an Admin reads the list and is told who maps. Nothing is ever
// applied by changing the dropdown: the Owner
//   - confirms an exact-match suggestion with its own button (POST /lead-sources/import-labels/confirm; the server
//     works the suggestion out again and answers 409 when it no longer holds),
//   - or chooses a lead source and then presses "Map to <source>" / "Change to <source>" (PUT),
//   - or removes a mapping, after being told what that stops (PUT with leadSourceId null).
// The no-label group is one row and is mapped by its import, never by an empty label. Every write is 🔒: the shell asks
// for the password when the server answers REAUTH_REQUIRED and the same request is sent again (useAction). A failed
// action stays on its row with "Try again".
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Notice } from '../../design/index.js';
import { type ApiError, useApi, useSession } from '../../shell/index.js';
import { type ActionResult, useAction, useAnnounce } from '../admin/lib/hooks.js';
import { Pill, SelectField, StatusLine } from '../admin/lib/ui.js';
import { SOURCE_KEYS, useOverview } from './hooks.js';
import { sentenceFor } from './messages.js';
import { IN_REVIEW_MEANS, type ImportLabelView, OWNER_MAPS_LABELS, REMOVE_WARNING, WHAT_CHOOSING_DOES, choiceWords, fieldLabel, mappingKey, notCoveredWords, provenanceWords, rowGroupName, rowKey, rowTitle, stateWords, stoppedWords } from './reviewWords.js';
import type { SourceOverview } from './types.js';
import { madeSafeWords } from './words.js';

export { NO_LABEL_FIELD, OWNER_MAPS_LABELS, mappingKey } from './reviewWords.js';
export type { ImportLabelView } from './reviewWords.js';

export const IMPORT_LABELS_KEY = ['lead-sources', 'import-labels'] as const;
/** Where the review lives on the Lead sources page (an import links here). */
export const REVIEW_ANCHOR = 'review-sources';
export const LEAD_SOURCES_PATH = '/admin/lead-sources';
export const REVIEW_PATH = `${LEAD_SOURCES_PATH}#${REVIEW_ANCHOR}`;
const NOT_CHOSEN = '';

interface Answer {
  label: ImportLabelView;
  pausing: number;
  stopping: number;
  withdrawn?: number;
}
type MapBody = ({ label: string } | { unlabeledImportId: string }) & { leadSourceId: string | null };
type Failure = Extract<ActionResult<Answer>, { ok: false }>;

/** What a successful change is announced as: the row's new sentence, then what it stopped, in the words that fit it. */
export function changedWords(a: Answer): string {
  return `${a.label.sentence}${a.label.state === 'mapped' && a.label.noAutomatedContact ? madeSafeWords(a) : stoppedWords(a)}`;
}

/** The rows of the review. `canChange` is the server's word where it sends one; otherwise only the Owner changes them. */
export function ImportLabelList({ rows, onChanged, canChange }: { rows: readonly ImportLabelView[]; onChanged(): void; canChange?: boolean }) {
  const { session } = useSession();
  const owner = canChange ?? session?.tenant?.role === 'owner';
  const sources = useOverview(owner);
  const [status, announce] = useAnnounce(12_000);
  const done = (a: Answer) => {
    announce(changedWords(a));
    onChanged();
  };
  return (
    <div className="flex flex-col gap-3">
      <StatusLine text={status} />
      {owner && sources.isError ? (
        <Notice
          tone="error"
          action={
            <Button variant="secondary" onClick={() => void sources.refetch()}>
              Try again
            </Button>
          }
        >
          Your lead sources could not be loaded, so there is nothing to choose from yet. {sentenceFor(sources.error)}
        </Notice>
      ) : null}
      {owner && sources.data && sources.data.sources.length === 0 ? (
        <Notice tone="info">
          There is no lead source to choose yet.{' '}
          <Link to={LEAD_SOURCES_PATH} className="text-accent underline">
            Add one under Lead sources
          </Link>
          , then choose it here.
        </Notice>
      ) : null}
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={rowKey(r)}>
            <ReviewRow row={r} owner={owner} sources={sources.data?.sources ?? []} onDone={done} onStale={onChanged} />
          </li>
        ))}
      </ul>
      {owner ? null : <p className="text-[14px] text-ink-muted">{OWNER_MAPS_LABELS}</p>}
    </div>
  );
}

function ReviewRow({ row: r, owner, sources, onDone, onStale }: { row: ImportLabelView; owner: boolean; sources: readonly SourceOverview[]; onDone(a: Answer): void; onStale(): void }) {
  const inv = { invalidate: [[...IMPORT_LABELS_KEY], ...SOURCE_KEYS] };
  const put = useAction<MapBody, Answer>('PUT', inv);
  const confirm = useAction<{ label: string; leadSourceId: string }, Answer>('POST', inv);
  // the Owner's choice in the dropdown: only a choice until a button applies it
  const [choice, setChoice] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState<{ failure: Failure; retry: (() => void) | null } | null>(null);
  const chosen = choice ?? r.leadSourceId ?? NOT_CHOSEN;
  const chosenSource = sources.find((s) => s.id === chosen) ?? null;
  const pending = put.pending || confirm.pending;
  const state = stateWords(r);
  const notCovered = notCoveredWords(r);

  const settle = (res: ActionResult<Answer>, retry: () => void) => {
    if (res.ok) {
      setChoice(null);
      setRemoving(false);
      setFailed(null);
      onDone(res.data);
      return;
    }
    // the suggestion no longer holds: nothing was mapped, and the list is read again so the row says what is true now
    const stale = res.code === 'IMPORT_LABEL_SUGGESTION_CHANGED';
    setFailed({ failure: res, retry: stale ? null : retry });
    if (stale) onStale();
  };
  const map = (leadSourceId: string | null) => {
    const go = async (): Promise<void> => settle(await put.run('/lead-sources/import-labels', { ...mappingKey(r), leadSourceId }), () => void go());
    void go();
  };
  const confirmSuggestion = () => {
    if (!r.suggestion) return;
    const body = { label: r.label, leadSourceId: r.suggestion.leadSourceId };
    const go = async (): Promise<void> => settle(await confirm.run('/lead-sources/import-labels/confirm', body), () => void go());
    void go();
  };

  return (
    <div role="group" aria-label={rowGroupName(r)} className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* the label exactly as imported: its spaces and line breaks are kept, and a long one wraps */}
        <p className="min-w-0 flex-1 basis-40 whitespace-pre-wrap break-words text-[16px] font-semibold text-ink">{rowTitle(r)}</p>
        <Pill tone={state.tone}>{state.text}</Pill>
        {/* E755: people of the file the mapping does not cover (the row's sentence says who, in numbers) */}
        {notCovered ? <Pill tone="warn">{notCovered}</Pill> : null}
      </div>
      <p className="break-words text-[15px] text-ink">{r.sentence}</p>
      <p className="text-[14px] text-ink-muted">{provenanceWords(r)}</p>
      {owner ? (
        <div className="flex flex-col gap-2">
          {r.state === 'suggested' && r.suggestion ? (
            <div>
              <Button pending={confirm.pending} disabled={pending} onClick={confirmSuggestion}>
                Confirm {r.suggestion.leadSourceName}
              </Button>
            </div>
          ) : null}
          {sources.length > 0 ? (
            <SelectField
              label={fieldLabel(r)}
              value={chosen}
              disabled={pending}
              hint={r.state === 'suggested' ? 'Or choose a different lead source. Choosing changes nothing until you press the button under it.' : 'Choosing changes nothing until you press the button under it.'}
              onChange={(e) => {
                setChoice(e.target.value);
                setRemoving(false);
                setFailed(null);
              }}
            >
              <option value={NOT_CHOSEN}>Choose a lead source</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.noAiCare ? ' (no automated contact)' : ''}
                </option>
              ))}
            </SelectField>
          ) : null}
          {chosenSource && chosenSource.id !== r.leadSourceId ? (
            <>
              <p className="text-[14px] text-ink">{choiceWords(chosenSource)}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant={r.state === 'suggested' ? 'secondary' : 'primary'} pending={put.pending} disabled={pending} onClick={() => map(chosenSource.id)}>
                  {r.leadSourceId ? 'Change to' : 'Map to'} {chosenSource.name}
                </Button>
                <Button variant="quiet" disabled={pending} onClick={() => setChoice(null)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : null}
          {r.leadSourceId && !removing ? (
            <div>
              <Button variant="quiet" disabled={pending} onClick={() => setRemoving(true)}>
                Remove mapping
              </Button>
            </div>
          ) : null}
          {r.leadSourceId && removing ? (
            <div role="group" aria-label={`Remove the mapping to ${r.leadSourceName ?? 'this lead source'}`} className="flex flex-col gap-2 rounded-xl bg-warn-soft p-3">
              <p className="text-[15px] font-semibold text-ink">Remove the mapping to {r.leadSourceName ?? 'this lead source'}?</p>
              <p className="text-[15px] text-ink">{REMOVE_WARNING}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" pending={put.pending} disabled={pending} onClick={() => map(null)}>
                  Yes, remove it
                </Button>
                <Button variant="quiet" disabled={pending} onClick={() => setRemoving(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : null}
          {failed ? (
            <Notice
              tone="error"
              action={
                failed.retry ? (
                  <Button variant="secondary" onClick={failed.retry}>
                    Try again
                  </Button>
                ) : undefined
              }
            >
              {sentenceFor(failed.failure)} Nothing was changed.
            </Notice>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The Lead sources page: the review of every imported label in the CRM, afterwards as at import time. */
export function ReviewSourcesSection() {
  const api = useApi();
  const q = useQuery<{ labels: ImportLabelView[]; canChange: boolean }, ApiError>({ queryKey: IMPORT_LABELS_KEY, queryFn: ({ signal }) => api.get('/lead-sources/import-labels', { signal }) });
  return (
    <section aria-label="Review sources" id={REVIEW_ANCHOR}>
      <Card className="flex flex-col gap-3">
        <h2 className="text-[18px] font-semibold text-ink">Review sources</h2>
        <p className="text-[15px] text-ink-muted">
          People brought in from Follow Up Boss or a file carry their source as a label, shown here exactly as it was imported. {WHAT_CHOOSING_DOES}
        </p>
        {q.isPending ? <p className="text-[15px] text-ink-muted">Loading the source review</p> : null}
        {q.isError ? (
          <Notice
            tone="error"
            action={
              <Button variant="secondary" onClick={() => void q.refetch()}>
                Try again
              </Button>
            }
          >
            The source review could not be loaded. {sentenceFor(q.error)}
          </Notice>
        ) : null}
        {q.data && q.data.labels.length === 0 ? <p className="text-[15px] text-ink">No imported source labels yet. When an import brings people in, their source labels are listed here for an Owner to review.</p> : null}
        {q.data && q.data.labels.length > 0 ? (
          <>
            {q.data.labels.some((r) => r.inReview) ? (
              <Notice tone="warn" title="People whose source is in review">
                {IN_REVIEW_MEANS}
              </Notice>
            ) : null}
            <ImportLabelList rows={q.data.labels} canChange={q.data.canChange} onChanged={() => void q.refetch()} />
          </>
        ) : null}
      </Card>
    </section>
  );
}
