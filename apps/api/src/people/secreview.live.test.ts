// secreview api/people writes on a contact that is no longer live (soft-deleted or merged away).
//
// A merged-away loser takes no write that would strand a row on it: edits, stage changes, points, addresses,
// relationships, notes, logged activity and tags are 404 (people/common.ts liveDetailFacts, R-PAR-45). After the
// merge its detail is still seen by the Owner, Admins, the loser's collaborators and the members of the loser's deals
// (a merge moves neither), never by its former owner or their Team Lead. The one exception is the person-level
// do-not-contact (R-CHAN-2, E140), open to whoever still sees the record and holds contact.edit on it (the Owner, an
// Admin, a collaborator of the loser; not a TC, F3): recording an opt-out only tightens, and the definer trigger
// app.contacts_dnc_follow_merge (migration 0018) copies it onto the survivor's own row, along merge chains, which is
// the row core canContact and the dispatch guards read. Real Postgres, the real server, fake providers only.
import { randomUUID } from 'node:crypto';
import type { Purpose } from '@realty/core/compliance';
import type { Instant } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { evaluateGate } from '../comms/gateInput.js';
import * as msgs from '../comms/repos/messages.js';
import { type CommsWorld, commsWorld, ownedContact, randomEmail, sendText } from '../comms/testing.js';
import { call, command, freshReauth, randomPhone } from '../leads/testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;
let admin: TestClient;
let tc: TestClient;
let brokerage: string;
let identity: { id: string; address: string };

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, rule: false, teamLead: true, others: ['admin', 'tc'] });
  agent = w.agents[0]!;
  agent2 = w.agents[1]!;
  admin = w.others[0]!;
  tc = w.others[1]!;
  brokerage = (await h.su.query<{ n: string }>('SELECT brokerage_legal_name AS n FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
  identity = { id: w.identityId, address: (await h.su.query<{ a: string }>('SELECT from_address AS a FROM email_identities WHERE id = $1', [w.identityId])).rows[0]!.a };
}, 180_000);
afterAll(async () => {
  await h?.close();
});

interface Pt {
  id: string;
  address: string;
  hmac: string;
}
const pointOf = async (contactId: string, address: string): Promise<Pt> =>
  (await h.su.query<Pt>("SELECT id, address, encode(address_hmac, 'hex') AS hmac FROM contact_points WHERE contact_id = $1 AND address = $2", [contactId, address])).rows[0]!;

/** The agent's survivor S and duplicate L (each with its own phone and email), L merged into S by the Owner. */
async function mergedPair(): Promise<{ s: { id: string; phone: string; email: string }; l: { id: string; phone: string; email: string } }> {
  const s = await ownedContact(agent, { consent: false });
  const l = await ownedContact(agent, { consent: false, confirmDistinct: true });
  await freshReauth(h, w.owner);
  const m = await command(w.owner, s.id, 'merge', { loserId: l.id });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
  // after the merge the agent (its former owner) no longer sees the merged-away record; the Owner and Admins still do
  expect((await call(agent, 'GET', `/contacts/${l.id}`)).status).toBe(404);
  return { s, l };
}

const OPT_OUT = ['PERSON_DO_NOT_CONTACT', 'CONSENT_REVOKED', 'SUPPRESSED'] as const;

/** The app gate (buildGateInput + core.canContact) as the agent, for a human send/call to `to`: only its opt-out reasons. */
async function appOptOuts(contactId: string, to: Pt, channel: 'sms' | 'voice' | 'email', purpose: Purpose): Promise<string[]> {
  const body = `${brokerage}: checking in about the house. Reply STOP to opt out. Unsubscribe: https://x.example/u`;
  const e = await withTenantTx(
    agent.actor(),
    (tx, now) =>
      evaluateGate(tx, { contactId, recipient: { kind: 'contact', addressHmac: to.hmac, channel, pointId: to.id }, purpose, initiator: 'human', category: 'none', sender: { phoneNumberId: channel === 'email' ? null : w.mainNumberId, emailIdentityId: channel === 'email' ? identity.id : null }, body: channel === 'voice' ? null : body }, now),
    { db: h.database },
  );
  return e.decision.reasons.filter((r) => (OPT_OUT as readonly string[]).includes(r));
}

