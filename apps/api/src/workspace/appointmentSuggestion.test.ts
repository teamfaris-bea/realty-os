// The stage an appointment's result suggests (R-STG-2): POST /appointments/:id/outcome answers `suggestedStage`, by
// the same core table and the same lock rule as the two other outcome routes (people/stageSuggestion.ts). Only a
// signed agreement suggests a stage ("Active client"), only for a person in an earlier stage, and the route never
// changes a stage itself: the agent confirms with the ordinary stage route.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { appointmentEnded, call, contactOf, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2, teamLead: true });
});
afterAll(async () => {
  await h?.close();
});

type Suggested = { stage: string; why: string; locked: boolean; alsoOffer: { stage: string; locked: boolean }[] } | null;
type OutcomeRes = { appointment: { id: string; outcome: string | null; status: string }; suggestedStage: Suggested };

const stageOf = async (id: string) => (await h.su.query<{ stage: string }>('SELECT stage FROM contacts WHERE id = $1', [id])).rows[0]!.stage;
const stageEvents = async (id: string) => (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM contact_stage_events WHERE contact_id = $1', [id])).rows[0]!.n;

/** An appointment with `contactId` that has ended, so its outcome can be logged. */
async function endedAppointment(by: TestClient, contactId: string | null): Promise<string> {
  const start = Date.now() + 3_600_000;
  const r = await call<{ appointment: { id: string } }>(by, 'POST', '/appointments', { kind: 'buyer_consult', ...(contactId ? { contactId } : {}), startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3_600_000).toISOString() });
  if (r.status !== 201) throw new Error(`appointment: ${r.status} ${JSON.stringify(r.body)}`);
  await appointmentEnded(h, r.body.appointment.id, 60_000);
  return r.body.appointment.id;
}
const outcome = (by: TestClient, id: string, result: string) => call<OutcomeRes>(by, 'POST', `/appointments/${id}/outcome`, { result });

describe('POST /appointments/:id/outcome answers the suggested stage (R-STG-2)', () => {
  it('a signed agreement suggests "active" for a person in an earlier stage, says why, and changes no stage', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a, { firstName: 'Sig' });
    expect((await call(a, 'POST', `/contacts/${c.id}/stage`, { stage: 'connected' })).status).toBe(200);
    const events = await stageEvents(c.id);
    const o = await outcome(a, await endedAppointment(a, c.id), 'agreement_signed');
    expect(o.status).toBe(200);
    expect(o.body.appointment).toMatchObject({ outcome: 'agreement_signed', status: 'held' });
    expect(o.body.suggestedStage).toEqual({ stage: 'active', why: 'They signed an agreement, so you are working together now.', locked: false, alsoOffer: [] });
    // a suggestion only: the stage and its history are exactly as they were
    expect(await stageOf(c.id)).toBe('connected');
    expect(await stageEvents(c.id)).toBe(events);
  });

  it('every other result suggests nothing: follow up, no decision, not a fit, no show', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a, { firstName: 'Nan' });
    for (const result of ['follow_up', 'no_decision', 'not_a_fit', 'no_show']) {
      const o = await outcome(a, await endedAppointment(a, c.id), result);
      expect(o.status, result).toBe(200);
      expect(o.body.suggestedStage, result).toBeNull();
    }
    expect(await stageOf(c.id)).toBe('new');
  });

  it('never suggests an earlier stage: a signed agreement for a person already active or beyond suggests nothing', async () => {
    const a = w.agents[1]!;
    const c = await contactOf(a, { firstName: 'Act' });
    for (const stage of ['active', 'under_contract']) {
      expect((await call(a, 'POST', `/contacts/${c.id}/stage`, { stage })).status).toBe(200);
      expect((await outcome(a, await endedAppointment(a, c.id), 'agreement_signed')).body.suggestedStage, stage).toBeNull();
    }
  });

  it('an appointment with no person suggests nothing', async () => {
    const a = w.agents[1]!;
    const o = await outcome(a, await endedAppointment(a, null), 'agreement_signed');
    expect(o.status).toBe(200);
    expect(o.body.suggestedStage).toBeNull();
  });

  it('a refused outcome answers no suggestion (the error is unchanged)', async () => {
    const a = w.agents[0]!;
    const c = await contactOf(a, { firstName: 'Fut' });
    const start = Date.now() + 86_400_000;
    const r = await call<{ appointment: { id: string } }>(a, 'POST', '/appointments', { kind: 'consult', contactId: c.id, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3_600_000).toISOString() });
    const o = await outcome(a, r.body.appointment.id, 'agreement_signed');
    expect(o.code).toBe('VALIDATION_FAILED');
    expect((o.body as unknown as Record<string, unknown>).suggestedStage).toBeUndefined();
  });
});
