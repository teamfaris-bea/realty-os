import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ContactId, MINUTE_MS, plusMs } from '../foundation/index.js';
import { addressLockOrder, duplicatePair, inquiryDuplicate, inquiryFingerprint, matchContacts, type ExistingMatch } from './dedup.js';
import { SRC, T0 } from './testing/fixtures.js';

const P1 = 'p'.repeat(64);
const P2 = 'q'.repeat(64);
const E1 = 'e'.repeat(64);
const cid = (n: number) => `c0000000-0000-7000-8000-${n.toString().padStart(12, '0')}` as ContactId;
const ex = (n: number, hmacs: string[], over: Partial<ExistingMatch> = {}): ExistingMatch => ({
  contactId: cid(n),
  createdAt: plusMs(T0, n * MINUTE_MS),
  ownershipState: 'owned',
  matchedHmacs: hmacs,
  ...over,
});

describe('dedup (R-OWN-25)', () => {
  it('R-OWN-25: an exact normalized phone or email match auto-attaches', () => {
    expect(matchContacts({ phoneHmacs: [P1], emailHmacs: [] }, [ex(1, [P1])])).toEqual({ kind: 'attach', contactId: cid(1), matchedBy: ['phone'], duplicates: [] });
    expect(matchContacts({ phoneHmacs: [P1], emailHmacs: [E1] }, [ex(1, [P1, E1])])).toMatchObject({ kind: 'attach', matchedBy: ['phone', 'email'] });
    expect(matchContacts({ phoneHmacs: [], emailHmacs: [] }, [])).toEqual({ kind: 'create', duplicates: [] });
  });

  it('R-OWN-25: phone and email matching different contacts attach to the earliest and create a duplicate candidate', () => {
    const out = matchContacts({ phoneHmacs: [P1], emailHmacs: [E1] }, [ex(5, [E1]), ex(2, [P1])]);
    expect(out).toEqual({ kind: 'attach', contactId: cid(2), matchedBy: ['phone'], duplicates: [{ contactId: cid(5), reason: 'phone_email_split' }] });
    // E21: spouses share one phone; the earliest gets the inquiry, the other becomes a candidate
    const shared = matchContacts({ phoneHmacs: [P1], emailHmacs: [] }, [ex(3, [P1]), ex(1, [P1])]);
    expect(shared).toEqual({ kind: 'attach', contactId: cid(1), matchedBy: ['phone'], duplicates: [{ contactId: cid(3), reason: 'shared_phone' }] });
    const sharedEmail = matchContacts({ phoneHmacs: [], emailHmacs: [E1] }, [ex(1, [E1]), ex(2, [E1])]);
    expect(sharedEmail).toMatchObject({ duplicates: [{ contactId: cid(2), reason: 'shared_email' }] });
    // the same contact found by two lookups is one match
    expect(matchContacts({ phoneHmacs: [P1], emailHmacs: [E1] }, [ex(1, [P1]), ex(1, [E1])])).toEqual({ kind: 'attach', contactId: cid(1), matchedBy: ['phone', 'email'], duplicates: [] });
  });

  it('R-OWN-25: ties on created_at go to the lowest id; a split is recognized either way round; lookups without similarity are not fuzzy', () => {
    const tie = matchContacts({ phoneHmacs: [P1], emailHmacs: [] }, [ex(2, [P1], { createdAt: T0 }), ex(1, [P1], { createdAt: T0 }), ex(3, [P1], { createdAt: T0 })]);
    expect(tie).toMatchObject({ contactId: cid(1), duplicates: [{ contactId: cid(2) }, { contactId: cid(3) }] });
    const emailFirst = matchContacts({ phoneHmacs: [P1], emailHmacs: [E1] }, [ex(1, [E1]), ex(2, [P1])]);
    expect(emailFirst).toEqual({ kind: 'attach', contactId: cid(1), matchedBy: ['email'], duplicates: [{ contactId: cid(2), reason: 'phone_email_split' }] });
    expect(matchContacts({ phoneHmacs: [P1], emailHmacs: [] }, [ex(3, [P2])])).toEqual({ kind: 'create', duplicates: [] });
  });

  it('R-OWN-25: fuzzy matches (name + postal, trigram ≥ 0.8) only create candidates, never attach', () => {
    const out = matchContacts({ phoneHmacs: [P2], emailHmacs: [], displayName: 'Jane Doe', postalCode: '10001' }, [
      ex(1, [], { nameSimilarity: 0.85, samePostal: true }),
      ex(2, [], { nameSimilarity: 0.9 }),
      ex(3, [], { nameSimilarity: 0.79, samePostal: true }),
    ]);
    expect(out).toEqual({ kind: 'create', duplicates: [{ contactId: cid(1), reason: 'name_postal' }, { contactId: cid(2), reason: 'trigram_name' }] });
    const mixed = matchContacts({ phoneHmacs: [P1], emailHmacs: [] }, [ex(4, [P1]), ex(2, [], { nameSimilarity: 0.95 })]);
    expect(mixed).toEqual({ kind: 'attach', contactId: cid(4), matchedBy: ['phone'], duplicates: [{ contactId: cid(2), reason: 'trigram_name' }] });
  });

  it('R-OWN-25: merged and soft-deleted contacts never absorb a new inquiry', () => {
    const out = matchContacts({ phoneHmacs: [P1], emailHmacs: [] }, [ex(1, [P1], { ownershipState: 'closed', closedReason: 'deleted' }), ex(2, [P1], { ownershipState: 'closed', closedReason: 'merged' })]);
    expect(out).toEqual({ kind: 'create', duplicates: [] });
    expect(matchContacts({ phoneHmacs: [P1], emailHmacs: [] }, [ex(1, [P1], { ownershipState: 'closed', closedReason: 'spam' })]).kind).toBe('attach');
  });

  it('R-OWN-25: identifiers are locked in one sorted order, so two simultaneous inquiries for one person serialize', () => {
    // E20 itself (one contact under real advisory locks) is db/client's two-session test
    expect(addressLockOrder({ phoneHmacs: [P2, P1], emailHmacs: [E1, P1] })).toEqual([E1, P1, P2]);
    fc.assert(
      fc.property(fc.array(fc.constantFrom(P1, P2, E1, 'a'.repeat(64)), { maxLength: 6 }), fc.array(fc.constantFrom(P1, P2, E1), { maxLength: 4 }), (phones, emails) => {
        const a = addressLockOrder({ phoneHmacs: phones, emailHmacs: emails });
        const b = addressLockOrder({ phoneHmacs: [...emails].reverse(), emailHmacs: [...phones].reverse() });
        expect(a).toEqual(b);
        expect(a).toEqual([...a].sort());
        expect(new Set(a).size).toBe(a.length);
      }),
    );
  });

  it('duplicate pairs are stored with contact_a < contact_b', () => {
    expect(duplicatePair(cid(9), cid(3))).toEqual({ contactAId: cid(3), contactBId: cid(9) });
    expect(duplicatePair(cid(3), cid(9))).toEqual({ contactAId: cid(3), contactBId: cid(9) });
  });
});

