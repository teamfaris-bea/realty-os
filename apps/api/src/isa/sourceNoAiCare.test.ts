// b18 item f (PHASE2_3_PLAN product boundaries, owner 2026-11-14; renamed "No automated contact for leads from this source"
// by b18 review B18S-5): an Owner-only lead-source setting, first named "No AI care for
// leads from this source". AI care start, Continue and resume refuse AI_ISA_SOURCE_NO_AI_CARE for a person whose
// original lead source has it set (any record of the person), the panel says why, and care already running pauses with
// an honest note (pause reason source_no_ai_care, chain link 11). The source here is a made-up test source: no partner
// is named in code, seeds or tests. Fakes only.
import { withTenantTx } from '@realty/db';
import type { UserActor } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { inviteViaApi } from '../admin/testing.js';
import { postIntake } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { type IsaWorld, assignmentOf, call, freshReauth, isaLead, isaWorld, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;
let admin: TestClient;
let source: string;
let other: string;
let referral: { id: string; token: string };
let later: { id: string; token: string };

const actorOf = (c: TestClient, role: UserActor['role']): UserActor => ({ kind: 'user', userId: c.userId!, tenantId: w.tenantId, role, sessionId: 'b18-test' }) as UserActor;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
  admin = await inviteViaApi(h, w.owner, 'admin');
  source = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Referral source (test)', kind: 'portal' })).body.source.id;
  other = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Open house sign-in (test)', kind: 'portal' })).body.source.id;
  // B18S-1: two more made-up sources whose inquiries reach people already in the CRM (through the signed intake webhook)
  const made = async (name: string) => {
    const r = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name, kind: 'portal' });
    return { id: r.body.source.id, token: r.body.ingestToken };
  };
  referral = await made('Partner referral (test)');
  later = await made('Second referral (test)');
});
afterAll(async () => {
  await h?.close();
});

/** fixture only: the lead arrived from `src` (the intake writes original_lead_source_id; the test sets it directly) */
const fromSource = (contactId: string, src: string) => h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [contactId, src]);
const setNoAiCare = async (c: TestClient, on: boolean, src = source) => {
  await freshReauth(h, c);
  return call<{ source: { id: string; noAiCare: boolean; noAiCareSentence: string }; pausing: number }>(c, 'PUT', `/lead-sources/${src}/ai-care`, { noAiCare: on });
};
const panel = (c: TestClient, contactId: string) =>
  call<{ canStart: boolean; canResume: boolean; canContinue: boolean; continueRefusal: { code: string; sentence: string } | null; startRefusal: { code: string; sentence: string } | null; chain: { link: number; effect: string; code: string | null; sentence: string }[]; assignment: { pauseReason: string | null } | null }>(c, 'GET', `/contacts/${contactId}/ai-isa`);

