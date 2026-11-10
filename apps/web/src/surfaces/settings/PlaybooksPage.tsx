// Playbooks list and editor (BUILD_PLAN module 17 "Playbook editor with approval attestation";
// api/assistant playbooks; R-AST-3, R-AST-4, R-AST-11).
//
// - A playbook runs only from an approved version. Saving an edit creates a new draft; the approved
//   version keeps running until the draft is approved (enrollments move at their next message).
// - Approving shows exactly what will run and asks the approver to confirm an attestation bound to
//   that version's content fingerprint (contentSha256), so a version changed after review cannot be
//   approved by a stale tap (PLAYBOOK_HASH_MISMATCH).
// - What blocks approval is listed per message in plain words (money, contracts, payment details,
//   claiming to be a person, ...): those always need a person.
// - Team playbooks are approved by an Owner or Admin; a personal playbook by its own agent.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, EmptyState, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { formatStamp } from '../admin/lib/format.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';
import type { Playbook, PlaybookStepView, PlaybookVersion } from '../admin/lib/types.js';
import { Check, ErrorLine, Pill, Section, SelectField, StatusLine, TextArea } from '../admin/lib/ui.js';
import { type DelayUnit, KIND_LABEL, STATUS_LABEL, TEMPLATES, approvalAttestation, delayText, issueSentence, joinDelay, mayApprove, placeholdersIn, playbookState, revokeAttestation, splitDelay, stepsOf, workingVersion } from './playbooks.js';

const PLAYBOOKS_KEY = ['assistant', 'playbooks'] as const;

export function PlaybooksPage() {
  const api = useApi();
  const { session } = useSession();
  const role = session?.tenant?.role;
  const navigate = useNavigate();
  const q = useQuery<{ playbooks: Playbook[] }, ApiError>({ queryKey: PLAYBOOKS_KEY, queryFn: ({ signal }) => api.get('/playbooks', { signal }) });
  const create = useAction<{ templateKey: string }, { playbook: Playbook }>('POST', { invalidate: [[...PLAYBOOKS_KEY]] });
  const allowed = TEMPLATES.filter((t) => t.scope === 'agent' || role === 'owner' || role === 'admin');
  const [pick, setPick] = useState(allowed[0]?.key ?? '');
  const list = q.data?.playbooks ?? [];
  const team = list.filter((p) => p.scope === 'team');
  const mine = list.filter((p) => p.scope === 'agent');
  return (
    <div className="flex w-full max-w-3xl flex-col gap-8">
      <Notice tone="info">
        A playbook is a set of messages you approve once. The assistant then sends them on its own, signed as the assistant, never to anyone who has opted out, and it stops the moment a client replies. Anything about money, offers or contracts always waits for a person.
      </Notice>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {q.data && list.length === 0 ? <EmptyState icon="checklist" title="No playbooks yet" /> : null}
      {team.length > 0 ? <PlaybookList title="Team playbooks" items={team} /> : null}
      {mine.length > 0 ? <PlaybookList title={role === 'owner' || role === 'admin' ? 'Personal playbooks' : 'Your playbooks'} items={mine} /> : null}
      {allowed.length > 0 ? (
        <Section title="Start a playbook" description="Start from a written-out example, then edit the words before approving it.">
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await create.run('/playbooks', { templateKey: pick });
              if (r.ok) navigate(`/settings/playbooks/${r.data.playbook.id}`);
            }}
          >
            <SelectField label="Start from" value={pick} onChange={(e) => setPick(e.target.value)} className="sm:flex-1">
              {allowed.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name} {t.scope === 'team' ? '(team)' : '(personal)'}
                </option>
              ))}
            </SelectField>
            <Button type="submit" variant="secondary" pending={create.pending} disabled={!pick}>
              Create draft
            </Button>
          </form>
          <ErrorLine message={create.error?.message} />
        </Section>
      ) : null}
    </div>
  );
}

