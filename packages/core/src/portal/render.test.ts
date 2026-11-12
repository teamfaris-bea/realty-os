import { describe, expect, it } from 'vitest';
import { renderPortalItem } from './render.js';
import { publishable } from './publishable.js';
import { pgBtrimLength, rowChecksAccept } from './testing/guard.js';
import { dealGrant, documentSrc, facts, feedback, listingGrant, milestone, sellerUpdate, showing, task, T0 } from './testing/fixtures.js';
import type { PortalSource } from './types.js';

const ALL = (): PortalSource[] => [milestone({ id: '00000044-0000-7000-8000-0000000000a1' as never }), documentSrc({ id: '00000044-0000-7000-8000-0000000000a2' as never }),
  showing({}, { id: '00000044-0000-7000-8000-0000000000a3' as never }), feedback({}, { id: '00000044-0000-7000-8000-0000000000a4' }),
  sellerUpdate({ id: '00000044-0000-7000-8000-0000000000a5' as never }), task({ id: '00000044-0000-7000-8000-0000000000a6' as never })];

describe('renderPortalItem', () => {
  it('R-PORTAL-3: one snapshot per kind, built from the allowlist only', () => {
    const out = ALL().map((s) => renderPortalItem(facts(s)));
    expect(out).toMatchSnapshot();
    const json = JSON.stringify(out);
    for (const never of ['Agent Example', 'Example Brokerage', 'PRIVATE NOTE', 'tenant', 'confidence', 'probability', 'score']) expect(json).not.toContain(never);
    for (const o of out) expect(rowChecksAccept(o)).toBe(true);
  });

  it('dates are slots: the date lives only in occursOn, in the zone passed in', () => {
    const out = ALL().map((s) => renderPortalItem(facts(s)));
    expect(out.map((o) => [o.kind, o.occursOn])).toEqual([
      ['milestone', '2026-12-01'], ['document', null], ['showing', '2026-11-12'], ['feedback', '2026-11-12'], ['seller_update', null], ['next_step', '2026-11-12'],
    ]);
    expect(renderPortalItem(facts(showing(), { zone: 'UTC' as never })).occursOn).toBe('2026-11-13');
    expect(renderPortalItem(facts(task({ dueAt: null }))).occursOn).toBeNull();
    for (const o of out) expect(`${o.title} ${o.body ?? ''}`).not.toMatch(/\d{4}-\d{2}|\d{1,2}:\d{2}|\b(Nov|Dec|November|December)\b|2026/);
    expect(T0).toBeGreaterThan(0);
  });

  it('sourceVersion is due_version for a deal_date, version_no for a document and 1 otherwise; documentId only and always for a document', () => {
    const out = ALL().map((s) => renderPortalItem(facts(s)));
    expect(out.map((o) => o.sourceVersion)).toEqual([2, 3, 1, 1, 1, 1]);
    expect(out.map((o) => o.documentId === null)).toEqual([true, false, true, true, true, true]);
    expect(out[1]!.documentId).toBe(out[1]!.sourceId);
    const moved = renderPortalItem(facts(milestone({ id: '00000044-0000-7000-8000-0000000000b1' as never, dueVersion: 3, dueOn: '2026-12-08' as never })));
    const before = renderPortalItem(facts(milestone({ id: '00000044-0000-7000-8000-0000000000b1' as never, dueVersion: 2 })));
    expect([moved.sourceId, moved.sourceVersion]).not.toEqual([before.sourceId, before.sourceVersion]);
  });

  it('titles: 120 code points pass as they are, 121 are shortened visibly; astral characters count once', () => {
    for (const ch of ['a', '😀', '𝔸']) {
      const at = renderPortalItem(facts(task({ title: ch.repeat(120) }))).title;
      expect(at).toBe(ch.repeat(120));
      const over = renderPortalItem(facts(task({ title: ch.repeat(121) }))).title;
      expect(Array.from(over)).toHaveLength(120);
      expect(over.endsWith('…')).toBe(true);
      expect(pgBtrimLength(over)).toBe(120);
    }
    const spaced = renderPortalItem(facts(task({ title: `${'word '.repeat(30)}` }))).title;
    expect(spaced).toBe(spaced.trim());
    expect(Array.from(spaced).length).toBeLessThanOrEqual(120);
  });

  it('a 120-code-point title with a leading tab, U+00A0 or U+3000 is trimmed the JavaScript way and counts the same in Postgres', () => {
    for (const lead of ['\t', '\u00A0', '\u3000']) {
      const raw = `${lead}${'b'.repeat(119)}`;
      expect(Array.from(raw)).toHaveLength(120);
      const t = renderPortalItem(facts(task({ title: raw }))).title;
      expect(t).toBe('b'.repeat(119));
      expect(pgBtrimLength(t)).toBe(Array.from(t).length);
      // Postgres's btrim would have kept the leading character and counted 120: core never hands it one.
      expect(pgBtrimLength(raw)).toBe(120);
    }
  });

  it('bodies: 4000 code points pass verbatim; 4001 are refused by publishable and shown shortened in a preview', () => {
    for (const ch of ['x', '😀']) {
      const at = renderPortalItem(facts(sellerUpdate({ text: ch.repeat(4000) })));
      expect(at.body).toBe(ch.repeat(4000));
      const over = facts(sellerUpdate({ text: ch.repeat(4001) }));
      expect(publishable('seller_update', { ...over, grant: dealGrant({ clientIsSellerSide: true }) })).toEqual({ ok: false, reason: 'PORTAL_TEXT_TOO_LONG' });
      const body = renderPortalItem(over).body!;
      expect(Array.from(body).length).toBeLessThanOrEqual(4000);
      expect(body).toContain('shortened here: the full text is 4001 characters');
    }
  });

  it('feedback comments and the approved seller update are copied verbatim; empty text is no body', () => {
    const comments = '  Loved it.\n\nThe <b>basement</b> smelled damp & "musty".  ';
    expect(renderPortalItem(facts(feedback({}, { comments }))).body).toBe(comments);
    expect(renderPortalItem(facts(feedback({}, { comments: null, rating: null })))).toMatchObject({ title: 'Showing feedback', body: null });
    expect(renderPortalItem(facts(sellerUpdate({ text: '' }))).body).toBeNull();
  });

  it('output does not depend on the publisher or the grant', () => {
    for (const s of ALL()) {
      const base = renderPortalItem(facts(s));
      for (const over of [{ publisher: 'system' as const }, { grant: listingGrant() }, { grant: dealGrant({ revoked: true, clientIsSellerSide: true }) }]) {
        expect(renderPortalItem(facts(s, over))).toEqual(base);
      }
    }
  });

  it('a milestone uses its label, else the kind\'s name; a whitespace-only title falls back', () => {
    expect(renderPortalItem(facts(milestone({ kind: 'custom', label: 'HOA documents due' }))).title).toBe('HOA documents due');
    expect(renderPortalItem(facts(milestone({ kind: 'closing', label: '   ' }))).title).toBe('Closing');
    expect(renderPortalItem(facts(documentSrc({ displayName: '\u202E\u0007' }))).title).toBe('Document');
    expect(renderPortalItem(facts(task({ title: '\n\t ' }))).title).toBe('Next step');
  });

  it('refuses a malformed SourceFacts with a RangeError', () => {
    expect(() => renderPortalItem({} as never)).toThrow(RangeError);
  });
});
