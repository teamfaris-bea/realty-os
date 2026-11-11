// R-CHAN-2 and the suppressions at the send-time gate: core canContact (buildGateInput: repos/gate.ts
// personDoNotContact, optOutFanoutPhoneHmacs, suppressionRows) and the DB dispatch guards (app.messages_dispatch_guard,
// app.calls_dispatch_guard, migration 0041: both judge a recipient by its whole person, app.contact_person_ids, so a
// merged-away record gets the survivor's opt-outs too, F1) must refuse exactly the same texts, calls and emails, so the API's
// mapping of a guard refusal to a blocked send (gateInput.ts GUARD_DENY_REASONS, guardRefusal.test.ts) is only
// defence in depth. Each case is arranged through the real paths (the one-tap do-not-contact, the merge
// command, the point routes), then the app gate is asked as the agent and the guard is asked, core bypassed,
// in a transaction that is always rolled back. Real Postgres, the real server, fake providers only. The
// opt-out fan-out over removed phones has its own matrix (optOutFanout.test.ts).
import { randomUUID } from 'node:crypto';
import type { Purpose } from '@realty/core/compliance';
import type { Instant } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { command, suFixture } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { evaluateGate } from './gateInput.js';
import * as msgs from './repos/messages.js';
import { type CommsWorld, call, commsWorld, inboundSms, randomEmail, randomPhone } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let brokerage: string;
let identity: { id: string; address: string };

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1, rule: false });
  agent = w.agents[0]!;
  brokerage = (await h.su.query<{ n: string }>('SELECT brokerage_legal_name AS n FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
  identity = { id: w.identityId, address: (await h.su.query<{ a: string }>('SELECT from_address AS a FROM email_identities WHERE id = $1', [w.identityId])).rows[0]!.a };
}, 240_000);
afterAll(async () => {
  await h?.close();
});

interface Pt {
  id: string;
  address: string;
  hmac: string;
}
const pointOf = async (contactId: string, address: string): Promise<Pt> =>
  (await h.su.query<Pt>("SELECT id, address, encode(address_hmac, 'hex') AS hmac FROM contact_points WHERE contact_id = $1 AND address = $2", [contactId, address])).rows[0]!;

