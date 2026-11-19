// Source coverage through the real server as app_user (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-10,
// R-TEAMQ-11, E833 to E837): a named owner, a named backup, a "high intent" mark and the "covered" switch of a lead
// source, read with its computed warnings and changed by Owner and Admin only, every change audited. Names are made up.
import { randomUUID } from 'node:crypto';
import { type Role, ROLES, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { CoverageBody, LEAD_SOURCES_RESPONSE_SCHEMAS } from './sourcesSchemas.js';
import { type LeadsWorld, call, freshReauth, leadsWorker, leadsWorld } from './testing.js';

interface Coverage {
  owner: { userId: string; name: string | null; status: string } | null;
  backup: { userId: string; name: string | null; status: string } | null;
  highIntent: boolean;
  covered: boolean;
  setting: boolean;
  sentence: string;
  warnings: { code: string; sentence: string }[];
  changedAt: string | null;
}

let h: ApiHarness;
let w: LeadsWorld & { others: TestClient[] };
let other: LeadsWorld;
const users = {} as Record<Role, TestClient>;

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 3, teamLead: true, others: ['admin', 'isa', 'tc'] });
  other = await leadsWorld(h, { agents: 1 });
  users.owner = w.owner;
  users.agent = w.agents[0]!;
  users.team_lead = w.teamLead!;
  [users.admin, users.isa, users.tc] = w.others as [TestClient, TestClient, TestClient];
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const read = async (id = w.sourceId, c: TestClient = w.owner) => call<{ coverage: Coverage }>(c, 'GET', `/lead-sources/${id}/coverage`);
const put = async (body: Record<string, unknown>, id = w.sourceId, c: TestClient = w.owner) => call<{ coverage: Coverage }>(c, 'PUT', `/lead-sources/${id}/coverage`, body);
const inOverview = async (id = w.sourceId, c: TestClient = w.owner) => (await call<{ sources: { id: string; coverage: Coverage }[] }>(c, 'GET', '/lead-sources/overview')).body.sources.find((s) => s.id === id)!.coverage;
const codesOf = (c: Coverage) => c.warnings.map((x) => x.code);
const newSource = async (name: string) => (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name, kind: 'website' })).body.source.id;
const audits = async (sourceId: string) =>
  (await h.su.query<{ actor_user_id: string; reason: string; changes: Record<string, unknown> }>("SELECT actor_user_id, reason, changes FROM audit_log WHERE entity_type = 'lead_source' AND entity_id = $1 AND reason = 'LEAD_SOURCE_COVERAGE_CHANGED' ORDER BY seq", [sourceId])).rows;
const stored = async (sourceId: string) => (await h.su.query<{ o: string | null; b: string | null; c: boolean; hi: boolean }>('SELECT owner_user_id AS o, backup_user_id AS b, covered AS c, high_intent AS hi FROM lead_sources WHERE id = $1', [sourceId])).rows[0]!;

