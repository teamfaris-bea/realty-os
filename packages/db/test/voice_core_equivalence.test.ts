// Module 47 (core/voice) equivalence test, kept beside the DB tests it mirrors (packages/core is pure:
// no database, even in tests), as module 19 did with compliance_v3_equivalence.test.ts.
//
// R-VOICE-4: core's closed tool set, argument allowlist, outcomes, appointment kinds and reason codes
// are the freshly migrated catalog's, read from pg_constraint / pg_proc (never a migration file):
//   - VOICE_LEDGER_TOOLS = the voice_tool_calls.tool CHECK
//   - on generated argument vectors, a core allow ⇒ app.voice_tool_args_ok is true, and a DB false ⇒ a
//     core deny; every ledger projection core emits passes app.voice_tool_args_ok
//   - VoiceOutcome / TransferOutcome = the calls CHECKs; book_appointment kinds = appointments.kind
//   - every core reason code matches the voice_tool_calls.reason_code CHECK
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPOINTMENT_KINDS,
  END_CALL_REASONS,
  MESSAGE_TOPICS,
  OPT_OUT_TOOL_CHANNELS,
  TRANSFER_OUTCOMES,
  VOICE_ANSWER_WHEN,
  VOICE_LEDGER_TOOLS,
  VOICE_OUTCOMES,
  VOICE_REASON_CODES,
  type VoiceLedgerTool,
  TOOL_ARG_KEYS,
  decideToolCall,
  ledgerProjection,
  toolArgsValid,
} from '@realty/core/voice';
import { HOT_CLAIMS, OTHER_MEMBER_ID, OWNER_ID, SESSION_START, SLOT_A, SLOT_ARGS, openSession, voiceFacts } from '@realty/core/voice/testing';
import { createTestDb, type TestDb } from '../src/testing/index.js';

let db: TestDb;
let client: pg.Client;
beforeAll(async () => {
  db = await createTestDb();
  client = new pg.Client({ connectionString: db.ownerUrl });
  await client.connect();
});
afterAll(async () => {
  await client?.end();
  await db?.drop();
});

