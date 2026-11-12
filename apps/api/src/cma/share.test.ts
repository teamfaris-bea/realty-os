// V2-A sharing against real Postgres (R-CMA-9, R-CMA-7, R-CMA-8, D1, R-GATE-14, R-GATE-10, R-FH-1; E376, E377, E600-E611,
// E613-E615, E617-E619). Fakes only: the fake email provider records every send; no real provider, MLS or person.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform, dispatchOutbound } from '../comms/index.js';
import { mlsConnection } from '../mls/testing.js';
import type { TestClient } from '../auth/testHarness.js';
import { type CmaBody, type ShareWorld, call, cmaPack, emailSeller, localSales, oneTap, saleReso, shareFrom, sharePreview, shareQueued, shareWorld, syncSales, teamListing, withPlatformCmaCleared } from './testing.js';

let h: ApiHarness;
let w: ShareWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await shareWorld(h);
  await localSales(w, 12);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const agent = () => w.agents[0]!;
const sent = (to: string | null) => h.providers.email.sent.filter((m) => m.to === to);
const messagesOf = async (contactId: string) => Number((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [contactId])).rows[0].n);

async function draftFor(o: Parameters<typeof emailSeller>[2] = {}) {
  const s = await emailSeller(w, agent(), o);
  const r = await oneTap(agent(), s.c);
  expect(r.status).toBe(201);
  return { ...s, id: r.body.cma.id, view: r.body.cma };
}

describe('accept: one more tap emails the report', () => {
  it('R-CMA-9 D1 R-GATE-14: with every gate met, the preview shows the report and an allow; one POST creates one human email through dispatch, freezes the CMA as shared by that person with that message', async () => {
    const d = await draftFor();
    await withPlatformCmaCleared(h, async () => {
      const p = await sharePreview(agent(), d.id);
      expect(p.status).toBe(200);
      const pv = p.body.preview;
      expect(pv).toMatchObject({ canShare: true, sentence: null, blockers: [], disclosureMissing: [], stale: null, recipientContactId: d.c });
      expect(pv.decision!.outcome).toBe('allow');
      expect(pv.reportText).toContain('Estimated value range: $');
      expect(pv.body).toContain(pv.reportText!);
      const before = sent(d.email).length;
      const s = await shareFrom(agent(), pv);
      expect([s.status, s.body.message.result]).toEqual([200, 'sent']);
      expect(sent(d.email).length).toBe(before + 1);
      const mail = sent(d.email).at(-1)!;
      expect(mail.text).toContain(pv.reportText!);
      const row = (await h.su.query('SELECT status, shared_by_user_id, shared_message_id, shared_at FROM cma_reports WHERE id = $1', [d.id])).rows[0];
      expect(row).toMatchObject({ status: 'shared', shared_by_user_id: agent().userId, shared_message_id: s.body.message.id });
      expect(row.shared_at).not.toBeNull();
      const m = (await h.su.query('SELECT initiator, initiated_by_user_id, channel, status, contact_id FROM messages WHERE id = $1', [s.body.message.id])).rows[0];
      expect(m).toMatchObject({ initiator: 'human', initiated_by_user_id: agent().userId, channel: 'email', status: 'sent', contact_id: d.c });
      expect(s.body.cma.share).toMatchObject({ sharedByUserId: agent().userId, message: { id: s.body.message.id, sentence: 'Sent.' } });
      expect(s.body.cma.status).toBe('shared');
      expect(s.body.cma.pdfAvailable).toBe(true);
    });
  });
});

const errorOf = (r: { body: unknown }) => (r.body as { error: { code: string; details?: Record<string, unknown> } }).error;
const preview = async (id: string, q: { recipientContactId?: string; toPointId?: string } = {}, client: TestClient = agent()) => {
  const p = await sharePreview(client, id, q);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return p.body.preview;
};
const setPack = (conn: string, pack: Record<string, unknown>) => h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [conn, JSON.stringify(pack)]);
const nothingStored = async (d: { id: string; c: string }) => {
  expect((await h.su.query('SELECT status, shared_message_id FROM cma_reports WHERE id = $1', [d.id])).rows[0]).toEqual({ status: 'draft', shared_message_id: null });
  expect(await messagesOf(d.c)).toBe(0);
};