async function person(o: { phones?: string[]; emails?: string[]; confirmDistinct?: boolean } = {}): Promise<string> {
  const r = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Ida', lastName: 'Equal', phones: o.phones ?? [], emails: o.emails ?? [], confirmDistinct: o.confirmDistinct ?? true });
  expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  return r.body.contact.id;
}
async function addPoint(contactId: string, kind: 'phone' | 'email', address: string): Promise<void> {
  const r = await call(agent, 'POST', `/contacts/${contactId}/points`, { kind, address });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
/** The one-tap person-level do-not-contact (R-CHAN-3: also revokes every channel on the points the person has now). */
async function doNotContact(by: TestClient, contactId: string): Promise<void> {
  const r = await call(by, 'POST', `/contacts/${contactId}/do-not-contact`, {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
async function merge(survivorId: string, loserId: string): Promise<void> {
  const r = await command(agent, survivorId, 'merge', { loserId, commandId: randomUUID() });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
async function suppress(hmac: string, kind: 'phone' | 'email', channel: 'all' | 'sms' | 'voice' | 'email', lifted = false): Promise<void> {
  // admin_block: no application path writes it here (a superuser fixture, as the other suppression tests do)
  await suFixture(h, [
    {
      text: `INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason, lifted_at, lifted_by_user_id, lift_reason)
             VALUES ($1, $2, $3, decode($4, 'hex'), 'x', $5, 'admin_block', ${lifted ? 'now()' : 'NULL'}, ${lifted ? '$6' : 'NULL'}, ${lifted ? "'entered in error'" : 'NULL'})`,
      values: lifted ? [w.tenantId, randomUUID(), kind, hmac, channel, w.owner.userId] : [w.tenantId, randomUUID(), kind, hmac, channel],
    },
  ]);
}

const OPT_OUT = ['PERSON_DO_NOT_CONTACT', 'CONSENT_REVOKED', 'SUPPRESSED'] as const;

/** The app gate (buildGateInput + core.canContact) as `by` (the agent), for a human send/call to `to`; only its opt-out reasons. */
async function appOptOuts(contactId: string, to: Pt, channel: 'sms' | 'voice' | 'email', purpose: Purpose, by: TestClient = agent): Promise<string[]> {
  const body = `${brokerage}: checking in about the house. Reply STOP to opt out. Unsubscribe: https://x.example/u`;
  const e = await withTenantTx(
    by.actor(),
    (tx, now) =>
      evaluateGate(tx, { contactId, recipient: { kind: 'contact', addressHmac: to.hmac, channel, pointId: to.id }, purpose, initiator: 'human', category: 'none', sender: { phoneNumberId: channel === 'email' ? null : w.mainNumberId, emailIdentityId: channel === 'email' ? identity.id : null }, body: channel === 'voice' ? null : body }, now),
    { db: h.database },
  );
  return e.decision.reasons.filter((r) => (OPT_OUT as readonly string[]).includes(r));
}

class Rollback extends Error {}

/** The DB guard, core bypassed, as `by` (the agent), rolled back: a queued text/email moved to dispatching, or an outbound call row. */
async function guardSays(contactId: string, to: Pt, channel: 'sms' | 'voice' | 'email', purpose: Purpose, by: TestClient = agent): Promise<string> {
  const write = async (tx: Tx, now: Instant): Promise<void> => {
    const conversationId = await msgs.ensureConversation(tx, randomUUID(), contactId, null);
    if (channel === 'voice') {
      await sql`
        INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id, client_address, initiator, status, started_at, recording_mode, recording_decision)
        VALUES (app.tenant_id(), ${randomUUID()}, ${conversationId}, ${contactId}, 'outbound', ${w.mainNumberId}, ${by.userId}, ${to.address}, 'human', 'initiated', now(), 'off', '{"mode":"off"}'::jsonb)`.execute(tx);
      return;
    }
    const id = randomUUID();
    await msgs.insertOutbound(tx, {
      id, conversationId, contactId, channel, phoneNumberId: channel === 'sms' ? w.mainNumberId : null, emailIdentityId: channel === 'email' ? identity.id : null,
      fromAddress: channel === 'sms' ? w.mainNumber : identity.address, toAddress: to.address, subject: channel === 'email' ? 'Checking in' : null,
      body: 'Checking in', status: 'queued', scheduledFor: null, initiator: 'human', initiatedByUserId: by.userId!, purpose, actionCategory: 'none',
      assistantActionId: null, playbookStepRunId: null, pinnedInboundSeq: null, idempotencyKey: `eq:${id}`, occurredAt: now,
    });
    await msgs.markDispatching(tx, id, now);
  };
  try {
    await withTenantTx(by.actor(), async (tx, now) => {
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

/**
 * The one exemption, in both layers: the system's informational STOP confirmation (opt_out_confirmation) to a
 * number that texted an opt-out keyword into the conversation in the last 24 hours. The app gate's opt-out
 * reasons and the guard's answer (core bypassed, rolled back), as the system actor that sends it.
 */
async function systemConfirmation(contactId: string, to: Pt): Promise<{ app: string[]; guard: string }> {
  const sys = systemActor(w.tenantId, 'worker');
  const body = `${brokerage}: you are unsubscribed and will get no more texts. Reply START to resubscribe.`;
  const e = await withTenantTx(
    sys,
    (tx, now) => evaluateGate(tx, { contactId, recipient: { kind: 'contact', addressHmac: to.hmac, channel: 'sms', pointId: to.id }, purpose: 'informational', initiator: 'system', category: 'opt_out_confirmation', sender: { phoneNumberId: w.mainNumberId, emailIdentityId: null }, body }, now),
    { db: h.database },
  );
  const app = e.decision.reasons.filter((r) => (OPT_OUT as readonly string[]).includes(r));
  try {
    await withTenantTx(sys, async (tx, now) => {
      const conversationId = await msgs.ensureConversation(tx, randomUUID(), contactId, null);
      const id = randomUUID();
      await msgs.insertOutbound(tx, {
        id, conversationId, contactId, channel: 'sms', phoneNumberId: w.mainNumberId, emailIdentityId: null, fromAddress: w.mainNumber, toAddress: to.address, subject: null,
        body, status: 'queued', scheduledFor: null, initiator: 'system', initiatedByUserId: null, purpose: 'informational', actionCategory: 'opt_out_confirmation',
        assistantActionId: null, playbookStepRunId: null, pinnedInboundSeq: null, idempotencyKey: `eq:${id}`, occurredAt: now,
      });
      await msgs.markDispatching(tx, id, now);
      throw new Rollback('rolled back on purpose');
    }, { db: h.database });
  } catch (err) {
    if (err instanceof Rollback) return { app, guard: 'allow' };
    const code = /^([A-Z_]+):/.exec((err as Error).message)?.[1];
    if (!code) throw err;
    return { app, guard: code };
  }
  throw new Error('unreachable');
}

/** The guard code the app's own opt-out reasons predict: the guards check the person, then the opt-outs, then suppressions. */
function predicted(app: readonly string[]): string {
  if (app.includes('PERSON_DO_NOT_CONTACT')) return 'PERSON_DO_NOT_CONTACT';
  if (app.includes('CONSENT_REVOKED')) return 'RECIPIENT_OPTED_OUT';
  if (app.includes('SUPPRESSED')) return 'RECIPIENT_SUPPRESSED';
  return 'allow';
}

interface Case {
  label: string;
  contactId: string;
  phone: Pt;
  email: Pt;
  /** what the guards must answer, per channel, whatever the purpose (independent of the app) */
  want: Record<'sms' | 'voice' | 'email', string>;
  /** who asks both layers (default the agent; the Owner for a merged-away record, which only tenant-wide roles still see) */
  by?: TestClient;
}

async function check(k: Case): Promise<void> {
  for (const channel of ['sms', 'voice', 'email'] as const) {
    const to = channel === 'email' ? k.email : k.phone;
    for (const purpose of ['informational', 'marketing'] as const) {
      const label = `${k.label} / ${channel} ${purpose}`;
      const app = await appOptOuts(k.contactId, to, channel, purpose, k.by);
      const guard = await guardSays(k.contactId, to, channel, purpose, k.by);
      // the two layers agree, case by case: canContact refuses for exactly the reason the guard would refuse with
      expect({ label, guard }).toEqual({ label, guard: predicted(app) });
      // and both follow the rule, stated independently of either layer
      expect({ label, guard }).toEqual({ label, guard: k.want[channel] });
    }
  }
}

const ALLOW = { sms: 'allow', voice: 'allow', email: 'allow' } as const;
const DNC = { sms: 'PERSON_DO_NOT_CONTACT', voice: 'PERSON_DO_NOT_CONTACT', email: 'PERSON_DO_NOT_CONTACT' } as const;

/**
 * The recipient: a person whose phone R and email E were added AFTER any do-not-contact was recorded, so R and E
 * carry no revoke of their own and only the person-level do-not-contact can block them (the guards check it
 * before the opt-outs). A do-not-contact needs an address to cite: the person starts with an email only.
 */
async function recipient(prefix: (id: string) => Promise<void> = async () => undefined): Promise<{ id: string; phone: Pt; email: Pt }> {
  const id = await person({ emails: [randomEmail()] });
  await prefix(id);
  const r = randomPhone();
  const e = randomEmail();
  await addPoint(id, 'phone', r);
  await addPoint(id, 'email', e);
  return { id, phone: await pointOf(id, r), email: await pointOf(id, e) };
}

describe('R-CHAN-2 equivalence: the app gate decides exactly what the DB dispatch guards decide for the person-level do-not-contact and for suppressions (real Postgres)', () => {
  it('R-CHAN-2 E140: the person-level do-not-contact of the person, of a duplicate merged into them (recorded before or after the merge; the agent cannot see the merged record), along a merge chain, and of another person sharing the number: texts, calls and email, every purpose', async () => {
    const cases: Case[] = [];
    const none = await recipient();
    cases.push({ label: 'nobody asked', contactId: none.id, phone: none.phone, email: none.email, want: ALLOW });

    const self = await recipient((id) => doNotContact(agent, id));
    cases.push({ label: 'the person asked', contactId: self.id, phone: self.phone, email: self.email, want: DNC });

    // a duplicate that asked first, then merged into the recipient (the survivor takes the do-not-contact, E140)
    const before = await recipient();
    const dupBefore = await person({ emails: [randomEmail()] });
    await doNotContact(agent, dupBefore);
    await merge(before.id, dupBefore);
    cases.push({ label: 'a duplicate merged in had asked', contactId: before.id, phone: before.phone, email: before.email, want: DNC });

    // a duplicate merged in first; the Owner (the only one who still sees the merged record) records its do-not-contact later
    const after = await recipient();
    const dupAfter = await person({ emails: [randomEmail()] });
    await merge(after.id, dupAfter);
    expect((await call(agent, 'GET', `/contacts/${dupAfter}`)).status).toBe(404);
    await doNotContact(w.owner, dupAfter);
    cases.push({ label: 'a merged duplicate asked later', contactId: after.id, phone: after.phone, email: after.email, want: DNC });

    // a chain: A asked, A merged into B, B merged into the recipient
    const chain = await recipient();
    const a = await person({ emails: [randomEmail()] });
    const b = await person({ emails: [randomEmail()] });
    await doNotContact(agent, a);
    await merge(b, a);
    await merge(chain.id, b);
    cases.push({ label: 'a merge chain', contactId: chain.id, phone: chain.phone, email: chain.email, want: DNC });

    // another person, never merged, who asked and shares the recipient's number and email (added after they asked):
    // the do-not-contact is the person's, not the number's
    const shared = await recipient();
    const other = await person({ emails: [randomEmail()] });
    await doNotContact(agent, other);
    await addPoint(other, 'phone', shared.phone.address);
    await addPoint(other, 'email', shared.email.address);
    cases.push({ label: 'another person sharing the number asked', contactId: shared.id, phone: shared.phone, email: shared.email, want: ALLOW });

    // the facts behind the merged cases: the agent's RLS shows only the survivor, whose own row carries the copy
    for (const id of [before.id, after.id, chain.id]) expect((await h.su.query('SELECT do_not_contact_at IS NOT NULL AS dnc FROM contacts WHERE id = $1', [id])).rows[0]).toEqual({ dnc: true });
    for (const k of cases) await check(k);
  }, 120_000);

  it('R-CHAN-2 D1 F1: a merged-away record gets the whole person’s verdict, never only its own: the survivor asked, or a phone only the survivor had texted STOP, before the merge (directly and along a chain); the Owner, who still sees the merged-away record, asks both layers; the survivor’s copies of the same addresses answer the same for the agent', async () => {
    const cases: Case[] = [];
    /** S (asked or not before), then L merged into S: L's own phone and email carry no revoke of their own */
    const pair = async (before: (s: string) => Promise<void>, o: { chain?: boolean } = {}) => {
      const s = await recipient();
      await before(s.id);
      const l = await recipient();
      if (o.chain) {
        // L merged into A first, then A into S: L is two hops from the record the person lives on
        const a = await person({ emails: [randomEmail()] });
        await merge(a, l.id);
        await merge(s.id, a);
      } else await merge(s.id, l.id);
      expect((await call(agent, 'GET', `/contacts/${l.id}`)).status).toBe(404);
      return { s, l, copy: { phone: await pointOf(s.id, l.phone.address), email: await pointOf(s.id, l.email.address) } };
    };
    const add = (label: string, p: Awaited<ReturnType<typeof pair>>, want: Case['want']) => {
      cases.push({ label: `${label}: the merged-away record`, contactId: p.l.id, phone: p.l.phone, email: p.l.email, want, by: w.owner });
      cases.push({ label: `${label}: the survivor's copy`, contactId: p.s.id, phone: p.copy.phone, email: p.copy.email, want });
    };
    add('nobody asked', await pair(async () => undefined), ALLOW);
    add('the survivor asked before the merge', await pair((s) => doNotContact(agent, s)), DNC);
    add('the survivor asked before a chain of merges', await pair((s) => doNotContact(agent, s), { chain: true }), DNC);
    // a STOP from a phone only the survivor had: texts to every phone of the person are refused; calls and email are not
    // (a STOP is the text channel), exactly as for the survivor itself
    const STOP = { sms: 'RECIPIENT_OPTED_OUT', voice: 'allow', email: 'allow' } as const;
    add('a phone only the survivor had texted STOP before the merge', await pair(async (s) => {
      const only = randomPhone();
      await addPoint(s, 'phone', only);
      expect((await inboundSms(h, only, w.mainNumber, 'STOP')).statusCode).toBe(200);
    }), STOP);
    add('a phone only the survivor had texted STOP before a chain of merges', await pair(async (s) => {
      const only = randomPhone();
      await addPoint(s, 'phone', only);
      expect((await inboundSms(h, only, w.mainNumber, 'STOP')).statusCode).toBe(200);
    }, { chain: true }), STOP);
    for (const k of cases) await check(k);
  }, 180_000);

  it('R-CONSENT-1 R-CHAN-2: suppressions of the recipient’s own address (every channel scope, live or lifted), of another of the person’s phones, of the same number through another contact, and together with a do-not-contact: texts, calls and email, every purpose', async () => {
    const cases: Case[] = [];
    for (const scope of ['all', 'sms', 'voice', 'email'] as const) {
      for (const lifted of [false, true]) {
        const r = await recipient();
        await suppress(r.phone.hmac, 'phone', scope, lifted);
        await suppress(r.email.hmac, 'email', scope, lifted);
        const blocks = (ch: 'sms' | 'voice' | 'email') => (!lifted && (scope === 'all' || scope === ch) ? 'RECIPIENT_SUPPRESSED' : 'allow');
        cases.push({ label: `suppressed for ${scope}${lifted ? ' (lifted)' : ''}`, contactId: r.id, phone: r.phone, email: r.email, want: { sms: blocks('sms'), voice: blocks('voice'), email: blocks('email') } });
      }
    }
    // a suppression is about its address: another phone of the person being suppressed never blocks R
    const otherPhone = await recipient();
    const second = randomPhone();
    await addPoint(otherPhone.id, 'phone', second);
    await suppress((await pointOf(otherPhone.id, second)).hmac, 'phone', 'all');
    cases.push({ label: 'another phone of the person is suppressed', contactId: otherPhone.id, phone: otherPhone.phone, email: otherPhone.email, want: ALLOW });
    // keyed by HMAC: the same number on another contact carries the suppression to this one
    const viaOther = await recipient();
    const stranger = await person({ phones: [viaOther.phone.address] });
    await suppress((await pointOf(stranger, viaOther.phone.address)).hmac, 'phone', 'all');
    cases.push({ label: 'the number is suppressed through another contact', contactId: viaOther.id, phone: viaOther.phone, email: viaOther.email, want: { sms: 'RECIPIENT_SUPPRESSED', voice: 'RECIPIENT_SUPPRESSED', email: 'allow' } });
    // both at once: the guards name the person first, and canContact gives both reasons
    const both = await recipient((id) => doNotContact(agent, id));
    await suppress(both.phone.hmac, 'phone', 'all');
    await suppress(both.email.hmac, 'email', 'all');
    cases.push({ label: 'suppressed and asked not to be contacted', contactId: both.id, phone: both.phone, email: both.email, want: DNC });
    for (const k of cases) await check(k);
    expect(await appOptOuts(both.id, both.phone, 'sms', 'informational')).toEqual(['SUPPRESSED', 'PERSON_DO_NOT_CONTACT']);
  }, 120_000);

  it('R-CHAN-2 R-CONSENT-7: the one exemption agrees too: the system’s STOP confirmation reaches the number that texted STOP despite the person-level do-not-contact, in both layers; never another of the person’s phones, never past a suppression, and never for a human text', async () => {
    const p = await recipient((id) => doNotContact(agent, id));
    const other = randomPhone();
    await addPoint(p.id, 'phone', other);
    expect((await inboundSms(h, p.phone.address, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const sameFact = (r: { app: string[]; guard: string }) => ({ ...r, predicted: predicted(r.app) });

    // the number that asked: exempt from the do-not-contact and from its own STOP, in both
    expect(sameFact(await systemConfirmation(p.id, p.phone))).toEqual({ app: [], guard: 'allow', predicted: 'allow' });
    // another phone of the person did not text the keyword: no exemption, in both
    const o = await systemConfirmation(p.id, await pointOf(p.id, other));
    expect(o.app).toContain('PERSON_DO_NOT_CONTACT');
    expect(sameFact(o)).toMatchObject({ guard: 'PERSON_DO_NOT_CONTACT', predicted: 'PERSON_DO_NOT_CONTACT' });
    // a human text to the number that asked is never exempt
    expect(await guardSays(p.id, p.phone, 'sms', 'informational')).toBe(predicted(await appOptOuts(p.id, p.phone, 'sms', 'informational')));
    expect(await guardSays(p.id, p.phone, 'sms', 'informational')).toBe('PERSON_DO_NOT_CONTACT');
    // the exemption never covers a suppression: both refuse the confirmation for it
    await suppress(p.phone.hmac, 'phone', 'sms');
    expect(sameFact(await systemConfirmation(p.id, p.phone))).toEqual({ app: ['SUPPRESSED'], guard: 'RECIPIENT_SUPPRESSED', predicted: 'RECIPIENT_SUPPRESSED' });
  }, 120_000);
});
