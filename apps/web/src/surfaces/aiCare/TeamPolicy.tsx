// The team AI policy on "AI assistant (ISA)" (/settings/ai-assistant/team; Owner and Admin; R-ISA-33, R-ISA-34; E1000 to
// E1006; docs/AI_ISA.md §3.2, §10.1). Everything this card says is an answer of GET /admin/ai-isa/policy:
// - the state sentence (no policy yet, draft only, approved, approved with a newer draft, revoked);
// - each version in words by section (what the assistant may and may not do), written by core policySections;
// - the draft's diff in words and what approving it does; a WIDER draft gets the banner before any tap;
// - a control is drawn only when `can` says the server would accept it (an Admin gets no Approve and reads why);
// - the text the Owner accepts to approve, or the Owner/Admin to revoke, is the server's, shown in full, ticked, and
//   sent back verbatim (Q2: never a web constant);
// - Edit is a form built from `fields`, the validator's own list; a refusal lands on its field in the server's words.
// Nothing here starts AI care, sends anything, or marks a counsel review. Phone first: one column, 44 px targets.
import { AI_ISA_POLICY_SECTIONS } from '@realty/core/isa';
import { type ReactNode, useState } from 'react';
import { Button, Card, Dialog, Notice, announce } from '../../design/index.js';
import {
  type PolicyApproveResult,
  type PolicyDecisionBody,
  type PolicyDraft,
  type PolicyFieldView,
  type PolicyIssue,
  type PolicyRevokeResult,
  type PolicySection,
  type PolicyVersion,
  type PolicyView,
  useIsaAction,
  usePolicy,
} from './api.js';
import { isaMessage } from './words.js';

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

export function TeamPolicy() {
  const q = usePolicy();
  return (
    <Card className="flex flex-col gap-4" aria-labelledby="ai-policy">
      <h2 id="ai-policy" className="text-[19px] font-semibold">
        Team policy
      </h2>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : q.isError ? (q.error.status === 403 || q.error.status === 404 ? null : <Notice tone="error">{isaMessage(q.error)}</Notice>) : <Policy v={q.data} />}
    </Card>
  );
}