describe('the shipped default', () => {
  it('D9 R-CMA-7: platform:cma ships unreviewed: the preview names PLATFORM_NOT_CLEARED in words with Email off, and a share is CMA_NOT_SHAREABLE with nothing stored', async () => {
    const d = await draftFor();
    const pv = await preview(d.id);
    expect(pv.canShare).toBe(false);
    expect(pv.blockers.map((b) => b.code)).toEqual(['PLATFORM_NOT_CLEARED']);
    expect(pv.blockers[0]!.sentence).toMatch(/counsel review/);
    expect(pv.sentence).toBe('This CMA can’t be shown to a client yet:');
    const s = await shareFrom(agent(), pv);
    expect([s.status, errorOf(s)]).toEqual([409, { code: 'CMA_NOT_SHAREABLE', requestId: expect.any(String), details: { blockers: ['PLATFORM_NOT_CLEARED'] } }]);
    await nothingStored(d);
  });
});

describe('R-CMA-9 E376 E377', () => {
  it('R-CMA-9 E376: a comp the pack hides from clients blocks the share (COMPS_HIDDEN in words, no message); after removing it the share sends the recomputed range without it', async () => {
    const w2 = await shareWorld(h);
    await localSales(w2, 4);
    const hiddenLine = '777 Hidden Comp Avenue';
    const [hidden] = await syncSales(w2, [saleReso({ line1: hiddenLine, displayAllowed: false, sqft: 1500, beds: 3, closePriceCents: 99_000_000 })]);
    const s = await emailSeller(w2, w2.agents[0]!);
    const tap = await oneTap(w2.agents[0]!, s.c);
    const comp = tap.body.cma.comps.find((c) => c.saleListingId === hidden);
    expect(comp, 'the hidden sale is a comp').toBeDefined();
    await withPlatformCmaCleared(h, async () => {
      const pv = await preview(tap.body.cma.id, {}, w2.agents[0]!);
      expect(pv.blockers.map((b) => b.code)).toEqual(['COMPS_HIDDEN']);
      expect(pv.blockers[0]!.sentence).toMatch(/^1 of these sales can’t be shown to clients/);
      const view = await call<CmaBody>(w2.agents[0]!, 'GET', `/cma/${tap.body.cma.id}`);
      expect(view.body.cma.clientShare.blockers.map((b) => b.code)).toEqual(['COMPS_HIDDEN']);
      const r = await shareFrom(w2.agents[0]!, pv);
      expect([r.status, errorOf(r).code, errorOf(r).details]).toEqual([409, 'CMA_NOT_SHAREABLE', { blockers: ['COMPS_HIDDEN'] }]);
      expect(await messagesOf(s.c)).toBe(0);
      const p = await call<CmaBody>(w2.agents[0]!, 'PATCH', `/cma/${tap.body.cma.id}`, { exclude: [comp!.listingId] });
      expect(p.status).toBe(200);
      expect(p.body.cma.comps.some((c) => c.saleListingId === hidden)).toBe(false);
      const pv2 = await preview(tap.body.cma.id, {}, w2.agents[0]!);
      expect(pv2.canShare).toBe(true);
      const ok = await shareFrom(w2.agents[0]!, pv2);
      expect([ok.status, ok.body.message.result]).toEqual([200, 'sent']);
      const mail = h.providers.email.sent.filter((m) => m.to === s.email).at(-1)!;
      const money = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
      expect(mail.text).toContain(`Estimated value range: ${money(p.body.cma.result.lowCents!)} to ${money(p.body.cma.result.highCents!)}`);
      expect(mail.text).not.toContain(hiddenLine.replace('Avenue', 'Ave'));
      expect(mail.text).not.toContain('777 Hidden');
    });
  });

  it('R-CMA-8 E377: a PATCH after share is CMA_NOT_DRAFT and the shared row is byte-identical; a one-tap then makes a new draft (201) and the shared row keeps its status and message', async () => {
    const d = await draftFor();
    const shared = await withPlatformCmaCleared(h, async () => shareFrom(agent(), await preview(d.id)));
    expect(shared.status).toBe(200);
    const snap = async () => (await h.su.query('SELECT to_jsonb(r) AS j FROM cma_reports r WHERE id = $1', [d.id])).rows[0].j;
    const before = await snap();
    const p = await call(agent(), 'PATCH', `/cma/${d.id}`, { notes: 'after the share' });
    expect([p.status, errorOf(p).code]).toEqual([409, 'CMA_NOT_DRAFT']);
    expect(await snap()).toEqual(before);
    const again = await oneTap(agent(), d.c);
    expect(again.status).toBe(201);
    expect(again.body.cma.id).not.toBe(d.id);
    expect((await h.su.query('SELECT status, shared_message_id FROM cma_reports WHERE id = $1', [d.id])).rows[0]).toEqual({ status: 'shared', shared_message_id: shared.body.message.id });
    // a shared CMA is not shared again, and its preview is CMA_NOT_DRAFT
    expect(errorOf(await sharePreview(agent(), d.id)).code).toBe('CMA_NOT_DRAFT');
  });
});

