// Architecture checks for module 29 (R-GATE-15, R-MKT-12, R-MKT-7, E228): source scans of apps/api/src.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
function files(dir: string, withTests = false): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__snapshots__' ? [] : files(p, withTests);
    return /\.tsx?$/.test(n) && (withTests || (!/\.test\.tsx?$/.test(n) && !n.endsWith('testing.ts'))) ? [p] : [];
  });
}
const SOURCES = files(SRC).map((p) => ({ rel: relative(SRC, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }));
const ALL = files(SRC, true).map((p) => ({ rel: relative(SRC, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }));

describe('module 29 architecture', () => {
  it('R-GATE-15 R-MKT-12: publishPost is the only publishing path: no file outside marketing/publish.ts (and the providers themselves) calls publishPost, lookupPost, deletePost or postReviewReply, tests included', () => {
    const offenders = ALL.filter((f) => !f.rel.startsWith('providers/') && f.rel !== 'marketing/publish.ts' && /\.\s*(publishPost|lookupPost|deletePost|postReviewReply)\s*\(/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
    // and publish.ts reaches the provider only through the injected SocialPublisher (no providers import of a real adapter)
    const pub = SOURCES.find((f) => f.rel === 'marketing/publish.ts')!.text;
    expect(pub).toMatch(/deps\.social\.publishPost\(/);
    expect(pub).not.toMatch(/integrations\/real/);
  });

  it('R-MKT-12: marketing_publications is written only by marketing/publish.ts (TX1 insert as the person; outcomes and retractions as the system)', () => {
    const writers = SOURCES.filter((f) => /(INSERT INTO|UPDATE)\s+marketing_publications\b/.test(f.text)).map((f) => f.rel);
    expect(writers).toEqual(['marketing/publish.ts']);
    const pub = SOURCES.find((f) => f.rel === 'marketing/publish.ts')!.text;
    // every outcome write happens inside asSystem(...)
    const record = pub.slice(pub.indexOf('async function recordOutcome'), pub.indexOf('export async function reconcilePublications'));
    expect(record).toMatch(/return\s+asSystem\(|await asSystem\(/);
    expect(record).toMatch(/status = 'published', external_post_id/);
  });

  it('R-MKT-12 E227: nothing in the reconcile handler or the reconcile pass can post (no publishPost reachable from handlers.ts or reconcilePublications)', () => {
    const handlers = SOURCES.find((f) => f.rel === 'marketing/handlers.ts')!.text;
    expect(handlers).not.toMatch(/publishPost/);
    const pub = SOURCES.find((f) => f.rel === 'marketing/publish.ts')!.text;
    const reconcile = pub.slice(pub.indexOf('export async function reconcilePublications'), pub.indexOf('export async function retractPublication'));
    expect(reconcile).not.toMatch(/publishPost|sendAndRecord/);
    expect(reconcile).toMatch(/lookupPost/);
  });

  it('R-MKT-7: the public page reads only through app.public_listing_page; no other code calls the definer', () => {
    const callers = SOURCES.filter((f) => /app\.public_listing_page\(/.test(f.text)).map((f) => f.rel);
    expect(callers).toEqual(['marketing/publicPage.ts']);
  });

  it('R-MKT-8 D1: invites go only through composeHumanMessage (module 22) and never write messages rows themselves', () => {
    const inv = SOURCES.find((f) => f.rel === 'marketing/invites.ts')!.text;
    expect(inv).toMatch(/composeHumanMessage\(/);
    expect(inv).not.toMatch(/INSERT INTO messages/);
    const marketing = SOURCES.filter((f) => f.rel.startsWith('marketing/'));
    expect(marketing.filter((f) => /INSERT INTO messages|\.sendEmail\(|dispatchOutbound\(/.test(f.text)).map((f) => f.rel)).toEqual([]);
  });

  it('E228: no Meta messaging webhook, DM parser or Lead Ads receiver exists anywhere in the API', () => {
    const routes = SOURCES.filter((f) => /['"`]\/webhooks\/(meta|facebook|instagram|messenger)/i.test(f.text)).map((f) => f.rel);
    expect(routes).toEqual([]);
  });
});
