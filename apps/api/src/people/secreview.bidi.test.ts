// secreview: control and bidi-override characters. Tag names and field labels drop invisible/bidi
// characters and refuse controls (core normalizeTagName/cleanLabel); api/people's names, relationship
// labels and stage labels do not, and a contact's first name flows verbatim into other users' mention
// notification titles (R-PAR-3 "first name and initial").
import { mentionToken } from '@realty/core/parity/people';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, ownedContact } from '../comms/testing.js';
import { call, freshReauth } from '../leads/testing.js';

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

describe('secreview: control / bidi characters in api/people text', () => {
  it('a first name with BEL and RLO is refused (422), so it can never reach a mention notification title', async () => {
    const c = await ownedContact(agent, { consent: false });
    const r = await call(agent, 'PATCH', `/contacts/${c.id}`, { rowVersion: 1, firstName: 'Ann\u0007‮gpj.exe' });
    const n = await call(agent, 'POST', `/contacts/${c.id}/notes`, { body: `fyi ${mentionToken(w.owner.userId!, 'Owner')}` });
    const titles = (await h.su.query<{ title: string }>("SELECT title FROM notifications WHERE kind = 'mention' AND user_id = $1 AND subject_id = $2", [w.owner.userId, c.id])).rows.map((x) => x.title);
    // eslint-disable-next-line no-control-regex -- finding control characters is the point
    expect({ patch: r.status, note: n.status, controlInTitle: titles.some((t) => /[\u0000-\u001f\u007f‪-‮⁦-⁩]/u.test(t)) }).toEqual({ patch: 422, note: 201, controlInTitle: false });
  });

  it('a relationship label and a stage label with a bidi override are refused (or stripped) like tag names', async () => {
    const a = await ownedContact(agent, { consent: false });
    const b = await ownedContact(agent, { consent: false });
    const rel = await call<{ relationship?: { label: string | null } }>(agent, 'POST', `/contacts/${a.id}/relationships`, { relatedContactId: b.id, kind: 'other', label: 'Friend‮dneirf' });
    await freshReauth(h, w.owner);
    const st = await call<{ labels?: Record<string, string> }>(w.owner, 'PUT', '/stage-labels', { labels: { lost: '‮Won' } });
    const relOk = rel.status === 422 || (rel.status === 201 && !/[‪-‮]/u.test(rel.body.relationship?.label ?? ''));
    const stOk = st.status === 422 || (st.status === 200 && !/[‪-‮]/u.test(st.body.labels?.lost ?? ''));
    expect({ relationship: [rel.status, relOk], stageLabel: [st.status, stOk] }).toEqual({ relationship: [rel.status, true], stageLabel: [st.status, true] });
  });
});