describe('R-GATE-14 R-GATE-10 D1: every send goes through dispatch', () => {
  it('R-GATE-14 R-GATE-10 E603(b): shared with the email queued, then the recipient unsubscribes: dispatch blocks it (one gate_decisions row, send/deny), the fake provider records no send, the CMA stays shared and says why', async () => {
    const d = await draftFor();
    const r = await withPlatformCmaCleared(h, async () => shareQueued(h, agent(), await preview(d.id)));
    expect(r.message).toMatchObject({ status: 'queued', result: 'queued' });
    const body = (await h.su.query('SELECT body, purpose FROM messages WHERE id = $1', [r.message.id])).rows[0];
    expect(body.purpose).toBe('marketing'); // owner question c: the human classification, never forced informational
    const url = new URL(String(body.body).match(/https?:\/\/\S+\/api\/email\/unsubscribe\/\S+/)![0]);
    const unsub = await h.app.inject({ method: 'POST', url: url.pathname, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(unsub.statusCode).toBe(200);
    const before = sent(d.email).length;
    const x = await dispatchOutbound(r.message.id, depsFromPlatform(h.app.platform), { tenantId: w.tenantId, actor: agent().actor() });
    expect(x.kind).toBe('blocked');
    expect(sent(d.email).length).toBe(before);
    const g = await h.su.query("SELECT phase, outcome FROM gate_decisions WHERE id = (SELECT gate_decision_id FROM messages WHERE id = $1)", [r.message.id]);
    expect(g.rows).toEqual([{ phase: 'send', outcome: 'deny' }]);
    const v = await call<CmaBody & { cma: { share: { message: { status: string; sentence: string } } } }>(agent(), 'GET', `/cma/${d.id}`);
    expect(v.body.cma.status).toBe('shared');
    expect(v.body.cma.share.message.status).toBe('blocked');
    expect(v.body.cma.share.message.sentence).toMatch(/^The email was not sent: /);
  });

  it('D1 E603(a): an opt-out at preview time shows the deny, and the share is CMA_RECIPIENT_BLOCKED with nothing stored', async () => {
    const d = await draftFor();
    expect((await call(agent(), 'POST', `/contacts/${d.c}/do-not-contact`, {})).status).toBe(200);
    await withPlatformCmaCleared(h, async () => {
      const pv = await preview(d.id);
      expect(pv.decision!.outcome).toBe('deny');
      expect(pv.canShare).toBe(false);
      expect(pv.sentence).toMatch(/^The send-time check would block this email now\. /);
      const s = await shareFrom(agent(), pv);
      expect([s.status, errorOf(s).code]).toEqual([409, 'CMA_RECIPIENT_BLOCKED']);
      expect(errorOf(s).details!['reasons']).toEqual(expect.arrayContaining([expect.any(String)]));
    });
    await nothingStored(d);
  });
});

describe('E613 recipients', () => {
  it('E613 R-PERM-5: (a) a co_seller is listed and may receive it; (b) referred_by is 422; (c) a contact the agent cannot see is 404; (d) one they see but may not message is 404', async () => {
    const d = await draftFor();
    const co = await emailSeller(w, agent(), { name: 'Cory Coseller' });
    const ref = await emailSeller(w, agent(), { name: 'Riley Referrer' });
    // (d): agents[1]'s contact on a deal agents[0] is a co-agent of: agents[0] sees its detail (deal member) but may
    // not message it (an agent's comms.send is own and collaborating contacts only)
    const theirs = await emailSeller(w, w.agents[1]!, { name: 'Toni Theirs' });
    const deal = await call<{ deal: { id: string } }>(w.agents[1]!, 'POST', '/deals', { primaryContactId: theirs.c, side: 'sell' });
    expect(deal.status).toBe(201);
    expect((await call(w.owner, 'POST', `/deals/${deal.body.deal.id}/members`, { userId: agent().userId, role: 'co_agent' })).status).toBe(200);
    expect((await call(agent(), 'GET', `/contacts/${theirs.c}`)).status).toBe(200);
    for (const [rel, kind] of [[co.c, 'co_seller'], [ref.c, 'referred_by'], [theirs.c, 'spouse_partner']] as const) {
      const r = await call(w.owner, 'POST', `/contacts/${d.c}/relationships`, { relatedContactId: rel, kind });
      expect([kind, r.status]).toEqual([kind, 201]);
    }
    const { intake } = await import('../leads/testing.js');
    const pond = (await intake(h, w.leads, { emails: ['pond-lead@example.test'] })).contactId;
    await withPlatformCmaCleared(h, async () => {
      const pv = await preview(d.id);
      // (d): agents[1]'s contact is visible to the agent but not theirs to message: never listed
      expect(pv.recipients.map((r) => [r.relationship, r.contactId])).toEqual([['self', d.c], ['co_seller', co.c]]);
      const coPv = await preview(d.id, { recipientContactId: co.c });
      expect(coPv.canShare).toBe(true);
      const point = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email'", [ref.c])).rows[0].id;
      const b = await shareFrom(agent(), pv, { recipientContactId: ref.c, toPointId: point });
      expect([b.status, errorOf(b).code, errorOf(b).details]).toEqual([422, 'VALIDATION_FAILED', { issues: [{ path: '/recipientContactId', code: 'not_a_share_relation' }] }]);
      const pondPoint = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email'", [pond])).rows[0].id;
      expect((await shareFrom(agent(), pv, { recipientContactId: pond, toPointId: pondPoint })).status).toBe(404);
      const theirPoint = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email'", [theirs.c])).rows[0].id;
      expect((await shareFrom(agent(), pv, { recipientContactId: theirs.c, toPointId: theirPoint })).status).toBe(404);
      expect((await sharePreview(agent(), d.id, { recipientContactId: theirs.c })).status).toBe(404);
      // a point that is not the recipient's email
      const phone = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [d.c])).rows[0].id;
      expect(errorOf(await shareFrom(agent(), pv, { toPointId: phone })).details).toEqual({ issues: [{ path: '/toPointId', code: 'not_an_email_of_recipient' }] });
      await nothingStored(d);
      // (a) the co_seller receives it
      const before = sent(co.email).length;
      const ok = await shareFrom(agent(), coPv);
      expect([ok.status, ok.body.message.result]).toEqual([200, 'sent']);
      expect(sent(co.email).length).toBe(before + 1);
      expect((await h.su.query('SELECT contact_id FROM messages WHERE id = $1', [ok.body.message.id])).rows[0].contact_id).toBe(co.c);
    });
  });

  it('R-CMA-9: a recipient without an email address: the preview says so and Email is off', async () => {
    const d = await draftFor({ name: 'Nadia Nomail', email: null });
    const pv = await withPlatformCmaCleared(h, () => preview(d.id));
    expect(pv).toMatchObject({ canShare: false, toPointId: null, decision: null, sentence: 'No email address for Nadia.' });
  });
});

