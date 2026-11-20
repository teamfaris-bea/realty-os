// The team AI policy through its own routes (R-ISA-33, R-ISA-34; E1000 to E1006; docs/AI_ISA.md §3.2). Real Postgres via
// the API harness; fakes only (no real model, send, call or vendor). No playbook, version or approval row in this file
// is written by the superuser pool: the superuser clears counsel's pack and reads back, nothing else.
import { DEFAULT_AI_ISA_CONTENT, aiIsaPolicyApprovalText, aiIsaPolicyRevokeText } from '@realty/core/isa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staleReauth } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { commsWorld, type CommsWorld } from '../comms/testing.js';
import { FakeIsaAi } from '../providers/fake/isaAi.js';
import type { AiProvider } from '../providers/types.js';
import { aiMessages, assignmentOf, call, freshReauth, isaLead, optInAgent, runIsa, startCare, sweepNow } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let admin: TestClient;
let isa: TestClient;
let tc: TestClient;

interface Draft { versionId: string; versionNo: number; contentSha256: string; content: Record<string, unknown>; issues: { field: string | null; sentence: string }[]; effect: string | null; effectSentence: string;
  diff: { adds: string[]; removes: string[]; rewords: string[]; wider: boolean } | null; approvalText: string | null }
interface Version { versionId: string; versionNo: number; contentSha256: string; content: Record<string, unknown>; sections: { key: string; may: string[]; mayNot: string[] }[]; decidedBy: string | null; decidedByRole: string | null }
interface View { state: string; sentence: string; approved: Version | null; revoked: Version | null; draft: Draft | null; revokeText: string | null; underCare: number; optedIn: number;
  can: { create: boolean; saveDraft: boolean; approve: boolean; revoke: boolean }; fields: { key: string }[] }
interface Decision { effect: string; careContinues: boolean; pausedCare: number; agentsToReconfirm: number; sentence: string; replayed: boolean; policy: View }

const view = async (c: TestClient) => (await call<View>(c, 'GET', '/admin/ai-isa/policy')).body;
const D = DEFAULT_AI_ISA_CONTENT as unknown as Record<string, unknown>;
const DENIED = [403, 404];

async function saveDraft(c: TestClient, content: Record<string, unknown>) {
  await freshReauth(h, c);
  return call<View>(c, 'PUT', '/admin/ai-isa/policy/draft', { content });
}
async function approve(c: TestClient, d: Draft, o: { attestation?: string } = {}) {
  await freshReauth(h, c);
  return call<Decision>(c, 'POST', '/admin/ai-isa/policy/approve', { versionId: d.versionId, contentSha256: d.contentSha256, attestation: o.attestation ?? d.approvalText });
}
const policyRows = async (tenantId: string) => (await h.su.query<{ playbooks: number; versions: number; approvals: number }>(`SELECT
  (SELECT count(*)::int FROM playbooks WHERE tenant_id = $1 AND kind = 'ai_isa') AS playbooks,
  (SELECT count(*)::int FROM playbook_versions v JOIN playbooks p ON p.id = v.playbook_id WHERE v.tenant_id = $1 AND p.kind = 'ai_isa') AS versions,
  (SELECT count(*)::int FROM playbook_approvals a JOIN playbook_versions v ON v.id = a.playbook_version_id JOIN playbooks p ON p.id = v.playbook_id WHERE a.tenant_id = $1 AND p.kind = 'ai_isa') AS approvals`, [tenantId])).rows[0]!;
