// Contract-date review in jsdom on the staff contract (module 55 item 7; R-STAFF-1, R-STAFF-2, R-STAFF-6, E675, E676).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { StaffFake, staffError } from '../../test/staffContract.js';
import { CONFIRM_WHO } from '../deals/milestones.js';
import { groupClaims } from './DatesPage.js';
import { ACTION, CLAIM1, CLAIM2, CLAIM3, COPY, DATE1, DEAL, DOC, RAW, app, claim, doc, extraction, milestones, platform } from './fixtures.js';
import { surface } from './index.js';
import type { ExtractionResponse } from './types.js';

const PATH = `/documents/${DOC}/dates`;
const confirmPath = (id: string) => `POST /documents/${DOC}/extraction/claims/${id}/confirm`;
const rejectPath = (id: string) => `POST /documents/${DOC}/extraction/claims/${id}/reject`;
const UUID = /^[0-9a-f-]{36}$/;

/** The API's extraction: a decision changes what the next read returns (the refetch after a confirm sees it). */
function fakeFor(x: ExtractionResponse, canConfirm = true): StaffFake & { state: { current: ExtractionResponse } } {
  const state = { current: x };
  const fake = new StaffFake().on(`GET /documents/${DOC}/extraction`, () => ({ status: 200, body: state.current })).on(`GET /deals/${DEAL}/milestones`, { status: 200, body: milestones(canConfirm) });
  return Object.assign(fake, { state });
}
const answer = (fake: { state: { current: ExtractionResponse } }, body: ExtractionResponse & { dateId: string | null }) => () => {
  const { dateId: _d, ...view } = body;
  fake.state.current = view;
  return { status: 200, body };
};
const open = (fake: StaffFake, role: Parameters<typeof app>[2] = 'agent') => app(fake, PATH, role, surface);
const page = async () => {
  await screen.findByRole('heading', { level: 1, name: 'Contract dates' });
  await screen.findByRole('heading', { level: 2 });
  return screen.getByRole('main');
};
const noAssistant = (fake: StaffFake) => expect(fake.calls.filter((c) => c.path.startsWith('/assistant'))).toEqual([]);
const decided = (x: ExtractionResponse, over: Partial<ReturnType<typeof claim>>) => ({ ...x, claims: x.claims.map((c) => ({ ...c, ...over })), dateId: over.reviewStatus === 'confirmed' ? DATE1 : null });

