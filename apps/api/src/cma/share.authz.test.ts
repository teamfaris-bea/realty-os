// Authorization of the V2-A share routes, role × route against core can() (R-PERM-5, R-CMA-6, R-CMA-9; DATA_MODEL §8
// "Share a CMA, preview it, download its report (cma.share)": ✅ | ✅ | T | O | — | — | —; creator only for share and
// preview, owner question g). A denial is 404, never 403. Cross-tenant ids are 404 on every route (R-TEN-1, R-TEN-3).
import { type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type ShareWorld, call, emailSeller, localSales, oneTap, shareFrom, sharePreview, shareWorld, withPlatformCmaCleared } from './testing.js';

let h: ApiHarness;
let w: ShareWorld;
let other: ShareWorld;

beforeAll(async () => {
  h = await createApiHarness();
  [w, other] = await Promise.all([shareWorld(h), shareWorld(h)]);
  await Promise.all([localSales(w, 8), localSales(other, 8)]);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const point = async (contactId: string) => (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email'", [contactId])).rows[0].id as string;

describe('R-PERM-5 R-CMA-6 R-CMA-9 role × route against can()', () => {
  it('E611 owner question g: cma.share as can() says, and the preview and share are the creator\'s only: an Owner, Admin or Team Lead who may open the agent\'s draft gets 404; ISA and TC never', async () => {
    const s = await emailSeller(w, w.agents[0]!);
    const d = await oneTap(w.agents[0]!, s.c);
    expect(d.status).toBe(201);
    const id = d.body.cma.id;
    const body = { recipientContactId: s.c, toPointId: await point(s.c), contentSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64) };
    const roles: { name: string; role: Role; client: TestClient; facts: Record<string, boolean>; creator: boolean }[] = [
      { name: 'owner', role: 'owner', client: w.owner, facts: {}, creator: false },
      { name: 'admin', role: 'admin', client: w.admin, facts: {}, creator: false },
      { name: 'team lead', role: 'team_lead', client: w.teamLead, facts: { team: true }, creator: false },
      { name: 'agent (creator)', role: 'agent', client: w.agents[0]!, facts: { own: true }, creator: true },
      { name: 'agent (not theirs)', role: 'agent', client: w.agents[1]!, facts: {}, creator: false },
      { name: 'isa', role: 'isa', client: w.isa, facts: {}, creator: false },
      { name: 'tc', role: 'tc', client: w.tc, facts: {}, creator: false },
    ];
    for (const r of roles) {
      const allowed = can(r.client.actor(), 'cma.share', { tenantId: r.client.actor().tenantId, ...r.facts }).ok;
      expect([r.name, allowed]).toEqual([r.name, ['owner', 'admin', 'team_lead', 'agent'].includes(r.role) && (r.role !== 'agent' || r.creator)]);
      const p = await sharePreview(r.client, id);
      // a role cma.share admits reads the view (GET /cma/:id), but only the creator previews or shares
      expect([r.name, p.status]).toEqual([r.name, r.creator ? 200 : 404]);
      const x = await call(r.client, 'POST', `/cma/${id}/share`, body);
      expect([r.name, x.status === 404]).toEqual([r.name, !r.creator]);
      if (allowed && !r.creator) expect([r.name, (await call(r.client, 'GET', `/cma/${id}`)).status]).toEqual([r.name, 200]); // E611 (a): read-only
    }
    expect((await h.su.query('SELECT status FROM cma_reports WHERE id = $1', [id])).rows[0].status).toBe('draft');
  });
});

describe('R-TEN-1 R-TEN-3: another tenant', () => {
  it('another tenant\'s CMA, contact and point ids are 404 on preview and share; nothing changes', async () => {
    const theirs = await emailSeller(other, other.agents[0]!);
    const tc = await oneTap(other.agents[0]!, theirs.c);
    const mine = await emailSeller(w, w.agents[0]!);
    const md = await oneTap(w.agents[0]!, mine.c);
    await withPlatformCmaCleared(h, async () => {
      expect((await sharePreview(w.agents[0]!, tc.body.cma.id)).status).toBe(404);
      expect((await sharePreview(w.owner, tc.body.cma.id)).status).toBe(404);
      expect((await sharePreview(w.agents[0]!, md.body.cma.id, { recipientContactId: theirs.c })).status).toBe(404);
      const pv = (await sharePreview(w.agents[0]!, md.body.cma.id)).body.preview;
      expect((await shareFrom(w.agents[0]!, pv, { recipientContactId: theirs.c, toPointId: await point(theirs.c) })).status).toBe(404);
      const r = await shareFrom(w.agents[0]!, pv, { toPointId: await point(theirs.c) });
      expect([r.status, (r.body as unknown as { error: { code: string } }).error.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await call(w.owner, 'POST', `/cma/${tc.body.cma.id}/share`, { recipientContactId: theirs.c, toPointId: await point(theirs.c), contentSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64) })).status).toBe(404);
    });
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = ANY ($1::uuid[])', [[theirs.c, mine.c]])).rows[0].n).toBe(0);
  });

  it('R-TEN-3: the share body is strict: no tenant id, no message, no status', async () => {
    const s = await emailSeller(w, w.agents[0]!);
    const d = await oneTap(w.agents[0]!, s.c);
    const base = { recipientContactId: s.c, toPointId: await point(s.c), contentSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64) };
    for (const extra of [{ tenantId: s.c }, { body: 'x' }, { status: 'shared' }, { subject: 'x' }]) {
      expect((await call(w.agents[0]!, 'POST', `/cma/${d.body.cma.id}/share`, { ...base, ...extra })).status).toBe(422);
    }
  });
});