class Rollback extends Error {}

/** The DB dispatch guard, core bypassed, as the agent, always rolled back: a text/email moved to dispatching, or a call row. */
async function guardSays(contactId: string, to: Pt, channel: 'sms' | 'voice' | 'email', purpose: Purpose): Promise<string> {
  const write = async (tx: Tx, now: Instant): Promise<void> => {
    const conversationId = await msgs.ensureConversation(tx, randomUUID(), contactId, null);
    if (channel === 'voice') {
      await sql`
        INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id, client_address, initiator, status, started_at, recording_mode, recording_decision)
        VALUES (app.tenant_id(), ${randomUUID()}, ${conversationId}, ${contactId}, 'outbound', ${w.mainNumberId}, ${agent.userId}, ${to.address}, 'human', 'initiated', now(), 'off', '{"mode":"off"}'::jsonb)`.execute(tx);
      return;
    }
    const id = randomUUID();
    await msgs.insertOutbound(tx, {
      id, conversationId, contactId, channel, phoneNumberId: channel === 'sms' ? w.mainNumberId : null, emailIdentityId: channel === 'email' ? identity.id : null,
      fromAddress: channel === 'sms' ? w.mainNumber : identity.address, toAddress: to.address, subject: channel === 'email' ? 'Checking in' : null,
      body: 'Checking in', status: 'queued', scheduledFor: null, initiator: 'human', initiatedByUserId: agent.userId!, purpose, actionCategory: 'none',
      assistantActionId: null, playbookStepRunId: null, pinnedInboundSeq: null, idempotencyKey: `live:${id}`, occurredAt: now,
    });
    await msgs.markDispatching(tx, id, now);
  };
  try {
    await withTenantTx(agent.actor(), async (tx, now) => {
      await write(tx, now);
      throw new Rollback('rolled back on purpose');
    }, { db: h.database });
  } catch (e) {
    if (e instanceof Rollback) return 'allow';
    const code = /^([A-Z_]+):/.exec((e as Error).message)?.[1];
    if (!code) throw e;
    return code;
  }
  throw new Error('unreachable');
}

/** Both layers, for every channel of each point and every purpose: `${address} ${channel} ${purpose}` -> [app opt-out reasons, guard code]. */
async function verdicts(contactId: string, points: { phones: Pt[]; emails: Pt[] }): Promise<Record<string, [string[], string]>> {
  const out: Record<string, [string[], string]> = {};
  const legs = [...points.phones.flatMap((p) => [['sms', p], ['voice', p]] as const), ...points.emails.map((p) => ['email', p] as const)];
  for (const [channel, p] of legs) {
    for (const purpose of ['informational', 'marketing'] as const) {
      out[`${p.address} ${channel} ${purpose}`] = [await appOptOuts(contactId, p, channel, purpose), await guardSays(contactId, p, channel, purpose)];
    }
  }
  return out;
}

