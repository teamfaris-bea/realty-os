import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { type ConsentEventSpec, consentKey, effectiveLevel, levelRank, projectConsent, toConsentEvent, validateConsentEventSpec } from '../compliance/index.js';
import { type Instant, DAY_MS, instant, sequentialIds } from '../foundation/index.js';
import {
  type FubConsentFields,
  type ImportedConsentEventRow,
  IMPORTED_REVOKE_PURPOSE,
  importedConsentKey,
  importedOptOuts,
  mapFub,
  mapImportedConsent,
  mapImportedSuppressions,
  planRevert,
  plannedConsentKeys,
  revertImportedGrant,
} from './index.js';
import { FUB_EXPORT, T0, USERS, testKey } from './testing/fixtures.js';

const REC = '00000000-0000-7000-8000-0000000000e1';

function ctx(now: Instant = T0) {
  return { ids: sequentialIds({ prefix: 7 }), now, hmac: testKey, source: 'import_fub' as const, contactId: null, importRecordId: REC };
}

function rowOf(s: ConsentEventSpec): ImportedConsentEventRow {
  return {
    id: s.id,
    eventType: s.eventType,
    imported: s.imported,
    channel: s.channel,
    purpose: s.purpose,
    addressKind: s.addressKind,
    addressHmac: s.addressHmac,
    addressHint: s.addressHint,
    source: s.source,
    contactId: s.contactId,
    importRecordId: s.importRecordId,
  };
}

const channelArb = fc.constantFrom('sms' as const, 'voice' as const, 'email' as const);
const fieldsArb: fc.Arbitrary<FubConsentFields> = fc.record({
  addresses: fc.array(
    fc.oneof(
      fc.record({
        kind: fc.constant('phone' as const),
        address: fc.integer({ min: 2002000000, max: 9899999999 }).map((n) => `+1${n}`),
        grants: fc.uniqueArray(channelArb),
        revokes: fc.uniqueArray(channelArb),
        doNotContact: fc.boolean(),
      }),
      fc.record({
        kind: fc.constant('email' as const),
        address: fc.stringMatching(/^[a-z]{1,8}@example\.com$/),
        grants: fc.uniqueArray(channelArb),
        revokes: fc.uniqueArray(channelArb),
        doNotContact: fc.boolean(),
      }),
    ),
    { maxLength: 4 },
  ),
  occurredAt: fc.option(fc.integer({ min: T0 - 3000 * DAY_MS, max: T0 + 30 * DAY_MS }).map(instant), { nil: null }),
});

