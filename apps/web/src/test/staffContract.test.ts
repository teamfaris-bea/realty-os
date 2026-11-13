// @vitest-environment node
// The staff contract checker (module 55) agrees with the API on the cases its screens meet: strict bodies refuse a
// commandId, claim decisions require one, upload forms carry only the fields the API reads, z.record and
// discriminated unions are checked (propertyNames, oneOf), and a fake may only answer as the API can.
import { describe, expect, it } from 'vitest';
import { violations } from './contract.js';
import { StaffFake, staffContract, staffError, staffRequestViolations, staffResponseViolations, staffRouteFor } from './staffContract.js';

const ID = '01900000-0000-7000-8000-0000000000d1';
const CMD = '01900000-0000-7000-8000-0000000000c1';

describe('test/staffContract.ts (R-STAFF-2, R-STAFF-4, R-STAFF-8)', () => {
  it('R-STAFF-2: routes resolve with static segments first (GET /documents/extractions is not /documents/:id), and /likely and portal routes are not in it', () => {
    expect(staffRouteFor('GET', '/api/documents/extractions')).toBe('GET /documents/extractions');
    expect(staffRouteFor('GET', `/documents/${ID}`)).toBe('GET /documents/:id');
    expect(staffRouteFor('GET', '/likely')).toBeNull();
    expect(Object.keys(staffContract.routes).some((k) => /\/portal\b/.test(k))).toBe(false);
  });

  it('R-STAFF-4: strict bodies refuse a commandId (approve, cap, enable, reply); claim confirm and reject require one', () => {
    expect(staffRequestViolations('POST /voice/answering/enable', { attestation: 'x', commandId: CMD }, {})).not.toEqual([]);
    expect(staffRequestViolations('POST /voice/answering/enable', { attestation: 'x' }, {})).toEqual([]);
    expect(staffRequestViolations('POST /gbp/reviews/:id/reply', { actionId: ID, text: 'Thank you', commandId: CMD }, {})).not.toEqual([]);
    expect(staffRequestViolations('POST /documents/:id/extraction/claims/:claimId/reject', {}, {})).not.toEqual([]);
    expect(staffRequestViolations('POST /documents/:id/extraction/claims/:claimId/reject', { commandId: CMD }, {})).toEqual([]);
    // oneOf (the discriminated target)
    expect(staffRequestViolations('POST /documents/:id/extraction/claims/:claimId/confirm', { commandId: CMD, target: { kind: 'new' } }, {})).toEqual([]);
    expect(staffRequestViolations('POST /documents/:id/extraction/claims/:claimId/confirm', { commandId: CMD, target: { kind: 'existing' } }, {})).not.toEqual([]);
    expect(staffRequestViolations('POST /documents/:id/extraction/claims/:claimId/confirm', { commandId: CMD, target: { kind: 'existing', dateId: ID } }, {})).toEqual([]);
    // the ads approve takes no body
    expect(staffRequestViolations('POST /ads/proposals/:id/approve', undefined, {})).toEqual([]);
    expect(staffRequestViolations('POST /ads/proposals/:id/approve', { commandId: CMD }, {})).not.toEqual([]);
  });

  it('R-STAFF-8: an upload form carries only file, kind and displayName (no kind on a version)', () => {
    const f = new FormData();
    f.append('file', new Blob(['%PDF'], { type: 'application/pdf' }), 'a.pdf');
    f.append('kind', 'purchase_contract');
    expect(staffRequestViolations('POST /deals/:id/documents', f, {})).toEqual([]);
    f.append('commandId', CMD);
    expect(staffRequestViolations('POST /deals/:id/documents', f, {})).toEqual(['form /commandId: not a field the route reads']);
    const v = new FormData();
    v.append('file', new Blob(['%PDF'], { type: 'application/pdf' }), 'a.pdf');
    expect(staffRequestViolations('POST /documents/:id/versions', v, {})).toEqual([]);
    v.append('kind', 'addendum');
    expect(staffRequestViolations('POST /documents/:id/versions', v, {})).not.toEqual([]);
  });

  it('queries coerce numbers as z.coerce does; propertyNames is checked', () => {
    expect(staffRequestViolations('GET /coaching/trends', undefined, { weeks: '4' })).toEqual([]);
    expect(staffRequestViolations('GET /coaching/trends', undefined, { weeks: '5' })).not.toEqual([]);
    expect(violations({ type: 'object', propertyNames: { type: 'string', pattern: '^[a-z]+$' } }, { ok: 1, Bad: 2 })).toHaveLength(1);
  });

  it('a fake answering outside the response schema, or an error with the wrong status, is a problem; a good exchange is not', async () => {
    const fake = new StaffFake({ failOnFinish: false });
    fake.on('GET /documents/extractions', { status: 200, body: { extractions: [{ documentId: 'x' }] } });
    await fake.fetch('/api/documents/extractions');
    expect(fake.problems.join()).toMatch(/never sends/);
    const ok = new StaffFake({ failOnFinish: false });
    ok.on('GET /documents/extractions', { status: 200, body: { extractions: [] } });
    ok.on('POST /ads/proposals/' + ID + '/approve', staffError('ADS_PROPOSAL_STALE', { reason: 'cap' }));
    await ok.fetch('/api/documents/extractions');
    await ok.fetch(`/api/ads/proposals/${ID}/approve`, { method: 'POST' });
    expect(ok.problems).toEqual([]);
    ok.on('POST /ads/proposals/' + ID + '/reject', { status: 400, body: { error: { code: 'ADS_PROPOSAL_STALE', requestId: 'r' } } });
    await ok.fetch(`/api/ads/proposals/${ID}/reject`, { method: 'POST' });
    expect(ok.problems.join()).toMatch(/not how the API answers/);
    expect(staffResponseViolations('GET /documents/extractions', { extractions: [] })).toEqual([]);
  });
});
