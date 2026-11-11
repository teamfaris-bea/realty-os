// The Undo of an address delete is a server-side restore of the deleted row (module 57; PARITY_PLAN §5: an Undo toast
// instead of a confirm modal). Before, the web's Undo re-POSTed the address through the add schema (AddressBody: lines
// at most 200, city 120, region 60), which refused an address an import had stored (CSV and FUB keep lines up to 500,
// city 200, region 100): the delete had succeeded, so the address was lost. It also came back with a new id and
// without its jurisdiction or import batch. Now the delete answers a restore token sealing the row, and the restore
// puts exactly that row back for the same user and person within 10 minutes. A real CSV import through the real server
// and worker, real Postgres as app_user, fake providers.
import { randomUUID } from 'node:crypto';
import type { Instant } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows } from '../admin/testing.js';
import { randomPhone } from '../leads/testing.js';
import { type BatchView, type ImportWorld, type ImportsHarness, approve, batchOf, call, commitStage, csvBase64, dryRunStage, importWorld, importsHarness, verify } from '../imports/testing.js';
import { RESTORE_WINDOW_MS, sealAddressRestore } from './addressRestore.js';
import type * as repo from './repos/people.js';

let ih: ImportsHarness;
let w: ImportWorld;
const su = <T>(text: string, args: unknown[] = []) => ih.h.su.query(text, args).then((r) => r.rows as T[]);

beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
}, 180_000);
afterAll(async () => {
  await ih?.close();
});

