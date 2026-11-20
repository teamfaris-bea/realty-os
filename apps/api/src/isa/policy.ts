// The team AI policy: create, save a draft, approve, revoke (R-ISA-33, R-ISA-34; E1000 to E1006; docs/AI_ISA.md §3.2).
//
// - Storage is the playbook tables as they are (no migration): one `playbooks` row of kind ai_isa, team scope; each
//   `playbook_versions.steps` holds one AiIsaContent; a decision is one append-only `playbook_approvals` row with the
//   approver, their role, the content hash and the exact text they accepted. The DB guards stay the backstop
//   (playbook_versions_guard: born a draft, frozen after, approved only with a matching approval row;
//   playbook_approvals_guard: the approver is the caller, Owner or Admin on a team playbook).
// - This file is the only writer of an ai_isa policy. The generic playbook routes refuse the kind (assistant/playbooks.ts).
// - Wider or narrower is core `narrowsPrevious`, stored once at approval as `narrows_previous`; the consent chain's
//   link 4 (repo.ts versionState) and the send guard (0080, 0081, 0083) read it. Nothing here pauses, resumes or sends:
//   a wider version makes link 4 fail `policy_updated` for care on the older version, a revoke makes it fail
//   `approval_revoked`, and the sweep this file wakes applies that pause, as it would on its own within five minutes.
// - No route here writes a jurisdiction pack, starts care, or queues a message.
import { contentSha256 } from '@realty/core/assistant';
import type { UserActor } from '@realty/core/foundation';
import { type Tx, enqueueJob, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import {
  AI_ISA_POLICY_FIELDS,
  AI_ISA_POLICY_TEXT_VERSION,
  type AiIsaContent,
  DEFAULT_AI_ISA_CONTENT,
  type PolicyApprovalEffect,
  type PolicyDiff,
  type PolicyIssueWords,
  type PolicySectionWords,
  aiIsaPolicyApprovalText,
  aiIsaPolicyRevokeText,
  narrowsPrevious,
  parseAiIsaContent,
  policyDiff,
  policyIssueWords,
  policySections,
  validateAiIsaContent,
} from './coreSeam.js';
import type { IsaDeps } from './effects.js';

export const POLICY_NAME = 'AI assistant policy';

/** The hash every approval and every opt-in names: core contentSha256 over the stored content and an empty tone. */
export const policySha = (content: AiIsaContent): string => contentSha256(content as unknown as Parameters<typeof contentSha256>[0], {});

interface VersionRow {
  id: string;
  versionNo: number;
  steps: unknown;
  sha: string;
  status: 'draft' | 'approved' | 'superseded' | 'revoked';
  narrows: boolean | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

interface DecisionRow {
  versionId: string;
  decision: 'approve' | 'revoke';
  by: string | null;
  role: string;
  at: Date;
}

export type PolicyState = 'none' | 'draft_only' | 'approved' | 'approved_with_draft' | 'revoked' | 'revoked_with_draft';

/** One transaction-scoped lock per tenant: creates, draft saves and decisions of the policy run one at a time. */
async function lockPolicy(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('ai_isa.policy:' || app.tenant_id()::text, 0))`.execute(tx);
}

/** The tenant's ai_isa playbook (the oldest, should a database hold more than one: fixtures of older tests did). */
async function policyPlaybookId(tx: Tx): Promise<string | null> {
  const r = await sql<{ id: string }>`SELECT id FROM playbooks WHERE tenant_id = app.tenant_id() AND kind = 'ai_isa' AND scope = 'team' AND status = 'active' ORDER BY created_at, id LIMIT 1`.execute(tx);
  return r.rows[0]?.id ?? null;
}

async function versionsOf(tx: Tx, playbookId: string): Promise<VersionRow[]> {
  const r = await sql<{ id: string; version_no: number; steps: unknown; sha: string; status: VersionRow['status']; narrows: boolean | null; created_at: Date; updated_at: Date; by: string | null }>`
    SELECT v.id, v.version_no, v.steps, v.content_sha256 AS sha, v.status, v.narrows_previous AS narrows, v.created_at, v.updated_at, u.display_name AS by
      FROM playbook_versions v LEFT JOIN users u ON u.id = v.created_by_user_id
     WHERE v.tenant_id = app.tenant_id() AND v.playbook_id = ${playbookId} ORDER BY v.version_no`.execute(tx);
  return r.rows.map((v) => ({ id: v.id, versionNo: v.version_no, steps: v.steps, sha: v.sha, status: v.status, narrows: v.narrows, createdAt: v.created_at, updatedAt: v.updated_at, createdBy: v.by }));
}

async function decisionsOf(tx: Tx, playbookId: string): Promise<DecisionRow[]> {
  const r = await sql<{ v: string; decision: 'approve' | 'revoke'; by: string | null; role: string; at: Date }>`
    SELECT pa.playbook_version_id AS v, pa.decision, u.display_name AS by, pa.decided_by_role AS role, pa.decided_at AS at
      FROM playbook_approvals pa JOIN playbook_versions pv ON pv.tenant_id = pa.tenant_id AND pv.id = pa.playbook_version_id
      LEFT JOIN users u ON u.id = pa.decided_by_user_id
     WHERE pa.tenant_id = app.tenant_id() AND pv.playbook_id = ${playbookId} ORDER BY pa.decided_at DESC, pa.id DESC`.execute(tx);
  return r.rows.map((d) => ({ versionId: d.v, decision: d.decision, by: d.by, role: d.role, at: d.at }));
}

/** The holding lines are checked as the assistant's own words are: with the team's identity (content.ts LINE_GUARD). */
async function identityOf(tx: Tx) {
  const r = await sql<{ b: string; t: string | null; p: string | null }>`SELECT brokerage_legal_name AS b, team_name AS t, brokerage_postal_address AS p FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const s = r.rows[0]!;
  return { brokerageLegalName: s.b, teamName: s.t ?? s.b, agentFirstName: null, scope: 'team' as const, allowedLinkHosts: [], brokeragePostalAddress: s.p };
}

async function issuesOf(tx: Tx, content: unknown): Promise<PolicyIssueWords[]> {
  return validateAiIsaContent(content, { identity: await identityOf(tx) }).map((i) => policyIssueWords(i, content));
}

/**
 * What approving `next` does: against the version approved now (`approved`, null when none is), and whether any
 * decision was ever recorded (an approval that was then revoked). An approved version whose stored content no longer
 * parses cannot be shown to be narrowed by anything: wider.
 */
function effectOf(approved: { content: AiIsaContent | null } | null, hadDecision: boolean, next: AiIsaContent): PolicyApprovalEffect {
  if (approved === null) return hadDecision ? 'after_revoke' : 'first';
  return approved.content !== null && narrowsPrevious(approved.content, next) ? 'narrower' : 'wider';
}

const EFFECT_SENTENCE: Record<PolicyApprovalEffect, string> = {
  first: 'Nothing is approved yet, so approving this pauses nothing. Agents can opt in once it is approved.',
  narrower: 'This version lets the assistant do no more than the approved one. AI care continues under it at once.',
  wider: 'This version lets the assistant do more than the approved one. Approving it pauses AI care for every lead until each agent re-confirms.',
  after_revoke: 'The last approved version was revoked. AI care stays paused for every lead until each agent re-confirms on this version.',
};

/** The widening banner (the brief's wording): what is added, then what approving does. */
export function widerBanner(d: PolicyDiff): string {
  const what = d.adds.length === 0 ? '' : `: it ${d.adds.length === 1 ? d.adds[0]! : `${d.adds.slice(0, -1).join('; ')}; and ${d.adds.at(-1)!}`}`;
  return `This version lets the assistant do more than the approved one${what.replace(/^: it may /, ': it may now ')}. Approving it pauses AI care for every lead until each agent re-confirms.`;
}

const iso = (d: Date) => d.toISOString();
const ROLE_WORD: Record<string, string> = { owner: 'Owner', admin: 'Admin' };

function versionView(v: VersionRow, content: AiIsaContent | null, d: DecisionRow | null) {
  return {
    versionId: v.id,
    versionNo: v.versionNo,
    contentSha256: v.sha,
    content,
    sections: content ? policySections(content) : [],
    decidedAt: d ? iso(d.at) : null,
    decidedBy: d ? (d.by ?? 'A former member') : null,
    decidedByRole: d ? (ROLE_WORD[d.role] ?? d.role) : null,
  };
}

export async function policyViewInTx(tx: Tx, actor: UserActor) {
  const owner = actor.role === 'owner';
  const admin = actor.role === 'admin';
  const counts = await sql<{ live: number; agents: number }>`SELECT (SELECT count(*)::int FROM ai_isa_assignments WHERE tenant_id = app.tenant_id() AND ended_at IS NULL) AS live,
    (SELECT count(*)::int FROM ai_isa_agent_optins WHERE tenant_id = app.tenant_id() AND status = 'active') AS agents`.execute(tx);
  const base = { fields: AI_ISA_POLICY_FIELDS.map((f) => ({ ...f, path: [...f.path], options: f.options ? [...f.options] : undefined, locked: f.locked ? [...f.locked] : undefined })),
    textVersion: AI_ISA_POLICY_TEXT_VERSION, underCare: counts.rows[0]!.live, optedIn: counts.rows[0]!.agents };
  const pb = await policyPlaybookId(tx);
  if (pb === null) {
    return { ...base, state: 'none' as PolicyState, sentence: 'Your team has no AI assistant policy yet. Nothing is sent by the assistant, and no agent can opt in, until one is approved.',
      approved: null, revoked: null, draft: null, revokeText: null, can: { create: owner || admin, saveDraft: false, approve: false, revoke: false }, approveOwnerOnly: !owner };
  }
  const versions = await versionsOf(tx, pb);
  const decisions = await decisionsOf(tx, pb);
  const latest = (id: string, kind: 'approve' | 'revoke') => decisions.find((d) => d.versionId === id && d.decision === kind) ?? null;
  const approvedRow = versions.find((v) => v.status === 'approved') ?? null;
  const draftRow = versions.at(-1)?.status === 'draft' ? versions.at(-1)! : null;
  const revokedRow = approvedRow ? null : ([...versions].reverse().find((v) => v.status === 'revoked') ?? null);
  const approved = approvedRow ? parseAiIsaContent(approvedRow.steps) : null;
  const draftContent = draftRow ? ((draftRow.steps ?? null) as AiIsaContent | null) : null;
  const issues = draftRow ? await issuesOf(tx, draftRow.steps) : [];
  const valid = draftRow !== null && issues.length === 0;
  const effect = valid ? effectOf(approvedRow ? { content: approved } : null, decisions.length > 0, draftContent!) : null;
  const diff = valid && approved !== null ? policyDiff(approved, draftContent!) : null;
  const state: PolicyState = approvedRow ? (draftRow ? 'approved_with_draft' : 'approved') : revokedRow ? (draftRow ? 'revoked_with_draft' : 'revoked') : 'draft_only';
  const sentence = state === 'approved' ? `Version ${approvedRow!.versionNo} is approved and in use.`
    : state === 'approved_with_draft' ? `Version ${approvedRow!.versionNo} is approved and in use. Version ${draftRow!.versionNo} is a draft: it changes nothing until the Owner approves it.`
    : state === 'draft_only' ? `Version ${draftRow?.versionNo ?? 1} is a draft. Nothing is sent by the assistant, and no agent can opt in, until the Owner approves it.`
    : state === 'revoked' ? `Version ${revokedRow!.versionNo} was revoked. AI care is paused for every lead. Save and approve a new version to let agents re-confirm.`
    : `Version ${revokedRow!.versionNo} was revoked and AI care is paused for every lead. Version ${draftRow!.versionNo} is a draft: care stays paused until the Owner approves it and each agent re-confirms.`;
  return {
    ...base,
    state,
    sentence,
    approved: approvedRow ? versionView(approvedRow, approved, latest(approvedRow.id, 'approve')) : null,
    revoked: revokedRow ? versionView(revokedRow, parseAiIsaContent(revokedRow.steps), latest(revokedRow.id, 'revoke')) : null,
    draft: draftRow ? {
      versionId: draftRow.id, versionNo: draftRow.versionNo, contentSha256: draftRow.sha, content: draftRow.steps as Record<string, unknown>, sections: valid ? policySections(draftContent!) : [],
      savedAt: iso(draftRow.updatedAt), savedBy: draftRow.createdBy ?? 'A former member', issues, effect,
      effectSentence: effect === null ? 'This draft cannot be approved until the marked values are fixed.' : effect === 'wider' && diff ? widerBanner(diff) : EFFECT_SENTENCE[effect],
      diff, approvalText: effect === null ? null : aiIsaPolicyApprovalText({ versionNo: draftRow.versionNo, contentSha256: draftRow.sha, effect }),
    } : null,
    revokeText: approvedRow ? aiIsaPolicyRevokeText({ versionNo: approvedRow.versionNo, contentSha256: approvedRow.sha }) : null,
    can: { create: false, saveDraft: owner || admin, approve: owner && valid, revoke: (owner || admin) && approvedRow !== null },
    approveOwnerOnly: !owner,
  };
}

export type PolicyView = Awaited<ReturnType<typeof policyViewInTx>>;

/**
 * POST /admin/ai-isa/policy: the team's one policy, born as a draft of the shipped default. A second create returns the
 * existing policy unchanged (`created: false`): there is never a second ai_isa playbook to choose between.
 */
export async function createPolicy(actor: UserActor, deps: IsaDeps): Promise<{ created: boolean; policy: PolicyView }> {
  return withTenantTx(actor, async (tx) => {
    await lockPolicy(tx);
    if ((await policyPlaybookId(tx)) !== null) return { created: false, policy: await policyViewInTx(tx, actor) };
    const id = deps.ids.next<'PlaybookId'>() as string;
    const versionId = deps.ids.next<'PlaybookVersionId'>() as string;
    const steps = DEFAULT_AI_ISA_CONTENT;
    await sql`INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name, template_key) VALUES (app.tenant_id(), ${id}, 'ai_isa', 'team', NULL, ${POLICY_NAME}, NULL)`.execute(tx);
    await sql`INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id)
      VALUES (app.tenant_id(), ${versionId}, ${id}, 1, ${JSON.stringify(steps)}::jsonb, '{}'::jsonb, ${policySha(steps)}, 'draft', ${actor.userId})`.execute(tx);
    await audit(tx, actor, { action: 'ai_isa.policy_created', entity: { type: 'playbook_version', id: versionId }, reason: 'from_default' });
    return { created: true, policy: await policyViewInTx(tx, actor) };
  }, { db: deps.db, retries: 2 });
}

/**
 * PUT /admin/ai-isa/policy/draft: a change is saved as a draft version (the existing draft is replaced in place; with
 * none, the next version number is born a draft). The approved version keeps running untouched. Content the validator
 * refuses is not saved: 422 with one reason per field.
 */
export async function savePolicyDraft(actor: UserActor, deps: IsaDeps, content: unknown): Promise<PolicyView> {
  return withTenantTx(actor, async (tx) => {
    await lockPolicy(tx);
    const pb = await policyPlaybookId(tx);
    if (pb === null) throw new AppError('AI_ISA_POLICY_MISSING');
    const issues = await issuesOf(tx, content);
    if (issues.length > 0) throw new AppError('AI_ISA_POLICY_INVALID', { issues: issues.slice(0, 40) });
    const steps = parseAiIsaContent(content)!;
    const sha = policySha(steps);
    const versions = await versionsOf(tx, pb);
    const last = versions.at(-1);
    let versionId: string;
    if (last && last.status === 'draft') {
      versionId = last.id;
      await sql`UPDATE playbook_versions SET steps = ${JSON.stringify(steps)}::jsonb, tone = '{}'::jsonb, content_sha256 = ${sha}, updated_at = now(), created_by_user_id = ${actor.userId}
        WHERE tenant_id = app.tenant_id() AND id = ${last.id} AND status = 'draft'`.execute(tx);
    } else {
      versionId = deps.ids.next<'PlaybookVersionId'>() as string;
      await sql`INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id)
        VALUES (app.tenant_id(), ${versionId}, ${pb}, ${(last?.versionNo ?? 0) + 1}, ${JSON.stringify(steps)}::jsonb, '{}'::jsonb, ${sha}, 'draft', ${actor.userId})`.execute(tx);
    }
    await audit(tx, actor, { action: 'ai_isa.policy_draft_saved', entity: { type: 'playbook_version', id: versionId }, reason: `content:${sha.slice(0, 16)}` });
    return policyViewInTx(tx, actor);
  }, { db: deps.db, retries: 2 });
}

export interface PolicyDecisionInput {
  versionId: string;
  contentSha256: string;
  attestation: string;
}

/** Wakes the sweep so link 4's pause reaches every assignment now rather than within five minutes. It sends nothing. */
async function wakeSweep(tx: Tx, versionId: string, why: 'approved' | 'revoked'): Promise<void> {
  await enqueueJob(tx, { queue: 'default', kind: 'ai_isa.sweep', payload: {}, dedupeKey: `ai_isa.sweep:policy_${why}:${versionId}` });
}

async function liveCare(tx: Tx): Promise<{ care: number; agents: number }> {
  const r = await sql<{ care: number; agents: number }>`SELECT count(*)::int AS care, count(DISTINCT owner_user_id)::int AS agents FROM ai_isa_assignments WHERE tenant_id = app.tenant_id() AND ended_at IS NULL`.execute(tx);
  return r.rows[0]!;
}

/**
 * POST /admin/ai-isa/policy/approve (the Owner, re-authenticated). The approver accepts the exact text the server
 * served for this version and effect; the row records who, their role, the content hash and that text. `effect` is
 * computed here, under the policy lock, from the version approved at this instant.
 */
export async function approvePolicy(actor: UserActor, deps: IsaDeps, input: PolicyDecisionInput) {
  return withTenantTx(actor, async (tx, now) => {
    await lockPolicy(tx);
    const pb = await policyPlaybookId(tx);
    const versions = pb === null ? [] : await versionsOf(tx, pb);
    const v = versions.find((x) => x.id === input.versionId);
    if (pb === null || !v) throw new AppError('NOT_FOUND');
    const decisions = await decisionsOf(tx, pb);
    const previous = versions.find((x) => x.status === 'approved') ?? null;
    if (v.status === 'approved' && v.sha === input.contentSha256) {
      // a repeated tap: the stored decision, nothing written
      const before = [...versions].reverse().find((x) => x.versionNo < v.versionNo && x.status !== 'draft') ?? null;
      const effect: PolicyApprovalEffect = v.narrows === true ? 'narrower' : before === null ? 'first' : before.status === 'superseded' ? 'wider' : 'after_revoke';
      return { ...(await outcome(tx, actor, effect, effect === 'narrower' || effect === 'first' ? { care: 0, agents: 0 } : await liveCareOff(tx, v.id))), replayed: true };
    }
    if (v.status !== 'draft') throw new AppError('PLAYBOOK_VERSION_NOT_DRAFT', { status: v.status });
    if (v.sha !== input.contentSha256) throw new AppError('PLAYBOOK_HASH_MISMATCH');
    const issues = await issuesOf(tx, v.steps);
    if (issues.length > 0) throw new AppError('AI_ISA_POLICY_INVALID', { issues: issues.slice(0, 40) });
    const next = parseAiIsaContent(v.steps)!;
    const effect = effectOf(previous ? { content: parseAiIsaContent(previous.steps) } : null, decisions.length > 0, next);
    if (input.attestation !== aiIsaPolicyApprovalText({ versionNo: v.versionNo, contentSha256: v.sha, effect })) throw new AppError('AI_ISA_POLICY_ATTESTATION_MISMATCH');
    const paused = effect === 'narrower' || effect === 'first' ? { care: 0, agents: 0 } : await liveCare(tx);
    await sql`INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at)
      VALUES (app.tenant_id(), ${deps.ids.next<'PlaybookApprovalId'>() as string}, ${v.id}, 'approve', ${actor.userId}, ${actor.role}, ${v.sha}, ${input.attestation}, ${new Date(now)})`.execute(tx);
    if (previous) await sql`UPDATE playbook_versions SET status = 'superseded' WHERE tenant_id = app.tenant_id() AND id = ${previous.id}`.execute(tx);
    // narrows_previous is written once, here, with the status (V11): true only when core says this version narrows the
    // one it supersedes; anything else (no previous, a revoke before it, a wider version) is not a narrowing
    await sql`UPDATE playbook_versions SET status = 'approved', narrows_previous = ${effect === 'narrower'} WHERE tenant_id = app.tenant_id() AND id = ${v.id}`.execute(tx);
    await audit(tx, actor, { action: 'ai_isa.policy_approved', entity: { type: 'playbook_version', id: v.id }, reason: `${effect}:${v.sha.slice(0, 16)}${previous ? `:supersedes:${previous.id}` : ''}` });
    if (effect === 'wider') await wakeSweep(tx, v.id, 'approved');
    return { ...(await outcome(tx, actor, effect, paused)), replayed: false };
  }, { db: deps.db, retries: 2 });
}

/** Live care bound to any version but `versionId` (what a wider or post-revoke approval leaves paused). */
async function liveCareOff(tx: Tx, versionId: string): Promise<{ care: number; agents: number }> {
  const r = await sql<{ care: number; agents: number }>`SELECT count(*)::int AS care, count(DISTINCT owner_user_id)::int AS agents FROM ai_isa_assignments
    WHERE tenant_id = app.tenant_id() AND ended_at IS NULL AND playbook_version_id <> ${versionId}`.execute(tx);
  return r.rows[0]!;
}

async function outcome(tx: Tx, actor: UserActor, effect: PolicyApprovalEffect, paused: { care: number; agents: number }) {
  const careContinues = effect === 'narrower' || effect === 'first';
  const people = (k: number) => `${k} ${k === 1 ? 'person' : 'people'}`;
  const agents = (k: number) => `${k} ${k === 1 ? 'agent' : 'agents'}`;
  const sentence = effect === 'first' ? 'Approved. Agents can now opt in. Nothing was sent to anyone.'
    : effect === 'narrower' ? 'Approved. AI care continues under the narrower rules from now. Nothing was sent to anyone.'
    : effect === 'wider' ? `Approved. AI care is paused for ${people(paused.care)} until ${paused.agents === 1 ? 'their agent re-confirms' : `each of ${agents(paused.agents)} re-confirms`}. Nothing was sent to anyone.`
    : `Approved. AI care stays paused for ${people(paused.care)} until ${paused.agents === 1 ? 'their agent re-confirms' : `each of ${agents(paused.agents)} re-confirms`}. Nothing was sent to anyone.`;
  return { effect, careContinues, pausedCare: paused.care, agentsToReconfirm: paused.agents, sentence, policy: await policyViewInTx(tx, actor) };
}

/**
 * POST /admin/ai-isa/policy/revoke (Owner or Admin: stopping is never the Owner's alone, as with the team switch). The
 * version is revoked at once, so the send guard refuses the assistant's messages from this instant and link 4 pauses
 * every assignment `approval_revoked` at its next check. Nothing is sent to anyone.
 */
export async function revokePolicy(actor: UserActor, deps: IsaDeps, input: PolicyDecisionInput) {
  return withTenantTx(actor, async (tx, now) => {
    await lockPolicy(tx);
    const pb = await policyPlaybookId(tx);
    const versions = pb === null ? [] : await versionsOf(tx, pb);
    const v = versions.find((x) => x.id === input.versionId);
    if (pb === null || !v) throw new AppError('NOT_FOUND');
    const paused = await liveCare(tx);
    const sentence = `Revoked. AI care is paused for ${paused.care} ${paused.care === 1 ? 'person' : 'people'}, and the assistant sends nothing more. Nothing was sent to anyone about this.`;
    if (v.status === 'revoked') return { pausedCare: paused.care, sentence, replayed: true, policy: await policyViewInTx(tx, actor) };
    if (v.status !== 'approved') throw new AppError('PLAYBOOK_NOT_APPROVED', { status: v.status });
    if (v.sha !== input.contentSha256) throw new AppError('PLAYBOOK_HASH_MISMATCH');
    if (input.attestation !== aiIsaPolicyRevokeText({ versionNo: v.versionNo, contentSha256: v.sha })) throw new AppError('AI_ISA_POLICY_ATTESTATION_MISMATCH');
    await sql`INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at)
      VALUES (app.tenant_id(), ${deps.ids.next<'PlaybookApprovalId'>() as string}, ${v.id}, 'revoke', ${actor.userId}, ${actor.role}, ${v.sha}, ${input.attestation}, ${new Date(now)})`.execute(tx);
    await sql`UPDATE playbook_versions SET status = 'revoked' WHERE tenant_id = app.tenant_id() AND id = ${v.id}`.execute(tx);
    await audit(tx, actor, { action: 'ai_isa.policy_revoked', entity: { type: 'playbook_version', id: v.id }, reason: `content:${v.sha.slice(0, 16)}` });
    await wakeSweep(tx, v.id, 'revoked');
    return { pausedCare: paused.care, sentence, replayed: false, policy: await policyViewInTx(tx, actor) };
  }, { db: deps.db, retries: 2 });
}

/**
 * The agent's view of the approved policy: its words by section, and what changed since the version they attested to
 * (GET /me/ai-isa). `state` is link 4's own answer for the version their opt-in is bound to.
 */
export async function policyForAgent(tx: Tx, current: { versionId: string; steps: unknown } | null, optInVersionId: string | null, optInVersionState: 'approved' | 'narrowed' | 'widened' | 'revoked' | 'missing' | null): Promise<{
  versionNo: number | null; sections: PolicySectionWords[]; change: { state: 'narrowed' | 'widened' | 'revoked'; fromVersionNo: number | null; diff: PolicyDiff | null; sentence: string } | null }> {
  const content = current ? parseAiIsaContent(current.steps) : null;
  const no = async (id: string) => (await sql<{ n: number; steps: unknown }>`SELECT version_no AS n, steps FROM playbook_versions WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx)).rows[0] ?? null;
  const cur = current ? await no(current.versionId) : null;
  const base = { versionNo: cur?.n ?? null, sections: content ? policySections(content) : [] };
  if (optInVersionId === null || optInVersionState === null || optInVersionState === 'approved' || optInVersionState === 'missing' || (current !== null && optInVersionId === current.versionId)) return { ...base, change: null };
  const mine = await no(optInVersionId);
  const mineContent = mine ? parseAiIsaContent(mine.steps) : null;
  const diff = content && mineContent ? policyDiff(mineContent, content) : null;
  const sentence = optInVersionState === 'narrowed'
    ? 'The team narrowed the AI rules since you confirmed them. AI care for your leads continues under the narrower rules. To start AI care for another lead, confirm the current version.'
    : optInVersionState === 'widened'
      ? 'The team changed the AI rules since you confirmed them, and the new version lets the assistant do more. AI care for your leads is paused until you confirm it.'
      : current === null
        ? 'The team revoked the AI rules you confirmed. AI care for your leads is paused, and nothing is sent, until a new version is approved and you confirm it.'
        : 'The team revoked the AI rules you confirmed and approved a new version. AI care for your leads is paused until you confirm it.';
  return { ...base, change: { state: optInVersionState, fromVersionNo: mine?.n ?? null, diff, sentence } };
}
