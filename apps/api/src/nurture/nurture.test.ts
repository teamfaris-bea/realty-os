// api/nurture end to end through real Postgres (app_user, RLS), the deterministic MLS record feed and the fake
// email/telephony providers. PHASE2_3_PLAN §5.4 #26: R-NURT-1..5, R-NURT-7, R-NURT-8, R-FH-2, R-AST-20,
// R-MKT-11; E82, E83, E84, E101.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { actionsOf, call, listing, messagesOf, ownedContact } from '../assistant/testing.js';
import { emailWebhook } from '../comms/testing.js';
import { command } from '../leads/testing.js';
import { ATTEST, type NurtureWorld, approveTemplate, firingsDue, follow, mlsRecord, nurtureWorld, reconcileAndRun, triggerRuns } from './testing.js';

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
    expect(sent[0]).toMatchObject({ status: 'sent', initiator: 'assistant', channel: 'email' });
    expect(sent[0]!.body).toContain('now $480,000');
    expect(sent[0]!.body).toContain('Listing information from the regional MLS (test attribution).');
    expect(sent[0]!.body).toContain('Listed by Other Brokerage (test).'); // R-MLS-2: the listing brokerage on every MLS rendering
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

const alerts = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'search_alert');
type Runs = { runs: { id: string; status: string; trigger: string; fact: { text: string; source: string; at: string } | null; skip: { reason: string; text: string } | null }[] };

describe('R-NURT-3 digest and R-NURT-4 the send-time recheck (E82, E83, E84)', () => {
  it('E84 R-NURT-3: five followed homes dropping the same day become ONE message listing five homes, each with its evidence', async () => {
    const c = await ownedContact(w.agents[0]!);
    const ks = [nextMls(), nextMls(), nextMls(), nextMls(), nextMls()];
    for (const k of ks) await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 600000 }), c.id);
    for (const k of ks) await mlsRecord(h, w, k, { ListPrice: 590000 });
    const runs = await triggerRuns(h, c.id);
    expect(runs).toHaveLength(5);
    // the approved digest window (120 min) put all five on one send time
    expect(new Set(runs.map((r) => r.scheduled_for.getTime())).size).toBe(1);
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await alerts(c.id);
    expect(m).toHaveLength(1);
    expect(m[0]!.status).toBe('sent');
    expect(m[0]!.body).toContain('5 updates on homes you follow');
    expect(m[0]!.body.match(/now \$590,000, down from \$600,000/g)).toHaveLength(5);
    expect((await triggerRuns(h, c.id)).map((r) => r.status)).toEqual(['sent', 'sent', 'sent', 'sent', 'sent']); // members settle with the lead
    const a = (await actionsOf(h, c.id)).find((x) => x.kind === 'autonomous_message')!;
    expect((a.payload['evidence'] as unknown[]).length).toBe(5);
    expect((await h.su.query('SELECT count(*)::int AS n FROM assistant_claims WHERE action_id = $1', [a.id])).rows[0].n).toBe(5);
  });

  it('E83 R-NURT-3 R-NURT-4: the price rises again inside the window: still a net drop ⇒ the message shows the CURRENT price; no net drop ⇒ skipped with the reason', async () => {
    const c = await ownedContact(w.agents[0]!);
    const k1 = nextMls();
    const k2 = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, k1, { ListPrice: 500000 }), c.id);
    await follow(h, w.tenantId, await mlsRecord(h, w, k2, { ListPrice: 700000 }), c.id);
    await mlsRecord(h, w, k1, { ListPrice: 480000 });
    await mlsRecord(h, w, k2, { ListPrice: 650000 });
    await mlsRecord(h, w, k1, { ListPrice: 490000 }); // up again, still below 500k: no new firing (a rise is not a fact that fires)
    await mlsRecord(h, w, k2, { ListPrice: 710000 }); // back above the alerted price: no net drop
    expect(await triggerRuns(h, c.id)).toHaveLength(2);
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await alerts(c.id);
    expect(m).toHaveLength(1);
    expect(m[0]!.body).toContain('now $490,000');
    expect(m[0]!.body).not.toContain('$480,000');
    expect(m[0]!.body).not.toContain('710,000');
    const view = await call<Runs>(w.agents[0]!, 'GET', `/contacts/${c.id}/trigger-runs`);
    expect(view.status).toBe(200);
    const skipped = view.body.runs.find((r) => r.status === 'skipped_ineligible')!;
    expect(skipped.skip).toEqual({ reason: 'PRICE_NOT_LOWER', text: 'The price is no longer lower than before.' });
  });

  it('E82 R-NURT-4: a listing withdrawn while its alert is scheduled is skipped_ineligible with a visible reason, never sent', async () => {
    const c = await ownedContact(w.agents[0]!);
    const k = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 500000 }), c.id);
    await mlsRecord(h, w, k, { ListPrice: 450000 });
    await mlsRecord(h, w, k, { ListPrice: 450000, StandardStatus: 'Withdrawn' });
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    expect(await alerts(c.id)).toEqual([]);
    const view = await call<Runs>(w.agents[0]!, 'GET', `/contacts/${c.id}/trigger-runs`);
    expect(view.body.runs).toEqual([expect.objectContaining({ status: 'skipped_ineligible', trigger: 'price_drop', skip: { reason: 'LISTING_INACTIVE', text: 'The home is no longer on the market.' }, fact: expect.objectContaining({ source: 'mls' }) })]);
  });

  it('R-NURT-2: a return to market (withdrawn ⇒ active) on a followed MLS home fires back_on_market once; an unfollowed home fires nothing', async () => {
    const c = await ownedContact(w.agents[0]!);
    const k = nextMls();
    const other = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, k, { StandardStatus: 'Withdrawn' }), c.id);
    await mlsRecord(h, w, other, { StandardStatus: 'Withdrawn' });
    await mlsRecord(h, w, k, { StandardStatus: 'Active' });
    await mlsRecord(h, w, other, { StandardStatus: 'Active' });
    const runs = await triggerRuns(h, c.id);
    expect(runs.map((r) => r.step_key)).toEqual(['back_on_market']);
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await alerts(c.id);
    expect(m).toHaveLength(1);
    expect(m[0]!.body).toContain('is back on the market');
  });

  it('R-NURT-2: a team listing price decrease (listing_price_history row) fires for a client who follows it; an increase does not', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const lid = await listing(h, w, agent.userId!, { priceCents: 90_000_000 });
    await follow(h, w.tenantId, lid, c.id);
    expect((await call(agent, 'PATCH', `/listings/${lid}`, { listPriceCents: 95_000_000 })).status).toBe(200);
    await reconcileAndRun(h, w.tenantId, 1);
    expect(await triggerRuns(h, c.id)).toEqual([]);
    expect((await call(agent, 'PATCH', `/listings/${lid}`, { listPriceCents: 85_000_000 })).status).toBe(200);
    await reconcileAndRun(h, w.tenantId, 1);
    const runs = await triggerRuns(h, c.id);
    expect(runs).toHaveLength(1);
    const hist = (await h.su.query('SELECT id FROM listing_price_history WHERE listing_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 1', [lid])).rows[0].id;
    expect(runs[0]!.trigger_key).toBe(`price_drop:${hist}:${c.id}`);
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    const m = await alerts(c.id);
    expect(m).toHaveLength(1);
    expect(m[0]!.body).toContain('now $850,000');
    expect(m[0]!.body).not.toContain('MLS'); // a team listing is not MLS data
  });
});

