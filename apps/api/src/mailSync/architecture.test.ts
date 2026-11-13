// Architecture test of module 68 (R-GMAIL-14, R-GMAIL-4 / S-D2-7; PHASE2_3_PLAN §5.4 #68 "Architecture test"): source
// scans of apps/api/src. The lint rule realty/mail-sync-boundary enforces the same in the editor; this proves it over
// the real files, including the transitive import closure of mailSync (no path from it reaches a model provider).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : files(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && !n.endsWith('testing.ts') && !p.includes('/testing/') ? [p] : [];
  });
}
const SOURCES = files(SRC).map((p) => ({ rel: relative(SRC, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }));
const byRel = new Map(SOURCES.map((f) => [f.rel, f.text]));
const TABLE = /(?<![A-Za-z0-9_])(mail_messages|user_mail_links)(?![A-Za-z0-9_])/;
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/** The body of a top-level function `name` in `text` (from its declaration to the next top-level declaration). */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`export async function ${name}(`);
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/\n(export |async function |function |const [A-Z_]+ =)/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

/**
 * Value imports (not `import type`) of a file's text, resolved to apps/api/src-relative paths: static imports and
 * re-exports, side-effect imports, and dynamic `import('./x.js')` (a runtime value import the static form would miss;
 * batch 13 audit ISA2B-03). A `typeof import('./x.js')` is a type and does not count.
 */
function importTargets(rel: string, text: string): string[] {
  const out: string[] = [];
  const specs = [
    ...[...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)].map((m) => m[1]!),
    ...[...text.matchAll(/^\s*import\s+'(\.[^']+)'/gm)].map((m) => m[1]!),
    ...[...text.matchAll(/(?<!\btypeof\s*)\bimport\s*\(\s*'(\.[^']+)'\s*\)/g)].map((m) => m[1]!),
  ];
  for (const s of specs) out.push(normalize(join(dirname(rel), s)).replaceAll('\\', '/').replace(/\.js$/, '.ts'));
  return out;
}
const valueImports = (rel: string): string[] => importTargets(rel, byRel.get(rel) ?? '');

