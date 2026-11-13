// Fixture builder for rls_smoke_ai_isa.test.ts (lane ISA-2; D12 proposed). Every application step runs as app_user
// through withTenantTx (RLS and the guards apply); the superuser only seeds what has no application path in this
// package (numbers, identities, the approved ai_isa policy, the counsel clearance). No test names the migration file.
import { createHash } from 'node:crypto';
import type { Actor } from '@realty/core/foundation';
import { sql } from 'kysely';
import { withTenantTx } from '../src/tenantTx.js';
import { type Harness, type Member, type World, selfCreated, suFixture, suRows, uuid } from './world.js';

export const hmacHex = (addr: string) => createHash('sha256').update(`test-hmac:${addr}`).digest('hex');
export const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** IANA fixed-offset zones (Etc/GMT+N is UTC−N). The tests pick one whose local time suits the case. b12 recheck R25:
 *  each is its own canonical name (core ianaZone; 'Etc/GMT' is 'UTC'), as the api fixture's (apps/api/src/isa/testing.ts). */
const ETC = Array.from({ length: 25 }, (_, i) => i - 12).map((n) => (n === 0 ? 'UTC' : n > 0 ? `Etc/GMT-${n}` : `Etc/GMT+${-n}`));
function localOf(zone: string, at = new Date()): { hour: number; isoDow: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday!) + 1;
  return { hour: Number(parts.hour), isoDow: dow };
}
/** A zone where it is now (or at `at`) 10:00–17:59 on Monday–Saturday (inside every window, initiated days included), or
 *  undefined. From about 06:00 to 22:00 UTC on a Sunday there is none: UTC−12 is past Saturday 18:00, UTC+12 not yet at
 *  Monday 10:00. */
export function initiatedZone(at = new Date()): string | undefined {
  return ETC.find((x) => { const l = localOf(x, at); return l.hour >= 10 && l.hour < 18 && l.isoDow <= 6; });
}
/** A zone where it is now (or at `at`) 10:00–17:59: initiatedZone() when there is one, else one where it is 10:00–17:59 on
 *  the Sunday (the 25 offsets reach every hour, so one always exists). b13: it used to throw 'no open zone now' on a
 *  Sunday from about 06:00 to 22:00 UTC, which failed every case built on leadUnderCare(). Replies go out in the
 *  fallback zone; an initiated AI message waits for a permitted day (ISA_QUIET_HOURS), so a case that needs an initiated
 *  send uses initiatedDayNow() below. */
export function openZone(at = new Date()): string {
  const z = initiatedZone(at) ?? ETC.find((x) => { const l = localOf(x, at); return l.hour >= 10 && l.hour < 18; });
  if (z === undefined) throw new Error(`openZone: no fixed-offset zone is at 10:00-17:59 at ${at.toISOString()}`);
  return z;
}
/** A zone where it is now (or at `at`) 10:00–17:59 on a weekday (Monday–Friday) when there is one, else openZone(). */
export function openWeekdayZone(at = new Date()): string {
  return ETC.find((x) => { const l = localOf(x, at); return l.hour >= 10 && l.hour < 18 && l.isoDow <= 5; }) ?? openZone(at);
}
/** A zone where it is now (or at `at`) 01:00–04:59 (outside every window, any day). */
export function closedZone(at = new Date()): string {
  const z = ETC.find((x) => { const l = localOf(x, at); return l.hour >= 1 && l.hour < 5; });
  if (z === undefined) throw new Error(`closedZone: no fixed-offset zone is at 01:00-04:59 at ${at.toISOString()}`);
  return z;
}
/** There is no fake clock (the guard reads now()). A case that needs an initiated AI send to go out runs `fn` with the
 *  day it is now in `zone` a permitted initiated day, in this file's own database, and puts everything back after. On a
 *  Monday–Saturday that is not a US federal holiday it changes nothing. On a Sunday (no zone is on a permitted day from
 *  about 06:00 to 22:00 UTC) it adds that ISO weekday to the platform:ai_isa pack's initiated_days; on a federal holiday
 *  it swaps app.ai_isa_us_federal_holiday for one that excepts that date. The case still proves what it is about. */
