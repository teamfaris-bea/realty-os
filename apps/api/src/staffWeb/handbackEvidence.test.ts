// E662 (module 55 verify 1): handbacks whose claims cite a stored field carry the locator `{kind:'field', field}`
// (voice/handback.ts: the voice outcome and the appointment time; comms/inbound.ts: a missed call's status during an
// enrollment, an auto-reply header). The evidence formatter read only `locator.name`, so the recipient's inbox and
// task reads answered 500. These are the recipient's own reads, on real Postgres with the fake providers.
import { randomUUID } from 'node:crypto';
import { renderStep, signOffFor } from '@realty/core/assistant';
import { SCRIPTS } from '@realty/core/voice/testing';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call } from '../admin/testing.js';
import { queueOutboundInTx } from '../comms/compose.js';
import { ownedContact, playbookFixture, sid, telephonyWebhook } from '../comms/testing.js';
import { type VoiceWorld, aiCall, handbacksOf, setVoicePack, voiceWorld } from '../voice/testing.js';
import { evidenceForClaims } from '../workspace/repos/evidence.js';
import { systemActor } from '../worker/systemActor.js';

let h: ApiHarness;
let w: VoiceWorld;
beforeAll(async () => {
  h = await createApiHarness();
  await setVoicePack(h, { reviewed: true, vendorReady: true });
  w = await voiceWorld(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

type Inbox = { items: { id: string; kind: string; claims: { text: string; evidence: { label: string; locator: Record<string, unknown> }[] }[] }[] };
const fieldClaimsOf = async (actionId: string) =>
  (await h.su.query<{ id: string; locator: Record<string, unknown> }>("SELECT c.id, e.locator FROM assistant_claims c JOIN evidence_refs e ON e.claim_id = c.id WHERE c.action_id = $1 AND e.locator->>'kind' = 'field'", [actionId])).rows;

const step = { stepKey: 'checkin', channel: 'sms', delay: { anchor: 'enrollment', offsetSeconds: 0 }, purpose: 'informational', category: 'reminder', intent: 'appointment_reminder', template: 'Reminder: your showing is tomorrow at 10.', personalization: 'none', slots: [], maxLength: 640, stopIf: [] };

describe('E662: field-locator evidence on a handback (verify 1)', () => {
  it('E662 R-STAFF-9: the recipient of a voice handback reads GET /assistant/inbox (200), and its call-field evidence is worded by the field (the web shows the claim text, never the stored value)', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking);
    const hb = (await handbacksOf(h, c.callId))[0]!;
    const fields = await fieldClaimsOf(hb.id);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.every((f) => typeof f.locator.field === 'string' && f.locator.name === undefined)).toBe(true);
    const r = await call<Inbox>(w.agents[0]!, 'GET', '/assistant/inbox');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const card = r.body.items.find((a) => a.id === hb.id);
    expect(card).toBeDefined();
    const labels = card!.claims.flatMap((x) => x.evidence.map((e) => e.label));
    expect(labels.some((l) => /voice outcome|starts at/.test(l))).toBe(true);
  });

  it('E662: the task read path (workspace/repos/evidence.ts) words the same claims', async () => {
    const c = await aiCall(h, w, SCRIPTS.booking);
    const hb = (await handbacksOf(h, c.callId))[0]!;
    const ids = (await fieldClaimsOf(hb.id)).map((x) => x.id);
    const actor = w.agents[0]!.actor();
    const ev = await withTenantTx(actor, (tx) => evidenceForClaims(tx, actor, w.deps.envelope, ids), { db: h.database });
    expect([...ev.values()].flat().length).toBe(ids.length);
    const t = await call(w.agents[0]!, 'GET', '/tasks');
    expect(t.status).toBe(200);
  });

  it('E662: a missed call during an active enrollment hands back with a field claim (status), and the inbox answers 200', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const s = (await h.su.query<{ b: string; t: string | null }>('SELECT brokerage_legal_name AS b, team_name AS t FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!;
    const r0 = renderStep(step as never, {}, { signOff: signOffFor({ scope: 'team', agentFirstName: null, teamName: s.t ?? s.b }), brokerageName: s.b, firstInThread: true });
    if (!r0.ok) throw new Error('render');
    const pb = await playbookFixture(h, w.tenantId, w.owner, c.id, { scope: 'team', step, body: r0.text, category: 'reminder', purpose: 'informational' });
    const q = await withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => queueOutboundInTx(tx, w.deps, { contactId: c.id, channel: 'sms', body: r0.text, initiator: 'assistant', purpose: 'informational', category: 'reminder', assistantActionId: pb.actionId, playbookStepRunId: pb.stepRunId, idempotencyKey: `n:${randomUUID()}`, scheduleAt: (Date.now() + 3600_000) as never }, now), { db: h.database });
    expect(q.ok).toBe(true);
    const r = await telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: sid('CA'), From: c.phone, To: w.mainNumber, CallStatus: 'no-answer', Direction: 'inbound' });
    expect(r.statusCode).toBe(200);
    const hb = (await h.su.query<{ id: string }>("SELECT id FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'", [c.id])).rows;
    expect(hb).toHaveLength(1);
    expect((await fieldClaimsOf(hb[0]!.id)).map((x) => x.locator)).toEqual([{ kind: 'field', field: 'status' }]);
    const inbox = await call<Inbox>(agent, 'GET', '/assistant/inbox');
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    expect(inbox.body.items.some((a) => a.id === hb[0]!.id)).toBe(true);
  });
});
