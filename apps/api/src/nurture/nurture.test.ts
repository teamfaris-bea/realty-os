// api/nurture end to end through real Postgres (app_user, RLS), the deterministic MLS record feed and the fake
// email/telephony providers. PHASE2_3_PLAN §5.4 #26: R-NURT-1..5, R-NURT-7, R-NURT-8, R-FH-2, R-AST-20,
// R-MKT-11; E82, E83, E84, E101.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { actionsOf, call, messagesOf, ownedContact } from '../assistant/testing.js';
import { emailWebhook } from '../comms/testing.js';
import { type NurtureWorld, approveTemplate, firingsDue, follow, mlsRecord, nurtureWorld, reconcileAndRun, triggerRuns } from './testing.js';

let h: ApiHarness;
let w: NurtureWorld;
let behavior: { playbookId: string; versionId: string };

beforeAll(async () => {
  h = await createApiHarness();
  w = await nurtureWorld(h);
  behavior = await approveTemplate(w.agents[0]!, 'behavior_alerts');
}, 240_000);
afterAll(async () => {
  await h?.close();
});

let n = 7000;
const nextMls = () => (n += 1);

describe('acceptance: Behavior alerts approved once, a fake MLS price drop, one digested gated message with evidence', () => {
  it('R-NURT-1 R-NURT-2 R-NURT-3 R-MLS-2: one message through dispatch, with the current price, attribution, and the fact, source and time as evidence; a reply pauses the rest (R-NURT-5)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const k = nextMls();
    const listingId = await mlsRecord(h, w, k, { ListPrice: 500000 });
    await follow(h, w.tenantId, listingId, c.id);
    expect(await triggerRuns(h, c.id)).toEqual([]); // a new listing is a match (R-MLS-6), never a trigger
    await mlsRecord(h, w, k, { ListPrice: 480000 });
    const runs = await triggerRuns(h, c.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'scheduled', step_key: 'price_drop', playbook_version_id: behavior.versionId });
    expect(runs[0]!.trigger_key).toMatch(/^price_drop:[0-9a-f-]+:/);
    // a re-sync of the same modification fires nothing new (unique trigger_key)
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    const sent = (await messagesOf(h, c.id)).filter((m) => m.action_category === 'search_alert');
    expect(sent).toHaveLength(1);
    if (sent[0]!.status !== 'sent') console.log(sent[0], (await h.su.query('SELECT reason_codes, explanation FROM gate_decisions WHERE message_id = $1', [sent[0]!.id])).rows);
    expect(sent[0]).toMatchObject({ status: 'sent', initiator: 'assistant', channel: 'email' });
    expect(sent[0]!.body).toContain('now $480,000');
    expect(sent[0]!.body).toContain('Listing information from the regional MLS (test attribution).');
    expect(sent[0]!.body).toMatch(/— \S+'s assistant/); // the assistant never pretends to be human (R-AST-11)
    const [run] = await triggerRuns(h, c.id);
    expect(run).toMatchObject({ status: 'sent', message_id: sent[0]!.id });
    const action = (await actionsOf(h, c.id)).find((a) => a.id === run!.assistant_action_id)!;
    expect(action).toMatchObject({ kind: 'autonomous_message', autonomy: 'within_playbook', action_category: 'search_alert', status: 'executed' });
    expect(action.payload['evidence']).toEqual([expect.objectContaining({ trigger: 'price_drop', source: 'mls', sourceId: listingId })]);
    const ev = (await h.su.query('SELECT c.claim_kind, c.text, e.source_type, e.source_id, e.snippet, e.verbatim_verified FROM assistant_claims c JOIN evidence_refs e ON e.claim_id = c.id WHERE c.action_id = $1', [action.id])).rows;
    expect(ev).toEqual([expect.objectContaining({ claim_kind: 'fact', source_type: 'listing', source_id: listingId, snippet: '$480,000 (was $500,000)', verbatim_verified: true })]);
    expect(ev[0]!.text).toMatch(/MLS, /);
    // never a touch, never an ownership change (R-NURT-8)
    expect((await h.su.query('SELECT last_human_touch_at, owner_user_id FROM contacts WHERE id = $1', [c.id])).rows[0]).toEqual({ last_human_touch_at: null, owner_user_id: agent.userId });

    // the client replies to the alert email: automation pauses; a further drop becomes a draft, never a send
    const replyTo = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!.replyTo!;
    expect((await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: c.email, to: replyTo, subject: 'Re: price', text: 'Can we see it Saturday?' })).statusCode).toBe(200);
    await mlsRecord(h, w, k, { ListPrice: 470000 });
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    expect((await messagesOf(h, c.id)).filter((m) => m.action_category === 'search_alert')).toHaveLength(1);
    const after = await triggerRuns(h, c.id);
    expect(after.map((r) => r.status)).toEqual(['sent', 'converted_to_draft']);
    const draft = (await actionsOf(h, c.id)).find((a) => a.id === after[1]!.assistant_action_id)!;
    expect(draft).toMatchObject({ kind: 'message_draft', autonomy: 'requires_approval', owner_user_id: agent.userId, status: 'proposed' });
    expect(draft.explanation).toMatch(/replied/);
    expect(draft.payload['body']).toContain('now $470,000');
    void call;
  });
});
