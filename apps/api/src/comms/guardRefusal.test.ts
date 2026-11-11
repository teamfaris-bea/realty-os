// Defence in depth behind R-PAR-12, R-CHAN-2 and the suppressions (D1): canContact reads the dispatch guards'
// own facts (repos/gate.ts optOutFanoutPhoneHmacs, personDoNotContact, suppressionRows), so a guard never
// refuses a send the gate allowed (guardEquivalence.test.ts and optOutFanout.test.ts prove it case by case).
// This file forces that disagreement: a read is stubbed to see nothing (the fan-out: the old loader's blind
// spot, removed phones; the person-level do-not-contact; the suppressions), while the guards still read
// everything. Every guard refusal about the recipient must still reach the agent as a clean blocked result with
// the guard's reason, recorded like a deny, nothing sent, never a 500 and never retried; any other refusal or
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
import { queueOutboundInTx } from './compose.js';
import { dispatchOutbound } from './dispatch.js';
import { DISPATCH_DENY_SENTENCES, type GuardDenyReason, GUARD_DENY_REASONS, guardOptOutRefusal } from './gateInput.js';
import type * as AutomationRepo from './repos/automation.js';
import type * as GateRepo from './repos/gate.js';
import { type CommsWorld, call, commsWorld, decisionsFor, inboundSms, messageRow, ownedContact, randomPhone, sendText } from './testing.js';

// The seams: while `blind` is set, the gate's fan-out read returns no phones, so canContact sees only the
// recipient's own opt-outs. While `blindDnc` is set, the gate reads no person-level do-not-contact; while
// `blindSuppressions` is set, it reads no suppressions. While `forgeApproval` is set, TX1 reads every assistant
// action as approved by `forgeApproval` (a refusal that is not about the recipient). Unset, they are the real reads.
const seam = vi.hoisted(() => ({ blind: false, blindDnc: false, blindSuppressions: false, forgeApproval: null as string | null }));
vi.mock('./repos/gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof GateRepo>();
  return {
    ...real,
    optOutFanoutPhoneHmacs: async (...a: Parameters<typeof real.optOutFanoutPhoneHmacs>) => (seam.blind ? [] : real.optOutFanoutPhoneHmacs(...a)),
    personDoNotContact: async (...a: Parameters<typeof real.personDoNotContact>) => (seam.blindDnc ? false : real.personDoNotContact(...a)),
    suppressionRows: async (...a: Parameters<typeof real.suppressionRows>) => (seam.blindSuppressions ? [] : real.suppressionRows(...a)),
  };
});
vi.mock('./repos/automation.js', async (importOriginal) => {
  const real = await importOriginal<typeof AutomationRepo>();
  return {
    ...real,
    actionFacts: async (...a: Parameters<typeof real.actionFacts>) => {
      const f = await real.actionFacts(...a);
      return f && seam.forgeApproval ? { ...f, status: 'approved', decidedByUserId: seam.forgeApproval } : f;
    },
  };
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
  seam.blindDnc = false;
  seam.blindSuppressions = false;
  seam.forgeApproval = null;
});
afterAll(async () => {
  await h?.close();
});

