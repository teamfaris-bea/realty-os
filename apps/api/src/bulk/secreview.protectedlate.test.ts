// Security review: a tag that becomes protected (R-PAR-8) AFTER the draft — protected directly by the Owner,
// or by merging a protected tag into it — must still never define a bulk send audience, nor be removed in bulk.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, ownedContact } from '../comms/testing.js';
import { runBulkAction } from './run.js';
import { confirm, draft, itemsOf, marketingReady } from './testing.js';

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

const run = (id: string) => runBulkAction(id, w.deps, w.tenantId);
const emailsTo = (addr: string) => h.providers.email.sent.filter((m) => m.to === addr);
async function newTag(name: string): Promise<string> {
  const r = await call<{ tag: { id: string } }>(w.owner, 'POST', '/tags', { name: `${name} ${randomUUID().slice(0, 6)}` });
  return r.body.tag.id;
}
async function emailTemplate() {
  return (await call<{ template: { id: string } }>(w.agents[0]!, 'POST', '/templates', { scope: 'personal', channel: 'email', name: `S ${randomUUID().slice(0, 6)}`, subject: 'Hello', body: 'New homes this week.' })).body.template.id;
}

describe('secreview R-PAR-8: protection applied between draft and confirm/run', () => {
  it('secreview R-PAR-8 a smart-list audience whose tag is protected after the draft is refused at confirm and never emailed', async () => {
    const agent = w.agents[0]!;
    const t = await newTag('Spring');
    const c = await ownedContact(agent);
    expect((await call(agent, 'POST', `/contacts/${c.id}/tags`, { tagIds: [t] })).status).toBe(200);
    const list = (await call<{ list: { id: string } }>(agent, 'POST', '/smart-lists', { scope: 'personal', name: `L ${randomUUID().slice(0, 4)}`, definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [t] }] } })).body.list.id;
    const d = await draft(agent, { kind: 'email', selection: { listId: list }, templateId: await emailTemplate() });
    expect(d.body.action?.targetCount, JSON.stringify(d.body)).toBe(1);
    // the Owner flags the tag as a fair-housing proxy before the agent hits Confirm
    expect((await call(w.owner, 'POST', `/tags/${t}/protect`, { protected: true })).status).toBe(200);
    // the list itself is now a protected audience: a fresh draft is refused
    expect((await draft(agent, { kind: 'email', selection: { listId: list }, templateId: await emailTemplate() })).body).toMatchObject({ error: { code: 'AUDIENCE_PROTECTED_PROXY' } });
    const r = await confirm(agent, d.body.action.id);
    if (r.status === 200) await run(d.body.action.id);
    expect(emailsTo(c.email)).toHaveLength(0);
    expect(r.body).toMatchObject({ error: { code: 'AUDIENCE_PROTECTED_PROXY' } });
  });

  it('secreview R-PAR-8 a bulk untag whose tag becomes protected after confirm (here: a protected tag merged into it) never removes it in bulk', async () => {
    const agent = w.agents[0]!;
    const t = await newTag('Plain');
    const p = await newTag('Autumn');
    expect((await call(w.owner, 'POST', `/tags/${p}/protect`, { protected: true })).status).toBe(200);
    const c = await ownedContact(agent);
    expect((await call(agent, 'POST', `/contacts/${c.id}/tags`, { tagIds: [t] })).status).toBe(200);
    const d = await draft(agent, { kind: 'untag', selection: { contactIds: [c.id] }, tagId: t });
    expect(d.body.action.targetCount).toBe(1);
    expect((await confirm(agent, d.body.action.id)).status).toBe(200);
    // the protected tag is merged into the untag's tag: the target is protected now (R-PAR-9)
    const m = await call<{ tag: { protected: boolean } }>(w.owner, 'POST', `/tags/${p}/merge`, { intoTagId: t });
    expect(m.status).toBe(200);
    expect(m.body.tag.protected).toBe(true);
    // a fresh bulk untag of it is refused (TAG_PROTECTED) ...
    expect((await draft(agent, { kind: 'untag', selection: { contactIds: [c.id] }, tagId: t })).body).toMatchObject({ error: { code: 'TAG_PROTECTED' } });
    // ... but the already-confirmed one still removes it in bulk
    await run(d.body.action.id);
    const still = await h.su.query('SELECT 1 FROM contact_tags WHERE contact_id = $1 AND tag_id = $2', [c.id, t]);
    expect(still.rowCount, JSON.stringify(await itemsOf(h, d.body.action.id))).toBe(1);
  });
});