describe('R-TEAMQ-10 the coverage of a lead source: read and change', () => {
  it('R-TEAMQ-10 E833: a source starts not covered, said in words with its warnings; the overview and the per-source read agree', async () => {
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body.coverage).toMatchObject({ owner: null, backup: null, highIntent: false, covered: false, setting: false, sentence: 'Not covered: no owner and no backup are named.', changedAt: null });
    expect(codesOf(r.body.coverage)).toEqual(expect.arrayContaining(['NO_OWNER', 'NO_BACKUP']));
    for (const x of r.body.coverage.warnings) expect(x.sentence.length).toBeGreaterThan(10);
    expect(await inOverview()).toEqual(r.body.coverage);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/confidence|score|tenantId|tenant_id/i);
  });

  it('R-TEAMQ-10: the Owner names an owner and a backup, marks high intent and turns coverage on; the change is audited with who, from and to; saying the same again writes nothing', async () => {
    const [a, b] = w.agents as [TestClient, TestClient, TestClient];
    const r = await put({ ownerUserId: a.userId, backupUserId: b.userId, highIntent: true, covered: true });
    expect(r.status).toBe(200);
    expect(r.body.coverage).toMatchObject({ owner: { userId: a.userId, status: 'active' }, backup: { userId: b.userId, status: 'active' }, highIntent: true, covered: true, setting: true });
    expect(r.body.coverage.sentence).toMatch(/^Covered: .+ owns this source and .+ is the backup\.$/);
    expect(r.body.coverage.changedAt).not.toBeNull();
    expect(codesOf(r.body.coverage)).not.toEqual(expect.arrayContaining(['NO_OWNER']));
    expect(await stored(w.sourceId)).toEqual({ o: a.userId, b: b.userId, c: true, hi: true });
    expect((await read()).body.coverage).toEqual(r.body.coverage);
    expect(await inOverview()).toEqual(r.body.coverage);
    const log = await audits(w.sourceId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      actor_user_id: w.owner.userId,
      changes: { owner_user_id: { from: null, to: a.userId }, backup_user_id: { from: null, to: b.userId }, high_intent: { from: false, to: true }, covered: { from: false, to: true } },
    });
    // the same values again: no write, no second audit row
    expect((await put({ ownerUserId: a.userId, backupUserId: b.userId, highIntent: true, covered: true })).status).toBe(200);
    expect(await audits(w.sourceId)).toHaveLength(1);
    // an Admin edits too, and only what changed is in the audit row
    const byAdmin = await put({ ownerUserId: a.userId, backupUserId: b.userId, highIntent: false, covered: true }, w.sourceId, users.admin);
    expect(byAdmin.status).toBe(200);
    const log2 = await audits(w.sourceId);
    expect(log2).toHaveLength(2);
    expect(log2[1]).toMatchObject({ actor_user_id: users.admin.userId, changes: { high_intent: { from: true, to: false } } });
    expect(Object.keys(log2[1]!.changes)).toEqual(['high_intent']);
  });

  it('R-TEAMQ-10 E833: covered is refused without both people, and nothing is written; a strict body refuses an extra field or a tenant id', async () => {
    const id = await newSource('Open house sign-in (coverage test)');
    const a = w.agents[0]!;
    for (const body of [
      { ownerUserId: a.userId, backupUserId: null, highIntent: false, covered: true },
      { ownerUserId: null, backupUserId: a.userId, highIntent: false, covered: true },
      { ownerUserId: null, backupUserId: null, highIntent: false, covered: true },
    ]) {
      const r = await put(body, id);
      expect([r.status, r.code]).toEqual([422, 'VALIDATION_FAILED']);
    }
    expect(await stored(id)).toEqual({ o: null, b: null, c: false, hi: false });
    expect(await audits(id)).toEqual([]);
    expect((await put({ ownerUserId: null, backupUserId: null, highIntent: false, covered: false, tenantId: w.tenantId }, id)).status).toBe(422);
    expect((await put({ ownerUserId: null, backupUserId: null, highIntent: false }, id)).status).toBe(422);
    expect(Object.keys(z.toJSONSchema(CoverageBody).properties ?? {}).sort()).toEqual(['backupUserId', 'covered', 'highIntent', 'ownerUserId']);
  });

  it('R-TEAMQ-10 R-PERM-15: a member who cannot take leads (a TC), a suspended member and an unknown id cannot be newly named', async () => {
    const id = await newSource('Sign calls (coverage test)');
    const a = w.agents[0]!;
    const tc = await put({ ownerUserId: a.userId, backupUserId: users.tc.userId, highIntent: false, covered: false }, id);
    expect([tc.status, tc.code]).toEqual([422, 'VALIDATION_FAILED']);
    const unknown = await put({ ownerUserId: randomUUID(), backupUserId: a.userId, highIntent: false, covered: false }, id);
    expect([unknown.status, unknown.code]).toEqual([404, 'NOT_FOUND']);
    expect(await stored(id)).toEqual({ o: null, b: null, c: false, hi: false });
  });

  it('R-TEAMQ-11 E835 E836: the same person twice, no rule naming the source and a shared fallback pond are warnings, each a code and a sentence', async () => {
    const id = await newSource('Website form (coverage test)');
    const a = w.agents[0]!;
    const r = await put({ ownerUserId: a.userId, backupUserId: a.userId, highIntent: false, covered: true }, id);
    expect(r.status).toBe(200);
    expect(r.body.coverage.covered).toBe(true);
    // R-TEAMQ-21 E881 (review fix M2): this agent is in the rule's rotation, so as the backup they also receive these leads: said too
    expect(codesOf(r.body.coverage)).toEqual(['SAME_PERSON', 'BACKUP_IN_ROTATION', 'NO_ROUTING_RULE', 'SHARED_FALLBACK_POND']);
    const byCode = new Map(r.body.coverage.warnings.map((x) => [x.code, x.sentence]));
    expect(byCode.get('BACKUP_IN_ROTATION')).toBe('The backup also receives these leads. When a lead is with them, their team lead is alerted instead.');
    // the world's rule ("Everyone") names no source, so this source falls to it; every source shares the default pond
    expect(byCode.get('NO_ROUTING_RULE')).toBe('No routing rule names this source: its leads follow the rule "Everyone", which is not specific to it.');
    expect(byCode.get('SHARED_FALLBACK_POND')).toMatch(/^Its fallback pond, ".+", is also the fallback pond of /);
  });

  it('R-TEAMQ-11 E836: with no routing rule its leads go straight to the default pond, said so; a rule that names the source, with its own fallback pond, clears both warnings', async () => {
    const w3 = await leadsWorld(h, { agents: 2, rule: false });
    const [a, b] = w3.agents as [TestClient, TestClient];
    const first = await put({ ownerUserId: a.userId, backupUserId: b.userId, highIntent: false, covered: true }, w3.sourceId, w3.owner);
    expect(first.status).toBe(200);
    expect(codesOf(first.body.coverage)).toEqual(['NO_ROUTING_RULE']);
    expect(first.body.coverage.warnings[0]!.sentence).toMatch(/^No routing rule names this source: its leads go straight to the pond ".+"\.$/);
    await freshReauth(h, w3.owner);
    const pond = await call<{ pond: { id: string } }>(w3.owner, 'POST', '/ponds', { name: 'Portal overflow (coverage test)' });
    expect(pond.status).toBe(201);
    const rule = await call(w3.owner, 'POST', '/routing-rules', { name: 'Portal first', strategy: 'round_robin', match: { sources: [w3.sourceId] }, members: [{ userId: a.userId, weight: 1 }], fallbackPondId: pond.body.pond.id });
    expect(rule.status).toBe(201);
    const after = (await read(w3.sourceId, w3.owner)).body.coverage;
    expect(after.warnings).toEqual([]);
    expect(after.covered).toBe(true);
    // a second source of that team still falls to the default pond, alone there: only the rule warning
    const second = await call<{ source: { id: string } }>(w3.owner, 'POST', '/lead-sources', { name: 'Website (coverage test)', kind: 'website' });
    expect(codesOf((await read(second.body.source.id, w3.owner)).body.coverage)).toEqual(['NO_OWNER', 'NO_BACKUP', 'NO_ROUTING_RULE']);
  });
});