describe('E606 E607 disclosure at share', () => {
  it('E606: (a) purpose other without intended users, (b) an exterior inspection without a date: CMA_DISCLOSURE_INCOMPLETE naming each field and path; (c) listing_price with no inspection needs nothing', async () => {
    const d = await draftFor();
    await withPlatformCmaCleared(h, async () => {
      expect((await call(agent(), 'PATCH', `/cma/${d.id}`, { purpose: 'other', disclosure: { agentInterest: 'Listing agent', conflicts: 'None', valueDefinition: 'Market value', limitingConditions: 'Exterior only' } })).status).toBe(200);
      const a = await preview(d.id);
      expect([a.canShare, a.disclosureMissing, a.sentence]).toEqual([false, ['intendedUsers'], 'Fill in the disclosure items before sharing.']);
      const ra = await shareFrom(agent(), a);
      expect([ra.status, errorOf(ra).code, errorOf(ra).details]).toEqual([422, 'CMA_DISCLOSURE_INCOMPLETE', { missing: ['intendedUsers'], paths: ['/disclosure/intendedUsers'] }]);
      expect((await call(agent(), 'PATCH', `/cma/${d.id}`, { purpose: 'listing_price', inspection: 'exterior' })).status).toBe(200);
      const b = await preview(d.id);
      const rb = await shareFrom(agent(), b);
      expect([rb.status, errorOf(rb).details]).toEqual([422, { missing: ['inspectedOn'], paths: ['/inspectedOn'] }]);
      await nothingStored(d);
      expect((await call(agent(), 'PATCH', `/cma/${d.id}`, { inspection: 'none' })).status).toBe(200);
      const c = await preview(d.id);
      expect(c.disclosureMissing).toEqual([]);
      expect((await shareFrom(agent(), c)).status).toBe(200);
    });
  });
});

