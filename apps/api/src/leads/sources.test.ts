// The Lead sources API (module 22; DATA_MODEL R-LSRC-1..5, E333–E339, E387) through the real server as app_user.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { SITE, chatConfig, chatSource, codeOf, createWidget, startChat } from '../channels/testing.js';
import { enableInbox, labelledBody, leadAddress, postLeadEmail } from '../leadEmail/testing.js';
import { signedHeader } from '../providers/webhooks.js';
import { type LeadsWorld, call, contactState, freshReauth, intake, leadsWorld, postIntake, randomPhone } from './testing.js';

let h: ApiHarness;
let w: LeadsWorld & { others: TestClient[] };
let other: LeadsWorld;

interface Overview {
  sources: {
    id: string;
    name: string;
    active: boolean;
    offSince: string | null;
    lastLeadAt: string | null;
    leadsLast30Days: number;
    heldEmails: number;
    paths: {
      email: { state: string; address: string | null };
      webhook: { hasToken: boolean; ownSecret: boolean; secretCreatedAt: string | null };
      googleLeadForm: { state: string };
      trackingNumbers: { id: string; e164: string }[];
      partnerFeeds: unknown[];
      webChats: { status: string }[];
    };
  }[];
  deployment: { inboundEmail: boolean; publicHttps: boolean };
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 2, others: ['admin'] });
  other = await leadsWorld(h, { agents: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const overviewOf = async (c: TestClient = w.owner) => (await call<Overview>(c, 'GET', '/lead-sources/overview')).body;
const sourceOf = async (id: string) => (await overviewOf()).sources.find((s) => s.id === id)!;
const newSource = async (name: string, kind = 'portal') => {
  const r = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name, kind });
  return { id: r.body.source.id, token: r.body.ingestToken };
};
const signed = (secret: string, token: string, body: Record<string, unknown>) => {
  const raw = JSON.stringify(body);
  return h.app.inject({ method: 'POST', url: `/api/intake/${token}`, headers: { 'content-type': 'application/json', 'x-realty-signature': signedHeader(secret, Math.floor(Date.now() / 1000), raw) }, payload: raw });
};

describe('R-LSRC-1 the overview', () => {
  it('R-LSRC-1: each source with its facts and path states from stored facts only; no score, no tenant id', async () => {
    await intake(h, w);
    const inbox = await enableInbox(h, w.owner, w.sourceId);
    const o = await overviewOf();
    expect(o.deployment).toEqual({ inboundEmail: true, publicHttps: true });
    const s = o.sources.find((x) => x.id === w.sourceId)!;
    expect(s.lastLeadAt).not.toBeNull();
    expect(s.leadsLast30Days).toBe(1);
    expect(s.paths.email).toMatchObject({ state: 'on', address: inbox.address });
    expect(s.paths.webhook).toEqual({ hasToken: true, ownSecret: false, secretCreatedAt: null });
    expect(s.paths.googleLeadForm.state).toBe('off');
    expect(s.paths.trackingNumbers).toEqual([]);
    const text = JSON.stringify(o);
    expect(text).not.toMatch(/confidence|score|tenantId|tenant_id/i);
    expect(text).not.toContain(w.tenantId);
    expect(o.sources.some((x) => x.id === other.sourceId)).toBe(false);
  });

  it('R-LSRC-1 R-PERM-5: only Owner/Admin read it', async () => {
    expect((await call(w.others[0]!, 'GET', '/lead-sources/overview')).status).toBe(200);
    expect([403, 404]).toContain((await call(w.agents[0]!, 'GET', '/lead-sources/overview')).status);
  });

  it('R-LSRC-1 E339: a deployment without an inbound domain or a public https address says so per path', async () => {
    const h2 = await createApiHarness({ config: { publicBaseUrl: 'http://localhost:3000', leadEmail: { ...h.config.leadEmail, inboundDomain: null } } });
    try {
      const w2 = await leadsWorld(h2, { agents: 1, rule: false });
      const o = (await call<Overview>(w2.owner, 'GET', '/lead-sources/overview')).body;
      expect(o.deployment).toEqual({ inboundEmail: false, publicHttps: false });
      expect(o.sources[0]!.paths.email.state).toBe('not_available');
      expect(o.sources[0]!.paths.googleLeadForm.state).toBe('not_available');
    } finally {
      await h2.close();
    }
  }, 120_000);
});

