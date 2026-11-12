// Architecture checks for module 53 (R-GBP-1, R-GBP-5, R-GATE-15, R-MKT-12): source scans of apps/api/src.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : files(p);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}
const SOURCES = files(SRC).map((p) => ({ rel: relative(SRC, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }));
// test fixtures under gbp/testing/ write through the system actor like the module; they are fixtures, not module code
const MODULE = SOURCES.filter((f) => f.rel.startsWith('gbp/') && !f.rel.startsWith('gbp/testing/'));
const specs = (t: string) => [...t.matchAll(/\bfrom\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1] ?? m[2]!);

describe('module 53 architecture', () => {
  it('R-GBP-5: only gbp/** writes gbp_reviews', () => {
    const writers = SOURCES.filter((f) => /(INSERT INTO|UPDATE)\s+gbp_reviews\b/.test(f.text)).map((f) => f.rel);
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.filter((r) => !r.startsWith('gbp/'))).toEqual([]);
  });

  it('R-GBP-1 R-GATE-15: only gbp/replies.ts imports sendReviewReply (the one postReviewReply call site, in marketing/publish.ts)', () => {
    const importers = SOURCES.filter((f) => /import\s*\{[^}]*\bsendReviewReply\b[^}]*\}\s*from/.test(f.text)).map((f) => f.rel);
    expect(importers).toEqual(['gbp/replies.ts']);
    expect(SOURCES.filter((f) => /export async function sendReviewReply\b/.test(f.text)).map((f) => f.rel)).toEqual(['marketing/publish.ts']);
    // gbp/** never calls a reserved provider method itself
    expect(MODULE.filter((f) => /\.\s*(publishPost|lookupPost|deletePost|postReviewReply)\s*\(/.test(f.text)).map((f) => f.rel)).toEqual([]);
  });

  it('R-GATE-15 R-GBP-5: gbp/** never imports the contact send path, leads, ownership or the assistant\'s contact drafts', () => {
    const bad = MODULE.flatMap((f) => specs(f.text).filter((s) => /comms\/dispatch|\/leads\/|ownership|assistant\/drafts|@realty\/core\/ownership/.test(s)).map((s) => `${f.rel}: ${s}`));
    expect(MODULE.length).toBeGreaterThanOrEqual(10);
    expect(bad).toEqual([]);
    // and writes no messages, contact points, touches or consent events (a public review reply is publishing)
    expect(MODULE.filter((f) => /(INSERT INTO|UPDATE)\s+(messages|contact_points|touches|consent_events)\b/.test(f.text)).map((f) => f.rel)).toEqual([]);
  });

  it('R-GBP-5: no SQL anywhere joins gbp_reviews to contacts or contact points (reviewers are never matched to contacts)', () => {
    const bad = SOURCES.filter((f) => /\bgbp_reviews\b/.test(f.text) && /\b(FROM|JOIN)\s+(contacts|contact_points)\b/i.test(f.text)).map((f) => f.rel);
    expect(bad).toEqual([]);
  });

  it('R-GBP-1 E471: nothing outside gbp/** writes a review_reply_draft', () => {
    expect(SOURCES.filter((f) => !f.rel.startsWith('gbp/') && /review_reply_draft/.test(f.text)).map((f) => f.rel)).toEqual([]);
  });

  it('R-MKT-12: gbp/** never writes marketing_publications (GBP posts go through marketing/publish.ts)', () => {
    expect(MODULE.filter((f) => /(INSERT INTO|UPDATE)\s+marketing_publications\b/.test(f.text)).map((f) => f.rel)).toEqual([]);
  });
});
