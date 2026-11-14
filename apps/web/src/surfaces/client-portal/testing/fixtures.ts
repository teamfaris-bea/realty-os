// module 46: staff-side fixtures (fictional example.test data). Every body is checked against module 45's contract
// (portalResponseViolations) before a test answers with it.
import { portalApiError, portalRequestViolations, portalResponseViolations } from '../../../portal/test/portalContract.js';
import type { Reply } from '../../../shell/testing/fakeApi.js';

export const DEAL = '01900000-0000-7000-8000-00000000d001';
export const JANE = '01900000-0000-7000-8000-00000000e001';
export const ACCOUNT = '01900000-0000-7000-8000-00000000e101';
export const GRANT = '01900000-0000-7000-8000-00000000a001';
export const POINT = '01900000-0000-7000-8000-00000000e201';

/** A 200 the API can send for this contract route (else the test fails). */
export function ok(key: string, body: unknown): Reply {
  const v = portalResponseViolations(key, body);
  if (v.length > 0) throw new Error(`fixture for ${key} is not what the API sends: ${v.join('; ')}`);
  return { status: 200, body };
}
export const apiErr = (code: string, details?: Record<string, unknown>): Reply => portalApiError(code, details);
export const requestProblems = portalRequestViolations;

export const account = (o: Record<string, unknown> = {}) => ({
  id: ACCOUNT,
  contactId: JANE,
  status: 'invited',
  statusText: 'Invited; has not signed in yet.',
  loginPoint: { id: POINT, kind: 'email', hint: 'j***@example.test', status: 'active', usable: true },
  signInImpossible: null,
  disabledReason: null,
  ...o,
});
export const grantStaff = (o: Record<string, unknown> = {}) => ({
  id: GRANT,
  accountId: ACCOUNT,
  state: 'live',
  stateText: 'Live.',
  grantedAt: '2026-11-10T15:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  revokedBy: null,
  view: { id: GRANT, scope: 'purchase', title: 'Your home purchase', contact: { agentName: 'Ava Agent', textTo: '+15555550123', emailTo: 'replies@example.test' }, expiresOn: null },
  ...o,
});
export const state = (o: Record<string, unknown> = {}) => ({
  portalCleared: true,
  portalText: null,
  channels: { email: 'test', sms: 'test', text: ['Sign-in links by email use the test provider (test deployments only).'] },
  accounts: [] as unknown[],
  grants: [] as unknown[],
  items: [] as unknown[],
  ...o,
});
export const notice = (o: Record<string, unknown> = {}) => ({ sent: true, text: 'Jane was sent a note by email with how to sign in.', channel: 'email', decision: null, ...o });
export const inviteBody = (n = notice()) => ({ account: account(), grant: grantStaff(), created: { account: true, grant: true }, notice: n });
export const preview = (o: Record<string, unknown> = {}) => ({
  visibleNow: true,
  why: [] as string[],
  grant: grantStaff().view,
  timeline: {
    items: [{ itemId: '01900000-0000-7000-8000-00000000b001', kind: 'milestone', title: 'Inspection', body: null, occursOn: '2026-12-18', publishedAt: '2026-11-10T15:00:00.000Z' }],
    nextSteps: [],
  },
  documents: [{ itemId: '01900000-0000-7000-8000-00000000c001', title: 'Purchase contract.pdf', body: 'Purchase contract, version 1', publishedAt: '2026-11-12T15:00:00.000Z' }],
  ...o,
});
