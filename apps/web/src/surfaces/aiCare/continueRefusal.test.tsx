// b18 review item 3 (after B18S-1 and B18S-5): a re-inquiry from a lead source marked "No automated contact for leads
// from this source" pauses AI care 'reinquiry', and Continue is always refused for such a person. The panel route says
// so (canContinue false, continueRefusal), so the panel shows the refusal's sentence and no "Continue AI care" button;
// a person from another source still gets the button. Fakes only; a made-up source.
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PanelResponse } from './api.js';
import { FakeFetch, IDS, contactReads, isaApp, meView, optIn, panel, row } from './testing.js';

const REFUSAL = "No automated contact for leads from this source: the Owner turned this on for this person's lead source, so the AI assistant does not care for them (nothing automatic goes to them; call, text or email them one to one).";

function person(p: PanelResponse) {
  return contactReads(new FakeFetch())
    .on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: p })
    .on(`GET /contacts/${IDS.jane}/ai-isa/turns`, { status: 200, body: { turns: [] } })
    .on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: { rows: [row()], holdSentence: null } })
    .on('GET /me/ai-isa', { status: 200, body: meView({ optIn: optIn(), sentence: 'You are opted in.' }) });
}
function reinquiry(o: Partial<Pick<PanelResponse, 'canContinue' | 'continueRefusal'>>): PanelResponse {
  const p = panel({ state: 'paused' });
  p.assignment!.pauseReason = 'reinquiry';
  return { ...p, ...o };
}

describe('b18 review item 3: Continue AI care is hidden when the person\'s lead source is marked "No automated contact"', () => {
  it('E723 R-LSRC-8: the owner sees the refusal sentence and no "Continue AI care" button', async () => {
    isaApp(person(reinquiry({ canContinue: false, continueRefusal: { code: 'AI_ISA_SOURCE_NO_AI_CARE', sentence: REFUSAL } })), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText('Jane inquired again. AI care is paused so you can see the new inquiry.')).toBeInTheDocument();
    expect(screen.getByText(REFUSAL)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue AI care' })).toBeNull();
  });

  it('E516: with no refusal the owner still gets the button', async () => {
    isaApp(person(reinquiry({ canContinue: true, continueRefusal: null })), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByRole('button', { name: 'Continue AI care' })).toBeInTheDocument();
  });
});
