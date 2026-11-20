// R-STG-1: the web has ONE source of stage words. A stage's label, its one-line definition and its "does not mean"
// line come from the API (GET /stage-labels, the contact's details), whose defaults are core's stage guide. No web
// file restates the default labels (surfaces/imports is another lane's and is not read here), so a renamed stage
// reads the same on the contact header, its timeline, the People list, the bulk sheet and the duplicates page.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEFAULT_STAGE_LABELS, STAGES } from '@realty/core/parity/people';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeFetch, IDS, agentApp, fullContact, reachability, timelineItem } from '../feed/lib/testing.js';
import { DEFAULT_GUIDE, labelIn } from './stageGuide.js';

const SRC = join(__dirname, '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('R-STG-1: one source of stage labels', () => {
  it('no web file outside surfaces/imports writes a default stage label as a literal in its code (old words or new; a comment may name one)', () => {
    // the lead-stage words that are not also deal-stage words: the old defaults and core's new ones
    const words = ['Attempting', 'Nurture', ...Object.values(DEFAULT_STAGE_LABELS).filter((l) => !['Connected', 'Under contract'].includes(l))];
    const re = new RegExp(`['"\`](${words.map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})['"\`]`);
    const offenders = sources(SRC)
      .filter((f) => !relative(SRC, f).startsWith(join('surfaces', 'imports')))
      // code only: a comment that explains a screen may quote a label
      .filter((f) => re.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('the fallback guide is core\'s own (the eight keys in order, each with a label, a definition and a "does not mean" line)', () => {
    expect(DEFAULT_GUIDE.map((s) => s.key)).toEqual([...STAGES]);
    for (const s of DEFAULT_GUIDE) {
      expect(s.label).toBe(DEFAULT_STAGE_LABELS[s.key as keyof typeof DEFAULT_STAGE_LABELS]);
      expect(s.definition.length).toBeGreaterThan(10);
      expect(s.notThis.length).toBeGreaterThan(10);
    }
    expect(labelIn(DEFAULT_GUIDE, 'attempting')).toBe('Trying to reach');
    // a key the guide does not know is shown readable, never as a raw key with underscores
    expect(labelIn(DEFAULT_GUIDE, 'some_new_key')).toBe('some new key');
  });
});

function contactFake(stage: string, labels: Record<string, string> = {}) {
  const c = fullContact({ stage });
  const stages = DEFAULT_GUIDE.map((s) => ({ ...s, label: labels[s.key] ?? s.label }));
  return new FakeFetch()
    .on(`GET /contacts/${c.id}`, { status: 200, body: { contact: c } })
    .on('GET /stage-labels', { status: 200, body: { labels, stages } })
    .on(`GET /contacts/${c.id}/reachability`, { status: 200, body: { reachability: reachability(c.id) } })
    .on(`GET /contacts/${c.id}/timeline?limit=100`, { status: 200, body: { items: [timelineItem({ id: '01900000-0000-7000-8000-00000000e001', type: 'stage', detail: 'new>attempting', preview: null })], nextCursor: null } })
    .on('GET /assistant/inbox', { status: 200, body: { items: [] } })
    .on(`GET /tasks?contactId=${c.id}&scope=visible&status=open`, { status: 200, body: { tasks: [] } })
    .on(`GET /deals?contactId=${c.id}`, { status: 200, body: { deals: [] } })
    .on(`GET /contacts/${c.id}/saved-searches`, { status: 200, body: { searches: [] } });
}

describe('R-STG-1: the contact page reads its stage words from the API', () => {
  it('the header names the stage by its label, never by the raw key', async () => {
    agentApp(contactFake('under_contract'), `/contacts/${IDS.jane}`);
    const head = (await screen.findByRole('heading', { level: 2, name: 'Jane Doe' })).parentElement!;
    expect(await within(head).findByText('Buyer · Under contract · Yours · From Zillow')).toBeInTheDocument();
    expect(head.textContent).not.toMatch(/under contract ·|under_contract/);
  });

  it("a team's own label wins on the header and in the timeline's stage line", async () => {
    agentApp(contactFake('attempting', { attempting: 'Chasing', new: 'Fresh' }), `/contacts/${IDS.jane}`);
    const head = (await screen.findByRole('heading', { level: 2, name: 'Jane Doe' })).parentElement!;
    expect(await within(head).findByText('Buyer · Chasing · Yours · From Zillow')).toBeInTheDocument();
    expect(await screen.findByText('Stage: Fresh → Chasing')).toBeInTheDocument();
  });

  it('without an override the timeline says the default labels (the API\'s guide)', async () => {
    agentApp(contactFake('attempting'), `/contacts/${IDS.jane}`);
    expect(await screen.findByText('Stage: New lead → Trying to reach')).toBeInTheDocument();
  });
});