describe('b18 item f: "No AI care for leads from this source" (Owner-only, R-ISA-1)', () => {
  it('E723: only the Owner may change it; an Admin and an agent get 404 from the route, and the database refuses anyone else too', async () => {
    expect((await setNoAiCare(admin, true)).status).toBe(404);
    expect((await setNoAiCare(w.agents[0]!, true)).status).toBe(404);
    // the database backstop: an Admin writing the column directly is refused, and an agent cannot either
    // (an agent's update reaches no row at all: lead_sources' admin_update policy; the guard refuses the Admin, who can
    // update other columns, and the system)
    await expect(withTenantTx(actorOf(admin, 'admin'), (tx) => sql`UPDATE lead_sources SET no_ai_care = true WHERE tenant_id = app.tenant_id() AND id = ${source}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/LEAD_SOURCE_AI_CARE_OWNER_ONLY/);
    await expect(withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => sql`UPDATE lead_sources SET no_ai_care = true WHERE tenant_id = app.tenant_id() AND id = ${source}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/LEAD_SOURCE_AI_CARE_OWNER_ONLY/);
    const agentTry = await withTenantTx(actorOf(w.agents[0]!, 'agent'), (tx) => sql`UPDATE lead_sources SET no_ai_care = true WHERE tenant_id = app.tenant_id() AND id = ${source}::uuid`.execute(tx), { db: h.database }).then((r) => Number(r.numAffectedRows ?? 0n), (e: Error) => e.message);
    expect(agentTry === 0 || /LEAD_SOURCE_AI_CARE_OWNER_ONLY/.test(String(agentTry))).toBe(true);
    expect((await h.su.query('SELECT no_ai_care FROM lead_sources WHERE id = $1', [source])).rows[0]!.no_ai_care).toBe(false);
    const on = await setNoAiCare(w.owner, true);
    expect(on.status).toBe(200);
    expect(on.body.source.noAiCare).toBe(true);
    expect(on.body.source.noAiCareSentence).toMatch(/No automated contact for leads from this source/);
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND reason = 'LEAD_SOURCE_NO_AI_CARE_ON'", [w.tenantId, source])).rows).toHaveLength(1);
    const ov = await call<{ sources: { id: string; noAiCare: boolean }[] }>(admin, 'GET', '/lead-sources/overview');
    expect(ov.body.sources.find((s) => s.id === source)!.noAiCare).toBe(true);
    expect(ov.body.sources.find((s) => s.id === other)!.noAiCare).toBe(false);
    expect((await setNoAiCare(w.owner, false)).body.source.noAiCare).toBe(false);
  });

  it('E723: AI care start is refused AI_ISA_SOURCE_NO_AI_CARE for a lead whose original source has it set, and the panel says why; a lead from another source still starts', async () => {
    expect((await setNoAiCare(w.owner, true)).status).toBe(200);
    try {
      const l = await isaLead(h, w.agents[0]!);
      await fromSource(l.id, source);
      const r = await startCare(w.agents[0]!, l.id);
      expect(r.status).toBe(409);
      expect(r.code).toBe('AI_ISA_SOURCE_NO_AI_CARE');
      expect(await assignmentOf(h, l.id)).toBeNull();
      const p = await panel(w.agents[0]!, l.id);
      expect(p.body.canStart).toBe(false);
      expect(p.body.startRefusal!.code).toBe('AI_ISA_SOURCE_NO_AI_CARE');
      expect(p.body.startRefusal!.sentence).toMatch(/No automated contact for leads from this source/);
      // a merged-in record from that source counts for the person too
      const survivor = await isaLead(h, w.agents[0]!);
      await fromSource(survivor.id, other);
      const dup = await isaLead(h, w.agents[0]!);
      await fromSource(dup.id, source);
      await h.su.query(`SET session_replication_role = replica; UPDATE contacts SET merged_into_contact_id = '${survivor.id}' WHERE id = '${dup.id}'; SET session_replication_role = origin`);
      expect((await startCare(w.agents[0]!, survivor.id)).code).toBe('AI_ISA_SOURCE_NO_AI_CARE');
      // another source's lead is not affected
      const ok = await isaLead(h, w.agents[0]!);
      await fromSource(ok.id, other);
      expect((await startCare(w.agents[0]!, ok.id)).status).toBe(200);
    } finally {
      await setNoAiCare(w.owner, false);
    }
  });

  it('E723: care already running for such a lead pauses source_no_ai_care with an honest note, cannot be resumed while the setting is on, and the database refuses a resume too', async () => {
    const l = await isaLead(h, w.agents[0]!);
    await fromSource(l.id, source);
    expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await assignmentOf(h, l.id))!.paused_at).toBeNull();
    const on = await setNoAiCare(w.owner, true);
    expect(on.body.pausing).toBeGreaterThanOrEqual(1);
    await runIsa(h, w.tenantId);
    const a = (await assignmentOf(h, l.id))!;
    expect(a.ended_at).toBeNull();
    expect(a.paused_at).not.toBeNull();
    expect(a.pause_reason).toBe('source_no_ai_care');
    const note = (await h.su.query<{ title: string; body: string | null }>("SELECT title, body FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND kind = 'ai_isa_paused' AND subject_id = $3 ORDER BY created_at DESC LIMIT 1", [w.tenantId, w.agents[0]!.userId, l.id])).rows[0]!;
    expect(note.title).toMatch(/^AI care paused/);
    expect(note.body).toMatch(/No automated contact for leads from this source/);
    const p = await panel(w.agents[0]!, l.id);
    expect(p.status, JSON.stringify(p.body).slice(0, 400)).toBe(200);
    expect(p.body.assignment!.pauseReason).toBe('source_no_ai_care');
    expect(p.body.canResume).toBe(false);
    const link = p.body.chain.find((x) => x.link === 11)!;
    expect(link).toMatchObject({ effect: 'pause', code: 'AI_ISA_SOURCE_NO_AI_CARE' });
    expect(link.sentence).toMatch(/No automated contact for leads from this source/);
    const resume = await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/resume`, {});
    expect(resume.status).toBe(409);
    expect(resume.code).toBe('AI_ISA_SOURCE_NO_AI_CARE');
    // the database backstop: the owner clearing the pause directly is refused while the setting is on
    await expect(withTenantTx(actorOf(w.agents[0]!, 'agent'), (tx) => sql`UPDATE ai_isa_assignments SET paused_at = NULL, paused_by_kind = NULL, paused_by_user_id = NULL, pause_reason = NULL, epoch = epoch + 1
      WHERE tenant_id = app.tenant_id() AND id = ${a.id}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/AI_ISA_SOURCE_NO_AI_CARE/);
    // a Continue (a new linked assignment) is refused the same way
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/continue`, {})).status).toBeGreaterThanOrEqual(400);
    await setNoAiCare(w.owner, false);
  });
});

// B18S-1 (b18 review): the setting covers every lead the source sends, not only the person it first created. An inquiry
// from a marked source that the intake attaches to someone already in the CRM never changes original_lead_source_id
// (fixed once set, 0071), so 0094 alone let AI care start, continue and resume for them, and link 11 said "allows".
describe('B18S-1: "No AI care for leads from this source" covers an inquiry attached to an existing person', () => {
  /** the marked source sends `phone` again: the signed intake webhook, matched to the existing person by the phone */
  const sends = async (src: { token: string }, phone: string) => {
    const r = await postIntake(h, src.token, { inquiryType: 'buy', fullName: 'Jane Doe', phones: [phone], message: 'Referred by our partner (test).' });
    expect([200, 201], r.body).toContain(r.statusCode);
    return JSON.parse(r.body) as { contactId: string; outcome: string };
  };
  const original = async (contactId: string) => (await h.su.query<{ s: string | null }>('SELECT original_lead_source_id AS s FROM contacts WHERE id = $1', [contactId])).rows[0]!.s;
  const definerSays = (c: TestClient, role: UserActor['role'], contactId: string) =>
    withTenantTx(actorOf(c, role), async (tx) => (await sql<{ no: boolean }>`SELECT app.person_no_ai_care_source(app.tenant_id(), ${contactId}::uuid) AS no`.execute(tx)).rows[0]!.no, { db: h.database });

  beforeAll(async () => {
    expect((await setNoAiCare(w.owner, true, referral.id)).status).toBe(200);
  });

  it('B18S-1 E723: an inquiry from the marked source attached to a person from another source refuses the start, the panel says why, and the definer answers yes; a merged-in record\'s inquiry counts too', async () => {
    const agent = w.agents[0]!;
    const l = await isaLead(h, agent);
    await fromSource(l.id, other);
    const r = await sends(referral, l.phone);
    expect(r.contactId).toBe(l.id);
    expect(['attached', 'reinquiry']).toContain(r.outcome);
    expect(await original(l.id)).toBe(other); // the record's own attribution is unchanged (0071)
    expect(await definerSays(agent, 'agent', l.id)).toBe(true);
    const p = await panel(agent, l.id);
    expect(p.body.canStart).toBe(false);
    expect(p.body.startRefusal).toMatchObject({ code: 'AI_ISA_SOURCE_NO_AI_CARE' });
    const s = await startCare(agent, l.id);
    expect([s.status, s.code]).toEqual([409, 'AI_ISA_SOURCE_NO_AI_CARE']);
    expect(await assignmentOf(h, l.id)).toBeNull();
    // a record merged into the person that the marked source sent again counts for the person
    const survivor = await isaLead(h, agent);
    await fromSource(survivor.id, other);
    const dup = await isaLead(h, agent);
    await fromSource(dup.id, other);
    expect((await sends(referral, dup.phone)).contactId).toBe(dup.id);
    await h.su.query(`SET session_replication_role = replica; UPDATE contacts SET merged_into_contact_id = '${survivor.id}' WHERE id = '${dup.id}'; SET session_replication_role = origin`);
    expect(await definerSays(agent, 'agent', survivor.id)).toBe(true);
    expect((await startCare(agent, survivor.id)).code).toBe('AI_ISA_SOURCE_NO_AI_CARE');
    // a person no marked source sent still starts, and the definer says no
    const ok = await isaLead(h, agent);
    await fromSource(ok.id, other);
    expect(await definerSays(agent, 'agent', ok.id)).toBe(false);
    expect((await startCare(agent, ok.id)).status).toBe(200);
  });

  it('B18S-1 E723: care running when the marked source sends the person again (a recent touch: no new period) pauses source_no_ai_care at once, says so, and cannot be resumed; the database refuses the resume too', async () => {
    const agent = w.agents[0]!;
    const l = await isaLead(h, agent);
    await fromSource(l.id, other);
    expect((await startCare(agent, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    const before = await h.su.query<{ s: string }>('SELECT ownership_period_seq AS s FROM contacts WHERE id = $1', [l.id]);
    expect((await sends(referral, l.phone)).contactId).toBe(l.id);
    expect((await h.su.query<{ s: string }>('SELECT ownership_period_seq AS s FROM contacts WHERE id = $1', [l.id])).rows[0]!.s).toBe(before.rows[0]!.s);
    await runIsa(h, w.tenantId);
    const a = (await assignmentOf(h, l.id))!;
    expect(a).toMatchObject({ ended_at: null, pause_reason: 'source_no_ai_care' });
    const p = await panel(agent, l.id);
    expect(p.body.canResume).toBe(false);
    expect(p.body.chain.find((x) => x.link === 11)).toMatchObject({ effect: 'pause', code: 'AI_ISA_SOURCE_NO_AI_CARE' });
    const resume = await call(agent, 'POST', `/contacts/${l.id}/ai-isa/resume`, {});
    expect([resume.status, resume.code]).toEqual([409, 'AI_ISA_SOURCE_NO_AI_CARE']);
    await expect(withTenantTx(actorOf(agent, 'agent'), (tx) => sql`UPDATE ai_isa_assignments SET paused_at = NULL, paused_by_kind = NULL, paused_by_user_id = NULL, pause_reason = NULL, epoch = epoch + 1
      WHERE tenant_id = app.tenant_id() AND id = ${a.id}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/AI_ISA_SOURCE_NO_AI_CARE/);
  });

  it('B18S-1 E723: a re-inquiry from the marked source that pauses care REINQUIRY cannot be continued: the panel offers no Continue and says why, Continue is refused AI_ISA_SOURCE_NO_AI_CARE and nothing ends', async () => {
    const agent = w.agents[0]!;
    const l = await isaLead(h, agent);
    await fromSource(l.id, other);
    expect((await startCare(agent, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    const a0 = (await assignmentOf(h, l.id))!;
    // the last touch is old, so the source's inquiry starts a same-owner new period (REINQUIRY_SLA, R-OWN-20)
    await h.su.query(`SET session_replication_role = replica`);
    try {
      await h.su.query(`UPDATE contacts SET owned_at = owned_at - interval '8 days', last_human_touch_at = last_human_touch_at - interval '8 days' WHERE id = $1`, [l.id]);
    } finally {
      await h.su.query(`SET session_replication_role = origin`);
    }
    expect(await sends(referral, l.phone)).toMatchObject({ contactId: l.id, outcome: 'reinquiry' });
    await h.su.query(`INSERT INTO jobs (tenant_id, queue, kind, payload, run_at) VALUES ($1, 'realtime', 'ai_isa.turn', $2::jsonb, now())`,
      [w.tenantId, JSON.stringify({ assignmentId: a0.id, trigger: 'sweep', epoch: a0.epoch })]);
    await runIsa(h, w.tenantId);
    expect(await assignmentOf(h, l.id)).toMatchObject({ id: a0.id, pause_reason: 'reinquiry', ended_at: null });
    // the panel offers no start while care is paused (startRefusal is for a person with no live care): link 11 says why
    const p = await panel(agent, l.id);
    expect(p.body.chain.find((x) => x.link === 11)).toMatchObject({ effect: 'pause', code: 'AI_ISA_SOURCE_NO_AI_CARE' });
    // b18 review item 3: the panel does not offer Continue: it says why instead (canContinue false, the refusal's sentence)
    expect(p.body.canContinue).toBe(false);
    expect(p.body.continueRefusal).toMatchObject({ code: 'AI_ISA_SOURCE_NO_AI_CARE' });
    expect(p.body.continueRefusal!.sentence).toMatch(/No automated contact for leads from this source/);
    const c = await call(agent, 'POST', `/contacts/${l.id}/ai-isa/continue`, {});
    expect([c.status, c.code]).toEqual([409, 'AI_ISA_SOURCE_NO_AI_CARE']);
    expect(await assignmentOf(h, l.id)).toMatchObject({ id: a0.id, pause_reason: 'reinquiry', ended_at: null });
    expect((await h.su.query('SELECT 1 FROM ai_isa_assignments WHERE contact_id = $1', [l.id])).rows).toHaveLength(1);
  });

  it('B18S-1 E723: turning the setting on pauses running care of a person whose only link to the source is an attached inquiry', async () => {
    const agent = w.agents[0]!;
    const l = await isaLead(h, agent);
    await fromSource(l.id, other);
    expect((await startCare(agent, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await sends(later, l.phone)).contactId).toBe(l.id); // the setting is still off for it: care goes on
    await runIsa(h, w.tenantId);
    expect((await assignmentOf(h, l.id))!.paused_at).toBeNull();
    const on = await setNoAiCare(w.owner, true, later.id);
    expect(on.body.pausing).toBeGreaterThanOrEqual(1);
    await runIsa(h, w.tenantId);
    expect(await assignmentOf(h, l.id)).toMatchObject({ ended_at: null, pause_reason: 'source_no_ai_care' });
    await setNoAiCare(w.owner, false, later.id);
  });

  it('E727 (b18 round 3 item 4): turning the setting on counts only this source\'s live AI care; in a mixed set, another marked source\'s care still waiting to pause is not counted, and a person from no marked source keeps their care', async () => {
    const made = async (name: string) => (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name, kind: 'portal' })).body.source.id;
    const hillside = await made('Hillside Referrals (test)');
    const router = await made('LeadRouter (test)');
    const cared = async (src: string | null) => {
      const l = await isaLead(h, w.agents[0]!);
      if (src) await fromSource(l.id, src);
      expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
      return l;
    };
    const a = await cared(hillside);
    const b = await cared(router);
    const plain = await cared(null);
    await runIsa(h, w.tenantId);
    for (const l of [a, b, plain]) expect((await assignmentOf(h, l.id))!.paused_at).toBeNull();
    try {
      // no job runs between the two taps: the first source's care is still live when the second is turned on
      const first = await setNoAiCare(w.owner, true, hillside);
      expect([first.status, first.body.pausing]).toEqual([200, 1]);
      expect((await assignmentOf(h, a.id))!.paused_at).toBeNull();
      const second = await setNoAiCare(w.owner, true, router);
      expect([second.status, second.body.pausing]).toEqual([200, 1]);
      await runIsa(h, w.tenantId);
      for (const l of [a, b]) expect(await assignmentOf(h, l.id)).toMatchObject({ pause_reason: 'source_no_ai_care', ended_at: null });
      expect((await assignmentOf(h, plain.id))!.paused_at).toBeNull();
    } finally {
      await setNoAiCare(w.owner, false, hillside);
      await setNoAiCare(w.owner, false, router);
    }
  });
});