describe('contract-date review', () => {
  it('R-STAFF-2: each claim shows its text, page and quoted evidence line; Confirm sends a commandId and a target, one tap from a preselected new date; no /assistant request; axe finds nothing', async () => {
    const x = extraction();
    const fake = fakeFor(x);
    fake.on(confirmPath(CLAIM1), answer(fake, decided(x, { reviewStatus: 'confirmed', appliedDateId: DATE1 })));
    open(fake);
    const m = await page();
    const card = within(m).getByRole('article', { name: 'Closing on Dec 18, 2026' });
    expect(within(card).getByText('Page 3')).toBeInTheDocument();
    expect(within(card).getByText('“Closing Date: December 18, 2026” in the document')).toBeInTheDocument();
    expect(within(m).getByText(COPY.explanation)).toBeInTheDocument();
    expect(within(m).getByRole('link', { name: 'Open the deal timeline' })).toHaveAttribute('href', `/deals/${DEAL}`);
    await waitFor(() => expect(within(card).getByRole('radio', { name: 'Add as a new date' })).toBeChecked());
    expect(await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } }).then((r) => r.violations.map((v) => v.id))).toEqual([]);
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Confirm' }));
    expect(await within(m).findByText('Confirmed: on the deal timeline.')).toBeInTheDocument();
    const calls = fake.callsTo(confirmPath(CLAIM1));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ target: { kind: 'new' }, commandId: expect.stringMatching(UUID) });
    expect(within(m).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(m.textContent).not.toMatch(RAW);
    expect(m.textContent).not.toMatch(/confidence|score|probab|%/i);
    noAssistant(fake);
  });

  it('R-STAFF-2: "Replace {label} on {date}" names the live date; the reminder (0-60) is sent; Not right sends only a commandId', async () => {
    const c1 = claim({ liveDates: [{ dateId: DATE1, label: 'Closing', dueOn: '2026-12-20', status: 'confirmed', source: 'template' }] });
    const c2 = claim({ id: CLAIM2, ordinal: 2, text: 'Inspection by Nov 20, 2026', milestone: { kind: 'inspection', label: 'Inspection', dueOn: '2026-11-20' } });
    const x = extraction({ claims: [c1, c2] });
    const fake = fakeFor(x)
      .on(confirmPath(CLAIM1), { status: 200, body: { ...x, dateId: DATE1 } })
      .on(rejectPath(CLAIM2), { status: 200, body: { ...x, dateId: null } });
    open(fake);
    const m = await page();
    const user = userEvent.setup();
    const card = within(m).getByRole('article', { name: 'Closing on Dec 18, 2026' });
    const confirm = await within(card).findByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await user.click(within(card).getByRole('radio', { name: 'Replace Closing on Dec 20, 2026' }));
    await user.type(within(card).getByLabelText('Reminder, days before (optional, 0 to 60)'), '61');
    expect(confirm).toBeDisabled();
    await user.clear(within(card).getByLabelText('Reminder, days before (optional, 0 to 60)'));
    await user.type(within(card).getByLabelText('Reminder, days before (optional, 0 to 60)'), '3');
    await user.click(confirm);
    await waitFor(() => expect(fake.callsTo(confirmPath(CLAIM1))).toHaveLength(1));
    expect(fake.callsTo(confirmPath(CLAIM1))[0]!.body).toEqual({ target: { kind: 'existing', dateId: DATE1 }, reminderDaysBefore: 3, commandId: expect.stringMatching(UUID) });
    await user.click(within(within(m).getByRole('article', { name: 'Inspection by Nov 20, 2026' })).getByRole('button', { name: 'Not right' }));
    await waitFor(() => expect(fake.callsTo(rejectPath(CLAIM2))).toHaveLength(1));
    expect(fake.callsTo(rejectPath(CLAIM2))[0]!.body).toEqual({ commandId: expect.stringMatching(UUID) });
    noAssistant(fake);
  });

  it('E675: a needs-review claim shows the API\'s reviewNote and has no Confirm; conflicting claims sit side by side with the conflictNote, none preselected', async () => {
    const a = claim({ conflictsWith: [CLAIM2], conflictNote: COPY.conflict });
    const b = claim({ id: CLAIM2, ordinal: 2, text: 'Closing on Jan 8, 2027', milestone: { kind: 'closing', label: 'Closing', dueOn: '2027-01-08' }, conflictsWith: [CLAIM1], conflictNote: COPY.conflict });
    const c = claim({ id: CLAIM3, ordinal: 3, text: 'Appraisal by Nov 30, 2026', milestone: { kind: 'appraisal', label: 'Appraisal', dueOn: '2026-11-30' }, needsReview: true, reviewNote: COPY.needsReview, evidence: [{ sourceType: 'document', locator: { kind: 'char_range', page: 2, start: 0, end: 9 }, snippet: 'Appraisal', verified: false, line: '“Appraisal” in the document' }] });
    const fake = fakeFor(extraction({ claims: [a, b, c] }));
    open(fake);
    const m = await page();
    const group = within(m).getByRole('group', { name: 'Different dates for Closing' });
    await within(group).findAllByRole('button', { name: 'Confirm' });
    const cards = within(group).getAllByRole('article');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(within(card).getByText(COPY.conflict)).toBeInTheDocument();
      expect(within(card).getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true);
      expect(within(card).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    }
    const review = within(m).getByRole('article', { name: 'Appraisal by Nov 30, 2026' });
    expect(within(review).getByText(COPY.needsReview)).toBeInTheDocument();
    expect(within(review).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(within(review).getByRole('button', { name: 'Not right' })).toBeInTheDocument();
    expect(groupClaims([a, b, c]).map((g) => g.map((x) => x.id))).toEqual([[CLAIM1, CLAIM2], [CLAIM3]]);
  });

  it('R-STAFF-6 E676: an extraction 404 says who can review, with no "Read dates now"; without milestone.confirm the page is read-only with CONFIRM_WHO', async () => {
    const fake = new StaffFake().on(`GET /documents/${DOC}/extraction`, staffError('NOT_FOUND'));
    const r = open(fake, 'tc');
    expect(await screen.findByText('Only the person who uploaded this contract, or an Owner or Admin, can review its dates.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read dates now' })).toBeNull();
    r.view.unmount();
    const fake2 = fakeFor(extraction(), false);
    open(fake2, 'isa');
    const m = await page();
    expect(await within(m).findByText(CONFIRM_WHO)).toBeInTheDocument();
    expect(within(m).queryByRole('button', { name: /Confirm|Not right/ })).toBeNull();
    expect(within(m).getByText('“Closing Date: December 18, 2026” in the document')).toBeInTheDocument();
    noAssistant(fake2);
  });

  it('R-STAFF-1: "Read dates now" only while not_started; it posts no body fields and shows the read result; EXTRACTION_EXISTS is words', async () => {
    const before = extraction({ action: null, claims: [] }, { extraction: { status: 'not_started', outcome: null, claimCount: 0, text: null } });
    const fake = fakeFor(before).on(`POST /documents/${DOC}/extraction/run`, { status: 200, body: extraction() });
    open(fake);
    const m = await page();
    expect(within(m).getByText('The dates in this contract have not been read yet.')).toBeInTheDocument();
    await userEvent.setup().click(within(m).getByRole('button', { name: 'Read dates now' }));
    expect(await within(m).findByRole('article', { name: 'Closing on Dec 18, 2026' })).toBeInTheDocument();
    expect(within(m).queryByRole('button', { name: 'Read dates now' })).toBeNull();
    expect(fake.callsTo(`POST /documents/${DOC}/extraction/run`).map((c) => c.body)).toEqual([{}]);
    noAssistant(fake);
  });

  it.each([
    ['photo (an image-only scan)', { status: 'photo', outcome: null, claimCount: 0, text: COPY.photo }, null, COPY.photo, 'Enter the dates by hand'],
    ['no_text', { status: 'executed', outcome: 'no_text', claimCount: 0, text: COPY.noText }, { id: ACTION, status: 'executed', outcome: 'no_text', text: COPY.noText }, COPY.noText, 'Enter the dates by hand'],
    ['no_dates', { status: 'executed', outcome: 'no_dates', claimCount: 0, text: COPY.noDates }, { id: ACTION, status: 'executed', outcome: 'no_dates', text: COPY.noDates }, COPY.noDates, 'Enter the dates by hand'],
    ['unreadable', { status: 'executed', outcome: 'unreadable', claimCount: 0, text: COPY.unreadable }, { id: ACTION, status: 'executed', outcome: 'unreadable', text: COPY.unreadable }, COPY.unreadable, 'Enter the dates by hand'],
    ['not_set_up', { status: 'not_set_up', outcome: null, claimCount: 0, text: COPY.extractorNotSetUp }, null, COPY.extractorNotSetUp, 'Enter the dates by hand'],
    ['waiting_for_scan', { status: 'waiting_for_scan', outcome: null, claimCount: 0, text: null }, null, 'The dates are read after the file passes the virus check.', 'Open the deal timeline'],
  ] as const)('R-STAFF-1: the %s state shows the API\'s sentence (or its words) and a link to the deal timeline; no Read dates now', async (_name, ex, action, sentence, link) => {
    const x = extraction({ action, claims: [], platform: platform(ex.status === 'not_set_up' ? { extractor: { configured: false, statusText: COPY.extractorNotSetUp } } : {}) }, { extraction: ex, ...(ex.status === 'waiting_for_scan' ? { scan: 'checking', scanText: COPY.checking } : {}) });
    const fake = fakeFor(x);
    open(fake);
    const m = await page();
    expect(within(m).getAllByText(sentence).length).toBeGreaterThan(0);
    expect(within(m).getByRole('link', { name: link })).toHaveAttribute('href', `/deals/${DEAL}`);
    expect(within(m).queryByRole('button', { name: 'Read dates now' })).toBeNull();
    expect(m.textContent).not.toMatch(RAW);
    if (ex.status === 'photo') expect(m.textContent).toContain('Enter the dates by hand');
    noAssistant(fake);
  });

  it('relativeDeadlineText shows as the API words it', async () => {
    open(fakeFor(extraction({ relativeDeadlineText: COPY.relative })));
    expect(await within(await page()).findByText(COPY.relative)).toBeInTheDocument();
  });

  it.each([
    ['EXTRACTION_CLOSED', 'This contract’s date review is closed. The page shows where each date stands.'],
    ['EXTRACTION_CLAIM_NEEDS_REVIEW', 'This date wasn’t found in the contract as quoted, so it can’t be confirmed here. Enter it by hand on the deal timeline if it is right.'],
    ['EXTRACTION_CLAIM_DECIDED', 'Someone already decided this date. The page shows the latest.'],
    ['EXTRACTION_TARGET_KIND', 'That date is a different kind of milestone. Replace a date of the same kind, or add this as a new date.'],
    ['DATE_HUMAN_CONFIRMATION', 'Only a person can confirm a date, as themselves.'],
    ['DOCUMENT_SUPERSEDED', 'A newer version of this contract replaced this one. Review the dates on the newest version.'],
  ])('a confirm refused with %s is words and refetches the review', async (code, words) => {
    const fake = fakeFor(extraction()).on(confirmPath(CLAIM1), staffError(code));
    open(fake);
    const m = await page();
    const card = within(m).getByRole('article', { name: 'Closing on Dec 18, 2026' });
    await waitFor(() => expect(within(card).getByRole('radio', { name: 'Add as a new date' })).toBeChecked());
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Confirm' }));
    expect(await within(m).findByText(words)).toBeInTheDocument();
    expect(fake.callsTo(confirmPath(CLAIM1))).toHaveLength(1);
    await waitFor(() => expect(fake.callsTo(`GET /documents/${DOC}/extraction`).length).toBeGreaterThanOrEqual(2));
    expect(m.textContent).not.toMatch(RAW);
  });

  it('tap budget: from the deal page, "Review N dates" (1) then Confirm (2)', async () => {
    const { DocumentsSection } = await import('./DocumentsSection.js');
    const host = { pages: [{ path: '/t/deal', title: 'Deal', roles: 'all' as const, component: () => <DocumentsSection kind="deal" id={DEAL} ownerUserId={doc().uploadedByUserId} /> }] };
    const x = extraction();
    const fake = fakeFor(x)
      .on(`GET /deals/${DEAL}/documents`, { status: 200, body: { documents: [{ ...x.document, newerVersion: null }], platform: platform() } })
      .on(confirmPath(CLAIM1), { status: 200, body: decided(x, { reviewStatus: 'confirmed', appliedDateId: DATE1 }) });
    app(fake, '/t/deal', 'agent', surface, host);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Review 1 date' }));
    const card = await screen.findByRole('article', { name: 'Closing on Dec 18, 2026' });
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Confirm' })).toBeEnabled());
    await user.click(within(card).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(fake.callsTo(confirmPath(CLAIM1))).toHaveLength(1));
    noAssistant(fake);
  });
});
