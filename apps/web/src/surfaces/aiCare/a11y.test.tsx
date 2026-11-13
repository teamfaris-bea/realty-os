// axe-core over every AI care state (WCAG 2.2 AA rules axe can check in jsdom; contrast is checked in the Playwright
// sweep): live, paused, finalizing (Undo open), ended, hold, refusal, the list, the handoff card and both settings pages.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { card, feed } from '../feed/lib/testing.js';
import type { PanelResponse } from './api.js';
import { FakeFetch, IDS, ISA_IDS, adminView, contactReads, handoffView, isaApp, iso, meView, optIn, panel, row } from './testing.js';
import { UNDO_MS } from './undoStore.js';

async function violations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

function base(p: PanelResponse, hold: string | null = null) {
  return contactReads(new FakeFetch())
    .on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: p })
    .on(`GET /contacts/${IDS.jane}/ai-isa/turns`, { status: 200, body: { turns: [] } })
    .on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: { rows: p.assignment && !p.assignment.endedAt && !p.assignment.pausedAt ? [row()] : [], holdSentence: hold } })
    .on('GET /me/ai-isa', { status: 200, body: meView({ optIn: optIn() }) });
}

const STATES: [string, () => PanelResponse, string | null][] = [
  ['live', () => panel(), null],
  ['paused', () => panel({ state: 'paused' }), null],
  ['ended', () => panel({ state: 'ended', block: { reason: 'opted_out', since: iso(-1000), sentence: 'x' } }), null],
  ['hold', () => panel(), 'AI assistant sending is off on this deployment.'],
  ['refusal', () => panel({ state: 'none', startRefusal: { code: 'AI_ISA_FIRST_TOUCH_PENDING', sentence: 'x' } }), null],
  ['finalizing', () => {
    const p = panel({ state: 'paused' });
    p.assignment!.undoUntil = iso(8000);
    return p;
  }, null],
];

describe('AI care accessibility (axe-core)', () => {
  for (const [name, p, hold] of STATES) {
    it(`the person page (${name}) has no axe violations`, async () => {
      isaApp(base(p(), hold), `/contacts/${IDS.jane}`, 'agent');
      await screen.findAllByText('Jane Doe', { selector: 'h2' });
      if (name !== 'refusal') await screen.findByTestId('ai-strip');
      else await screen.findByTestId('ai-refusal');
      expect(await violations()).toEqual([]);
    });
  }

  it('the thread with the Undo toast open has no axe violations', async () => {
    const fake = base(panel()).on(`POST /contacts/${IDS.jane}/ai-isa/take-over`, { status: 200, body: { assignmentId: ISA_IDS.assignment, state: 'paused', epoch: 1, inFlight: [], canceled: 0, undoUntil: new Date(Date.now() + UNDO_MS).toISOString(), sentence: 'x' } });
    isaApp(fake, `/contacts/${IDS.jane}/thread`, 'agent');
    await userEvent.setup().click(within(await screen.findByTestId('ai-thread-banner')).getByRole('button', { name: 'Take over' }));
    await screen.findByTestId('ai-undo-toast');
    expect(await violations()).toEqual([]);
  });

  it('Under AI care has no axe violations', async () => {
    isaApp(new FakeFetch().on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: { rows: [row({ handoffOverdue: true, nextTouchAt: iso(3_600_000) })], holdSentence: 'AI assistant sending is off on this deployment.' } }), '/ai-care', 'owner');
    await screen.findByRole('link', { name: 'Jane Doe' });
    expect(await violations()).toEqual([]);
  });

  it('the handoff card has no axe violations', async () => {
    const c = card({ itemType: 'ai_isa_handoff', band: 'pinned', dueAt: iso(900_000), subjectType: 'ai_isa_handoff', subjectId: ISA_IDS.handoff, reasons: [{ code: 'AI_ISA_HANDOFF:escalated', label: 'x' }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
    const fake = contactReads(new FakeFetch()).on('GET /feed', { status: 200, body: feed([c], []) }).on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: handoffView() });
    isaApp(fake, '/', 'agent');
    await within(await screen.findByTestId('ai-card-ai_isa_handoff')).findByText('They asked to talk to a person.');
    expect(await violations()).toEqual([]);
  });

  it('My AI assistant and the team page have no axe violations', async () => {
    const v = isaApp(new FakeFetch().on('GET /me/ai-isa', { status: 200, body: meView({ optIn: optIn(), underCare: 1 }) }), '/settings/ai-assistant', 'agent');
    await screen.findByTestId('attestation');
    expect(await violations()).toEqual([]);
    v.view.unmount();
    isaApp(new FakeFetch().on('GET /admin/ai-isa', { status: 200, body: adminView({ packCleared: false, overdueHandoffs: 1 }) }).on('GET /me/ai-isa', { status: 200, body: meView() }).on('GET /playbooks', { status: 200, body: { playbooks: [] } }), '/settings/ai-assistant/team', 'owner');
    await screen.findByTestId('ai-team-holds');
    expect(await violations()).toEqual([]);
  });
});
