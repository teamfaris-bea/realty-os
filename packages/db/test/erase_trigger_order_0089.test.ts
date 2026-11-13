// Batch 14 to-do (privacy-critical): contact erasure never depends on the order of the RI triggers.
//
// The cause (portal_retracted_by_fk.test.ts, F6): app.purge_contact_internal first UPDATEs the person's lead emails
// (0041: sender and DKIM domains), then deletes the contact. lead_email_messages has two ON DELETE SET NULL foreign
// keys, to the contact and to the inquiry (which the contact's delete cascades away). PostgreSQL re-checks every foreign
// key of a row an RI action updates when the old row version is this transaction's own, and the contact's RI actions
// fire in trigger-name order (RI_ConstraintTrigger_a_<oid>, compared as text). When the email's SET NULL (contact_id)
// sorts before the inquiries' cascade, the inquiry key is re-checked after the inquiry is gone and the erase fails with
// "violates foreign key constraint lead_email_messages_tenant_id_inquiry_id_fkey". An oid power-of-ten crossing or a
// migration that re-creates either foreign key flips that order, in a test template or in production.
//
// 0089 unlinks the person's lead emails (contact_id and inquiry_id) explicitly, in the purge, before any record is
// deleted, so neither SET NULL action finds a row to update and the outcome no longer depends on the order. These tests
// force each order by re-creating a foreign key (a newer oid sorts after the older one) inside a transaction that is
// always rolled back.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
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

/** A lead the lead-email intake created: the contact, its inquiry and the email row linked to both, as the webhook writes it. */
async function leadFromEmail(): Promise<{ contactId: string; inquiryId: string; emailId: string }> {
  const { contactId } = await intakeLead(h.app, w);
  const [inq] = await suRows<{ id: string }>(h.su, 'SELECT id FROM lead_inquiries WHERE contact_id = $1', [contactId]);
  const emailId = uuid();
  await withTenantTx(w.system('provider'), (tx) => sql`
    INSERT INTO lead_email_messages (tenant_id, id, connection_id, lead_source_id, message_key_sha256, provider_format, received_at, status, parser_kind,
                                     sender_domain, dkim_pass_domains, contact_id, inquiry_id)
    VALUES (app.tenant_id(), ${emailId}, ${connectionId}, ${w.leadSourceId}, ${randomBytes(32)}, 'generic', clock_timestamp(), 'lead_created', 'zillow',
            'leads.example.test', ARRAY['leads.example.test'], ${contactId}, ${inq!.id})`.execute(tx), { db: h.app });
  return { contactId, inquiryId: inq!.id, emailId };
}

/** contacts' RI action triggers for the two tables, in firing (name) order. */
async function order(c: pg.PoolClient): Promise<string[]> {
  const r = await c.query<{ t: string }>(`SELECT cr.relname AS t FROM pg_trigger tg JOIN pg_constraint con ON con.oid = tg.tgconstraint JOIN pg_class cr ON cr.oid = con.conrelid
    WHERE tg.tgrelid = 'public.contacts'::regclass AND tg.tgisinternal AND cr.relname IN ('lead_inquiries','lead_email_messages') AND tg.tgname LIKE 'RI_ConstraintTrigger_a_%'
    ORDER BY tg.tgname`);
  return [...new Set(r.rows.map((x) => x.t))];
}

interface Outcome {
  order: string[];
  error: string | null;
  contacts: number;
  inquiries: number;
  email: { status: string; contact_id: string | null; inquiry_id: string | null; sender_domain: string | null; dkim_pass_domains: string[] } | undefined;
}

/** Runs the purge in one transaction that is always rolled back; `before` may change the schema inside it. */
async function purgeInRolledBackTx(ids: { contactId: string; inquiryId: string; emailId: string }, before: (c: pg.PoolClient) => Promise<void>): Promise<Outcome> {
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await before(c);
    const o = await order(c);
    let error: string | null = null;
    await c.query('SAVEPOINT purge');
    try {
      await c.query('SELECT app.purge_contact_internal($1, $2)', [w.tenantId, ids.contactId]);
    } catch (e) {
      error = (e as Error).message;
      await c.query('ROLLBACK TO SAVEPOINT purge');
    }
    const n = async (q: string, v: unknown[]) => Number((await c.query<{ n: string }>(q, v)).rows[0]!.n);
    return {
      order: o,
      error,
      contacts: await n('SELECT count(*) AS n FROM contacts WHERE id = $1', [ids.contactId]),
      inquiries: await n('SELECT count(*) AS n FROM lead_inquiries WHERE id = $1', [ids.inquiryId]),
      email: (await c.query('SELECT status, contact_id, inquiry_id, sender_domain, dkim_pass_domains FROM lead_email_messages WHERE id = $1', [ids.emailId])).rows[0],
    };
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/** Re-creates lead_inquiries' contact FK: its new trigger sorts after lead_email_messages' (the order that failed). */
const inquiriesLast = async (c: pg.PoolClient) => {
  await c.query('ALTER TABLE lead_inquiries DROP CONSTRAINT lead_inquiries_tenant_id_contact_id_fkey');
  await c.query('ALTER TABLE lead_inquiries ADD CONSTRAINT lead_inquiries_tenant_id_contact_id_fkey FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE');
};
/** Re-creates lead_email_messages' contact FK: its new trigger sorts after lead_inquiries' (the order that worked). */
const emailsLast = async (c: pg.PoolClient) => {
  await c.query('ALTER TABLE lead_email_messages DROP CONSTRAINT lead_email_messages_tenant_id_contact_id_fkey');
  await c.query('ALTER TABLE lead_email_messages ADD CONSTRAINT lead_email_messages_tenant_id_contact_id_fkey FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id)');
};

/** The purge succeeded: the person and their inquiry are gone; the email stays as the tombstone of its message key,
 *  unlinked and without the person's domains. */
const ERASED = {
  error: null,
  contacts: 0,
  inquiries: 0,
  email: { status: 'lead_created', contact_id: null, inquiry_id: null, sender_domain: null, dkim_pass_domains: [] },
};

describe('b14: contact erasure does not depend on RI trigger-name order (0089)', () => {
  it('erase cascade: when lead_email_messages\' SET NULL fires before the lead_inquiries cascade, the purge still erases the person and unlinks the email', async () => {
    const ids = await leadFromEmail();
    const r = await purgeInRolledBackTx(ids, inquiriesLast);
    expect(r.order).toEqual(['lead_email_messages', 'lead_inquiries']);
    const { order: _o, ...outcome } = r;
    expect(outcome).toEqual(ERASED);
  });

  it('erase cascade: in the other order (the lead_inquiries cascade first) the outcome is the same', async () => {
    const ids = await leadFromEmail();
    const r = await purgeInRolledBackTx(ids, emailsLast);
    expect(r.order).toEqual(['lead_inquiries', 'lead_email_messages']);
    const { order: _o, ...outcome } = r;
    expect(outcome).toEqual(ERASED);
  });

  it('erase cascade: an email that reached the person only through their inquiry is unlinked and loses the domains too, in the failing order', async () => {
    const ids = await leadFromEmail();
    // the contact link alone gone (as a merge's ON DELETE SET NULL of a merged record would leave it), the inquiry kept
    await withTenantTx(w.system('provider'), (tx) => sql`UPDATE lead_email_messages SET contact_id = NULL WHERE id = ${ids.emailId}`.execute(tx), { db: h.app });
    const r = await purgeInRolledBackTx(ids, inquiriesLast);
    const { order: _o, ...outcome } = r;
    expect(outcome).toEqual(ERASED);
  });
});
