// The bulk action sheet (parity module 64; R-PAR-33..R-PAR-42, PARITY_PLAN §5 honest UI). Exported for the
// People page bulk bar (module 61), which opens it with the selection (the checked people, or the whole
// smart list after "Select all") and, for tag/untag/assign/enroll, the chosen tag, person or plan. Email and
// text pick their template here; stage picks here. The server freezes the selection at draft (module 60's
// resolveSelection: detail-visible people only, the kind's cap, no protected-tag audience for sends).
//
//   1. choose  (email/text: a template; stage: a stage)           1 tap
//   2. the confirm sheet: the draft the server built, with the frozen target. Everyone selected is counted:
//      who will get it, and who is left out and why (opted out, no address, wrote in the last 24 h, shares
//      an address, …). There is nothing to pre-tick and no way to include someone who opted out.
//   3. Confirm                                                      1 tap
// From the People bulk bar: Email → template → Confirm (PARITY_PLAN §5: bulk email 6 taps on a phone).
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Dialog, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useCommand } from '../../shell/index.js';
import type { TemplateView } from '../templates/api.js';
import { BULK_ERROR_MESSAGES, BULK_KEY, type BulkActionView, type BulkKind, KIND_WORDS, reasonWords } from './api.js';

export const STAGE_CHOICES: readonly { key: string; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'attempting', label: 'Attempting' },
  { key: 'connected', label: 'Connected' },
  { key: 'nurture', label: 'Nurture' },
  { key: 'active', label: 'Active' },
  { key: 'under_contract', label: 'Under contract' },
  { key: 'closed', label: 'Closed' },
  { key: 'lost', label: 'Lost' },
];

/** A whole smart list as resolveSelection's input (PARITY_PLAN §4.2): a saved list, or an unsaved definition (a tag chip view). */
export type BulkListSelection = { listId: string } | { definition: unknown };

export interface BulkActionSheetProps {
  kind: BulkKind;
  /** the people picked by id */
  contactIds?: readonly string[];
  /** or everyone in a smart list ("Select all"); the server resolves and freezes it at draft */
  selection?: BulkListSelection;
  /** the selection as the caller counts it ("30 people", "10,000+ people") until the draft's own count */
  selectedText?: string;
  /** tags the selection was built from (a tag chip): a protected one refuses sends (R-PAR-8) */
  audienceTagIds?: readonly string[];
  /** tag/untag: the tag; assign: the person; enroll: the plan (chosen by the caller) */
  params?: { tagId?: string; toUserId?: string; playbookId?: string; stage?: string; templateId?: string };
  /** a label for the thing chosen by the caller ("Tag Buyer", "Assign to Sam") */
  paramLabel?: string;
  onClose(): void;
  onConfirmed?(a: BulkActionView): void;
}

