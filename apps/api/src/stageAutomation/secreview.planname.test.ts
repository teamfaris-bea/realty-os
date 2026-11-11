// Security review (R-PERM-5, R-PERM-12): an agent's own (agent-scope) playbook is invisible to every other
// agent and ISA by playbooks RLS (playbooks_select: team scope, own, or sees_all_detail; TLs see all). The
// stage-change response must not disclose it to a collaborator who changes the stage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld } from '../comms/testing.js';
import { changeStage, newContact, playbook, setStage } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;
let isa: TestClient;
let secret: { id: string; versionId: string };
const SECRET_NAME = "Ana's private seller plan";

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, others: ['isa'] });
  agent = w.agents[0]!;
  agent2 = w.agents[1]!;
  isa = w.others[0]!;
  secret = await playbook(agent, { scope: 'agent', name: SECRET_NAME });
  expect((await setStage(agent, secret.id, 'active')).status).toBe(200);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('secreview: the stage-change response never names a playbook the changer cannot see', () => {
  it('precondition: another agent and the ISA cannot read the agent\'s own playbook (RLS: 404, not listed)', async () => {
    for (const c of [agent2, isa]) {
      expect((await call(c, 'GET', `/playbooks/${secret.id}`)).status).toBe(404);
      const list = await call<{ playbooks: { id: string; name: string }[] }>(c, 'GET', '/playbooks');
      expect(list.body.playbooks.map((p) => p.name)).not.toContain(SECRET_NAME);
    }
  });

  it('an agent co_agent collaborator moving the agent\'s person to Active is not told the name of the agent\'s private plan', async () => {
    const c = await newContact(agent);
    expect((await call(agent, 'POST', `/contacts/${c}/collaborators`, { userId: agent2.userId, role: 'co_agent' })).status).toBe(200);
    const r = await changeStage(agent2, c, 'active');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body.automation ?? null)).not.toContain(SECRET_NAME);
  });

  it('an ISA collaborator moving the agent\'s person to Active is not told the name of the agent\'s private plan', async () => {
    const c = await newContact(agent);
    expect((await call(agent, 'POST', `/contacts/${c}/collaborators`, { userId: isa.userId, role: 'isa' })).status).toBe(200);
    const r = await changeStage(isa, c, 'active');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body.automation ?? null)).not.toContain(SECRET_NAME);
  });
});