describe('R-TEAMQ-11 a named member is suspended or deactivated', () => {
  it('R-TEAMQ-11 E834: suspending the backup does not fail: the source is flagged and reads as not covered, nobody is put in their place, and reactivating them covers it again', async () => {
    const id = await newSource('Portal B (coverage test)');
    const [a, , c] = w.agents as [TestClient, TestClient, TestClient];
    expect((await put({ ownerUserId: a.userId, backupUserId: c.userId, highIntent: false, covered: true }, id)).body.coverage.covered).toBe(true);
    await freshReauth(h, w.owner);
    const members = await call<{ members: { userId: string; version: number }[] }>(w.owner, 'GET', '/members');
    const version = members.body.members.find((m) => m.userId === c.userId)!.version;
    const suspended = await call<{ member: { version: number } }>(w.owner, 'PATCH', `/members/${c.userId}`, { status: 'suspended', version });
    expect(suspended.status).toBe(200);
    const after = (await read(id)).body.coverage;
    expect(after).toMatchObject({ covered: false, setting: true, owner: { userId: a.userId }, backup: { userId: c.userId, status: 'suspended' } });
    expect(after.sentence).toMatch(/^Not covered: the backup, .+, is suspended\.$/);
    expect(codesOf(after)).toContain('BACKUP_UNAVAILABLE');
    expect(await stored(id)).toMatchObject({ o: a.userId, b: c.userId, c: true });
    // nothing was written to the source by the suspension
    expect(await audits(id)).toHaveLength(1);
    // the Owner can still save the other fields with the suspended backup left as named
    expect((await put({ ownerUserId: a.userId, backupUserId: c.userId, highIntent: true, covered: true }, id)).status).toBe(200);
    // ...but a suspended member cannot be NEWLY named
    const other = await newSource('Portal C (coverage test)');
    const refused = await put({ ownerUserId: a.userId, backupUserId: c.userId, highIntent: false, covered: false }, other);
    expect([refused.status, refused.code]).toEqual([422, 'VALIDATION_FAILED']);
    await freshReauth(h, w.owner);
    const back = await call(w.owner, 'PATCH', `/members/${c.userId}`, { status: 'active', version: suspended.body.member.version });
    expect(back.status).toBe(200);
    expect((await read(id)).body.coverage.covered).toBe(true);
  });

  it('R-TEAMQ-11 E834: deactivating the owner of a source runs to the end: the source keeps naming them, is flagged and not covered', async () => {
    const id = await newSource('Portal D (coverage test)');
    const w2 = w.agents[1]!;
    const [a] = w.agents as [TestClient];
    expect((await put({ ownerUserId: w2.userId, backupUserId: a.userId, highIntent: false, covered: true }, id)).status).toBe(200);
    await freshReauth(h, w.owner);
    const run = await call(w.owner, 'POST', `/members/${w2.userId}/deactivate`, { mode: 'run', destination: 'default_pond' });
    expect(run.status).toBe(202);
    await leadsWorker(h).drain();
    expect((await h.su.query<{ status: string }>('SELECT status FROM memberships WHERE tenant_id = $1 AND user_id = $2', [w.tenantId, w2.userId])).rows[0]!.status).toBe('removed');
    const after = (await read(id)).body.coverage;
    expect(after).toMatchObject({ covered: false, setting: true, owner: { userId: w2.userId, status: 'removed' }, backup: { userId: a.userId, status: 'active' } });
    expect(after.sentence).toMatch(/^Not covered: the owner, .+, is no longer on the team\.$/);
    expect(codesOf(after)).toContain('OWNER_UNAVAILABLE');
    expect(await stored(id)).toMatchObject({ o: w2.userId, b: a.userId, c: true });
  });
});

