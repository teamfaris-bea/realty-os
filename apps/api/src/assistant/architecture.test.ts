// Architecture tests of api/assistant (R-AST-13, R-TEN-3, R-GATE-2, R-GATE-10).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { PLAYBOOK_STEP, SWEEPER_KIND_QUEUES } from '../worker/contracts.js';
import { HandlerRegistry } from '../worker/registry.js';
import { makeAssistantHandlers } from './handlers.js';
import { ASSISTANT_REQUEST_SCHEMAS, ASSISTANT_RESPONSE_SCHEMAS } from './schemas.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function keysOf(schema: z.ZodType): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.properties && typeof n.properties === 'object') for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) {
      out.push(k);
      walk(v);
    }
    for (const k of ['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties']) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
  return out;
}

describe('schemas (R-AST-13, R-TEN-3)', () => {
  it('R-AST-13: no assistant response schema carries a confidence (or score) field; every card carries explanation + evidence (snapshot of every key)', () => {
    const all = Object.fromEntries(Object.entries(ASSISTANT_RESPONSE_SCHEMAS).map(([n, s]) => [n, [...new Set(keysOf(s as z.ZodType))].sort()]));
    for (const keys of Object.values(all)) expect(keys.filter((k) => /confidence|score|probability/i.test(k))).toEqual([]);
    expect(all.InboxResponse).toEqual(expect.arrayContaining(['explanation', 'evidence', 'snippet', 'label', 'needsReview']));
    expect(all).toMatchSnapshot();
  });

  it('R-TEN-3: no assistant request schema accepts a tenant id', () => {
    for (const [name, s] of Object.entries(ASSISTANT_REQUEST_SCHEMAS)) expect(keysOf(s as z.ZodType).filter((k) => /tenant/i.test(k)), name).toEqual([]);
  });
});

describe('the one outbound path (R-GATE-2, R-GATE-10)', () => {
  it('R-GATE-2: no api/assistant source calls a provider send or dial; every message is queued through api/comms', () => {
    const OUTBOUND = /\.(sendSms|sendEmail|dialCall)\s*\(|\b(sendSms|sendEmail|dialCall)\s*:/;
    const files = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const repos = readdirSync(join(HERE, 'repos')).map((f) => join('repos', f));
    const offenders = [...files, ...repos].filter((f) => OUTBOUND.test(readFileSync(join(HERE, f), 'utf8')));
    expect(offenders).toEqual([]);
    // the queueing call sites exist (steps, approvals, alerts)
    for (const f of ['steps.ts', 'drafts.ts', 'searches.ts']) expect(readFileSync(join(HERE, f), 'utf8')).toContain('queueOutboundInTx(');
  });

  it('handlers register cleanly and follow the sweeper contract for playbook.step', () => {
    const reg = new HandlerRegistry().registerAll(makeAssistantHandlers());
    expect(reg.get(PLAYBOOK_STEP.kind)?.queue).toBe(SWEEPER_KIND_QUEUES[PLAYBOOK_STEP.kind]);
    expect(reg.kinds()).toEqual(expect.arrayContaining(['assistant.first_response', 'assistant.enrich_handback', 'assistant.call_summary', 'playbook.step']));
    expect(reg.get('assistant.first_response')?.queue).toBe('realtime');
    // payloads carry ids only (R-TEN-7)
    expect(reg.get('assistant.first_response')!.schema.safeParse({ contactId: '018f2b3c-0000-7000-8000-000000000000', phone: '+14155550100' }).success).toBe(false);
  });
});
