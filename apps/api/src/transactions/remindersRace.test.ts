// A deterministic concurrent test for the reminder pass (R-TXN-4, R-OWN-24; ownership-data/F3). Two real Postgres
// sessions as app_user under RLS: B, an Owner's engine merge of L into S held open after it ran (both contact locks
// held, deal_contacts already re-pointed to S by the merge trigger, nothing committed), and A, the system's
// remindersInTx, which reads the deal's recipients (still L) and then waits on L's contact lock. The superuser pool
// only watches pg_locks for A's ungranted advisory lock and reads state back. No sleeps decide the order: B commits
// only once A is seen waiting. Fakes only (the harness's fake providers); every person here is synthetic.
import { randomUUID } from 'node:crypto';
import type { ContactId, UserActor } from '@realty/core/foundation';
import { applyOwnershipCommandInTx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { ownedContact } from '../comms/testing.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { systemActor } from '../worker/systemActor.js';
import { remindersInTx } from './reconcile.js';
import { type TxnWorld, approveUpdates, confirmDueSoon, dateRow, deal, enterDate, localDay, runsOfDate, txnWorld } from './testing.js';

let h: ApiHarness;
let w: TxnWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await txnWorld(h);
  expect((await approveUpdates(w.owner)).versionId).toBeDefined(); // the built-in step: buyer, seller, co_buyer, co_seller
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** A buy deal whose only buyer is L, a duplicate S of the same person (not on the deal), and a confirmed date whose reminder is due. */
async function world(firstName: string): Promise<{ dealId: string; loser: string; survivor: string; dateId: string }> {
  const d = await deal(h, w, w.agents[0]!, { side: 'buy', firstName });
  const s = await ownedContact(w.agents[0]!, { consent: false, firstName });
  const e = await enterDate(w.agents[0]!, d.dealId, 'closing', localDay(w.zone, 20));
  expect(e.status).toBe(201);
  expect((await confirmDueSoon(w.tc, e.body.date.id, w.zone)).status).toBe(200);
  expect((await dateRow(h, e.body.date.id)).reminder_at).not.toBeNull();
  const roles = (await h.su.query<{ contact_id: string; role: string }>('SELECT contact_id, role FROM deal_contacts WHERE deal_id = $1', [d.dealId])).rows;
  expect(roles).toEqual([{ contact_id: d.contactId, role: 'buyer' }]);
  return { dealId: d.dealId, loser: d.contactId, survivor: s.id, dateId: e.body.date.id };
}

/** Transaction A: the system's reminder pass, called directly; reports its backend pid before it starts. */
function reminderPass(onPid: (pid: number) => void) {
  const deps = depsFromPlatform(h.app.platform);
  return withTenantTx(
    systemActor(w.tenantId, 'worker'),
    async (tx, now) => {
      onPid((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0]!.pid);
      return remindersInTx(tx, deps, now);
    },
    { db: h.database, retries: 0 },
  );
}

/** Polls pg_locks (superuser) until `pid()` waits on an ungranted advisory lock; fails after 10 s. */
async function waitForAdvisoryWait(pid: () => number | null): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const p = pid();
    if (p !== null) {
      const r = await h.su.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [p]);
      if (r.rowCount! > 0) return;
    }
    if (Date.now() > deadline) throw new Error(`the reminder pass (pid ${p}) never waited on a contact lock within 10 s`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('R-TXN-4 R-OWN-24: the reminder pass and a concurrent merge', () => {
  it('R-TXN-4 R-OWN-24 E556: a merge that commits while the reminder pass waits on the contact lock: the survivor gets the update, the loser none', async () => {
    const x = await world('Quinn');
    const owner: UserActor = w.owner.actor();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let merged!: () => void;
    const mergedSignal = new Promise<void>((r) => (merged = r));
    // B: the Owner's merge through the ownership engine, held open after it ran
    const b = withTenantTx(
      owner,
      async (tx) => {
        const r = await applyOwnershipCommandInTx(tx, owner, x.survivor as ContactId, { kind: 'merge', survivorId: x.survivor as ContactId, loserId: x.loser as ContactId, ownerChoice: null }, { commandId: randomUUID() });
        if (!r.outcome.ok) throw new Error(`merge: ${r.outcome.code}`);
        // inside B the merge trigger already moved the buyer role to S (0059); nothing is committed yet
        const inB = (await sql<{ contact_id: string }>`SELECT contact_id FROM deal_contacts WHERE deal_id = ${x.dealId}::uuid`.execute(tx)).rows.map((y) => y.contact_id);
        expect(inB).toEqual([x.survivor]);
        merged();
        await held;
      },
      { db: h.database, retries: 0 },
    );
    b.catch(() => merged()); // a failed B must not leave the test waiting on the signal
    await mergedSignal;
    // outside B nothing has changed yet
    expect((await h.su.query('SELECT contact_id FROM deal_contacts WHERE deal_id = $1', [x.dealId])).rows).toEqual([{ contact_id: x.loser }]);
    // A: the reminder pass reads L as the recipient, then waits on L's lock (held by B)
    let pid: number | null = null;
    const a = reminderPass((p) => (pid = p));
    try {
      await waitForAdvisoryWait(() => pid);
    } finally {
      release();
    }
    await b;
    const result = await a;
    expect(result).toEqual({ reminders: 1, firings: 1 });
    const runs = await runsOfDate(h, x.dateId);
    expect(runs.map((r) => [r.contact_id, r.status])).toEqual([[x.survivor, 'scheduled']]);
    expect(runs.filter((r) => r.contact_id === x.loser)).toEqual([]);
    const basis = (await dateRow(h, x.dateId)).basis as { reminderPass?: { planned: number; reason: string | null }; mergedUpdates?: unknown };
    expect(basis.reminderPass).toMatchObject({ planned: 1, reason: null });
    // the pass itself planned it: mergeReplanInTx was not called and left no note
    expect(basis.mergedUpdates).toBeUndefined();
  });

  it('R-TXN-4: control: with no merge the same pass plans the update for L', async () => {
    const x = await world('Avery');
    const result = await reminderPass(() => undefined);
    expect(result).toEqual({ reminders: 1, firings: 1 });
    expect((await runsOfDate(h, x.dateId)).map((r) => [r.contact_id, r.status])).toEqual([[x.loser, 'scheduled']]);
    const basis = (await dateRow(h, x.dateId)).basis as { reminderPass?: { planned: number }; mergedUpdates?: unknown };
    expect(basis.reminderPass).toMatchObject({ planned: 1 });
    expect(basis.mergedUpdates).toBeUndefined();
  });
});