/** The CHECK definitions on `table` that mention `column`. */
async function checksOn(table: string, column: string): Promise<string[]> {
  const r = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND t.relnamespace = 'public'::regnamespace AND c.contype = 'c'`,
    [table],
  );
  return r.rows.map((x) => x.def).filter((d) => new RegExp(`\\(\\(?${column}\\b|\\b${column} = ANY|\\b${column}\\)? ~`).test(d));
}

/** The quoted values of the one `column IN (...)` CHECK on `table`. */
async function checkValues(table: string, column: string): Promise<string[]> {
  const defs = (await checksOn(table, column)).filter((d) => d.startsWith(`CHECK ((${column} = ANY (ARRAY[`));
  expect(defs, `${table}.${column}`).toHaveLength(1);
  return [...(defs[0] as string).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] as string).sort();
}

describe('R-VOICE-4 the closed sets are the catalog\'s', () => {
  it('R-VOICE-4 the core closed tool set equals the voice_tool_calls.tool CHECK', async () => {
    expect(await checkValues('voice_tool_calls', 'tool')).toEqual([...VOICE_LEDGER_TOOLS].sort());
  });

  it('VoiceOutcome and TransferOutcome equal the calls CHECKs', async () => {
    expect(await checkValues('calls', 'voice_outcome')).toEqual([...VOICE_OUTCOMES].sort());
    expect(await checkValues('calls', 'transfer_outcome')).toEqual([...TRANSFER_OUTCOMES].sort());
  });

  it('book_appointment kinds equal the appointments.kind CHECK; the answer modes equal tenant_settings.voice_answer_when', async () => {
    expect(await checkValues('appointments', 'kind')).toEqual([...APPOINTMENT_KINDS].sort());
    expect(await checkValues('tenant_settings', 'voice_answer_when')).toEqual([...VOICE_ANSWER_WHEN].sort());
  });

  it('every core reason code matches the voice_tool_calls.reason_code CHECK (an allow carries one too)', async () => {
    const defs = await checksOn('voice_tool_calls', 'reason_code');
    expect(defs).toHaveLength(1);
    const re = /~ '([^']+)'::text/.exec(defs[0] as string)?.[1];
    expect(re).toBe('^[A-Z][A-Z0-9_]*$');
    const r = await client.query<{ code: string; ok: boolean }>(`SELECT c AS code, c ~ $2 AS ok FROM unnest($1::text[]) AS c`, [[...VOICE_REASON_CODES], re]);
    expect(r.rows.filter((x) => !x.ok).map((x) => x.code)).toEqual([]);
    expect(r.rows).toHaveLength(VOICE_REASON_CODES.length);
  });

  it('app.voice_tool_args_ok knows exactly the closed set (anything else is false)', async () => {
    const r = await client.query<{ t: string; ok: boolean }>(`SELECT t, app.voice_tool_args_ok(t, '{}'::jsonb) AS ok FROM unnest($1::text[]) AS t`, [[...VOICE_LEDGER_TOOLS, 'dial_number', 'transfer_to_owner', 'share_listing_facts', '']]);
    const ok = Object.fromEntries(r.rows.map((x) => [x.t, x.ok]));
    // with no arguments, only book_appointment (which needs a slot) is false among the six
    expect(ok).toEqual({ check_availability: true, book_appointment: false, warm_transfer: true, take_message: true, record_opt_out: true, end_call: true, dial_number: false, transfer_to_owner: false, share_listing_facts: false, '': false });
  });
});

// ---- generated argument vectors -------------------------------------------------------------------

const VALUES: readonly unknown[] = [
  '2026-11-14T15:00:00Z',
  '2026-11-14T15:30:00.000Z',
  '2026-11-14T10:00-05:00',
  '2026-11-14T15:00:00.123456789Z',
  '2026-11-14T15:00:00',
  '2026-02-30T10:00:00Z',
  '2026-13-01T10:00:00Z',
  '2026-11-14T25:00:00Z',
  '2026-11-14 15:00:00Z',
  'tomorrow at 3',
  OWNER_ID,
  OWNER_ID.toUpperCase(),
  OTHER_MEMBER_ID,
  '+15550100199',
  ...APPOINTMENT_KINDS,
  'showing',
  ...MESSAGE_TOPICS,
  'ANY_CODE',
  'lower_code',
  'A'.repeat(65),
  ...OPT_OUT_TOOL_CHANNELS,
  'email',
  ...END_CALL_REASONS,
  'caller was rude',
  '',
  ' PRICE',
  'PRICE\n',
  7,
  true,
  null,
  { code: 'PRICE' },
  ['PRICE'],
];
const ALL_KEYS = [...new Set(Object.values(TOOL_ARG_KEYS).flat()), 'note', 'number', 'summary', '__proto__'];

const argsArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 8, arbitrary: fc.dictionary(fc.constantFrom(...ALL_KEYS), fc.constantFrom(...VALUES), { maxKeys: 4 }) },
  // shapes built from a tool's own keys, so allows are frequent
  {
    weight: 8,
    arbitrary: fc.constantFrom(...VOICE_LEDGER_TOOLS).chain((t) => fc.dictionary(fc.constantFrom(...TOOL_ARG_KEYS[t]), fc.constantFrom(...VALUES), { maxKeys: 3 })),
  },
  { weight: 1, arbitrary: fc.constantFrom<unknown>(null, [], 'x', 42, [{}]) },
);
const toolArb = fc.oneof({ weight: 9, arbitrary: fc.constantFrom<string>(...VOICE_LEDGER_TOOLS) }, { weight: 1, arbitrary: fc.constantFrom('dial_number', 'transfer_to_owner', '') });

/** Vectors the DB can hold as jsonb: the JSON round trip is what module 48 would send. */
function vectors(n: number, seed: number): { tool: string; args: unknown }[] {
  const raw = fc.sample(fc.record({ tool: toolArb, args: argsArb }), { numRuns: n, seed });
  const extra: { tool: string; args: unknown }[] = [
    { tool: 'book_appointment', args: SLOT_ARGS(SLOT_A, 'buyer_consult') },
    { tool: 'book_appointment', args: { slot_start: '2026-11-14T15:00:00Z', slot_end: '2026-11-14T15:30:00Z' } },
    { tool: 'warm_transfer', args: { target_user_id: OWNER_ID } },
    { tool: 'take_message', args: { topic: 'PRICE' } },
    { tool: 'record_opt_out', args: { channel: 'all' } },
    { tool: 'end_call', args: { reason_code: 'GOODBYE' } },
    { tool: 'check_availability', args: { from: '2026-11-14T00:00:00Z', to: '2026-11-15T00:00:00Z' } },
  ];
  return [...raw, ...extra].map((v) => ({ tool: v.tool, args: JSON.parse(JSON.stringify(v.args ?? null)) as unknown }));
}

async function dbOk(vs: readonly { tool: string; args: unknown }[]): Promise<boolean[]> {
  const r = await client.query<{ i: number; ok: boolean | null }>(
    `SELECT x.i, app.voice_tool_args_ok(x.t, x.a::jsonb) AS ok FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS x(t, a, i) ORDER BY x.i`,
    [vs.map((v) => v.tool), vs.map((v) => JSON.stringify(v.args))],
  );
  // a NULL result (a NULL jsonb) is not true
  return r.rows.map((x) => x.ok === true);
}

describe('R-VOICE-4 core arguments are identical to or stricter than app.voice_tool_args_ok', () => {
  it('R-VOICE-4 on generated vectors: a core allow ⇒ the DB is true; a DB false ⇒ a core deny', async () => {
    const vs = vectors(4000, 47);
    const ok = await dbOk(vs);
    let coreAllows = 0;
    let dbTrue = 0;
    const violations: string[] = [];
    vs.forEach((v, i) => {
      const core = (VOICE_LEDGER_TOOLS as readonly string[]).includes(v.tool) && toolArgsValid(v.tool as VoiceLedgerTool, v.args);
      if (core) coreAllows += 1;
      if (ok[i]) dbTrue += 1;
      if (core && !ok[i]) violations.push(`${v.tool} ${JSON.stringify(v.args)}`);
    });
    expect(violations).toEqual([]);
    // the vectors exercise both sides (not vacuous): many allows, and the DB accepting things core refuses
    expect(coreAllows).toBeGreaterThan(200);
    expect(dbTrue).toBeGreaterThan(coreAllows);
  });

  it('R-VOICE-4 every full decideToolCall allow is a request the DB accepts as it was made', async () => {
    const f = voiceFacts({ claims: HOT_CLAIMS });
    const s = openSession(f);
    const vs = vectors(3000, 4747);
    const ok = await dbOk(vs);
    const allows = vs.map((v, i) => ({ v, i, d: decideToolCall(s, { tool: v.tool, args: v.args, at: (SESSION_START + 10_000) as never }, f) })).filter((x) => x.d.decision === 'allow');
    expect(allows.length).toBeGreaterThan(50);
    expect(allows.filter((x) => !ok[x.i]).map((x) => `${x.v.tool} ${JSON.stringify(x.v.args)}`)).toEqual([]);
  });

  it('R-VOICE-4 every ledger projection core emits is a row the voice_tool_calls args CHECK accepts', async () => {
    const f = voiceFacts();
    const rows = vectors(4000, 470)
      .map((v) => ledgerProjection({ tool: v.tool, args: v.args, at: SESSION_START }, { optOut: null }, f))
      .filter((r) => r !== null)
      .map((r) => ({ tool: r.tool, args: r.args as unknown }));
    expect(rows.length).toBeGreaterThan(1000);
    const ok = await dbOk(rows);
    expect(rows.filter((_, i) => !ok[i]).map((r) => `${r.tool} ${JSON.stringify(r.args)}`)).toEqual([]);
  });
});
