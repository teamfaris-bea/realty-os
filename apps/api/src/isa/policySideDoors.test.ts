// The team AI policy is never enrolled by hand or by stage (R-ISA-37; E1010; review fix F6). The policy is a playbook
// row of kind ai_isa, so every path that turns "a playbook" into an enrollment has to refuse the kind: the stage-start
// setting (PUT /playbooks/:id/auto-enroll-stage), the stage entry itself should the column ever hold it, the stage
// preview, and a bulk enrollment. One list (core NEVER_ENROLLED_PLAYBOOK_KINDS) says which kinds those are.
// Real Postgres via the API harness; fakes only.
import { NEVER_ENROLLED_PLAYBOOK_KINDS, isNeverEnrolledPlaybookKind } from '@realty/core/assistant';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { draft } from '../bulk/testing.js';
import { commsWorld, type CommsWorld, ownedContact } from '../comms/testing.js';
import { changeStage, decisionsOf, enrollmentsOf, reconcileAsJob, setStage } from '../stageAutomation/testing.js';
import { approvePolicyAsOwner, call, freshReauth } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let admin: TestClient;
let policyId: string;

const stageOf = async () => (await h.su.query<{ s: string | null }>(`SELECT auto_enroll_stage AS s FROM playbooks WHERE id = $1`, [policyId])).rows[0]!.s;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1, others: ['admin'] });
  [admin] = w.others as [TestClient];
  await approvePolicyAsOwner(h, w.owner);
  policyId = (await h.su.query<{ id: string }>(`SELECT id FROM playbooks WHERE tenant_id = $1 AND kind = 'ai_isa'`, [w.tenantId])).rows[0]!.id;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-ISA-37 the policy is never enrolled by hand or by stage (E1010)', () => {
  it('one list names the kinds that are never enrolled, and the policy is on it', () => {
    expect([...NEVER_ENROLLED_PLAYBOOK_KINDS].sort()).toEqual(['ai_isa', 'new_lead_response', 'trigger', 'voice_answering']);
    expect(isNeverEnrolledPlaybookKind('ai_isa')).toBe(true);
    expect(isNeverEnrolledPlaybookKind('nurture')).toBe(false);
  });

  it('PUT /playbooks/:id/auto-enroll-stage refuses the policy for the Owner and an Admin; the stage slot stays free', async () => {
    for (const c of [w.owner, admin]) {
      await freshReauth(h, c);
      const r = await setStage(c, policyId, 'nurture');
      expect(r).toMatchObject({ status: 422, code: 'AUTO_ENROLL_NOT_ALLOWED' });
    }
    expect(await stageOf()).toBeNull();
    // clearing is a no-op, as for every playbook
    expect((await setStage(w.owner, policyId, null)).status).toBe(200);
  });

  it('should the column ever name a stage (written past the route), entering that stage starts nothing, throws nothing, and the preview names no plan', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: true });
    // the superuser writes what no route can: the fixture of a database that already holds the bad setting
    await h.su.query(`UPDATE playbooks SET auto_enroll_stage = 'nurture' WHERE id = $1`, [policyId]);
    try {
      const preview = await call<Record<string, unknown>>(agent, 'GET', `/contacts/${c.id}/stage/preview?to=nurture`);
      expect(preview.status).toBe(200);
      expect(JSON.stringify(preview.body)).not.toContain('AI assistant policy');
      const changed = await changeStage(agent, c.id, 'nurture');
      expect(changed.status).toBe(200);
      expect(changed.body.automation).toBeNull();
      const ev = (await h.su.query<{ id: string }>(`SELECT id FROM contact_stage_events WHERE contact_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`, [c.id])).rows[0]!.id;
      // the worker's pass over the same event: no throw, no decision, no enrollment
      await expect(reconcileAsJob(h, w.tenantId, ev)).resolves.toBeDefined();
      expect(await decisionsOf(h, c.id)).toEqual([]);
      expect(await enrollmentsOf(h, c.id)).toEqual([]);
    } finally {
      await h.su.query(`UPDATE playbooks SET auto_enroll_stage = NULL WHERE id = $1`, [policyId]);
    }
  });

  it('a bulk enrollment naming the policy is refused as a whole: 404, no action row', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: true });
    const d = await draft(agent, { kind: 'enroll', selection: { contactIds: [c.id] }, playbookId: policyId });
    expect(d).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect((await h.su.query(`SELECT 1 FROM bulk_actions WHERE tenant_id = $1 AND kind = 'enroll'`, [w.tenantId])).rows).toEqual([]);
    expect(await enrollmentsOf(h, c.id)).toEqual([]);
  });
});
