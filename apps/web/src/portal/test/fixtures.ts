// module 46 test fixtures: fictional example.test data only (the repository is public). Every body here satisfies
// module 45's contract (api.contract.test.ts checks them all through portalContractFetch).
export const GRANT_ID = '01900000-0000-7000-8000-00000000a001';
export const GRANT_2 = '01900000-0000-7000-8000-00000000a002';
export const ITEM_1 = '01900000-0000-7000-8000-00000000b001';
export const ITEM_2 = '01900000-0000-7000-8000-00000000b002';
export const STEP_1 = '01900000-0000-7000-8000-00000000b003';
export const DOC_1 = '01900000-0000-7000-8000-00000000c001';
export const TOKEN = 'A'.repeat(21) + '_' + 'b'.repeat(20) + '-'; // 43 base64url characters
export const FILE_TOKEN = 'f'.repeat(43);
export const CSRF = 'portal-csrf-token-1';

export const contact = { agentName: 'Sam Agent', textTo: '+15555550123', emailTo: 'replies@example.test' };

export const grant = (o: Partial<{ id: string; title: string; scope: 'purchase' | 'sale' | 'listing' | null; expiresOn: string | null; contact: typeof contact | null }> = {}) => ({
  id: GRANT_ID,
  scope: 'purchase' as const,
  title: 'Your home purchase',
  contact,
  expiresOn: null,
  ...o,
});

export const me = (grants: unknown[] = [grant()], csrfToken = CSRF) => ({ account: { status: 'active' }, csrfToken, session: { idleHours: 24, absoluteDays: 14 }, grants });

export const timeline = (grantId = GRANT_ID) => ({
  grantId,
  items: [
    { itemId: ITEM_1, kind: 'milestone', title: 'Inspection', body: null, occursOn: '2026-12-18', publishedAt: '2026-11-10T15:00:00.000Z' },
    { itemId: ITEM_2, kind: 'milestone', title: 'Closing', body: null, occursOn: '2027-01-15', publishedAt: '2026-11-10T15:00:01.000Z' },
  ],
  nextSteps: [{ itemId: STEP_1, kind: 'next_step', title: 'Book the movers', body: null, occursOn: '2027-01-10', publishedAt: '2026-11-11T15:00:00.000Z' }],
});

export const documents = (grantId = GRANT_ID) => ({
  grantId,
  documents: [{ itemId: DOC_1, title: 'Purchase contract.pdf', body: 'Purchase contract, version 1', publishedAt: '2026-11-12T15:00:00.000Z' }],
});

export const streamToken = (o: Partial<{ url: string; fileName: string; contentType: string; byteSize: number }> = {}) => ({
  url: `/api/portal/files/${FILE_TOKEN}`,
  expiresAt: '2026-11-13T15:01:00.000Z',
  fileName: 'Purchase contract.pdf',
  contentType: 'application/pdf',
  byteSize: 8,
  ...o,
});

export const session = (csrfToken = CSRF) => ({ csrfToken, idleExpiresAt: '2026-11-14T15:00:00.000Z', absoluteExpiresAt: '2026-11-27T15:00:00.000Z' });
export const accepted = () => ({ status: 'sent_if_matched', message: 'If that email or phone number is the one your agent set up, and it can get messages from us, we sent a sign-in link. It works once, for 15 minutes. Nothing after a few minutes? Ask your agent.' });

export const PDF = new TextEncoder().encode('%PDF-1.4'); // 8 bytes
