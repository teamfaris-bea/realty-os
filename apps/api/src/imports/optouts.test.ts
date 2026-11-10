// api/imports: imported opt-outs are in force from the contacts commit (outbound-2; R-CONSENT-3, E40:
// "a STOP in FUB stays a STOP here"). The consent stage is the last one (seq 6), so before this the
// revocations of a FUB STOP or a CSV "Opted Out" column only took effect after every other stage was
// committed and verified; with the consent-basis check gone, the contact was textable in between.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CommsWorld, commsWorld, freshReauth, sendText } from '../comms/testing.js';
import type { TestClient } from '../auth/testHarness.js';
import { type BatchView, type ImportsHarness, approve, batchOf, call, commitStage, csvBase64, dryRunStage, fubFixture, importsHarness, mapAgents, records, stageOf, verify } from './testing.js';

let ih: ImportsHarness;
let w: CommsWorld;
let admin: TestClient;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
  w = await commsWorld(ih.h, { agents: 2, others: ['admin'] });
  admin = w.others[0] as TestClient;
  await freshReauth(ih.h, admin);
});
afterAll(async () => {
  await ih?.close();
});

async function commitContacts(b: BatchView): Promise<void> {
  const d = await dryRunStage(ih, admin, b.id, 'contacts');
  for (const r of (await records(admin, b.id, 'contacts')).filter((x) => x.dryRunOutcome === 'needs_review')) await call(admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'import' });
  expect((await approve(admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
  await commitStage(ih, admin, b.id, 'contacts');
  expect((await verify(admin, b.id, 'contacts')).res.status).toBe(200);
}

const contactWithPhone = async (e164: string) =>
  (await q<{ id: string }>("SELECT c.id FROM contacts c JOIN contact_points p ON p.tenant_id = c.tenant_id AND p.contact_id = c.id WHERE c.tenant_id = $1 AND p.address = $2 AND c.deleted_at IS NULL", [w.tenantId, e164]))[0]!;

describe('outbound-2: imported opt-outs take effect when the contacts stage commits', () => {
  it('R-CONSENT-3 E40: a CSV "Opted Out" row cannot be texted between the contacts commit and the consent commit', async () => {
    const csv = 'First Name,Last Name,Mobile Phone,Opted Out\nOlive,Out,(415) 301-7777,yes\nPaula,Plain,(415) 301-7778,\n';
    const r = await call<{ batch: BatchView }>(admin, 'POST', '/imports', { source: 'csv', fileName: 'optout.csv', fileBase64: csvBase64(csv) });
    expect(r.status).toBe(201);
    expect((await call(admin, 'POST', `/imports/${r.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = await batchOf(admin, r.body.batch.id);
    await commitContacts(b);
    expect(stageOf(await batchOf(admin, b.id), 'consent').status).toBe('pending');

    const olive = await contactWithPhone('+14153017777');
    const states = await q<{ channel: string; status: string }>(
      "SELECT DISTINCT cs.channel, cs.status FROM consent_state cs JOIN contact_points p ON p.tenant_id = cs.tenant_id AND p.address_hmac = cs.address_hmac WHERE p.contact_id = $1 ORDER BY cs.channel",
      [olive.id],
    );
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) expect(s.status).toBe('revoked');
    const sent = ih.h.providers.telephony.sms.length;
    const s = await sendText(w.owner, olive.id, 'Hi Olive, checking in about homes in your area');
    expect(s.status).toBe(200);
    expect(s.body.result).not.toBe('sent');
    expect(s.body.decision?.outcome).toBe('deny');
    expect(s.body.decision?.reasons).toContain('CONSENT_REVOKED');
    expect(ih.h.providers.telephony.sms.length).toBe(sent);

    // a row without an opt-out is untouched (the contacts stage writes no grant: grants stay history in the consent stage)
    const paula = await contactWithPhone('+14153017778');
    expect(await q('SELECT 1 FROM consent_events WHERE contact_id = $1', [paula.id])).toHaveLength(0);
    expect((await sendText(w.owner, paula.id, 'Hi Paula')).body.result).toBe('sent');

    // the later consent stage does not write the revocation twice, and has nothing left that blocks a skip
    const d = await dryRunStage(ih, admin, b.id, 'consent');
    expect(d.status).toBe('dry_run_ready');
    expect((await call(admin, 'POST', `/imports/${b.id}/stages/consent/skip`)).status).toBe(200);

    // reverting the contacts stage keeps the revocation in force (R-CONSENT-3: opt-outs stay)
    expect((await call(admin, 'POST', `/imports/${b.id}/revert`, { category: 'contacts' })).status).toBe(202);
    await ih.drain();
    // (both contacts were messaged since the import, so they are TOUCHED and stay for a human decision)
    const rev = stageOf(await batchOf(admin, b.id), 'contacts').revert as { keptReasons: Record<string, number> };
    expect(rev.keptReasons.REVOCATION_KEPT).toBeGreaterThan(0);
    const after = await q<{ status: string }>("SELECT DISTINCT cs.status FROM consent_state cs JOIN consent_events e ON e.tenant_id = cs.tenant_id AND e.address_hmac = cs.address_hmac WHERE e.contact_id = $1", [olive.id]);
    expect(after).toEqual([{ status: 'revoked' }]);
  });

  it('R-CONSENT-3 E40: a FUB STOP (opted-out phone) and a DNC tag are in force while the ownership…consent stages are still pending', async () => {
    const key = 'key-optout-0001';
    ih.fub.add(key, fubFixture({ prefix: 7100, phoneSeed: 7 }));
    const cr = await call<{ batch: BatchView }>(admin, 'POST', '/imports', { source: 'fub_api', apiKey: key });
    expect(cr.status).toBe(201);
    expect((await call(admin, 'POST', `/imports/${cr.body.batch.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const b = await batchOf(admin, cr.body.batch.id);
    await mapAgents(admin, b.id, { ...w, admin }, [{ sourceRef: '99', target: { kind: 'unassigned' } }, { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } }]);
    await commitContacts(b);
    const nb = await batchOf(admin, b.id);
    expect(nb.stages.filter((s) => s.category !== 'contacts').map((s) => s.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);

    const bob = (await q<{ id: string }>("SELECT id FROM contacts WHERE tenant_id = $1 AND display_name = 'Bob Unsub'", [w.tenantId]))[0]!;
    const carla = (await q<{ id: string }>("SELECT id FROM contacts WHERE tenant_id = $1 AND display_name = 'Carla Dnc'", [w.tenantId]))[0]!;
    const sent = ih.h.providers.telephony.sms.length;
    for (const c of [bob, carla]) {
      const s = await sendText(w.owner, c.id, 'Hi, quick question about your home search');
      expect(s.status).toBe(200);
      expect(s.body.decision?.outcome).toBe('deny');
    }
    expect(ih.h.providers.telephony.sms.length).toBe(sent);
    expect(await q("SELECT reason, channel FROM suppressions WHERE tenant_id = $1 AND reason = 'import_dnc'", [w.tenantId])).toEqual([{ reason: 'import_dnc', channel: 'all' }]);
    // no grant was written by the contacts stage
    expect(await q("SELECT 1 FROM consent_events WHERE tenant_id = $1 AND event_type = 'grant'", [w.tenantId])).toHaveLength(0);
  });
});