export async function initiatedDayNow<T>(h: Harness, zone: string, fn: () => Promise<T>): Promise<T> {
  const [p] = await suRows<{ rules: Record<string, unknown>; dow: number; d: string; holiday: boolean; def: string }>(h.su,
    `SELECT j.rules, extract(isodow FROM now() AT TIME ZONE $1)::int AS dow, to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d,
            app.ai_isa_us_federal_holiday((now() AT TIME ZONE $1)::date) AS holiday,
            pg_get_functiondef('app.ai_isa_us_federal_holiday(date)'::regprocedure) AS def
       FROM jurisdiction_packs j WHERE j.key = 'platform:ai_isa'`, [zone]);
  const days = (p!.rules.initiated_days as number[] | undefined) ?? [1, 2, 3, 4, 5, 6];
  const addDay = !days.includes(p!.dow);
  if (addDay) await h.su.query(`UPDATE jurisdiction_packs SET rules = rules || jsonb_build_object('initiated_days', $1::jsonb) WHERE key = 'platform:ai_isa'`, [JSON.stringify([...days, p!.dow])]);
  if (p!.holiday) {
    await h.su.query(p!.def.replace('CREATE OR REPLACE FUNCTION app.ai_isa_us_federal_holiday', 'CREATE OR REPLACE FUNCTION app.ai_isa_us_federal_holiday_b13_orig'));
    await h.su.query(`CREATE OR REPLACE FUNCTION app.ai_isa_us_federal_holiday(d date) RETURNS boolean LANGUAGE sql IMMUTABLE
      SET search_path = pg_catalog AS $$ SELECT d <> DATE '${p!.d}' AND app.ai_isa_us_federal_holiday_b13_orig(d) $$`);
  }
  try {
    return await fn();
  } finally {
    if (p!.holiday) {
      await h.su.query(p!.def);
      await h.su.query(`DROP FUNCTION app.ai_isa_us_federal_holiday_b13_orig(date)`);
    }
    if (addDay) await h.su.query(`UPDATE jurisdiction_packs SET rules = $1::jsonb WHERE key = 'platform:ai_isa'`, [JSON.stringify(p!.rules)]);
  }
}

export interface IsaWorld {
  h: Harness;
  w: World;
  agent: Member;
  numberId: string;
  emailIdentityId: string;
  playbookId: string;
  versionId: string;
  versionSha: string;
  optinId: string;
}

let seq = 0;
export const nextPhone = () => `+1555013${String(1000 + ++seq).slice(-4)}`;

export const ATTESTATION = (versionSha: string) =>
  `I opt in to the team's AI assistant policy version ${versionSha}. I'm responsible for leads I put in AI care.`;