const dncOf = async (ids: string[]) =>
  Object.fromEntries((await h.su.query<{ id: string; at: Date | null; ev: string | null }>('SELECT id, do_not_contact_at AS at, do_not_contact_event_id AS ev FROM contacts WHERE id = ANY ($1::uuid[])', [ids])).rows.map((r) => [r.id, { at: r.at, ev: r.ev }]));

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

  it('every other api/people write that would strand a row on the merged-away loser stays refused for the Owner and an Admin (404): edits, stage, points, addresses, relationships, notes, logged activity; nothing lands on the loser', async () => {
    const s = await ownedContact(agent, { consent: false });
    const l = await ownedContact(agent, { consent: false, confirmDistinct: true });
    const other = await ownedContact(agent, { consent: false });
    // an address on L before the merge: a merge moves points (copied), tags, values, relationships and notes, not addresses
    const addr = await call<{ address: { id: string } }>(agent, 'POST', `/contacts/${l.id}/addresses`, { kind: 'home', line1: '1 Main St', city: 'Charleston', region: 'SC', postalCode: '29401' });
    expect(addr.status, JSON.stringify(addr.body)).toBe(201);
    await freshReauth(h, w.owner);
    expect((await command(w.owner, s.id, 'merge', { loserId: l.id })).status).toBe(200);
    const lPhone = await pointOf(l.id, l.phone);
    const snapshot = async () =>
      (
        await h.su.query(
          `SELECT c.row_version, c.stage, c.first_name, c.do_not_contact_at,
                  (SELECT count(*)::int FROM notes n WHERE n.contact_id = c.id) AS notes,
                  (SELECT count(*)::int FROM contact_points p WHERE p.contact_id = c.id) AS points,
                  (SELECT string_agg(p.label || ':' || p.is_primary || ':' || (p.removed_at IS NULL), ',' ORDER BY p.id) FROM contact_points p WHERE p.contact_id = c.id) AS point_flags,
                  (SELECT string_agg(a.id::text || ':' || a.kind || ':' || coalesce(a.line1, ''), ',' ORDER BY a.id) FROM contact_addresses a WHERE a.contact_id = c.id) AS addresses,
                  (SELECT count(*)::int FROM contact_relationships r WHERE r.contact_id = c.id OR r.related_contact_id = c.id) AS relationships
             FROM contacts c WHERE c.id = $1`,
          [l.id],
        )
      ).rows[0];
    const before = await snapshot();
    const at = new Date().toISOString();
    const got: Record<string, number> = {};
    for (const c of [w.owner, admin]) {
      const rv = (await h.su.query<{ v: number }>('SELECT row_version AS v FROM contacts WHERE id = $1', [l.id])).rows[0]!.v;
      const tries: [string, 'POST' | 'PATCH' | 'DELETE', string, unknown][] = [
        ['edit', 'PATCH', `/contacts/${l.id}`, { rowVersion: rv, firstName: 'Stranded' }],
        ['stage', 'POST', `/contacts/${l.id}/stage`, { stage: 'nurture' }],
        ['point add', 'POST', `/contacts/${l.id}/points`, { kind: 'email', address: randomEmail() }],
        ['point replace', 'POST', `/contacts/${l.id}/points/${lPhone.id}/replace`, { address: randomPhone() }],
        ['point remove', 'POST', `/contacts/${l.id}/points/${lPhone.id}/remove`, { reason: 'old' }],
        ['point primary', 'POST', `/contacts/${l.id}/points/${lPhone.id}/primary`, {}],
        ['point label', 'PATCH', `/contacts/${l.id}/points/${lPhone.id}`, { label: 'work' }],
        ['address add', 'POST', `/contacts/${l.id}/addresses`, { kind: 'mailing', line1: '2 Side St' }],
        ['address edit', 'PATCH', `/contacts/${l.id}/addresses/${addr.body.address.id}`, { kind: 'home', line1: '3 Moved St' }],
        ['address delete', 'DELETE', `/contacts/${l.id}/addresses/${addr.body.address.id}`, undefined],
        ['address restore', 'POST', `/contacts/${l.id}/addresses/${addr.body.address.id}/restore`, { restoreToken: 'x'.repeat(32) }],
        ['relationship add', 'POST', `/contacts/${l.id}/relationships`, { relatedContactId: other.id, kind: 'family' }],
        ['relationship delete', 'DELETE', `/contacts/${l.id}/relationships/${randomUUID()}`, undefined],
        ['note', 'POST', `/contacts/${l.id}/notes`, { body: 'on the loser' }],
        ['activity', 'POST', `/contacts/${l.id}/activities`, { kind: 'call', direction: 'outbound', at }],
      ];
      for (const [label, method, url, body] of tries) got[`${c.role} ${label}`] = (await call(c, method, url, body)).status;
    }
    expect(Object.keys(got)).toHaveLength(30);
    expect(Object.entries(got).filter(([, status]) => status !== 404)).toEqual([]);
    // nothing landed on the loser
    expect(await snapshot()).toEqual(before);
  });

  it('R-CHAN-2 E140: the Owner and an Admin still record the person-level do-not-contact of a merged-away record they see (tighten-only); the survivor’s own row carries it and every text, call and email to the survivor is refused, by core canContact and by the dispatch guards, every purpose', async () => {
    for (const by of [w.owner, admin]) {
      const { s, l } = await mergedPair();
      const sPoints = { phones: [await pointOf(s.id, s.phone)], emails: [await pointOf(s.id, s.email)] };
      // control: before, nothing blocks the survivor's own phone and email
      for (const [k, v] of Object.entries(await verdicts(s.id, sPoints))) expect({ k, v }).toEqual({ k, v: [[], 'allow'] });

      const r = await call<{ doNotContact: boolean; alreadySet: boolean; revokedPoints: number }>(by, 'POST', `/contacts/${l.id}/do-not-contact`, { reason: 'asked_on_call' });
      expect(r.status, `${by.role}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body).toEqual({ doNotContact: true, alreadySet: false, revokedPoints: 2 });

      // the carry follow-up B designed (E140): app.contacts_dnc_follow_merge copied the loser's do-not-contact and its
      // ledger event onto the survivor's own row
      const dnc = await dncOf([s.id, l.id]);
      expect(dnc[l.id]!.ev, `${by.role}`).not.toBeNull();
      expect(dnc[s.id], `${by.role}`).toEqual(dnc[l.id]);
      const ev = (await h.su.query('SELECT event_type, source, contact_id FROM consent_events WHERE id = $1', [dnc[l.id]!.ev])).rows[0];
      expect(ev).toEqual({ event_type: 'revoke', source: 'agent_revoke', contact_id: l.id });

      // a phone and an email added to the survivor afterwards carry no revoke of their own: the carried flag blocks them too
      const later = randomPhone();
      const laterEmail = randomEmail();
      expect((await call(agent, 'POST', `/contacts/${s.id}/points`, { kind: 'phone', address: later })).status).toBe(201);
      expect((await call(agent, 'POST', `/contacts/${s.id}/points`, { kind: 'email', address: laterEmail })).status).toBe(201);
      const all = { phones: [...sPoints.phones, await pointOf(s.id, later), await pointOf(s.id, l.phone)], emails: [...sPoints.emails, await pointOf(s.id, laterEmail), await pointOf(s.id, l.email)] };
      const v = await verdicts(s.id, all);
      expect(Object.keys(v)).toHaveLength(3 * 2 * 2 + 3 * 2);
      for (const [k, [app, guard]] of Object.entries(v)) {
        expect({ k, by: by.role, app: app.includes('PERSON_DO_NOT_CONTACT'), guard }).toEqual({ k, by: by.role, app: true, guard: 'PERSON_DO_NOT_CONTACT' });
      }
      // and through the real send path: blocked for the person, nothing reaches the fake provider
      const sent = h.providers.telephony.sms.length;
      expect((await sendText(agent, s.id, 'Checking in')).body).toMatchObject({ result: 'blocked', decision: { reasons: expect.arrayContaining(['PERSON_DO_NOT_CONTACT']) } });
      expect(h.providers.telephony.sms.length).toBe(sent);
      // tighten-only: asked again, nothing changes
      const again = await call(by, 'POST', `/contacts/${l.id}/do-not-contact`, {});
      expect([again.status, again.body]).toMatchObject([200, { doNotContact: true, alreadySet: true }]);
      expect(await dncOf([s.id, l.id])).toEqual(dnc);
    }
  });

  it('R-PERM-5 F3: who records a merged-away record’s do-not-contact is whoever still sees its detail and holds contact.edit on it: a collaborator of the loser (200, carried onto a survivor they cannot see, which it then blocks; their other writes stay 404); the TC on the loser’s deal follows the deal to the survivor (b7 ownership-data/F1: deal roles follow a merge), so it no longer sees the loser (404); the former owner and their Team Lead see nothing (404)', async () => {
    const s = await ownedContact(agent, { consent: false });
    const l = await ownedContact(agent, { consent: false, confirmDistinct: true });
    expect((await call(agent, 'POST', `/contacts/${l.id}/collaborators`, { userId: agent2.userId, role: 'co_agent' })).status).toBe(200);
    const deal = await call<{ deal: { id: string } }>(agent, 'POST', '/deals', { primaryContactId: l.id, side: 'buy' });
    expect(deal.status, JSON.stringify(deal.body)).toBe(201);
    expect((await call(agent, 'POST', `/deals/${deal.body.deal.id}/members`, { userId: tc.userId, role: 'tc' })).status).toBe(200);
    await freshReauth(h, w.owner);
    expect((await command(w.owner, s.id, 'merge', { loserId: l.id })).status).toBe(200);
    // who sees what after the merge: a merge does not move the loser's collaborators; its deals follow the person to the
    // survivor (b7 review ownership-data/F1), so the deal's TC now sees the survivor and not the loser
    const sees = async (c: TestClient, id: string) => (await call(c, 'GET', `/contacts/${id}`)).status;
    const tl = w.teamLead!;
    expect({ collaborator: [await sees(agent2, l.id), await sees(agent2, s.id)], tc: [await sees(tc, l.id), await sees(tc, s.id)], former: await sees(agent, l.id), teamLead: await sees(tl, l.id) })
      .toEqual({ collaborator: [200, 404], tc: [404, 200], former: 404, teamLead: 404 });
    const ledger = async () => Number((await h.su.query<{ n: string }>('SELECT count(*) AS n FROM consent_events WHERE contact_id = ANY ($1::uuid[])', [[s.id, l.id]])).rows[0]!.n);
    const n = await ledger();
    // refused: no sight of the record (the TC, the former owner, the Team Lead); nothing is recorded
    for (const [who, c] of [['tc', tc], ['former owner', agent], ['team lead', tl]] as const) {
      const r = await call<{ error: { code: string } }>(c, 'POST', `/contacts/${l.id}/do-not-contact`, { reason: 'asked_on_call' });
      expect({ who, r: [r.status, r.body.error?.code] }).toEqual({ who, r: [404, 'NOT_FOUND'] });
    }
    expect(await dncOf([s.id, l.id])).toEqual({ [s.id]: { at: null, ev: null }, [l.id]: { at: null, ev: null } });
    expect(await ledger()).toBe(n);
    // the loser's collaborator records it: tighten-only, and the trigger carries it to the survivor they cannot see
    const r = await call<{ doNotContact: boolean; alreadySet: boolean; revokedPoints: number }>(agent2, 'POST', `/contacts/${l.id}/do-not-contact`, { reason: 'asked_on_call' });
    expect([r.status, r.body]).toEqual([200, { doNotContact: true, alreadySet: false, revokedPoints: 2 }]);
    const dnc = await dncOf([s.id, l.id]);
    expect(dnc[l.id]!.ev).not.toBeNull();
    expect(dnc[s.id]).toEqual(dnc[l.id]);
    // which blocks the person: the survivor's owner texting the survivor is refused, nothing reaches the provider
    const sent = h.providers.telephony.sms.length;
    expect((await sendText(agent, s.id, 'Checking in')).body).toMatchObject({ result: 'blocked', decision: { reasons: expect.arrayContaining(['PERSON_DO_NOT_CONTACT']) } });
    expect(h.providers.telephony.sms.length).toBe(sent);
    // and the collaborator's writes that would strand a row on the loser stay refused
    const at = new Date().toISOString();
    const writes = {
      note: (await call(agent2, 'POST', `/contacts/${l.id}/notes`, { body: 'on the loser' })).status,
      point: (await call(agent2, 'POST', `/contacts/${l.id}/points`, { kind: 'phone', address: randomPhone() })).status,
      stage: (await call(agent2, 'POST', `/contacts/${l.id}/stage`, { stage: 'nurture' })).status,
      activity: (await call(agent2, 'POST', `/contacts/${l.id}/activities`, { kind: 'call', direction: 'outbound', at })).status,
    };
    expect(writes).toEqual({ note: 404, point: 404, stage: 404, activity: 404 });
  });

  it('R-PERM-5: an agent who cannot see the merged-away record gets 404 for its do-not-contact, and nothing is recorded', async () => {
    const { s, l } = await mergedPair();
    const ledger = async () => Number((await h.su.query<{ n: string }>('SELECT count(*) AS n FROM consent_events WHERE contact_id = ANY ($1::uuid[])', [[s.id, l.id]])).rows[0]!.n);
    const n = await ledger();
    const r = await call<{ error: { code: string } }>(agent, 'POST', `/contacts/${l.id}/do-not-contact`, { reason: 'asked_on_call' });
    expect([r.status, r.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    expect(await dncOf([s.id, l.id])).toEqual({ [s.id]: { at: null, ev: null }, [l.id]: { at: null, ev: null } });
    expect(await ledger()).toBe(n);
  });
});
