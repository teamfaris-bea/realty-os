// R-MLS-7 for saved searches through real Postgres: MLS listings synced under the Spark mapping have no size (no field
// is confirmed as finished living area), so a size criterion can match only team listings. The assistant's size
// criteria are held for the agent's check, and the review and preview say why in words, never silently. Fakes only:
// a deterministic record feed and a scripted model; nothing is sent and no MLS is called. E611.
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@realty/core/foundation';
import type { ResoLike } from '@realty/core/listings';
import { MLS_SIZE_NONE_SENTENCE, MLS_SIZE_SOME_SENTENCE } from '@realty/core/assistant';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { syncConnection } from '../mls/sync.js';
import { makeDue, mlsConnection, mlsDeps, pagedFeed, reso } from '../mls/testing.js';
import { SPARK_FIELD_MAPPING } from '../providers/integrations/spark.js';
import { systemActor } from '../worker/systemActor.js';
import { summarizeCall } from './callPipeline.js';
import { type AssistantWorld, assistantWorld, call, depsOf, listing, ownedContact, transcribedCall } from './testing.js';

let h: ApiHarness;
let spark: AssistantWorld;
let sized: AssistantWorld;
let noMls: AssistantWorld;

type View = { search: { criteria: Record<string, unknown>; unchecked: string[]; prefill: Record<string, unknown>; sizeNote: string | null; matches: { source: string; postalCode: string }[] } };

async function syncActive(w: AssistantWorld, records: ResoLike[], fields: Record<string, string | null>): Promise<void> {
  const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
  await makeDue(h, conn);
  const r = await syncConnection(mlsDeps(h, { [conn]: { ...pagedFeed([records]), fields } }), w.tenantId as TenantId, conn);
  expect(r).toMatchObject({ outcome: 'synced', inserted: records.length });
}

/** A search stored as the assistant would (proposed), for a new contact of the world's agent 0. */
async function search(w: AssistantWorld, criteria: Record<string, unknown>): Promise<string> {
  const c = await ownedContact(w.agents[0]!);
  const id = randomUUID();
  await h.su.query(`INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'Size','proposed',$4::jsonb,'{}'::jsonb)`, [w.tenantId, id, c.id, JSON.stringify(criteria)]);
  return id;
}
const preview = async (w: AssistantWorld, id: string) => (await call<View>(w.agents[0]!, 'GET', `/saved-searches/${id}/preview`)).body.search;

beforeAll(async () => {
  h = await createApiHarness();
  spark = await assistantWorld(h, { agents: 1 });
  sized = await assistantWorld(h, { agents: 1 });
  noMls = await assistantWorld(h, { agents: 1 });
  // the Spark tenant: active MLS listings in 94611 with LivingArea and BuildingAreaTotal in the record, stored without a size
  await syncActive(spark, [6111, 6112, 6113].map((i) => reso(i, { PostalCode: '94611', LivingArea: 1800, BuildingAreaTotal: 2400 })), SPARK_FIELD_MAPPING);
  // a tenant whose feed has a size field (the RESO default LivingArea)
  await syncActive(sized, [6121, 6122].map((i) => reso(i, { PostalCode: '94612', LivingArea: 1800 })), {});
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('E611 R-MLS-7: a saved-search size criterion while the MLS gives no size', () => {
  it('E611 R-MLS-7: the preview says a size criterion matches only team listings; without it the MLS listings match; the team listing with a size still does', async () => {
    const team = await listing(h, spark, spark.agents[0]!.userId!, { postalCode: '94611' }); // sqft 1500
    const withSize = await preview(spark, await search(spark, { postalCodes: ['94611'], sqftMin: 1500 }));
    expect(withSize.sizeNote).toBe(MLS_SIZE_NONE_SENTENCE);
    expect(withSize.matches.map((m) => m.source)).toEqual(['team']);
    const without = await preview(spark, await search(spark, { postalCodes: ['94611'] }));
    expect(without.sizeNote).toBeNull();
    expect(without.matches.filter((m) => m.source === 'mls')).toHaveLength(3);
    expect(team).toBeTruthy();
  });

  it('E611 R-MLS-7: a feed with sizes needs no note; a second feed without them makes it "some listings"', async () => {
    const id = await search(sized, { postalCodes: ['94612'], sqftMax: 2000 });
    const v = await preview(sized, id);
    expect(v.sizeNote).toBeNull();
    expect(v.matches.filter((m) => m.source === 'mls')).toHaveLength(2);
    await syncActive(sized, [6123].map((i) => reso(i, { PostalCode: '94612', LivingArea: 1800 })), SPARK_FIELD_MAPPING);
    expect((await preview(sized, id)).sizeNote).toBe(MLS_SIZE_SOME_SENTENCE);
  });

  it('E611 R-MLS-7 R-AST-5: the assistant\'s size criterion from a call is held for the agent\'s check (prefilled, unchecked) and the review says why; the rest is stored', async () => {
    const searchId = await proposeFromCall(spark);
    const stored = (await h.su.query('SELECT criteria FROM saved_searches WHERE id = $1', [searchId])).rows[0];
    expect(stored.criteria).toEqual({ postalCodes: ['94611'] });
    const v = await preview(spark, searchId);
    expect(v.unchecked).toEqual(['sqftMin']);
    expect(v.prefill).toEqual({ sqftMin: 1500 });
    expect(v.sizeNote).toBe(MLS_SIZE_NONE_SENTENCE);
  });

  it('E611 R-MLS-7: without an MLS feed (team listings only, which carry their sizes) the size criterion is stored as proposed and nothing is said', async () => {
    const searchId = await proposeFromCall(noMls);
    expect((await h.su.query('SELECT criteria FROM saved_searches WHERE id = $1', [searchId])).rows[0].criteria).toEqual({ postalCodes: ['94611'], sqftMin: 1500 });
    const v = await preview(noMls, searchId);
    expect([v.unchecked, v.sizeNote]).toEqual([[], null]);
  });
});

/** A call where the client gives a ZIP code and a smallest size, both verified; returns the proposed search. */
async function proposeFromCall(w: AssistantWorld): Promise<string> {
  const agent = w.agents[0]!;
  const c = await ownedContact(agent);
  const segments = [
    { startMs: 0, endMs: 10_000, speaker: 'agent', text: 'What are you looking for?' },
    { startMs: 10_000, endMs: 30_000, speaker: 'client', text: 'Something in 94611, at least 1500 square feet.' },
  ];
  const callId = await transcribedCall(h, w, c.id, agent.userId!, segments);
  const ev = (snippet: string) => [{ source: 'S1', locator: { kind: 'transcript_offset', start_ms: 10_000, end_ms: 30_000 }, snippet }];
  const output = {
    explanation: 'Search criteria from the call.',
    claims: [
      { kind: 'preference', text: 'In 94611', criterion: { key: 'postal_codes', value: ['94611'] }, needs_review: false, evidence: ev('Something in 94611') },
      { kind: 'preference', text: 'At least 1,500 sq ft', criterion: { key: 'sqft_min', value: 1500 }, needs_review: false, evidence: ev('at least 1500 square feet') },
    ],
  };
  h.providers.ai.scripted.push({ text: JSON.stringify({ claims: [] }) }, { text: JSON.stringify(output) });
  const r = await summarizeCall(systemActor(w.tenantId, 'assistant'), callId, depsOf(h));
  const searchId = (r as { searchId: string }).searchId;
  expect(searchId).toBeTruthy();
  return searchId;
}
