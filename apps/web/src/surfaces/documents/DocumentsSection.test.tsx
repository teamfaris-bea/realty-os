// The documents section in jsdom on the staff contract (module 55 item 6; R-STAFF-1, R-STAFF-5, R-STAFF-6, R-STAFF-8,
// E672, E673). Every state comes from an API fixture; StaffFake fails a test whose request the API would refuse.
import type { Role } from '@realty/core/foundation';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SurfaceModule } from '../../shell/index.js';
import { StaffFake, staffError } from '../../test/staffContract.js';
import { contactSections } from '../contact/sections.js';
import { ContactDocumentsSection, DocumentsSection } from './DocumentsSection.js';
import { CONTACT, COPY, DEAL, DOC, DOC2, LISTING, ME, OTHER, RAW, app, detail, doc, entry, list, platform } from './fixtures.js';
import { surface } from './index.js';
import { DOC_MESSAGES, UPLOAD_MESSAGES, mayUpload, precheck } from './words.js';

const host: SurfaceModule = {
  pages: [
    { path: '/t/deal', title: 'Deal', roles: 'all', component: () => <DocumentsSection kind="deal" id={DEAL} ownerUserId={OTHER} memberUserIds={[ME]} /> },
    { path: '/t/deal-own', title: 'Deal', roles: 'all', component: () => <DocumentsSection kind="deal" id={DEAL} ownerUserId={ME} /> },
    { path: '/t/deal-other', title: 'Deal', roles: 'all', component: () => <DocumentsSection kind="deal" id={DEAL} ownerUserId={OTHER} /> },
    { path: '/t/listing-own', title: 'Listing', roles: 'all', component: () => <DocumentsSection kind="listing" id={LISTING} ownerUserId={ME} /> },
    { path: '/t/listing-other', title: 'Listing', roles: 'all', component: () => <DocumentsSection kind="listing" id={LISTING} ownerUserId={OTHER} /> },
    { path: '/t/contact', title: 'Contact', roles: 'all', component: () => <DocumentsSection kind="contact" id={CONTACT} ownerUserId={OTHER} /> },
  ],
};

const render = (fake: StaffFake, path: string, role: Role = 'agent') => app(fake, path, role, surface, host);
const section = async () => (await screen.findByRole('heading', { name: 'Documents' })).closest('section') as HTMLElement;
const pdf = (name = 'contract.pdf', size?: number) => {
  const f = new File(['%PDF-1.4 synthetic'], name, { type: 'application/pdf' });
  if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
  return f;
};
const uploaded = (over = {}) => ({ ...detail(doc({ scan: 'checking', scanText: COPY.checking, ...over })), previousVersionShared: false, previousVersionSharedText: null });

