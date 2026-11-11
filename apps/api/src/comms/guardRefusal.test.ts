// Defence in depth behind R-PAR-12 (D1): canContact reads the dispatch guards' own opt-out fan-out
// (repos/gate.ts optOutFanoutPhoneHmacs), so a guard never refuses a send the gate allowed. This file forces
// that disagreement: the fan-out read is stubbed to see nothing (the old loader's blind spot, removed phones),
// while the guards still read every phone. The guard's refusal must still reach the agent as a clean blocked
// result with the guard's reason, recorded like a deny, nothing sent, never a 500 and never retried; any other
// error stays an error. Real Postgres, the real server and paths, fake providers only.
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@realty/core/compliance';
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { dispatchOutbound } from './dispatch.js';
import { DISPATCH_DENY_SENTENCES, guardOptOutRefusal } from './gateInput.js';
import type * as GateRepo from './repos/gate.js';
import { type CommsWorld, call, commsWorld, decisionsFor, inboundSms, messageRow, ownedContact, randomPhone, sendText } from './testing.js';

// The seam: while `blind` is set, the gate's fan-out read returns no phones, so canContact sees only the
// recipient's own opt-outs. Unset, it is the real read.
const seam = vi.hoisted(() => ({ blind: false }));
vi.mock('./repos/gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof GateRepo>();
  return { ...real, optOutFanoutPhoneHmacs: async (...a: Parameters<typeof real.optOutFanoutPhoneHmacs>) => (seam.blind ? [] : real.optOutFanoutPhoneHmacs(...a)) };
});

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1, rule: false });
  agent = w.agents[0]!;
  const ch = await agent.post('/api/me/alert-phone', { phone: randomPhone() });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const v = await agent.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (v.statusCode !== 200) throw new Error(`alert phone: ${v.statusCode} ${v.body}`);
});
afterEach(() => {
  seam.blind = false;
});
afterAll(async () => {
  await h?.close();
});

const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone);
const callsTo = (phone: string) => h.providers.telephony.calls.filter((x) => x.to === phone);
const pointIdOf = async (contactId: string, address: string) => (await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [contactId, address])).rows[0]!.id;
const touchOf = async (contactId: string) => (await h.su.query<{ at: Date | null }>('SELECT last_human_touch_at AS at FROM contacts WHERE id = $1', [contactId])).rows[0]!.at;

