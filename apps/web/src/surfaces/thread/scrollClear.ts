// The thread scrolls the document. The page header and the compose bar stay on screen and cover
// whatever stops underneath them. axe target-size fails a control whose largest rectangle not covered
// by that chrome is under 24px (WCAG 2.2 2.5.8), which is where a Why disclosure lands when the
// conversation opens at the latest message and a later banner shifts it by a few dozen pixels.
// A control fully inside the chrome passes (nothing of it can be hit). One that only sticks out a
// sliver does not. scrollIntoView of the end marker does not look at those other controls, so after
// that scroll we nudge until every control is clear, using the chrome's real boxes.

export const MIN_UNOBSCURED = 24;

export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
}

/** Full-bleed covers only: a side sliver is not what the header or the compose bar do. */
function fullBleedCovers(target: Box, covers: readonly Box[]): Box[] {
  return covers.filter((c) => c.left <= target.left + 0.5 && c.right >= target.right - 0.5 && overlaps(target, c));
}

/** Tallest vertical run of `target` that no full-bleed cover takes, including the part above the viewport. */
export function unobscuredHeight(target: Box, covers: readonly Box[]): number {
  let spans: [number, number][] = [[target.top, target.bottom]];
  for (const c of fullBleedCovers(target, covers)) {
    const next: [number, number][] = [];
    for (const [a, b] of spans) {
      const lo = Math.max(a, c.top);
      const hi = Math.min(b, c.bottom);
      if (hi <= a || lo >= b) {
        next.push([a, b]);
        continue;
      }
      if (lo > a) next.push([a, lo]);
      if (hi < b) next.push([hi, b]);
    }
    spans = next.filter(([a, b]) => b - a > 0);
  }
  return spans.reduce((m, [a, b]) => Math.max(m, b - a), 0);
}

function fullyCovered(target: Box, covers: readonly Box[]): boolean {
  return covers.some((c) => c.left <= target.left + 0.5 && c.right >= target.right - 0.5 && c.top <= target.top + 0.5 && c.bottom >= target.bottom - 0.5);
}

function bigEnough(target: Box, covers: readonly Box[], min: number): boolean {
  const width = target.right - target.left;
  return width + 0.05 >= min && unobscuredHeight(target, covers) + 0.05 >= min;
}

/** A hittable run of at least `min` px, not a control buried entirely under the chrome. */
export function targetHasRoom(target: Box, covers: readonly Box[], min = MIN_UNOBSCURED): boolean {
  const height = target.bottom - target.top;
  const width = target.right - target.left;
  if (height <= 0 || width <= 0 || fullyCovered(target, covers)) return false;
  if (!covers.some((c) => overlaps(target, c))) return height + 0.05 >= min && width + 0.05 >= min;
  return bigEnough(target, covers, min);
}

/** True when axe target-size would not fail this box for being partly under `covers`. Fully covered passes: nothing of it can be hit. */
export function targetClears(target: Box, covers: readonly Box[], min = MIN_UNOBSCURED): boolean {
  const height = target.bottom - target.top;
  const width = target.right - target.left;
  if (height <= 0 || width <= 0) return true;
  if (fullyCovered(target, covers)) return true;
  if (!covers.some((c) => overlaps(target, c))) return true;
  return bigEnough(target, covers, min);
}

function shift(target: Box, delta: number): Box {
  return { top: target.top - delta, bottom: target.bottom - delta, left: target.left, right: target.right };
}

interface ClearStats {
  fails: number;
  visible: number;
}

/**
 * How far to scroll the document so controls stop failing target-size under the chrome.
 * Positive scrolls down (content moves up). 0 when no move helps.
 * A control fully under the chrome passes target-size (nothing of it can be hit), so a drop in the
 * fail count is not enough: every control that has room before the nudge must still have room after.
 * Among equal fixes, the smaller move wins.
 */
