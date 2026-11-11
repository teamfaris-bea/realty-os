// R-PAR-12 at the send-time gate (the parity L1 lane's finding for module 22). The opt-out fan-out the gate
// reads (repos/gate.ts optOutFanoutPhoneHmacs) is the dispatch guards' own set: every phone of the contact,
// live or removed, except one removed as a confirmed wrong number. So an opt-out on a removed phone is
// refused up front by canContact, with its reason, and the guard is never the one to refuse (no 500); the
// one exception mirrors the guard. Real Postgres, the real server and paths, fake providers only.
import { randomUUID } from 'node:crypto';
import type { Purpose } from '@realty/core/compliance';
import type { Instant } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { evaluateGate } from './gateInput.js';
import * as msgs from './repos/messages.js';
import { type CommsWorld, call, commsWorld, decisionsFor, inboundSms, ownedContact, randomPhone, sendText } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let brokerage: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1, rule: false });
  agent = w.agents[0]!;
  await alertPhone(agent);
  brokerage = (await h.su.query<{ n: string }>('SELECT brokerage_legal_name AS n FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
});
afterAll(async () => {
  await h?.close();
});

/** The agent's verified phone: a call rings the agent first (dial.ts). */
async function alertPhone(c: TestClient): Promise<void> {
  const ch = await c.post('/api/me/alert-phone', { phone: randomPhone() });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
}

interface Pt {
  id: string;
  address: string;
  hmac: string;
  status: string;
  removed_reason: string | null;
}
async function pointOf(contactId: string, address: string): Promise<Pt> {
  const r = await h.su.query<Pt>("SELECT id, address, encode(address_hmac, 'hex') AS hmac, status, removed_reason FROM contact_points WHERE contact_id = $1 AND address = $2", [contactId, address]);
  return r.rows[0]!;
}

