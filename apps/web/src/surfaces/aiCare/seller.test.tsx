// The seller side of the person's AI care panel (R-ISA-35; E1007, E1008): the home the assistant believes it is
// discussing, and the four actions of the seller routes, each drawn only when the API says it is available and each
// showing the server's own sentence, also on a refusal. Plus the two handoff next steps that used to read
// "not available yet".
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SellerPanelView } from './api.js';
import { FakeFetch, IDS, ISA_IDS, SELLER_IDS, SHA, contactReads, handoffView, isaApp, isaRequestViolations, isaResponseViolations, meView, optIn, panel, row, sellerPanel } from './testing.js';
import { card, feed } from '../feed/lib/testing.js';
import { iso } from './testing.js';

const LOAD = { timeout: 10_000 };
const handoffCard = () =>
  card({ itemType: 'ai_isa_handoff', band: 'pinned', dueAt: iso(900_000), subjectType: 'ai_isa_handoff', subjectId: ISA_IDS.handoff, reasons: [{ code: 'AI_ISA_HANDOFF:escalated', label: 'AI care handed back to you' }], primaryAction: { kind: 'open_contact', label: 'Open', contactId: IDS.jane } });
function feedOf(cards: ReturnType<typeof card>[], o: { handoff?: ReturnType<typeof handoffView> } = {}) {
  return contactReads(new FakeFetch())
    .on('GET /feed', { status: 200, body: feed(cards.filter((c) => c.band === 'pinned'), cards.filter((c) => c.band !== 'pinned')) })
    .on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: { rows: [], holdSentence: null } })
    .on(`GET /ai-isa/handoffs/${ISA_IDS.handoff}`, { status: 200, body: o.handoff ?? handoffView() })
    .on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: panel() });
}
const SELLER = `GET /contacts/${IDS.jane}/ai-isa/seller`;
const OK = (sentence: string) => ({ status: 200, body: { ok: true, sentence } });
const off = (reason: string) => ({ available: false, reason });

function person(seller: SellerPanelView | null, o: { side?: 'seller' | 'both' | 'buyer'; state?: 'live' | 'paused' } = {}) {
  const p = panel({ state: o.state ?? 'live' });
  p.assignment!.side = o.side ?? 'seller';
  const fake = contactReads(new FakeFetch())
    .on(`GET /contacts/${IDS.jane}/ai-isa`, { status: 200, body: p })
    .on(`GET /contacts/${IDS.jane}/ai-isa/turns`, { status: 200, body: { turns: [] } })
    .on('GET /ai-isa/assignments?scope=all&state=live', { status: 200, body: { rows: [row()], holdSentence: null } })
    .on('GET /me/ai-isa', { status: 200, body: meView({ optIn: optIn(), sentence: 'You are opted in.' }) });
  if (seller) fake.on(SELLER, { status: 200, body: seller });
  return fake;
}
const home = async () => within(await screen.findByTestId('ai-seller-home', {}, LOAD));

describe('the fixtures say only what the API can (webContract.json)', () => {
  it('the seller panel and its requests fit the contract', () => {
    expect(isaResponseViolations('GET /contacts/:id/ai-isa/seller', sellerPanel())).toEqual([]);
    expect(isaRequestViolations('POST /contacts/:id/ai-isa/confirm-subject', { contactAddressId: SELLER_IDS.address, recordListingId: SELLER_IDS.record, factsSha256: SHA })).toEqual([]);
    expect(isaRequestViolations('POST /contacts/:id/ai-isa/seller/near-match-different', { listingIds: [SELLER_IDS.near] })).toEqual([]);
  });
});

