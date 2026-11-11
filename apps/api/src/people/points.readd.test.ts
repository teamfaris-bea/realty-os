// Re-adding a phone or email this person once had, through module 57's API (R-PAR-11, R-PAR-12). A point's
// address never changes and the person has at most one row per address (UNIQUE (tenant, contact, kind,
// address)), so "add it again" restores that row: same id, same HMAC history, so an opt-out recorded on it keeps
// blocking. A point removed as a confirmed wrong number is final: the API refuses it as WRONG_NUMBER_FINAL (409),
// never a 500, for a phone and for an email, by add and by replace, and the database refuses a raw restore.
// Real Postgres, the real server and paths, fake providers only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, emailWebhook, inboundSms, ownedContact, randomEmail, randomPhone, sendText } from '../comms/testing.js';

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

interface Row {
  id: string;
  status: string;
  removed_reason: string | null;
  removed: boolean;
  hmac: string;
}
const rowsOf = async (contactId: string, address: string): Promise<Row[]> =>
  (await h.su.query<Row>("SELECT id, status, removed_reason, removed_at IS NOT NULL AS removed, encode(address_hmac, 'hex') AS hmac FROM contact_points WHERE contact_id = $1 AND address = $2", [contactId, address])).rows;
const revoked = async (hmac: string, channel: string) =>
  (await h.su.query<{ status: string }>("SELECT status FROM consent_state WHERE tenant_id = $1 AND address_hmac = decode($2, 'hex') AND channel = $3", [w.tenantId, hmac, channel])).rows.map((r) => r.status);
type Points = { points: { id: string; address: string; status: string }[]; removed: { id: string; reason: string | null }[] };
const points = async (contactId: string) => (await call<Points>(agent, 'GET', `/contacts/${contactId}/points`)).body;
const add = (contactId: string, kind: 'phone' | 'email', address: string) => call<{ point: { id: string; address: string; status: string } }>(agent, 'POST', `/contacts/${contactId}/points`, { kind, address });
const remove = (contactId: string, pointId: string, reason: 'old' | 'wrong_number') => call(agent, 'POST', `/contacts/${contactId}/points/${pointId}/remove`, { reason });
const replace = (contactId: string, pointId: string, address: string) => call(agent, 'POST', `/contacts/${contactId}/points/${pointId}/replace`, { address });