async function addPhone(contactId: string, address: string): Promise<string> {
  const r = await call<{ point: { id: string } }>(agent, 'POST', `/contacts/${contactId}/points`, { kind: 'phone', address, label: 'work' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.point.id;
}

async function removePoint(contactId: string, pointId: string, reason: 'old' | 'wrong_number'): Promise<void> {
  const r = await call(agent, 'POST', `/contacts/${contactId}/points/${pointId}/remove`, { reason });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

type CallRes = { result: string; callId: string | null; decision: { id: string | null; outcome: string; reasons: string[] } };
const dial = (contactId: string, body: Record<string, unknown> = {}) => call<CallRes>(agent, 'POST', `/contacts/${contactId}/calls`, body);
const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone);
const callsTo = (phone: string) => h.providers.telephony.calls.filter((x) => x.to === phone);

describe('R-PAR-12: the send-time gate reads the dispatch guards’ opt-out fan-out', () => {
  for (const how of ['old', 'replaced'] as const) {
    it(`R-PAR-12 R-CONSENT-7 E168: a STOP on a phone later removed as ${how} blocks texting the person's other live phone at the gate: a clean blocked answer with the reason, nothing handed to the provider`, async () => {
      const c = await ownedContact(agent);
      expect((await inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
      const stopped = await pointOf(c.id, c.phone);
      const work = randomPhone();
      if (how === 'old') {
        await addPhone(c.id, work);
        await removePoint(c.id, stopped.id, 'old');
      } else {
        const r = await call(agent, 'POST', `/contacts/${c.id}/points/${stopped.id}/replace`, { address: work });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
      }
      expect(await pointOf(c.id, c.phone)).toMatchObject({ status: 'removed', removed_reason: how });
      const sent = h.providers.telephony.sms.length;

      const r = await sendText(agent, c.id, 'Checking in about the house');
      expect(r.status).toBe(200);
      expect(r.body.result).toBe('blocked');
      expect(r.body.message).toMatchObject({ status: 'blocked', statusReason: 'CONSENT_REVOKED' });
      expect(r.body.decision).toMatchObject({ id: expect.any(String), outcome: 'deny', reasons: ['CONSENT_REVOKED'], phase: 'send' });
      // recorded like every deny: the blocked-send row cites the removed phone's STOP among its inputs
      const rows = await decisionsFor(h, { messageId: r.body.message!.id });
      expect(rows.map((d) => [d.outcome, d.phase, d.reason_codes])).toEqual([['deny', 'send', ['CONSENT_REVOKED']]]);
      const consent = rows[0]!.inputs.consent as { addressHmac: string; channel: string; status: string }[];
      expect(consent.filter((x) => x.status === 'revoked' && x.channel === 'sms').map((x) => x.addressHmac)).toContain(stopped.hmac);
      // nothing left: no provider call, no message past the gate
      expect(smsTo(work)).toEqual([]);
      expect(h.providers.telephony.sms.length).toBe(sent);
      expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND status NOT IN ('blocked','canceled')", [c.id])).rows[0].n).toBe(0);
      // the compose preview says the same before the tap; compose still offers only the live phone
      const p = await call<{ decision: { outcome: string; reasons: string[] } }>(agent, 'POST', `/contacts/${c.id}/messages/preview`, { channel: 'sms', body: 'Checking in' });
      expect(p.body.decision).toMatchObject({ outcome: 'deny', reasons: ['CONSENT_REVOKED'] });
      expect((await call(agent, 'POST', `/contacts/${c.id}/messages/preview`, { channel: 'sms', body: 'x', toPointId: stopped.id })).code).toBe('CONTACT_POINT_MISSING');
    });
  }

  it('R-PAR-12 E169: a STOP on a phone removed as a confirmed wrong number does not block the person’s other phone (the guards’ one exception), and the wrong number keeps its opt-outs', async () => {
    const c = await ownedContact(agent);
    const reported = async () =>
      Object.fromEntries((await call<{ points: { address: string; wrongNumberReported: boolean }[] }>(agent, 'GET', `/contacts/${c.id}/points`)).body.points.map((p) => [p.address, p.wrongNumberReported]));
    expect((await inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    // a STOP is not a wrong-number report: the person's page does not offer "wrong number" for it yet
    expect(await reported()).toEqual({ [c.phone]: false, [c.email]: false });
    // the ledger proves it a wrong number (the wrong-number reply path), then it is removed as one
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Wrong number, sorry')).statusCode).toBe(200);
    const wrong = await pointOf(c.id, c.phone);
    expect(wrong.status).toBe('wrong_number');
    const work = randomPhone();
    await addPhone(c.id, work);
    // the page offers "wrong number" exactly where the remove route accepts it: on the reported number only
    expect(await reported()).toEqual({ [c.phone]: true, [work]: false, [c.email]: false });
    await removePoint(c.id, wrong.id, 'wrong_number');
    expect((await pointOf(c.id, c.phone)).removed_reason).toBe('wrong_number');

    const r = await sendText(agent, c.id, 'Hi, this is your agent following up.');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: 'sent', message: { status: 'sent' }, decision: { outcome: 'allow', reasons: [] } });
    expect(smsTo(work)).toHaveLength(1);
    // nothing was lifted: the wrong number's own SMS and voice rows stay revoked
    const st = (await h.su.query<{ channel: string; status: string }>("SELECT channel, status FROM consent_state WHERE tenant_id = $1 AND address_hmac = decode($2, 'hex') AND channel IN ('sms','voice')", [w.tenantId, wrong.hmac])).rows;
    expect(st.length).toBeGreaterThan(0);
    expect(st.every((x) => x.status === 'revoked')).toBe(true);
  });

  it('R-PAR-12 R-CONSENT-7 outbound-3: a "do not call" on a removed phone blocks calling the person’s other phone through the dial path; nothing is dialed', async () => {
    const c = await ownedContact(agent, { consent: false });
    const first = await pointOf(c.id, c.phone);
    const r0 = await dial(c.id);
    expect(r0.body.result).toBe('dialing');
    expect((await call(agent, 'POST', `/calls/${r0.body.callId}/outcome`, { outcome: 'do_not_call_request' })).status).toBe(200);
    const work = randomPhone();
    const workId = await addPhone(c.id, work);
    await removePoint(c.id, first.id, 'old');
    const before = (await h.su.query<{ id: string }>('SELECT id FROM calls WHERE contact_id = $1', [c.id])).rows.map((x) => x.id);
    expect(before).toEqual([r0.body.callId]);

    for (const body of [{}, { toPointId: workId }]) {
      const r = await dial(c.id, body);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ result: 'gate', callId: null, decision: { id: expect.any(String), outcome: 'deny', reasons: ['CONSENT_REVOKED'] } });
    }
    // no call row was written past the gate and the provider dialed nothing to the live phone
    expect((await h.su.query<{ id: string }>('SELECT id FROM calls WHERE contact_id = $1', [c.id])).rows.map((x) => x.id)).toEqual(before);
    expect(callsTo(work)).toEqual([]);
    const logged = (await decisionsFor(h, { contactId: c.id })).filter((d) => d.reason_codes.includes('CONSENT_REVOKED'));
    expect(logged.map((d) => [d.outcome, d.phase, d.reason_codes])).toEqual([['deny', 'send', ['CONSENT_REVOKED']], ['deny', 'send', ['CONSENT_REVOKED']]]);
    // a do-not-call is about calls: texting the live phone stays open
    const p = await call<{ decision: { outcome: string } }>(agent, 'POST', `/contacts/${c.id}/messages/preview`, { channel: 'sms', body: 'Checking in' });
    expect(p.body.decision.outcome).toBe('allow');
  });
});

// ---- START after a removal: the lift reads the same phones the send-time fan-out reads --------------

describe('R-PAR-12 with R-CONSENT-10 outbound-4: START lifts what its own STOP revoked, also on a phone removed since', () => {
  /** A contact with phones A and B, both live: a STOP from A also revokes B (R-CONSENT-7). */
  async function twoPhones(): Promise<{ id: string; a: string; b: string }> {
    const a = randomPhone();
    const b = randomPhone();
    const r = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Sam', lastName: 'Start', phones: [a, b], emails: [] });
    expect([200, 201]).toContain(r.status);
    return { id: r.body.contact.id, a, b };
  }
  /** The address's SMS consent rows, one per purpose. */
  const smsStatus = async (hmac: string) =>
    (await h.su.query<{ status: string }>("SELECT status FROM consent_state WHERE tenant_id = $1 AND channel = 'sms' AND address_hmac = decode($2, 'hex') ORDER BY purpose", [w.tenantId, hmac])).rows.map((x) => x.status);
  const resubscribes = async (hmac: string) =>
    (await h.su.query<{ n: number }>("SELECT count(*)::int AS n FROM consent_events WHERE tenant_id = $1 AND address_hmac = decode($2, 'hex') AND event_type = 'resubscribe'", [w.tenantId, hmac])).rows[0]!.n;
  type Reach = { channels: { sms: { blocked: boolean; reasons: { code: string; source: string; otherAddress: boolean; addressRemoved: boolean; addressHint: string | null }[] } } };
  const reach = async (id: string) => (await call<{ reachability: Reach }>(agent, 'GET', `/contacts/${id}/reachability`)).body.reachability.channels.sms;

  for (const how of ['old', 'replaced'] as const) {
    it(`R-PAR-12 outbound-4: A texts STOP (B gets its copy), B is ${how === 'old' ? 'removed as old' : 'replaced'}, A texts START: B's copy is lifted too and the next text to A is sent`, async () => {
      const p = await twoPhones();
      expect((await inboundSms(h, p.a, w.mainNumber, 'STOP')).statusCode).toBe(200);
      const b = await pointOf(p.id, p.b);
      expect(await smsStatus(b.hmac)).toEqual(['revoked', 'revoked']);
      if (how === 'old') await removePoint(p.id, b.id, 'old');
      else expect((await call(agent, 'POST', `/contacts/${p.id}/points/${b.id}/replace`, { address: randomPhone() })).status).toBe(201);
      expect((await pointOf(p.id, p.b)).removed_reason).toBe(how);

      expect((await inboundSms(h, p.a, w.mainNumber, 'START')).statusCode).toBe(200);
      const a = await pointOf(p.id, p.a);
      expect(await smsStatus(a.hmac)).not.toContain('revoked');
      expect(await smsStatus(b.hmac)).not.toContain('revoked');
      const r = await sendText(agent, p.id, 'Welcome back');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ result: 'sent', decision: { outcome: 'allow', reasons: [] } });
      expect(smsTo(p.a)).toHaveLength(1);
      // the summary agrees: nobody is shown as having texted STOP
      expect(await reach(p.id)).toMatchObject({ blocked: false, reasons: [] });
    });
  }

  it('R-PAR-12 outbound-4: when B texted its own STOP before it was removed, A’s START lifts A only; the person stays blocked by B’s STOP', async () => {
    const p = await twoPhones();
    expect((await inboundSms(h, p.b, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const b = await pointOf(p.id, p.b);
    await removePoint(p.id, b.id, 'old');
    expect((await inboundSms(h, p.a, w.mainNumber, 'START')).statusCode).toBe(200);
    expect(await smsStatus((await pointOf(p.id, p.a)).hmac)).not.toContain('revoked');
    expect(await smsStatus(b.hmac)).toEqual(['revoked', 'revoked']);
    expect(await resubscribes(b.hmac)).toBe(0);
    const r = await sendText(agent, p.id, 'Welcome back');
    expect(r.body).toMatchObject({ result: 'blocked', decision: { outcome: 'deny', reasons: ['CONSENT_REVOKED'] } });
    expect(smsTo(p.a)).toEqual([]);
    expect(await reach(p.id)).toMatchObject({ blocked: true, reasons: [expect.objectContaining({ code: 'CONSENT_REVOKED', source: 'keyword', otherAddress: true, addressRemoved: true, addressHint: `•••-•••-${p.b.slice(-4)}` })] });
  });

  it('R-PAR-12 outbound-4: B’s copy also came from its own later STOP: A’s START does not lift B', async () => {
    const p = await twoPhones();
    expect((await inboundSms(h, p.a, w.mainNumber, 'STOP')).statusCode).toBe(200);
    expect((await inboundSms(h, p.b, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const b = await pointOf(p.id, p.b);
    await removePoint(p.id, b.id, 'old');
    expect((await inboundSms(h, p.a, w.mainNumber, 'START')).statusCode).toBe(200);
    expect(await smsStatus(b.hmac)).toEqual(['revoked', 'revoked']);
    expect(await resubscribes(b.hmac)).toBe(0);
    expect((await sendText(agent, p.id, 'Welcome back')).body).toMatchObject({ result: 'blocked', decision: { reasons: ['CONSENT_REVOKED'] } });
    expect(smsTo(p.a)).toEqual([]);
  });

  it('R-PAR-12 E169 outbound-4: a phone removed as a confirmed wrong number is outside the lift as it is outside the fan-out: A’s START writes nothing on it, it keeps its opt-outs, and A is textable', async () => {
    const p = await twoPhones();
    expect((await inboundSms(h, p.a, w.mainNumber, 'STOP')).statusCode).toBe(200);
    expect((await inboundSms(h, p.b, w.mainNumber, 'Wrong number')).statusCode).toBe(200);
    const b = await pointOf(p.id, p.b);
    await removePoint(p.id, b.id, 'wrong_number');
    expect((await inboundSms(h, p.a, w.mainNumber, 'START')).statusCode).toBe(200);
    expect(await resubscribes(b.hmac)).toBe(0);
    expect(await smsStatus(b.hmac)).toEqual(['revoked', 'revoked']);
    expect((await sendText(agent, p.id, 'Welcome back')).body).toMatchObject({ result: 'sent' });
    expect(smsTo(p.a)).toHaveLength(1);
  });
});

// ---- equivalence: the app gate decides exactly what the DB guards decide ----------------------------

type State = 'live' | 'removed_old' | 'removed_replaced' | 'removed_wrong_number';
type Where = 'nowhere' | 'recipient' | 'other';
const STATES: readonly State[] = ['live', 'removed_old', 'removed_replaced', 'removed_wrong_number'];

class Rollback extends Error {}

/**
 * A contact with a live recipient phone R and another phone O in `state`. The opt-out (a staff-recorded
 * SMS and voice revoke of `purpose`) is recorded on `where` while the point is live, as in production; a
 * wrong-number removal is proven first by the person's own "wrong number" reply from O.
 */
async function arrange(state: State, where: Where, purpose: 'all' | 'marketing'): Promise<{ contactId: string; r: Pt }> {
  const rPhone = randomPhone();
  const oPhone = randomPhone();
  const made = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Mia', lastName: 'Matrix', phones: [rPhone, oPhone], emails: [] });
  expect([200, 201]).toContain(made.status);
  const contactId = made.body.contact.id;
  const r = await pointOf(contactId, rPhone);
  const o = await pointOf(contactId, oPhone);
  if (where !== 'nowhere') {
    const at = where === 'recipient' ? r : o;
    for (const channel of ['sms', 'voice'] as const) {
      const rv = await call(agent, 'POST', `/contacts/${contactId}/consent`, { kind: 'revoke', pointId: at.id, channel, purpose, evidence: {} });
      expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    }
  }
  if (state === 'removed_old') await removePoint(contactId, o.id, 'old');
  if (state === 'removed_replaced') expect((await call(agent, 'POST', `/contacts/${contactId}/points/${o.id}/replace`, { address: randomPhone() })).status).toBe(201);
  if (state === 'removed_wrong_number') {
    expect((await inboundSms(h, oPhone, w.mainNumber, 'Wrong number')).statusCode).toBe(200);
    await removePoint(contactId, o.id, 'wrong_number');
  }
  expect((await pointOf(contactId, oPhone)).removed_reason).toBe(state === 'live' ? null : state.slice('removed_'.length));
  // R stays the live, active recipient whatever happened to O
  expect(await pointOf(contactId, rPhone)).toMatchObject({ status: 'active', removed_reason: null });
  return { contactId, r };
}

/** The app gate (buildGateInput + core.canContact), as the agent, for a human send/call to R right now. */
async function appReasons(contactId: string, r: Pt, channel: 'sms' | 'voice', purpose: Purpose): Promise<string[]> {
  const body = `${brokerage}: checking in about the house. Reply STOP to opt out.`;
  const e = await withTenantTx(
    agent.actor(),
    (tx, now) => evaluateGate(tx, { contactId, recipient: { kind: 'contact', addressHmac: r.hmac, channel, pointId: r.id }, purpose, initiator: 'human', category: 'none', sender: { phoneNumberId: w.mainNumberId, emailIdentityId: null }, body: channel === 'voice' ? null : body }, now),
    { db: h.database },
  );
  return e.decision.reasons;
}

/**
 * The DB guard, core bypassed, as the agent, in a transaction that is always rolled back: a queued text
 * to R moved to 'dispatching' (app.messages_dispatch_guard), or an outbound call row to R
 * (app.calls_dispatch_guard). 'allow', or the guard's code.
 */
async function guardSays(contactId: string, r: Pt, channel: 'sms' | 'voice', purpose: Purpose): Promise<string> {
  const write = async (tx: Tx, now: Instant): Promise<void> => {
    const conversationId = await msgs.ensureConversation(tx, randomUUID(), contactId, null);
    if (channel === 'sms') {
      const id = randomUUID();
      await msgs.insertOutbound(tx, {
        id, conversationId, contactId, channel: 'sms', phoneNumberId: w.mainNumberId, emailIdentityId: null, fromAddress: w.mainNumber, toAddress: r.address, subject: null,
        body: 'Checking in', status: 'queued', scheduledFor: null, initiator: 'human', initiatedByUserId: agent.userId!, purpose, actionCategory: 'none',
        assistantActionId: null, playbookStepRunId: null, pinnedInboundSeq: null, idempotencyKey: `eq:${id}`, occurredAt: now,
      });
      await msgs.markDispatching(tx, id, now);
    } else {
      await sql`
        INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id, client_address, initiator, status, started_at, recording_mode, recording_decision)
        VALUES (app.tenant_id(), ${randomUUID()}, ${conversationId}, ${contactId}, 'outbound', ${w.mainNumberId}, ${agent.userId}, ${r.address}, 'human', 'initiated', now(), 'off', '{"mode":"off"}'::jsonb)`.execute(tx);
    }
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

describe('R-PAR-12 equivalence: for every point state and opt-out position, the app gate decides exactly what the DB dispatch guards decide (real Postgres)', () => {
  for (const state of STATES) {
    it(`R-PAR-12 R-CONSENT-7 E168 E169: the other phone ${state.replace('_', ' ')}: texts and calls, every purpose`, async () => {
      const cases: { where: Where; revoke: 'all' | 'marketing' }[] = [{ where: 'nowhere', revoke: 'all' }, ...(['recipient', 'other'] as const).flatMap((where) => (['all', 'marketing'] as const).map((revoke) => ({ where, revoke })))];
      for (const k of cases) {
        const { contactId, r } = await arrange(state, k.where, k.revoke);
        for (const channel of ['sms', 'voice'] as const) {
          for (const purpose of ['informational', 'marketing'] as const) {
            const label = `${state} / opt-out on ${k.where} (${k.revoke}) / ${channel} ${purpose}`;
            const app = await appReasons(contactId, r, channel, purpose);
            const guard = await guardSays(contactId, r, channel, purpose);
            // the two layers agree, case by case: canContact refuses exactly when the guard would
            expect({ label, app: app.includes('CONSENT_REVOKED') ? 'refused' : 'allowed', guard: guard === 'RECIPIENT_OPTED_OUT' ? 'refused' : guard }).toEqual({ label, app: guard === 'allow' ? 'allowed' : 'refused', guard: guard === 'allow' ? 'allow' : 'refused' });
            // and both follow R-PAR-12: the recipient's own opt-out, or the other phone's unless it was removed
            // as a confirmed wrong number; a text needs the purpose to match, a call is blocked by either
            const counts = k.where === 'recipient' || (k.where === 'other' && state !== 'removed_wrong_number');
            const blocks = counts && (channel === 'voice' || k.revoke === 'all' || k.revoke === purpose);
            expect({ label, app, guard }).toEqual({ label, app: blocks ? ['CONSENT_REVOKED'] : [], guard: blocks ? 'RECIPIENT_OPTED_OUT' : 'allow' });
          }
        }
      }
    });
  }
});