describe('mapImportedConsent (R-CONSENT-3: imports never manufacture consent)', () => {
  it('R-CONSENT-3 property: every imported grant is exactly imported_unverified, every event passes the consent_events CHECKs, and the fold never projects above imported_unverified', () => {
    fc.assert(
      fc.property(fieldsArb, (fields) => {
        const specs = mapImportedConsent(fields, { source: 'fub' }, ctx());
        for (const s of specs) {
          expect(validateConsentEventSpec(s)).toEqual([]);
          expect(s.imported).toBe(true);
          if (s.eventType === 'grant') expect(s.level).toBe('imported_unverified');
          else expect([s.eventType, s.level]).toEqual(['revoke', 'none']);
          expect(s.occurredAt).toBeLessThanOrEqual(T0); // never future-dated
        }
        for (const row of projectConsent(specs.map(toConsentEvent), T0).values()) {
          expect(levelRank(effectiveLevel(row, T0))).toBeLessThanOrEqual(levelRank('imported_unverified'));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('R-CONSENT-3 imported opt-outs take effect at commit at full strength: dated at the commit instant, purpose all, and they beat a non-imported express grant recorded before', () => {
    const fields: FubConsentFields = { addresses: [{ kind: 'phone', address: '+14155550132', grants: [], revokes: ['sms'], doNotContact: false }], occurredAt: instant(T0 - 400 * DAY_MS) };
    const [revoke] = mapImportedConsent(fields, { source: 'fub' }, ctx());
    expect(revoke).toMatchObject({ eventType: 'revoke', level: 'none', occurredAt: T0, purpose: IMPORTED_REVOKE_PURPOSE });
    const prior = { ...(revoke as ConsentEventSpec), id: '00000000-0000-7000-8000-000000000001', eventType: 'grant' as const, level: 'express' as const, source: 'agent_entry' as const, imported: false, importRecordId: null, originalProvenance: null, purpose: 'informational' as const, occurredAt: instant(T0 - DAY_MS), actor: { kind: 'user' as const, userId: 'u' } };
    const state = projectConsent([toConsentEvent(prior), toConsentEvent(revoke as ConsentEventSpec)], T0);
    expect(state.get(consentKey('sms', 'informational', testKey('phone', '+14155550132')))?.status).toBe('revoked');
    expect(state.get(consentKey('sms', 'marketing', testKey('phone', '+14155550132')))?.status).toBe('revoked');
  });

  it('E40 an imported FUB contact marked unsubscribed gets its revocations at consent-stage commit', () => {
    const bob = mapFub('consent', FUB_EXPORT.people[1], USERS);
    if (bob.record?.category !== 'consent') throw new Error('category');
    const specs = mapImportedConsent(bob.record.fields, bob.record.provenance, ctx());
    expect(specs.map((s) => [s.channel, s.eventType])).toEqual([
      ['sms', 'revoke'],
      ['email', 'revoke'],
    ]);
    const state = projectConsent(specs.map(toConsentEvent), T0);
    expect(state.get(consentKey('email', 'marketing', testKey('email', 'bob@example.org')))?.status).toBe('revoked');
    expect(specs[0]?.originalProvenance).toMatchObject({ personId: '1002', points: [{ kind: 'phone', status: 'Opted Out' }, { kind: 'email', status: 'Unsubscribed' }] });
  });

  it('a channel both granted and revoked yields only the revoke; mismatched channels are ignored', () => {
    const specs = mapImportedConsent({ addresses: [{ kind: 'email', address: 'a@example.com', grants: ['email', 'sms'], revokes: ['email', 'voice'], doNotContact: false }], occurredAt: null }, {}, ctx());
    expect(specs.map((s) => [s.channel, s.eventType])).toEqual([['email', 'revoke']]);
  });

  it('do-not-contact becomes an import_dnc suppression on every channel with the import record', () => {
    const s = mapImportedSuppressions({ addresses: [{ kind: 'phone', address: '+16465550177', grants: [], revokes: [], doNotContact: true }], occurredAt: null }, ctx());
    expect(s).toEqual([
      {
        id: expect.any(String),
        addressKind: 'phone',
        addressHmac: testKey('phone', '+16465550177'),
        addressHint: '•••0177',
        channel: 'all',
        reason: 'import_dnc',
        sourceRef: { source: 'import_fub', importRecordId: REC },
        imported: true,
        importRecordId: REC,
      },
    ]);
  });

  it('address hints are short and never the full address', () => {
    const [g] = mapImportedConsent({ addresses: [{ kind: 'email', address: `${'x'.repeat(60)}@a-very-long-domain-name-for-testing.example.com`, grants: ['email'], revokes: [], doNotContact: false }], occurredAt: null }, {}, ctx());
    expect(g?.addressHint.length).toBeLessThanOrEqual(40);
    expect(g?.addressHint).not.toContain('xxxx');
  });

  it('plannedConsentKeys names exactly what would be written (re-run idempotency keys)', () => {
    const k = testKey('phone', '+14155550132');
    expect(plannedConsentKeys({ addresses: [{ kind: 'phone', address: '+14155550132', grants: ['sms', 'voice'], revokes: ['voice'], doNotContact: true }], occurredAt: null }, testKey)).toEqual([
      importedConsentKey(k, 'sms', 'grant'),
      importedConsentKey(k, 'voice', 'revoke'),
      importedConsentKey(k, 'sms', 'dnc'),
    ]);
  });
});

describe('revert of the consent stage (R-IMPORT-10, R-CONSENT-3)', () => {
  it('R-CONSENT-3 R-IMPORT-10 E43 import_revert voids imported grants and never imported revocations or DNC flags', () => {
    const fields: FubConsentFields = {
      addresses: [
        { kind: 'phone', address: '+14155550132', grants: ['sms'], revokes: [], doNotContact: false },
        { kind: 'email', address: 'bob@example.org', grants: [], revokes: ['email'], doNotContact: true },
      ],
      occurredAt: null,
    };
    const specs = mapImportedConsent(fields, {}, ctx());
    const supp = mapImportedSuppressions(fields, ctx());
    const plan = planRevert(
      'consent',
      [...specs.map((s) => ({ table: 'consent_events' as const, id: s.id, event: rowOf(s) })), ...supp.map((s) => ({ table: 'suppressions' as const, id: s.id }))],
      new Set(),
      { ids: sequentialIds({ prefix: 9 }), now: instant(T0 + DAY_MS) },
    );
    expect(plan.delete).toEqual([]);
    expect(plan.compensate).toHaveLength(1);
    expect(plan.compensate[0]).toMatchObject({ eventType: 'import_revert', level: 'none', revertsEventId: specs[0]?.id, imported: true });
    expect(validateConsentEventSpec(plan.compensate[0] as ConsentEventSpec)).toEqual([]);
    expect(plan.kept.sort()).toEqual([specs[1]?.id, supp[0]?.id].sort());
    expect(plan.reasons[specs[1]?.id as string]).toBe('REVOCATION_KEPT');
    expect(plan.reasons[supp[0]?.id as string]).toBe('DNC_KEPT');

    const after = projectConsent([...specs, ...plan.compensate].map(toConsentEvent), instant(T0 + DAY_MS));
    expect(after.get(consentKey('sms', 'informational', testKey('phone', '+14155550132')))?.status).toBe('none');
    expect(after.get(consentKey('email', 'marketing', testKey('email', 'bob@example.org')))?.status).toBe('revoked');
  });

  it('revertImportedGrant refuses revocations and non-imported rows', () => {
    const [grant] = mapImportedConsent({ addresses: [{ kind: 'phone', address: '+14155550132', grants: ['sms'], revokes: [], doNotContact: false }], occurredAt: null }, {}, ctx());
    const row = rowOf(grant as ConsentEventSpec);
    const c = { ids: sequentialIds(), now: T0 };
    expect(revertImportedGrant({ ...row, eventType: 'revoke' }, c)).toBeNull();
    expect(revertImportedGrant({ ...row, imported: false }, c)).toBeNull();
    expect(revertImportedGrant({ ...row, importRecordId: null }, c)).toBeNull();
    expect(revertImportedGrant(row, c)?.revertsEventId).toBe(row.id);
  });
});

describe('importedOptOuts (outbound-2: opt-outs carried by the contacts stage)', () => {
  const fields: FubConsentFields = {
    occurredAt: null,
    addresses: [
      { kind: 'phone', address: '+14155550101', grants: ['voice'], revokes: ['sms', 'sms'], doNotContact: false },
      { kind: 'email', address: 'a@example.com', grants: ['email'], revokes: [], doNotContact: false },
      { kind: 'phone', address: '+14155550102', grants: [], revokes: [], doNotContact: true },
      { kind: 'email', address: 'b@example.com', grants: [], revokes: ['email', 'sms'], doNotContact: false },
    ],
  };

  it('R-CONSENT-3: keeps only revocations and DNC flags, never a grant', () => {
    const o = importedOptOuts(fields, []);
    expect(o.addresses).toEqual([
      { kind: 'phone', address: '+14155550101', grants: [], revokes: ['sms'], doNotContact: false },
      { kind: 'phone', address: '+14155550102', grants: [], revokes: [], doNotContact: true },
      { kind: 'email', address: 'b@example.com', grants: [], revokes: ['email'], doNotContact: false },
    ]);
    const specs = mapImportedConsent(o, {}, ctx());
    expect(specs.every((x) => x.eventType === 'revoke' && x.level === 'none')).toBe(true);
    expect(mapImportedSuppressions(o, ctx())).toHaveLength(1);
  });

  it('R-IMPORT-13: an ambiguous value (a bare "no") waits for the consent-stage review', () => {
    const o = importedOptOuts(fields, [{ code: 'CONSENT_VALUE_AMBIGUOUS', severity: 'review', field: 'consent_sms' }]);
    expect(o.addresses.map((a) => [a.address, a.revokes, a.doNotContact])).toEqual([
      ['+14155550102', [], true],
      ['b@example.com', ['email'], false],
    ]);
  });
});
