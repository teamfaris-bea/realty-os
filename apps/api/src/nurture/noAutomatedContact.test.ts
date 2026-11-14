// b18 review B18S-5 (owner product boundary, 2026-11-14): a module 26 trigger message (a price drop, a home value, an
// anniversary, a deal date) is automated contact, so none goes to a person a lead source marked "No automated contact
// for leads from this source" sent: the firing is skipped with a visible reason (SOURCE_NO_AUTOMATED_CONTACT), never
// silently and never sent; a person from another source still gets theirs. A made-up source; fakes only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call, messagesOf, ownedContact } from '../assistant/testing.js';
import { freshReauth } from '../comms/testing.js';
import { NO_AUTOMATED_CONTACT_LABEL, SOURCE_NO_AUTOMATED_CONTACT } from '../leads/automatedContact.js';
import { type NurtureWorld, approveTemplate, firingsDue, follow, mlsRecord, nurtureWorld, reconcileAndRun, triggerRuns } from './testing.js';

let h: ApiHarness;
let w: NurtureWorld;
let marked: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await nurtureWorld(h);
  await approveTemplate(w.agents[0]!, 'behavior_alerts');
  marked = (await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referral (test)', kind: 'portal' })).body.source.id;
  await freshReauth(h, w.owner);
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked}/ai-care`, { noAiCare: true })).status).toBe(200);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

let n = 7700;
async function dropFor(contactId: string): Promise<void> {
  const k = (n += 1);
  const lid = await mlsRecord(h, w, k, { ListPrice: 500000 });
  await follow(h, w.tenantId, lid, contactId);
  await mlsRecord(h, w, k, { ListPrice: 460000 });
  await firingsDue(h, contactId);
}
const alerts = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'search_alert');

describe('R-LSRC-8 B18S-5: no module 26 trigger message for a lead from a source marked "No automated contact"', () => {
  it('B18S-5 E727: a price-drop firing for such a person is skipped SOURCE_NO_AUTOMATED_CONTACT with a sentence and nothing is sent; another person gets the alert', async () => {
    const c = await ownedContact(w.agents[0]!);
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [c.id, marked]);
    const plain = await ownedContact(w.agents[0]!);
    await dropFor(c.id);
    await dropFor(plain.id);
    await reconcileAndRun(h, w.tenantId);
    expect(await alerts(c.id)).toEqual([]);
    expect(h.providers.email.sent.filter((m) => m.to === c.email)).toEqual([]);
    const [run] = await triggerRuns(h, c.id);
    expect(run!.status).toBe('skipped_ineligible');
    const skip = (run!.trigger_ref as { skip?: { reason: string; text: string } }).skip;
    expect(skip?.reason).toBe(SOURCE_NO_AUTOMATED_CONTACT);
    expect(skip?.text).toContain(NO_AUTOMATED_CONTACT_LABEL);
    expect((await alerts(plain.id)).map((m) => m.status)).toEqual(['sent']);
  });
});
