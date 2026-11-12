// E142 over real Postgres (R-TXN-5, R-TXN-4, R-AST-6): a TC moves a deal date while a converted-to-draft update citing
// it waits. Approving returns DRAFT_STALE, and no re-tap sends it: not one with reviewedInboundSeq, not the resume of an
// approved but never-queued approval, and not when the move lands between the approval and the queue transaction.
//
// The seam: queueAndSend (assistant/drafts.ts) reads the approver's email signature between the approval transaction
// and the queue transaction. While `between` is set, that read first runs it: a deterministic place for "the move
// lands between the approval and the queue". Unset, it is the real read.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { reconcileAndRun } from '../nurture/testing.js';
import type * as SignatureRepo from '../templates/repos/signature.js';
import { type TxnWorld, approveUpdates, call, confirmDueSoon, dateRow, deal, enterDate, localDay, mailTo, reconcile, runsOfDate, txnWorld } from './testing.js';

const seam = vi.hoisted(() => ({ between: null as null | (() => Promise<void>) }));
vi.mock('../templates/repos/signature.js', async (importOriginal) => {
  const real = await importOriginal<typeof SignatureRepo>();
  return {
    ...real,
    senderSignature: async (...a: Parameters<typeof real.senderSignature>) => {
      const f = seam.between;
      seam.between = null;
      if (f) await f();
      return real.senderSignature(...a);
    },
  };
});

let h: ApiHarness;
let w: TxnWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await txnWorld(h);
  await approveUpdates(w.owner);
});
afterAll(async () => {
  await h?.close();
});

/** A contract-worded update (R-AST-3: always a draft) for the deal's buyer, waiting for the agent. */
async function waitingDraft(): Promise<{ dealId: string; dateId: string; actionId: string; email: string; contactId: string }> {
  const d = await deal(h, w, w.agents[0]!);
  const e = await enterDate(w.agents[0]!, d.dealId, 'custom', localDay(w.zone, 20), 'Contract amendment deadline');
  await confirmDueSoon(w.tc, e.body.date.id, w.zone);
  await reconcile(h, w.tenantId);
  await reconcileAndRun(h, w.tenantId);
  const run = (await runsOfDate(h, e.body.date.id))[0]!;
  expect(run.status).toBe('converted_to_draft');
  return { dealId: d.dealId, dateId: e.body.date.id, actionId: run.assistant_action_id!, email: d.email, contactId: d.contactId };
}

const approve = async (actionId: string, extra: Record<string, unknown> = {}) => {
  const r = await call<{ result?: string; error?: { details?: Record<string, unknown> } }>(w.agents[0]!, 'POST', `/assistant/actions/${actionId}/approve`, { commandId: randomUUID(), ...extra });
  return { ...r, details: r.body.error?.details ?? {} };
};
const actionStatus = async (id: string) => (await h.su.query<{ status: string }>('SELECT status FROM assistant_actions WHERE id = $1', [id])).rows[0]!.status;
const messagesOfAction = async (id: string) => (await h.su.query('SELECT id FROM messages WHERE assistant_action_id = $1', [id])).rowCount;

describe('E142 a draft citing a moved deal date is stale', () => {
  it('E142 R-TXN-5: the TC moves the date while the draft waits: approving returns DRAFT_STALE (the date moved), and a re-review re-tap never sends it', async () => {
    const x = await waitingDraft();
    expect((await call(w.tc, 'PATCH', `/deal-dates/${x.dateId}`, { dueOn: localDay(w.zone, 4) })).status).toBe(200);
    const r = await approve(x.actionId);
    expect([r.status, r.code]).toEqual([409, 'DRAFT_STALE']);
    expect(r.details).toMatchObject({ reason: 'DATE_MOVED', dealDateId: x.dateId, boundDueVersion: 2, currentDueVersion: 3 });
    const conv = await h.su.query<{ s: string }>('SELECT inbound_seq AS s FROM conversations WHERE contact_id = $1', [x.contactId]);
    const retap = await approve(x.actionId, { reviewedInboundSeq: Number(conv.rows[0]?.s ?? 0) });
    expect([retap.status, retap.code]).toEqual([409, 'DRAFT_STALE']);
    expect(await actionStatus(x.actionId)).toBe('proposed');
    expect(await messagesOfAction(x.actionId)).toBe(0);
    expect(mailTo(h, x.email)).toHaveLength(0);
  });

  it('E142: a completed date stales its draft too (DATE_NO_LONGER_DRIVES)', async () => {
    const x = await waitingDraft();
    expect((await call(w.tc, 'PATCH', `/deal-dates/${x.dateId}`, { completed: true })).status).toBe(200);
    const r = await approve(x.actionId);
    expect([r.status, r.code, (r.details as { reason?: string }).reason]).toEqual([409, 'DRAFT_STALE', 'DATE_NO_LONGER_DRIVES']);
  });

  it('E142: the move lands between the approval and the queue transaction: nothing is queued, the approval is undone, and no re-tap sends it', async () => {
    const x = await waitingDraft();
    seam.between = async () => {
      const r = await call(w.tc, 'PATCH', `/deal-dates/${x.dateId}`, { dueOn: localDay(w.zone, 5) });
      expect(r.status).toBe(200);
    };
    const r = await approve(x.actionId);
    expect(seam.between).toBeNull(); // the seam ran
    expect([r.status, r.code, (r.details as { reason?: string }).reason]).toEqual([409, 'DRAFT_STALE', 'DATE_MOVED']);
    expect(await actionStatus(x.actionId)).toBe('proposed');
    expect(await messagesOfAction(x.actionId)).toBe(0);
    expect([(await approve(x.actionId)).code]).toEqual(['DRAFT_STALE']);
    expect(mailTo(h, x.email)).toHaveLength(0);
  });

  it('E142: an approved but never-queued approval (the process died after the tap) is not resumed once the date moved', async () => {
    const x = await waitingDraft();
    // the approval transaction committed, the queue transaction never ran (fixture: the state it leaves)
    await h.su.query("UPDATE assistant_actions SET status = 'approved', decided_by_user_id = $2, decided_at = now() WHERE id = $1", [x.actionId, w.agents[0]!.userId]);
    expect((await call(w.tc, 'PATCH', `/deal-dates/${x.dateId}`, { dueOn: localDay(w.zone, 6) })).status).toBe(200);
    const r = await approve(x.actionId);
    expect([r.status, r.code]).toEqual([409, 'DRAFT_STALE']);
    expect(await messagesOfAction(x.actionId)).toBe(0);
    expect(await actionStatus(x.actionId)).toBe('proposed');
  });

  it('E142 control: an unmoved date\'s draft is approved and sent once', async () => {
    const x = await waitingDraft();
    const r = await approve(x.actionId);
    expect(r.status).toBe(200);
    expect(mailTo(h, x.email)).toHaveLength(1);
    expect((await dateRow(h, x.dateId)).due_version).toBe(2);
  });
});
