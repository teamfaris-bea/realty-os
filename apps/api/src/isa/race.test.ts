// ISA-2b item 4: the per-person cap race (R-ISA-11; E515, E496). One person's AI messages never pass the guard on
// stale counts (they all go to the root contact, one proposed per contact, TX-B under lockForTurn, TX1 under
// lock_contact to commit; the DB proof is rls_smoke_ai_isa.test.ts). The nearest real race, an AI send against another
// automated send on ONE record, serializes on lock_contact: the later TX1 counts the earlier one. Fakes only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { dispatchOutbound } from '../comms/dispatch.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { inboundSms, sendText } from '../comms/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { aiMessages, isaLead, isaWorld, type IsaWorld, runIsa, startCare } from './testing.js';
import { runTurn } from './turn.js';

let h: ApiHarness;
let w: IsaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
});
afterAll(async () => {
  await h?.close();
});

/** A live lead whose reply has made the AI queue a message (not yet dispatched), with `n` automated sends today. */
async function queuedAiReply(n: number) {
  const l = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
  await runIsa(h, w.tenantId);
  const conv = (await h.su.query<{ id: string; pn: string | null }>(`SELECT id, $2::uuid AS pn FROM conversations WHERE contact_id = $1`, [l.id, w.mainNumberId])).rows[0]!;
  for (let i = 0; i < n; i += 1) {
    await h.su.query(`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status,
        initiator, purpose, action_category, dispatched_at, occurred_at) VALUES ($1, gen_random_uuid(), $2, $3, 'sms', 'outbound', $4, $5, $6, 'Alert', 'sent',
        'system', 'informational', 'search_alert', now() - interval '1 hour', now())`, [w.tenantId, conv.id, l.id, conv.pn, w.mainNumber, l.phone]);
  }
  await inboundSms(h, l.phone, w.mainNumber, 'We are looking for a condo');
  await h.su.query(`UPDATE conversations SET last_inbound_at = last_inbound_at - interval '1 minute' WHERE contact_id = $1`, [l.id]);
  await h.su.query(`UPDATE messages SET created_at = created_at - interval '3 minutes' WHERE contact_id = $1 AND direction = 'inbound'`, [l.id]);
  const a = (await h.su.query<{ id: string; epoch: number }>(`SELECT id, epoch FROM ai_isa_assignments WHERE contact_id = $1`, [l.id])).rows[0]!;
  await runTurn(depsFromPlatform(h.app.platform) as never, w.tenantId, { assignmentId: a.id, trigger: 'inbound', epoch: a.epoch });
  const m = (await aiMessages(h, l.id)).filter((x) => x.status === 'queued' || x.status === 'scheduled').at(-1);
  expect(m).toBeDefined();
  return { l, conv, messageId: m!.id };
}

describe('R-ISA-11: AI sends against other automated sends on one record', () => {
  it('R-ISA-11 E515 E496: another automated TX1 first (lock_contact held) → the AI\'s TX1 waits, then defers ISA_CAP_REACHED on the committed count', async () => {
    const { l, conv, messageId } = await queuedAiReply(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let holding!: () => void;
    const held = new Promise<void>((r) => { holding = r; });
    // the other send's TX1: lock_contact, then its dispatching UPDATE (counted by the AI's TX1 once committed)
    const other = withTenantTx(systemActor(w.tenantId as never, 'worker'), async (tx) => {
      await sql`SELECT app.lock_contact(${l.id}::uuid)`.execute(tx);
      await sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status,
          initiator, purpose, action_category, dispatched_at, occurred_at) VALUES (app.tenant_id(), ${randomUUID()}, ${conv.id}, ${l.id}, 'sms', 'outbound', ${conv.pn}, ${w.mainNumber}, ${l.phone},
          'Alert', 'dispatching', 'system', 'informational', 'search_alert', now(), now())`.execute(tx);
      holding();
      await gate;
    }, { db: h.database });
    await held;
    let done = false;
    const ai = dispatchOutbound(messageId, depsFromPlatform(h.app.platform), { tenantId: w.tenantId }).finally(() => { done = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false); // waiting on lock_contact
    release();
    await other;
    await ai;
    const row = (await h.su.query<{ status: string; status_reason: string | null }>(`SELECT status, status_reason FROM messages WHERE id = $1`, [messageId])).rows[0]!;
    expect(row.status).not.toBe('sent');
    expect(row.status_reason ?? '').toMatch(/ISA_CAP_REACHED/);
  });

  it('R-ISA-11 E515: the AI first → a later non-AI send by the agent is decided by D1 only (AI caps never apply to it)', async () => {
    const { l, messageId } = await queuedAiReply(2);
    await dispatchOutbound(messageId, depsFromPlatform(h.app.platform), { tenantId: w.tenantId });
    expect((await h.su.query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [messageId])).rows[0]!.status).toBe('sent');
    const s = await sendText(w.agents[0]!, l.id, 'Hi, this is your agent following up personally.');
    expect(s.body.decision?.reasons ?? []).not.toContain('ISA_CAP_REACHED');
    expect(['sent', 'queued', 'dispatching']).toContain(s.body.message?.status);
  });
});