describe('R-PAR-11 R-PAR-12: adding a number or email the person once had', () => {
  it('R-PAR-11 R-PAR-12 E168: a phone removed as old, or replaced, comes back as the same row (same id and HMAC, 201): its STOP still blocks texting the person, and the replacement stays', async () => {
    const c = await ownedContact(agent);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const [orig] = await rowsOf(c.id, c.phone);
    const work = randomPhone();
    expect((await add(c.id, 'phone', work)).status).toBe(201);
    // removed as old, then added again: the same row, live again
    expect((await remove(c.id, orig!.id, 'old')).status).toBe(200);
    const again = await add(c.id, 'phone', c.phone);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.point).toMatchObject({ id: orig!.id, address: c.phone, status: 'active' });
    expect(await rowsOf(c.id, c.phone)).toEqual([{ ...orig!, status: 'active', removed_reason: null, removed: false }]);
    // replaced by a new number, then added again: the same row once more; the replacement is kept
    const next = randomPhone();
    expect((await replace(c.id, orig!.id, next)).status).toBe(201);
    expect(await rowsOf(c.id, c.phone)).toEqual([{ ...orig!, status: 'removed', removed_reason: 'replaced', removed: true }]);
    const back = await add(c.id, 'phone', c.phone);
    expect([back.status, back.body.point.id]).toEqual([201, orig!.id]);
    expect((await points(c.id)).points.map((p) => p.address).filter((a) => !a.includes('@')).sort()).toEqual([c.phone, next, work].sort());
    // the HMAC history came back with the row: the STOP still blocks every text to the person
    expect(await revoked(orig!.hmac, 'sms')).toEqual(['revoked', 'revoked']);
    expect((await sendText(agent, c.id, 'Checking in')).body).toMatchObject({ result: 'blocked', decision: { reasons: ['CONSENT_REVOKED'] } });
    expect(h.providers.telephony.sms.filter((m) => [c.phone, next, work].includes(m.to))).toEqual([]);
  });

  it('R-PAR-11: an email removed as old comes back as the same row, typed in any case (201); its opt-out stays with it', async () => {
    const c = await ownedContact(agent, { consent: false });
    const e = randomEmail();
    expect((await add(c.id, 'email', e)).status).toBe(201);
    const [orig] = await rowsOf(c.id, e);
    expect((await call(agent, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: orig!.id, channel: 'email', purpose: 'all', evidence: {} })).status).toBe(200);
    expect((await remove(c.id, orig!.id, 'old')).status).toBe(200);
    const again = await add(c.id, 'email', e.toUpperCase());
    expect([again.status, again.body.point.id, again.body.point.address]).toEqual([201, orig!.id, e]);
    expect(await revoked(orig!.hmac, 'email')).toEqual(['revoked', 'revoked']);
  });

  it('R-PAR-12 E169: a phone removed as a confirmed wrong number is final: adding it again, or replacing another number with it, is WRONG_NUMBER_FINAL (409, never a 500); nothing changes and its opt-outs stay', async () => {
    const c = await ownedContact(agent);
    const work = randomPhone();
    expect((await add(c.id, 'phone', work)).status).toBe(201);
    // the person's own "wrong number" reply writes the ledger record that lets it be removed as one
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Wrong number, sorry')).statusCode).toBe(200);
    const [wrong] = await rowsOf(c.id, c.phone);
    expect((await remove(c.id, wrong!.id, 'wrong_number')).status).toBe(200);
    const before = await rowsOf(c.id, c.phone);
    expect(before).toEqual([{ ...wrong!, status: 'removed', removed_reason: 'wrong_number', removed: true }]);

    const again = await add(c.id, 'phone', c.phone);
    expect([again.status, again.code]).toEqual([409, 'WRONG_NUMBER_FINAL']);
    const workId = (await rowsOf(c.id, work))[0]!.id;
    const swap = await replace(c.id, workId, c.phone);
    expect([swap.status, swap.code]).toEqual([409, 'WRONG_NUMBER_FINAL']);
    // the refused replace removed nothing (one transaction): the work phone is still live
    expect(await rowsOf(c.id, work)).toEqual([expect.objectContaining({ id: workId, removed: false, removed_reason: null })]);
    expect(await rowsOf(c.id, c.phone)).toEqual(before);
    expect(await revoked(wrong!.hmac, 'sms')).toEqual(['revoked', 'revoked']);
    expect(await revoked(wrong!.hmac, 'voice')).toEqual(['revoked', 'revoked']);
  });

  it('R-PAR-12: an email removed as a confirmed wrong address (the person’s "wrong person" reply) is final too: WRONG_NUMBER_FINAL (409), never a 500', async () => {
    const c = await ownedContact(agent, { consent: false });
    // an open appointment makes the email informational (no marketing footer needed); the reply comes through its token
    await h.su.query("INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, created_by_kind) VALUES ($1,$2,$3,$4,'consult',now() + interval '1 day',now() + interval '25 hours','user')", [w.tenantId, randomUUID(), c.id, agent.userId]);
    const sent = await call<{ result: string }>(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Showing', body: 'Here are the details.', idempotencyKey: `e-${randomUUID()}` });
    expect(sent.body.result).toBe('sent');
    const replyTo = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!.replyTo!;
    expect((await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: c.email, to: replyTo, subject: 'Re: Showing', text: 'Wrong person, sorry.' })).statusCode).toBe(200);
    const [wrong] = await rowsOf(c.id, c.email);
    expect((await remove(c.id, wrong!.id, 'wrong_number')).status).toBe(200);
    const again = await add(c.id, 'email', c.email);
    expect([again.status, again.code]).toEqual([409, 'WRONG_NUMBER_FINAL']);
    expect(await rowsOf(c.id, c.email)).toEqual([{ ...wrong!, status: 'removed', removed_reason: 'wrong_number', removed: true }]);
  });

  it('R-PAR-11 R-PAR-12: with the API bypassed, the database keeps one row per address and never restores a confirmed wrong number; its refusal no longer suggests adding the number again', async () => {
    const c = await ownedContact(agent);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Wrong number')).statusCode).toBe(200);
    const [wrong] = await rowsOf(c.id, c.phone);
    expect((await remove(c.id, wrong!.id, 'wrong_number')).status).toBe(200);
    const asAgent = <T>(fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(agent.actor(), fn, { db: h.database }).then(() => null, (e: unknown) => e);
    const restore = await asAgent((tx) => sql`UPDATE contact_points SET removed_at = NULL, removed_reason = NULL, status = 'active' WHERE id = ${wrong!.id}::uuid`.execute(tx));
    expect(restore).toMatchObject({ code: '23514', message: 'REMOVED_REASON_IMMUTABLE: a confirmed wrong number is final; it is never added back to this person' });
    const second = await asAgent((tx) => sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label) VALUES (app.tenant_id(), ${randomUUID()}::uuid, ${c.id}::uuid, 'phone', ${c.phone}, decode(${wrong!.hmac}, 'hex'), 'mobile')`.execute(tx));
    expect(second).toMatchObject({ code: '23505' });
    expect(await rowsOf(c.id, c.phone)).toEqual([{ ...wrong!, status: 'removed', removed_reason: 'wrong_number', removed: true }]);
  });
});
