// Batch 14 audit F6: why an immediate portal_items_retracted_by_fk seemed to break contact erasure, and why it did not.
//
// The lane saw app.purge_contact_internal fail "insert or update on table lead_email_messages violates foreign key
// constraint lead_email_messages_tenant_id_inquiry_id_fkey" (apps/api/src/leadEmail/erasure.test.ts,
// admin/erasure.race.test.ts) and made the FK DEFERRABLE INITIALLY DEFERRED. The FK was never involved:
//   * lead_email_messages has two ON DELETE SET NULL foreign keys, to the contact and to the inquiry, and
//     purge_contact_internal first UPDATEs the person's lead_email_messages rows (0041: sender and DKIM domains), so
//     their xmin is the erasing transaction. PostgreSQL re-checks EVERY foreign key of a row updated by an RI action when
//     the old row version was written by the same transaction (ri_triggers.c RI_FKey_fk_upd_check_required).
//   * Deleting the contact queues its RI actions in trigger NAME order, and RI_ConstraintTrigger_a_<oid> names sort as
//     text. Normally the lead_inquiries cascade (0001, lower oid) runs first, its SET NULL (inquiry_id) follows before
//     any re-check sees the row, and all is well. If lead_email_messages' SET NULL (contact_id) sorts first, the
//     re-check of the inquiry foreign key it queues runs after the inquiry is deleted but before inquiry_id is nulled,
//     and the purge fails with exactly the lane's error.
//   * Trigger oids come from the cluster-wide oid counter. A template build that crosses a power of ten (here, a fresh
//     cloud container's counter passing 100000 between 0001 and 0040) gives the later trigger a name with one more digit
//     that sorts first. The lane's container rebuilt its test template at that crossing with the immediate FK, then
//     again above it with the deferred one: the deferral only rode along with the rebuild. In this checkout the
//     immediate FK passes both erasure tests (it is immediate again, as its sibling published_by_user_id).
// This file forces that order inside a transaction rolled back after each case, and asserts it before the outcome.
// Batch 14 round 2: it re-creates BOTH contact foreign keys in the wanted sequence and re-reads the order
// (riOrderFixture.ts forceRiOrder), since re-creating one and trusting "a newer, larger oid sorts later" fails once the
// cluster's oid counter has more digits than the template's triggers (lane 46). Since batch 14's 0089 the purge unlinks
// the person's lead emails itself before deleting anything, so that order erases the person too.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
import { forceRiOrder, riOrder, simulateShortOidTemplate } from './riOrderFixture.js';
import { createHarness, createWorld, type Harness, intakeLead, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let connectionId = '';

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 1 });
  connectionId = uuid();
  await withTenantTx(w.system('provider'), async (tx) => {
    await sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id) VALUES (app.tenant_id(), ${connectionId}, 'lead_email', 'Lead email: Website', ${w.leadSourceId})`.execute(tx);
    await sql`UPDATE integration_connections SET status = 'connected', connected_at = clock_timestamp() WHERE tenant_id = app.tenant_id() AND id = ${connectionId} AND status = 'not_configured'`.execute(tx);
  }, { db: h.app });
}, 120_000);
afterAll(async () => {
  await h?.close();
});

/** A lead the lead-email intake created: the contact, its inquiry, and the email row linked to both, as the webhook writes it. */
async function leadFromEmail(): Promise<string> {
  const { contactId } = await intakeLead(h.app, w);
  const [inq] = await suRows<{ id: string }>(h.su, 'SELECT id FROM lead_inquiries WHERE contact_id = $1', [contactId]);
  await withTenantTx(w.system('provider'), (tx) => sql`
    INSERT INTO lead_email_messages (tenant_id, id, connection_id, lead_source_id, message_key_sha256, provider_format, received_at, status, parser_kind,
                                     sender_domain, dkim_pass_domains, contact_id, inquiry_id)
    VALUES (app.tenant_id(), ${uuid()}, ${connectionId}, ${w.leadSourceId}, ${randomBytes(32)}, 'generic', clock_timestamp(), 'lead_created', 'zillow',
            'leads.example.test', ARRAY['leads.example.test'], ${contactId}, ${inq!.id})`.execute(tx), { db: h.app });
  return contactId;
}

/** Runs the purge in one transaction that is always rolled back; `before` may change the schema inside it. */
async function purgeInRolledBackTx(contactId: string, before: (c: pg.PoolClient) => Promise<void> = async () => {}): Promise<{ order: string[]; error: string | null }> {
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await before(c);
    const o = await riOrder(c);
    try {
      await c.query('SELECT app.purge_contact_internal($1, $2)', [w.tenantId, contactId]);
      return { order: o, error: null };
    } catch (e) {
      return { order: o, error: (e as Error).message };
    }
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/** lead_email_messages' SET NULL first (the lane's failing order before 0089). */
const emailsFirst = async (c: pg.PoolClient) => {
  await forceRiOrder(c, ['lead_email_messages', 'lead_inquiries']);
};

describe('b14 F6: the erase cascade and portal_items_retracted_by_fk', () => {
  it('F6: portal_items_retracted_by_fk is an ordinary immediate FK, like its sibling published_by_user_id', async () => {
    const rows = await suRows<{ conname: string; condeferrable: boolean; def: string }>(h.su, `SELECT conname, condeferrable, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public.portal_items'::regclass AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%REFERENCES memberships%' ORDER BY conname`);
    expect(rows.map((r) => [r.def.replace(/\s+/g, ' '), r.condeferrable])).toEqual(
      expect.arrayContaining([['FOREIGN KEY (tenant_id, retracted_by_user_id) REFERENCES memberships(tenant_id, user_id)', false]]),
    );
    expect(rows.every((r) => !r.condeferrable)).toBe(true);
  });

  it('F6: in the normal trigger order the purge of a lead with a linked lead email succeeds, with the immediate FK in place', async () => {
    const contactId = await leadFromEmail();
    // the normal order is forced too: a template built across a power-of-ten crossing has the other one (lane 46)
    const r = await purgeInRolledBackTx(contactId, (c) => forceRiOrder(c, ['lead_inquiries', 'lead_email_messages']).then(() => undefined));
    expect(r.order).toEqual(['lead_inquiries', 'lead_email_messages']);
    expect(r.error).toBeNull();
  });

  // Before 0089 this order failed with the lane's exact error ("lead_email_messages ... violates foreign key constraint
  // lead_email_messages_tenant_id_inquiry_id_fkey"), with or without the portal FK, and only because of the purge's own
  // earlier UPDATE of the email row. 0089 unlinks the person's lead emails inside the purge before any record is
  // deleted, so the order no longer matters (erase_trigger_order_0089.test.ts holds the full proof: both orders and the
  // end state).
  it.each([
    ['as built', async () => {}],
    ['a template built before a power-of-ten oid crossing (simulated)', simulateShortOidTemplate],
  ] as [string, (c: pg.PoolClient) => Promise<void>][])('F6: the lane\'s failing order (lead_email_messages\' SET NULL first) now erases the person, with or without portal_items_retracted_by_fk (0089), %s', async (_name, cluster) => {
    const contactId = await leadFromEmail();
    const flipped = await purgeInRolledBackTx(contactId, async (c) => { await cluster(c); await emailsFirst(c); });
    expect(flipped.order).toEqual(['lead_email_messages', 'lead_inquiries']);
    expect(flipped.error).toBeNull();
    // the portal FK plays no part: dropped, the outcome is the same
    const noPortalFk = await purgeInRolledBackTx(contactId, async (c) => {
      await c.query('ALTER TABLE portal_items DROP CONSTRAINT portal_items_retracted_by_fk');
      await cluster(c);
      await emailsFirst(c);
    });
    expect(noPortalFk.order).toEqual(['lead_email_messages', 'lead_inquiries']);
    expect(noPortalFk.error).toBeNull();
  });

  it('F6: trigger names sort as text, so an oid with one more digit sorts first (the power-of-ten crossing that flipped the lane\'s template)', async () => {
    const [r] = await suRows<{ flipped: boolean }>(h.su, `SELECT 'RI_ConstraintTrigger_a_100004' < 'RI_ConstraintTrigger_a_99998' COLLATE "C" AS flipped`);
    expect(r!.flipped).toBe(true);
  });
});
