// b18 review item 3 (after B18S-1 and B18S-5): a re-inquiry from a lead source marked "No automated contact for leads
// from this source" pauses AI care 'reinquiry', and Continue is always refused for such a person. The panel route says
// so (canContinue false, continueRefusal), so the panel shows the refusal's sentence and no "Continue AI care" button;
// a person from another source still gets the button. Fakes only; a made-up source.
// b18 round 3 item 6: the same for care paused by a policy change (policy_updated, approval_revoked). The panel offered
// "Re-attest in My AI assistant to continue", but re-attesting does not continue care for such a person (Continue is
// refused), so the refusal's sentence replaces the link.
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

function paused(reason: 'policy_updated' | 'approval_revoked', o: Partial<Pick<PanelResponse, 'canContinue' | 'continueRefusal'>>): PanelResponse {
  const p = panel({ state: 'paused' });
  p.assignment!.pauseReason = reason;
  return { ...p, ...o };
}

describe('b18 round 3 item 6: no "Re-attest … to continue" when the person\'s lead source is marked "No automated contact"', () => {
  it.each(['policy_updated', 'approval_revoked'] as const)('E723 R-LSRC-8: care paused %s for such a person: the owner sees that the rules changed and the refusal sentence, and no "Re-attest in My AI assistant" link (re-attesting would not continue it)', async (reason) => {
    isaApp(person(paused(reason, { canContinue: false, continueRefusal: { code: 'AI_ISA_SOURCE_NO_AI_CARE', sentence: REFUSAL } })), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(screen.getByText('The team changed the AI rules.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Re-attest in My AI assistant' })).toBeNull();
    expect(screen.queryByText(/to continue/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue AI care' })).toBeNull();
  });

  it.each(['policy_updated', 'approval_revoked'] as const)('E516: care paused %s with no refusal: the owner still gets the re-attest link', async (reason) => {
    isaApp(person(paused(reason, { canContinue: true, continueRefusal: null })), `/contacts/${IDS.jane}`, 'agent');
    expect(await screen.findByRole('link', { name: 'Re-attest in My AI assistant' })).toBeInTheDocument();
    expect(screen.queryByText(REFUSAL)).toBeNull();
  });
});

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
