// Two-session races on one contact (ARCHITECTURE §10 global lock order; E22, E66). Real Postgres, real
// concurrent transactions: dispatch TX1, inbound ingestion and the ownership timers all take
// app.lock_contact. To exercise BOTH orders (not just whichever happens to be faster), a third session
// holds the contact lock while the two contenders start and queue on it in a chosen order; releasing it
// lets them run concurrently in that order. A free-running race follows as well.
import { type ContactId } from '@realty/core/foundation';
import { lockContact, withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { command, contactState, intake, leadsWorker, ledger, setPeriodDeadlines } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { dispatchOutbound } from './dispatch.js';
import { type CommsWorld, commsWorld, grantConsent, inboundSms, messageRow, ownedContact, sendText } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const smsBodies = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone).map((m) => m.body);

/** Holds app.lock_contact in another session; resolves `held` once taken; `release()` commits. */
function holdLock(contactId: string): { held: Promise<void>; release: () => void; done: Promise<void> } {
  let release!: () => void;
  let held!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const taken = new Promise<void>((r) => (held = r));
  const done = withTenantTx(systemActor(w.tenantId, 'worker'), async (tx) => {
    await lockContact(tx, contactId as ContactId);
    held();
    await gate;
  }, { db: h.database });
  return { held: taken, release, done };
}

/** Starts `first`, lets it queue on the held lock, then `second`, then releases. */
async function ordered(contactId: string, first: () => Promise<unknown>, second: () => Promise<unknown>): Promise<void> {
  const lock = holdLock(contactId);
  await lock.held;
  const a = first();
  await sleep(250);
  const b = second();
  await sleep(250);
  lock.release();
  await Promise.all([lock.done, a, b]);
}

describe('STOP vs dispatch (E22)', () => {
  async function scheduledText(i: number) {
    const agent = w.agents[i % 2]!;
    const c = await ownedContact(agent);
    const scheduled = await sendText(agent, c.id, `Race ${i}`, { scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    const id = scheduled.body.message!.id;
    await h.su.query("UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1", [id]);
    return { c, id };
  }
  const sentCount = (phone: string, i: number) => smsBodies(phone).filter((b) => b.startsWith(`Race ${i}`)).length;
  const revoked = async (contactId: string) =>
    (await h.su.query("SELECT status FROM consent_state WHERE channel = 'sms' AND address_hmac = (SELECT address_hmac FROM contact_points WHERE contact_id = $1 AND kind = 'phone')", [contactId])).rows.every((r) => r.status === 'revoked');

  it('E22 R-CONSENT-7: dispatch TX1 wins the contact lock ⇒ the message goes out once, and the STOP still revokes everything after it', async () => {
    const { c, id } = await scheduledText(100);
    await ordered(c.id, () => dispatchOutbound(id, w.deps, { tenantId: w.tenantId }), () => inboundSms(h, c.phone, w.mainNumber, 'STOP'));
    expect((await messageRow(h, id)).status).toBe('sent');
    expect(sentCount(c.phone, 100)).toBe(1);
    expect(await revoked(c.id)).toBe(true);
  });

  it('E22 R-CONSENT-7: ingestion wins the contact lock ⇒ the queued SMS is cancelled in the STOP transaction and never reaches the provider', async () => {
    const { c, id } = await scheduledText(101);
    await ordered(c.id, () => inboundSms(h, c.phone, w.mainNumber, 'STOP'), () => dispatchOutbound(id, w.deps, { tenantId: w.tenantId }));
    expect((await messageRow(h, id)).status).toBe('canceled');
    expect(sentCount(c.phone, 101)).toBe(0);
    expect(await revoked(c.id)).toBe(true);
  });

  it('E22: free-running races never send after a committed STOP and never leave a message dispatching', async () => {
    for (let i = 0; i < 6; i++) {
      const { c, id } = await scheduledText(i);
      await Promise.all([dispatchOutbound(id, w.deps, { tenantId: w.tenantId }), inboundSms(h, c.phone, w.mainNumber, 'STOP')]);
      const m = await messageRow(h, id);
      expect(['sent', 'canceled', 'blocked']).toContain(m.status);
      expect(sentCount(c.phone, i)).toBe(m.status === 'sent' ? 1 : 0);
      expect(await revoked(c.id)).toBe(true);
    }
  }, 60_000);
});

describe('a human send vs auto-release (E66)', () => {
  async function dueLead(i: number) {
    const lead = await intake(h, w, { fullName: `Race Lead ${i}` });
    const st = await contactState(h, lead.contactId);
    const agent = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
    expect((await command(agent, lead.contactId, 'accept', { offerId: st.offer_id })).status).toBe(200);
    await grantConsent(agent, lead.contactId, 'sms');
    await setPeriodDeadlines(h, lead.contactId, -60_000, -1_000);
    const phone = (await h.su.query<{ address: string }>("SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [lead.contactId])).rows[0]!.address;
    return { contactId: lead.contactId, agent, phone };
  }

  it('E66 R-OWN-14: the touch commits first ⇒ no release; the first touch is in the send transaction', async () => {
    const x = await dueLead(1);
    const worker = leadsWorker(h);
    await ordered(x.contactId, () => sendText(x.agent, x.contactId, 'Hi there A'), () => worker.drain(20));
    await worker.drain(20);
    const types = (await ledger(h, x.contactId)).map((e) => e.type);
    expect(types).toContain('first_touch_recorded');
    expect(types).not.toContain('auto_released');
    const after = await contactState(h, x.contactId);
    expect(after.ownership_state).toBe('owned');
    expect(after.owner_user_id).toBe(x.agent.userId);
    expect(smsBodies(x.phone).filter((b) => b.startsWith('Hi there A'))).toHaveLength(1);
  }, 60_000);

  it('E66 R-OWN-14: the release commits first ⇒ the send is blocked (the sender no longer owns the lead) and nothing reaches the client', async () => {
    const x = await dueLead(2);
    const worker = leadsWorker(h);
    let send: Awaited<ReturnType<typeof sendText>> | null = null;
    await ordered(x.contactId, () => worker.drain(20), async () => {
      send = await sendText(x.agent, x.contactId, 'Hi there B');
    });
    const types = (await ledger(h, x.contactId)).map((e) => e.type);
    expect(types).toContain('auto_released');
    expect(types).not.toContain('first_touch_recorded');
    expect(smsBodies(x.phone).filter((b) => b.startsWith('Hi there B'))).toHaveLength(0);
    const s = send as unknown as Awaited<ReturnType<typeof sendText>>;
    // the agent's TX1 lost sight of the contact: a system TX1 blocked it with SENDER_NOT_AUTHORIZED
    // (or the request was refused before a message existed, when the contact was already out of reach)
    if (s.status === 200) {
      expect(s.body.result).toBe('blocked');
      expect(s.body.decision!.reasons[0]).toBe('SENDER_NOT_AUTHORIZED');
      const rows = (await h.su.query("SELECT status FROM messages WHERE contact_id = $1 AND direction = 'outbound'", [x.contactId])).rows;
      expect(rows.map((r) => r.status)).toEqual(['blocked']);
    } else expect([404, 422], JSON.stringify(s.body)).toContain(s.status);
  }, 60_000);
});