/** The tenant-level setup: a number, an email identity, the approved ai_isa policy and the agent's opt-in. */
export async function setupIsaWorld(h: Harness, w: World, o: { clear?: boolean; d12?: boolean } = {}): Promise<IsaWorld> {
  const agent = w.agents[0]!;
  const numberId = uuid();
  const emailIdentityId = uuid();
  const playbookId = uuid();
  const versionId = uuid();
  const versionSha = sha(`policy-${versionId}`);
  await suFixture(h.su, `
    INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, acquired_at)
      VALUES ($1, $2, $8, 'fake', 'PN-isa-' || $2, 'local', 'team_main', true, true, now());
    INSERT INTO email_identities (tenant_id, id, from_address, display_name, status) VALUES ($1, $3, 'team@isa.test', 'Team', 'active');
    INSERT INTO playbooks (tenant_id, id, kind, scope, name, status) VALUES ($1, $4, 'ai_isa', 'team', 'AI assistant', 'active');
    INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id)
      VALUES ($1, $5, $4, 1, '{}'::jsonb, '{}'::jsonb, $6, 'approved', $7);
    INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at)
      VALUES ($1, gen_random_uuid(), $5, 'approve', $7, 'owner', $6, 'approved', now());`,
    [w.tenantId, numberId, emailIdentityId, playbookId, versionId, versionSha, w.owner.id, nextPhone()]);
  if (o.clear ?? true) await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:ai_isa'`);
  if (o.d12 ?? true) await h.su.query(`UPDATE jurisdiction_packs SET rules = rules || jsonb_build_object('d12_effective_at', (now() - interval '30 days')::text) WHERE key = 'platform:ai_isa'`);
  await withTenantTx(w.owner.actor, (tx) => sql`UPDATE tenant_settings SET ai_enabled = true, ai_isa_enabled = true, ai_isa_enabled_by = ${w.owner.id}, ai_isa_enabled_at = now()`.execute(tx), { db: h.app });
  const optinId = uuid();
  await withTenantTx(agent.actor, (tx) => sql`
    INSERT INTO ai_isa_agent_optins (tenant_id, id, user_id, playbook_version_id, attestation, attestation_sha256, capabilities, channels, timezone)
    VALUES (app.tenant_id(), ${optinId}, ${agent.id}, ${versionId}, ${ATTESTATION(versionSha)}, ${sha(ATTESTATION(versionSha))},
            ARRAY['converse','share_listings'], ARRAY['sms','email'], 'America/New_York')`.execute(tx), { db: h.app });
  return { h, w, agent, numberId, emailIdentityId, playbookId, versionId, versionSha, optinId };
}

export interface Lead {
  contactId: string;
  conversationId: string;
  phone: string;
  email: string;
  phonePointId: string;
  emailPointId: string;
  assignmentId: string;
  zone: string;
}

/** An agent-owned lead with a phone and an email, a conversation and a live assignment (started by the agent). */
export async function leadUnderCare(x: IsaWorld, o: { zone?: string; start?: boolean } = {}): Promise<Lead> {
  const contactId = await selfCreated(x.h.app, x.w, x.agent, `Isa Lead ${++seq}`);
  const conversationId = uuid();
  const phone = nextPhone();
  const email = `lead${seq}@isa.test`;
  const phonePointId = uuid();
  const emailPointId = uuid();
  const zone = o.zone ?? openZone();
  await withTenantTx(x.agent.actor, async (tx) => {
    await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, is_primary)
              VALUES (app.tenant_id(), ${phonePointId}, ${contactId}, 'phone', ${phone}, decode(${hmacHex(phone)}, 'hex'), true),
                     (app.tenant_id(), ${emailPointId}, ${contactId}, 'email', ${email}, decode(${hmacHex(email)}, 'hex'), true)`.execute(tx);
    await sql`INSERT INTO conversations (tenant_id, id, contact_id) VALUES (app.tenant_id(), ${conversationId}, ${contactId})`.execute(tx);
  }, { db: x.h.app });
  await x.h.su.query(`UPDATE contacts SET timezone = $2, timezone_source = 'explicit' WHERE id = $1`, [contactId, zone]);
  const assignmentId = uuid();
  if (o.start ?? true) await startCare(x, contactId, assignmentId, { phonePointId, phone, emailPointId, email });
  return { contactId, conversationId, phone, email, phonePointId, emailPointId, assignmentId, zone };
}

export async function startCare(x: IsaWorld, contactId: string, assignmentId: string, p: { phonePointId: string; phone: string; emailPointId: string; email: string }, as: Actor = x.agent.actor): Promise<void> {
  const [c] = await suRows<{ seq: string }>(x.h.su, 'SELECT ownership_period_seq AS seq FROM contacts WHERE id = $1', [contactId]);
  const bound = { sms: { point_id: p.phonePointId, hmac: hmacHex(p.phone) }, email: { point_id: p.emailPointId, hmac: hmacHex(p.email) } };
  await withTenantTx(as, (tx) => sql`
    INSERT INTO ai_isa_assignments (tenant_id, id, contact_id, owner_user_id, optin_id, playbook_version_id, bound_ownership_seq, bound_points,
                                    side, started_by_user_id)
    VALUES (app.tenant_id(), ${assignmentId}, ${contactId}, ${x.agent.id}, ${x.optinId}, ${x.versionId}, ${c!.seq}, ${JSON.stringify(bound)}::jsonb,
            'buyer', ${as.kind === 'user' ? as.userId : x.agent.id})`.execute(tx), { db: x.h.app });
}

/** An inbound from `from` (the client), bumping the conversation's inbound_seq like ingestion does. */
export async function inbound(x: IsaWorld, l: Lead, o: { channel?: 'sms' | 'email'; from?: string; dkim?: boolean | null; ageMinutes?: number } = {}): Promise<string> {
  const id = uuid();
  const channel = o.channel ?? 'sms';
  const from = o.from ?? (channel === 'sms' ? l.phone : l.email);
  await withTenantTx(x.w.system('provider'), async (tx) => {
    await sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status,
                initiator, email_dkim_aligned, occurred_at, created_at)
              VALUES (app.tenant_id(), ${id}, ${l.conversationId}, ${l.contactId}, ${channel}, 'inbound', ${from},
                ${channel === 'sms' ? '+15555559200' : 'team@isa.test'}, 'Hello there', 'received', 'client',
                ${channel === 'email' ? (o.dkim === undefined ? true : o.dkim) : null},
                now() - make_interval(mins => ${o.ageMinutes ?? 0}), now() - make_interval(mins => ${o.ageMinutes ?? 0}))`.execute(tx);
    await sql`UPDATE conversations SET inbound_seq = inbound_seq + 1, last_inbound_at = now() WHERE tenant_id = app.tenant_id() AND id = ${l.conversationId}`.execute(tx);
  }, { db: x.h.app });
  return id;
}

