// F1 (D1, R-CHAN-2, R-PAR-12): a merged-away record is the whole person, never a second, unguarded address of them.
//
// A merge copies the loser's points onto the survivor and carries the loser's do-not-contact up to the survivor
// (app.contacts_dnc_follow_merge), so every send to the SURVIVOR sees the whole person. Nothing looked the other way:
// the survivor's own do-not-contact, or a STOP from a phone only the survivor had, both recorded before the merge, never
// reached the merged-away record, and a text, a call, a direct enrollment or a saved-search alert addressed to that
// record went out (the review's probes: the fake providers received them). Now:
//   - nothing new is addressed to a merged-away record: a text, an email, a compose preview and a call are refused
//     before anything is created (409 CONTACT_MERGED, the survivor named only to whoever sees it), and its saved
//     searches send no alert (a merge moves none);
//   - and whatever reaches one anyway (a message composed while the merge committed) is judged as the whole person, in
//     core canContact and in both DB dispatch guards (migration 0041: app.contact_person_ids), so it is blocked by the
//     person's opt-outs and never sent (guardEquivalence.test.ts proves the two layers agree case by case).
// Real Postgres, the real server, fake providers only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { command, freshReauth } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { depsOf, listing, runJobs } from '../assistant/testing.js';
import { matchSavedSearches } from '../assistant/searches.js';
import { dispatchOutbound } from './dispatch.js';
import * as msgs from './repos/messages.js';
import { type CommsWorld, call, commsWorld, inboundSms, ownedContact, randomPhone, sendText } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;
let admin: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, rule: false, others: ['admin'] });
  agent = w.agents[0]!;
  agent2 = w.agents[1]!;
  admin = w.others[0]!;
  // the callers' own phones, so a call is refused for the record, not for a missing agent phone
  for (const c of [w.owner, admin, agent, agent2]) await h.su.query('UPDATE memberships SET alert_phone_e164 = $3, alert_phone_verified_at = now() WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, c.userId, randomPhone()]);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

interface Person {
  id: string;
  phone: string;
  email: string;
}

/**
 * The agent's S and L (L with a collaborator, agent2, and optionally an active saved search, both from before the
 * merge); `before` runs on S before the Owner merges L into S. After the merge the agent no longer sees L; the Owner,
 * an Admin and L's collaborator still do.
 */
async function mergedPair(before: (s: Person) => Promise<void> = async () => undefined, o: { search?: string } = {}): Promise<{ s: Person; l: Person; searchId: string | null }> {
  const s = await ownedContact(agent, { consent: false });
  const l = await ownedContact(agent, { consent: false, confirmDistinct: true, firstName: 'Jean' });
  expect((await call(agent, 'POST', `/contacts/${l.id}/collaborators`, { userId: agent2.userId, role: 'co_agent' })).status).toBe(200);
  const searchId = o.search ? await activeSearch(l.id, o.search) : null;
  await before(s);
  await freshReauth(h, w.owner);
  const m = await command(w.owner, s.id, 'merge', { loserId: l.id });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
  expect((await call(agent, 'GET', `/contacts/${l.id}`)).status).toBe(404);
  for (const c of [w.owner, admin, agent2]) expect((await call(c, 'GET', `/contacts/${l.id}`)).status).toBe(200);
  return { s, l, searchId };
}

/** An approved, active saved search with instant text alerts (a superuser fixture: the agent's approval and activation). */
async function activeSearch(contactId: string, postalCode: string): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, approved_by_user_id, approved_at, activated_at, alert_channel, alert_frequency)
     VALUES ($1, $2, $3, 'Homes like this', 'active', $4::jsonb, $5, now(), now(), 'sms', 'instant')`,
    [w.tenantId, id, contactId, JSON.stringify({ postalCodes: [postalCode] }), agent.userId],
  );
  return id;
}

const asked = (s: Person) => call(agent, 'POST', `/contacts/${s.id}/do-not-contact`, { reason: 'asked_on_call' }).then((r) => expect(r.status).toBe(200));
/** A phone only S has (L never had it) texts STOP before the merge. */
const stopOnSurvivorsOwnPhone = async (s: Person) => {
  const only = randomPhone();
  expect((await call(agent, 'POST', `/contacts/${s.id}/points`, { kind: 'phone', address: only })).status).toBe(201);
  expect((await inboundSms(h, only, w.mainNumber, 'STOP')).statusCode).toBe(200);
};

const outbound = async (contactId: string) =>
  (await h.su.query<{ m: number; c: number }>("SELECT (SELECT count(*)::int FROM messages WHERE contact_id = $1 AND direction = 'outbound') AS m, (SELECT count(*)::int FROM calls WHERE contact_id = $1 AND direction = 'outbound') AS c", [contactId])).rows[0]!;
const providerTo = (p: Person) => ({ sms: h.providers.telephony.sms.filter((m) => m.to === p.phone).length, email: h.providers.email.sent.filter((m) => m.to === p.email).length, calls: h.providers.telephony.calls.length });

describe('F1 D1: a merged-away record is the whole person, never a second, unguarded address', () => {
  it('F1: a text, an email, a compose preview and a call addressed to a merged-away record are refused before anything is created (409 CONTACT_MERGED; the survivor named only to whoever sees it), for the Owner, an Admin and the loser’s collaborator, even when nobody opted out; nothing reaches a provider; the former owner gets 404; the person is reached through the survivor', async () => {
    const { s, l } = await mergedPair();
    const rows = await outbound(l.id);
    const sent = providerTo(l);
    const got: Record<string, unknown> = {};
    for (const [who, c] of [['owner', w.owner], ['admin', admin], ['collaborator', agent2]] as const) {
      const tries = {
        text: await call<{ error: { code: string; details?: { mergedInto?: string } } }>(c, 'POST', `/contacts/${l.id}/messages`, { channel: 'sms', body: 'Checking in', idempotencyKey: `k-${randomUUID()}` }),
        email: await call<{ error: { code: string; details?: { mergedInto?: string } } }>(c, 'POST', `/contacts/${l.id}/messages`, { channel: 'email', subject: 'Checking in', body: 'Checking in', idempotencyKey: `k-${randomUUID()}` }),
        preview: await call<{ error: { code: string; details?: { mergedInto?: string } } }>(c, 'POST', `/contacts/${l.id}/messages/preview`, { channel: 'sms', body: 'Checking in' }),
        call: await call<{ error: { code: string; details?: { mergedInto?: string } } }>(c, 'POST', `/contacts/${l.id}/calls`, {}),
      };
      for (const [k, r] of Object.entries(tries)) got[`${who} ${k}`] = [r.status, r.body.error?.code, r.body.error?.details?.mergedInto ?? null];
    }
    const want: Record<string, unknown> = {};
    for (const who of ['owner', 'admin', 'collaborator']) for (const k of ['text', 'email', 'preview', 'call']) want[`${who} ${k}`] = [409, 'CONTACT_MERGED', who === 'collaborator' ? null : s.id];
    expect(got).toEqual(want);
    expect((await sendText(agent, l.id, 'Hi')).status).toBe(404);
    expect(await outbound(l.id)).toEqual(rows);
    expect(providerTo(l)).toEqual(sent);
    // the person: the survivor, with the loser's phone copied onto it (R-PAR-45), is texted as before
    expect((await sendText(agent, s.id, 'Checking in on the house')).body).toMatchObject({ result: 'sent' });
  });

  it('F1 D1 R-CHAN-2 R-PAR-12: a message that reached a merged-away record anyway (composed while the merge committed) is judged as the whole person at dispatch: blocked by canContact for the survivor’s do-not-contact or a STOP from a phone only the survivor had, both from before the merge; the reason is recorded and nothing reaches the provider', async () => {
    for (const [label, before, reason] of [['asked', asked, 'PERSON_DO_NOT_CONTACT'], ['stop', stopOnSurvivorsOwnPhone, 'CONSENT_REVOKED']] as const) {
      const { l } = await mergedPair(before);
      const sent = providerTo(l);
      // the race: a text the Owner composed on L committed after the merge moved L's messages (a fixture: compose now refuses)
      const id = randomUUID();
      await withTenantTx(w.owner.actor(), async (tx, now) => {
        const conversationId = await msgs.ensureConversation(tx, randomUUID(), l.id, null);
        await msgs.insertOutbound(tx, {
          id, conversationId, contactId: l.id, channel: 'sms', phoneNumberId: w.mainNumberId, emailIdentityId: null, fromAddress: w.mainNumber, toAddress: l.phone, subject: null,
          body: 'Checking in', status: 'queued', scheduledFor: null, initiator: 'human', initiatedByUserId: w.owner.userId!, purpose: 'informational', actionCategory: 'none',
          assistantActionId: null, playbookStepRunId: null, pinnedInboundSeq: null, idempotencyKey: `race:${id}`, occurredAt: now,
        });
      }, { db: h.database });
      const r = await dispatchOutbound(id, w.deps, { tenantId: w.tenantId, actor: w.owner.actor() });
      expect({ label, kind: r.kind, reasons: 'decision' in r ? r.decision?.reasons : null }).toEqual({ label, kind: 'blocked', reasons: expect.arrayContaining([reason]) });
      expect((await h.su.query('SELECT status FROM messages WHERE id = $1', [id])).rows[0]).toEqual({ status: 'blocked' });
      expect(providerTo(l), label).toEqual(sent);
    }
  });

  it('F1 D1: an active saved search of a merged-away record sends no alert after the merge (automatic: a new matching listing, the match and the dispatch jobs), whether or not the person opted out; the survivor’s own search still alerts', async () => {
    for (const before of [async () => undefined, asked] as const) {
      const code = `9${String(Math.floor(Math.random() * 9000) + 1000)}`;
      const { s, l } = await mergedPair(before, { search: code });
      const sSearch = await activeSearch(s.id, code);
      const sent = { l: providerTo(l), s: providerTo(s) };
      const rows = await outbound(l.id);
      const listingId = await listing(h, w, agent.userId!, { postalCode: code });
      await matchSavedSearches(systemActor(w.tenantId, 'assistant'), listingId, depsOf(h));
      await runJobs(h, w.tenantId, ['comms.dispatch']);
      // nothing is addressed to the merged-away record, so nothing is sent to it
      expect(await outbound(l.id)).toEqual(rows);
      expect(providerTo(l)).toEqual(sent.l);
      // the survivor's search alerts it (when it did not opt out), so the person still hears about the home
      const alerts = (await h.su.query<{ status: string }>("SELECT m.status FROM messages m JOIN saved_search_matches x ON x.alerted_message_id = m.id WHERE x.search_id = $1", [sSearch])).rows;
      expect(alerts.map((a) => a.status)).toEqual([before === asked ? 'blocked' : 'sent']);
      expect(providerTo(s).sms).toBe(sent.s.sms + (before === asked ? 0 : 1));
    }
  });
});