describe('E604 E605 statements at share', () => {
  it('E604 E605: a substituted statement, attribution or disclaimer is CMA_STATEMENT_NOT_RENDERABLE naming its part and code points; a 14 pt minimum is EMAIL_TYPE_SIZE; nothing is stored', async () => {
    const w3 = await shareWorld(h);
    await localSales(w3, 6);
    const s = await emailSeller(w3, w3.agents[0]!);
    const tap = await oneTap(w3.agents[0]!, s.c);
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [cmaPack({ valuation: { statements: { CA: { text: 'Statement™ (fixture).', min_point_size: 10 } } } }), { part: 'statement', reason: 'SUBSTITUTED', codePoints: ['U+2122'] }],
      [cmaPack({ valuation: { statements: { CA: { text: 'Statement (fixture).', min_point_size: 14 } } } }), { part: 'statement', reason: 'EMAIL_TYPE_SIZE' }],
      [{ ...cmaPack(), attribution_text: 'Courtesy of • the Test MLS (fixture).' }, { part: 'attribution', reason: 'SUBSTITUTED', codePoints: ['U+2022'] }],
      [{ ...cmaPack(), disclaimer_text: 'Fixture disclaimer…' }, { part: 'disclaimer', reason: 'SUBSTITUTED', codePoints: ['U+2026'] }],
    ];
    await withPlatformCmaCleared(h, async () => {
      for (const [pack, details] of cases) {
        await setPack(w3.mls, pack);
        const pv = await preview(tap.body.cma.id, {}, w3.agents[0]!);
        expect([details, pv.canShare, pv.statement]).toEqual([details, false, { ok: false, part: details['part'], reason: details['reason'], codePoints: (details['codePoints'] as string[] | undefined) ?? [] }]);
        const r = await shareFrom(w3.agents[0]!, pv);
        expect([r.status, errorOf(r).code, errorOf(r).details]).toEqual([409, 'CMA_STATEMENT_NOT_RENDERABLE', details]);
      }
      expect(await messagesOf(s.c)).toBe(0);
      // curly quotes, a dash and NBSP are allowed: kept as written in the email
      const ok = 'It’s an “estimate” – not\u00A0an appraisal (fixture).';
      await setPack(w3.mls, cmaPack({ valuation: { statements: { CA: { text: ok, min_point_size: 12 } } } }));
      const pv = await preview(tap.body.cma.id, {}, w3.agents[0]!);
      expect(pv.canShare).toBe(true);
      const r = await shareFrom(w3.agents[0]!, pv);
      expect(r.status).toBe(200);
      expect(h.providers.email.sent.filter((m) => m.to === s.email).at(-1)!.text).toContain(ok);
    });
  });
});