async function importCsv(text: string): Promise<BatchView> {
  const r = await call<{ batch: BatchView }>(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'addresses.csv', fileBase64: csvBase64(text) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect((await call(w.admin, 'POST', `/imports/${r.body.batch.id}/snapshot`)).status).toBe(202);
  await ih.drain();
  const b = await batchOf(w.admin, r.body.batch.id);
  const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
  expect((await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
  await commitStage(ih, w.admin, b.id, 'contacts');
  expect((await verify(w.admin, b.id, 'contacts')).res.status).toBe(200);
  return b;
}

type Row = Record<string, unknown>;
/** Every stored column of an address but updated_at (a restore is a change). */
const rowOf = async (id: string): Promise<Row | null> =>
  (await su<Row>('SELECT id, tenant_id, contact_id, kind, line1, line2, city, region, postal_code, country, jurisdiction, import_batch_id, created_at, search_line1 FROM contact_addresses WHERE id = $1', [id]))[0] ?? null;

async function agentAddress(): Promise<{ contactId: string; addressId: string; token: string }> {
  const agent = w.agents[0]!;
  const c = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Una', lastName: 'Do', phones: [randomPhone()] });
  const a = await call<{ address: { id: string } }>(agent, 'POST', `/contacts/${c.body.contact.id}/addresses`, { kind: 'home', line1: '9 Birch Rd', city: 'Reno', region: 'NV', postalCode: '89501' });
  const del = await call<{ ok: true; restoreToken: string }>(agent, 'DELETE', `/contacts/${c.body.contact.id}/addresses/${a.body.address.id}`);
  expect(del.status).toBe(200);
  return { contactId: c.body.contact.id, addressId: a.body.address.id, token: del.body.restoreToken };
}

describe('module 57: Undo of an address delete restores the deleted row', () => {
  it('module 57: an imported address with a 300-character line (over the add schema’s 200), a jurisdiction and its import batch is removed and put back by the Undo verbatim: the same id and every column, audited as a restore; the old re-add is refused for it, and a second Undo adds nothing', async () => {
    const street = `${'1200 Old Mill Pond Road Building Seven '.repeat(8)}Suite 4`.slice(0, 300);
    expect(street.length).toBe(300);
    const b = await importCsv(`First Name,Last Name,Mobile Phone,Email,Address,City,State,Zip\nIma,Long,(415) 301-0901,ima.long@example.com,${street},Oakland,CA,94610\n`);
    const [addr] = await su<{ id: string; contact_id: string; import_batch_id: string; line1: string }>('SELECT id, contact_id, import_batch_id, line1 FROM contact_addresses WHERE import_batch_id = $1', [b.id]);
    expect(addr).toMatchObject({ import_batch_id: b.id, line1: street });
    // no application path writes a jurisdiction (seeds do): set as a fixture, it is the column an Undo must not lose
    await su("UPDATE contact_addresses SET jurisdiction = 'US-CA' WHERE id = $1", [addr!.id]);
    const before = await rowOf(addr!.id);

    const del = await call<{ ok: true; restoreToken: string }>(w.admin, 'DELETE', `/contacts/${addr!.contact_id}/addresses/${addr!.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, restoreToken: expect.stringMatching(/^[A-Za-z0-9_-]{100,}$/) });
    expect(del.body.restoreToken).not.toContain('Mill'); // sealed, not just encoded
    expect(await rowOf(addr!.id)).toBeNull();
    // the finding: the add schema refuses this address (the old Undo), so the address would be lost
    const readd = await call(w.admin, 'POST', `/contacts/${addr!.contact_id}/addresses`, { kind: 'home', line1: street, city: 'Oakland', region: 'CA', postalCode: '94610', country: 'US' });
    expect([readd.status, readd.code]).toEqual([422, 'VALIDATION_FAILED']);

    const undo = await call<{ address: { id: string; line1: string } }>(w.admin, 'POST', `/contacts/${addr!.contact_id}/addresses/${addr!.id}/restore`, { restoreToken: del.body.restoreToken });
    expect(undo.status, JSON.stringify(undo.body)).toBe(201);
    expect(undo.body.address).toMatchObject({ id: addr!.id, line1: street });
    expect(await rowOf(addr!.id)).toEqual(before);
    const restores = (await auditRows(ih.h, w.tenantId, 'contact.update')).filter((a) => a.entity_id === addr!.contact_id && JSON.stringify(a.changes).includes(addr!.id));
    expect(restores.map((a) => a.changes)).toEqual([
      { address_action: { changed: true }, address_id: { from: addr!.id, to: null }, kind: { from: 'home', to: null } },
      { address_action: { changed: true }, address_id: { from: null, to: addr!.id }, kind: { from: null, to: 'home' } },
    ]);
    expect(JSON.stringify(restores)).not.toContain('Mill');
    // an Undo sent again puts nothing back twice and audits nothing more
    const again = await call(w.admin, 'POST', `/contacts/${addr!.contact_id}/addresses/${addr!.id}/restore`, { restoreToken: del.body.restoreToken });
    expect(again.status).toBe(201);
    expect((await su('SELECT 1 FROM contact_addresses WHERE contact_id = $1', [addr!.contact_id])).length).toBe(1);
    expect((await auditRows(ih.h, w.tenantId, 'contact.update')).filter((a) => a.entity_id === addr!.contact_id && JSON.stringify(a.changes).includes(addr!.id))).toHaveLength(2);
  });

  it('R-PERM-5: a restore token is honored only for its address, person and user and only within the window: altered, for another address or person, from another editor, malformed, or after 10 minutes, it puts nothing back (404, or ADDRESS_RESTORE_EXPIRED)', async () => {
    const agent = w.agents[0]!;
    const t = await agentAddress();
    const other = await agentAddress();
    const restore = (c = agent, contactId = t.contactId, addressId = t.addressId, token = t.token) => call(c, 'POST', `/contacts/${contactId}/addresses/${addressId}/restore`, { restoreToken: token });
    const flipped = `${t.token.slice(0, 40)}${t.token[40] === 'A' ? 'B' : 'A'}${t.token.slice(41)}`;
    expect((await restore(agent, t.contactId, t.addressId, flipped)).status).toBe(404);
    expect((await restore(agent, t.contactId, other.addressId)).status).toBe(404); // sealed to its own address id
    expect((await restore(agent, other.contactId)).status).toBe(404); // and to its own person
    expect((await restore(agent, t.contactId, t.addressId, other.token)).status).toBe(404);
    expect((await restore(w.owner)).status).toBe(404); // an Owner may edit the person, but the Undo is the remover's
    expect((await restore(agent, t.contactId, t.addressId, `${'!'.repeat(20)}`)).status).toBe(404);
    expect((await restore(agent, t.contactId, t.addressId, 'short')).code).toBe('VALIDATION_FAILED');
    // past the window: a token sealed by the same key as if the delete had happened 10 minutes and a second ago
    const late = await withTenantTx(agent.actor(), (tx) =>
      sealAddressRestore(ih.h.app.platform.envelope, tx, agent.actor(), t.contactId, { id: t.addressId, kind: 'home', line1: '9 Birch Rd', line2: null, city: 'Reno', region: 'NV', postal_code: '89501', country: 'US', jurisdiction: null, import_batch_id: null, created_at: new Date() } satisfies repo.AddressFullRow, (Date.now() - RESTORE_WINDOW_MS - 1000) as Instant),
      { db: ih.h.database });
    const expired = await restore(agent, t.contactId, t.addressId, late);
    expect([expired.status, expired.code]).toEqual([409, 'ADDRESS_RESTORE_EXPIRED']);
    expect(await rowOf(t.addressId)).toBeNull();
    // the real token still works for the agent who removed it
    expect((await restore()).status).toBe(201);
    expect(await rowOf(t.addressId)).toMatchObject({ id: t.addressId, line1: '9 Birch Rd', contact_id: t.contactId });
  });
});
