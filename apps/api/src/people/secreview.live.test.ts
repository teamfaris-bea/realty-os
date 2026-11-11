// secreview api/people writes on a contact that is no longer live (soft-deleted or merged away).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact } from '../comms/testing.js';
import { call, command, freshReauth, randomPhone } from '../leads/testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1, rule: false });
  agent = w.agents[0]!;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('secreview: writes on a contact that is not live', () => {
  it('after a merge, the loser takes no new notes, points or relationships (404 like the lists routes)', async () => {
    const s = await ownedContact(agent, { consent: false });
    const l = await ownedContact(agent, { consent: false, confirmDistinct: true });
    const other = await ownedContact(agent, { consent: false });
    await freshReauth(h, w.owner);
    const m = await command(w.owner, s.id, 'merge', { loserId: l.id });
    const state = (await h.su.query('SELECT merged_into_contact_id, deleted_at, ownership_state FROM contacts WHERE id = $1', [l.id])).rows[0];
    const got: Record<string, unknown> = { merge: m.status, state };
    for (const c of [agent, w.owner]) {
      got[`${c.role} note`] = (await call(c, 'POST', `/contacts/${l.id}/notes`, { body: 'on the loser' })).status;
      got[`${c.role} point`] = (await call(c, 'POST', `/contacts/${l.id}/points`, { kind: 'phone', address: randomPhone() })).status;
      got[`${c.role} rel`] = (await call(c, 'POST', `/contacts/${other.id}/relationships`, { relatedContactId: l.id, kind: 'family' })).status;
      got[`${c.role} tags`] = (await call(c, 'POST', `/contacts/${l.id}/tags`, { names: ['x' + randomUUID().slice(0, 4)] })).status;
    }
    // the lists routes already refuse it (owner tags: 404); api/people (detailFacts: detail_visible only) does not
    expect(got).toMatchObject({ merge: 200, 'owner tags': 404, 'owner note': 404, 'owner point': 404, 'owner rel': 404 });
  });
});
