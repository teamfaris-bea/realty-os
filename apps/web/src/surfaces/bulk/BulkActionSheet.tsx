// The bulk action sheet (parity module 64; R-PAR-33..R-PAR-42, PARITY_PLAN §5 honest UI). Exported for the
// People page bulk bar (module 61), which opens it with the selection (the checked people with the list they
// came from, or the whole smart list after "Select all") and, for tag/untag, the chosen tag. Email and text
// pick their template here; stage picks a stage here; assign picks the person (only members the viewer may
// assign to, choices.ts) and Start plan picks the plan (only approved plans the viewer may start) here. A
// caller may pass the choice instead (module 64's /bulk/new link). The server freezes the selection at draft
// (module 60's resolveSelection: detail-visible people only, the kind's cap, no protected-tag audience for
// sends and plans, the checked people's list included) and decides every person again (module 63).
//
//   1. choose  (a template, a stage, a person or a plan)           1 tap
//   2. the confirm sheet: the draft the server built, with the frozen target. Everyone selected is counted:
//      who will get it, and who is left out and why (opted out, no address, wrote in the last 24 h, shares
//      an address, already in a plan, can't be reached, not yours, …). There is nothing to pre-tick and no
//      way to include someone who opted out.
//   3. Confirm                                                      1 tap
// From the People bulk bar: Email → template → Confirm (PARITY_PLAN §5: bulk email 6 taps on a phone, where
// Email also takes a sideways swipe on the one-row bar, ARCHITECTURE "The phone bulk bar"); Assign → person →
// Confirm (§5 bulk assign: 6 on a phone with no swipe, 5 on desktop); Start plan → plan → Confirm.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Dialog, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useCommand, useSession } from '../../shell/index.js';
import { KIND_LABEL } from '../settings/playbooks.js';
import { type TemplateView, readableMergeFields } from '../templates/api.js';
import { BULK_ERROR_MESSAGES, BULK_KEY, type BulkActionView, type BulkKind, KIND_WORDS, reasonWordsFor } from './api.js';
import { type AssignTarget, type PlanChoice, mayBulkAssign, mayBulkEnroll, useAssignTargets, usePlanChoices } from './choices.js';

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
  /** with `contactIds`: the list they were picked from; the server reads its tags, and a protected one refuses sends and plans (R-PAR-8) */
  audienceSource?: BulkListSelection;
  /** tags the selection was built from (a tag chip): a protected one refuses sends (R-PAR-8) */
  audienceTagIds?: readonly string[];
  /** tag/untag: the tag; assign: the person; enroll: the plan (when the caller chose already; otherwise the sheet asks) */
  params?: { tagId?: string; toUserId?: string; playbookId?: string; stage?: string; templateId?: string };
  /** a label for the thing chosen by the caller ("Tag Buyer", "Assign to Sam") */
  paramLabel?: string;
  onClose(): void;
  onConfirmed?(a: BulkActionView): void;
}

/** What the person chose in the sheet: the parameter for the draft and the words that describe it. */
interface Choice {
  templateId?: string;
  stage?: string;
  toUserId?: string;
  playbookId?: string;
  label: string;
  /** the person or plan's name, for the count sentence */
  name?: string;
  /** enroll: a personal plan (it covers only the people its agent owns) */
  personalPlan?: boolean;
}

const CHOICE_BUTTON = 'flex min-h-tap w-full flex-col items-start justify-center rounded-xl border border-line bg-surface px-3.5 py-2 text-left active:bg-surface-2 disabled:opacity-60';

/**
 * Who hears about a bulk assign, as module 63's runner does it (R-PAR-35, apps/api/src/bulk/run.ts finish): one
 * summary notice to the new owner and one to each current owner whose people move, but never to the person
 * who runs it, whether they assign to themself or own some of the people (they get the results notice).
 */
function assignNoticeText(toYou: boolean, name: string | undefined): string {
  if (toYou) return 'Each one moves to you under the same rules as assigning one lead. Each current owner gets one notice for the whole group, not one per lead.';
  return `Each one moves to ${name ?? 'the new owner'} under the same rules as assigning one lead. ${name ?? 'The new owner'} and each current owner other than you get one notice for the whole group, not one per lead.`;
}

