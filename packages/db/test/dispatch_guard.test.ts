// Dispatch guards: 0013 (core-compliance/2.0.0), replaced in 0018 with an explicit channel map, the DM and web-chat
// channels, the person-level do-not-contact (merge-safe) and the platform:meta clearance; the last block runs the
// shared opt-out case table (fixtures/opt_out_cases.json, R-CHAN-5) per channel. The per-send gate decision is gone;
// what the database still refuses at dispatch, for every role and every write path, is:
//   - a message or call to an address that opted out (STOP / unsubscribe / agent-recorded do-not-contact),
//     including a STOP on another of the contact's phones for SMS, or that is actively suppressed;
//   - an assistant message without an approved playbook / human approval (assistant autonomy, A3/A7).
// A normal human send needs no gate_decisions row at all. Every write below runs as app_user (RLS);
// the superuser pool only seeds fixtures with no application path (numbers, playbooks).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
let emailIdentityId: string;
let seq = 0;

const hmacHex = (addr: string) => createHash('sha256').update(`test-hmac:${addr}`).digest('hex');
const nextPhone = () => `+1555012${String(1000 + ++seq).slice(-4)}`;

beforeAll(async () => {
  h = await createHarness(6);
  w = await createWorld(h.app, { agents: 1 });
  agent = w.agents[0]!;
  numberId = uuid();
  emailIdentityId = uuid();
  await suFixture(h.su, `
    INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, acquired_at)
      VALUES ($1, $2, '+15555559100', 'fake', 'PN-guard', 'local', 'team_main', true, true, now());
    INSERT INTO email_identities (tenant_id, id, from_address, display_name, status)
      VALUES ($1, $3, 'team@guard.test', 'Team', 'active');`, [w.tenantId, numberId, emailIdentityId]);
});
afterAll(async () => {
  await h?.close();
});

function revokeSpec(addr: string, o: Partial<ConsentEventSpec> = {}): ConsentEventSpec {
  return {
    id: uuid(), addressKind: addr.includes('@') ? 'email' : 'phone', addressHmac: hmacHex(addr), addressHint: '•••', channel: 'sms', purpose: 'all',
    eventType: 'revoke', level: 'none', source: 'inbound_keyword', occurredAt: Date.now() as Instant, contactId: null, actor: { kind: 'system' },
    disclosureId: null, evidenceObjectId: null, evidenceMessageId: uuid(), evidenceCallId: null, evidenceCallOffsetMs: null, evidence: {},
    imported: false, importRecordId: null, originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false, ...o,
  };
}

const revoke = (addr: string, o: Partial<ConsentEventSpec> = {}, as: Actor = w.system('provider')) =>
  withTenantTx(as, (tx) => recordConsentEvent(tx, revokeSpec(addr, o)), { db: h.app });

/** An agent-owned contact with the given points, and its conversation, all written by the agent (app_user). */
type PointKind = 'phone' | 'email' | 'messenger' | 'instagram' | 'web_chat';

