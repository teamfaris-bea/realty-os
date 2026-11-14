// b18 item f (PHASE2_3_PLAN product boundaries, owner 2026-11-14): an Owner-only lead-source setting, "No AI care for
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
import { systemActor } from '../worker/systemActor.js';
import { type IsaWorld, assignmentOf, call, freshReauth, isaLead, isaWorld, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;
let admin: TestClient;
let source: string;
let other: string;

const actorOf = (c: TestClient, role: UserActor['role']): UserActor => ({ kind: 'user', userId: c.userId!, tenantId: w.tenantId, role, sessionId: 'b18-test' }) as UserActor;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
  admin = await inviteViaApi(h, w.owner, 'admin');
  source = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Referral source (test)', kind: 'portal' })).body.source.id;
  other = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Open house sign-in (test)', kind: 'portal' })).body.source.id;
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
  call<{ canStart: boolean; canResume: boolean; startRefusal: { code: string; sentence: string } | null; chain: { link: number; effect: string; code: string | null; sentence: string }[]; assignment: { pauseReason: string | null } | null }>(c, 'GET', `/contacts/${contactId}/ai-isa`);

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
    expect(on.body.source.noAiCareSentence).toMatch(/No AI care for leads from this source/);
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
      expect(p.body.startRefusal!.sentence).toMatch(/No AI care for leads from this source/);
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
    expect(note.body).toMatch(/No AI care for leads from this source/);
    const p = await panel(w.agents[0]!, l.id);
    expect(p.status, JSON.stringify(p.body).slice(0, 400)).toBe(200);
    expect(p.body.assignment!.pauseReason).toBe('source_no_ai_care');
    expect(p.body.canResume).toBe(false);
    const link = p.body.chain.find((x) => x.link === 11)!;
    expect(link).toMatchObject({ effect: 'pause', code: 'AI_ISA_SOURCE_NO_AI_CARE' });
    expect(link.sentence).toMatch(/No AI care for leads from this source/);
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
