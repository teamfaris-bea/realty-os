// The ISA test world's policy is the application's own work (R-ISA-33, R-ISA-34): created and approved by the Owner
// through the policy routes, never inserted by the superuser pool. Every suite built on isaWorld or sellerWorld
// therefore runs the consent chain's link 4 against rows the routes wrote.
import { contentSha256 } from '@realty/core/assistant';
import { aiIsaPolicyApprovalText } from '@realty/core/isa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { SELLER_CAPS, sellerWorld } from './seller/testing.js';
import { call, isaLead, isaWorld, startCare } from './testing.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const rowsOf = async (tenantId: string) => (await h.su.query<{ id: string; version_no: number; status: string; steps: { capabilities: string[] }; content_sha256: string; narrows_previous: boolean | null; decision: string; decided_by_user_id: string;
  decided_by_role: string; approval_sha: string; attestation: string }>(`SELECT v.id, v.version_no, v.status, v.steps, v.content_sha256, v.narrows_previous, a.decision, a.decided_by_user_id, a.decided_by_role, a.content_sha256 AS approval_sha, a.attestation
    FROM playbooks p JOIN playbook_versions v ON v.playbook_id = p.id LEFT JOIN playbook_approvals a ON a.playbook_version_id = v.id WHERE p.tenant_id = $1 AND p.kind = 'ai_isa'`, [tenantId])).rows;

describe('the ISA test world builds its policy on the real path', () => {
  it('isaWorld: one policy, approved by the Owner with the served text over the exact content, audited; link 4 passes', async () => {
    const w = await isaWorld(h);
    const rows = await rowsOf(w.tenantId);
    expect(rows).toHaveLength(1);
    const v = rows[0]!;
    expect(v).toMatchObject({ id: w.versionId, version_no: 1, status: 'approved', decision: 'approve', decided_by_user_id: w.owner.userId, decided_by_role: 'owner', content_sha256: w.versionSha, approval_sha: w.versionSha });
    expect(v.content_sha256).toBe(contentSha256(v.steps as never, {}));
    expect(v.attestation).toBe(aiIsaPolicyApprovalText({ versionNo: 1, contentSha256: w.versionSha, effect: 'first' }));
    const audit = (await h.su.query<{ action: string; actor_user_id: string | null }>(`SELECT action, actor_user_id FROM audit_log WHERE tenant_id = $1 AND action LIKE 'ai_isa.policy_%' ORDER BY occurred_at, action`, [w.tenantId])).rows;
    expect(audit.map((a) => a.action).sort()).toEqual(['ai_isa.policy_approved', 'ai_isa.policy_created']);
    expect(new Set(audit.map((a) => a.actor_user_id))).toEqual(new Set([w.owner.userId]));
    const lead = await isaLead(h, w.agents[0]!);
    expect((await startCare(w.agents[0]!, lead.id)).status).toBe(200);
    const panel = await call<{ chain: { link: number; effect: string; sentence: string }[] }>(w.agents[0]!, 'GET', `/contacts/${lead.id}/ai-isa`);
    expect(panel.body.chain.find((l) => l.link === 4)).toMatchObject({ effect: 'ok', sentence: 'The team policy is approved.' });
  });

  it('sellerWorld: the seller capabilities are in the version the Owner approved, not written over it afterwards', async () => {
    const w = await sellerWorld(h);
    const rows = await rowsOf(w.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.steps.capabilities).toEqual(SELLER_CAPS);
    expect(rows[0]!.content_sha256).toBe(contentSha256(rows[0]!.steps as never, {}));
  });
});
