// Phone checks shared by the a11y sweep and the phone-polish spec. Each returns human-readable
// problems (empty = fine), so a failing run lists every offender at once.
import type { Page } from 'playwright/test';

export const MIN_TAP = 44;

const CONTROLS = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=link]';

/**
 * - no horizontal scroll at the current width;
 * - every visible control is at least 44 × 44 px (a checkbox or radio counts its wrapping label;
 *   a link inside running text is exempt, WCAG 2.5.8's inline exception);
 * - every focusable control, once focused (the browser scrolls it into view), is not hidden behind
 *   the sticky top bar or the bottom tab bar (WCAG 2.4.11 Focus Not Obscured);
 * - at the bottom of the page the last piece of content sits above the tab bar.
 */
export async function phoneProblems(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ CONTROLS, MIN_TAP }) => {
      const out: string[] = [];
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth) out.push(`scrolls sideways: content is ${doc.scrollWidth}px wide in a ${doc.clientWidth}px viewport`);
      const label = (e: Element) => (e.getAttribute('aria-label') ?? (e as HTMLElement).innerText ?? e.getAttribute('name') ?? e.tagName).trim().replace(/\s+/g, ' ').slice(0, 40) || e.tagName.toLowerCase();
      const visible = (e: Element) => {
        const r = e.getBoundingClientRect();
        const s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const controls = [...document.querySelectorAll<HTMLElement>(CONTROLS)].filter(visible).filter((e) => !e.closest('[aria-hidden="true"], .sr-only'));
      for (const e of controls) {
        // a link in a sentence (its parent holds more text than the link itself) is an inline target
        const own = (e.textContent ?? '').trim().length;
        const around = (e.parentElement?.textContent ?? '').trim().length;
        const inline = e.tagName === 'A' && getComputedStyle(e).display === 'inline' && around > own + 2;
        if (inline) continue;
        const target = e instanceof HTMLInputElement && (e.type === 'checkbox' || e.type === 'radio') ? (e.closest('label') ?? e) : e;
        const r = target.getBoundingClientRect();
        if (Math.round(r.width) < MIN_TAP || Math.round(r.height) < MIN_TAP) out.push(`small tap target "${label(e)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
      // focus not obscured by the sticky header or the tab bar
      const startY = window.scrollY;
      for (const e of [...document.querySelectorAll<HTMLElement>('main ' + CONTROLS.split(', ').join(', main '))].filter(visible)) {
        if (e.tabIndex < 0) continue;
        e.focus({ preventScroll: false });
        if (document.activeElement !== e) continue;
        const r = e.getBoundingClientRect();
        const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
        const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
        const hit = document.elementFromPoint(x, y);
        if (hit && !e.contains(hit) && !hit.contains(e) && hit.closest('header, nav[aria-label="Main tabs"], [data-sticky]')) out.push(`focused "${label(e)}" is hidden behind ${hit.closest('header') ? 'the top bar' : 'a sticky bar'}`);
      }
      (document.activeElement as HTMLElement | null)?.blur();
      // the end of the page is reachable above the tab bar
      window.scrollTo(0, doc.scrollHeight);
      const main = document.querySelector('main');
      const tabbar = document.querySelector('nav[aria-label="Main tabs"]');
      if (main && tabbar && visible(tabbar)) {
        const leaves = [...main.querySelectorAll<HTMLElement>('*')].filter((e) => e.children.length === 0 && visible(e) && (e.textContent ?? '').trim() !== '');
        const last = leaves.at(-1);
        if (last && last.getBoundingClientRect().bottom > tabbar.getBoundingClientRect().top + 1) out.push(`the end of the page ("${label(last)}") is under the tab bar`);
      }
      window.scrollTo(0, startY);
      return [...new Set(out)];
    },
    { CONTROLS, MIN_TAP },
  );
}

/** Text cut off by its box (ellipsis or overflow hidden) — content lost at large text sizes. */
export async function clippedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const e of document.querySelectorAll<HTMLElement>('body *')) {
      if (e.closest('[aria-hidden="true"], .sr-only, svg')) continue;
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const hides = s.textOverflow === 'ellipsis' || s.overflowX === 'hidden' || s.overflowX === 'clip';
      if (!hides) continue;
      const text = [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
      if (text && e.scrollWidth > e.clientWidth + 1) out.push(`text cut off: "${(e.innerText || '').trim().slice(0, 40)}"`);
    }
    return [...new Set(out)];
  });
}