function PlaybookList({ title, items }: { title: string; items: Playbook[] }) {
  return (
    <Section title={title}>
      <ul className="flex flex-col gap-2">
        {items.map((p) => {
          const st = playbookState(p);
          return (
            <li key={p.id}>
              <Link to={`/settings/playbooks/${p.id}`} className="block rounded-2xl border border-line bg-surface p-4 active:bg-surface-2">
                <p className="text-[16px] font-semibold text-ink">{p.name}</p>
                <p className="flex flex-wrap items-center gap-2 text-[14px] text-ink-muted">
                  {KIND_LABEL[p.kind] ?? p.kind} <Pill tone={st.tone}>{st.text}</Pill>
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export function PlaybookPage() {
  const { playbookId = '' } = useParams();
  const api = useApi();
  const { session } = useSession();
  const [status, announce] = useAnnounce();
  const q = useQuery<{ playbook: Playbook }, ApiError>({ queryKey: [...PLAYBOOKS_KEY, playbookId], queryFn: ({ signal }) => api.get(`/playbooks/${playbookId}`, { signal }) });
  const p = q.data?.playbook;
  const working = p ? workingVersion(p) : null;
  const approver = p ? mayApprove(p, { userId: session?.user.id, role: session?.tenant?.role }) : false;
  const running = p?.versions.find((v) => v.id === p.approvedVersionId) ?? null;
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <Link to="/settings/playbooks" className="inline-flex min-h-tap items-center text-[15px] text-accent">
        All playbooks
      </Link>
      <StatusLine text={status} />
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {p ? (
        <>
          <div>
            <h2 className="text-[22px] font-semibold text-ink">{p.name}</h2>
            <p className="flex flex-wrap items-center gap-2 text-[15px] text-ink-muted">
              {p.scope === 'team' ? 'Team playbook' : 'Personal playbook'} · {KIND_LABEL[p.kind] ?? p.kind} <Pill tone={playbookState(p).tone}>{playbookState(p).text}</Pill>
            </p>
            {!approver ? <p className="mt-1 text-[14px] text-ink-muted">{p.scope === 'team' ? 'An Owner or Admin approves team playbooks. You can read it here.' : 'Only the agent it belongs to approves this playbook.'}</p> : null}
          </div>
          {working ? <Editor key={working.id} playbook={p} version={working} canEdit={approver} onDone={announce} /> : null}
          {running && approver ? <Revoke playbook={p} version={running} onDone={announce} /> : null}
          <History playbook={p} />
        </>
      ) : null}
    </div>
  );
}

interface StepDraft {
  channel: 'sms' | 'email';
  amount: string;
  unit: DelayUnit;
  subject: string;
  template: string;
}

function draftOf(s: PlaybookStepView): StepDraft {
  const d = splitDelay(s.delay.offsetSeconds);
  return { channel: s.channel, amount: String(d.amount), unit: d.unit, subject: s.subject ?? '', template: s.template };
}

/** The edited step, keeping every field the editor does not show exactly as it was. */
export function applyDraft(s: PlaybookStepView, d: StepDraft): PlaybookStepView {
  const known = new Set(['first_name', 'agent_first_name', 'team_name', 'brokerage_name', 'inquiry_property', 'listing_address', 'listing_price', 'listing_url', 'search_name', 'match_count', 'appointment_time', 'appointment_place', ...s.slots]);
  const used = placeholdersIn(`${d.subject} ${d.template}`).filter((x) => known.has(x));
  const amount = Number(d.amount);
  const next: PlaybookStepView = {
    ...s,
    channel: d.channel,
    delay: { ...s.delay, offsetSeconds: Number.isFinite(amount) ? joinDelay(amount, d.unit) : s.delay.offsetSeconds },
    template: d.template,
    slots: [...new Set([...s.slots, ...used])],
  };
  if (d.channel === 'email') next.subject = d.subject.trim() || s.subject || '';
  else delete next.subject;
  return next;
}

function Editor({ playbook, version, canEdit, onDone }: { playbook: Playbook; version: PlaybookVersion; canEdit: boolean; onDone(t: string): void }) {
  const steps = stepsOf(version);
  const [drafts, setDrafts] = useState<StepDraft[]>(steps.map(draftOf));
  const [attest, setAttest] = useState(false);
  const save = useAction<{ steps: unknown[]; tone: Record<string, unknown> }, { playbook: Playbook }>('POST', { invalidate: [[...PLAYBOOKS_KEY]] });
  const approve = useAction<{ attestation: string; contentSha256: string }, { playbook: Playbook }>('POST', { invalidate: [[...PLAYBOOKS_KEY]] });
  const edited = steps.map((s, i) => applyDraft(s, drafts[i]!));
  const dirty = JSON.stringify(edited) !== JSON.stringify(steps);
  const isDraft = version.status === 'draft';
  const attestation = approvalAttestation(playbook, version);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await save.run(`/playbooks/${playbook.id}/versions`, { steps: edited, tone: version.tone });
    if (r.ok) onDone('Saved as a new draft. The running version keeps running until this one is approved.');
  };
  const doApprove = async () => {
    const r = await approve.run(`/playbook-versions/${version.id}/approve`, { attestation, contentSha256: version.contentSha256 });
    if (r.ok) onDone(`Version ${version.versionNo} approved and running`);
  };
  return (
    <Section title={isDraft ? `Draft · version ${version.versionNo}` : `Version ${version.versionNo} · ${STATUS_LABEL[version.status] ?? version.status}`} description={isDraft ? undefined : canEdit ? 'Edit the words below to start a new draft. This version keeps running until the new one is approved.' : undefined}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <ol className="flex flex-col gap-3">
          {steps.map((s, i) => {
            const d = drafts[i]!;
            const issues = version.issues.filter((x) => x.index === i);
            const set = (patch: Partial<StepDraft>) => setDrafts((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <li key={s.stepKey}>
                <Card className="flex flex-col gap-3">
                  <p className="text-[15px] font-semibold text-ink">
                    Message {i + 1} · {delayText(applyDraft(s, d).delay)}
                    {s.purpose === 'marketing' ? <span className="font-normal text-ink-muted"> · marketing</span> : null}
                  </p>
                  {canEdit ? (
                    <>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <SelectField label="Send as" value={d.channel} onChange={(e) => set({ channel: e.target.value as StepDraft['channel'] })}>
                          <option value="sms">Text</option>
                          <option value="email">Email</option>
                        </SelectField>
                        <TextField label="Wait" type="number" inputMode="numeric" value={d.amount} onChange={(e) => set({ amount: e.target.value })} />
                        <SelectField label="Unit" value={d.unit} onChange={(e) => set({ unit: e.target.value as DelayUnit })}>
                          <option value="minutes">minutes</option>
                          <option value="hours">hours</option>
                          <option value="days">days</option>
                        </SelectField>
                      </div>
                      {d.channel === 'email' ? <TextField label="Subject" value={d.subject} onChange={(e) => set({ subject: e.target.value })} maxLength={200} /> : null}
                      <TextArea label="Message" value={d.template} onChange={(e) => set({ template: e.target.value })} rows={4} maxLength={4000} hint={`Placeholders: ${s.slots.map((x) => `{{${x}}}`).join(' ') || 'none'}. The assistant's sign-off is added automatically.`} />
                    </>
                  ) : (
                    <>
                      {s.subject ? <p className="text-[15px] text-ink">Subject: {s.subject}</p> : null}
                      <p className="whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-[16px] text-ink">{s.template}</p>
                    </>
                  )}
                  {issues.map((x, n) => (
                    <Notice key={`${x.code}:${n}`} tone="error">
                      {issueSentence(x.code)}
                    </Notice>
                  ))}
                </Card>
              </li>
            );
          })}
        </ol>
        {version.issues.filter((x) => x.index < 0 || x.index >= steps.length).map((x, n) => (
          <Notice key={`g${n}`} tone="error">
            {issueSentence(x.code)}
          </Notice>
        ))}
        <ErrorLine message={save.error?.message} />
        {canEdit ? (
          <div>
            <Button type="submit" variant={isDraft ? 'secondary' : 'primary'} pending={save.pending} disabled={!dirty}>
              Save as new draft
            </Button>
          </div>
        ) : null}
      </form>
      {isDraft && canEdit ? (
        <Card className="flex flex-col gap-3">
          <h3 className="text-[17px] font-semibold text-ink">Approve version {version.versionNo}</h3>
          {dirty ? <Notice tone="warn">Save your edits first. Approval is for the exact words that were saved.</Notice> : null}
          {version.issues.length > 0 ? <Notice tone="warn">Fix the problems listed above, save, then approve.</Notice> : null}
          <Check label={attestation} checked={attest} onChange={setAttest} disabled={dirty || version.issues.length > 0} hint={`Version fingerprint ${version.contentSha256.slice(0, 12)}`} />
          <ErrorLine message={approve.error?.message} />
          <div>
            <Button pending={approve.pending} disabled={!attest || dirty || version.issues.length > 0} onClick={() => void doApprove()}>
              Approve and run
            </Button>
          </div>
        </Card>
      ) : null}
    </Section>
  );
}

function Revoke({ playbook, version, onDone }: { playbook: Playbook; version: PlaybookVersion; onDone(t: string): void }) {
  const [open, setOpen] = useState(false);
  const [attest, setAttest] = useState(false);
  const a = useAction<{ attestation: string; contentSha256: string }, { playbook: Playbook }>('POST', { invalidate: [[...PLAYBOOKS_KEY]] });
  const text = revokeAttestation(playbook, version);
  if (!open) {
    return (
      <div>
        <Button variant="quiet" onClick={() => setOpen(true)}>
          Stop this playbook
        </Button>
      </div>
    );
  }
  return (
    <Card className="flex flex-col gap-3">
      <h3 className="text-[17px] font-semibold text-ink">Stop version {version.versionNo}</h3>
      <p className="text-[15px] text-ink">Everyone on this playbook is paused at once. You can approve a new version later.</p>
      <Check label={text} checked={attest} onChange={setAttest} />
      <ErrorLine message={a.error?.message} />
      <div className="flex gap-2">
        <Button variant="danger" pending={a.pending} disabled={!attest} onClick={async () => (await a.run(`/playbook-versions/${version.id}/revoke`, { attestation: text, contentSha256: version.contentSha256 })).ok && onDone(`Version ${version.versionNo} stopped`)}>
          Stop playbook
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function History({ playbook }: { playbook: Playbook }) {
  const versions = [...playbook.versions].sort((a, b) => b.versionNo - a.versionNo);
  return (
    <Section title="Versions">
      <ul className="flex flex-col gap-1">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2 text-[15px] text-ink">
            Version {v.versionNo} <Pill tone={v.status === 'approved' ? 'ok' : v.status === 'draft' ? 'warn' : 'neutral'}>{STATUS_LABEL[v.status] ?? v.status}</Pill>
            <span className="text-ink-muted">{formatStamp(v.createdAt)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