describe('the seller home in the AI care panel', () => {
  it('E1007: shows the home the assistant believes it is discussing; Confirm sends what the panel showed and says the server’s sentence', async () => {
    const fake = person(sellerPanel()).on(`POST /contacts/${IDS.jane}/ai-isa/confirm-subject`, OK('Confirmed. The assistant compares recent sales with this home’s MLS record.'));
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const h = await home();
    expect(h.getByText('The home the assistant believes it is discussing')).toBeInTheDocument();
    expect(h.getByText('12 Sample Ct, Oakland, CA 94110')).toBeInTheDocument();
    expect(h.getByText('Single family, 3 bedrooms, 2 bathrooms, 1,500 sq ft (from its MLS record).')).toBeInTheDocument();
    expect(h.getByText('Not confirmed yet. The assistant shares nothing about this home until you confirm it.')).toBeInTheDocument();
    // only the action the API offers
    expect(h.queryByRole('button', { name: 'That is not their home' })).toBeNull();
    expect(h.queryByRole('button', { name: 'Near match, different home' })).toBeNull();
    expect(h.queryByRole('button', { name: 'Resume comps' })).toBeNull();
    fake.on(SELLER, { status: 200, body: sellerPanel({ actions: { ...sellerPanel().actions, confirmSubject: off('The home is confirmed.'), subjectDisputed: { available: true, reason: null } }, subject: { ...sellerPanel().subject, confirmed: true, confirmedAt: new Date().toISOString(), codes: [] } }) });
    await userEvent.setup().click(h.getByRole('button', { name: 'Confirm this is their home' }));
    await waitFor(() => expect(h.getByTestId('ai-seller-line').textContent).toBe('Confirmed. The assistant compares recent sales with this home’s MLS record.'));
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/confirm-subject`)[0]!.body).toEqual({ contactAddressId: SELLER_IDS.address, recordListingId: SELLER_IDS.record, factsSha256: SHA });
    expect(await h.findByText('Confirmed: the assistant may compare recent sales with this home.')).toBeInTheDocument();
    expect(await h.findByRole('button', { name: 'That is not their home' })).toBeInTheDocument();
    expect(h.queryByRole('button', { name: 'Confirm this is their home' })).toBeNull();
  });

  it('E1007: a refusal shows the server’s own reason, never a code', async () => {
    const fake = person(sellerPanel()).on(`POST /contacts/${IDS.jane}/ai-isa/confirm-subject`, { status: 409, body: { error: { code: 'SUBJECT_CHANGED', requestId: 'r', details: { sentence: 'The home’s record or address changed since the panel was shown. Look again, then confirm.' } } } });
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const h = await home();
    await userEvent.setup().click(h.getByRole('button', { name: 'Confirm this is their home' }));
    await waitFor(() => expect(h.getByTestId('ai-seller-line').textContent).toBe('The home’s record or address changed since the panel was shown. Look again, then confirm.'));
    expect(document.body.textContent).not.toMatch(/SUBJECT_CHANGED/);
  });

  it('E1007: a home that cannot be confirmed says why and what to do, with no Confirm', async () => {
    const s = sellerPanel();
    isaApp(person({ ...s, actions: { ...s.actions, confirmSubject: off('Add the address of the home they are selling.') },
      subject: { ...s.subject, state: 'incomplete', code: 'SUBJECT_INCOMPLETE', sentence: 'Add the address of the home they are selling.', nextStep: 'Add a property address on the person.', addressLine: null, facts: null, factsSha256: null, recordListingId: null, contactAddressId: null } }), `/contacts/${IDS.jane}`, 'agent');
    const h = await home();
    expect(h.getByText('Add the address of the home they are selling.')).toBeInTheDocument();
    expect(h.getByText('Add a property address on the person.')).toBeInTheDocument();
    expect(h.queryByRole('button')).toBeNull();
  });

  it('E1007: "That is not their home" is there for a confirmed home and says what stops', async () => {
    const s = sellerPanel();
    const fake = person({ ...s, actions: { ...s.actions, confirmSubject: off('The home is confirmed.'), subjectDisputed: { available: true, reason: null } }, subject: { ...s.subject, confirmed: true, confirmedAt: new Date().toISOString(), codes: [] } })
      .on(`POST /contacts/${IDS.jane}/ai-isa/seller/subject-disputed`, OK('Marked disputed. Recent sales stop until the owner confirms the home again.'));
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const h = await home();
    await userEvent.setup().click(h.getByRole('button', { name: 'That is not their home' }));
    await waitFor(() => expect(h.getByTestId('ai-seller-line').textContent).toBe('Marked disputed. Recent sales stop until the owner confirms the home again.'));
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/seller/subject-disputed`)).toHaveLength(1);
  });

  it('E1008: a possible listing shows while care is paused; "Near match, different home" sends the listing ids the API gave', async () => {
    const s = sellerPanel();
    const fake = person({ ...s, actions: { ...s.actions, confirmSubject: off('The home is confirmed.'), nearMatchDifferent: { available: true, reason: null, listingIds: [SELLER_IDS.near] } },
      subject: { ...s.subject, confirmed: true, codes: [] }, link: { effect: 'pause', code: 'AI_ISA_POSSIBLE_LISTING', sentence: 'Possibly listed: confirm it’s a different home, then resume.', listingIds: [SELLER_IDS.near] } }, { state: 'paused' })
      .on(`POST /contacts/${IDS.jane}/ai-isa/seller/near-match-different`, OK('Noted: a different home. Resume AI care to continue; recent sales stay off while a live listing may be this home.'));
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const h = await home();
    expect(h.getByText('Possibly listed: confirm it’s a different home, then resume.')).toBeInTheDocument();
    await userEvent.setup().click(h.getByRole('button', { name: 'Near match, different home' }));
    await waitFor(() => expect(h.getByTestId('ai-seller-line').textContent).toMatch(/^Noted: a different home\./));
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/ai-isa/seller/near-match-different`)[0]!.body).toEqual({ listingIds: [SELLER_IDS.near] });
  });

  it('E1008: "Resume comps" is there only while the API says recent sales are paused and offers it', async () => {
    const s = sellerPanel();
    const paused = { ...s, actions: { ...s.actions, confirmSubject: off('The home is confirmed.'), resumeComps: { available: true, reason: null } }, subject: { ...s.subject, confirmed: true, codes: [] },
      suspension: { suspended: true, sentence: 'Recent sales paused: they asked about price. Prepare or re-run a CMA, share one, or let the assistant keep sharing.' } };
    const fake = person(paused).on(`POST /contacts/${IDS.jane}/ai-isa/seller/resume-comps`, OK('The assistant may share recent sales again, by email, when every check passes.'));
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    const h = await home();
    expect(h.getByText('Recent sales paused: they asked about price. Prepare or re-run a CMA, share one, or let the assistant keep sharing.')).toBeInTheDocument();
    await userEvent.setup().click(h.getByRole('button', { name: 'Resume comps' }));
    await waitFor(() => expect(h.getByTestId('ai-seller-line').textContent).toBe('The assistant may share recent sales again, by email, when every check passes.'));
  });

  it('a viewer the API offers nothing gets no control (a paused suspension still reads, without its button)', async () => {
    const s = sellerPanel();
    isaApp(person({ ...s, actions: { confirmSubject: off('Only the lead’s owner confirms the home.'), subjectDisputed: off('The owner has not confirmed the home yet.'), nearMatchDifferent: { ...off('No live listing may be this home.'), listingIds: [] },
      resumeComps: off('Only the lead’s owner can let the assistant keep sharing recent sales.') }, suspension: { suspended: true, sentence: 'Recent sales paused: they asked about price. Prepare or re-run a CMA, share one, or let the assistant keep sharing.' } }), `/contacts/${IDS.jane}`, 'team_lead');
    const h = await home();
    expect(h.queryByRole('button')).toBeNull();
    expect(h.getByText('Only the lead’s owner confirms the home.')).toBeInTheDocument();
    expect(h.getByText(/^Recent sales paused/)).toBeInTheDocument();
  });

  it('buyer-side care asks nothing about a seller home', async () => {
    const fake = person(null, { side: 'buyer' });
    isaApp(fake, `/contacts/${IDS.jane}`, 'agent');
    await screen.findByTestId('ai-strip', {}, LOAD);
    expect(screen.queryByTestId('ai-seller-home')).toBeNull();
    expect(fake.callsTo(SELLER)).toHaveLength(0);
  });
});

describe('the handoff card’s seller next steps are real actions', () => {
  it('"Confirm the home they’re selling" opens the person’s AI care panel at the home', async () => {
    const h = handoffView();
    const v = isaApp(feedOf([handoffCard()], { handoff: { ...h, package: { ...h.package, nextSteps: ['confirm_subject'] } } }), '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    await userEvent.setup().click(await within(c).findByRole('button', { name: "Confirm the home they're selling" }));
    await waitFor(() => expect(v.router.state.location.pathname).toBe(`/contacts/${IDS.jane}`));
    expect(v.router.state.location.hash).toBe('#ai-seller-home');
    expect(c.textContent).not.toMatch(/not available yet/);
  });

  it('"Prepare a CMA" is the one tap: it asks for the contact’s CMA and opens it; a refusal says the server’s reason and points to the Home value section', async () => {
    const h = handoffView();
    const cmaId = '01900000-0000-7000-8000-0000000e0001';
    const fake = feedOf([handoffCard()], { handoff: { ...h, package: { ...h.package, nextSteps: ['prepare_cma'] } } }).on(`POST /contacts/${IDS.jane}/cma`, { status: 200, body: { cma: { id: cmaId } } });
    const v = isaApp(fake, '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    expect(c.textContent).not.toMatch(/not available yet/);
    await userEvent.setup().click(await within(c).findByRole('button', { name: 'Prepare a CMA' }));
    await waitFor(() => expect(v.router.state.location.pathname).toBe(`/cma/${cmaId}`));
    expect(fake.callsTo(`POST /contacts/${IDS.jane}/cma`)[0]!.body).toEqual({});
  });

  it('"Prepare a CMA" refused: the reason in words and a link to the person’s Home value section, where the missing facts are asked for', async () => {
    const h = handoffView();
    const fake = feedOf([handoffCard()], { handoff: { ...h, package: { ...h.package, nextSteps: ['prepare_cma'] } } })
      .on(`POST /contacts/${IDS.jane}/cma`, { status: 422, body: { error: { code: 'CMA_SUBJECT_INCOMPLETE', requestId: 'r', details: { missing: ['address'] } } } });
    isaApp(fake, '/', 'agent');
    const c = await screen.findByTestId('ai-card-ai_isa_handoff');
    await userEvent.setup().click(await within(c).findByRole('button', { name: 'Prepare a CMA' }));
    const line = await within(c).findByTestId('ai-cma-line');
    expect(line.textContent).not.toMatch(/CMA_SUBJECT_INCOMPLETE/);
    expect(within(line).getByRole('link', { name: 'Open their Home value section' })).toHaveAttribute('href', `/contacts/${IDS.jane}#cma`);
  });
});
