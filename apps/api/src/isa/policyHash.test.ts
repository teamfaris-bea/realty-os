// Approval recomputes the content hash (R-ISA-40; E1013; review fix F10). The approval row names a content hash and the
// Owner's accepted text names the same hash; before this fix the server trusted the stored `content_sha256` and never
// checked it against the stored content, so a draft whose content was changed without its hash (by SQL: a draft is not
// frozen) was approved under a hash, and a text, that named other content.
// Real Postgres via the API harness; fakes only. The superuser pool writes the one thing no route can: the bad row.
import { DEFAULT_AI_ISA_CONTENT } from '@realty/core/isa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { commsWorld, type CommsWorld } from '../comms/testing.js';
import { call, freshReauth } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

interface Draft { versionId: string; versionNo: number; contentSha256: string; content: Record<string, unknown>; effect: string | null; effectSentence: string; approvalText: string | null; issues: { code: string; field: string | null; sentence: string }[] }
interface View { state: string; draft: Draft | null; can: { approve: boolean } }
const D = DEFAULT_AI_ISA_CONTENT as unknown as Record<string, unknown>;
const WIDER = { ...D, capabilities: ['converse', 'share_listings', 'book_appointments'] };
const view = async () => (await call<View>(w.owner, 'GET', '/admin/ai-isa/policy')).body;
const rows = async () => (await h.su.query<{ status: string; approvals: number }>(`SELECT v.status, (SELECT count(*)::int FROM playbook_approvals a WHERE a.playbook_version_id = v.id) AS approvals
  FROM playbook_versions v JOIN playbooks p ON p.id = v.playbook_id WHERE v.tenant_id = $1 AND p.kind = 'ai_isa' ORDER BY v.version_no`, [w.tenantId])).rows;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  await freshReauth(h, w.owner);
  expect((await call(w.owner, 'POST', '/admin/ai-isa/policy', {})).status).toBe(201);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-ISA-40 the hash an approval names is the stored content\'s (E1013)', () => {
  it('a draft whose stored content is not the content of its stored hash is not approved: 409, in words, no approval row', async () => {
    const before = (await view()).draft!;
    expect(before).toMatchObject({ versionNo: 1, effect: 'first', issues: [] });
    // the content changes under the hash: what the Owner read and the hash their text names are now different things
    await h.su.query(`UPDATE playbook_versions SET steps = $2::jsonb WHERE id = $1`, [before.versionId, JSON.stringify(WIDER)]);
    await freshReauth(h, w.owner);
    const r = await call(w.owner, 'POST', '/admin/ai-isa/policy/approve', { versionId: before.versionId, contentSha256: before.contentSha256, attestation: before.approvalText });
    expect(r).toMatchObject({ status: 409, code: 'AI_ISA_POLICY_HASH_STALE' });
    expect(await rows()).toEqual([{ status: 'draft', approvals: 0 }]);
  });

  it('the page says so before any tap: the draft has a reason, no text to accept, and no Approve', async () => {
    const v = await view();
    expect(v.can.approve).toBe(false);
    expect(v.draft).toMatchObject({ effect: null, approvalText: null });
    expect(v.draft!.issues).toEqual([{ code: 'HASH_STALE', field: null, sentence: 'This draft’s saved content does not match its fingerprint, so it cannot be approved. Save the draft again, then approve it.' }]);
    expect(v.draft!.effectSentence).toBe('This draft cannot be approved until the marked values are fixed.');
  });

  it('saving the draft again writes content and hash together, and the approval then names that hash', async () => {
    await freshReauth(h, w.owner);
    const saved = await call<View>(w.owner, 'PUT', '/admin/ai-isa/policy/draft', { content: WIDER });
    const d = saved.body.draft!;
    expect(d).toMatchObject({ issues: [], effect: 'first' });
    const ok = await call<{ effect: string }>(w.owner, 'POST', '/admin/ai-isa/policy/approve', { versionId: d.versionId, contentSha256: d.contentSha256, attestation: d.approvalText });
    expect(ok).toMatchObject({ status: 200, body: { effect: 'first' } });
    const row = (await h.su.query<{ v: string; a: string }>(`SELECT v.content_sha256 AS v, a.content_sha256 AS a FROM playbook_versions v JOIN playbook_approvals a ON a.playbook_version_id = v.id WHERE v.id = $1`, [d.versionId])).rows;
    expect(row).toEqual([{ v: d.contentSha256, a: d.contentSha256 }]);
  });
});