describe('E614 E615 E617 E619 the report\'s contents', () => {
  it('E614 E615 E617 E619 R-CMA-4 R-MLS-2: the email holds exactly the client parts: the range, the estimate sentence, every connection\'s statement, attribution and disclaimer (a rate-pool-only one too), the comps as rendered for clients (a hidden street shows its locality), and none of the agent-only data', async () => {
    const w4 = await shareWorld(h);
    const pool = { h, tenantId: w4.tenantId, mls: await mlsConnection(h, w4.tenantId, w4.owner.userId!, { lastSyncedAt: new Date(), pack: { ...cmaPack({ valuation: { statements: { CA: { text: 'Pool connection statement (fixture).', min_point_size: 10 } } } }), attribution_text: 'Pool attribution (fixture).', disclaimer_text: 'Pool disclaimer (fixture).' } }) };
    await localSales(w4, 4);
    await localSales(pool, 6, { sqft: 3000 }); // too large to compare: only the rate pool reads them
    await syncSales(w4, [{ ...saleReso({ line1: '615 Remark Avenue', sqft: 1450, beds: 3 }), PublicRemarks: 'Remarks fixture text', Media: [{ MediaURL: 'https://photos.example.test/615.jpg', Order: 0 }] }]);
    await syncSales(w4, [{ ...saleReso({ line1: '617 Hidden Street', sqft: 1480, beds: 3, postalCode: '94110' }), InternetAddressDisplayYN: false }]);
    await teamListing(w4.agents[0]!, { addressLine1: '614 Team Avenue', status: 'sold', sqft: 1460, listPriceCents: 61_234_500, mlsNumber: 'TM614' });
    await syncSales(w4, [saleReso({ mlsNumber: 'TM614', line1: '614 Team Ave', sqft: 1460, beds: 3, closePriceCents: 52_000_000 })]);
    const s = await emailSeller(w4, w4.agents[0]!);
    const tap = await oneTap(w4.agents[0]!, s.c);
    const v = tap.body.cma;
    const hiddenComp = v.comps.find((c) => (c as unknown as { address: { line1: string } }).address.line1.startsWith('617'));
    expect(hiddenComp, 'the address-hidden sale is a comp').toBeDefined();
    expect(v.comps.some((c) => c.sourceLabel === 'Team'), 'the mirrored team sale is a comp').toBe(true);
    await withPlatformCmaCleared(h, async () => {
      const pv = await preview(v.id, {}, w4.agents[0]!);
      expect(pv.canShare, JSON.stringify(pv.blockers)).toBe(true);
      const r = await shareFrom(w4.agents[0]!, pv);
      expect(r.status).toBe(200);
      const text = h.providers.email.sent.filter((m) => m.to === s.email).at(-1)!.text;
      for (const part of ['Estimated value range: $', 'This is an estimate, not an appraisal.', 'Prepared by ', 'from MLS sales', 'Test valuation statement (fixture text, not legal wording).', 'Pool connection statement (fixture).', 'Pool attribution (fixture).', 'Pool disclaimer (fixture).', 'MLS data as of ', 'The home was not inspected for this estimate.', 'Sold: ', 'Adjusted price: $']) {
        expect([part, text.includes(part)]).toEqual([part, true]);
      }
      expect(text.match(/Sold: /g)!.length).toBe(v.comps.length);
      // E617: the hidden street is never in the email; its locality is
      expect(text).not.toContain('617 Hidden');
      expect(text).toContain('Sold: Oakland, CA 94110');
      // the agent screen still shows the street
      expect((hiddenComp as unknown as { address: { line1: string } }).address.line1).toMatch(/^617 Hidden/);
      for (const never of ['$612,345', 'Remarks fixture text', 'photos.example.test', String(v.result.valueCents! / 100), 'weight', 'missed the price', v.backtest.sentence, 'For context', 'Not used', ...v.notUsed.slice(0, 3).map((n) => n.sentence), ...v.market.sentences, ...v.comps.flatMap((c) => c.adjustments.map((a) => (a as unknown as { sentence: string }).sentence))]) {
        expect([never, text.includes(never)]).toEqual([never, false]);
      }
      expect(text).not.toMatch(/confiden|probab|score/i);
    });
  });

  it('E614: two connections\' long disclaimers and five full SoP items exceed the email cap: CMA_REPORT_TOO_LONG naming the parts, nothing stored', async () => {
    const w5 = await shareWorld(h, { pack: { ...cmaPack(), disclaimer_text: `First long disclaimer (fixture). ${'a'.repeat(1900)}` } });
    const second = { h, tenantId: w5.tenantId, mls: await mlsConnection(h, w5.tenantId, w5.owner.userId!, { lastSyncedAt: new Date(), pack: { ...cmaPack(), disclaimer_text: `Second long disclaimer (fixture). ${'b'.repeat(1900)}` } }) };
    await localSales(w5, 4);
    await localSales(second, 4);
    const s = await emailSeller(w5, w5.agents[0]!);
    const tap = await oneTap(w5.agents[0]!, s.c);
    const long = (k: string) => `${k} ${'x'.repeat(1990)}`;
    const p = await call(w5.agents[0]!, 'PATCH', `/cma/${tap.body.cma.id}`, { purpose: 'other', notes: long('Notes').padEnd(4000, 'y'), disclosure: { intendedUsers: long('Users'), agentInterest: long('Interest'), conflicts: long('Conflicts'), valueDefinition: long('Value'), limitingConditions: long('Limits') } });
    expect(p.status).toBe(200);
    await withPlatformCmaCleared(h, async () => {
      const pv = await preview(tap.body.cma.id, {}, w5.agents[0]!);
      expect(pv.canShare).toBe(false);
      expect(pv.tooLong!.parts.slice(0, 3).map((x) => x.role)).toEqual(['sop', 'notes', 'disclaimer']);
      const r = await shareFrom(w5.agents[0]!, pv);
      expect([r.status, errorOf(r).code]).toEqual([422, 'CMA_REPORT_TOO_LONG']);
      expect((errorOf(r).details!['parts'] as { role: string }[])[0]!.role).toBe('sop');
    });
    expect(await messagesOf(s.c)).toBe(0);
  });

  it('E619: a notes line outside WinAnsi warns "won\'t print" in the preview and is carried as written by the email', async () => {
    const d = await draftFor();
    expect((await call(agent(), 'PATCH', `/cma/${d.id}`, { notes: 'Near Đông Park' })).status).toBe(200);
    await withPlatformCmaCleared(h, async () => {
      const pv = await preview(d.id);
      expect(pv.warnings).toContainEqual({ code: 'WONT_PRINT', role: 'notes', codePoints: ['U+0110'] });
      expect(pv.canShare).toBe(true);
      expect((await shareFrom(agent(), pv)).status).toBe(200);
      expect(sent(d.email).at(-1)!.text).toContain('Notes: Near Đông Park');
    });
  });
});