export function BulkActionSheet({ kind, contactIds = [], selection, selectedText, audienceTagIds, params = {}, paramLabel, onClose, onConfirmed }: BulkActionSheetProps) {
  const api = useApi();
  const id = useId();
  const send = kind === 'email' || kind === 'text';
  const needsChoice = (send && !params.templateId) || (kind === 'stage' && !params.stage);
  const [choice, setChoice] = useState<{ templateId?: string; stage?: string; label: string } | null>(null);
  const [draft, setDraft] = useState<BulkActionView | null>(null);
  const [confirmed, setConfirmed] = useState<BulkActionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const templates = useQuery<{ templates: TemplateView[] }, ApiError>({
    queryKey: ['templates', kind === 'email' ? 'email' : 'sms'],
    queryFn: ({ signal }) => api.get<{ templates: TemplateView[] }>(`/templates?channel=${kind === 'email' ? 'email' : 'sms'}`, { signal }),
    enabled: send && !params.templateId,
  });
  const create = useCommand<Record<string, unknown>, { action: BulkActionView }>('/bulk-actions', { idKey: 'idempotencyKey', invalidate: [[...BULK_KEY]] });
  const confirm = useCommand<Record<string, unknown>, { action: BulkActionView }>(`/bulk-actions/${draft?.id ?? 'none'}/confirm`, { invalidate: [[...BULK_KEY]] });

  const build = async (c: { templateId?: string; stage?: string; label: string } | null) => {
    setChoice(c);
    setError(null);
    const r = await create.run({ kind, selection: selection ?? { contactIds: [...contactIds] }, ...(audienceTagIds?.length ? { audienceTagIds: [...audienceTagIds] } : {}), ...params, ...(c?.templateId ? { templateId: c.templateId } : {}), ...(c?.stage ? { stage: c.stage } : {}) });
    if (r.ok) setDraft(r.data.action);
    else setError(messageFor({ code: r.code, details: r.details }, BULK_ERROR_MESSAGES));
  };

  const doConfirm = async () => {
    const r = await confirm.run({});
    if (r.ok) {
      setConfirmed(r.data.action);
      onConfirmed?.(r.data.action);
    } else setError(messageFor({ code: r.code, details: r.details }, BULK_ERROR_MESSAGES));
  };

  const words = KIND_WORDS[kind];
  const title = confirmed ? `${words.verb} started` : draft ? `${words.verb} ${draft.targetCount} of ${draft.selected}?` : `${words.verb} ${selectedText ?? `${contactIds.length} ${contactIds.length === 1 ? 'person' : 'people'}`}`;

  // the server builds the draft as soon as there is nothing left to choose
  const started = useRef(false);
  useEffect(() => {
    if (needsChoice || started.current) return;
    started.current = true;
    void build(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per sheet
  }, []);

  const skipped = draft ? Object.entries(draft.preflight).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]) : [];
  return (
    <Dialog
      title={title}
      onClose={onClose}
      dismissible={!create.pending && !confirm.pending}
      description={paramLabel ?? choice?.label}
      footer={
        draft && !confirmed ? (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void doConfirm()} pending={confirm.pending} pendingLabel="Starting" disabled={draft.targetCount === 0}>
              {`${words.verb} ${draft.targetCount} ${draft.targetCount === 1 ? 'person' : 'people'}`}
            </Button>
          </div>
        ) : confirmed ? (
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : null
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!draft && needsChoice && send ? (
        <section aria-label="Templates" className="flex flex-col gap-1">
          <p className="text-[15px] text-ink-muted">Pick the {kind === 'email' ? 'email' : 'text'}. Each person gets it with their own name in it.</p>
          {templates.isPending ? <p className="text-[15px] text-ink-muted">Loading templates</p> : null}
          {templates.data?.templates.length === 0 ? <p className="text-[15px] text-ink-muted">No {kind === 'email' ? 'email' : 'text'} templates yet. Add one under Templates.</p> : null}
          <ul className="flex flex-col gap-1">
            {(templates.data?.templates ?? []).map((t) => (
              <li key={t.id}>
                <button type="button" disabled={create.pending} onClick={() => void build({ templateId: t.id, label: t.name })} className="flex min-h-tap w-full flex-col items-start rounded-xl border border-line bg-surface px-3.5 py-2 text-left active:bg-surface-2 disabled:opacity-60">
                  <span className="text-[17px] font-medium text-ink">{t.name}</span>
                  <span className="line-clamp-2 text-[14px] text-ink-muted [overflow-wrap:anywhere]">{t.subject ? `${t.subject} · ` : ''}{t.body}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {!draft && needsChoice && kind === 'stage' ? (
        <section aria-label="Stages" className="grid grid-cols-2 gap-1.5">
          {STAGE_CHOICES.map((s) => (
            <button key={s.key} type="button" disabled={create.pending} onClick={() => void build({ stage: s.key, label: `Move to ${s.label}` })} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink active:bg-surface-2 disabled:opacity-60">
              {s.label}
            </button>
          ))}
        </section>
      ) : null}
      {create.pending ? <p className="text-[15px] text-ink-muted">Checking each person</p> : null}
      {draft && !confirmed ? (
        <div className="flex flex-col gap-3">
          <p className="text-[17px] text-ink" id={`${id}-count`}>
            <span className="font-semibold">{draft.targetCount}</span> of {draft.selected} selected will get this {words.noun}.
          </p>
          {skipped.length > 0 ? (
            <section aria-labelledby={`${id}-skips`} className="flex flex-col gap-1 rounded-xl bg-surface-2 px-3.5 py-3">
              <h3 id={`${id}-skips`} className="text-[15px] font-semibold text-ink">
                Left out ({skipped.reduce((s, [, n]) => s + n, 0)})
              </h3>
              <ul className="flex flex-col gap-0.5 text-[15px] text-ink">
                {skipped.map(([code, n]) => (
                  <li key={code} data-reason={code}>
                    <span className="font-semibold">{n}</span> {reasonWords(code)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {draft.sharedAddresses > 0 ? <p className="text-[14px] text-ink-muted">{draft.sharedAddresses + 1} people share an address, so they get one {words.noun} between them.</p> : null}
          {draft.body ? (
            <section aria-label="Message" className="flex flex-col gap-1 rounded-xl border border-line px-3.5 py-3">
              {draft.subject ? <p className="text-[15px] font-semibold text-ink [overflow-wrap:anywhere]">{draft.subject}</p> : null}
              <p className="whitespace-pre-wrap text-[15px] text-ink [overflow-wrap:anywhere]">{draft.body}</p>
              <p className="text-[14px] text-ink-muted">
                {kind === 'email'
                  ? 'Sent as marketing: your signature, the brokerage name and postal address, and an unsubscribe link are added. People who opt out before it reaches them are skipped.'
                  : 'Sent as marketing: it ends with your brokerage name and "Reply STOP to opt out." Anyone who opts out before it reaches them is skipped.'}
              </p>
            </section>
          ) : null}
          <p className="text-[14px] text-ink-muted">Nobody who opted out can be included. Bulk messages don't count as touches on a lead.</p>
          {draft.targetCount === 0 ? <Notice tone="warn">Everyone selected is left out, so there is nothing to {words.verb.toLowerCase()}.</Notice> : null}
        </div>
      ) : null}
      {confirmed ? (
        <div className="flex flex-col gap-2">
          <Notice tone="ok">{`Started: ${confirmed.targetCount} ${confirmed.targetCount === 1 ? 'person' : 'people'}. You'll get a notice with the results when it finishes.`}</Notice>
          <Link to={`/bulk/${confirmed.id}`} className="inline-flex min-h-tap items-center text-[15px] font-medium text-accent underline">
            See progress
          </Link>
        </div>
      ) : null}
    </Dialog>
  );
}
