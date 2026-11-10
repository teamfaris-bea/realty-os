// 0014 send-gate review fixes (core-compliance/2.1.0):
//   outbound-1  the system STOP/HELP reply may reach a revoked number only when that number sent the keyword;
//   outbound-3  a voice revoke on any of the contact's phones blocks calling the contact;
//   integrity-1 messages left waiting for the retired "confirm anyway" tap are canceled and their sender told.
// Every write runs as app_user (RLS) except fixtures with no application path.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConsentEventSpec } from '@realty/core/compliance';
import type { Actor, Instant } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordConsentEvent } from '../src/consent.js';
import { withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, type Member, selfCreated, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let agent: Member;
let numberId: string;
let seq = 0;
const NUMBER = '+15555559200';

const hmacHex = (addr: string) => createHash('sha256').update(`test-hmac:${addr}`).digest('hex');
const nextPhone = () => `+1555013${String(1000 + ++seq).slice(-4)}`;

beforeAll(async () => {
  h = await createHarness(4);
  w = await createWorld(h.app, { agents: 1 });
  agent = w.agents[0]!;
  numberId = uuid();
  await suFixture(h.su, `
    INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, acquired_at)
      VALUES ($1, $2, '${NUMBER}', 'fake', 'PN-0014', 'local', 'team_main', true, true, now());`, [w.tenantId, numberId]);
});
afterAll(async () => {
  await h?.close();
});

const revoke = (addr: string, o: Partial<ConsentEventSpec> = {}, as: Actor = w.system('provider')) =>
  withTenantTx(as, (tx) => recordConsentEvent(tx, {
    id: uuid(), addressKind: 'phone', addressHmac: hmacHex(addr), addressHint: '•••', channel: 'sms', purpose: 'all',
    eventType: 'revoke', level: 'none', source: 'inbound_keyword', occurredAt: Date.now() as Instant, contactId: null, actor: { kind: 'system' },
    disclosureId: null, evidenceObjectId: null, evidenceMessageId: uuid(), evidenceCallId: null, evidenceCallOffsetMs: null, evidence: {},
    imported: false, importRecordId: null, originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false, ...o,
  }), { db: h.app });

async function contactWith(phones: string[]): Promise<{ contactId: string; conversationId: string }> {
  const contactId = await selfCreated(h.app, w, agent, `Fix ${++seq}`);
  const conversationId = uuid();
  await withTenantTx(agent.actor, async (tx) => {
    for (const p of phones) {
      await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
                VALUES (app.tenant_id(), ${uuid()}, ${contactId}, 'phone', ${p}, decode(${hmacHex(p)}, 'hex'))`.execute(tx);
    }
    await sql`INSERT INTO conversations (tenant_id, id, contact_id) VALUES (app.tenant_id(), ${conversationId}, ${contactId})`.execute(tx);
  }, { db: h.app });
  return { contactId, conversationId };
}

function keyword(c: { contactId: string; conversationId: string }, from: string, word: string, ago = '0 minutes') {
  return withTenantTx(w.system('provider'), (tx) => sql`
    INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator,
      opt_out_keyword, occurred_at, created_at)
    VALUES (app.tenant_id(), ${uuid()}, ${c.conversationId}, ${c.contactId}, 'sms', 'inbound', ${from}, ${NUMBER}, ${word}, 'received',
      'client', ${word}, now(), now() - ${ago}::interval)`.execute(tx), { db: h.app });
}

function systemReply(c: { contactId: string; conversationId: string }, to: string, category: 'opt_out_confirmation' | 'help_reply'): Promise<string> {
  const id = uuid();
  return withTenantTx(w.system(), async (tx) => {
    await sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body,
                status, initiator, purpose, action_category, dispatched_at, occurred_at)
              VALUES (app.tenant_id(), ${id}, ${c.conversationId}, ${c.contactId}, 'sms', 'outbound', ${numberId}, ${NUMBER}, ${to}, 'Reply STOP to opt out',
                'dispatching', 'system', 'informational', ${category}, now(), now())`.execute(tx);
    return id;
  }, { db: h.app });
}

function insertCall(c: { contactId: string; conversationId: string }, to: string): Promise<void> {
  return withTenantTx(agent.actor, async (tx) => {
    await sql`INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id, client_address, initiator,
                status, started_at, recording_mode, recording_decision)
              VALUES (app.tenant_id(), ${uuid()}, ${c.conversationId}, ${c.contactId}, 'outbound', ${numberId}, ${agent.id}, ${to}, 'human',
                'initiated', now(), 'off', '{"mode":"off"}'::jsonb)`.execute(tx);
  }, { db: h.app });
}

describe('0014 outbound-1: the keyword reply reaches only the number that sent the keyword (R-CONSENT-7)', () => {
  it('a HELP from phone B never lets the reply reach phone A, which opted out earlier; the reply to B itself goes', async () => {
    const a = nextPhone();
    const b = nextPhone();
    const c = await contactWith([a, b]);
    await revoke(a); // A texted STOP a week ago (the keyword message aged out)
    await keyword(c, a, 'STOP', '8 days');
    await keyword(c, b, 'HELP');
    await expect(systemReply(c, a, 'help_reply')).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    await expect(systemReply(c, a, 'opt_out_confirmation')).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    // B is blocked for ordinary texts by A's STOP (contact-wide), but the reply answers B's own HELP
    await expect(systemReply(c, b, 'help_reply')).resolves.toBeTruthy();
  });

  it('a STOP from B lets the confirmation reach B (the number that just opted out), not the primary phone A', async () => {
    const a = nextPhone();
    const b = nextPhone();
    const c = await contactWith([a, b]);
    await revoke(b);
    await keyword(c, b, 'STOP');
    await expect(systemReply(c, a, 'opt_out_confirmation')).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    await expect(systemReply(c, b, 'opt_out_confirmation')).resolves.toBeTruthy();
  });
});

describe('0014 outbound-3: an agent-recorded "do not call me" blocks every phone of the contact', () => {
  it('a voice revoke on phone A blocks calling phone B of the same contact; another contact is unaffected', async () => {
    const a = nextPhone();
    const b = nextPhone();
    const c = await contactWith([a, b]);
    const other = await contactWith([nextPhone()]);
    await revoke(a, { channel: 'voice', purpose: 'all', source: 'agent_revoke', actor: { kind: 'user', userId: agent.id } }, agent.actor);
    await expect(insertCall(c, a)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    await expect(insertCall(c, b)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    const [p] = await suRows<{ address: string }>(h.su, `SELECT address FROM contact_points WHERE contact_id = $1`, [other.contactId]);
    await expect(insertCall(other, p!.address)).resolves.toBeUndefined();
  });
});

describe('0014 integrity-1: the retired "confirm anyway" waits are resolved', () => {
  const retire = readFileSync(fileURLToPath(new URL('../migrations/0014_send_gate_review_fixes.sql', import.meta.url)), 'utf8').split('-- ---- 3.')[1]!;
  const retireSql = retire.slice(retire.indexOf('\n') + 1);

  it('a human message and an approved draft stuck in queued/NEEDS_CONFIRMATION are canceled, the draft invalidated, and the sender told; nothing is sent', async () => {
    const phone = nextPhone();
    const c = await contactWith([phone]);
    const human = uuid();
    const draftMsg = uuid();
    const action = uuid();
    const waiting = uuid();
    // the pre-0013 dispatcher's markAwaitingTap state (fixtures: no application path writes it any more)
    await suFixture(h.su, `
      INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, decided_by_user_id, decided_at,
        explanation, payload)
        VALUES ($1, $2, $3, 'message_draft', 'reminder', 'requires_approval', 'approved', $4, $4, now(), 'Reminder', '{}');
      INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status,
        status_reason, initiator, initiated_by_user_id, purpose, action_category, assistant_action_id, occurred_at)
        VALUES ($1, $5, $6, $3, 'sms', 'outbound', $7, '${NUMBER}', '${phone}', 'Hi', 'queued', 'NEEDS_CONFIRMATION', 'human', $4, 'informational', 'none', NULL, now()),
               ($1, $8, $6, $3, 'sms', 'outbound', $7, '${NUMBER}', '${phone}', 'Reminder', 'queued', 'NEEDS_CONFIRMATION', 'assistant', NULL, 'informational', 'reminder', $2, now()),
               ($1, $9, $6, $3, 'sms', 'outbound', $7, '${NUMBER}', '${phone}', 'Later', 'queued', 'CLIENT_REPLIED_SINCE_SCHEDULED', 'human', $4, 'informational', 'none', NULL, now());`,
      [w.tenantId, action, c.contactId, agent.id, human, c.conversationId, numberId, draftMsg, waiting]);

    const [counts] = (await h.su.query<{ canceled: string; drafts: string; notices: string }>(retireSql)).rows;
    expect(counts).toMatchObject({ canceled: '2', drafts: '1', notices: '2' });
    const rows = await suRows<{ id: string; status: string; status_reason: string; dispatched_at: Date | null }>(h.su,
      `SELECT id, status, status_reason, dispatched_at FROM messages WHERE id = ANY ($1::uuid[]) ORDER BY id`, [[human, draftMsg, waiting]]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(human)).toMatchObject({ status: 'canceled', status_reason: 'CONFIRMATION_RETIRED', dispatched_at: null });
    expect(byId.get(draftMsg)).toMatchObject({ status: 'canceled', status_reason: 'CONFIRMATION_RETIRED', dispatched_at: null });
    // a different wait (the client replied since it was scheduled: the human re-taps) is left alone
    expect(byId.get(waiting)).toMatchObject({ status: 'queued', status_reason: 'CLIENT_REPLIED_SINCE_SCHEDULED' });
    expect(await suRows(h.su, `SELECT status FROM assistant_actions WHERE id = $1`, [action])).toEqual([{ status: 'invalidated' }]);
    const notes = await suRows<{ user_id: string; kind: string; subject_id: string }>(h.su,
      `SELECT user_id, kind, subject_id FROM notifications WHERE tenant_id = $1 AND dedupe_key LIKE 'confirmation_retired:%' ORDER BY subject_id`, [w.tenantId]);
    expect(notes.map((n) => [n.user_id, n.kind, n.subject_id]).sort()).toEqual([[agent.id, 'system', human], [agent.id, 'system', draftMsg]].sort());
    // idempotent: a second run changes nothing
    const [again] = (await h.su.query<{ canceled: string; notices: string }>(retireSql)).rows;
    expect(again).toMatchObject({ canceled: '0', notices: '0' });
  });
});