export function BulkActionSheet({ kind, contactIds = [], selection, selectedText, audienceSource, audienceTagIds, params = {}, paramLabel, onClose, onConfirmed }: BulkActionSheetProps) {
  const api = useApi();
  const { session } = useSession();
  const id = useId();
  const send = kind === 'email' || kind === 'text';
  const needsChoice = (send && !params.templateId) || (kind === 'stage' && !params.stage) || (kind === 'assign' && !params.toUserId) || (kind === 'enroll' && !params.playbookId);
  const [choice, setChoice] = useState<Choice | null>(null);
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

  const build = async (c: Choice | null) => {
    setChoice(c);
    setError(null);
    const r = await create.run({
      kind,
      selection: selection ?? { contactIds: [...contactIds] },
      ...(audienceSource && !selection ? { audienceSource } : {}),
      ...(audienceTagIds?.length ? { audienceTagIds: [...audienceTagIds] } : {}),
      ...params,
      ...(c?.templateId ? { templateId: c.templateId } : {}),
      ...(c?.stage ? { stage: c.stage } : {}),
      ...(c?.toUserId ? { toUserId: c.toUserId } : {}),
      ...(c?.playbookId ? { playbookId: c.playbookId } : {}),
    });
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
  // assign: is the new owner the viewer (picked as "(you)", or passed in by the caller)? Then the runner sends them no summary
  const assignee = choice?.toUserId ?? params.toUserId;
  const toYou = kind === 'assign' && assignee !== undefined && assignee === session?.user.id;
  const outcome = toYou ? 'will be assigned to you' : kind === 'assign' && choice?.name ? `will be assigned to ${choice.name}` : kind === 'enroll' && choice?.name ? `will start “${choice.name}”` : `will get this ${words.noun}`;
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
      {/* module 76 (Q4): the run always skips people under AI care (bulk/run.ts:170-175) */}
      {send ? <p className="text-[14px] text-ink">People under AI care, live or paused, are skipped.</p> : null}
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
                  <span className="line-clamp-2 text-[14px] text-ink-muted [overflow-wrap:anywhere]">{t.subject ? `${readableMergeFields(t.subject)} · ` : ''}{readableMergeFields(t.body)}</span>
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
      {!draft && needsChoice && kind === 'assign' ? <AssignChoices disabled={create.pending} onPick={(t) => void build({ toUserId: t.userId, label: t.you ? 'Assign to you' : `Assign to ${t.name}`, name: t.name })} /> : null}
      {!draft && needsChoice && kind === 'enroll' ? <PlanChoices disabled={create.pending} onPick={(p) => void build({ playbookId: p.id, label: `Start “${p.name}”`, name: p.name, personalPlan: p.scope === 'agent' })} /> : null}
      {create.pending ? <p className="text-[15px] text-ink-muted">Checking each person</p> : null}
      {draft && !confirmed ? (
        <div className="flex flex-col gap-3">
          <p className="text-[17px] text-ink" id={`${id}-count`}>
            <span className="font-semibold">{draft.targetCount}</span> of {draft.selected} selected {outcome}.
          </p>
          {skipped.length > 0 ? (
            <section aria-labelledby={`${id}-skips`} className="flex flex-col gap-1 rounded-xl bg-surface-2 px-3.5 py-3">
              <h3 id={`${id}-skips`} className="text-[15px] font-semibold text-ink">
                Left out ({skipped.reduce((s, [, n]) => s + n, 0)})
              </h3>
              <ul className="flex flex-col gap-0.5 text-[15px] text-ink">
                {skipped.map(([code, n]) => (
                  <li key={code} data-reason={code}>
                    <span className="font-semibold">{n}</span> {reasonWordsFor(code, { kind, ...(choice?.personalPlan ? { personalPlan: true } : {}) })}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {draft.sharedAddresses > 0 ? <p className="text-[14px] text-ink-muted">{draft.sharedAddresses + 1} people share an address, so they get one {words.noun} between them.</p> : null}
          {/* batch 6 review F6: assigning a lead on offer withdraws the offer (R-OWN-18); its agent is told */}
          {kind === 'assign' && (draft.onOffer ?? 0) > 0 ? (
            <p className="text-[14px] text-ink">
              {draft.onOffer === 1 ? '1 of them is on offer to an agent now: assigning withdraws that offer, and the agent is told.' : `${draft.onOffer} of them are on offer to agents now: assigning withdraws those offers, and each agent is told.`}
            </p>
          ) : null}
          {draft.body ? (
            <section aria-label="Message" className="flex flex-col gap-1 rounded-xl border border-line px-3.5 py-3">
              {/* merge fields in words: each person's own values are filled in when it goes out */}
              {draft.subject ? <p className="text-[15px] font-semibold text-ink [overflow-wrap:anywhere]">{readableMergeFields(draft.subject)}</p> : null}
              <p className="whitespace-pre-wrap text-[15px] text-ink [overflow-wrap:anywhere]">{readableMergeFields(draft.body)}</p>
              <p className="text-[14px] text-ink-muted">
                {kind === 'email'
                  ? 'Sent as marketing: your signature, the brokerage name and postal address, and an unsubscribe link are added. People who opt out before it reaches them are skipped.'
                  : 'Sent as marketing: it ends with your brokerage name and "Reply STOP to opt out." Anyone who opts out before it reaches them is skipped.'}
              </p>
            </section>
          ) : null}
          {kind === 'assign' ? (
            <p className="text-[14px] text-ink-muted">{assignNoticeText(toYou, choice?.name)}</p>
          ) : kind === 'enroll' ? (
            <p className="text-[14px] text-ink-muted">The plan sends its approved messages on its own, signed as the assistant, and stops when someone replies. Anyone who opts out before a message goes out is skipped.</p>
          ) : (
            <p className="text-[14px] text-ink-muted">Nobody who opted out can be included. Bulk messages don't count as touches on a lead.</p>
          )}
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

/** Assign: the members this viewer may assign to (Owner/Admin: anyone active who can hold leads; a Team Lead: their team). */
function AssignChoices({ disabled, onPick }: { disabled: boolean; onPick(t: AssignTarget): void }) {
  const { session } = useSession();
  const role = session?.tenant?.role;
  const q = useAssignTargets(role);
  if (!mayBulkAssign(role)) return <Notice tone="warn">{BULK_ERROR_MESSAGES['BULK_NOT_PERMITTED']}</Notice>;
  return (
    <section aria-label="Assign to" className="flex flex-col gap-1">
      <p className="text-[15px] text-ink-muted">{role === 'team_lead' ? 'Pick who takes them: you, or someone on a team you lead.' : 'Pick who takes them.'}</p>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading people</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, BULK_ERROR_MESSAGES)}</Notice> : null}
      {q.data?.length === 0 ? <p className="text-[15px] text-ink-muted">There is no one you can assign them to.</p> : null}
      <ul className="flex flex-col gap-1">
        {(q.data ?? []).map((t) => (
          <li key={t.userId}>
            <button type="button" disabled={disabled} onClick={() => onPick(t)} className={CHOICE_BUTTON}>
              <span className="text-[17px] font-medium text-ink">{t.you ? `${t.name} (you)` : t.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Start plan: approved plans only, never the instant reply to new leads; team plans and the viewer's own. */
function PlanChoices({ disabled, onPick }: { disabled: boolean; onPick(p: PlanChoice): void }) {
  const { session } = useSession();
  const allowed = mayBulkEnroll(session?.tenant?.role);
  const q = usePlanChoices(allowed);
  if (!allowed) return <Notice tone="warn">{BULK_ERROR_MESSAGES['BULK_NOT_PERMITTED']}</Notice>;
  return (
    <section aria-label="Plans" className="flex flex-col gap-1">
      <p className="text-[15px] text-ink-muted">Pick the plan. It starts only for people who are not in a plan already and can be reached by text or email.</p>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading plans</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, BULK_ERROR_MESSAGES)}</Notice> : null}
      {q.data?.length === 0 ? <p className="text-[15px] text-ink-muted">No plan is ready to start. A plan needs an approved version first: approve one under Playbooks.</p> : null}
      <ul className="flex flex-col gap-1">
        {(q.data ?? []).map((p) => (
          <li key={p.id}>
            <button type="button" disabled={disabled} onClick={() => onPick(p)} className={CHOICE_BUTTON}>
              <span className="text-[17px] font-medium text-ink [overflow-wrap:anywhere]">{p.name}</span>
              <span className="text-[14px] text-ink-muted">{`${p.scope === 'team' ? 'Team plan' : 'Your plan, for people you own'} · ${KIND_LABEL[p.kind] ?? p.kind}`}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
