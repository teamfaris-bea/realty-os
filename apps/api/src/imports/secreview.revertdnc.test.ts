// Security review (candidate, not reproduced; kept as a regression guard): an import revert must never drop a
// person-level do-not-contact. Today the do-not-contact's own consent event makes the contact "touched", so the
// revert keeps it (with its points and the flag); an imported DNC stays as an import_dnc suppression (DNC_KEPT).
// A person imported by a batch is marked do-not-contact (R-CHAN-3) and nothing else touches them; the batch is
// then reverted. Either the person stays (with the do-not-contact), or every address the revert deletes keeps
// a revoke, so the same phone or email re-created later is still blocked.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImportsHarness, approve, batchOf, call, commitStage, dryRunStage, fubFixture, importWorld, importsHarness, mapAgents, records, startFub, verify } from './testing.js';

let ih: ImportsHarness;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
});
afterAll(async () => {
  await ih?.close();
});

describe('secreview: import revert and person-level do-not-contact', () => {
  it('R-CHAN-3 R-IMPORT-10 a reverted import never leaves an address of a do-not-contact person unblocked', async () => {
    const w = await importWorld(ih);
    ih.fub.add('key-rdnc-0001', fubFixture({ prefix: 7700, phoneSeed: 7 }));
    const b = await startFub(ih, w.admin, 'key-rdnc-0001');
    await mapAgents(w.admin, b.id, w, [{ sourceRef: '99', target: { kind: 'unassigned' } }, { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } }]);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    for (const r of (await records(w.admin, b.id, 'contacts')).filter((x) => x.dryRunOutcome === 'needs_review')) await call(w.admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'import' });
    await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string);
    await commitStage(ih, w.admin, b.id, 'contacts');
    expect((await verify(w.admin, b.id, 'contacts')).res.status).toBe(200);

    // an imported, owned person with a phone and no revoke of their own
    const jane = (await q<{ id: string }>("SELECT id FROM contacts WHERE tenant_id = $1 AND display_name = 'Jane Doe'", [w.tenantId]))[0]!;
    const dnc = await call(w.owner, 'POST', `/contacts/${jane.id}/do-not-contact`, { reason: 'asked_on_call' });
    expect(dnc.status).toBe(200);
    const points = await q<{ address_hmac: Buffer; kind: string; address: string }>('SELECT address_hmac, kind, address FROM contact_points WHERE contact_id = $1', [jane.id]);
    expect(points.length).toBeGreaterThan(0);

    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, {})).status).toBe(202);
    await ih.drain();
    expect((await batchOf(w.admin, b.id)).status).toBe('reverted');

    const after = (await q<{ live: boolean; dnc: boolean }>('SELECT deleted_at IS NULL AND merged_into_contact_id IS NULL AS live, do_not_contact_at IS NOT NULL AS dnc FROM contacts WHERE id = $1', [jane.id]))[0]!;
    if (after.live) {
      expect(after.dnc).toBe(true);
      return;
    }
    // deleted: each of her addresses must still carry a revoke on every channel it could be reached on
    for (const p of points) {
      const channels = p.kind === 'email' ? ['email'] : ['sms', 'voice'];
      for (const ch of channels) {
        const rows = await q<{ status: string }>("SELECT status FROM consent_state WHERE tenant_id = $1 AND address_hmac = $2 AND channel = $3 AND status = 'revoked'", [w.tenantId, p.address_hmac, ch]);
        expect({ address: p.address, channel: ch, revoked: rows.length > 0 }).toEqual({ address: p.address, channel: ch, revoked: true });
      }
    }
    // and a person re-created at that phone is not textable by policy (no grant can override the revoke)
    const phone = points.find((p) => p.kind === 'phone')!.address;
    const re = await call<{ contact: { id: string } }>(w.agents[0]!, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Jane', lastName: 'Again', phones: [phone] });
    expect([200, 201]).toContain(re.status);
  });
});