describe('the documents section', () => {
  it('b14 review F6: a long file name with no spaces wraps anywhere inside its link (no sideways scroll at 390 px; jsdom has no layout, so the classes are checked)', async () => {
    const long = 'Residential_Purchase_Agreement_FULLY_EXECUTED_with_all_addenda_v3.pdf';
    const fake = new StaffFake().on(`GET /deals/${DEAL}/documents`, { status: 200, body: list([entry({ displayName: long })], platform()) });
    render(fake, '/t/deal');
    const link = await within(await section()).findByRole('link', { name: long });
    expect(link.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full', '[overflow-wrap:anywhere]']));
  });

  it('R-STAFF-1: each chain shows kind, version, uploader, date and the server\'s scan, portal and extraction sentences; Review N dates; the newer-version note; the platform status', async () => {
    const fake = new StaffFake().on(
      `GET /deals/${DEAL}/documents`,
      {
        status: 200,
        body: list(
          [
            entry({ extraction: { status: 'proposed', outcome: 'dates', claimCount: 3, text: COPY.explanation }, portal: { shared: true, portalCleared: false, text: COPY.sharedNotCleared }, newerVersion: { id: DOC2, versionNo: 2, scan: 'checking' } }),
            entry({ id: DOC2, kind: 'disclosure', displayName: 'Seller disclosure <b>.pdf', uploadedByUserId: OTHER, scan: 'checking', scanText: COPY.checking, extraction: { status: 'not_applicable', outcome: null, claimCount: 0, text: null } }),
          ],
          platform({ scanner: { test: true, statusText: COPY.scannerTest }, extractor: { test: true, statusText: COPY.extractorTest } }),
        ),
      },
    );
    render(fake, '/t/deal');
    const s = await section();
    const rows = await within(s).findAllByRole('listitem');
    const first = rows.find((r) => r.textContent?.includes('Purchase contract 12 Oak St.pdf'))!;
    expect(first.textContent).toContain('Purchase contract · Version 1 · Uploaded by you · Nov 12, 2026');
    expect(within(first).getByText('Passed the virus check')).toBeInTheDocument();
    expect(within(first).getByText(COPY.sharedNotCleared)).toBeInTheDocument();
    expect(within(first).getByText(COPY.explanation)).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Review 3 dates' })).toHaveAttribute('href', `/documents/${DOC}/dates`);
    expect(within(first).getByRole('link', { name: 'Version 2' })).toHaveAttribute('href', `/documents/${DOC2}`);
    expect(first.textContent).toContain('is newer. Being checked for viruses.');
    // a document name is React text, never markup (R-STAFF-5)
    const second = rows.find((r) => r.textContent?.includes('Seller disclosure'))!;
    expect(within(second).getByRole('link', { name: 'Seller disclosure <b>.pdf' })).toBeInTheDocument();
    expect(second.textContent).toContain('Uploaded by a teammate');
    expect(within(second).getByText(COPY.checking)).toBeInTheDocument();
    expect(within(second).queryByRole('link', { name: /Review/ })).toBeNull();
    expect(within(s).getByRole('list', { name: 'Platform status' }).textContent).toBe(COPY.scannerTest + COPY.extractorTest);
    expect(s.textContent).not.toMatch(RAW);
    expect(s.textContent).not.toMatch(/score|confidence|%/i);
  });

  it('R-STAFF-1 E673: with no scanner configured the server\'s sentence shows; no download, share or date reading is offered', async () => {
    const fake = new StaffFake().on(`GET /deals/${DEAL}/documents`, {
      status: 200,
      body: list([entry({ scan: 'waiting_for_scanner', scanText: COPY.noScanner, extraction: { status: 'waiting_for_scan', outcome: null, claimCount: 0, text: null } })], platform({ scanner: { configured: false, statusText: COPY.scannerNotSetUp } })),
    });
    render(fake, '/t/deal');
    const s = await section();
    expect(await within(s).findByText(COPY.noScanner)).toBeInTheDocument();
    expect(within(s).getByText(COPY.scannerNotSetUp)).toBeInTheDocument();
    expect(within(s).getByText('Locked: no virus scanner yet')).toBeInTheDocument();
    expect(within(s).queryByRole('link', { name: /Download|Review/ })).toBeNull();
    expect(within(s).queryByRole('button', { name: /portal|Read dates/ })).toBeNull();
  });

  it('a scope the viewer cannot see (404) hides the section; an empty one says so', async () => {
    const fake = new StaffFake().on(`GET /deals/${DEAL}/documents`, staffError('NOT_FOUND')).on(`GET /listings/${LISTING}/documents`, { status: 200, body: list([]) });
    const first = render(fake, '/t/deal');
    await waitFor(() => expect(fake.callsTo(`GET /deals/${DEAL}/documents`).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Documents' })).toBeNull());
    first.view.unmount();
    const fake2 = new StaffFake().on(`GET /listings/${LISTING}/documents`, { status: 200, body: list([]) });
    render(fake2, '/t/listing-own');
    expect(await within(await section()).findByText('No documents yet.')).toBeInTheDocument();
  });
});

describe('R-STAFF-6: upload controls only for roles holding the scope\'s upload action', () => {
  it('mirrors core authz document.upload, document.upload_listing and document.upload_contact', () => {
    const f = (own: boolean, member: boolean) => ({ own, member });
    // deal: Owner/Admin all; Team Lead (team: the server decides); agent own or member; TC member; ISA never
    expect(['owner', 'admin', 'team_lead'].map((r) => mayUpload('deal', r as Role, f(false, false)))).toEqual([true, true, true]);
    expect([mayUpload('deal', 'agent', f(true, false)), mayUpload('deal', 'agent', f(false, true)), mayUpload('deal', 'agent', f(false, false))]).toEqual([true, true, false]);
    expect([mayUpload('deal', 'tc', f(false, true)), mayUpload('deal', 'tc', f(false, false)), mayUpload('deal', 'isa', f(true, true))]).toEqual([true, false, false]);
    // listing: Owner/Admin/Team Lead all; agent own; ISA and TC never
    expect([mayUpload('listing', 'team_lead', f(false, false)), mayUpload('listing', 'agent', f(true, false)), mayUpload('listing', 'agent', f(false, false))]).toEqual([true, true, false]);
    expect([mayUpload('listing', 'isa', f(true, true)), mayUpload('listing', 'tc', f(true, true))]).toEqual([false, false]);
    // contact: Owner/Admin/Team Lead/agent/ISA; never a TC
    expect((['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'] as const).map((r) => mayUpload('contact', r, f(false, false)))).toEqual([true, true, true, true, true, false]);
    expect(mayUpload('deal', null, f(true, true))).toBe(false);
  });

  const cases: [string, Role, string, boolean][] = [
    ['/t/deal', 'tc', 'deal member TC', true],
    ['/t/deal-other', 'tc', 'TC off the deal', false],
    ['/t/deal-own', 'agent', 'the deal\'s agent', true],
    ['/t/deal-other', 'agent', 'another agent', false],
    ['/t/deal', 'isa', 'an ISA on the deal', false],
    ['/t/listing-own', 'agent', 'the listing agent', true],
    ['/t/listing-other', 'agent', 'another agent on a listing', false],
    ['/t/contact', 'isa', 'an ISA on a contact', true],
    ['/t/contact', 'tc', 'a TC on a contact', false],
  ];
  it.each(cases)('%s as %s (%s): controls shown = %s', async (path, role, _what, shown) => {
    const fake = new StaffFake().on(`GET /deals/${DEAL}/documents`, { status: 200, body: list([]) }).on(`GET /listings/${LISTING}/documents`, { status: 200, body: list([]) }).on(`GET /contacts/${CONTACT}/documents`, { status: 200, body: list([]) });
    render(fake, path, role);
    const s = await section();
    await within(s).findByText('No documents yet.');
    expect(within(s).queryAllByRole('button', { name: /^Upload/ }).length > 0).toBe(shown);
  });

  it('a deal offers "Upload a contract" and "Upload another document"; a listing or contact offers the kind form', async () => {
    const fake = new StaffFake().on(`GET /deals/${DEAL}/documents`, { status: 200, body: list([]) }).on(`GET /contacts/${CONTACT}/documents`, { status: 200, body: list([]) });
    const deal = render(fake, '/t/deal-own');
    const s = await section();
    expect(await within(s).findByRole('button', { name: 'Upload a contract' })).toBeInTheDocument();
    expect(within(s).getByRole('button', { name: 'Upload another document' })).toBeInTheDocument();
    const input = within(s).getByLabelText('Contract file') as HTMLInputElement;
    expect(input.getAttribute('accept')).toBe('application/pdf,image/jpeg,image/png');
    expect(input.hasAttribute('capture')).toBe(false);
    deal.view.unmount();
    render(fake, '/t/contact', 'agent');
    const c = await section();
    expect(await within(c).findByRole('button', { name: 'Upload a document' })).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Upload a contract' })).toBeNull();
  });
});

describe('R-STAFF-8: uploads', () => {
  it('E672: a .docx, an empty file and a 10,000,001-byte PDF are refused in words before any request', async () => {
    const fake = new StaffFake().on(`GET /deals/${DEAL}/documents`, { status: 200, body: list([]) });
    render(fake, '/t/deal-own');
    const s = await section();
    const user = userEvent.setup({ applyAccept: false });
    const input = (await within(s).findByLabelText('Contract file')) as HTMLInputElement;
    await user.upload(input, new File(['PK'], 'contract.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    expect(await within(s).findByText('Only PDF, JPEG and PNG files can be added. Choose a PDF or a photo.')).toBeInTheDocument();
    await user.upload(input, new File([], 'empty.pdf', { type: 'application/pdf' }));
    expect(await within(s).findByText('This file is empty. Choose another file.')).toBeInTheDocument();
    await user.upload(input, pdf('big.pdf', 10_000_001));
    expect(await within(s).findByText('This file is larger than 10 MB (10,000,000 bytes). Choose a smaller file.')).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // exactly 10,000,000 bytes is allowed by the pre-check
    expect(precheck({ size: 10_000_000, type: 'application/pdf' })).toBeNull();
    expect(precheck({ size: 1, type: 'image/png' })).toBeNull();
    expect(precheck({ size: 1, type: '' })).not.toBeNull();
  });

  it('"Upload a contract": one tap to the picker, then one request whose form holds only file and kind purchase_contract (no commandId); the server\'s scan sentence shows', async () => {
    const fake = new StaffFake().on(`GET /deals/${DEAL}/documents`, { status: 200, body: list([]) }).on(`POST /deals/${DEAL}/documents`, { status: 201, body: uploaded() });
    render(fake, '/t/deal-own');
    const s = await section();
    const user = userEvent.setup();
    const input = (await within(s).findByLabelText('Contract file')) as HTMLInputElement;
    let clicked = 0;
    input.addEventListener('click', () => (clicked += 1));
    await user.click(within(s).getByRole('button', { name: 'Upload a contract' }));
    expect(clicked).toBe(1);
    await user.upload(input, pdf());
    expect(await within(s).findByText(COPY.checking)).toBeInTheDocument();
    const calls = fake.callsTo(`POST /deals/${DEAL}/documents`);
    expect(calls).toHaveLength(1);
    const form = calls[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()].sort()).toEqual(['file', 'kind']);
    expect(form.get('kind')).toBe('purchase_contract');
    expect((form.get('file') as File).name).toBe('contract.pdf');
    expect(calls[0]!.headers['content-type']).toBeUndefined();
    await waitFor(() => expect(fake.callsTo(`GET /deals/${DEAL}/documents`).length).toBeGreaterThanOrEqual(2));
  });

  it('"Upload another document": file, kind and an optional name only; previousVersionSharedText shows', async () => {
    const fake = new StaffFake()
      .on(`GET /deals/${DEAL}/documents`, { status: 200, body: list([]) })
      .on(`POST /deals/${DEAL}/documents`, { status: 201, body: { ...uploaded({ kind: 'addendum', displayName: 'Addendum A' }), previousVersionShared: true, previousVersionSharedText: COPY.previousShared } });
    render(fake, '/t/deal-own');
    const s = await section();
    const user = userEvent.setup();
    await user.click(await within(s).findByRole('button', { name: 'Upload another document' }));
    const upload = within(s).getByRole('button', { name: 'Upload' });
    expect(upload).toBeDisabled();
    await user.selectOptions(within(s).getByLabelText('Kind'), 'Addendum');
    await user.upload(within(s).getByLabelText('File'), pdf('a.pdf'));
    await user.type(within(s).getByLabelText('Name (optional)'), 'Addendum A');
    await user.click(upload);
    expect(await within(s).findByText(COPY.previousShared)).toBeInTheDocument();
    const form = fake.callsTo(`POST /deals/${DEAL}/documents`)[0]!.body as FormData;
    expect([...form.keys()].sort()).toEqual(['displayName', 'file', 'kind']);
    expect(form.get('kind')).toBe('addendum');
    expect(form.get('displayName')).toBe('Addendum A');
  });

  it('R-STAFF-6: a 404 on upload says "You can\'t add documents here"; RATE_LIMITED names 60 uploads an hour; one request per file, never retried after a 502', async () => {
    let n = 0;
    const fake = new StaffFake()
      .on(`GET /deals/${DEAL}/documents`, { status: 200, body: list([]) })
      .on(`POST /deals/${DEAL}/documents`, () => {
        n += 1;
        return n === 1 ? staffError('NOT_FOUND') : n === 2 ? staffError('RATE_LIMITED') : { status: 502, body: { error: { code: 'INTERNAL_ERROR', requestId: 'r' } } };
      });
    render(fake, '/t/deal-own');
    const s = await section();
    const user = userEvent.setup();
    const input = (await within(s).findByLabelText('Contract file')) as HTMLInputElement;
    await user.upload(input, pdf());
    expect(await within(s).findByText('You can’t add documents here.')).toBeInTheDocument();
    await user.upload(input, pdf());
    expect(await within(s).findByText('You reached the limit of 60 uploads an hour. Try again later.')).toBeInTheDocument();
    await user.upload(input, pdf());
    await waitFor(() => expect(within(s).queryByText(/limit of 60/)).toBeNull());
    expect(fake.callsTo(`POST /deals/${DEAL}/documents`)).toHaveLength(3);
    expect(s.textContent).not.toMatch(RAW);
  });

  it('the contact page registers the documents section at order 40', async () => {
    expect(contactSections.find((x) => x.id === 'documents')).toMatchObject({ order: 40, component: ContactDocumentsSection });
  });
});

describe('words', () => {
  it('every code the surface meets has a sentence, none shows a raw code, and the surface registry codes are its own', () => {
    for (const code of ['DOCUMENT_TYPE_NOT_ALLOWED', 'DOCUMENT_TOO_LARGE', 'DOCUMENT_VERSION_CONFLICT', 'DOCUMENT_QUARANTINED', 'DOCUMENT_BLOCKED', 'DOCUMENT_SUPERSEDED', 'DOCUMENT_NOT_SHAREABLE', 'DOCUMENT_HOLD_OWNER_ADMIN', 'DOCUMENT_RETENTION_OUT_OF_RANGE', 'DOCUMENT_RETAINED', 'CONTACT_MERGED', 'VALIDATION_FAILED', 'RATE_LIMITED']) {
      expect(DOC_MESSAGES[code], code).toBeTruthy();
      expect(DOC_MESSAGES[code]).not.toMatch(RAW);
    }
    expect(UPLOAD_MESSAGES.NOT_FOUND).toBe('You can’t add documents here.');
    expect(DOC_MESSAGES.RATE_LIMITED).toContain('60 uploads an hour');
    expect(Object.keys(surface.errorMessages ?? {}).every((c) => /^(DOCUMENT_|EXTRACTION_)/.test(c))).toBe(true);
    expect(surface.evidenceRoutes?.document?.({ sourceType: 'document', sourceId: DOC })).toBe(`/documents/${DOC}`);
  });
});