const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone);
const callsTo = (phone: string) => h.providers.telephony.calls.filter((x) => x.to === phone);
const pointIdOf = async (contactId: string, address: string) => (await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [contactId, address])).rows[0]!.id;
const touchOf = async (contactId: string) => (await h.su.query<{ at: Date | null }>('SELECT last_human_touch_at AS at FROM contacts WHERE id = $1', [contactId])).rows[0]!.at;
const callCount = async (contactId: string) => (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM calls WHERE contact_id = $1', [contactId])).rows[0]!.n;
type CallRes = { result: string; callId: string | null; decision: { id: string | null; outcome: string; reasons: string[]; explanation: string } };
const dial = (contactId: string, body: Record<string, unknown> = {}) => call<CallRes>(agent, 'POST', `/contacts/${contactId}/calls`, body);

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

/**
 * R-CHAN-2's person: they asked not to be contacted (the one-tap person-level do-not-contact, which also revokes
 * every channel on the points they had), and the agent added a new phone afterwards, which carries no revoke of
 * its own: only the do-not-contact blocks it (the guards check it before the opt-outs).
 */
async function personDoNotContactWithNewPhone(): Promise<{ id: string; fresh: string; freshId: string }> {
  const c = await ownedContact(agent, { consent: false });
  expect((await call(agent, 'POST', `/contacts/${c.id}/do-not-contact`, {})).status).toBe(200);
  const fresh = randomPhone();
  expect((await call(agent, 'POST', `/contacts/${c.id}/points`, { kind: 'phone', address: fresh, label: 'work' })).status).toBe(201);
  const freshId = await pointIdOf(c.id, fresh);
  expect((await call(agent, 'POST', `/contacts/${c.id}/points/${freshId}/primary`)).status).toBe(200);
  return { id: c.id, fresh, freshId };
}

/** A contact whose only phone is suppressed (an admin block: no application path writes one here). */
async function suppressedPerson(): Promise<{ id: string; phone: string }> {
  const c = await ownedContact(agent);
  const hmac = (await h.su.query<{ hmac: string }>("SELECT encode(address_hmac, 'hex') AS hmac FROM contact_points WHERE contact_id = $1 AND address = $2", [c.id, c.phone])).rows[0]!.hmac;
  await suFixture(h, [{ text: "INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason) VALUES ($1, $2, 'phone', decode($3, 'hex'), $4, 'all', 'admin_block')", values: [w.tenantId, randomUUID(), hmac, `•••-•••-${c.phone.slice(-4)}`] }]);
  return { id: c.id, phone: c.phone };
}

/** The stored blocked-send row is a deny like any other: the guard's code, its sentence, a digest of the stored inputs. */
async function expectRecordedLikeADeny(where: { messageId?: string; callId?: string }, decisionId: string, code: GuardDenyReason = 'RECIPIENT_OPTED_OUT'): Promise<void> {
  const rows = await decisionsFor(h, where);
  expect(rows.map((d) => [d.id, d.outcome, d.phase, d.reason_codes, d.explanation])).toEqual([[decisionId, 'deny', 'send', [code], DISPATCH_DENY_SENTENCES[code]]]);
  expect(rows[0]!.inputs.dispatchReasons).toEqual([code]);
  expect(rows[0]!.inputs_sha256).toBe(sha256Hex(canonicalJson(rows[0]!.inputs as never)));
}

/** A scheduled human text to `contactId` that is now due (the worker's send; no application path moves time). */
async function dueText(contactId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const later = await sendText(agent, contactId, 'Later', { scheduleAt: new Date(Date.now() + 3600_000).toISOString(), ...extra });
  expect(later.body.result).toBe('scheduled');
  const mid = later.body.message!.id;
  await suFixture(h, [{ text: "UPDATE messages SET scheduled_for = now() - interval '1 minute' WHERE id = $1", values: [mid] }]);
  return mid;
}

describe('defence in depth: a dispatch guard refusal about the recipient is a blocked send, never a 500', () => {
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
    const mid = await dueText(c.id);
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
    const before = await callCount(c.id);
    const touched = await touchOf(c.id);
    seam.blind = true;
    const r = await dial(c.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: 'gate', callId: null, decision: { id: expect.any(String), outcome: 'deny', reasons: ['RECIPIENT_OPTED_OUT'], explanation: DISPATCH_DENY_SENTENCES.RECIPIENT_OPTED_OUT } });
    const row = (await decisionsFor(h, { contactId: c.id })).find((d) => d.id === r.body.decision.id)!;
    expect(row).toMatchObject({ outcome: 'deny', phase: 'send', reason_codes: ['RECIPIENT_OPTED_OUT'] });
    expect(row.inputs.dispatchReasons).toEqual(['RECIPIENT_OPTED_OUT']);
    expect(await callCount(c.id)).toBe(before);
    expect(await touchOf(c.id)).toEqual(touched);
    expect(callsTo(c.work)).toEqual([]);
  });

  it('R-PAR-12: with the real fan-out read the same sends are refused by canContact itself (CONSENT_REVOKED), so the guard is never reached', async () => {
    const t = await personWithRemovedOptOut({ optOut: 'stop' });
    expect((await sendText(agent, t.id, 'Checking in')).body).toMatchObject({ result: 'blocked', decision: { reasons: ['CONSENT_REVOKED'] } });
    const v = await personWithRemovedOptOut({ optOut: 'do_not_call' });
    expect((await dial(v.id)).body).toMatchObject({ result: 'gate', decision: { reasons: ['CONSENT_REVOKED'] } });
  });

  it('R-CHAN-2: when the guards refuse a text (in-request and the worker’s) and a call for a person-level do-not-contact the gate did not see, each is a clean blocked result with PERSON_DO_NOT_CONTACT, recorded like a deny: no dispatching row, no call row, no touch, nothing sent or dialed, never a 500', async () => {
    const p = await personDoNotContactWithNewPhone();
    const touched = await touchOf(p.id);
    const callsBefore = await callCount(p.id);
    const sent = h.providers.telephony.sms.length;
    const dialed = h.providers.telephony.calls.length;
    // control: with the real reads canContact refuses the new phone itself, with the person-level reason
    const gate = await sendText(agent, p.id, 'Checking in', { toPointId: p.freshId });
    expect(gate.body).toMatchObject({ result: 'blocked', decision: { reasons: expect.arrayContaining(['PERSON_DO_NOT_CONTACT']) } });
    expect((await dial(p.id, { toPointId: p.freshId })).body).toMatchObject({ result: 'gate', decision: { reasons: expect.arrayContaining(['PERSON_DO_NOT_CONTACT']) } });
    const scheduled = await dueText(p.id, { toPointId: p.freshId });
    seam.blind = true;
    seam.blindDnc = true;

    const r = await sendText(agent, p.id, 'Checking in about the house', { toPointId: p.freshId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: 'blocked', message: { status: 'blocked', statusReason: 'PERSON_DO_NOT_CONTACT', dispatchedAt: null } });
    expect(r.body.decision).toMatchObject({ outcome: 'deny', reasons: ['PERSON_DO_NOT_CONTACT'], explanation: DISPATCH_DENY_SENTENCES.PERSON_DO_NOT_CONTACT, phase: 'send' });
    await expectRecordedLikeADeny({ messageId: r.body.message!.id }, r.body.decision!.id!, 'PERSON_DO_NOT_CONTACT');

    const wr = await dispatchOutbound(scheduled, w.deps, { tenantId: w.tenantId as TenantId });
    expect(wr).toMatchObject({ kind: 'blocked', messageId: scheduled, decision: { outcome: 'deny', reasons: ['PERSON_DO_NOT_CONTACT'] } });
    await expectRecordedLikeADeny({ messageId: scheduled }, (wr as { decision: { id: string } }).decision.id, 'PERSON_DO_NOT_CONTACT');
    expect(await messageRow(h, scheduled)).toMatchObject({ status: 'blocked', status_reason: 'PERSON_DO_NOT_CONTACT', dispatched_at: null });
    expect(await dispatchOutbound(scheduled, w.deps, { tenantId: w.tenantId as TenantId })).toMatchObject({ kind: 'noop', status: 'blocked' });

    const v = await dial(p.id, { toPointId: p.freshId });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ result: 'gate', callId: null, decision: { id: expect.any(String), outcome: 'deny', reasons: ['PERSON_DO_NOT_CONTACT'], explanation: DISPATCH_DENY_SENTENCES.PERSON_DO_NOT_CONTACT } });
    expect((await decisionsFor(h, { contactId: p.id })).find((d) => d.id === v.body.decision.id)!.inputs.dispatchReasons).toEqual(['PERSON_DO_NOT_CONTACT']);

    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND status NOT IN ('blocked','canceled')", [p.id])).rows[0].n).toBe(0);
    expect(await callCount(p.id)).toBe(callsBefore);
    expect(await touchOf(p.id)).toEqual(touched);
    expect(h.providers.telephony.sms.length).toBe(sent);
    expect(h.providers.telephony.calls.length).toBe(dialed);
    expect(smsTo(p.fresh)).toEqual([]);
    expect(callsTo(p.fresh)).toEqual([]);
  });

  it('a RECIPIENT_SUPPRESSED the gate did not see is a clean blocked result through the worker’s dispatch and the dial, recorded like a deny: nothing sent or dialed, never a 500; with the real read canContact refuses both first (SUPPRESSED)', async () => {
    const c = await suppressedPerson();
    const scheduled = await dueText(c.id);
    seam.blindSuppressions = true;
    const callsBefore = await callCount(c.id);
    const touched = await touchOf(c.id);
    const sent = h.providers.telephony.sms.length;
    const dialed = h.providers.telephony.calls.length;

    // the dispatch (as the worker runs it): the guard's refusal becomes the blocked result, not an error
    const r = await dispatchOutbound(scheduled, w.deps, { tenantId: w.tenantId as TenantId });
    expect(r).toMatchObject({ kind: 'blocked', messageId: scheduled, decision: { outcome: 'deny', reasons: ['RECIPIENT_SUPPRESSED'], explanation: DISPATCH_DENY_SENTENCES.RECIPIENT_SUPPRESSED } });
    await expectRecordedLikeADeny({ messageId: scheduled }, (r as { decision: { id: string } }).decision.id, 'RECIPIENT_SUPPRESSED');
    expect(await messageRow(h, scheduled)).toMatchObject({ status: 'blocked', status_reason: 'RECIPIENT_SUPPRESSED', dispatched_at: null });
    expect(await dispatchOutbound(scheduled, w.deps, { tenantId: w.tenantId as TenantId })).toMatchObject({ kind: 'noop', status: 'blocked' });
    // the in-request send and the dial: a blocked answer and a gate answer, never a 500
    const now = await sendText(agent, c.id, 'Checking in');
    expect([now.status, now.body.result, now.body.message?.statusReason]).toEqual([200, 'blocked', 'RECIPIENT_SUPPRESSED']);
    await expectRecordedLikeADeny({ messageId: now.body.message!.id }, now.body.decision!.id!, 'RECIPIENT_SUPPRESSED');
    const v = await dial(c.id);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ result: 'gate', callId: null, decision: { id: expect.any(String), outcome: 'deny', reasons: ['RECIPIENT_SUPPRESSED'] } });
    expect(await callCount(c.id)).toBe(callsBefore);
    expect(await touchOf(c.id)).toEqual(touched);
    expect(h.providers.telephony.sms.length).toBe(sent);
    expect(h.providers.telephony.calls.length).toBe(dialed);

    // control: with the real read canContact refuses both itself, cleanly, so the seam is what made the guard decide
    seam.blindSuppressions = false;
    expect((await sendText(agent, c.id, 'Checking in')).body).toMatchObject({ result: 'blocked', decision: { reasons: ['SUPPRESSED'] } });
    expect((await dial(c.id)).body).toMatchObject({ result: 'gate', decision: { reasons: ['SUPPRESSED'] } });
    expect(smsTo(c.phone)).toEqual([]);
    expect(callsTo(c.phone)).toEqual([]);
  });

  it('every guard refusal about the recipient is classified as a block, from the real guards: RECIPIENT_OPTED_OUT, RECIPIENT_NOT_A_CONTACT_POINT, PERSON_DO_NOT_CONTACT and RECIPIENT_SUPPRESSED check violations map; every other error does not', async () => {
    expect([...GUARD_DENY_REASONS].sort()).toEqual(['PERSON_DO_NOT_CONTACT', 'RECIPIENT_NOT_A_CONTACT_POINT', 'RECIPIENT_OPTED_OUT', 'RECIPIENT_SUPPRESSED']);
    const c = await personWithRemovedOptOut({ optOut: 'stop' });
    const dnc = await personDoNotContactWithNewPhone();
    const sup = await suppressedPerson();
    const convOf = async (id: string) => (await h.su.query<{ id: string }>('SELECT id FROM conversations WHERE contact_id = $1', [id])).rows[0]?.id ?? null;
    // core bypassed: a queued text moved to dispatching by the system
    const refusalOf = async (contactId: string, to: string): Promise<unknown> => {
      const mid = randomUUID();
      const conv = (await convOf(contactId)) ?? (await withTenantTx(systemActor(w.tenantId, 'worker'), async (tx) => {
        const id = randomUUID();
        await sql`INSERT INTO conversations (tenant_id, id, contact_id) VALUES (app.tenant_id(), ${id}, ${contactId})`.execute(tx);
        return id;
      }, { db: h.database }));
      await h.su.query(
        `INSERT INTO messages (tenant_id, id, contact_id, conversation_id, channel, direction, initiator, initiated_by_user_id, purpose, action_category, body, phone_number_id, from_address, to_address, status, occurred_at)
         VALUES ($1, $2, $3, $4, 'sms', 'outbound', 'human', $5, 'informational', 'none', 'x', $6, $7, $8, 'queued', now())`,
        [w.tenantId, mid, contactId, conv, agent.userId, w.mainNumberId, w.mainNumber, to],
      );
      return withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE id = ${mid}`.execute(tx), { db: h.database }).then(
        () => null,
        (e: unknown) => e,
      );
    };
    const cases: [string, string, GuardDenyReason][] = [
      [c.id, c.work, 'RECIPIENT_OPTED_OUT'],
      [c.id, randomPhone(), 'RECIPIENT_NOT_A_CONTACT_POINT'],
      [dnc.id, dnc.fresh, 'PERSON_DO_NOT_CONTACT'],
      [sup.id, sup.phone, 'RECIPIENT_SUPPRESSED'],
    ];
    for (const [contactId, to, code] of cases) {
      const e = await refusalOf(contactId, to);
      expect(e, code).toMatchObject({ code: '23514', message: expect.stringMatching(new RegExp(`^${code}:`)) });
      expect(guardOptOutRefusal(e)).toBe(code);
    }
    // the calls guard raises the same codes (an outbound call row written with core bypassed)
    const callRefusal = async (contactId: string, to: string): Promise<unknown> =>
      withTenantTx(agent.actor(), async (tx) => {
        const conv = await convOf(contactId);
        await sql`INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id, client_address, initiator, status, started_at, recording_mode, recording_decision)
                  VALUES (app.tenant_id(), ${randomUUID()}, ${conv}, ${contactId}, 'outbound', ${w.mainNumberId}, ${agent.userId}, ${to}, 'human', 'initiated', now(), 'off', '{"mode":"off"}'::jsonb)`.execute(tx);
      }, { db: h.database }).then(() => null, (e: unknown) => e);
    for (const [contactId, to, code] of [[dnc.id, dnc.fresh, 'PERSON_DO_NOT_CONTACT'], [sup.id, sup.phone, 'RECIPIENT_SUPPRESSED']] as const) {
      const e = await callRefusal(contactId, to);
      expect(e, code).toMatchObject({ code: '23514', message: expect.stringMatching(new RegExp(`^${code}:`)) });
      expect(guardOptOutRefusal(e)).toBe(code);
    }
    // another check violation from the database (a point's address never changes) is not a block
    const immutable = await withTenantTx(agent.actor(), (tx) => sql`UPDATE contact_points SET address = ${randomPhone()} WHERE contact_id = ${c.id}::uuid`.execute(tx), { db: h.database }).then(() => null, (e: unknown) => e);
    expect(immutable).toMatchObject({ code: '23514', message: expect.stringMatching(/^CONTACT_POINT_IMMUTABLE:/) });
    expect(guardOptOutRefusal(immutable)).toBeNull();
    // the guards' refusals that are not about the recipient, other SQLSTATEs, a code that is not at the start, and non-errors are not blocks
    for (const e of [
      { code: '23514', message: 'ASSISTANT_ACTION_NOT_APPROVED' },
      { code: '23514', message: 'ASSISTANT_ACTION_MISSING' },
      { code: '23514', message: 'PLAYBOOK_NOT_APPROVED' },
      { code: '23514', message: 'AUTOMATION_PAUSED: the client replied; hand back instead' },
      { code: '23514', message: 'MARKETING_PIECE_NOT_APPROVED: an invite is sent only from an approved open-house invite version' },
      { code: '23514', message: 'PLATFORM_NOT_CLEARED: Messenger and Instagram sending is off until counsel reviews the platform:meta pack' },
      { code: '23514', message: 'CHANNEL_UNKNOWN: no opt-out mapping for channel fax' },
      { code: '23505', message: 'RECIPIENT_OPTED_OUT: a unique violation that merely says so' },
      { code: '23505', message: 'PERSON_DO_NOT_CONTACT: a unique violation that merely says so' },
      { code: '23514', message: 'the guard said RECIPIENT_SUPPRESSED: elsewhere' },
      { code: '23514', message: 'RECIPIENT_OPTED_OUT without the separator' },
      { code: '23514', message: 'PERSON_DO_NOT_CONTACT without the separator' },
      new Error('RECIPIENT_OPTED_OUT: no SQLSTATE'),
      'PERSON_DO_NOT_CONTACT: a string',
      null,
      undefined,
    ]) {
      expect(guardOptOutRefusal(e), JSON.stringify(e ?? null)).toBeNull();
    }
  });

  it('every other guard refusal stays an error through the real paths: an assistant message whose approval TX1 misread (ASSISTANT_ACTION_NOT_APPROVED from the guard) rejects the dispatch; nothing recorded, nothing sent, the message left as it was', async () => {
    const c = await ownedContact(agent);
    const pending = randomUUID();
    // a draft still waiting for its approval, bound to the agent's current ownership period
    await suFixture(h, [{ text: "INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, bound_ownership_seq) SELECT $1,$2,$3,'message_draft','novel_message','requires_approval','proposed',$4,'Draft','{}', ownership_period_seq FROM contacts WHERE id = $3", values: [w.tenantId, pending, c.id, agent.userId] }]);
    const q = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'sms', idempotencyKey: `t:${randomUUID()}`, body: 'About the offer: want to talk tonight?', category: 'novel_message', purpose: 'informational', initiator: 'assistant', assistantActionId: pending } as never, now), { db: h.database });
    if (!q.ok) throw new Error(q.code);
    const sent = h.providers.telephony.sms.length;
    seam.forgeApproval = agent.userId!;
    await expect(dispatchOutbound(q.messageId, w.deps, { tenantId: w.tenantId as TenantId })).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/^ASSISTANT_ACTION_NOT_APPROVED/) });
    expect(await messageRow(h, q.messageId)).toMatchObject({ status: 'queued', status_reason: null, gate_decision_id: null, dispatched_at: null });
    expect(await decisionsFor(h, { messageId: q.messageId })).toEqual([]);
    expect(h.providers.telephony.sms.length).toBe(sent);
    // control: with the real read TX1 blocks it itself, cleanly
    seam.forgeApproval = null;
    expect(await dispatchOutbound(q.messageId, w.deps, { tenantId: w.tenantId as TenantId })).toMatchObject({ kind: 'blocked', decision: { reasons: expect.arrayContaining(['ASSISTANT_ACTION_NOT_APPROVED']) } });
    expect(smsTo(c.phone)).toEqual([]);
  });
});