describe('R-LSRC-2 rename, consent text, off and on', () => {
  it('R-LSRC-2: a duplicate name is VERSION_CONFLICT {field:name}; a rename is audited', async () => {
    const a = await newSource('Rename A');
    await newSource('Rename B');
    const dup = await call(w.owner, 'PATCH', `/lead-sources/${a.id}`, { name: 'Rename B' });
    expect([dup.status, dup.code]).toEqual([409, 'VERSION_CONFLICT']);
    const ok = await call<{ source: { name: string } }>(w.owner, 'PATCH', `/lead-sources/${a.id}`, { name: 'Rename C' });
    expect(ok.body.source.name).toBe('Rename C');
    const audits = (await h.su.query("SELECT reason FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'routing.changed' ORDER BY occurred_at", [w.tenantId, a.id])).rows.map((r) => r.reason);
    expect(audits).toContain('LEAD_SOURCE_RENAMED');
  });

  it('R-LSRC-2 E337: a new consent text is a new disclosure row; new chats show it, a stale one is refused, earlier inquiries keep theirs', async () => {
    const src = await chatSource(h, w.owner, w.tenantId, `Chat ${randomUUID().slice(0, 6)}`);
    const widget = await createWidget(h, w.owner, src.sourceId);
    const before = await call<{ contactId: string; inquiryId: string }>(w.owner, 'GET', '/lead-sources/overview'); // touch
    expect(before.status).toBe(200);
    const first = await startChat(h, widget.key, { name: 'Early Visitor', phone: randomPhone(), message: 'Is it still for sale?', disclosureId: src.disclosureId });
    expect(first.statusCode).toBe(200);
    const r = await call(w.owner, 'PATCH', `/lead-sources/${src.sourceId}`, { consentDisclosure: { text: 'New consent wording for the chat.', namesSeller: 'The team' } });
    expect(r.status).toBe(200);
    const now = (await h.su.query('SELECT consent_disclosure_id FROM lead_sources WHERE id = $1', [src.sourceId])).rows[0]!.consent_disclosure_id as string;
    expect(now).not.toBe(src.disclosureId);
    const cfg = JSON.parse((await chatConfig(h, widget.key)).body) as { disclosure: { id: string; text: string } };
    expect(cfg.disclosure).toEqual({ id: now, text: 'New consent wording for the chat.' });
    const stale = await startChat(h, widget.key, { name: 'Late Visitor', phone: randomPhone(), message: 'Hello again', disclosureId: src.disclosureId }, { origin: SITE });
    expect([stale.statusCode, codeOf(stale)]).toEqual([409, 'WEBCHAT_DISCLOSURE_STALE']);
    const cited = (await h.su.query('SELECT DISTINCT consent_disclosure_id FROM lead_inquiries WHERE lead_source_id = $1', [src.sourceId])).rows.map((x) => x.consent_disclosure_id);
    expect(cited).toEqual([src.disclosureId]);
    expect((await h.su.query("SELECT reason FROM audit_log WHERE entity_id = $1 AND reason = 'LEAD_SOURCE_DISCLOSURE_CHANGED'", [src.sourceId])).rows).toHaveLength(1);
  });

  it('R-LSRC-2 E387: off stops every path (intake 404 unrouted, lead email unrouted), the card says since when; on restores; 🔒', async () => {
    const s = await newSource('Off test');
    const inbox = await enableInbox(h, w.owner, s.id);
    await freshReauth(h, w.owner);
    const off = await call<{ source: { active: boolean; offSince: string }; paths: string[]; sentence: string }>(w.owner, 'POST', `/lead-sources/${s.id}/off`);
    expect(off.status).toBe(200);
    expect(off.body.source.active).toBe(false);
    expect(off.body.paths).toEqual(['Lead emails sent to its address', 'Leads your website or system posts to its webhook address']);
    expect(off.body.sentence).toMatch(/not received/);
    expect((await sourceOf(s.id)).offSince).toBe(off.body.source.offSince);
    const posted = await postIntake(h, s.token, { fullName: 'Off Lead', phones: [randomPhone()] });
    expect(posted.statusCode).toBe(404);
    const mail = await postLeadEmail(h, { to: inbox.address!, text: labelledBody({ name: 'Off Mail', email: leadAddress() }) });
    expect(JSON.parse(mail.body).outcome).toBe('unrouted');
    const on = await call<{ source: { active: boolean; offSince: null } }>(w.owner, 'POST', `/lead-sources/${s.id}/on`);
    expect(on.body.source).toMatchObject({ active: true, offSince: null });
    expect((await postIntake(h, s.token, { fullName: 'On Lead', phones: [randomPhone()] })).statusCode).toBe(201);
    const reasons = (await h.su.query("SELECT reason FROM audit_log WHERE entity_id = $1 AND action = 'routing.changed' ORDER BY occurred_at", [s.id])).rows.map((r) => r.reason);
    expect(reasons).toEqual(expect.arrayContaining(['LEAD_SOURCE_DEACTIVATED', 'LEAD_SOURCE_REACTIVATED']));
    await h.su.query('UPDATE sessions SET reauthenticated_at = NULL WHERE user_id = $1', [w.owner.userId]);
    const stale = await call(w.owner, 'POST', `/lead-sources/${s.id}/off`);
    expect([stale.status, stale.code]).toEqual([401, 'REAUTH_REQUIRED']);
  });
});

