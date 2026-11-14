// Forcing the firing order of contacts' RI action triggers for lead_inquiries and lead_email_messages (batch 14
// round 2; erase_trigger_order_0089.test.ts and portal_retracted_by_fk.test.ts F6). Fixtures only, as the superuser,
// inside a transaction the caller always rolls back.
//
// A foreign key's action triggers on the referenced table are named RI_ConstraintTrigger_a_<oid> and fire in name
// order, compared as TEXT. Re-creating ONE foreign key and trusting "a newer oid sorts after the older one" holds only
// while the new oid has as many digits as the one it is compared with: in a long-lived cluster whose oid counter has
// gained a digit since the test template was built, the new trigger's name sorts FIRST ('1000000' < '999999'), and the
// test's precondition fails (lane 46 saw expect(r.order) fail in its cluster). forceRiOrder re-creates BOTH foreign
// keys in the wanted sequence, so both get new oids from the same counter, of the same width unless a power of ten
// falls between the two; it re-reads the order and repeats, a bounded number of times (each round takes fresh oids, so a
// crossing between the two can fall in one round only).
import type pg from 'pg';

export type RiTable = 'lead_inquiries' | 'lead_email_messages';

/** Each table's foreign key to contacts, exactly as the migrations define it (0001; 0040 for lead_email_messages). */
const CONTACT_FK: Readonly<Record<RiTable, { name: string; add: string }>> = {
  lead_inquiries: {
    name: 'lead_inquiries_tenant_id_contact_id_fkey',
    add: 'FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE',
  },
  lead_email_messages: {
    name: 'lead_email_messages_tenant_id_contact_id_fkey',
    add: 'FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id)',
  },
};

/** Drops and re-adds one table's contact foreign key: its action triggers on contacts get new oids, so new names. */
export async function recreateContactFk(c: pg.PoolClient, table: RiTable): Promise<void> {
  const fk = CONTACT_FK[table];
  await c.query(`ALTER TABLE ${table} DROP CONSTRAINT ${fk.name}`);
  await c.query(`ALTER TABLE ${table} ADD CONSTRAINT ${fk.name} ${fk.add}`);
}

/** The two tables in the order contacts' ON DELETE action triggers fire (trigger name order). */
export async function riOrder(c: pg.PoolClient): Promise<string[]> {
  const r = await c.query<{ t: string }>(`SELECT cr.relname AS t FROM pg_trigger tg JOIN pg_constraint con ON con.oid = tg.tgconstraint JOIN pg_class cr ON cr.oid = con.conrelid
    WHERE tg.tgrelid = 'public.contacts'::regclass AND tg.tgisinternal AND cr.relname IN ('lead_inquiries','lead_email_messages')
      AND tg.tgname LIKE 'RI_ConstraintTrigger_a_%' AND (tg.tgtype & 8) <> 0
    ORDER BY tg.tgname COLLATE "C"`);
  return r.rows.map((x) => x.t);
}

/**
 * Forces the firing order to `want` (first, then second): re-creates both contact foreign keys in that sequence and
 * re-reads the order, up to `tries` rounds. Returns the order read and the rounds taken; throws if it never holds, so a
 * test never asserts an outcome under an order it did not get. `read` is for the helper's own test only.
 */
export async function forceRiOrder(
  c: pg.PoolClient,
  want: readonly [RiTable, RiTable],
  o: { tries?: number; read?: (c: pg.PoolClient) => Promise<string[]> } = {},
): Promise<{ order: string[]; rounds: number }> {
  const tries = o.tries ?? 4;
  const read = o.read ?? riOrder;
  let got: string[] = [];
  for (let round = 1; round <= tries; round++) {
    await recreateContactFk(c, want[0]);
    await recreateContactFk(c, want[1]);
    got = await read(c);
    if (got.length === 2 && got[0] === want[0] && got[1] === want[1]) return { order: got, rounds: round };
  }
  throw new Error(`forceRiOrder: could not force ${want.join(' before ')} in ${tries} rounds (last read: ${got.join(', ')})`);
}

/**
 * Simulates a test template built just below the 100000 oid crossing in a cluster whose counter has since passed it:
 * both tables' contact action triggers get five-digit names (their natural order kept), so any trigger created now,
 * with a six- or seven-digit oid, sorts before them. The names are only names; nothing else about the triggers changes.
 */
export async function simulateShortOidTemplate(c: pg.PoolClient): Promise<void> {
  const r = await c.query<{ tgname: string; t: string }>(`SELECT tg.tgname, cr.relname AS t FROM pg_trigger tg JOIN pg_constraint con ON con.oid = tg.tgconstraint JOIN pg_class cr ON cr.oid = con.conrelid
    WHERE tg.tgrelid = 'public.contacts'::regclass AND tg.tgisinternal AND cr.relname IN ('lead_inquiries','lead_email_messages') AND tg.tgname LIKE 'RI_ConstraintTrigger_a_%'
    ORDER BY CASE cr.relname WHEN 'lead_inquiries' THEN 0 ELSE 1 END, tg.tgname COLLATE "C"`);
  let n = 99_990;
  for (const t of r.rows) await c.query(`ALTER TRIGGER "${t.tgname}" ON contacts RENAME TO "RI_ConstraintTrigger_a_${n++}"`);
}