function Policy({ v }: { v: PolicyView }) {
  const [line, setLine] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const create = useIsaAction<Record<string, never>, { created: boolean; policy: PolicyView }>('POST', { kind: 'policy' });
  const say = (t: string) => {
    setLine(t);
    announce(t);
  };
  const wider = v.draft?.effect === 'wider';
  const approveLabel = v.draft ? `Approve version ${v.draft.versionNo}${wider ? ' and pause AI care' : ''}` : '';
  return (
    <>
      <p className="text-[15px] text-ink">{v.sentence}</p>
      {line ? (
        <p role="status" className="text-[15px] font-medium text-ink" data-testid="policy-line">
          {line}
        </p>
      ) : null}
      {v.state === 'none' && v.can.create ? (
        <div className="flex flex-col gap-2">
          <p className="text-[15px] text-ink-muted">It starts as a draft of the platform’s defaults. A draft changes nothing: the Owner reads it, edits it and approves it.</p>
          <div>
            <Button
              variant="primary"
              pending={create.pending}
              onClick={async () => {
                const r = await create.run('/admin/ai-isa/policy', {});
                say(r.ok ? (r.data.created ? 'Created as a draft. Nothing is approved yet.' : 'Your team already has a policy. It is shown below.') : r.message);
              }}
            >
              Create the policy from the defaults
            </Button>
          </div>
        </div>
      ) : null}

      {v.approved ? (
        <section className="flex flex-col gap-2" data-testid="policy-approved" aria-label="The approved version">
          <p className="text-[15px] font-medium">
            Approved version {v.approved.versionNo}
            {v.approved.decidedBy ? `, by ${v.approved.decidedBy}${v.approved.decidedByRole ? ` (${v.approved.decidedByRole})` : ''}` : ''}. This is the version in use.
          </p>
          <VersionWords version={v.approved} />
        </section>
      ) : null}
      {v.revoked ? (
        <section className="flex flex-col gap-2" data-testid="policy-revoked" aria-label="The revoked version">
          <p className="text-[15px] font-medium">
            Revoked version {v.revoked.versionNo}
            {v.revoked.decidedBy ? `, by ${v.revoked.decidedBy}${v.revoked.decidedByRole ? ` (${v.revoked.decidedByRole})` : ''}` : ''}. It is not in use.
          </p>
          <VersionWords version={v.revoked} />
        </section>
      ) : null}

      {v.draft && !editing ? (
        <section className="flex flex-col gap-3 rounded-xl border border-line p-3" data-testid="policy-draft" aria-label="The draft">
          <p className="text-[15px] font-medium">
            Draft version {v.draft.versionNo}, saved by {v.draft.savedBy}. Not in use.
          </p>
          <DraftChange draft={v.draft} />
          {v.draft.issues.length > 0 ? (
            <Notice tone="error" title="This draft cannot be approved yet">
              <ul className="flex flex-col gap-1">
                {v.draft.issues.map((i, k) => (
                  <li key={k}>{i.sentence}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {v.draft.diff === null ? <VersionWords version={v.draft} /> : null}
          <div className="flex flex-wrap gap-2">
            {v.can.approve ? (
              <Button variant={wider ? 'danger' : 'primary'} onClick={() => setApproving(true)}>
                {approveLabel}
              </Button>
            ) : null}
            {v.can.saveDraft ? (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit the draft
              </Button>
            ) : null}
          </div>
          {!v.can.approve && v.approveOwnerOnly ? <p className="text-[15px] text-ink-muted">Only the account owner can approve a version.</p> : null}
        </section>
      ) : null}

      {editing ? (
        <PolicyForm
          v={v}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false);
            say(`Saved as draft version ${next.draft?.versionNo ?? ''}. Nothing changes until the Owner approves it.`.replace('  ', ' '));
          }}
        />
      ) : null}

      {!editing ? (
        <div className="flex flex-wrap gap-2">
          {!v.draft && v.can.saveDraft ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
          {v.can.revoke && v.approved ? (
            <Button variant="danger" onClick={() => setRevoking(true)}>
              Revoke
            </Button>
          ) : null}
        </div>
      ) : null}

      {approving && v.draft?.approvalText ? (
        <Decide
          title={`Approve version ${v.draft.versionNo}`}
          confirm={approveLabel}
          danger={wider}
          text={v.draft.approvalText}
          path="/admin/ai-isa/policy/approve"
          body={{ versionId: v.draft.versionId, contentSha256: v.draft.contentSha256, attestation: v.draft.approvalText }}
          onClose={() => setApproving(false)}
          onDone={(r: PolicyApproveResult) => say(r.sentence)}
          onFail={say}
        >
          <p>{v.draft.effectSentence}</p>
          {wider || v.draft.effect === 'after_revoke' ? <p>AI care is on for {people(v.underCare)} now. Approving {wider ? 'pauses it for all of them' : 'keeps it paused'} until each agent re-confirms. Nothing is sent to anyone.</p> : <p>Nothing is sent to anyone.</p>}
        </Decide>
      ) : null}
      {revoking && v.approved && v.revokeText ? (
        <Decide
          title={`Revoke version ${v.approved.versionNo}`}
          confirm={`Revoke version ${v.approved.versionNo}`}
          danger
          text={v.revokeText}
          path="/admin/ai-isa/policy/revoke"
          body={{ versionId: v.approved.versionId, contentSha256: v.approved.contentSha256, attestation: v.revokeText }}
          onClose={() => setRevoking(false)}
          onDone={(r: PolicyRevokeResult) => say(r.sentence)}
          onFail={say}
        >
          <p>AI care pauses for {people(v.underCare)} now, and the assistant sends nothing more to anyone.</p>
          <p>
            It starts again only after a new version is approved and each of the {v.optedIn} {v.optedIn === 1 ? 'agent' : 'agents'} who opted in re-confirms.
          </p>
          <p>Nothing is sent to any client about this.</p>
        </Decide>
      ) : null}
    </>
  );
}

/** A version in words: per section, what the assistant may and may not do. */
export function VersionWords({ version }: { version: Pick<PolicyVersion | PolicyDraft, 'sections' | 'content'> }) {
  if (version.content === null || version.sections.length === 0) return <p className="text-[15px]">This version can't be shown here.</p>;
  return (
    <div className="flex flex-col gap-3">
      <PolicySections sections={version.sections} />
      <p className="text-[13px] text-ink-muted">Engineering defaults. VERIFY WITH COUNSEL.</p>
    </div>
  );
}

export function PolicySections({ sections }: { sections: readonly PolicySection[] }) {
  return (
    <div className="flex flex-col gap-3">
      {sections.map((s) => (
        <div key={s.key} className="flex flex-col gap-1">
          <h3 className="text-[15px] font-semibold">{s.title}</h3>
          <ul className="flex flex-col gap-1 text-[15px]">
            {s.may.map((t) => (
              <li key={`y${t}`} data-may="yes" className="flex gap-2">
                <span className="shrink-0 font-medium text-ok">May</span>
                <span>{t}</span>
              </li>
            ))}
            {s.mayNot.map((t) => (
              <li key={`n${t}`} data-may="no" className="flex gap-2">
                <span className="shrink-0 font-medium text-danger">May not</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** "Adds: …", "Removes: …", "Rewords: …", one line each (the server's words). */
export function DiffLines({ diff }: { diff: { adds: string[]; removes: string[]; rewords: string[] } }) {
  const none = diff.adds.length + diff.removes.length + diff.rewords.length === 0;
  return (
    <ul className="flex flex-col gap-1 text-[15px]">
      {diff.adds.map((t) => (
        <li key={`a${t}`}>Adds: {t}.</li>
      ))}
      {diff.removes.map((t) => (
        <li key={`r${t}`}>Removes: {t}.</li>
      ))}
      {diff.rewords.map((t) => (
        <li key={`w${t}`}>Rewords: {t}.</li>
      ))}
      {none ? <li>No difference from the approved version.</li> : null}
    </ul>
  );
}

function DraftChange({ draft }: { draft: PolicyDraft }) {
  return (
    <>
      {draft.diff ? (
        <div className="flex flex-col gap-1">
          <p className="text-[15px] font-medium">Against the approved version</p>
          <DiffLines diff={draft.diff} />
        </div>
      ) : null}
      {draft.effect === 'wider' || draft.effect === 'after_revoke' ? (
        <div data-testid="policy-wider">
          <Notice tone="warn" title={draft.effect === 'wider' ? 'This draft is wider' : 'AI care stays paused'}>
            {draft.effectSentence}
          </Notice>
        </div>
      ) : (
        <p className="text-[15px]">{draft.effectSentence}</p>
      )}
    </>
  );
}

function Decide<R>({ title, confirm, danger, text, path, body, onClose, onDone, onFail, children }: {
  title: string; confirm: string; danger: boolean; text: string; path: string; body: PolicyDecisionBody; onClose(): void; onDone(r: R): void; onFail(message: string): void; children: ReactNode }) {
  const [tick, setTick] = useState(false);
  const act = useIsaAction<PolicyDecisionBody, R>('POST', { kind: 'policy' });
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="flex flex-col gap-3 text-[15px]">
        {children}
        <p className="rounded-xl border border-line bg-surface-2 p-3 break-words" data-testid="policy-attestation">
          {text}
        </p>
        <label className="flex min-h-tap items-start gap-2">
          <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={tick} onChange={(e) => setTick(e.target.checked)} />
          <span>I have read this and agree</span>
        </label>
        <Button
          variant={danger ? 'danger' : 'primary'}
          disabled={!tick}
          pending={act.pending}
          onClick={async () => {
            const r = await act.run(path, body);
            onClose();
            if (r.ok) onDone(r.data);
            else onFail(r.message);
          }}
        >
          {confirm}
        </Button>
      </div>
    </Dialog>
  );
}

// ---- the edit form, built from the validator's field list ---------------------------------------------------------

type Content = Record<string, unknown>;
const get = (c: Content, path: readonly string[]): unknown => path.reduce<unknown>((at, k) => (at !== null && typeof at === 'object' ? (at as Content)[k] : undefined), c);
function set(c: Content, path: readonly string[], value: unknown, clear = false): Content {
  const [k, ...rest] = path as [string, ...string[]];
  if (rest.length > 0) return { ...c, [k]: set((c[k] ?? {}) as Content, rest, value, clear) };
  if (!clear) return { ...c, [k]: value };
  const { [k]: _gone, ...kept } = c;
  return kept;
}
const hhmm = (sec: number) => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
const seconds = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60;
};

function PolicyForm({ v, onClose, onSaved }: { v: PolicyView; onClose(): void; onSaved(next: PolicyView): void }) {
  const start = (v.draft?.content ?? v.approved?.content ?? v.revoked?.content ?? {}) as Content;
  const [content, setContent] = useState<Content>(start);
  const [issues, setIssues] = useState<PolicyIssue[]>([]);
  const [general, setGeneral] = useState<string | null>(null);
  const save = useIsaAction<{ content: Content }, PolicyView>('PUT', { kind: 'policy' });
  const sections = [...new Set(v.fields.map((f) => f.section))];
  const titles: Record<string, string> = Object.fromEntries(AI_ISA_POLICY_SECTIONS.map((s) => [s.key, s.title]));
  const errorOf = (key: string) => issues.find((i) => i.field === key)?.sentence ?? null;
  return (
    <form
      aria-label="Edit the team policy"
      // the server's validator is the judge and its words land on the field; the browser's own bubbles would hide them
      noValidate
      className="flex flex-col gap-5 rounded-xl border border-line p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await save.run('/admin/ai-isa/policy/draft', { content });
        if (r.ok) return onSaved(r.data);
        const list = (r.details?.issues as PolicyIssue[] | undefined) ?? [];
        setIssues(list);
        const loose = list.filter((i) => i.field === null || !v.fields.some((f) => f.key === i.field)).map((i) => i.sentence);
        const t = list.length > 0 ? ['Not saved. Fix the marked values.', ...loose].join(' ') : r.message;
        setGeneral(t);
        announce(t);
      }}
    >
      <p className="text-[15px] text-ink-muted">A save makes a draft. The version in use does not change until the Owner approves the draft.</p>
      {sections.map((key) => (
        <fieldset key={key} className="flex flex-col gap-3">
          <legend className="text-[17px] font-semibold">{titles[key] ?? 'More'}</legend>
          {v.fields.filter((f) => f.section === key).map((f) => (
            <FieldControl key={f.key} f={f} value={get(content, f.path)} error={errorOf(f.key)} onChange={(value, clear) => setContent((c) => set(c, f.path, value, clear))} />
          ))}
        </fieldset>
      ))}
      {general ? (
        <p role="alert" className="text-[15px] font-medium text-danger">
          {general}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" pending={save.pending}>
          Save as a draft
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const INPUT = 'min-h-tap w-full rounded-xl border bg-surface px-3 text-[17px]';

function FieldControl({ f, value, error, onChange }: { f: PolicyFieldView; value: unknown; error: string | null; onChange(value: unknown, clear?: boolean): void }) {
  const id = `policy-${f.key.replace(/\./g, '-')}`;
  const describedBy = [f.help ? `${id}-help` : null, error ? `${id}-err` : null].filter(Boolean).join(' ') || undefined;
  const tail = (
    <>
      {f.help ? (
        <p id={`${id}-help`} className="text-[14px] text-ink-muted">
          {f.help}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-err`} className="text-[14px] font-medium text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
  if (f.kind === 'options') {
    const on = Array.isArray(value) ? (value as (string | number)[]) : [];
    return (
      <div role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy} className="flex flex-col gap-1">
        <p id={`${id}-label`} className="text-[15px] font-medium">
          {f.label}
        </p>
        {(f.options ?? []).map((o) => {
          const locked = (f.locked ?? []).includes(o.value);
          return (
            <label key={String(o.value)} className="flex min-h-tap items-center gap-2 text-[15px]">
              <input
                type="checkbox"
                className="h-5 w-5 shrink-0"
                checked={on.includes(o.value)}
                disabled={locked}
                // the option order of the list is kept, so a tick and an untick leave the content as it was
                onChange={(e) => onChange((f.options ?? []).map((x) => x.value).filter((x) => (x === o.value ? e.target.checked : on.includes(x))))}
              />
              <span>{o.label}</span>
            </label>
          );
        })}
        {tail}
      </div>
    );
  }
  if (f.kind === 'toggle') {
    return (
      <div className="flex flex-col gap-1">
        <label className="flex min-h-tap items-center gap-2 text-[15px] font-medium">
          <input type="checkbox" className="h-5 w-5 shrink-0" checked={value === true} disabled={(f.locked ?? []).length > 0} aria-describedby={describedBy} onChange={(e) => onChange(e.target.checked)} />
          <span>{f.label}</span>
        </label>
        {tail}
      </div>
    );
  }
  const label = (
    <label htmlFor={id} className="text-[15px] font-medium">
      {f.label}
    </label>
  );
  const common = { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy } as const;
  const border = error ? 'border-danger' : 'border-line';
  return (
    <div className="flex flex-col gap-1">
      {label}
      {f.kind === 'choice' ? (
        <select {...common} className={`${INPUT} ${border}`} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(f.options ?? []).map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      ) : f.kind === 'int' ? (
        <div className="flex items-center gap-2">
          <input {...common} type="number" inputMode="numeric" step={1} min={f.min} max={f.max} className={`${INPUT} ${border}`} value={value === undefined || value === null || Number.isNaN(value) ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} />
          {f.unit ? <span className="shrink-0 text-[15px] text-ink-muted">{f.unit}</span> : null}
        </div>
      ) : f.kind === 'time' ? (
        <input {...common} type="time" step={60} min={f.min !== undefined ? hhmm(f.min) : undefined} max={f.max !== undefined ? hhmm(f.max) : undefined} className={`${INPUT} ${border}`} value={typeof value === 'number' ? hhmm(value) : ''}
          onChange={(e) => onChange(seconds(e.target.value))} />
      ) : (
        <textarea {...common} rows={f.path[0] === 'tone' ? 3 : 2} maxLength={f.maxLength} className={`w-full rounded-xl border bg-surface px-3 py-2 text-[17px] ${border}`} value={typeof value === 'string' ? value : ''}
          onChange={(e) => (f.path[0] === 'holdingLines' && e.target.value === '' ? onChange(undefined, true) : onChange(e.target.value))} />
      )}
      {tail}
    </div>
  );
}