describe('R-TEAMQ-10 who may read and change coverage', () => {
  it('R-TEAMQ-10 E837 R-PERM-1 R-PERM-5: the role matrix: Owner and Admin read and change it; a Team Lead, an Agent, an ISA and a TC get 404 on both and change nothing', async () => {
    const id = await newSource('Role matrix source (coverage test)');
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const c = users[role];
      const allowed = can(c.actor(), 'settings.routing', {}).ok;
      const r = await read(id, c);
      const p = await put({ ownerUserId: null, backupUserId: null, highIntent: role === 'owner' || role === 'admin', covered: false }, id, c);
      got[`${role} read`] = String(r.status);
      got[`${role} change`] = String(p.status);
      want[`${role} read`] = allowed ? '200' : '404';
      want[`${role} change`] = allowed ? '200' : '404';
    }
    expect(got).toEqual(want);
    expect(want).toMatchObject({ 'owner change': '200', 'admin change': '200', 'team_lead change': '404', 'agent read': '404', 'isa read': '404', 'tc change': '404' });
    // only the Owner's and the Admin's change reached the row and the audit log (the second said the same as the first)
    expect((await audits(id)).map((x) => x.actor_user_id)).toEqual([w.owner.userId]);
    expect((await h.client().request('GET', `/api/lead-sources/${id}/coverage`)).statusCode).toBe(401);
  });

  it('R-TEAMQ-10 E837 R-TEN-1: tenant isolation: another team\'s source is 404 to read and to change, another team\'s member cannot be named, and the overview never lists it', async () => {
    const a = w.agents[0]!;
    expect((await read(other.sourceId)).status).toBe(404);
    expect((await put({ ownerUserId: a.userId, backupUserId: a.userId, highIntent: true, covered: true }, other.sourceId)).status).toBe(404);
    expect(await stored(other.sourceId)).toEqual({ o: null, b: null, c: false, hi: false });
    const foreign = await put({ ownerUserId: other.agents[0]!.userId, backupUserId: a.userId, highIntent: false, covered: false });
    expect([foreign.status, foreign.code]).toEqual([404, 'NOT_FOUND']);
    expect(JSON.stringify((await call(w.owner, 'GET', '/lead-sources/overview')).body)).not.toContain(other.sourceId);
    // the other team reads its own source only
    expect((await read(other.sourceId, other.owner)).status).toBe(200);
    expect((await read(w.sourceId, other.owner)).status).toBe(404);
  });

  it('R-AST-13 R-TEN-3: the coverage response schema has no confidence or tenant id field', () => {
    const text = JSON.stringify(z.toJSONSchema(LEAD_SOURCES_RESPONSE_SCHEMAS.CoverageResponse));
    expect(text).not.toMatch(/confidence/i);
    expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
  });
});