describe('module 68 architecture (R-GMAIL-14)', () => {
  it('R-GMAIL-14: no SQL names mail_messages or user_mail_links outside apps/api/src/mailSync/**, except module 68’s flagged ingestSyncedMailInTx in comms/inbound.ts', () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      if (f.rel.startsWith('mailSync/')) continue;
      let text = stripComments(f.text);
      if (f.rel === 'comms/inbound.ts') text = text.replace(functionBody(text, 'ingestSyncedMailInTx'), '');
      if (TABLE.test(text)) offenders.push(f.rel);
    }
    expect(offenders).toEqual([]);
    expect(TABLE.test(functionBody(byRel.get('comms/inbound.ts')!, 'ingestSyncedMailInTx'))).toBe(true);
  });

  it('R-GMAIL-14: nothing under apps/api/src/assistant/** or the model provider imports mailSync', () => {
    const offenders = SOURCES.filter((f) => (f.rel.startsWith('assistant/') || f.rel === 'providers/anthropic.ts') && /from\s+'[^']*mailSync\//.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('R-GMAIL-14: no value import path from mailSync/** reaches the model provider, the fake AI or apps/api/src/assistant/**', () => {
    const seen = new Set<string>();
    const queue = SOURCES.filter((f) => f.rel.startsWith('mailSync/')).map((f) => f.rel);
    const parents = new Map<string, string>();
    while (queue.length > 0) {
      const r = queue.shift()!;
      if (seen.has(r)) continue;
      seen.add(r);
      for (const t of valueImports(r)) {
        if (seen.has(t) || !byRel.has(t)) continue;
        if (!parents.has(t)) parents.set(t, r);
        queue.push(t);
      }
    }
    const bad = [...seen].filter((r) => r === 'providers/anthropic.ts' || r === 'providers/fake/ai.ts' || r === 'providers/fake/hostileAi.ts' || r.startsWith('assistant/'));
    const chain = (r: string) => {
      const c = [r];
      while (parents.has(c[0]!)) c.unshift(parents.get(c[0]!)!);
      return c.join(' → ');
    };
    expect(bad.map(chain)).toEqual([]);
    for (const f of SOURCES.filter((x) => x.rel.startsWith('mailSync/'))) expect(f.text, f.rel).not.toMatch(/@anthropic-ai\//);
    // the scan sees every runtime import form, so a path cannot hide behind a dynamic import() (ISA2B-03); types do not count
    const probe = [
      "import { a } from '../assistant/repos/actions.js';",
      "export * from '../voice/facts.js';",
      "import '../providers/anthropic.js';",
      "  const { runModel } = await import('../assistant/runs.js');",
      "const m = import(\n  '../providers/fake/ai.js'\n);",
      "import type { T } from '../assistant/repos/context.js';",
      "type U = typeof import('../assistant/steps.js');",
    ].join('\n');
    expect(importTargets('isa/probe.ts', probe)).toEqual(['assistant/repos/actions.ts', 'voice/facts.ts', 'providers/anthropic.ts', 'assistant/runs.ts', 'providers/fake/ai.ts']);
  });

  it('R-GMAIL-3 R-GMAIL-14: mailSync never sends: no dispatchOutbound / dialOutbound, no provider send, and the Gmail adapter has no send, modify, label, trash or delete method', () => {
    for (const f of SOURCES.filter((x) => x.rel.startsWith('mailSync/'))) {
      expect(f.text, f.rel).not.toMatch(/\b(dispatchOutbound|dialOutbound|sendSms|sendEmail|placeCall|queueOutboundInTx)\b/);
    }
    const iface = byRel.get('mailSync/provider.ts')!;
    const body = iface.slice(iface.indexOf('export interface GmailProvider'), iface.indexOf('}', iface.indexOf('export interface GmailProvider')));
    expect(body).not.toMatch(/\b(send|modify|insert|import|trash|untrash|delete|batchModify|batchDelete|labels|watch|settings)\w*\s*\(/i);
    expect(iface).toMatch(/GMAIL_SCOPES: readonly string\[\] = \[GMAIL_READONLY_SCOPE\]/);
  });

  it('R-GMAIL-10 R-GMAIL-14: ingestSyncedMailInTx enqueues no assistant.enrich_handback job, writes no messages row, quotes nothing and does not classify again', () => {
    const fn = stripComments(functionBody(byRel.get('comms/inbound.ts')!, 'ingestSyncedMailInTx'));
    expect(fn.length).toBeGreaterThan(500);
    expect(fn).not.toMatch(/enrich_handback|enqueueJob|INSERT INTO messages|insertInbound|classifyInbound|planInboundEffects|\.body\b|snippet: [^N]/);
    expect(fn).toMatch(/'mail_message'/);
    // b7 sends/F3: it counts the reply on the conversation (E27, R-AST-6); a counter is not a messages row, and it never
    // moves last_inbound_at (that would loosen R-CONSENT-5's purpose and so a marketing-only unsubscribe, D1)
    expect(fn).toMatch(/msgs\.bumpInboundSeq\(tx, conversationId\)/);
    expect(fn).not.toMatch(/bumpInbound\(|last_inbound_at/);
  });

  it('R-GMAIL-14: no code path writes a messages row, a touch, a speed-to-lead or an ownership event from synced mail', () => {
    for (const f of SOURCES.filter((x) => x.rel.startsWith('mailSync/'))) {
      const t = stripComments(f.text);
      expect(t, f.rel).not.toMatch(/INSERT INTO (messages|calls|lead_ownership_events|contact_stage_events)\b|applyOwnershipCommand|first_touch|recordTouch|speed_to_lead|bumpInbound|last_inbound_at|insertInbound/);
    }
  });

  it('R-GMAIL-4 S-D2-7: no code outside mailSync/token.ts selects user_mail_links.refresh_enc, and no route schema returns it', () => {
    // a file that never names user_mail_links cannot select its column (the calendar's own user_calendar_links.refresh_enc is not this one)
    const offenders = SOURCES.filter((f) => f.rel !== 'mailSync/token.ts' && /user_mail_links/.test(stripComments(f.text)) && /refresh_enc/.test(stripComments(f.text))).map((f) => f.rel);
    expect(SOURCES.filter((f) => /user_mail_links/.test(stripComments(f.text))).length).toBeGreaterThan(1);
    expect(offenders).toEqual([]);
    expect(stripComments(byRel.get('mailSync/routes.ts')!)).not.toMatch(/refresh|accessToken|access_token/i);
  });

  it('R-GMAIL-14: the lint rule is wired for every file set it guards', () => {
    const cfg = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');
    for (const mode of ['outside', 'no-import', 'inside']) expect(cfg).toContain(`'realty/mail-sync-boundary': ['error', { mode: '${mode}'`);
  });
});