export function scrollDeltaToClear(targets: readonly Box[], covers: readonly Box[], min = MIN_UNOBSCURED): number {
  const live = targets.filter((t) => t.bottom > t.top && t.right > t.left);
  const hadRoom = live.map((t) => targetHasRoom(t, covers, min));
  const statsOf = (delta: number): ClearStats => {
    let fails = 0;
    let visible = 0;
    for (const t of live) {
      const s = shift(t, delta);
      if (!targetClears(s, covers, min)) fails += 1;
      if (targetHasRoom(s, covers, min)) visible += 1;
    }
    return { fails, visible };
  };
  const keepsRoom = (delta: number) => live.every((t, i) => !hadRoom[i] || targetHasRoom(shift(t, delta), covers, min));
  const base = statsOf(0);
  const candidates = new Set<number>();
  for (const t of live) {
    if (targetClears(t, covers, min)) continue;
    for (const c of fullBleedCovers(t, covers)) {
      // wholly on one side of the cover
      candidates.add(Math.ceil(t.bottom - c.top));
      candidates.add(Math.floor(t.top - c.bottom));
      // a 24px run on one side of the cover
      candidates.add(Math.ceil(t.top + min - c.top));
      candidates.add(Math.floor(t.bottom - min - c.bottom));
    }
  }
  const improves = (s: ClearStats) => s.fails < base.fails || (s.fails === base.fails && s.visible > base.visible);
  const better = (s: ClearStats, delta: number, best: ClearStats, bestDelta: number) => {
    if (s.fails !== best.fails) return s.fails < best.fails;
    if (s.visible !== best.visible) return s.visible > best.visible;
    return Math.abs(delta) < Math.abs(bestDelta);
  };
  let bestDelta = 0;
  let best = base;
  for (const delta of candidates) {
    if (delta === 0 || !keepsRoom(delta)) continue;
    const s = statsOf(delta);
    if (improves(s) && better(s, delta, best, bestDelta)) {
      best = s;
      bestDelta = delta;
    }
  }
  return bestDelta;
}

export interface SettleHeights {
  above: number;
  compose: number;
}

export function settleKey(h: SettleHeights): string {
  return `${h.above}:${h.compose}`;
}

/**
 * Scroll the thread again when content above the list or the compose bar changes size.
 * A pair already settled is skipped, so a grow-then-shrink loop stops, and a later compose-bar
 * change is not dropped after several banner updates.
 */
export function shouldResettle(prev: SettleHeights, next: SettleHeights, seen: ReadonlySet<string>): boolean {
  if (next.above === prev.above && next.compose === prev.compose) return false;
  return !seen.has(settleKey(next));
}

const CONTROLS = 'button, a[href], summary, input:not([type=hidden]), select, textarea';

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
}

function stickyCovers(): Box[] {
  const out: Box[] = [];
  const consider = (el: Element | null) => {
    if (!el) return;
    const pos = getComputedStyle(el).position;
    if (pos !== 'sticky' && pos !== 'fixed') return;
    const b = boxOf(el);
    if (b.bottom - b.top > 0 && b.right - b.left > 0) out.push(b);
  };
  consider(document.querySelector('header'));
  consider(document.querySelector('nav[aria-label="Main tabs"]'));
  document.querySelectorAll('[data-sticky]').forEach((el) => consider(el));
  return out;
}

/** Nudge the document until controls in `root` are not left as a sliver under sticky chrome. */
export function clearObscuredControls(root: ParentNode): void {
  if (typeof window === 'undefined' || typeof window.scrollBy !== 'function') return;
  const controls = [...root.querySelectorAll<HTMLElement>(CONTROLS)].filter((e) => {
    if (e.closest('header, nav[aria-label="Main tabs"], [data-sticky], [aria-hidden="true"], [inert], [role="dialog"]')) return false;
    const r = e.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  });
  for (let pass = 0; pass < 4; pass++) {
    const delta = scrollDeltaToClear(controls.map(boxOf), stickyCovers());
    if (delta === 0) return;
    const before = window.scrollY;
    window.scrollBy(0, delta);
    if (window.scrollY === before) return;
  }
}
