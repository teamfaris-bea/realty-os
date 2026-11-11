// Lane people-filters, owner decision D1: a filter never changes who may be messaged. A bulk email whose
// selection is an unsaved filter definition (what "Select all" on a filtered People page sends) still blocks
// every opted-out person at preview and at send, through comms/dispatch.ts (E200, R-PAR-36).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, ownedContact, pointId } from '../comms/testing.js';
import { runBulkAction } from '../bulk/run.js';
import { confirm, draft, itemsOf, marketingReady } from '../bulk/testing.js';
import { makeTag, tagContact } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  await marketingReady(h, w);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('bulk on a filtered list (D1)', () => {
  it('E200 R-PAR-36: Select all on "tag Open house AND stage is not lost" emails the matching people and blocks the opted-out one; the excluded stage is not targeted', async () => {
    const agent = w.agents[0]!;
    const tag = await makeTag(agent, `Open house ${randomUUID().slice(0, 4)}`);
    const a = await ownedContact(agent, { firstName: 'Ann' });
    const b = await ownedContact(agent, { firstName: 'Bea' });
    const out = await ownedContact(agent, { firstName: 'Ola' });
    const lost = await ownedContact(agent, { firstName: 'Lou' });
    for (const x of [a, b, out, lost]) await tagContact(agent, x.id, [tag.id]);
    await h.su.query(`UPDATE contacts SET stage = 'lost' WHERE id = $1`, [lost.id]);
    const r = await call(agent, 'POST', `/contacts/${out.id}/consent`, { kind: 'revoke', pointId: await pointId(h, out.id, 'email'), channel: 'email', purpose: 'all', evidence: { note: 'asked to stop' } });
    expect(r.status).toBe(200);
    const tpl = await call<{ template: { id: string } }>(agent, 'POST', '/templates', { scope: 'personal', channel: 'email', name: `F ${randomUUID().slice(0, 6)}`, subject: 'Hi {{contact.first_name}}', body: 'Open house Saturday.' });
    const definition = { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [tag.id] }, { kind: 'stage', not_in: ['lost'] }] };
    const d = await draft(agent, { kind: 'email', selection: { definition }, templateId: tpl.body.template.id });
    expect(d.status).toBe(201);
    expect(d.body.action.selected).toBe(3);
    expect(d.body.action.preflight).toEqual({ RECIPIENT_OPTED_OUT: 1 });
    expect(d.body.action.targetCount).toBe(2);
    await confirm(agent, d.body.action.id);
    expect(await runBulkAction(d.body.action.id, w.deps, w.tenantId)).toEqual({ kind: 'finished', status: 'completed' });
    const sent = (to: string) => h.providers.email.sent.filter((m) => m.to === to).length;
    expect([sent(a.email), sent(b.email), sent(out.email), sent(lost.email)]).toEqual([1, 1, 0, 0]);
    const items = await itemsOf(h, d.body.action.id);
    expect(items.map((i) => i.contact_id)).not.toContain(lost.id);
    expect(items.find((i) => i.contact_id === out.id)?.status).not.toBe('done');
  });
});
