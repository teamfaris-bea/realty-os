// The linear HTML → text scanner of lead emails.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_HTML_INPUT_CHARS } from './html.js';
import { MAX_INPUT_CHARS, htmlToText } from './index.js';

describe('htmlToText', () => {
  it('drops tags, keeps link text but never the URL', () => {
    expect(htmlToText('<p class="a">Hello <b>you</b></p><a href="https://evil.test/x?y=1">click</a><img src="https://t.test/p.gif">')).toBe('Hello you\n\nclick');
  });

  it('block-closing tags and <br> become newlines; table cells are separated by a space', () => {
    expect(htmlToText('a<br>b<br/>c<BR />d</div>e</tr>f</li>g')).toBe('a\nb\nc\nd\ne\nf\ng');
    // paragraphs and headings end with a blank line (never more than one)
    expect(htmlToText('g</h1>h</H6>i</p></p></div>j</ul>k</table>')).toBe('g\n\nh\n\ni\n\nj\n\nk\n\n');
    expect(htmlToText('<div><div>a</div></div>b')).toBe('a\nb');
    expect(htmlToText('a<br><br><br>b')).toBe('a\n\n\nb');
    expect(htmlToText('<tr><td>Name:</td><td>Jane</td></tr>')).toBe('Name: Jane \n');
  });

  it('collapses source whitespace like a browser', () => {
    expect(htmlToText('<p>\n  Name:\n   Jane\n</p>\n<p>x</p>')).toBe('Name: Jane \n\nx\n\n');
  });

  it('drops script/style/head/title/template/noscript content, unterminated ⇒ to the end', () => {
    expect(htmlToText('a<script type="x">Email: evil@x.test</script>b<STYLE>p{}</style>c<head><title>t</title></head>d<template>t</template>e<noscript>n</noscript>f')).toBe('abcdef');
    expect(htmlToText('a<script>var s = "</scripty>"; secret')).toBe('a');
    expect(htmlToText('a<style>b')).toBe('a');
    expect(htmlToText('a<script/>b')).toBe('ab');
  });

  it('drops comments, doctype and processing instructions; unterminated ⇒ to the end', () => {
    expect(htmlToText('<!doctype html>a<!-- Email: x@y.test -->b<?xml x?>c')).toBe('abc');
    expect(htmlToText('a<!-- never closed b')).toBe('a');
    expect(htmlToText('a<div class="x')).toBe('a');
    expect(htmlToText('a<a title="x>y">b</a>')).toBe('ab');
  });

  it("a '<' that starts no tag is text", () => {
    expect(htmlToText('1 < 2 and 3<4')).toBe('1 < 2 and 3<4');
  });

  it('decodes only the listed entities and valid numeric references', () => {
    expect(htmlToText('&amp; &lt; &gt; &quot; &#39; &apos; a&nbsp;b &#65;&#x42;&#X43;')).toBe(`& < > " ' ' a b ABC`);
    expect(htmlToText('&copy; &eacute; &amp')).toBe('&copy; &eacute; &amp');
    expect(htmlToText('x&#0;y&#xD800;z&#x110000;w&#99999999;v')).toBe('xyzwv');
    expect(htmlToText('&lt;script&gt;')).toBe('<script>');
    expect(htmlToText('&#128512;')).toBe('😀');
  });

  it('caps the output at maxChars (default MAX_INPUT_CHARS)', () => {
    expect(htmlToText('<p>abcdef</p>', 3)).toBe('abc');
    expect(htmlToText('abc', 0)).toBe('');
    expect(htmlToText('x'.repeat(MAX_INPUT_CHARS + 5))).toHaveLength(MAX_INPUT_CHARS);
    expect(htmlToText('ab😀', 3)).toBe('ab');
    // its own input cap, whatever maxChars asks for
    expect(htmlToText('x'.repeat(MAX_HTML_INPUT_CHARS + 5), Number.MAX_SAFE_INTEGER)).toHaveLength(MAX_HTML_INPUT_CHARS);
  });

  it('property: a generated script block never leaks, and the output never exceeds maxChars', () => {
    const MARK = 'QQSCRIPTQQ';
    // before the script: complete tokens only (an unclosed tag or attribute quote would swallow the
    // <script> tag itself, as in a browser, and the marker would then be text); after it: anything
    const complete = fc.oneof(
      fc.constantFrom('<p>', '</p>', '<br>', '<div class="a>b">', '</div>', '<!-- c -->', '&amp;', '&#65;', '<b>', '</td>', '>', '&', '"', ' < ', '<!doctype html>', '<style>x</style>'),
      fc.string({ unit: fc.constantFrom(...'abc />&;#x"\'=-!\n'.split('')), maxLength: 12 }),
    );
    const frag = fc.oneof(complete, fc.constantFrom('<', '<!--', '<a href="', '<script>', '</script>'), fc.string({ unit: fc.constantFrom(...'abc <>/&;#x"\'=-!\n'.split('')), maxLength: 12 }));
    fc.assert(
      fc.property(
        fc.array(complete, { maxLength: 8 }),
        fc.array(frag, { maxLength: 8 }),
        fc.constantFrom('script', 'SCRIPT', 'Script'),
        fc.constantFrom('', ' type="text/javascript"', ' src="x.js"', " data-x='>'"),
        fc.string({ unit: fc.constantFrom(...'abc <>/&;"\'=\n'.split('')), maxLength: 20 }),
        fc.integer({ min: 0, max: 400 }),
        (before, after, tag, attrs, body, maxChars) => {
          const html = before.join('') + `<${tag}${attrs}>${body}${MARK}${body}</${tag}>` + after.join('');
          const out = htmlToText(html, maxChars);
          expect(out).not.toContain(MARK);
          expect(out.length).toBeLessThanOrEqual(maxChars);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('property: any input, any maxChars ⇒ a string no longer than maxChars', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), fc.integer({ min: 0, max: 100 }), (html, max) => {
        const out = htmlToText(html, max);
        expect(typeof out).toBe('string');
        expect(out.length).toBeLessThanOrEqual(max);
      }),
      { numRuns: 300 },
    );
  });

  it('5 MB HTML bombs convert in < 1000 ms', () => {
    const bombs = ['<div>'.repeat(1_000_000), 'a<'.repeat(2_500_000), '<!--' + 'x'.repeat(5_000_000), '<div class="' + 'x'.repeat(5_000_000), '</'.repeat(2_500_000), '&#'.repeat(2_500_000), '<b>x</b>'.repeat(650_000)];
    for (const html of bombs) {
      const t0 = performance.now();
      htmlToText(html);
      htmlToText(html, Number.MAX_SAFE_INTEGER);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
});
