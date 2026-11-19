// The global lock order (ARCHITECTURE §10; review D8-R5): a writer that records consent for an address of a contact it
// locks takes the address lock FIRST, the order inbound ingestion takes them (step 1, then step 2). Two writers that
// record a provider-reported opt-out took the contact first: dispatch's TX2 (the provider refused the send as opted
// out) and the status callback (a carrier opt-out code). Against the person's own inbound from that number (their STOP)
// that is the opposite order: a deadlock the database breaks after its timeout, with one side run again.
//
// Each case holds the address lock in a transaction of the test (an inbound that has taken step 1) and shows that the
// writer, while it waits for the address, does not hold the contact. Fakes only: no real provider, no real number.
import { type Tx, lockAddress, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { ProviderError } from '../providers/types.js';
import { systemActor } from '../worker/systemActor.js';
import { dispatchOutbound } from './dispatch.js';
import { type CommsWorld, commsWorld, messageRow, ownedContact, sendText, telephonyWebhook } from './testing.js';
import type { CommsDeps } from './types.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
});
afterAll(async () => {
  await h?.close();
});

const asWorker = <T>(fn: (tx: Tx) => Promise<T>) => withTenantTx(systemActor(w.tenantId as never, 'worker'), fn, { db: h.database });
const hmacOf = (address: string) => asWorker(async (tx) => Buffer.from(await w.deps.envelope.inTx(tx, w.tenantId as never).hmacAddress(w.tenantId as never, address)).toString('hex'));

/** Holds the address lock (an inbound from that number, after its step 1) until `release()`. */
async function holdAddress(hmac: string): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let holding!: () => void;
  const held = new Promise<void>((r) => { holding = r; });
  const other = asWorker(async (tx) => {
    await lockAddress(tx, hmac);
    holding();
    await gate;
  });
  await held;
  return { release: async () => { open(); await other; } };
}

/** Whether the contact's lock can be taken right now (what the inbound's step 2 would do next). */
async function contactLockFree(contactId: string): Promise<boolean> {
  try {
    await asWorker(async (tx) => {
      await sql`SET LOCAL lock_timeout = '400ms'`.execute(tx);
      await sql`SELECT app.lock_contact(${contactId}::uuid)`.execute(tx);
    });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === '55P03') return false;
    throw e;
  }
}

const revokes = async (messageId: string) => (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM consent_events WHERE tenant_id = $1 AND evidence_message_id = $2 AND event_type = 'revoke' AND source = 'provider_report'`, [w.tenantId, messageId])).rows[0]!.n;

describe('a provider-reported opt-out takes the address lock before the contact lock (ARCHITECTURE §10)', () => {
  it('R-CONSENT-12 E792: dispatch TX2, when the provider refuses the send as opted out, waits for the address without holding the contact', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const fake = h.providers.telephony;
    const telephony = Object.create(fake) as typeof fake;
    let refused!: () => void;
    const called = new Promise<void>((r) => { refused = r; });
    // eslint-disable-next-line realty/no-provider-outbound -- test stub: the fake rejects with a carrier opt-out code; nothing is sent
    telephony.sendSms = async () => {
      refused();
      throw new ProviderError('rejected', '21610');
    };
    const deps: CommsDeps = { ...w.deps, providers: { ...w.deps.providers, telephony } };
    const queued = await sendText(agent, c.id, 'Lock order: send-time opt-out', { idempotencyKey: `k-${randomUUID()}`, scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    const id = queued.body.message!.id;
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [id]);
    const inbound = await holdAddress(await hmacOf(c.phone));
    let free: boolean;
    let settled = false;
    const dispatch = dispatchOutbound(id, deps, { tenantId: w.tenantId }).finally(() => { settled = true; });
    try {
      await called;
      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false); // TX2 is waiting for the address
      free = await contactLockFree(c.id);
    } finally {
      await inbound.release();
    }
    expect((await dispatch).kind).toBe('failed');
    expect(free).toBe(true);
    expect((await messageRow(h, id)).status_reason).toBe('PROVIDER_OPTED_OUT');
    expect(await revokes(id)).toBe(1);
  });

  it('R-CONSENT-12 E792: the status callback, on a carrier opt-out code, waits for the address without holding the contact', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const r = await sendText(agent, c.id, 'Lock order: status opt-out');
    const id = r.body.message!.id;
    const ref = (await messageRow(h, id)).provider_message_ref!;
    const inbound = await holdAddress(await hmacOf(c.phone));
    let free: boolean;
    let settled = false;
    const status = telephonyWebhook(h, `/webhooks/telephony/status?m=${id}`, { MessageSid: ref, MessageStatus: 'undelivered', ErrorCode: '21610', From: w.mainNumber, To: c.phone }).finally(() => { settled = true; });
    try {
      await new Promise((r2) => setTimeout(r2, 700));
      expect(settled).toBe(false); // the callback is waiting for the address
      free = await contactLockFree(c.id);
    } finally {
      await inbound.release();
    }
    expect((await status).statusCode).toBe(200);
    expect(free).toBe(true);
    expect((await messageRow(h, id)).status).toBe('undelivered');
    expect(await revokes(id)).toBe(1);
  });
});
