// The team AI policy is read only through its own routes (R-ISA-36; E1009; review fix F1). The generic playbook reads
// (GET /playbooks, GET /playbooks/:id), and every other read that returns a playbook version's content, never return a
// playbook of kind ai_isa to anyone: the Owner and Admin read it at GET /admin/ai-isa/policy, an agent reads the approved
// version's words at GET /me/ai-isa. Real Postgres via the API harness; fakes only.
import { DEFAULT_AI_ISA_CONTENT } from '@realty/core/isa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { commsWorld, type CommsWorld, ownedContact } from '../comms/testing.js';
import { approvePolicyAsOwner, call, freshReauth } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let other: CommsWorld;
let admin: TestClient;
let isa: TestClient;
let tc: TestClient;
let policyId: string;
let versionIds: string[];

const D = DEFAULT_AI_ISA_CONTENT as unknown as Record<string, unknown>;
// the draft's marker: a tone sample no other row of the fixture holds
const MARKER = 'zq-marker-7391 warm and brief';
const APPROVED_MARKER = 'zq-approved-5527 plain and short';

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1, teamLead: true, others: ['admin', 'isa', 'tc'] });
  [admin, isa, tc] = w.others as [TestClient, TestClient, TestClient];
  other = await commsWorld(h, { agents: 1 });
  // version 1 approved, version 2 a wider draft carrying the marker
  await approvePolicyAsOwner(h, w.owner, { ...D, tone: APPROVED_MARKER });
  await freshReauth(h, w.owner);
  const saved = await call<{ draft: { effect: string } }>(w.owner, 'PUT', '/admin/ai-isa/policy/draft', { content: { ...D, capabilities: ['converse', 'share_listings'], tone: MARKER } });
  expect(saved.body.draft.effect).toBe('wider');
  policyId = (await h.su.query<{ id: string }>(`SELECT id FROM playbooks WHERE tenant_id = $1 AND kind = 'ai_isa'`, [w.tenantId])).rows[0]!.id;
  versionIds = (await h.su.query<{ id: string }>(`SELECT id FROM playbook_versions WHERE playbook_id = $1 ORDER BY version_no`, [policyId])).rows.map((r) => r.id);
  expect(versionIds).toHaveLength(2);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-ISA-36 the generic playbook reads never return the team AI policy (E1009)', () => {
  it('GET /playbooks lists no playbook of kind ai_isa and GET /playbooks/:id is 404, for all six roles and a second tenant, with a wider draft saved', async () => {
    const everyone: [string, TestClient][] = [['agent', w.agents[0]!], ['isa', isa], ['tc', tc], ['team_lead', w.teamLead!], ['admin', admin], ['owner', w.owner], ['other tenant owner', other.owner]];
    for (const [who, c] of everyone) {
      const list = await call<{ playbooks: { id: string; kind: string }[] }>(c, 'GET', '/playbooks');
      expect(list.status, who).toBe(200);
      expect(list.body.playbooks.filter((p) => p.kind === 'ai_isa' || p.id === policyId), who).toEqual([]);
      const text = JSON.stringify(list.body);
      expect(text.includes(MARKER), `${who}: the draft's marker in the list`).toBe(false);
      expect(text.includes(APPROVED_MARKER), `${who}: the approved version's marker in the list`).toBe(false);
      const one = await call(c, 'GET', `/playbooks/${policyId}`);
      expect(one.status, who).toBe(404);
      // the other tenant cannot tell the id exists (row-level security): plain NOT_FOUND; this tenant is told where it lives
      expect(one.code, who).toBe(who === 'other tenant owner' ? 'NOT_FOUND' : 'AI_ISA_POLICY_USE_ITS_ROUTES');
      const body = JSON.stringify(one.body);
      expect(body.includes(MARKER) || body.includes(APPROVED_MARKER) || body.includes('share_listings'), `${who}: policy content in the refusal`).toBe(false);
    }
  });

  it('the stage-start read of the policy id carries its id, name and scope and no version, content or hash, for every role', async () => {
    for (const c of [w.agents[0]!, isa, tc, w.teamLead!, admin, w.owner]) {
      const r = await call<{ playbook: Record<string, unknown>; canChange: boolean }>(c, 'GET', `/playbooks/${policyId}/auto-enroll-stage`);
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(['canChange', 'playbook']);
      expect(Object.keys(r.body.playbook).sort()).toEqual(['autoEnrollStage', 'id', 'name', 'scope']);
      expect(r.body.playbook).toEqual({ id: policyId, name: 'AI assistant policy', scope: 'team', autoEnrollStage: null });
    }
    expect((await call(other.owner, 'GET', `/playbooks/${policyId}/auto-enroll-stage`)).status).toBe(404);
  });

  it('the Owner and Admin still read it at its own route, and an agent reads the approved version there, never the draft', async () => {
    for (const c of [w.owner, admin]) {
      const v = await call<{ state: string; draft: { content: { tone: string } } }>(c, 'GET', '/admin/ai-isa/policy');
      expect(v.body).toMatchObject({ state: 'approved_with_draft', draft: { content: { tone: MARKER } } });
    }
    const me = await call<{ policy: { versionId: string; versionNo: number } | null }>(w.agents[0]!, 'GET', '/me/ai-isa');
    expect(me.body.policy).toMatchObject({ versionId: versionIds[0], versionNo: 1 });
    expect(JSON.stringify(me.body)).not.toContain(MARKER);
    expect(JSON.stringify(me.body)).not.toContain('share listings');
  });
});