export interface SendOpts {
  channel?: 'sms' | 'email';
  to?: string;
  body?: string;
  frozenBody?: string;
  kind?: 'reply' | 'initiated';
  category?: 'ai_isa_message' | 'ai_isa_confirmation' | 'ai_isa_holding_line';
  zones?: string[];
  windowStart?: string;
  windowEnd?: string;
  purpose?: 'marketing' | 'informational';
  epoch?: number;
  pinnedSeq?: number;
  facts?: 'listing_active' | 'sold_comp_set';
  status?: 'queued' | 'scheduled';
}

export interface Queued {
  messageId: string;
  actionId: string;
  turnId: string;
}

/** TX-B's write: a turn, the proposed AI action and the queued message bound to it (as the system actor). */
export async function queueAi(x: IsaWorld, l: Lead, o: SendOpts = {}): Promise<Queued> {
  const channel = o.channel ?? 'sms';
  const to = o.to ?? (channel === 'sms' ? l.phone : l.email);
  const body = o.body ?? 'Thanks for writing back. What area are you looking in?';
  const turnId = uuid();
  const actionId = uuid();
  const messageId = uuid();
  const [cv] = await suRows<{ s: string }>(x.h.su, 'SELECT inbound_seq AS s FROM conversations WHERE id = $1', [l.conversationId]);
  const [asg] = await suRows<{ epoch: number }>(x.h.su, 'SELECT epoch FROM ai_isa_assignments WHERE id = $1', [l.assignmentId]);
  const pinned = o.pinnedSeq ?? Number(cv!.s);
  await withTenantTx(x.w.system('assistant'), async (tx) => {
    // TX-B withdraws any proposed AI action of the person first (one open AI message per contact)
    await sql`UPDATE assistant_actions SET status = 'superseded' WHERE tenant_id = app.tenant_id() AND contact_id = ${l.contactId}
                AND kind = 'ai_isa_message' AND status = 'proposed'`.execute(tx);
    await sql`INSERT INTO ai_isa_turns (tenant_id, id, assignment_id, contact_id, seq, epoch, trigger_kind, trigger_key, pinned_inbound_seq, state_before,
                rules_version, policy_version, prompt_version)
              VALUES (app.tenant_id(), ${turnId}, ${l.assignmentId}, ${l.contactId}, 1, ${asg!.epoch}, 'inbound', ${'t:' + turnId}, ${pinned}, 'engaged',
                'core-isa/1.0.0', ${x.versionSha}, 'ai_isa.turn/1')`.execute(tx);
    await sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, playbook_version_id, status, owner_user_id,
                explanation, payload, pinned_inbound_seq, ai_isa_turn_id, epoch, dedupe_key)
              VALUES (app.tenant_id(), ${actionId}, ${l.contactId}, 'ai_isa_message', ${o.category ?? 'ai_isa_message'}, 'ai_isa_mandate', ${x.versionId},
                'proposed', ${x.agent.id}, 'AI assistant reply', '{}'::jsonb, ${pinned}, ${turnId}, ${o.epoch ?? asg!.epoch}, ${'ai_isa_msg:' + turnId})`.execute(tx);
    await sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, email_identity_id, from_address,
                to_address, subject, body, status, scheduled_for, initiator, purpose, action_category, assistant_action_id, pinned_inbound_seq, occurred_at)
              VALUES (app.tenant_id(), ${messageId}, ${l.conversationId}, ${l.contactId}, ${channel}, 'outbound',
                ${channel === 'sms' ? x.numberId : null}, ${channel === 'email' ? x.emailIdentityId : null},
                ${channel === 'sms' ? '+15555559200' : 'team@isa.test'}, ${to}, ${channel === 'email' ? 'Hello' : null}, ${body},
                ${o.status ?? 'queued'}, ${o.status === 'scheduled' ? sql`now() + interval '1 hour'` : null}, 'assistant', ${o.purpose ?? 'marketing'},
                ${o.category ?? 'ai_isa_message'}, ${actionId}, ${pinned}, now())`.execute(tx);
    await sql`UPDATE ai_isa_turns SET assistant_action_id = ${actionId}, message_id = ${messageId}, channel = ${channel},
                message_kind = ${o.kind ?? 'reply'}, zones = ${o.zones ?? [l.zone]}::text[], zone_source = 'explicit',
                window_start = ${o.windowStart ?? '09:00'}::time, window_end = ${o.windowEnd ?? '20:00'}::time,
                body_sha256 = ${sha(o.frozenBody ?? body)}, status = 'sending'
              WHERE tenant_id = app.tenant_id() AND id = ${turnId}`.execute(tx);
    if (o.facts) {
      await sql`INSERT INTO ai_isa_shared_facts (tenant_id, id, assignment_id, contact_id, turn_id, message_id, fact_kind, line_sha256)
                VALUES (app.tenant_id(), ${uuid()}, ${l.assignmentId}, ${l.contactId}, ${turnId}, ${messageId}, ${o.facts}, ${sha('line')})`.execute(tx);
    }
  }, { db: x.h.app });
  return { messageId, actionId, turnId };
}

/** TX1's dispatching UPDATE as the system actor: resolves to 'ok' or the guard's code. */
export async function dispatchCode(x: IsaWorld, messageId: string): Promise<string> {
  try {
    await withTenantTx(x.w.system('worker'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now()
      WHERE tenant_id = app.tenant_id() AND id = ${messageId}`.execute(tx), { db: x.h.app });
    return 'ok';
  } catch (e) {
    if (process.env.DEBUG_ISA) console.log((e as Error).message);
    const m = /([A-Z][A-Z_]{3,}):/.exec((e as Error).message);
    return m ? m[1]! : (e as Error).message;
  }
}

/** Marks a dispatched message sent (so it counts toward caps and the reply-tier "after the last AI outbound"). */
export async function markSent(x: IsaWorld, messageId: string, minutesAgo = 0): Promise<void> {
  await x.h.su.query(`UPDATE messages SET status = 'sent', dispatched_at = now() - make_interval(mins => $2) WHERE id = $1`, [messageId, minutesAgo]);
}