describe('R-LSRC-3 a source\'s own webhook credentials', () => {
  it('R-LSRC-3 E333: rotation gives a new URL and secret once; only that secret is accepted; the deployment secret is refused for it and kept for a source without one; the old token is unrouted', async () => {
    const s = await newSource('Own secret');
    const plain = await newSource('Deployment secret');
    await freshReauth(h, w.owner);
    const r = await call<{ intakeUrl: string; signingSecret: string; createdAt: string }>(w.owner, 'POST', `/lead-sources/${s.id}/webhook`);
    expect(r.status).toBe(200);
    const token = new URL(r.body.intakeUrl).pathname.split('/').at(-1)!;
    expect(r.body.signingSecret).toMatch(/^[0-9a-f]{64}$/);
    expect((await signed(r.body.signingSecret, token, { fullName: 'Own Lead', phones: [randomPhone()] })).statusCode).toBe(201);
    expect((await signed(h.config.webhookSecrets.lead, token, { fullName: 'Deploy Lead', phones: [randomPhone()] })).statusCode).toBe(403);
    expect((await signed(h.config.webhookSecrets.lead, plain.token, { fullName: 'Plain Lead', phones: [randomPhone()] })).statusCode).toBe(201);
    // the old token: unknown now, so the deployment secret applies and the delivery is unrouted
    expect((await postIntake(h, s.token, { fullName: 'Old Url', phones: [randomPhone()] })).statusCode).toBe(404);
    const audits = (await h.su.query("SELECT changes::text AS c FROM audit_log WHERE entity_id = $1 AND action = 'lead_source.webhook_rotated'", [s.id])).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.c).not.toContain(r.body.signingSecret);
    expect(audits[0]!.c).not.toContain(token);
    const o = await sourceOf(s.id);
    expect(o.paths.webhook).toMatchObject({ hasToken: true, ownSecret: true, secretCreatedAt: r.body.createdAt });
  });

  it('R-LSRC-3 E338: two rotations at once are serialized: both 200, only the later key works, each says when it was made', async () => {
    const s = await newSource('Race rotate');
    const admin = w.others[0]!;
    await freshReauth(h, w.owner);
    await freshReauth(h, admin);
    const [a, b] = await Promise.all([
      call<{ intakeUrl: string; signingSecret: string; createdAt: string }>(w.owner, 'POST', `/lead-sources/${s.id}/webhook`),
      call<{ intakeUrl: string; signingSecret: string; createdAt: string }>(admin, 'POST', `/lead-sources/${s.id}/webhook`),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [first, later] = Date.parse(a.body.createdAt) <= Date.parse(b.body.createdAt) ? [a, b] : [b, a];
    const tok = (x: typeof a) => new URL(x.body.intakeUrl).pathname.split('/').at(-1)!;
    expect((await signed(later.body.signingSecret, tok(later), { fullName: 'Later', phones: [randomPhone()] })).statusCode).toBe(201);
    expect((await signed(first.body.signingSecret, tok(first), { fullName: 'First', phones: [randomPhone()] })).statusCode).not.toBe(201);
  });

  it('R-LSRC-3: an off source gets no new credentials (LEAD_SOURCE_OFF)', async () => {
    const s = await newSource('Off rotate');
    await freshReauth(h, w.owner);
    await call(w.owner, 'POST', `/lead-sources/${s.id}/off`);
    const r = await call(w.owner, 'POST', `/lead-sources/${s.id}/webhook`);
    expect([r.status, r.code]).toEqual([409, 'LEAD_SOURCE_OFF']);
  });
});

describe('R-LSRC-4 the routing preview', () => {
  interface Preview {
    rule: { id: string; name: string } | null;
    outcome: { kind: 'offer'; userId: string; name: string } | { kind: 'pond'; pondId: string; pondName: string; reason: string };
    considered: { userId: string; eligible: boolean; reason: string | null }[];
    sentence: string;
    firstResponse: string;
  }
  const snapshot = async () => {
    const tables = ['routing_rotation_state', 'lead_inquiries', 'contacts', 'lead_ownership_events', 'audit_log', 'jobs', 'notifications'];
    const out: Record<string, unknown> = {};
    for (const t of tables) out[t] = (await h.su.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [w.tenantId])).rows[0]!.n;
    out.cursor = (await h.su.query('SELECT cursor FROM routing_rotation_state WHERE tenant_id = $1 ORDER BY rule_id', [w.tenantId])).rows;
    return out;
  };

  it('R-LSRC-4 E334: mid-round it names who a lead arriving now would be offered to, changes nothing, and the next real lead goes to that person', async () => {
    await intake(h, w); // advances the round robin
    const before = await snapshot();
    const p = await call<Preview>(w.owner, 'POST', `/lead-sources/${w.sourceId}/preview`, { inquiryType: 'buy' });
    expect(p.status).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect(p.body.outcome.kind).toBe('offer');
    expect(p.body.rule?.id).toBe(w.ruleId);
    expect(p.body.sentence).toMatch(/^If a lead came in now, it would be offered to /);
    expect(p.body.firstResponse).toBe('off'); // no approved new-lead playbook in this world
    const lead = await intake(h, w);
    const st = await contactState(h, lead.contactId);
    expect(st.offered_to_user_id).toBe((p.body.outcome as { userId: string }).userId);
  });

  it('R-LSRC-4 E336: a suspended direct agent ⇒ the fallback pond and the reason in words', async () => {
    const s = await newSource('Forwarded by Member');
    const agent = w.agents[1]!;
    await freshReauth(h, w.owner);
    const rule = await call<{ rule: { id: string } }>(w.owner, 'POST', '/routing-rules', { name: 'Direct', strategy: 'direct', directUserId: agent.userId, match: { sources: [s.id] } });
    expect(rule.status).toBe(201);
    await h.su.query('UPDATE routing_rules SET position = -1 WHERE id = $1', [rule.body.rule.id]);
    await h.su.query("UPDATE memberships SET accepting_leads = false WHERE tenant_id = $1 AND user_id = $2", [w.tenantId, agent.userId]);
    const p = await call<Preview>(w.owner, 'POST', `/lead-sources/${s.id}/preview`, {});
    expect(p.body.outcome).toMatchObject({ kind: 'pond', pondId: w.defaultPondId, reason: 'Nobody in the matching rule can take a lead right now.' });
    expect(p.body.considered).toEqual([{ userId: agent.userId, name: expect.any(String), eligible: false, reason: expect.stringMatching(/is not accepting leads\.$/) }]);
    expect(p.body.sentence).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    await h.su.query("UPDATE memberships SET accepting_leads = true WHERE tenant_id = $1 AND user_id = $2", [w.tenantId, agent.userId]);
    await h.su.query('DELETE FROM routing_rule_members WHERE rule_id = $1', [rule.body.rule.id]).catch(() => undefined);
    await h.su.query('UPDATE routing_rules SET enabled = false WHERE id = $1', [rule.body.rule.id]);
  });

  it('R-LSRC-4: a price-band rule matches only with a price', async () => {
    const s = await newSource('Priced');
    await freshReauth(h, w.owner);
    const rule = await call<{ rule: { id: string } }>(w.owner, 'POST', '/routing-rules', { name: 'Luxury', strategy: 'direct', directUserId: w.agents[0]!.userId, match: { sources: [s.id], price_min: 100_000_000, price_max: 900_000_000 } });
    expect(rule.status).toBe(201);
    await h.su.query('UPDATE routing_rules SET position = -2 WHERE id = $1', [rule.body.rule.id]);
    const noPrice = await call<Preview>(w.owner, 'POST', `/lead-sources/${s.id}/preview`, { inquiryType: 'buy' });
    expect(noPrice.body.rule?.id).not.toBe(rule.body.rule.id);
    const priced = await call<Preview>(w.owner, 'POST', `/lead-sources/${s.id}/preview`, { inquiryType: 'buy', priceMinCents: 150_000_000, priceMaxCents: 200_000_000 });
    expect(priced.body.rule?.id).toBe(rule.body.rule.id);
    await h.su.query('UPDATE routing_rules SET enabled = false WHERE id = $1', [rule.body.rule.id]);
  });
});