describe('R-ISA-36 the other reads of a playbook version (E1009)', () => {
  it('the voice test call names a version of the voice playbook only: the policy\'s version ids are 404', async () => {
    await freshReauth(h, w.owner);
    for (const versionId of versionIds) {
      const r = await call(w.owner, 'POST', '/voice/test-call', { script: 'booking', versionId });
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain(MARKER);
    }
  });

  it('nobody is enrolled in the policy by hand: no enrollment row, so the enrollment reads have no policy version to show', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: true });
    const r = await call(agent, 'POST', `/contacts/${c.id}/enrollments`, { playbookId: policyId });
    // refused by the content's shape before any row is written (assistant/repos/playbooks.ts insertEnrollment: NOT_ENROLLABLE)
    expect(r).toMatchObject({ status: 422, code: 'PLAYBOOK_INVALID' });
    expect((r.body as unknown as { error: { details: { issues: { code: string }[] } } }).error.details.issues).toEqual([{ code: 'NOT_ENROLLABLE' }]);
    expect(JSON.stringify(r.body)).not.toContain(MARKER);
    const rows = await h.su.query(`SELECT 1 FROM playbook_enrollments WHERE tenant_id = $1 AND playbook_id = $2`, [w.tenantId, policyId]);
    expect(rows.rows).toEqual([]);
    const status = await call(agent, 'GET', `/contacts/${c.id}/playbook-status`);
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).not.toContain(MARKER);
    expect(JSON.stringify(status.body)).not.toContain(APPROVED_MARKER);
  });

  it('the audit rows of the policy actions name the version and a hash prefix, never the content', async () => {
    const rows = (await h.su.query<{ action: string; row: string }>(`SELECT action, row_to_json(a)::text AS row FROM audit_log a WHERE tenant_id = $1 AND action LIKE 'ai_isa.policy%'`, [w.tenantId])).rows;
    expect(rows.map((r) => r.action).sort()).toEqual(['ai_isa.policy_approved', 'ai_isa.policy_created', 'ai_isa.policy_draft_saved', 'ai_isa.policy_draft_saved']);
    for (const r of rows) {
      expect(r.row).not.toContain('zq-marker');
      expect(r.row).not.toContain('zq-approved');
      expect(r.row).not.toContain('share_listings');
    }
  });
});
