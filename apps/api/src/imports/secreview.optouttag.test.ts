// secreview: a FUB opt-out tag carrying an invisible / control / width variant character is shown as the
// tag "DNC" (catalog normalization strips it) but is NOT converted into an opt-out (consent mapper matches the raw text).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CommsWorld, commsWorld, freshReauth, sendText } from '../comms/testing.js';
import type { TestClient } from '../auth/testHarness.js';
import { type BatchView, type ImportsHarness, approve, batchOf, call, commitStage, dryRunStage, importsHarness, records } from './testing.js';

let ih: ImportsHarness;
let w: CommsWorld;
let admin: TestClient;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
  w = await commsWorld(ih.h, { agents: 1, others: ['admin'] });
  admin = w.others[0] as TestClient;
  await freshReauth(ih.h, admin);
}, 180_000);
afterAll(async () => {
  await ih?.close();
});

const VARIANTS: [string, string][] = [
  ['control', 'DNC'],
  ['zwsp', 'D​NC'],
  ['lrm', 'DNC‎'],
  ['bell', 'DNC\u0007'],
  ['fullwidth', 'ＤＮＣ'],
];

describe('secreview: opt-out tag conversion vs tag normalization', () => {
  it('R-PAR-46 R-CONSENT-3: a tag that lands in the catalog as "DNC" also blocks the person', async () => {
    const people = VARIANTS.map(([name, tag], i) => ({
      id: 93000 + i, created: '2023-01-01T00:00:00Z', firstName: 'Tag', lastName: `Variant${name}`, stage: 'Lead',
      tags: [tag], phones: [{ value: `(415) 309-${String(1000 + i)}`, type: 'mobile', status: 'Valid', isPrimary: 1 }],
    }));
    const key = 'key-secreview-tag-1';
    ih.fub.add(key, { users: [], people, notes: [], textMessages: [], emails: [], calls: [], recordings: {} } as never);
    const cr = await call<{ batch: BatchView }>(admin, 'POST', '/imports', { source: 'fub_api', apiKey: key });
    expect(cr.status).toBe(201);
    expect((await call(admin, 'POST', `/imports/${cr.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = await batchOf(admin, cr.body.batch.id);
    const d = await dryRunStage(ih, admin, b.id, 'contacts');
    for (const r of (await records(admin, b.id, 'contacts')).filter((x) => x.dryRunOutcome === 'needs_review')) await call(admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'import' });
    expect((await approve(admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    await commitStage(ih, admin, b.id, 'contacts');

    const out: Record<string, unknown> = {};
    for (const [name] of VARIANTS) {
      const c = (await q<{ id: string; tags: string[] }>(
        `SELECT c.id, ARRAY(SELECT t.name FROM contact_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id WHERE ct.contact_id = c.id) AS tags
           FROM contacts c WHERE c.tenant_id = $1 AND c.last_name = $2`, [w.tenantId, `Variant${name}`]))[0]!;
      const s = await sendText(w.owner, c.id, 'Hi, checking in');
      out[name] = { tags: c.tags, result: s.body.result ?? s.status };
    }
    // the tag shows as plain "DNC" in the catalog, so the person must be treated as do-not-contact
    const shown = Object.fromEntries(VARIANTS.map(([n]) => [n, (out[n] as { tags: string[] }).tags.includes('DNC')]));
    expect(shown).toEqual(Object.fromEntries(VARIANTS.map(([n]) => [n, true])));
    const results = Object.fromEntries(VARIANTS.map(([n]) => [n, (out[n] as { result: unknown }).result]));
    expect(results.control).not.toBe('sent');
    expect(results).toEqual(Object.fromEntries(VARIANTS.map(([n]) => [n, results.control])));
  });
});