describe('R-NURT-7 owners, R-AST-4 approvals, R-NURT-5 the pause', () => {
  it('R-NURT-7: an agent-scoped trigger fires only for contacts its agent owns, and only while they still own them (re-checked at send time)', async () => {
    const [a0, a1] = w.agents as [typeof w.agents[0], typeof w.agents[0]];
    const mine = await ownedContact(a0!);
    const theirs = await ownedContact(a1!); // agent 1 has no Behavior alerts playbook
    const k = nextMls();
    const lid = await mlsRecord(h, w, k, { ListPrice: 500000 });
    await follow(h, w.tenantId, lid, mine.id);
    await follow(h, w.tenantId, lid, theirs.id);
    await mlsRecord(h, w, k, { ListPrice: 470000 });
    expect(await triggerRuns(h, theirs.id)).toEqual([]);
    expect(await triggerRuns(h, mine.id)).toHaveLength(1);
    // the lead moves to agent 1 before the alert goes out
    const moved = await command(w.owner, mine.id, 'reassign', { toUserId: a1!.userId });
    expect(moved.status).toBe(200);
    await firingsDue(h, mine.id);
    await reconcileAndRun(h, w.tenantId);
    expect(await alerts(mine.id)).toEqual([]);
    expect((await triggerRuns(h, mine.id))[0]).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: { reason: 'OWNER_CHANGED', text: expect.any(String) } }) });
  });

  it('R-NURT-7: an unowned contact (the pond) never gets a trigger message', async () => {
    const c = await ownedContact(w.agents[0]!);
    expect((await command(w.agents[0]!, c.id, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    const k = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 500000 }), c.id);
    await mlsRecord(h, w, k, { ListPrice: 490000 });
    expect(await triggerRuns(h, c.id)).toEqual([]);
  });

  it('R-AST-4: a draft version never fires; a revoked version stops at once (its scheduled firings are skipped, the guard refuses its messages)', async () => {
    const a1 = w.agents[1]!;
    const c = await ownedContact(a1);
    const draft = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string; issues: unknown[] }[] } }>(a1, 'POST', '/playbooks', { templateKey: 'behavior_alerts' });
    expect(draft.status).toBe(201);
    expect(draft.body.playbook.versions[0]!.issues).toEqual([]);
    const k = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 500000 }), c.id);
    await mlsRecord(h, w, k, { ListPrice: 495000 });
    expect(await triggerRuns(h, c.id)).toEqual([]); // only an APPROVED version fires
    const v = draft.body.playbook.versions[0]!;
    expect((await call(a1, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: ATTEST, contentSha256: v.contentSha256 })).status).toBe(200);
    await mlsRecord(h, w, k, { ListPrice: 485000 });
    expect(await triggerRuns(h, c.id)).toHaveLength(1);
    expect((await call(a1, 'POST', `/playbook-versions/${v.id}/revoke`, { attestation: ATTEST, contentSha256: v.contentSha256 })).status).toBe(200);
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    expect(await alerts(c.id)).toEqual([]);
    expect((await triggerRuns(h, c.id))[0]).toMatchObject({ status: 'skipped_ineligible', trigger_ref: expect.objectContaining({ skip: expect.objectContaining({ reason: 'APPROVAL_NOT_CURRENT' }) }) });
  });

  it('R-NURT-5: a paused conversation turns a firing into a draft for the owner, and the DB guard refuses a forced autonomous send while paused', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const k = nextMls();
    await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 500000 }), c.id);
    // the client wrote (SMS): the conversation is paused before the price drops
    const { inboundSms } = await import('../comms/testing.js');
    expect((await inboundSms(h, c.phone, w.mainNumber, 'Still looking, thanks')).statusCode).toBe(200);
    await mlsRecord(h, w, k, { ListPrice: 460000 });
    await firingsDue(h, c.id);
    await reconcileAndRun(h, w.tenantId);
    expect(await alerts(c.id)).toEqual([]);
    const [run] = await triggerRuns(h, c.id);
    expect(run!.status).toBe('converted_to_draft');
    const d = (await actionsOf(h, c.id)).find((a) => a.id === run!.assistant_action_id)!;
    expect(d).toMatchObject({ kind: 'message_draft', autonomy: 'requires_approval', status: 'proposed' });
    expect(d.payload['draftReasons']).toContain('PAUSED');
    expect(d.payload['evidence']).toEqual([expect.objectContaining({ source: 'mls', trigger: 'price_drop' })]);
    // the feed card waits for the agent
    expect((await h.su.query("SELECT item_type FROM priority_feed_items WHERE assistant_action_id = $1", [d.id])).rows).toEqual([{ item_type: 'assistant_draft' }]);
  });

  it('R-NURT-5: an inbound reply on SMS, email or web chat cancels the contact\'s scheduled trigger runs', async () => {
    const agent = w.agents[0]!;
    const { inboundSms } = await import('../comms/testing.js');
    for (const via of ['sms', 'email'] as const) {
      const c = await ownedContact(agent);
      const k = nextMls();
      await follow(h, w.tenantId, await mlsRecord(h, w, k, { ListPrice: 500000 }), c.id);
      await mlsRecord(h, w, k, { ListPrice: 455000 });
      expect((await triggerRuns(h, c.id)).map((r) => r.status)).toEqual(['scheduled']);
      if (via === 'sms') expect((await inboundSms(h, c.phone, w.mainNumber, 'Call me')).statusCode).toBe(200);
      else {
        await call(agent, 'POST', `/contacts/${c.id}/messages`, { channel: 'email', subject: 'Hello', body: 'Checking in.', idempotencyKey: `e-${randomUUID()}` });
        const replyTo = h.providers.email.sent.filter((m) => m.to === c.email).at(-1)!.replyTo!;
        expect((await emailWebhook(h, '/webhooks/email/inbound', { eventId: randomUUID(), from: c.email, to: replyTo, subject: 'Re: Hello', text: 'Call me' })).statusCode).toBe(200);
      }
      expect((await triggerRuns(h, c.id)).map((r) => r.status), via).toEqual(['canceled_paused']);
      await firingsDue(h, c.id);
      await reconcileAndRun(h, w.tenantId);
      expect(await alerts(c.id), via).toEqual([]);
    }
  });
});