describe('R-LSRC-5 agent forwarding', () => {
  it('R-LSRC-5 E335: a direct rule below the catch-all never wins; moved to the top (PUT /routing-rules/order) it does', async () => {
    const s = await newSource('Forwarded by Agent Two');
    const agent = w.agents[1]!;
    await freshReauth(h, w.owner);
    const rule = await call<{ rule: { id: string } }>(w.owner, 'POST', '/routing-rules', { name: 'Agent Two forwards', strategy: 'direct', directUserId: agent.userId, match: { sources: [s.id] } });
    expect(rule.status).toBe(201);
    const before = await call<Preview2>(w.owner, 'POST', `/lead-sources/${s.id}/preview`, {});
    expect(before.body.rule?.id).toBe(w.ruleId);
    const rules = (await call<{ rules: { id: string; enabled: boolean }[] }>(w.owner, 'GET', '/routing-rules')).body.rules.map((r) => r.id);
    const order = [rule.body.rule.id, ...rules.filter((id) => id !== rule.body.rule.id)];
    expect((await call(w.owner, 'PUT', '/routing-rules/order', { ruleIds: order })).status).toBe(200);
    const after = await call<Preview2>(w.owner, 'POST', `/lead-sources/${s.id}/preview`, {});
    expect(after.body).toMatchObject({ rule: { id: rule.body.rule.id }, outcome: { kind: 'offer', userId: agent.userId } });
  });
});
interface Preview2 {
  rule: { id: string } | null;
  outcome: { kind: string; userId?: string };
}

