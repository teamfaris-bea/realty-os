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
// This file reproduces the failure deterministically by re-creating the lead_inquiries foreign key (a newer, larger
// oid sorts after lead_email_messages'), inside a transaction rolled back after each case.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, intakeLead, suFixture, suRows, uuid, type World } from './world.js';

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

/** contacts' RI action triggers for the two tables, in firing (name) order. */
async function order(c: pg.PoolClient): Promise<string[]> {
  const r = await c.query<{ t: string }>(`SELECT cr.relname AS t FROM pg_trigger tg JOIN pg_constraint con ON con.oid = tg.tgconstraint JOIN pg_class cr ON cr.oid = con.conrelid
    WHERE tg.tgrelid = 'public.contacts'::regclass AND tg.tgisinternal AND cr.relname IN ('lead_inquiries','lead_email_messages') AND tg.tgname LIKE 'RI_ConstraintTrigger_a_%'
    ORDER BY tg.tgname`);
  return [...new Set(r.rows.map((x) => x.t))];
}

/** Runs the purge in one transaction that is always rolled back; `before` may change the schema inside it. */
async function purgeInRolledBackTx(contactId: string, before: (c: pg.PoolClient) => Promise<void> = async () => {}): Promise<{ order: string[]; error: string | null }> {
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await before(c);
    const o = await order(c);
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

const recreateInquiryFk = async (c: pg.PoolClient) => {
  await c.query('ALTER TABLE lead_inquiries DROP CONSTRAINT lead_inquiries_tenant_id_contact_id_fkey');
  await c.query('ALTER TABLE lead_inquiries ADD CONSTRAINT lead_inquiries_tenant_id_contact_id_fkey FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE');
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
    const r = await purgeInRolledBackTx(contactId);
    expect(r.order).toEqual(['lead_inquiries', 'lead_email_messages']);
    expect(r.error).toBeNull();
  });

  it('F6: the lane\'s failure reproduced: when lead_email_messages\' SET NULL sorts first the purge fails on the inquiry FK re-check, with or without portal_items_retracted_by_fk', async () => {
    const contactId = await leadFromEmail();
    const flipped = await purgeInRolledBackTx(contactId, recreateInquiryFk);
    expect(flipped.order).toEqual(['lead_email_messages', 'lead_inquiries']);
    expect(flipped.error).toMatch(/lead_email_messages.*violates foreign key constraint "lead_email_messages_tenant_id_inquiry_id_fkey"/);
    // the portal FK plays no part: dropped, the failure is the same
    const noPortalFk = await purgeInRolledBackTx(contactId, async (c) => {
      await c.query('ALTER TABLE portal_items DROP CONSTRAINT portal_items_retracted_by_fk');
      await recreateInquiryFk(c);
    });
    expect(noPortalFk.error).toMatch(/lead_email_messages_tenant_id_inquiry_id_fkey/);
    // and the row versions matter: without the purge's own earlier UPDATE of the email row (sender domain set NULL
    // first), the SET NULL is not re-checked and the flipped order passes
    await suFixture(h.su, `UPDATE lead_email_messages SET sender_domain = NULL, dkim_pass_domains = '{}' WHERE contact_id = $1`, [contactId]);
    expect((await purgeInRolledBackTx(contactId, recreateInquiryFk)).error).toBeNull();
  });

  it('F6: trigger names sort as text, so an oid with one more digit sorts first (the power-of-ten crossing that flipped the lane\'s template)', async () => {
    const [r] = await suRows<{ flipped: boolean }>(h.su, `SELECT 'RI_ConstraintTrigger_a_100004' < 'RI_ConstraintTrigger_a_99998' COLLATE "C" AS flipped`);
    expect(r!.flipped).toBe(true);
  });
});
