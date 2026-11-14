// A seeded generator of hostile JSON-like values (module 46 property tests). apps/web has no fast-check dependency, so
// this small deterministic generator (mulberry32) stands in: the same seed gives the same 200 cases on every run.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['grants', 'items', 'nextSteps', 'documents', 'grant', 'timeline', 'id', 'itemId', 'grantId', 'kind', 'title', 'body', 'occursOn', 'publishedAt', 'contact', 'agentName', 'textTo', 'emailTo', 'expiresOn', 'scope', 'account', 'status', 'csrfToken', 'url', 'fileName', 'contentType', 'byteSize', 'expiresAt', 'visibleNow', 'why', '__proto__', 'constructor', 'toString', 'notes', 'score', 'value', 'cmaValue', 'aiDraft', 'assignee', 'tenantId'];
const STRINGS = ['', ' ', 'milestone', 'next_step', 'document', 'active', '2026-12-18', '2026-02-30', '2026-11-13T15:00:00.000Z', 'not a date', '01900000-0000-7000-8000-00000000a001', 'javascript:alert(1)', '<img src=x onerror=alert(1)>', '‮evil', '+15555550123', 'a@example.test', 'x'.repeat(5000), '\u0000', '__proto__', 'sent_if_matched'];

export function hostile(r: () => number, depth = 0): unknown {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const roll = r();
  if (depth > 4 || roll < 0.25) return pick([null, undefined, true, false, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 10_000_001, ...STRINGS]);
  if (roll < 0.45) return Array.from({ length: Math.floor(r() * 4) }, () => hostile(r, depth + 1));
  const o: Record<string, unknown> = Object.create(r() < 0.1 ? null : Object.prototype) as Record<string, unknown>;
  const n = Math.floor(r() * 8);
  for (let i = 0; i < n; i += 1) Object.defineProperty(o, pick(KEYS), { value: hostile(r, depth + 1), enumerable: true, configurable: true, writable: true });
  return o;
}