describe('cross-tenant (R-TEN-3)', () => {
  it('R-TEN-3: another tenant\'s source id is 404 on every new route, and nothing is read or written', async () => {
    await freshReauth(h, w.owner);
    const before = (await h.su.query('SELECT name, active, ingest_token_hash FROM lead_sources WHERE id = $1', [other.sourceId])).rows;
    for (const [m, path, body] of [
      ['PATCH', `/lead-sources/${other.sourceId}`, { name: 'Taken over' }],
      ['POST', `/lead-sources/${other.sourceId}/off`, undefined],
      ['POST', `/lead-sources/${other.sourceId}/on`, undefined],
      ['POST', `/lead-sources/${other.sourceId}/webhook`, undefined],
      ['POST', `/lead-sources/${other.sourceId}/preview`, {}],
    ] as const) {
      const r = await call(w.owner, m, path, body);
      expect(r.status, path).toBe(404);
    }
    expect((await h.su.query('SELECT name, active, ingest_token_hash FROM lead_sources WHERE id = $1', [other.sourceId])).rows).toEqual(before);
  });
});

describe('response schemas (R-AST-13, R-TEN-3)', () => {
  it('R-AST-13 R-TEN-3: the Lead sources response schemas have no confidence or score field and no tenant id', async () => {
    const { z } = await import('zod');
    const { LEAD_SOURCES_RESPONSE_SCHEMAS } = await import('./sourcesSchemas.js');
    for (const [name, schema] of Object.entries(LEAD_SOURCES_RESPONSE_SCHEMAS)) {
      const text = JSON.stringify(z.toJSONSchema(schema));
      expect(text, name).not.toMatch(/"confidence|"score|"tenantId|"tenant_id/i);
    }
  });
});