describe('E601 E602 stale between preview and tap', () => {
  it('E601: an edit in another tab after the preview is CMA_STALE CONTENT_CHANGED, nothing stored', async () => {
    const d = await draftFor();
    await withPlatformCmaCleared(h, async () => {
      const pv = await preview(d.id);
      expect((await call(agent(), 'PATCH', `/cma/${d.id}`, { notes: 'edited elsewhere' })).status).toBe(200);
      const r = await shareFrom(agent(), pv);
      expect([r.status, errorOf(r).code, errorOf(r).details]).toEqual([409, 'CMA_STALE', { reason: 'CONTENT_CHANGED' }]);
    });
    await nothingStored(d);
  });

  it('E602 R-MLS-3: (a) a comp\'s close price or size corrected after prepare is SALE_CHANGED; (b) an attribution change after the preview is REPORT_CHANGED; (c) a stored MLS data date outside the freshness window is DATA_OLD; nothing stored', async () => {
    await withPlatformCmaCleared(h, async () => {
      for (const col of ['close_price_cents = close_price_cents + 100000', 'sqft = sqft + 10']) {
        const d = await draftFor();
        const pv = await preview(d.id);
        await h.su.query(`UPDATE listings SET ${col} WHERE id = $1`, [d.view.comps[0]!.saleListingId]);
        const p2 = await preview(d.id);
        expect([col, p2.stale, p2.canShare, p2.sentence]).toEqual([col, 'SALE_CHANGED', false, 'A sale changed since this CMA was prepared. Prepare it again.']);
        const r = await shareFrom(agent(), pv);
        expect([col, r.status, errorOf(r).details]).toEqual([col, 409, { reason: 'SALE_CHANGED' }]);
        await nothingStored(d);
      }
      const d = await draftFor();
      const pv = await preview(d.id);
      await setPack(w.mls, { ...cmaPack(), attribution_text: 'A changed attribution (fixture).' });
      try {
        const r = await shareFrom(agent(), pv);
        expect([r.status, errorOf(r).details]).toEqual([409, { reason: 'REPORT_CHANGED' }]);
      } finally {
        await setPack(w.mls, cmaPack());
      }
      await nothingStored(d);
      const old = await draftFor();
      const pvOld = await preview(old.id);
      await h.su.query("UPDATE cma_reports SET mls_data_as_of = now() - interval '3 days' WHERE id = $1", [old.id]);
      const p3 = await preview(old.id);
      expect([p3.stale, p3.sentence]).toEqual(['DATA_OLD', 'Prepare it again to use the latest sales.']);
      const r3 = await shareFrom(agent(), { ...pvOld, reportSha256: p3.reportSha256 });
      expect([r3.status, errorOf(r3).details]).toEqual([409, { reason: 'DATA_OLD' }]);
      await nothingStored(old);
    });
  });
});

