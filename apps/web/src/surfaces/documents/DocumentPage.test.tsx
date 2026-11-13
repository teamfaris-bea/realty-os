// The document page in jsdom on the staff contract (module 55 item 6; R-STAFF-1, R-STAFF-4, R-STAFF-5, R-STAFF-8,
// R-STAFF-10, E673).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { StaffFake, staffError } from '../../test/staffContract.js';
import { CONTACT, COPY, DEAL, DOC, DOC2, LISTING, RAW, app, detail, doc, platform } from './fixtures.js';
import { surface } from './index.js';

const open = (fake: StaffFake, role: Parameters<typeof app>[2] = 'agent', id = DOC) => app(fake, `/documents/${id}`, role, surface);
const main = async () => {
  await screen.findByRole('heading', { name: 'Versions' });
  return screen.getByRole('main');
};
const bad502 = { status: 502, body: { error: { code: 'INTERNAL_ERROR', requestId: 'r' } } };
const axeClean = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => v.id);

describe('the document page', () => {
  it('R-STAFF-5: a clean file has a same-origin download link (download attribute, no new tab, no preview); versions are listed; no delete or rename; axe finds nothing', async () => {
    const v1 = doc({ id: DOC2, versionNo: 1 });
    const v2 = doc({ versionNo: 2, supersedesId: DOC2, displayName: 'Contract <script>.pdf' });
    const fake = new StaffFake().on(`GET /documents/${DOC}`, { status: 200, body: detail(v2, [v1, v2]) });
    open(fake);
    const m = await main();
    expect(screen.getByRole('heading', { level: 1, name: 'Contract <script>.pdf' })).toBeInTheDocument();
    const link = within(m).getByRole('link', { name: 'Download version 2' });
    expect(link.getAttribute('href')).toBe(`/api/documents/${DOC}/file`);
    expect(link.hasAttribute('download')).toBe(true);
    expect(link.hasAttribute('target')).toBe(false);
    expect(m.querySelector('iframe, embed, object, img[src*="/file"]')).toBeNull();
    const versions = within(m).getByRole('list', { name: 'Versions' });
    expect(within(versions).getByRole('link', { name: 'Version 1' })).toHaveAttribute('href', `/documents/${DOC2}`);
    expect(within(versions).getByRole('link', { name: 'Download version 1' })).toHaveAttribute('href', `/api/documents/${DOC2}/file`);
    expect(within(m).queryByRole('button', { name: /Delete|Rename|Remove/ })).toBeNull();
    expect(within(m).getByRole('link', { name: 'Open the deal' })).toHaveAttribute('href', `/deals/${DEAL}`);
    expect(m.textContent).not.toMatch(RAW);
    expect(await axeClean()).toEqual([]);
  });

  it('R-STAFF-1 E673: no scanner configured: the server\'s no-scanner sentence; no download, share or date reading', async () => {
    const d = doc({ scan: 'waiting_for_scanner', scanText: COPY.noScanner, canShare: true, extraction: { status: 'waiting_for_scan', outcome: null, claimCount: 0, text: null } });
    const fake = new StaffFake().on(`GET /documents/${DOC}`, { status: 200, body: detail(d, [d], platform({ scanner: { configured: false, statusText: COPY.scannerNotSetUp } })) });
    open(fake, 'owner');
    const m = await main();
    expect(within(m).getByText(COPY.noScanner)).toBeInTheDocument();
    expect(within(m).getByText(COPY.scannerNotSetUp)).toBeInTheDocument();
    expect(within(m).queryByRole('link', { name: /Download|Review/ })).toBeNull();
    expect(within(m).queryByRole('button', { name: /portal|Read dates/ })).toBeNull();
  });

  it('R-STAFF-10: Share shows only when canShare, clean and not a contact document; the body is {shared} (no commandId); the API\'s sentence shows and never says a client sees it', async () => {
    const d = doc({ canShare: true });
    const shared = doc({ canShare: true, portal: { shared: true, portalCleared: false, text: COPY.sharedNotCleared } });
    const fake = new StaffFake().on(`GET /documents/${DOC}`, { status: 200, body: detail(d) }).on(`POST /documents/${DOC}/share`, { status: 200, body: { ...detail(shared), text: COPY.sharedNotCleared } });
    open(fake);
    const m = await main();
    await userEvent.setup().click(within(m).getByRole('button', { name: 'Mark for the client portal' }));
    expect(await within(m).findAllByText(COPY.sharedNotCleared)).not.toHaveLength(0);
    expect(fake.callsTo(`POST /documents/${DOC}/share`).map((c) => c.body)).toEqual([{ shared: true }]);
    expect(within(m).getByRole('button', { name: 'Stop marking for the client portal' })).toBeInTheDocument();
    expect(m.textContent).not.toMatch(/clients? (can|now|will) see|visible to (the )?clients?|shared with (the )?clients?/i);
  });

  it('R-STAFF-10: no Share for canShare false, a file not clean, or a contact document', async () => {
    for (const d of [doc({ canShare: false }), doc({ canShare: true, scan: 'checking', scanText: COPY.checking }), doc({ canShare: true, scope: { kind: 'contact', id: CONTACT } })]) {
      const fake = new StaffFake().on(`GET /documents/${DOC}`, { status: 200, body: detail(d) });
      const r = open(fake);
      const m = await main();
      expect(within(m).queryByRole('button', { name: /client portal/ })).toBeNull();
      r.view.unmount();
    }
  });

  it('R-STAFF-4: Share and Hold send one request per tap and are never retried after a 502', async () => {
    const d = doc({ canShare: true, canHold: true });
    const fake = new StaffFake().on(`GET /documents/${DOC}`, { status: 200, body: detail(d) }).on(`POST /documents/${DOC}/share`, bad502).on(`POST /documents/${DOC}/hold`, bad502);
    open(fake, 'owner');
    const m = await main();
    const user = userEvent.setup();
    await user.click(within(m).getByRole('button', { name: 'Mark for the client portal' }));
    await within(m).findAllByRole('alert');
    await user.type(within(m).getByLabelText('Reason (up to 200 characters)'), 'Dispute over the deposit');
    await user.click(within(m).getByRole('button', { name: 'Place legal hold' }));
    await waitFor(() => expect(within(m).getAllByRole('alert')).toHaveLength(2));
    expect(fake.callsTo(`POST /documents/${DOC}/share`)).toHaveLength(1);
    expect(fake.callsTo(`POST /documents/${DOC}/hold`)).toHaveLength(1);
    expect(fake.callsTo(`POST /documents/${DOC}/hold`)[0]!.body).toEqual({ hold: true, reason: 'Dispute over the deposit' });
  });

  it('hold and retention show only when canHold; retention sends {retentionUntil} and an out-of-range date is refused in words with the range', async () => {
    const noHold = new StaffFake().on(`GET /documents/${DOC}`, { status: 200, body: detail(doc()) });
    const r = open(noHold);
    expect(within(await main()).queryByRole('heading', { name: 'Legal hold and retention' })).toBeNull();
    r.view.unmount();
    const d = doc({ canHold: true, retentionUntil: '2033-11-12T17:00:00.000Z' });
    const fake = new StaffFake()
      .on(`GET /documents/${DOC}`, { status: 200, body: detail(d) })
      .on(`PUT /documents/${DOC}/retention`, staffError('DOCUMENT_RETENTION_OUT_OF_RANGE', { from: '2029-11-12T17:00:00.000Z', to: '2036-11-12T17:00:00.000Z' }));
    open(fake, 'admin');
    const m = await main();
    expect(within(m).getByText('Kept until Nov 12, 2033.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(within(m).getByLabelText('Keep until'), '2027-01-15');
    await user.click(within(m).getByRole('button', { name: 'Save retention' }));
    expect(await within(m).findByText(/Keep a document 3 to 10 years after the close.*Choose a date from Nov 12, 2029 to Nov 12, 2036\./)).toBeInTheDocument();
    expect(fake.callsTo(`PUT /documents/${DOC}/retention`).map((c) => c.body)).toEqual([{ retentionUntil: '2027-01-15T12:00:00.000Z' }]);
    expect(m.textContent).not.toMatch(RAW);
  });

  it('R-STAFF-8: a new version goes to the newest version with file only (no kind), and opens the new version', async () => {
    const v1 = doc({ id: DOC2, versionNo: 1 });
    const v2 = doc({ versionNo: 2, supersedesId: DOC2 });
    const fake = new StaffFake()
      .on(`GET /documents/${DOC2}`, { status: 200, body: detail(v1, [v1, v2]) })
      .on(`GET /documents/${DOC}`, { status: 200, body: detail(v2, [v1, v2]) })
      .on(`POST /documents/${DOC}/versions`, { status: 201, body: { ...detail(v2, [v1, v2]), previousVersionShared: false, previousVersionSharedText: null } });
    const { router } = open(fake, 'agent', DOC2);
    const m = await main();
    const user = userEvent.setup();
    await user.upload(within(m).getByLabelText('New version file'), new File(['%PDF-1.4'], 'v3.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/documents/${DOC}`));
    const form = fake.callsTo(`POST /documents/${DOC}/versions`)[0]!.body as FormData;
    expect([...form.keys()]).toEqual(['file']);
  });

  it('a TC sees no new-version control on a listing document; DOCUMENT_VERSION_CONFLICT and a 404 are words', async () => {
    const d = doc({ scope: { kind: 'listing', id: LISTING }, kind: 'listing_agreement' });
    const fake = new StaffFake().on(`GET /documents/${DOC}`, { status: 200, body: detail(d) });
    const r = open(fake, 'tc');
    expect(within(await main()).queryByRole('button', { name: 'Upload a new version' })).toBeNull();
    r.view.unmount();
    const fake2 = new StaffFake().on(`GET /documents/${DOC}`, { status: 200, body: detail(doc()) }).on(`POST /documents/${DOC}/versions`, staffError('DOCUMENT_VERSION_CONFLICT'));
    open(fake2, 'agent');
    const m = await main();
    await userEvent.setup().upload(within(m).getByLabelText('New version file'), new File(['%PDF-1.4'], 'v2.pdf', { type: 'application/pdf' }));
    expect(await within(m).findByText('Someone added a new version of this document first. Open the newest version to add another.')).toBeInTheDocument();
  });

  it('a document the viewer cannot see says it is not available', async () => {
    const fake = new StaffFake().on(`GET /documents/${DOC}`, staffError('NOT_FOUND'));
    open(fake, 'isa');
    expect(await screen.findByText("This isn't available. It may have moved, or you may not have access to it.")).toBeInTheDocument();
  });
});

describe('R-STAFF-10: the portal boundary in source', () => {
  it('no file of the documents surface imports src/portal or names a /portal route', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.tsx') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(4);
    for (const f of files) {
      const src = readFileSync(join(here, f), 'utf8');
      expect(src, f).not.toMatch(/from ['"][^'"]*\/portal(\/|['"])/);
      expect(src, f).not.toMatch(/['"`]\/(api\/)?portal\b/);
    }
  });
});
