// Security review: the Owner's batch-text switch (R-PAR-40, E185) must stop a running batch, including an
// item whose message was created before a crash (left 'queued') and is replayed by the next bulk.run.
import { randomUUID } from 'node:crypto';
import { bulkSendKey } from '@realty/core/parity/bulk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { composeHumanMessage } from '../comms/compose.js';
import { type CommsWorld, call, commsWorld, ownedContact, pointId } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';
import { runBulkAction } from './run.js';
import { batchTextOff, batchTextOn, confirm, draft, itemsOf, marketingReady } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  await marketingReady(h, w);
  const reg = await call<{ registration: { id: string } }>(w.owner, 'POST', '/sender-registrations', { kind: 'a2p_campaign', useCase: 'marketing', sampleMessages: ['New listings near you this week. Reply STOP to opt out.'], optInDescription: 'Leads opt in on our website form.' });
  await call(w.owner, 'POST', `/sender-registrations/${reg.body.registration.id}/refresh`);
  await call(w.owner, 'PATCH', `/numbers/${w.mainNumberId}/registration`, { registrationId: reg.body.registration.id });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('secreview R-PAR-40 E185 switch off stops a replayed item', () => {
  it('secreview R-PAR-40 a batch-text message left queued by a crash is not sent after the Owner turns batch text off', async () => {
    await batchTextOn(h, w.owner);
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { firstName: 'Zed' });
    const t = (await call<{ template: { id: string } }>(agent, 'POST', '/templates', { scope: 'personal', channel: 'sms', name: `T ${randomUUID().slice(0, 6)}`, body: 'Hi {{contact.first_name}}, open house Saturday.' })).body.template.id;
    const d = await draft(agent, { kind: 'text', selection: { contactIds: [c.id] }, templateId: t });
    expect(d.body.action.targetCount).toBe(1);
    const id = d.body.action.id;
    expect((await confirm(agent, id)).status).toBe(200);
    // the runner started, its compose transaction committed the message, and the process died before dispatch
    await suFixture(h, [{ text: "UPDATE bulk_actions SET status = 'running', started_at = now() WHERE id = $1", values: [id] }]);
    const hmac = (await h.su.query("SELECT encode(address_hmac, 'hex') AS h FROM bulk_action_items WHERE bulk_action_id = $1", [id])).rows[0].h as string;
    await composeHumanMessage(agent.actor(), c.id, { channel: 'sms', body: 'Hi Zed, open house Saturday.\n— Harbor Realty LLC. Reply STOP to opt out.', idempotencyKey: bulkSendKey(id, hmac), toPointId: await pointId(h, c.id, 'phone'), bulkActionId: id, purposeOverride: 'marketing', scheduleAt: new Date(Date.now() + 3_600_000).toISOString() }, w.deps);
    await suFixture(h, [{ text: "UPDATE messages SET status = 'queued', scheduled_for = NULL WHERE bulk_action_id = $1", values: [id] }]);
    expect(h.providers.telephony.sms.filter((m) => m.to === c.phone)).toHaveLength(0);
    // the Owner turns batch text off; the job comes back and resumes the action
    await batchTextOff(w.owner);
    await runBulkAction(id, w.deps, w.tenantId);
    expect(h.providers.telephony.sms.filter((m) => m.to === c.phone), JSON.stringify(await itemsOf(h, id))).toHaveLength(0);
  });
});
