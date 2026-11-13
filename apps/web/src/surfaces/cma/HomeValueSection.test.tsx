// The contact page's "Home value (CMA)" section (module 72; F15, E373) in jsdom on a scripted API: the contact's CMAs
// with their status, "Prepare CMA" as one tap to the CMA screen, the prompts when the server cannot prepare one (no
// address; no property type or size), every other refusal in words, and nothing for an ISA or a TC.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { contactSections } from '../contact/sections.js';
import { HomeValueSection } from './HomeValueSection.js';
import { CMA_ID, CONTACT, FakeFetch, err, preview, sectionApp, summary, view } from './testing.js';

const user = () => userEvent.setup();
const LIST = `GET /contacts/${CONTACT}/cmas`;
const TAP = `POST /contacts/${CONTACT}/cma`;

const section = async () => (await screen.findByRole('heading', { name: 'Home value (CMA)' })).closest('section')!;

describe('Home value (CMA) section', () => {
  it('is one section of the contact page, order 15', () => {
    expect(contactSections.find((s) => s.id === 'cma')).toEqual({ id: 'cma', order: 15, component: HomeValueSection });
  });

  it("lists the contact's CMAs with their status chips; a row opens the CMA", async () => {
    const f = new FakeFetch()
      .on(LIST, {
        status: 200,
        body: {
          cmas: [
            summary(),
            summary({ id: '01900000-0000-7000-8000-0000000c3a02', status: 'shared', mine: false, address: '100 Sample Ave, Oakland, CA 94110' }),
            summary({ id: '01900000-0000-7000-8000-0000000c3a03', status: 'superseded', lowCents: null, highCents: null, valueCents: null, fromMergedRecord: true, address: null }),
          ],
        },
      })
      .on(`GET /cma/${CMA_ID}`, { status: 200, body: { cma: view() } })
      .on(`GET /cma/${CMA_ID}/share-preview`, { status: 200, body: { preview: preview() } });
    sectionApp(f);
    const s = within(await section());
    const list = await s.findByRole('list', { name: 'CMAs of this contact' });
    const rows = within(list).getAllByRole('link');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('100 Sample Ave, Oakland, CA 94110');
    expect(rows[0]).toHaveTextContent('$520,000 to $570,000 · Nov 12, 2026');
    expect(within(rows[0]!).getByText('Draft')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Shared')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Prepared by someone else');
    expect(within(rows[2]!).getByText('Superseded')).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('The home');
    expect(rows[2]).toHaveTextContent('No value');
    expect(rows[2]).toHaveTextContent('From a merged record');
    await user().click(rows[0]!);
    expect(await screen.findByRole('heading', { name: 'Estimated range' })).toBeInTheDocument();
  });

  it('F15: "Prepare CMA" is one tap: one POST (a double tap included), then the CMA screen opens on the answer', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((ok) => (release = ok));
    const f = new FakeFetch()
      .on(LIST, { status: 200, body: { cmas: [] } })
      .on(TAP, async () => {
        await gate;
        return { status: 201, body: { cma: view() } };
      })
      .on(`GET /cma/${CMA_ID}/share-preview`, { status: 200, body: { preview: preview() } });
    const { router } = sectionApp(f);
    const s = within(await section());
    expect(await s.findByText('No CMA for this contact yet.')).toBeInTheDocument();
    await user().dblClick(s.getByRole('button', { name: 'Prepare CMA' }));
    expect(s.getByRole('button', { name: 'Preparing' })).toHaveAttribute('aria-busy', 'true');
    release();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/cma/${CMA_ID}`));
    expect(await screen.findByRole('heading', { name: 'Estimated range' })).toBeInTheDocument();
    expect(f.callsTo(TAP)).toHaveLength(1);
    expect(f.callsTo(TAP)[0]!.body).toEqual({});
    // the screen opened on the answer in hand: no second read of the CMA
    expect(f.callsTo(`GET /cma/${CMA_ID}`)).toHaveLength(0);
  });

  it('E373: with no address on the contact it says to add one, with a way to the Details section', async () => {
    const f = new FakeFetch().on(LIST, { status: 200, body: { cmas: [] } }).on(TAP, err(422, 'CMA_SUBJECT_INCOMPLETE', { missing: ['address'], sentence: 'Add the home’s address (a property or home address) to prepare a CMA.' }));
    sectionApp(f);
    const s = within(await section());
    await user().click(await s.findByRole('button', { name: 'Prepare CMA' }));
    expect(await s.findByText('Add the home’s address (a property or home address) to prepare a CMA.')).toBeInTheDocument();
    await user().click(s.getByRole('button', { name: 'Go to Details' }));
    expect(screen.getByRole('heading', { name: 'Details' })).toHaveFocus();
  });

  it('E373: with no property type or size in the MLS history it asks for both (type chips, a size field) and taps again with {facts}', async () => {
    const f = new FakeFetch()
      .on(LIST, { status: 200, body: { cmas: [] } })
      .on(TAP, (c) => (c.body && (c.body as { facts?: unknown }).facts ? { status: 201, body: { cma: view() } } : err(422, 'CMA_SUBJECT_INCOMPLETE', { missing: ['propertyType', 'sqft'], sentence: 'This address is not in the MLS history. Enter the property type and size to prepare a CMA.' })))
      .on(`GET /cma/${CMA_ID}/share-preview`, { status: 200, body: { preview: preview() } });
    const { router } = sectionApp(f);
    const s = within(await section());
    await user().click(await s.findByRole('button', { name: 'Prepare CMA' }));
    expect(await s.findByText('This address is not in the MLS history. Enter the property type and size to prepare a CMA.')).toBeInTheDocument();
    const group = s.getByRole('group', { name: 'Property type' });
    expect(within(group).getAllByRole('button')).toHaveLength(7);
    await user().click(s.getByRole('button', { name: 'Prepare CMA with these facts' }));
    expect(s.getByText('Choose the property type.')).toBeInTheDocument();
    expect(f.callsTo(TAP)).toHaveLength(1);
    await user().click(within(group).getByRole('button', { name: 'Condo' }));
    expect(within(group).getByRole('button', { name: 'Condo' })).toHaveAttribute('aria-pressed', 'true');
    await user().type(s.getByLabelText('Square feet'), '980');
    await user().click(s.getByRole('button', { name: 'Prepare CMA with these facts' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/cma/${CMA_ID}`));
    expect(f.callsTo(TAP)[1]!.body).toEqual({ facts: { propertyType: 'condo', sqft: 980 } });
  });

  it('only the size missing asks for the size alone', async () => {
    const f = new FakeFetch().on(LIST, { status: 200, body: { cmas: [] } }).on(TAP, err(422, 'CMA_SUBJECT_INCOMPLETE', { missing: ['sqft'], sentence: 'Enter the size to prepare a CMA.' }));
    sectionApp(f);
    const s = within(await section());
    await user().click(await s.findByRole('button', { name: 'Prepare CMA' }));
    expect(await s.findByLabelText('Square feet')).toBeInTheDocument();
    expect(s.queryByRole('group', { name: 'Property type' })).toBeNull();
  });

  it.each([
    ['CMA_NO_MLS_CONNECTION', { sentence: 'No MLS feed is connected, so there are no sold homes to compare.' }, 'No MLS feed is connected, so there are no sold homes to compare.'],
    ['CMA_VALUATION_NOT_ALLOWED', undefined, 'Your MLS licence pack does not say MLS sold data may be used for valuations. An admin records it on the MLS page, under Valuation use.'],
    ['CMA_SUBJECT_TYPE_NOT_SUPPORTED', { propertyType: 'land', sentence: 'Land and other property types are not valued yet: CMAs cover homes only for now.' }, 'Land and other property types are not valued yet: CMAs cover homes only for now.'],
    ['RATE_LIMITED', undefined, 'Too many tries in a short time. Wait a few minutes, then try again.'],
  ] as const)('%s is said in words', async (code, details, words) => {
    const f = new FakeFetch().on(LIST, { status: 200, body: { cmas: [] } }).on(TAP, err(409, code, details as Record<string, unknown> | undefined));
    sectionApp(f);
    const s = within(await section());
    await user().click(await s.findByRole('button', { name: 'Prepare CMA' }));
    expect(await s.findByText(words)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(code);
  });

  it.each(['isa', 'tc'] as const)('R-PERM: an %s sees no Home value section and nothing is asked for', async (role) => {
    const f = new FakeFetch().on(LIST, { status: 200, body: { cmas: [] } });
    sectionApp(f, role);
    expect(await screen.findByRole('heading', { name: 'Details' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Home value (CMA)' })).toBeNull();
    expect(f.callsTo(LIST)).toHaveLength(0);
  });

  it.each(['owner', 'admin', 'team_lead', 'agent'] as const)('a %s sees the section', async (role) => {
    sectionApp(new FakeFetch().on(LIST, { status: 200, body: { cmas: [] } }), role);
    expect(await screen.findByRole('heading', { name: 'Home value (CMA)' })).toBeInTheDocument();
  });
});
