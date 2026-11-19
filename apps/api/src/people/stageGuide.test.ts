// The stage guide through the API (R-STG-1): GET /stage-labels and the contact detail say what each stage means.
// Additive: every field these routes returned before is still there with the same meaning.
import { randomUUID } from 'node:crypto';
import { STAGES, STAGE_GUIDE } from '@realty/core/parity/people';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, randomPhone } from '../comms/testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  agent = w.agents[0]!;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

type GuideRow = { key: string; label: string; definition: string; notThis: string };

async function person(by: TestClient): Promise<string> {
  const r = await call<{ contact: { id: string } }>(by, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Jane', lastName: 'Doe', phones: [randomPhone()] });
  if (r.status !== 201) throw new Error(`create ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.contact.id;
}

describe('the stage guide through the API (R-STG-1)', () => {
  it('R-STG-1 GET /stage-labels returns the eight stages in order, each with its label, definition and "does not mean"', async () => {
    const r = await call<{ labels: Record<string, string>; stages: GuideRow[] }>(agent, 'GET', '/stage-labels');
    expect(r.status).toBe(200);
    expect(r.body.labels).toEqual({});
    expect(r.body.stages).toEqual(STAGES.map((key) => ({ key, label: STAGE_GUIDE[key].label, definition: STAGE_GUIDE[key].definition, notThis: STAGE_GUIDE[key].notThis })));
  });

  it('R-STG-1 R-PAR-13 a tenant label wins for the label; the definition and "does not mean" do not change; PUT answers the same shape', async () => {
    const put = await call<{ labels: Record<string, string>; stages: GuideRow[] }>(w.owner, 'PUT', '/stage-labels', { labels: { nurture: 'Long term' } });
    expect(put.status).toBe(200);
    const want = STAGES.map((key) => ({ key, label: key === 'nurture' ? 'Long term' : STAGE_GUIDE[key].label, definition: STAGE_GUIDE[key].definition, notThis: STAGE_GUIDE[key].notThis }));
    expect(put.body.stages).toEqual(want);
    const got = await call<{ labels: Record<string, string>; stages: GuideRow[] }>(agent, 'GET', '/stage-labels');
    expect(got.body).toEqual({ labels: { nurture: 'Long term' }, stages: want });
    expect((await call(w.owner, 'PUT', '/stage-labels', { labels: {} })).status).toBe(200);
  });

  it('R-STG-1 the contact detail says what the person\'s stage means and carries the whole guide for the picker', async () => {
    const id = await person(agent);
    type Details = { details: { stage: { stage: string; label: string; definition: string; notThis: string; locked: string[]; lockedReason: string | null }; stageLabels: Record<string, string>; stageGuide: GuideRow[] } };
    const d = (await call<Details>(agent, 'GET', `/contacts/${id}/details`)).body.details;
    // what was there before is unchanged
    expect(d.stage).toMatchObject({ stage: 'new', label: 'New lead', locked: [], lockedReason: null });
    expect(d.stageLabels).toEqual({});
    // new: the current stage's two lines, and the guide of all eight
    expect(d.stage.definition).toBe(STAGE_GUIDE.new.definition);
    expect(d.stage.notThis).toBe(STAGE_GUIDE.new.notThis);
    expect(d.stageGuide).toEqual(STAGES.map((key) => ({ key, label: STAGE_GUIDE[key].label, definition: STAGE_GUIDE[key].definition, notThis: STAGE_GUIDE[key].notThis })));
    // the stage route's own answer carries the same two lines for the stage it just set
    const s = await call<{ stage: { stage: string; label: string; definition: string; notThis: string } }>(agent, 'POST', `/contacts/${id}/stage`, { stage: 'attempting' });
    expect(s.body.stage).toMatchObject({ stage: 'attempting', label: 'Trying to reach', definition: STAGE_GUIDE.attempting.definition, notThis: STAGE_GUIDE.attempting.notThis });
  });
});