const audits = async (tenantId: string, action: string) => (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = $2`, [tenantId, action])).rows[0]!.n;
const outbound = async (tenantId: string) => (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND direction = 'outbound'`, [tenantId])).rows[0]!.n;
const link4 = async (agent: TestClient, contactId: string) => (await call<{ chain: { link: number; effect: string; code: string | null; sentence: string }[] }>(agent, 'GET', `/contacts/${contactId}/ai-isa`)).body.chain.find((l) => l.link === 4)!;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true, others: ['admin', 'isa', 'tc'] });
  [admin, isa, tc] = w.others as [TestClient, TestClient, TestClient];
  // counsel's review is never application code's to write: the superuser records it for the fixture, as the command would
  await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:ai_isa'`);
  await h.su.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = $1`, [w.tenantId]);
  await freshReauth(h, w.owner);
  const on = await call(w.owner, 'PUT', '/admin/ai-isa', { enabled: true, dailyCap: 100, attestation: 'I turn on the AI assistant for my team and accept the engineering defaults.' });
  expect(on.status).toBe(200);
  (h.providers as { ai: AiProvider }).ai = new FakeIsaAi();
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-ISA-33 create and draft (E1000)', () => {
  it('with no policy the page says so, nothing can be approved, and nobody can opt in', async () => {
    const v = await view(w.owner);
    expect(v).toMatchObject({ state: 'none', approved: null, draft: null, revokeText: null, can: { create: true, saveDraft: false, approve: false, revoke: false } });
    expect(v.sentence).toBe('Your team has no AI assistant policy yet. Nothing is sent by the assistant, and no agent can opt in, until one is approved.');
    expect(v.fields.map((f) => f.key)).toContain('caps.ai24h');
    const me = await call<{ policy: unknown; sentence: string }>(w.agents[0]!, 'GET', '/me/ai-isa');
    expect(me.body.policy).toBeNull();
    expect(await policyRows(w.tenantId)).toEqual({ playbooks: 0, versions: 0, approvals: 0 });
  });

  it('an Agent, ISA, TC or Team Lead cannot read, create, draft, approve or revoke', async () => {
    for (const c of [w.agents[0]!, isa, tc, w.teamLead!]) {
      await freshReauth(h, c);
      expect(DENIED, 'read').toContain((await call(c, 'GET', '/admin/ai-isa/policy')).status);
      expect(DENIED, 'create').toContain((await call(c, 'POST', '/admin/ai-isa/policy', {})).status);
      expect(DENIED, 'draft').toContain((await call(c, 'PUT', '/admin/ai-isa/policy/draft', { content: D })).status);
      expect(DENIED, 'approve').toContain((await call(c, 'POST', '/admin/ai-isa/policy/approve', { versionId: w.tenantId, contentSha256: 'a'.repeat(64), attestation: 'x'.repeat(20) })).status);
      expect(DENIED, 'revoke').toContain((await call(c, 'POST', '/admin/ai-isa/policy/revoke', { versionId: w.tenantId, contentSha256: 'a'.repeat(64), attestation: 'x'.repeat(20) })).status);
    }
    expect(await policyRows(w.tenantId)).toEqual({ playbooks: 0, versions: 0, approvals: 0 });
  });

  it('the Owner creates it only after re-authenticating; it is born a draft of the shipped default; a second create returns the same policy', async () => {
    await staleReauth(h, w.owner);
    const stale = await call(w.owner, 'POST', '/admin/ai-isa/policy', {});
    expect(stale).toMatchObject({ status: 401, code: 'REAUTH_REQUIRED' });
    await freshReauth(h, w.owner);
    const [a, b] = await Promise.all([call<{ created: boolean; policy: View }>(w.owner, 'POST', '/admin/ai-isa/policy', {}), call<{ created: boolean; policy: View }>(w.owner, 'POST', '/admin/ai-isa/policy', {})]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
    const again = await call<{ created: boolean; policy: View }>(w.owner, 'POST', '/admin/ai-isa/policy', {});
    expect(again.body.created).toBe(false);
    expect(again.body.policy.draft!.versionId).toBe(a.body.policy.draft!.versionId);
    expect(await policyRows(w.tenantId)).toEqual({ playbooks: 1, versions: 1, approvals: 0 });
    const v = again.body.policy;
    expect(v).toMatchObject({ state: 'draft_only', approved: null, can: { create: false, saveDraft: true, approve: true, revoke: false } });
    expect(v.draft).toMatchObject({ versionNo: 1, content: D, issues: [], effect: 'first', diff: null });
    expect(v.draft!.approvalText).toBe(aiIsaPolicyApprovalText({ versionNo: 1, contentSha256: v.draft!.contentSha256, effect: 'first' }));
    expect(await audits(w.tenantId, 'ai_isa.policy_created')).toBe(1);
    // a draft authorizes nothing: link 4 has no approved version
    await freshReauth(h, w.agents[0]!);
    expect((await call(w.agents[0]!, 'PUT', '/me/ai-isa/opt-in', { versionId: v.draft!.versionId, capabilities: ['converse'], channels: ['sms'], timezone: 'America/New_York', availability: [], bookingKinds: [] })).code).toBe('AI_ISA_POLICY_NOT_APPROVED');
  });

  it('content the validator refuses is not saved, with one reason per field in words; a valid change replaces the draft', async () => {
    const before = await view(w.owner);
    const bad = await saveDraft(w.owner, { ...D, caps: { ...(D.caps as object), ai24h: 4 }, capabilities: ['converse', 'share_value_estimate'], window: { startSec: 7 * 3600, endSec: 20 * 3600 } });
    expect(bad).toMatchObject({ status: 422, code: 'AI_ISA_POLICY_INVALID' });
    const issues = (bad.body as unknown as { error: { details: { issues: { field: string; sentence: string }[] } } }).error.details.issues;
    expect(issues.map((i) => i.field).sort()).toEqual(['capabilities', 'caps.ai24h', 'window.startSec']);
    expect(issues.find((i) => i.field === 'caps.ai24h')!.sentence).toBe('At most 3: the platform’s limit.');
    expect((await view(w.owner)).draft!.contentSha256).toBe(before.draft!.contentSha256);
    await staleReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/admin/ai-isa/policy/draft', { content: D })).code).toBe('REAUTH_REQUIRED');
    const ok = await saveDraft(w.owner, { ...D, cadence: '7d' });
    expect(ok.status).toBe(200);
    expect(ok.body.draft).toMatchObject({ versionId: before.draft!.versionId, versionNo: 1, effect: 'first' });
    expect(ok.body.draft!.contentSha256).not.toBe(before.draft!.contentSha256);
    expect(await policyRows(w.tenantId)).toEqual({ playbooks: 1, versions: 1, approvals: 0 });
    expect(await audits(w.tenantId, 'ai_isa.policy_draft_saved')).toBe(1);
  });

  it('an Admin can save a draft and cannot approve it; the generic playbook routes are no second door', async () => {
    const saved = await saveDraft(admin, D);
    expect(saved.status).toBe(200);
    expect(saved.body.can).toMatchObject({ saveDraft: true, approve: false });
    const d = saved.body.draft!;
    expect(DENIED).toContain((await approve(admin, d)).status);
    const pb = (await h.su.query<{ id: string }>(`SELECT id FROM playbooks WHERE tenant_id = $1 AND kind = 'ai_isa'`, [w.tenantId])).rows[0]!.id;
    await freshReauth(h, w.owner);
    expect(await call(w.owner, 'POST', '/playbooks', { kind: 'ai_isa', scope: 'team', name: 'x', steps: D })).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect((await call(w.owner, 'POST', `/playbooks/${pb}/versions`, { steps: D })).status).toBe(404);
    expect((await call(w.owner, 'POST', `/playbook-versions/${d.versionId}/approve`, { attestation: d.approvalText, contentSha256: d.contentSha256 })).status).toBe(404);
    expect((await call(w.owner, 'POST', `/playbook-versions/${d.versionId}/revoke`, { attestation: d.approvalText, contentSha256: d.contentSha256 })).status).toBe(404);
    expect(await policyRows(w.tenantId)).toEqual({ playbooks: 1, versions: 1, approvals: 0 });
  });
});

describe('R-ISA-34 approve: link 4 passes on the real path (E1001)', () => {
  let lead: Awaited<ReturnType<typeof isaLead>>;

  it('the approval records who, their role, the content hash and the exact text; any other text or hash is refused', async () => {
    const d = (await view(w.owner)).draft!;
    expect((await approve(w.owner, d, { attestation: 'I approve this policy and take responsibility.' })).code).toBe('AI_ISA_POLICY_ATTESTATION_MISMATCH');
    expect((await approve(w.owner, { ...d, contentSha256: 'b'.repeat(64) })).code).toBe('PLAYBOOK_HASH_MISMATCH');
    await staleReauth(h, w.owner);
    expect((await call(w.owner, 'POST', '/admin/ai-isa/policy/approve', { versionId: d.versionId, contentSha256: d.contentSha256, attestation: d.approvalText })).code).toBe('REAUTH_REQUIRED');
    expect(await policyRows(w.tenantId)).toEqual({ playbooks: 1, versions: 1, approvals: 0 });
    const before = await outbound(w.tenantId);
    const r = await approve(w.owner, d);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ effect: 'first', careContinues: true, pausedCare: 0, agentsToReconfirm: 0, replayed: false, sentence: 'Approved. Agents can now opt in. Nothing was sent to anyone.' });
    expect(r.body.policy).toMatchObject({ state: 'approved', draft: null, approved: { versionId: d.versionId, versionNo: 1, decidedByRole: 'Owner' }, can: { approve: false, revoke: true } });
    expect(r.body.policy.revokeText).toBe(aiIsaPolicyRevokeText({ versionNo: 1, contentSha256: d.contentSha256 }));
    const row = (await h.su.query<{ decision: string; decided_by_user_id: string; decided_by_role: string; content_sha256: string; attestation: string; status: string; narrows_previous: boolean | null }>(
      `SELECT a.decision, a.decided_by_user_id, a.decided_by_role, a.content_sha256, a.attestation, v.status, v.narrows_previous FROM playbook_approvals a JOIN playbook_versions v ON v.id = a.playbook_version_id WHERE v.id = $1`, [d.versionId])).rows;
    expect(row).toEqual([{ decision: 'approve', decided_by_user_id: w.owner.userId, decided_by_role: 'owner', content_sha256: d.contentSha256, attestation: d.approvalText, status: 'approved', narrows_previous: false }]);
    expect(await audits(w.tenantId, 'ai_isa.policy_approved')).toBe(1);
    expect(await outbound(w.tenantId)).toBe(before);
    // the same tap again: the stored decision, nothing written
    const again = await approve(w.owner, d);
    expect(again.body).toMatchObject({ effect: 'first', replayed: true });
    expect(await policyRows(w.tenantId)).toEqual({ playbooks: 1, versions: 1, approvals: 1 });
  });

  it('an agent opts in and starts care through the API, and the chain reports "The team policy is approved."', async () => {
    const me = await call<{ policy: { versionId: string; versionNo: number; sections: { key: string }[] } | null; policyChange: unknown }>(w.agents[0]!, 'GET', '/me/ai-isa');
    expect(me.body.policy).toMatchObject({ versionNo: 1 });
    expect(me.body.policy!.sections.map((s) => s.key)).toContain('does');
    expect(me.body.policyChange).toBeNull();
    await optInAgent(h, w.agents[0]!, me.body.policy!.versionId);
    lead = await isaLead(h, w.agents[0]!);
    expect((await startCare(w.agents[0]!, lead.id)).status).toBe(200);
    expect(await link4(w.agents[0]!, lead.id)).toMatchObject({ effect: 'ok', code: null, sentence: 'The team policy is approved.' });
    await runIsa(h, w.tenantId);
    expect((await assignmentOf(h, lead.id))!.paused_at).toBeNull();
  });

  it('a narrower version takes effect at once: care continues, nobody re-confirms, and the narrower limits apply (E1002)', async () => {
    const saved = await saveDraft(w.owner, { ...D, caps: { ...(D.caps as object), ai24h: 2 } });
    expect(saved.body).toMatchObject({ state: 'approved_with_draft', draft: { versionNo: 2, effect: 'narrower', diff: { adds: [], removes: ['at most 2 AI messages per person in 24 hours (was 3)'], wider: false } } });
    expect(saved.body.draft!.effectSentence).toBe('This version lets the assistant do no more than the approved one. AI care continues under it at once.');
    // the approved version is untouched by the draft
    expect(await link4(w.agents[0]!, lead.id)).toMatchObject({ effect: 'ok' });
    const sent = await outbound(w.tenantId);
    const r = await approve(w.owner, saved.body.draft!);
    expect(r.body).toMatchObject({ effect: 'narrower', careContinues: true, pausedCare: 0, agentsToReconfirm: 0 });
    expect(r.body.sentence).toBe('Approved. AI care continues under the narrower rules from now. Nothing was sent to anyone.');
    const rows = (await h.su.query<{ version_no: number; status: string; narrows_previous: boolean | null }>(`SELECT v.version_no, v.status, v.narrows_previous FROM playbook_versions v JOIN playbooks p ON p.id = v.playbook_id
      WHERE v.tenant_id = $1 AND p.kind = 'ai_isa' ORDER BY v.version_no`, [w.tenantId])).rows;
    expect(rows).toEqual([{ version_no: 1, status: 'superseded', narrows_previous: false }, { version_no: 2, status: 'approved', narrows_previous: true }]);
    expect(await link4(w.agents[0]!, lead.id)).toMatchObject({ effect: 'ok', sentence: 'The team policy is approved.' });
    await sweepNow(h, w.tenantId);
    const a = (await assignmentOf(h, lead.id))!;
    expect(a).toMatchObject({ paused_at: null, ended_at: null });
    // the limit the panel counts against is the narrower version's, though the care is bound to version 1
    const panel = await call<{ capsSentence: string }>(w.agents[0]!, 'GET', `/contacts/${lead.id}/ai-isa`);
    expect(panel.body.capsSentence).toMatch(/ of 2 today$/);
    const me = await call<{ needsReattest: boolean; policyChange: { state: string; fromVersionNo: number; diff: { removes: string[] }; sentence: string } }>(w.agents[0]!, 'GET', '/me/ai-isa');
    expect(me.body.needsReattest).toBe(false);
    expect(me.body.policyChange).toMatchObject({ state: 'narrowed', fromVersionNo: 1, diff: { removes: ['at most 2 AI messages per person in 24 hours (was 3)'] } });
    expect(await outbound(w.tenantId)).toBe(sent);
  });

  it('a wider version says so before approval, pauses care when approved, and care continues only after the agent re-confirms (E1003)', async () => {
    const two = { ...D, caps: { ...(D.caps as object), ai24h: 2 } };
    const saved = await saveDraft(w.owner, { ...two, capabilities: ['converse', 'share_listings'] });
    const d = saved.body.draft!;
    expect(d).toMatchObject({ versionNo: 3, effect: 'wider', diff: { adds: ['may share listings that fit their search'], removes: [], wider: true } });
    expect(d.effectSentence).toBe('This version lets the assistant do more than the approved one: it may now share listings that fit their search. Approving it pauses AI care for every lead until each agent re-confirms.');
    expect(d.approvalText).toContain('AI care pauses for every lead until each agent re-confirms');
    // the text of a narrower approval is not accepted for a wider version
    expect((await approve(w.owner, d, { attestation: aiIsaPolicyApprovalText({ versionNo: 3, contentSha256: d.contentSha256, effect: 'narrower' }) })).code).toBe('AI_ISA_POLICY_ATTESTATION_MISMATCH');
    const sent = await outbound(w.tenantId);
    const r = await approve(w.owner, d);
    expect(r.body).toMatchObject({ effect: 'wider', careContinues: false, pausedCare: 1, agentsToReconfirm: 1 });
    expect(r.body.sentence).toBe('Approved. AI care is paused for 1 person until their agent re-confirms. Nothing was sent to anyone.');
    expect(await link4(w.agents[0]!, lead.id)).toMatchObject({ effect: 'pause', code: 'POLICY_UPDATED', sentence: 'The team updated the AI rules. Re-attest to continue.' });
    // the approval itself woke the sweep: no wait for the periodic one
    await runIsa(h, w.tenantId);
    expect(await assignmentOf(h, lead.id)).toMatchObject({ pause_reason: 'policy_updated', ended_at: null });
    expect((await assignmentOf(h, lead.id))!.paused_at).not.toBeNull();
    const me = await call<{ needsReattest: boolean; policy: { versionId: string }; policyChange: { state: string; diff: { adds: string[] } } }>(w.agents[0]!, 'GET', '/me/ai-isa');
    expect(me.body).toMatchObject({ needsReattest: true, policyChange: { state: 'widened', diff: { adds: ['may share listings that fit their search'] } } });
    expect(await outbound(w.tenantId)).toBe(sent);
    expect((await aiMessages(h, lead.id)).filter((m) => m.status === 'queued' || m.status === 'scheduled')).toEqual([]);
    await freshReauth(h, w.agents[0]!);
    const re = await call<{ continued: { contactId: string }[]; notContinued: unknown[] }>(w.agents[0]!, 'POST', '/me/ai-isa/re-attest', { versionId: me.body.policy.versionId });
    expect(re.body).toMatchObject({ continued: [{ contactId: lead.id }], notContinued: [] });
    expect(await link4(w.agents[0]!, lead.id)).toMatchObject({ effect: 'ok' });
    expect(await assignmentOf(h, lead.id)).toMatchObject({ paused_at: null, ended_at: null });
  });

  it('a revoke by an Admin pauses care at once by the chain’s revoked path, sends nothing, and refuses a start (E1004)', async () => {
    const v = await view(admin);
    expect(v.can).toMatchObject({ revoke: true, approve: false });
    const body = { versionId: v.approved!.versionId, contentSha256: v.approved!.contentSha256, attestation: v.revokeText };
    expect((await call(admin, 'POST', '/admin/ai-isa/policy/revoke', { ...body, attestation: 'Stop the assistant now please.' })).code).toBe('AI_ISA_POLICY_ATTESTATION_MISMATCH');
    const sent = await outbound(w.tenantId);
    const r = await call<{ pausedCare: number; sentence: string; policy: View }>(admin, 'POST', '/admin/ai-isa/policy/revoke', body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pausedCare: 1, policy: { state: 'revoked', approved: null, revoked: { versionNo: 3, decidedByRole: 'Admin' }, can: { create: false, saveDraft: true, approve: false, revoke: false } } });
    expect(r.body.sentence).toBe('Revoked. AI care is paused for 1 person, and the assistant sends nothing more. Nothing was sent to anyone about this.');
    expect(await link4(w.agents[0]!, lead.id)).toMatchObject({ effect: 'pause', code: 'AI_ISA_POLICY_NOT_APPROVED', sentence: 'The team policy approval was revoked.' });
    await runIsa(h, w.tenantId);
    expect(await assignmentOf(h, lead.id)).toMatchObject({ pause_reason: 'approval_revoked', ended_at: null });
    const other = await isaLead(h, w.agents[0]!);
    expect((await startCare(w.agents[0]!, other.id)).code).toBe('AI_ISA_POLICY_NOT_APPROVED');
    expect(await outbound(w.tenantId)).toBe(sent);
    expect(await audits(w.tenantId, 'ai_isa.policy_revoked')).toBe(1);
    const me = await call<{ policy: unknown; policyChange: { state: string } }>(w.agents[0]!, 'GET', '/me/ai-isa');
    expect(me.body).toMatchObject({ policy: null, policyChange: { state: 'revoked' } });
  });

  it('after a revoke, a new approval keeps care paused until the agent re-confirms, even when it allows less (E1005)', async () => {
    const saved = await saveDraft(w.owner, { ...D, channels: ['sms'] });
    expect(saved.body).toMatchObject({ state: 'revoked_with_draft', draft: { versionNo: 4, effect: 'after_revoke', diff: null } });
    const r = await approve(w.owner, saved.body.draft!);
    expect(r.body).toMatchObject({ effect: 'after_revoke', careContinues: false, pausedCare: 1 });
    expect(await link4(w.agents[0]!, lead.id)).toMatchObject({ effect: 'pause' });
    await sweepNow(h, w.tenantId);
    expect((await assignmentOf(h, lead.id))!.paused_at).not.toBeNull();
    const row = (await h.su.query<{ narrows_previous: boolean | null }>(`SELECT narrows_previous FROM playbook_versions WHERE id = $1`, [saved.body.draft!.versionId])).rows[0]!;
    expect(row.narrows_previous).toBe(false);
  });
});

describe('R-ISA-33 tenant isolation (E1006)', () => {
  it('another team reads its own empty policy and cannot approve or revoke this team’s version', async () => {
    const other = await commsWorld(h, { agents: 1 });
    expect((await view(other.owner)).state).toBe('none');
    const mine = await view(w.owner);
    await freshReauth(h, other.owner);
    const body = { versionId: mine.approved!.versionId, contentSha256: mine.approved!.contentSha256, attestation: mine.revokeText };
    expect((await call(other.owner, 'POST', '/admin/ai-isa/policy/revoke', body)).status).toBe(404);
    expect((await call(other.owner, 'POST', '/admin/ai-isa/policy/approve', body)).status).toBe(404);
    expect((await call(other.owner, 'PUT', '/admin/ai-isa/policy/draft', { content: D })).code).toBe('AI_ISA_POLICY_MISSING');
    expect((await view(w.owner)).approved!.versionId).toBe(mine.approved!.versionId);
    expect(await policyRows(other.tenantId)).toEqual({ playbooks: 0, versions: 0, approvals: 0 });
  });
});