describe('E609 E610 never shared', () => {
  it('E609: (a) a research CMA is CMA_NO_RECIPIENT; (b) a listing-subject CMA with a contact is CMA_NO_RECIPIENT LISTING_SUBJECT; nothing stored', async () => {
    const research = await call<CmaBody>(agent(), 'POST', '/cma', { purpose: 'other', subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110' }, facts: { propertyType: 'single_family', sqft: 1400 } } });
    expect(research.status).toBe(201);
    const a = await sharePreview(agent(), research.body.cma.id);
    expect([a.status, errorOf(a).code, errorOf(a).details]).toEqual([422, 'CMA_NO_RECIPIENT', { reason: 'NO_CONTACT' }]);
    const s = await emailSeller(w, agent());
    const team = await teamListing(agent(), { addressLine1: '609 Sample Avenue' });
    const lst = await call<CmaBody>(agent(), 'POST', '/cma', { purpose: 'buyer_offer', contactId: s.c, subject: { kind: 'listing', listingId: team } });
    expect(lst.status).toBe(201);
    await withPlatformCmaCleared(h, async () => {
      const b = await sharePreview(agent(), lst.body.cma.id);
      expect([b.status, errorOf(b).details]).toEqual([422, { reason: 'LISTING_SUBJECT' }]);
      const point = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email'", [s.c])).rows[0].id;
      const r = await call(agent(), 'POST', `/cma/${lst.body.cma.id}/share`, { recipientContactId: s.c, toPointId: point, contentSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64) });
      expect([r.status, errorOf(r).code, errorOf(r).details]).toEqual([422, 'CMA_NO_RECIPIENT', { reason: 'LISTING_SUBJECT' }]);
    });
    expect(await messagesOf(s.c)).toBe(0);
  });

  it('E610 R-OWN-24: a CMA of a contact merged away is CONTACT_MERGED at preview and share', async () => {
    const d = await draftFor();
    const survivor = await emailSeller(w, agent(), { name: 'Pat Survivor' });
    const pv = await withPlatformCmaCleared(h, () => preview(d.id));
    const { command } = await import('../leads/testing.js');
    expect((await command(w.owner, survivor.c, 'merge', { loserId: d.c, ownerChoice: agent().userId })).status).toBe(200);
    expect(errorOf(await sharePreview(agent(), d.id)).code).toBe('CONTACT_MERGED');
    const r = await shareFrom(agent(), pv);
    expect([r.status, errorOf(r).code]).toEqual([409, 'CONTACT_MERGED']);
  });
});

describe('E608 fair housing on the agent\'s text', () => {
  it('R-FH-1 E608: a hard term in the notes is CMA_FAIR_HOUSING with its term id; a soft one is shown and the share goes, its term id audited; appraisal wording is a "Check this"', async () => {
    const d = await draftFor();
    await withPlatformCmaCleared(h, async () => {
      expect((await call(agent(), 'PATCH', `/cma/${d.id}`, { notes: 'Adults only building.' })).status).toBe(200);
      const hard = await preview(d.id);
      expect([hard.canShare, hard.fairHousing.hard.map((m) => [m.termId, m.where]), hard.sentence]).toEqual([false, [['fh.familial.adults_only', 'notes']], 'Edit the notes: this can’t be sent.']);
      const r = await shareFrom(agent(), hard);
      expect([r.status, errorOf(r).code, errorOf(r).details]).toEqual([422, 'CMA_FAIR_HOUSING', { termIds: ['fh.familial.adults_only'] }]);
      expect(await messagesOf(d.c)).toBe(0);
      expect((await call(agent(), 'PATCH', `/cma/${d.id}`, { notes: 'A short walk to the church; recently appraised.' })).status).toBe(200);
      const soft = await preview(d.id);
      expect(soft.fairHousing.soft.map((m) => m.termId)).toEqual(['fh.religion.mention']);
      expect(soft.warnings).toContainEqual({ code: 'CHECK_WORDING', role: 'notes' });
      expect(soft.canShare).toBe(true);
      const ok = await shareFrom(agent(), soft);
      expect(ok.status).toBe(200);
      const a = await h.su.query("SELECT changes FROM audit_log WHERE action = 'cma.shared' AND entity_id = $1", [d.id]);
      expect(a.rows[0].changes.soft_term_ids).toEqual({ from: null, to: ['fh.religion.mention'] });
    });
  });
});

describe('E600 E618 races', () => {
  it('E600: two concurrent POSTs give one message and one share; both answer 200 with the same message id', async () => {
    const d = await draftFor();
    await withPlatformCmaCleared(h, async () => {
      const pv = await preview(d.id);
      const [a, b] = await Promise.all([shareFrom(agent(), pv), shareFrom(agent(), pv)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.message.id).toBe(b.body.message.id);
      expect([a.body.message.result, b.body.message.result].sort()).toEqual(['replayed', 'sent']);
      expect(await messagesOf(d.c)).toBe(1);
      expect(sent(d.email).length).toBe(1);
      // a later retry replays too
      const c = await shareFrom(agent(), pv);
      expect([c.status, c.body.message.id, c.body.message.result]).toEqual([200, a.body.message.id, 'replayed']);
    });
  });

  it('E618 R-PERM-5: the contact reassigned between preview and tap is 404, nothing stored', async () => {
    const d = await draftFor();
    await withPlatformCmaCleared(h, async () => {
      const pv = await preview(d.id);
      const { command } = await import('../leads/testing.js');
      expect((await command(w.owner, d.c, 'reassign', { toUserId: w.agents[1]!.userId })).status).toBe(200);
      expect((await shareFrom(agent(), pv)).status).toBe(404);
    });
    await nothingStored(d);
  });
});

describe('audit', () => {
  it('R-AUDIT-5 R-TEN-7: cma.shared holds ids, codes and the method version only: no cents, no address, no text', async () => {
    const d = await draftFor({ line1: '4321 Audit Avenue' });
    const r = await withPlatformCmaCleared(h, async () => shareFrom(agent(), await preview(d.id)));
    expect(r.status).toBe(200);
    const a = (await h.su.query("SELECT changes, actor_user_id FROM audit_log WHERE action = 'cma.shared' AND entity_id = $1", [d.id])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].actor_user_id).toBe(agent().userId);
    expect(Object.keys(a[0].changes).sort()).toEqual(['connection_ids', 'message_id', 'method_version', 'recipient_contact_id', 'soft_term_ids']);
    const text = JSON.stringify(a[0].changes);
    expect(text).not.toMatch(/Audit Avenue|4321|Oakland|\$|estimate/);
    for (const cents of [d.view.result.lowCents, d.view.result.highCents, d.view.result.valueCents]) expect(text).not.toContain(String(cents));
    expect(a[0].changes.message_id.to).toBe(r.body.message.id);
  });
});