async function contactWith(points: { kind: PointKind; address: string }[]): Promise<{ contactId: string; conversationId: string }> {
  const contactId = await selfCreated(h.app, w, agent, `Guard ${++seq}`);
  const conversationId = uuid();
  await withTenantTx(agent.actor, async (tx) => {
    for (const p of points) {
      await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
                VALUES (app.tenant_id(), ${uuid()}, ${contactId}, ${p.kind}, ${p.address}, decode(${hmacHex(p.address)}, 'hex'))`.execute(tx);
    }
    await sql`INSERT INTO conversations (tenant_id, id, contact_id) VALUES (app.tenant_id(), ${conversationId}, ${contactId})`.execute(tx);
  }, { db: h.app });
  return { contactId, conversationId };
}

interface Send {
  contactId: string;
  conversationId: string;
  to: string;
  status?: string;
  channel?: 'sms' | 'email';
  initiator?: 'human' | 'assistant' | 'system';
  purpose?: 'informational' | 'marketing';
  category?: string;
  assistantActionId?: string | null;
}

/** A forged outbound message INSERT straight at the table, as `actor` through app_user. */
function insertMessage(actor: Actor, s: Send): Promise<string> {
  const id = uuid();
  const status = s.status ?? 'dispatching';
  const channel = s.channel ?? 'sms';
  const initiator = s.initiator ?? 'human';
  return withTenantTx(actor, async (tx) => {
    await sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, email_identity_id,
                from_address, to_address, subject, body, status, initiator, initiated_by_user_id, purpose, action_category, assistant_action_id,
                dispatched_at, occurred_at)
              VALUES (app.tenant_id(), ${id}, ${s.conversationId}, ${s.contactId}, ${channel}, 'outbound',
                ${channel === 'sms' ? numberId : null}, ${channel === 'email' ? emailIdentityId : null},
                ${channel === 'sms' ? '+15555559100' : 'team@guard.test'}, ${s.to}, ${channel === 'email' ? 'Hello' : null}, 'Hi there',
                ${status}, ${initiator}, ${initiator === 'human' ? agent.id : null}, ${s.purpose ?? 'informational'}, ${s.category ?? 'none'},
                ${s.assistantActionId ?? null}, ${status === 'queued' || status === 'scheduled' ? null : sql`now()`}, now())`.execute(tx);
    return id;
  }, { db: h.app });
}

const dispatch = (actor: Actor, id: string) =>
  withTenantTx(actor, (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx), { db: h.app });

function insertCall(actor: Actor, contactId: string, conversationId: string, to: string): Promise<void> {
  return withTenantTx(actor, async (tx) => {
    await sql`INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id, client_address, initiator,
                status, started_at, recording_mode, recording_decision)
              VALUES (app.tenant_id(), ${uuid()}, ${conversationId}, ${contactId}, 'outbound', ${numberId}, ${agent.id}, ${to}, 'human',
                'initiated', now(), 'off', '{"mode":"off"}'::jsonb)`.execute(tx);
  }, { db: h.app });
}

const gateRows = () => suRows<{ n: number }>(h.su, `SELECT count(*)::int AS n FROM gate_decisions WHERE tenant_id = $1`, [w.tenantId]);

describe('0013: a normal send needs no gate decision', () => {
  it('a human text to a contact who has not opted out goes queued → dispatching → sent with no gate_decisions row', async () => {
    const phone = nextPhone();
    const c = await contactWith([{ kind: 'phone', address: phone }]);
    const before = (await gateRows())[0]!.n;
    const id = await insertMessage(agent.actor, { ...c, to: phone, status: 'queued' });
    await dispatch(agent.actor, id);
    await withTenantTx(agent.actor, (tx) => sql`UPDATE messages SET status = 'sent' WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx), { db: h.app });
    const [m] = await suRows<{ status: string; gate_decision_id: string | null }>(h.su, `SELECT status, gate_decision_id FROM messages WHERE id = $1`, [id]);
    expect(m).toEqual({ status: 'sent', gate_decision_id: null });
    expect((await gateRows())[0]!.n).toBe(before);
  });

  it('a human marketing email and a human call need no gate decision either', async () => {
    const phone = nextPhone();
    const email = `guard${++seq}@example.test`;
    const c = await contactWith([{ kind: 'phone', address: phone }, { kind: 'email', address: email }]);
    await expect(insertMessage(agent.actor, { ...c, to: email, channel: 'email', purpose: 'marketing' })).resolves.toBeTruthy();
    await expect(insertCall(agent.actor, c.contactId, c.conversationId, phone)).resolves.toBeUndefined();
  });

  it('gate_decisions now logs blocked sends only: an allow row is refused', async () => {
    const insert = (outcome: string, phase: string) =>
      withTenantTx(agent.actor, (tx) => sql`
        INSERT INTO gate_decisions (tenant_id, id, address_hmac, channel, purpose, initiator, action_category, phase, outcome, reason_codes,
          explanation, actor_user_id, policy_version_id, core_rules_version, inputs, inputs_sha256, evaluated_at)
        VALUES (app.tenant_id(), ${uuid()}, decode(${hmacHex('+15555550000')}, 'hex'), 'sms', 'informational', 'human', 'none', ${phase}, ${outcome},
          ${outcome === 'allow' ? sql`'{}'::text[]` : sql`'{CONSENT_REVOKED}'::text[]`}, 'x', ${agent.id},
          (SELECT active_policy_id FROM tenant_settings WHERE tenant_id = app.tenant_id()), 'core-compliance/2.0.0', '{}'::jsonb, repeat('ab', 32), now())`.execute(tx), { db: h.app });
    await expect(insert('deny', 'send')).resolves.toBeTruthy();
    await expect(insert('allow', 'send')).rejects.toThrow(/gate_decisions_blocked_send_only/);
    await expect(insert('deny', 'preview')).rejects.toThrow(/gate_decisions_blocked_send_only/);
  });
});

describe('0013: opt-out block at dispatch, even for forged inserts (R-CONSENT-7, -10, -20)', () => {
  it('a text to a number that texted STOP cannot reach dispatching or sent, inserted directly or updated from queued, by the agent or the Owner', async () => {
    const phone = nextPhone();
    const c = await contactWith([{ kind: 'phone', address: phone }]);
    await revoke(phone);
    for (const status of ['dispatching', 'sent', 'delivered', 'dispatch_unknown', 'failed']) {
      await expect(insertMessage(agent.actor, { ...c, to: phone, status })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    }
    await expect(insertMessage(w.owner.actor, { ...c, to: phone, purpose: 'marketing' })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    const queued = await insertMessage(agent.actor, { ...c, to: phone, status: 'queued' }); // a draft may exist; it can never leave
    await expect(dispatch(agent.actor, queued)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    await expect(dispatch(w.owner.actor, queued)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });

  it('a system or assistant-labelled send is blocked the same way (no initiator overrides an opt-out)', async () => {
    const phone = nextPhone();
    const c = await contactWith([{ kind: 'phone', address: phone }]);
    await revoke(phone);
    await expect(insertMessage(w.system(), { ...c, to: phone, initiator: 'system', category: 'reminder' })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    // a human-labelled "opt-out confirmation" is not the exempt system reply
    await expect(insertMessage(agent.actor, { ...c, to: phone, category: 'opt_out_confirmation' })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });

  it("a STOP on another of the contact's phones blocks texting this one too", async () => {
    const clean = nextPhone();
    const stopped = nextPhone();
    const c = await contactWith([{ kind: 'phone', address: clean }, { kind: 'phone', address: stopped }]);
    await expect(insertMessage(agent.actor, { ...c, to: clean, status: 'queued' })).resolves.toBeTruthy();
    await revoke(stopped);
    await expect(insertMessage(agent.actor, { ...c, to: clean })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });

  it('a STOP blocks every contact that shares the number (address-keyed, E21)', async () => {
    const shared = nextPhone();
    const a = await contactWith([{ kind: 'phone', address: shared }]);
    const b = await contactWith([{ kind: 'phone', address: shared }]);
    await revoke(shared);
    await expect(insertMessage(agent.actor, { ...a, to: shared })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    await expect(insertMessage(agent.actor, { ...b, to: shared })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });

  it('a forged contact point with a wrong HMAC for the same number cannot hide the real opt-out', async () => {
    const phone = nextPhone();
    const real = await contactWith([{ kind: 'phone', address: phone }]);
    await revoke(phone);
    const forged = await selfCreated(h.app, w, agent, 'Forged');
    const conv = uuid();
    await withTenantTx(agent.actor, async (tx) => {
      await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
                VALUES (app.tenant_id(), ${uuid()}, ${forged}, 'phone', ${phone}, decode(${hmacHex('not-' + phone)}, 'hex'))`.execute(tx);
      await sql`INSERT INTO conversations (tenant_id, id, contact_id) VALUES (app.tenant_id(), ${conv}, ${forged})`.execute(tx);
    }, { db: h.app });
    await expect(insertMessage(agent.actor, { contactId: forged, conversationId: conv, to: phone })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    void real;
  });

  it('a send to an address that is not one of the contact\'s points is refused (its opt-out could not be checked)', async () => {
    const c = await contactWith([{ kind: 'phone', address: nextPhone() }]);
    await expect(insertMessage(agent.actor, { ...c, to: nextPhone() })).rejects.toThrow(/RECIPIENT_NOT_A_CONTACT_POINT/);
  });

  it('email unsubscribe blocks marketing email; an active suppression blocks its channel; a lifted one does not', async () => {
    const email = `unsub${++seq}@example.test`;
    const bounced = `bounce${++seq}@example.test`;
    const c = await contactWith([{ kind: 'email', address: email }, { kind: 'email', address: bounced }]);
    await revoke(email, { addressKind: 'email', channel: 'email', purpose: 'marketing', source: 'inbound_keyword' });
    await expect(insertMessage(agent.actor, { ...c, to: email, channel: 'email', purpose: 'marketing' })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    const sid = uuid();
    await withTenantTx(w.system('provider'), (tx) => sql`
      INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason)
      VALUES (app.tenant_id(), ${sid}, 'email', decode(${hmacHex(bounced)}, 'hex'), 'b•••', 'email', 'hard_bounce')`.execute(tx), { db: h.app });
    await expect(insertMessage(agent.actor, { ...c, to: bounced, channel: 'email' })).rejects.toThrow(/RECIPIENT_SUPPRESSED/);
    await withTenantTx(w.owner.actor, (tx) => sql`
      UPDATE suppressions SET lifted_at = now(), lifted_by_user_id = ${w.owner.id}, lift_reason = 'confirmed address' WHERE tenant_id = app.tenant_id() AND id = ${sid}`.execute(tx), { db: h.app });
    await expect(insertMessage(agent.actor, { ...c, to: bounced, channel: 'email' })).resolves.toBeTruthy();
  });

  it('an agent-recorded "do not call me" blocks every outbound call to that number, whatever the purpose; a text is a separate channel', async () => {
    const phone = nextPhone();
    const c = await contactWith([{ kind: 'phone', address: phone }]);
    await revoke(phone, { channel: 'voice', purpose: 'marketing', source: 'agent_revoke', actor: { kind: 'user', userId: agent.id } }, agent.actor);
    await expect(insertCall(agent.actor, c.contactId, c.conversationId, phone)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    await expect(insertCall(w.owner.actor, c.contactId, c.conversationId, phone)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    await expect(insertMessage(agent.actor, { ...c, to: phone })).resolves.toBeTruthy();
  });

  it('a voice suppression (internal do-not-call) blocks calls', async () => {
    const phone = nextPhone();
    const c = await contactWith([{ kind: 'phone', address: phone }]);
    await withTenantTx(w.system('provider'), (tx) => sql`
      INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason)
      VALUES (app.tenant_id(), ${uuid()}, 'phone', decode(${hmacHex(phone)}, 'hex'), '•••', 'all', 'internal_dnc')`.execute(tx), { db: h.app });
    await expect(insertCall(agent.actor, c.contactId, c.conversationId, phone)).rejects.toThrow(/RECIPIENT_SUPPRESSED/);
    await expect(insertMessage(agent.actor, { ...c, to: phone })).rejects.toThrow(/RECIPIENT_SUPPRESSED/);
  });

  it('only the system STOP/HELP reply to a keyword received in the last 24 h may reach the just-revoked number', async () => {
    const phone = nextPhone();
    const c = await contactWith([{ kind: 'phone', address: phone }]);
    await revoke(phone);
    const reply = { ...c, to: phone, initiator: 'system' as const, category: 'opt_out_confirmation' };
    await expect(insertMessage(w.system(), reply)).rejects.toThrow(/RECIPIENT_OPTED_OUT/); // no keyword message on the thread
    await withTenantTx(w.system('provider'), (tx) => sql`
      INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator,
        opt_out_keyword, occurred_at)
      VALUES (app.tenant_id(), ${uuid()}, ${c.conversationId}, ${c.contactId}, 'sms', 'inbound', ${phone}, '+15555559100', 'STOP', 'received',
        'client', 'STOP', now())`.execute(tx), { db: h.app });
    await expect(insertMessage(w.system(), reply)).resolves.toBeTruthy();
    await expect(insertMessage(w.system(), { ...reply, purpose: 'marketing' })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    await expect(insertMessage(w.system(), { ...reply, category: 'reminder' })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });
});

describe('0013: assistant autonomy stays exactly as strict (R-GATE-4)', () => {
  async function seedAction(versionStatus: 'draft' | 'approved' | 'revoked', autonomy: 'within_playbook' | 'requires_approval', status = 'proposed') {
    const pb = uuid();
    const pv = uuid();
    const action = uuid();
    const phone = nextPhone();
    const c = await contactWith([{ kind: 'phone', address: phone }]);
    await suFixture(h.su, `
      INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name) VALUES ($1, $2, 'nurture', 'team', NULL, 'Nurture ' || $2);
      INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, content_sha256, status, created_by_user_id)
        VALUES ($1, $3, $2, 1, '[]', repeat('ab', 32), $4, $5);
      INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, playbook_version_id, status, owner_user_id,
        explanation, payload)
        VALUES ($1, $6, $7, $8, 'nurture_step', $9, $3, $10, $5, 'Nurture step', '{}');`,
      [w.tenantId, pb, pv, versionStatus, agent.id, action, c.contactId, autonomy === 'within_playbook' ? 'autonomous_message' : 'message_draft', autonomy, status]);
    return { ...c, to: phone, initiator: 'assistant' as const, category: 'nurture_step', assistantActionId: action };
  }

  it('an autonomous assistant send without an approved playbook version still fails, with no gate decision involved', async () => {
    for (const v of ['draft', 'revoked'] as const) {
      const s = await seedAction(v, 'within_playbook');
      await expect(insertMessage(w.system('assistant'), s)).rejects.toThrow(/PLAYBOOK_NOT_APPROVED/);
    }
    const ok = await seedAction('approved', 'within_playbook');
    await expect(insertMessage(w.system('assistant'), ok)).resolves.toBeTruthy();
  });

  it('an unapproved draft never dispatches; a paused conversation stops an autonomous send', async () => {
    const draft = await seedAction('approved', 'requires_approval', 'proposed');
    await expect(insertMessage(w.system('assistant'), draft)).rejects.toThrow(/ASSISTANT_ACTION_NOT_APPROVED/);
    const auto = await seedAction('approved', 'within_playbook');
    await withTenantTx(w.system(), (tx) => sql`
      UPDATE conversations SET automation_paused_at = now(), automation_pause_reason = 'client_reply' WHERE tenant_id = app.tenant_id() AND id = ${auto.conversationId}`.execute(tx), { db: h.app });
    await expect(insertMessage(w.system('assistant'), auto)).rejects.toThrow(/AUTOMATION_PAUSED/);
  });

  it('an opt-out beats an approved playbook', async () => {
    const s = await seedAction('approved', 'within_playbook');
    await revoke(s.to);
    await expect(insertMessage(w.system('assistant'), s)).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 0018: the shared opt-out case table (R-CHAN-5, review finding F17). Every row of fixtures/opt_out_cases.json is
// written against the real guards, per channel. Module 19's core equivalence test reads the same rows and asserts that
// canContact denies every case the guard denies. Revokes, suppressions and inbound keywords are written as the system
// (provider) actor, a person-level do-not-contact and a merge as the Owner, and every send as app_user.
// ---------------------------------------------------------------------------------------------------------------------
interface RevokeFact { channel: string; purpose: 'all' | 'informational' | 'marketing' }
interface OptOutCase {
  id: string;
  why: string;
  channel: string;
  expect: string;
  initiator: 'human' | 'system';
  purpose: 'informational' | 'marketing';
  actionCategory: string;
  recipientRevoked: RevokeFact[];
  otherPointRevoked: RevokeFact[];
  otherKindRevoked: (RevokeFact & { kind: PointKind })[];
  suppression: { channel: string; reason: string } | null;
  personDoNotContact: boolean;
  mergedDuplicateDoNotContact: boolean;
  mergedIntoDoNotContact: boolean;
  survivorPhoneRevoked: RevokeFact[];
  keywordWithin24h: boolean;
  platformCleared: boolean | null;
}
type CaseRow = Partial<OptOutCase> & Pick<OptOutCase, 'id' | 'why' | 'channel' | 'expect'>;
const optOutTable = JSON.parse(readFileSync(new URL('./fixtures/opt_out_cases.json', import.meta.url), 'utf8')) as {
  defaults: Omit<OptOutCase, 'id' | 'why' | 'channel' | 'expect'>;
  cases: CaseRow[];
};
const optOutCases: OptOutCase[] = optOutTable.cases.map((c) => ({ ...optOutTable.defaults, ...c }));
const KIND_OF: Record<string, PointKind> = {
  sms: 'phone', mms: 'phone', voice: 'phone', email: 'email', messenger: 'messenger', instagram: 'instagram', web_chat: 'web_chat',
};
const PLATFORM = ['messenger', 'instagram', 'web_chat'] as const;
type PlatformChannel = (typeof PLATFORM)[number];
const isPlatform = (ch: string): ch is PlatformChannel => (PLATFORM as readonly string[]).includes(ch);

describe('0018: the shared opt-out case table (R-CHAN-5, F17)', () => {
  const conn: Record<PlatformChannel, string> = { messenger: uuid(), instagram: uuid(), web_chat: uuid() };
  const FROM: Record<string, string> = { messenger: 'fb:4001', instagram: 'ig:5001', web_chat: 'wc', email: 'team@guard.test' };
  let n = 0;

  beforeAll(async () => {
    const credentialId = uuid();
    // the provider callback's writes (system actor): a credential, then the live Page, Instagram account and chat widget
    await withTenantTx(w.system('provider'), async (tx) => {
      await sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version)
                VALUES (app.tenant_id(), ${credentialId}, 'meta', '\\x00'::bytea, 1)`.execute(tx);
      await sql`INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, credential_id,
                  lead_source_id, connected_at)
                VALUES (app.tenant_id(), ${conn.messenger}, 'messenger_page', 'connected', 'Guard Page', '4001', ${credentialId}, ${w.leadSourceId}, now()),
                       (app.tenant_id(), ${conn.instagram}, 'instagram_account', 'connected', 'Guard IG', '5001', ${credentialId}, ${w.leadSourceId}, now())`.execute(tx);
      await sql`INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, lead_source_id, connected_at, widget_key_hash,
                  allowed_origins)
                VALUES (app.tenant_id(), ${conn.web_chat}, 'web_chat_widget', 'connected', 'Guard chat', ${w.leadSourceId}, now(), ${randomBytes(32)},
                  ARRAY['https://guard.test'])`.execute(tx);
    }, { db: h.app });
  });

  const address = (kind: PointKind, other = false): string => {
    n += 1;
    switch (kind) {
      case 'phone': return nextPhone();
      case 'email': return `case${n}@optout.test`;
      case 'messenger': return `fb:${other ? 4002 : 4001}:${700000 + n}`;
      case 'instagram': return `ig:${other ? 5002 : 5001}:${800000 + n}`;
      case 'web_chat': return `wc:${randomBytes(16).toString('hex')}`;
    }
  };

  /** A revoke in the ledger and its projection, for any channel (each address in a case is fresh: one ledger event). */
  const revokeRow = (kind: PointKind, addr: string, r: RevokeFact, contactId: string) =>
    withTenantTx(w.system('provider'), async (tx) => {
      const eventId = uuid();
      await sql`INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
                  source, occurred_at, actor_kind, contact_id, evidence_message_id)
                VALUES (app.tenant_id(), ${eventId}, ${kind}, decode(${hmacHex(addr)}, 'hex'), '•••', ${r.channel}, ${r.purpose}, 'revoke', 'none',
                  ${r.channel === 'voice' || r.channel === 'web_chat' ? 'inbound_language' : 'inbound_keyword'}, now(), 'system', ${contactId}, ${uuid()})`.execute(tx);
      for (const purpose of r.purpose === 'all' ? ['informational', 'marketing'] : [r.purpose]) {
        await sql`INSERT INTO consent_state (tenant_id, channel, purpose, address_hmac, status, consent_level, basis_event_id, ledger_event_count)
                  VALUES (app.tenant_id(), ${r.channel}, ${purpose}, decode(${hmacHex(addr)}, 'hex'), 'revoked', 'none', ${eventId}, 1)`.execute(tx);
      }
    }, { db: h.app });

  /** The Owner records a person-level do-not-contact; its ledger evidence is a revoke on an address the contact no longer uses. */
  const markDoNotContact = (contactId: string) =>
    withTenantTx(w.owner.actor, async (tx) => {
      const eventId = uuid();
      await sql`INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
                  source, occurred_at, actor_kind, actor_user_id, contact_id)
                VALUES (app.tenant_id(), ${eventId}, 'email', decode(${hmacHex(`old-${eventId}@optout.test`)}, 'hex'), '•••', 'email', 'all', 'revoke',
                  'none', 'agent_revoke', now(), 'user', ${w.owner.id}, ${contactId})`.execute(tx);
      await sql`UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = ${eventId}
                WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
    }, { db: h.app });

  const setMetaCleared = (cleared: boolean) =>
    h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = ${cleared ? 'now()' : 'NULL'} WHERE key = 'platform:meta' AND status = 'published'`);

  function send(c: OptOutCase, s: { contactId: string; conversationId: string; to: string }): Promise<unknown> {
    const actor = c.initiator === 'human' ? agent.actor : w.system('provider');
    if (c.channel === 'voice') {
      return withTenantTx(actor, (tx) => sql`
        INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id, client_address, initiator,
          status, started_at, recording_mode, recording_decision)
        VALUES (app.tenant_id(), ${uuid()}, ${s.conversationId}, ${s.contactId}, 'outbound', ${numberId}, ${agent.id}, ${s.to}, 'human',
          'initiated', now(), 'off', '{"mode":"off"}'::jsonb)`.execute(tx), { db: h.app });
    }
    const phoneLike = !isPlatform(c.channel) && c.channel !== 'email';
    return withTenantTx(actor, (tx) => sql`
      INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, email_identity_id,
        integration_connection_id, from_address, to_address, subject, body, status, initiator, initiated_by_user_id, purpose, action_category,
        dispatched_at, occurred_at)
      VALUES (app.tenant_id(), ${uuid()}, ${s.conversationId}, ${s.contactId}, ${c.channel}, 'outbound', ${phoneLike ? numberId : null},
        ${c.channel === 'email' ? emailIdentityId : null}, ${isPlatform(c.channel) ? conn[c.channel] : null},
        ${FROM[c.channel] ?? '+15555559100'}, ${s.to}, ${c.channel === 'email' ? 'Hello' : null}, 'Hi there', 'dispatching', ${c.initiator},
        ${c.initiator === 'human' ? agent.id : null}, ${c.purpose}, ${c.actionCategory}, now(), now())`.execute(tx), { db: h.app });
  }

  it('covers every channel of the guard map, a call, an unknown channel and every opt-out reason code', () => {
    expect(new Set(optOutCases.map((c) => c.channel))).toEqual(new Set(['sms', 'mms', 'email', 'messenger', 'instagram', 'web_chat', 'voice', 'fax']));
    expect(new Set(optOutCases.map((c) => c.expect))).toEqual(
      new Set(['allow', 'RECIPIENT_OPTED_OUT', 'RECIPIENT_SUPPRESSED', 'PERSON_DO_NOT_CONTACT', 'PLATFORM_NOT_CLEARED', 'CHANNEL_UNKNOWN']));
    expect(new Set(optOutCases.map((c) => c.id)).size).toBe(optOutCases.length);
  });

  for (const c of optOutCases) {
    it(`${c.id}: ${c.why} ⇒ ${c.expect}`, async () => {
      if (c.platformCleared !== null) await setMetaCleared(c.platformCleared);
      const kind = KIND_OF[c.channel] ?? 'phone';
      const to = address(kind);
      const points: { kind: PointKind; address: string }[] = [{ kind, address: to }];
      const other = c.otherPointRevoked.length > 0 ? address(kind, true) : null;
      if (other) points.push({ kind, address: other });
      const otherKind = c.otherKindRevoked.map((r) => ({ ...r, address: address(r.kind) }));
      for (const p of otherKind) points.push({ kind: p.kind, address: p.address });
      const s = await contactWith(points);
      for (const r of c.recipientRevoked) await revokeRow(kind, to, r, s.contactId);
      for (const r of c.otherPointRevoked) await revokeRow(kind, other!, r, s.contactId);
      for (const p of otherKind) await revokeRow(p.kind, p.address, p, s.contactId);
      if (c.suppression) {
        const sup = c.suppression;
        await withTenantTx(w.system('provider'), (tx) => sql`
          INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason)
          VALUES (app.tenant_id(), ${uuid()}, ${kind}, decode(${hmacHex(to)}, 'hex'), '•••', ${sup.channel}, ${sup.reason})`.execute(tx), { db: h.app });
      }
      if (c.personDoNotContact) await markDoNotContact(s.contactId);
      if (c.mergedDuplicateDoNotContact) {
        const dup = await contactWith([]);
        await markDoNotContact(dup.contactId);
        await withTenantTx(w.owner.actor, (tx) => sql`
          UPDATE contacts SET merged_into_contact_id = ${s.contactId} WHERE tenant_id = app.tenant_id() AND id = ${dup.contactId}`.execute(tx), { db: h.app });
      }
      if (c.mergedIntoDoNotContact || c.survivorPhoneRevoked.length > 0) {
        // F1: the recipient record is merged away into a survivor that asked, or whose own phone opted out, before the merge
        const survivorPhone = c.survivorPhoneRevoked.length > 0 ? address('phone', true) : null;
        const survivor = await contactWith(survivorPhone ? [{ kind: 'phone', address: survivorPhone }] : []);
        for (const r of c.survivorPhoneRevoked) await revokeRow('phone', survivorPhone!, r, survivor.contactId);
        if (c.mergedIntoDoNotContact) await markDoNotContact(survivor.contactId);
        await withTenantTx(w.owner.actor, (tx) => sql`
          UPDATE contacts SET merged_into_contact_id = ${survivor.contactId} WHERE tenant_id = app.tenant_id() AND id = ${s.contactId}`.execute(tx), { db: h.app });
      }
      if (c.keywordWithin24h) {
        await withTenantTx(w.system('provider'), (tx) => sql`
          INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator,
            opt_out_keyword, occurred_at)
          VALUES (app.tenant_id(), ${uuid()}, ${s.conversationId}, ${s.contactId}, ${c.channel}, 'inbound', ${to}, ${FROM[c.channel] ?? '+15555559100'},
            'STOP', 'received', 'client', 'STOP', now())`.execute(tx), { db: h.app });
      }
      const result = send(c, { ...s, to });
      if (c.expect === 'allow') await expect(result).resolves.toBeDefined();
      else await expect(result).rejects.toThrow(new RegExp(c.expect));
    });
  }
});