describe('inquiry duplicates (R-OWN-25, E19)', () => {
  const fp = inquiryFingerprint({ leadSourceId: SRC, identifierHmacs: [P1, E1], inquiryType: 'buy' });

  it('E19 R-OWN-25: the same (lead_source, external_id) is ignored', () => {
    expect(inquiryDuplicate({ leadSourceId: SRC, externalId: 'z-1', fingerprint: 'new', receivedAt: plusMs(T0, 99 * MINUTE_MS) }, [{ leadSourceId: SRC, externalId: 'z-1', fingerprint: fp, receivedAt: T0 }])).toBe('EXTERNAL_ID');
    expect(inquiryDuplicate({ leadSourceId: 'other', externalId: 'z-1', fingerprint: 'new', receivedAt: T0 }, [{ leadSourceId: SRC, externalId: 'z-1', fingerprint: fp, receivedAt: T0 }])).toBeNull();
  });

  it('E19 R-OWN-25: the same fingerprint within 10 minutes is ignored; after 10 minutes it is a new inquiry', () => {
    const prior = [{ leadSourceId: SRC, externalId: null, fingerprint: fp, receivedAt: T0 }];
    expect(inquiryDuplicate({ leadSourceId: SRC, externalId: null, fingerprint: fp, receivedAt: plusMs(T0, 9 * MINUTE_MS + 59_999) }, prior)).toBe('FINGERPRINT');
    expect(inquiryDuplicate({ leadSourceId: SRC, externalId: null, fingerprint: fp, receivedAt: plusMs(T0, 10 * MINUTE_MS) }, prior)).toBeNull();
    expect(inquiryDuplicate({ leadSourceId: SRC, externalId: 'x', fingerprint: 'other', receivedAt: T0 }, prior)).toBeNull();
  });

  it('the fingerprint is order-insensitive over identifiers and distinguishes source and type', () => {
    expect(inquiryFingerprint({ leadSourceId: SRC.toUpperCase(), identifierHmacs: [E1, P1, P1], inquiryType: 'buy' })).toBe(fp);
    expect(inquiryFingerprint({ leadSourceId: SRC, identifierHmacs: [P1, E1], inquiryType: 'sell' })).not.toBe(fp);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