/** E168's person: the mobile texted STOP (or asked not to be called) and was removed; the work phone is live. */
async function personWithRemovedOptOut(o: { optOut: 'stop' | 'do_not_call' }): Promise<{ id: string; work: string }> {
  const c = await ownedContact(agent, { consent: o.optOut === 'stop' });
  if (o.optOut === 'stop') expect((await inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
  else {
    const first = await call<{ callId: string }>(agent, 'POST', `/contacts/${c.id}/calls`, {});
    expect((await call(agent, 'POST', `/calls/${first.body.callId}/outcome`, { outcome: 'do_not_call_request' })).status).toBe(200);
  }
  const work = randomPhone();
  expect((await call(agent, 'POST', `/contacts/${c.id}/points`, { kind: 'phone', address: work, label: 'work' })).status).toBe(201);
  expect((await call(agent, 'POST', `/contacts/${c.id}/points/${await pointIdOf(c.id, c.phone)}/remove`, { reason: 'old' })).status).toBe(200);
  return { id: c.id, work };
}

/** The stored blocked-send row is a deny like any other: the guard's code, its sentence, a digest of the stored inputs. */
async function expectRecordedLikeADeny(where: { messageId?: string; callId?: string }, decisionId: string): Promise<void> {
  const rows = await decisionsFor(h, where);
  expect(rows.map((d) => [d.id, d.outcome, d.phase, d.reason_codes, d.explanation])).toEqual([[decisionId, 'deny', 'send', ['RECIPIENT_OPTED_OUT'], DISPATCH_DENY_SENTENCES.RECIPIENT_OPTED_OUT]]);
  expect(rows[0]!.inputs.dispatchReasons).toEqual(['RECIPIENT_OPTED_OUT']);
  expect(rows[0]!.inputs_sha256).toBe(sha256Hex(canonicalJson(rows[0]!.inputs as never)));
}

describe('defence in depth: a dispatch guard refusal is a blocked send, never a 500', () => {
  it('R-PAR-12 R-CONSENT-7 E168: when the guard refuses a text the gate allowed (app/DB disagreement), the API answers with a clean blocked result carrying the guard’s reason, recorded like a deny; nothing is sent and TX1 left nothing behind', async () => {
    const c = await personWithRemovedOptOut({ optOut: 'stop' });
    const touched = await touchOf(c.id);
    seam.blind = true;
    const r = await sendText(agent, c.id, 'Checking in about the house');
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('blocked');
    expect(r.body.message).toMatchObject({ status: 'blocked', statusReason: 'RECIPIENT_OPTED_OUT', dispatchedAt: null });
    expect(r.body.decision).toMatchObject({ id: expect.any(String), outcome: 'deny', reasons: ['RECIPIENT_OPTED_OUT'], explanation: DISPATCH_DENY_SENTENCES.RECIPIENT_OPTED_OUT, phase: 'send' });
    await expectRecordedLikeADeny({ messageId: r.body.message!.id }, r.body.decision!.id!);
    expect((await messageRow(h, r.body.message!.id)).gate_decision_id).toBe(r.body.decision!.id);
    // the refused transaction was rolled back whole and not reused: no dispatching row, no touch; nothing sent
    expect(await touchOf(c.id)).toEqual(touched);
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND status <> 'blocked'", [c.id])).rows[0].n).toBe(0);
    expect(smsTo(c.work)).toEqual([]);
  });

  it('R-PAR-12 E168: the worker’s send of a scheduled text the guard refuses is blocked the same way (the job finishes, never retried)', async () => {
    const c = await personWithRemovedOptOut({ optOut: 'stop' });
    const later = await sendText(agent, c.id, 'Later', { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(later.body.result).toBe('scheduled');
    const mid = later.body.message!.id;
    await suFixture(h, [{ text: "UPDATE messages SET scheduled_for = now() - interval '1 minute' WHERE id = $1", values: [mid] }]);
    seam.blind = true;
    const r = await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId as TenantId });
    expect(r).toMatchObject({ kind: 'blocked', messageId: mid, decision: { outcome: 'deny', reasons: ['RECIPIENT_OPTED_OUT'] } });
    await expectRecordedLikeADeny({ messageId: mid }, (r as { decision: { id: string } }).decision.id);
    expect(await messageRow(h, mid)).toMatchObject({ status: 'blocked', status_reason: 'RECIPIENT_OPTED_OUT', dispatched_at: null });
    // a second run finds nothing to send (the message is blocked, not retried)
    expect(await dispatchOutbound(mid, w.deps, { tenantId: w.tenantId as TenantId })).toMatchObject({ kind: 'noop', status: 'blocked' });
    expect(smsTo(c.work)).toEqual([]);
  });

  it('R-PAR-12 outbound-3: when the calls guard refuses a call the gate allowed, the dial answers with a clean gate result carrying the guard’s reason: no call row, nothing dialed', async () => {
    const c = await personWithRemovedOptOut({ optOut: 'do_not_call' });
    const calls = async () => (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM calls WHERE contact_id = $1', [c.id])).rows[0]!.n;
    const before = await calls();
    const touched = await touchOf(c.id);
    seam.blind = true;
    const r = await call<{ result: string; callId: string | null; decision: { id: string | null; outcome: string; reasons: string[]; explanation: string } }>(agent, 'POST', `/contacts/${c.id}/calls`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: 'gate', callId: null, decision: { id: expect.any(String), outcome: 'deny', reasons: ['RECIPIENT_OPTED_OUT'], explanation: DISPATCH_DENY_SENTENCES.RECIPIENT_OPTED_OUT } });
    const row = (await decisionsFor(h, { contactId: c.id })).find((d) => d.id === r.body.decision.id)!;
    expect(row).toMatchObject({ outcome: 'deny', phase: 'send', reason_codes: ['RECIPIENT_OPTED_OUT'] });
    expect(row.inputs.dispatchReasons).toEqual(['RECIPIENT_OPTED_OUT']);
    expect(await calls()).toBe(before);
    expect(await touchOf(c.id)).toEqual(touched);
    expect(callsTo(c.work)).toEqual([]);
  });

  it('R-PAR-12: with the real fan-out read the same sends are refused by canContact itself (CONSENT_REVOKED), so the guard is never reached', async () => {
    const t = await personWithRemovedOptOut({ optOut: 'stop' });
    expect((await sendText(agent, t.id, 'Checking in')).body).toMatchObject({ result: 'blocked', decision: { reasons: ['CONSENT_REVOKED'] } });
    const v = await personWithRemovedOptOut({ optOut: 'do_not_call' });
    expect((await call<{ result: string; decision: { reasons: string[] } }>(agent, 'POST', `/contacts/${v.id}/calls`, {})).body).toMatchObject({ result: 'gate', decision: { reasons: ['CONSENT_REVOKED'] } });
  });

  it('only the guards’ opt-out refusals are a block: RECIPIENT_OPTED_OUT and RECIPIENT_NOT_A_CONTACT_POINT check violations from the real guards map, every other error stays an error', async () => {
    const c = await personWithRemovedOptOut({ optOut: 'stop' });
    const conv = (await h.su.query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1', [c.id])).rows[0]!.id;
    // core bypassed: a queued text moved to dispatching by the system, to the live work phone and to a number not on the person
    const refusalOf = async (to: string): Promise<unknown> => {
      const mid = randomUUID();
      await h.su.query(
        `INSERT INTO messages (tenant_id, id, contact_id, conversation_id, channel, direction, initiator, initiated_by_user_id, purpose, action_category, body, phone_number_id, from_address, to_address, status, occurred_at)
         VALUES ($1, $2, $3, $4, 'sms', 'outbound', 'human', $5, 'informational', 'none', 'x', $6, $7, $8, 'queued', now())`,
        [w.tenantId, mid, c.id, conv, agent.userId, w.mainNumberId, w.mainNumber, to],
      );
      return withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE id = ${mid}`.execute(tx), { db: h.database }).then(
        () => null,
        (e: unknown) => e,
      );
    };
    const optedOut = await refusalOf(c.work);
    expect(optedOut).toMatchObject({ code: '23514', message: expect.stringMatching(/^RECIPIENT_OPTED_OUT:/) });
    expect(guardOptOutRefusal(optedOut)).toBe('RECIPIENT_OPTED_OUT');
    const notOnRecord = await refusalOf(randomPhone());
    expect(notOnRecord).toMatchObject({ code: '23514', message: expect.stringMatching(/^RECIPIENT_NOT_A_CONTACT_POINT:/) });
    expect(guardOptOutRefusal(notOnRecord)).toBe('RECIPIENT_NOT_A_CONTACT_POINT');
    // another check violation from the database (a point's address never changes) is not a block
    const immutable = await withTenantTx(agent.actor(), (tx) => sql`UPDATE contact_points SET address = ${randomPhone()} WHERE contact_id = ${c.id}::uuid`.execute(tx), { db: h.database }).then(() => null, (e: unknown) => e);
    expect(immutable).toMatchObject({ code: '23514', message: expect.stringMatching(/^CONTACT_POINT_IMMUTABLE:/) });
    expect(guardOptOutRefusal(immutable)).toBeNull();
    // the other guard refusals, other SQLSTATEs, a code that is not at the start, and non-errors are not blocks
    for (const e of [
      { code: '23514', message: 'RECIPIENT_SUPPRESSED: this address is suppressed for sms' },
      { code: '23514', message: 'PERSON_DO_NOT_CONTACT: this person asked not to be contacted; nobody can send to them' },
      { code: '23514', message: 'ASSISTANT_ACTION_NOT_APPROVED' },
      { code: '23505', message: 'RECIPIENT_OPTED_OUT: a unique violation that merely says so' },
      { code: '23514', message: 'the guard said RECIPIENT_OPTED_OUT: elsewhere' },
      { code: '23514', message: 'RECIPIENT_OPTED_OUT without the separator' },
      new Error('RECIPIENT_OPTED_OUT: no SQLSTATE'),
      'RECIPIENT_OPTED_OUT: a string',
      null,
      undefined,
    ]) {
      expect(guardOptOutRefusal(e), JSON.stringify(e ?? null)).toBeNull();
    }
  });
});
