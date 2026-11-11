// @vitest-environment node
// Module 37 architecture tests over the source of the three inbox surfaces (thread, compose, widget):
//   D2           no Meta channel (Messenger, Instagram, Facebook DMs) and no messaging-window copy in any code or
//                string they ship (comments may explain the decision; tests may name what they forbid)
//   genuineness  the widget's code renders no typing indicator and no presence
//   separate bundle  the widget imports nothing outside src/widget (also the lint rule realty/isolated-bundle)
//   STUB(22)     every call to a module 22 route that does not exist yet is in one typed client per surface
import { describe, expect, it } from 'vitest';

const SOURCES = {
  ...import.meta.glob<string>(['../thread/**/*.{ts,tsx}', '../compose/**/*.{ts,tsx}', '../../widget/**/*.{ts,tsx,html}'], { query: '?raw', import: 'default', eager: true }),
};
/** "./ThreadPage.tsx" → "thread/ThreadPage.tsx", "../compose/x.ts" → "compose/x.ts", "../../widget/x.ts" → "widget/x.ts" */
const norm = (p: string) => (p.startsWith('./') ? `thread/${p.slice(2)}` : p.replace(/^(\.\.\/)+/, ''));
const shipped = Object.entries(SOURCES)
  .map(([p, src]) => [norm(p), src] as const)
  .filter(([p]) => !/\.test\.tsx?$/.test(p));

/** Code without its comments (block, line and HTML), so explanations of a decision do not trip the scan. */
function code(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

describe('module 37 architecture', () => {
  it('scans every shipped file of thread, compose and the widget', () => {
    const names = shipped.map(([p]) => p).sort();
    expect(names).toEqual(expect.arrayContaining(['thread/ThreadPage.tsx', 'compose/ComposeBox.tsx', 'compose/channelApi.ts', 'compose/channelChoice.ts', 'widget/api.ts', 'widget/widget.ts', 'widget/main.ts', 'widget/copy.ts', 'widget/preview.html']));
  });

  it('D2: no Meta channel (messenger, instagram) appears in compose, thread or the widget, and no messaging-window copy', () => {
    const found: string[] = [];
    for (const [p, src] of shipped) {
      const c = code(src);
      for (const m of c.matchAll(/messenger|instagram|facebook|\bmeta[_ ]?(dm|lead|page)|platform_window|PLATFORM_WINDOW_CLOSED|messaging window|reply window|24[- ]hours?/gi)) found.push(`${p}: ${m[0]}`);
    }
    expect(found).toEqual([]);
  });

  it('genuineness: the widget renders no typing indicator and no presence it did not get from the server', () => {
    const found: string[] = [];
    for (const [p, src] of shipped.filter(([x]) => x.startsWith('widget/'))) {
      for (const m of code(src).matchAll(/typing|is writing|online|presence|available now|active now|last seen|read receipt|replies? in \d|within \d+ ?(min|minutes|seconds)/gi)) found.push(`${p}: ${m[0]}`);
    }
    expect(found).toEqual([]);
  });

  it('the widget is a separate bundle: it imports nothing outside src/widget (no React, no shell, no staff surface)', () => {
    const found: string[] = [];
    for (const [p, src] of shipped.filter(([x]) => x.startsWith('widget/') && !x.endsWith('.html'))) {
      for (const m of code(src).matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? '';
        if (!spec.startsWith('./')) found.push(`${p}: ${spec}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('every STUB(22) call lives in the one typed client of its surface (compose/channelApi.ts, widget/api.ts), and the thread needs none', () => {
    const marked = shipped.filter(([, src]) => /STUB\(22\)/.test(code(src)) || /\/\/ STUB\(22\)/.test(src)).map(([p]) => p);
    expect(marked.sort()).toEqual(['compose/channelApi.ts', 'widget/api.ts']);
    // nothing else calls a public chat route or posts a web-chat message
    for (const [p, src] of shipped) {
      if (p === 'compose/channelApi.ts' || p === 'widget/api.ts') continue;
      expect(code(src), p).not.toMatch(/\/public\/chat\/|channel: 'web_chat', body/);
    }
  });
});
