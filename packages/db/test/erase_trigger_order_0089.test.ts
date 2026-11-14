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
// force each order inside a transaction that is always rolled back, and assert the order before the outcome.
// Batch 14 round 2: the order is forced by re-creating BOTH foreign keys in the wanted sequence and re-reading it
// (riOrderFixture.ts forceRiOrder), never by re-creating one and trusting that a newer oid sorts later: names compare as
// text, so in a long-lived cluster whose oid counter gained a digit since the template was built the new trigger sorts
// first (lane 46). Each case also runs on a simulated template built below the 100000 crossing.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
import { forceRiOrder, recreateContactFk, riOrder, simulateShortOidTemplate, simulatedRiName } from './riOrderFixture.js';
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
    const o = await riOrder(c);
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

/** lead_email_messages' SET NULL fires before the lead_inquiries cascade (the order that failed before 0089). */
const emailsFirst = async (c: pg.PoolClient) => {
  await forceRiOrder(c, ['lead_email_messages', 'lead_inquiries']);
};
/** The lead_inquiries cascade fires first (the order that worked). */
const inquiriesFirst = async (c: pg.PoolClient) => {
  await forceRiOrder(c, ['lead_inquiries', 'lead_email_messages']);
};

/** The purge succeeded: the person and their inquiry are gone; the email stays as the tombstone of its message key,
 *  unlinked and without the person's domains. */
const ERASED = {
  error: null,
  contacts: 0,
  inquiries: 0,
  email: { status: 'lead_created', contact_id: null, inquiry_id: null, sender_domain: null, dkim_pass_domains: [] },
};

/** The cluster the test database lives in: as built here, or a template built below the 100000 oid crossing (simulated). */
const CLUSTERS: [string, (c: pg.PoolClient) => Promise<void>][] = [
  ['as built', async () => {}],
  ['a template built before a power-of-ten oid crossing (simulated)', simulateShortOidTemplate],
];

describe.each(CLUSTERS)('b14: contact erasure does not depend on RI trigger-name order (0089), %s', (_name, cluster) => {
  it('erase cascade: when lead_email_messages\' SET NULL fires before the lead_inquiries cascade, the purge still erases the person and unlinks the email', async () => {
    const ids = await leadFromEmail();
    const r = await purgeInRolledBackTx(ids, async (c) => { await cluster(c); await emailsFirst(c); });
    expect(r.order).toEqual(['lead_email_messages', 'lead_inquiries']);
    const { order: _o, ...outcome } = r;
    expect(outcome).toEqual(ERASED);
  });

  it('erase cascade: in the other order (the lead_inquiries cascade first) the outcome is the same', async () => {
    const ids = await leadFromEmail();
    const r = await purgeInRolledBackTx(ids, async (c) => { await cluster(c); await inquiriesFirst(c); });
    expect(r.order).toEqual(['lead_inquiries', 'lead_email_messages']);
    const { order: _o, ...outcome } = r;
    expect(outcome).toEqual(ERASED);
  });

  it('erase cascade: an email that reached the person only through their inquiry is unlinked and loses the domains too, in the failing order', async () => {
    const ids = await leadFromEmail();
    // the contact link alone gone (as a merge's ON DELETE SET NULL of a merged record would leave it), the inquiry kept
    await withTenantTx(w.system('provider'), (tx) => sql`UPDATE lead_email_messages SET contact_id = NULL WHERE id = ${ids.emailId}`.execute(tx), { db: h.app });
    const r = await purgeInRolledBackTx(ids, async (c) => { await cluster(c); await emailsFirst(c); });
    expect(r.order).toEqual(['lead_email_messages', 'lead_inquiries']);
    const { order: _o, ...outcome } = r;
    expect(outcome).toEqual(ERASED);
  });
});

describe('b14 round 2: forcing the RI order is robust to the oid width (riOrderFixture.ts)', () => {
  it('b15 (b14 low i): the simulated template names sort after the name of a trigger with ANY oid (compared as text, as triggers fire), so every trigger created now sorts before them', () => {
    const oids = ['1', '16384', '99989', '99999', '100000', '9999', '99991', '9999123', '99999999', '999999999', '1000000000', '4294967295'];
    for (let i = 0; i < 4; i++) {
      const name = simulatedRiName(i);
      expect(oids.filter((o) => !(`RI_ConstraintTrigger_a_${o}` < name)), name).toEqual([]);
    }
  });

  async function inRolledBackTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await h.su.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('lane 46: re-creating ONE foreign key gets the wrong order once the template\'s triggers have fewer digits than a new oid; forceRiOrder gets the wanted order in both directions', async () => {
    for (const [one, want] of [
      ['lead_inquiries', ['lead_email_messages', 'lead_inquiries']],
      ['lead_email_messages', ['lead_inquiries', 'lead_email_messages']],
    ] as const) {
      const r = await inRolledBackTx(async (c) => {
        await simulateShortOidTemplate(c);
        await recreateContactFk(c, one); // the old helper: "a newer oid sorts after the older one"
        const old = await riOrder(c);
        const forced = await forceRiOrder(c, want);
        return { old, forced, after: await riOrder(c) };
      });
      expect(r.old, one).toEqual([...want].reverse());
      expect(r.forced.order, one).toEqual([...want]);
      expect(r.after, one).toEqual([...want]);
    }
  });

  it('forceRiOrder re-reads and repeats when a round does not give the order (a crossing between the two), and throws after its last round rather than let a test assert under the wrong order', async () => {
    const want = ['lead_email_messages', 'lead_inquiries'] as const;
    const r = await inRolledBackTx(async (c) => {
      let reads = 0;
      const lyingOnce = async (cc: pg.PoolClient) => (++reads === 1 ? [...want].reverse() : riOrder(cc));
      return forceRiOrder(c, want, { read: lyingOnce });
    });
    expect(r).toEqual({ order: [...want], rounds: 2 });
    await expect(inRolledBackTx((c) => forceRiOrder(c, want, { tries: 3, read: async () => [...want].reverse() }))).rejects.toThrow(
      'forceRiOrder: could not force lead_email_messages before lead_inquiries in 3 rounds (last read: lead_inquiries, lead_email_messages)',
    );
  });
});
