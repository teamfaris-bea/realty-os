// The thread scrolls the document. The page header, the tab bar and the compose bar stay on screen
// and cover whatever stops underneath them. Two checks have to pass together:
// - WCAG 2.4.11, the way obscuredFocus samples it: the focused control's center, clamped into the
//   viewport, must not land on the header, the tab bar or a [data-sticky] bar. A 24px sliver, or a
//   control fully under the chrome, still hides that center.
// - axe target-size (WCAG 2.2 2.5.8): the largest run not covered by that chrome is at least 24px.
//   That is an extra constraint, not a substitute for a clear center.
// scrollIntoView of the end marker does not look at the other controls, so after that scroll we nudge
// until every control's center is clear, using the chrome's real boxes.

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

/** The point obscuredFocus samples: the control's center, clamped into the viewport. */
export function sampledCenter(target: Box, viewportHeight: number, viewportWidth = 390): { x: number; y: number } {
  const cx = (target.left + target.right) / 2;
  const cy = (target.top + target.bottom) / 2;
  return {
    x: Math.min(Math.max(cx, 1), Math.max(1, viewportWidth - 1)),
    y: Math.min(Math.max(cy, 1), Math.max(1, viewportHeight - 1)),
  };
}

/** True when that sampled center lands on the header, the tab bar or a sticky bar. */
export function centerHitsChrome(target: Box, covers: readonly Box[], viewportHeight: number, viewportWidth = 390): boolean {
  const { x, y } = sampledCenter(target, viewportHeight, viewportWidth);
  return covers.some((c) => x >= c.left && x <= c.right && y >= c.top && y <= c.bottom);
}

/** Center clear of the chrome, and the 24px target-size run on top of that. */
export function focusClears(target: Box, covers: readonly Box[], viewportHeight: number, viewportWidth = 390, min = MIN_UNOBSCURED): boolean {
  if (target.bottom <= target.top || target.right <= target.left) return true;
  if (centerHitsChrome(target, covers, viewportHeight, viewportWidth)) return false;
  return targetClears(target, covers, min);
}

function shift(target: Box, delta: number): Box {
  return { top: target.top - delta, bottom: target.bottom - delta, left: target.left, right: target.right };
}

/**
 * How far to scroll the document so each control's center is clear of the chrome and the 24px run holds.
 * Positive scrolls down (content moves up). 0 when no move helps.
 * A control whose center is already clear must stay clear. Fully covering one, or leaving a 24px sliver
 * whose center is still on the chrome, does not count. Among equal fixes, the smaller move wins.
 */
export function scrollDeltaToClear(targets: readonly Box[], covers: readonly Box[], min = MIN_UNOBSCURED, viewportHeight = 844, viewportWidth = 390): number {
  const live = targets.filter((t) => t.bottom > t.top && t.right > t.left);
  const ok = (t: Box) => focusClears(t, covers, viewportHeight, viewportWidth, min);
  const hadClearCenter = live.map((t) => ok(t));
  const failsOf = (delta: number) => live.filter((t) => !ok(shift(t, delta))).length;
  const keepsCenters = (delta: number) => live.every((t, i) => !hadClearCenter[i] || ok(shift(t, delta)));
  const baseFails = failsOf(0);
  const candidates = new Set<number>();
  for (const t of live) {
    if (ok(t)) continue;
    const cy = (t.top + t.bottom) / 2;
    for (const c of covers) {
      if (c.right <= t.left || c.left >= t.right) continue;
      // center just above this cover, and just below it
      candidates.add(Math.ceil(cy - c.top + 1));
      candidates.add(Math.floor(cy - c.bottom - 1));
    }
    for (const c of fullBleedCovers(t, covers)) {
      // a 24px run on one side of the cover, and wholly to one side
      candidates.add(Math.ceil(t.bottom - c.top));
      candidates.add(Math.floor(t.top - c.bottom));
      candidates.add(Math.ceil(t.top + min - c.top));
      candidates.add(Math.floor(t.bottom - min - c.bottom));
    }
  }
  let bestDelta = 0;
  let bestFails = baseFails;
  for (const delta of candidates) {
    if (delta === 0 || !keepsCenters(delta)) continue;
    const fails = failsOf(delta);
    if (fails < bestFails || (fails === bestFails && bestDelta !== 0 && Math.abs(delta) < Math.abs(bestDelta))) {
      bestFails = fails;
      bestDelta = delta;
    }
  }
  return bestFails < baseFails ? bestDelta : 0;
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

/** Nudge the document until each control's center is clear of the header, the tab bar and sticky bars. */
export function clearObscuredControls(root: ParentNode): void {
  if (typeof window === 'undefined' || typeof window.scrollBy !== 'function') return;
  const controls = [...root.querySelectorAll<HTMLElement>(CONTROLS)].filter((e) => {
    if (e.closest('header, nav[aria-label="Main tabs"], [data-sticky], [aria-hidden="true"], [inert], [role="dialog"]')) return false;
    const r = e.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  });
  for (let pass = 0; pass < 4; pass++) {
    const delta = scrollDeltaToClear(controls.map(boxOf), stickyCovers(), MIN_UNOBSCURED, window.innerHeight, window.innerWidth);
    if (delta === 0) return;
    const before = window.scrollY;
    window.scrollBy(0, delta);
    if (window.scrollY === before) return;
  }
}
