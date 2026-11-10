import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Instant, instant, sequentialIds } from '../foundation/index.js';
import {
  type ConsentEvent,
  VOIDS_REVOKE_EVIDENCE_KEY,
  disclosureNamesTenant,
  effectiveLevel,
  levelForDisclosure,
  planNotAnOptOut,
  projectConsent,
  toConsentEvent,
  validateConsentEventSpec,
} from './consent.js';
import { H1, H2, NOW, days, ev, grantRow, hours, spec } from './testing/fixtures.js';
import { type ConsentStateRow, consentKey } from './types.js';

const T = (offsetMs: number): Instant => instant(NOW + offsetMs);

function state(events: ConsentEvent[], purpose: 'marketing' | 'informational' = 'informational', at: Instant = NOW, channel: 'sms' | 'voice' | 'email' = 'sms', hmac = H1): ConsentStateRow | undefined {
  return projectConsent(events, at).get(consentKey(channel, purpose, hmac));
}

describe('projectConsent: keys and basics', () => {
  it('R-CONSENT-1 keys are (channel, purpose, address HMAC), never a contact: two contacts sharing a phone share one state', () => {
    const rows = projectConsent(
      [
        ev({ eventType: 'grant', source: 'inbound_first_contact', purpose: 'informational', level: 'express', occurredAt: T(-hours(2)) }),
        // a different contact (context only) on the same address texts STOP
        ev({ eventType: 'revoke', source: 'inbound_keyword', occurredAt: T(-hours(1)) }),
        ev({ eventType: 'grant', addressHmac: H2, level: 'express', occurredAt: T(-hours(1)) }),
      ],
      NOW,
    );
    expect([...rows.keys()].sort()).toEqual(
      [consentKey('sms', 'marketing', H1), consentKey('sms', 'informational', H1), consentKey('sms', 'marketing', H2), consentKey('sms', 'informational', H2)].sort(),
    );
    expect(rows.get(consentKey('sms', 'informational', H1))?.status).toBe('revoked');
    expect(rows.get(consentKey('sms', 'informational', H2))?.status).toBe('granted');
    for (const r of rows.values()) expect(Object.keys(r).sort()).toEqual(['addressHmac', 'basisEventId', 'channel', 'expiresAt', 'ledgerEventCount', 'level', 'purpose', 'status']);
  });

  it('R-CONSENT-1 E39 a contact deleted and re-imported from an old CSV stays opted out through the HMAC', () => {
    const s = state([
      ev({ eventType: 'grant', level: 'express', occurredAt: T(-days(60)) }),
      ev({ eventType: 'revoke', source: 'inbound_keyword', occurredAt: T(-days(30)) }),
      // the re-import arrives under a new contact id but the same address
      ev({ eventType: 'grant', source: 'import_csv', imported: true, level: 'imported_unverified', occurredAt: T(-days(1)) }),
    ]);
    expect(s?.status).toBe('revoked');
  });

  it('R-CONSENT-2 `all` applies to both purposes; a purpose-specific event to one only', () => {
    const events = [
      ev({ eventType: 'grant', purpose: 'all', level: 'express', occurredAt: T(-hours(3)) }),
      ev({ eventType: 'revoke', purpose: 'marketing', source: 'agent_revoke', occurredAt: T(-hours(2)) }),
    ];
    expect(state(events, 'informational')).toMatchObject({ status: 'granted', level: 'express', ledgerEventCount: 1 });
    expect(state(events, 'marketing')).toMatchObject({ status: 'revoked', level: 'none', ledgerEventCount: 2 });
  });

  it('R-CONSENT-2 the latest revoke beats earlier grants (any level)', () => {
    const revoke = ev({ eventType: 'revoke', source: 'agent_revoke', occurredAt: T(-hours(1)) });
    const s = state([
      ev({ eventType: 'grant', level: 'express_written', disclosureId: 'd1', occurredAt: T(-hours(5)) }),
      ev({ eventType: 'grant', level: 'express', occurredAt: T(-hours(3)) }),
      revoke,
    ]);
    expect(s).toEqual({ channel: 'sms', purpose: 'informational', addressHmac: H1, status: 'revoked', level: 'none', basisEventId: revoke.id, expiresAt: null, ledgerEventCount: 3 });
  });

  it('R-CONSENT-2 an expired inquiry projects to none at evaluation time; unexpired it grants inquiry', () => {
    const g = ev({ eventType: 'grant', source: 'lead_provider', disclosureId: 'd1', level: 'inquiry', occurredAt: T(-days(10)), expiresAt: T(days(80)) });
    expect(state([g])).toMatchObject({ status: 'granted', level: 'inquiry', basisEventId: g.id, expiresAt: T(days(80)) });
    expect(state([g], 'informational', T(days(80)))).toMatchObject({ status: 'none', level: 'none', basisEventId: null });
    expect(state([g], 'informational', T(days(80) - 1))?.status).toBe('granted');
    // an inquiry without expires_at is never a valid basis
    expect(state([ev({ eventType: 'grant', level: 'inquiry', occurredAt: T(-1) })])?.status).toBe('none');
  });

  it('R-CONSENT-2 imported events count at their capped level (imported_unverified), whatever the row says', () => {
    const s = state([ev({ eventType: 'grant', source: 'import_fub', imported: true, level: 'express_written', occurredAt: T(-days(1)) })]);
    expect(s).toMatchObject({ status: 'granted', level: 'imported_unverified' });
  });

  it('the strongest valid grant is the level; its basis is the latest event at that level', () => {
    const a = ev({ eventType: 'grant', level: 'express', occurredAt: T(-hours(9)) });
    const b = ev({ eventType: 'grant', level: 'express', occurredAt: T(-hours(5)) });
    const c = ev({ eventType: 'grant', level: 'inquiry', expiresAt: T(days(9)), occurredAt: T(-hours(1)) });
    expect(state([c, a, b])).toMatchObject({ level: 'express', basisEventId: b.id, expiresAt: null });
    const w = ev({ eventType: 'grant', level: 'express_written', disclosureId: 'd', expiresAt: T(days(1)), occurredAt: T(-hours(7)) });
    expect(state([a, w, c])).toMatchObject({ level: 'express_written', basisEventId: w.id, expiresAt: T(days(1)) });
  });

  it('a future-dated grant does not count yet', () => {
    expect(state([ev({ eventType: 'grant', occurredAt: T(1) })])?.status).toBe('none');
    expect(state([ev({ eventType: 'grant', occurredAt: T(0) })])?.status).toBe('granted');
  });

  it('an expire event ends every earlier grant (status none, not an opt-out); later grants count again', () => {
    const e1 = ev({ eventType: 'grant', level: 'express', occurredAt: T(-hours(5)) });
    const x = ev({ eventType: 'expire', source: 'system_expiry', occurredAt: T(-hours(4)) });
    expect(state([e1, x])).toMatchObject({ status: 'none', ledgerEventCount: 2 });
    const e2 = ev({ eventType: 'grant', level: 'express', occurredAt: T(-hours(3)) });
    expect(state([e1, x, e2])).toMatchObject({ status: 'granted', basisEventId: e2.id });
  });

  it('ties on occurred_at are ordered by id (the DB index order); input order never matters', () => {
    const g = ev({ id: 'a', eventType: 'grant', occurredAt: T(-1) });
    const r = ev({ id: 'b', eventType: 'revoke', source: 'agent_revoke', occurredAt: T(-1) });
    expect(state([g, r])?.status).toBe('revoked');
    expect(state([r, g])?.status).toBe('revoked');
    const r2 = ev({ id: 'c', eventType: 'revoke', source: 'agent_revoke', occurredAt: T(-1) });
    const form = ev({ id: 'd', eventType: 'grant', disclosureId: 'disc', occurredAt: T(-1) });
    expect(state([form, r2])?.status).toBe('granted');
    expect(state([r2, form])?.status).toBe('granted');
  });

  it('ledgerEventCount counts every event of the key (purpose or all), markers included', () => {
    const imp = ev({ eventType: 'grant', source: 'import_csv', imported: true, level: 'imported_unverified', occurredAt: T(-hours(3)) });
    const events = [
      imp,
      ev({ eventType: 'import_revert', source: 'import_csv', imported: true, revertsEventId: imp.id, occurredAt: T(-hours(2)) }),
      ev({ eventType: 'grant', purpose: 'marketing', occurredAt: T(-hours(1)) }),
      ev({ eventType: 'grant', channel: 'voice', occurredAt: T(-hours(1)) }),
    ];
    expect(state(events, 'informational')?.ledgerEventCount).toBe(2);
    expect(state(events, 'marketing')?.ledgerEventCount).toBe(3);
    expect(state(events, 'informational', NOW, 'voice')?.ledgerEventCount).toBe(1);
  });

  it('property: the projection does not depend on input order', () => {
    const evArb = fc.record({
      t: fc.integer({ min: -100, max: 0 }),
      type: fc.constantFrom('grant', 'revoke', 'resubscribe', 'expire') as fc.Arbitrary<ConsentEvent['eventType']>,
      purpose: fc.constantFrom('all', 'marketing', 'informational') as fc.Arbitrary<ConsentEvent['purpose']>,
      level: fc.constantFrom('inquiry', 'express', 'express_written') as fc.Arbitrary<ConsentEvent['level']>,
      source: fc.constantFrom('web_form', 'inbound_keyword', 'agent_entry', 'inbound_language', 'signed_document') as fc.Arbitrary<ConsentEvent['source']>,
      disc: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(evArb, { maxLength: 12 }), fc.integer(), (raw, seed) => {
        const events = raw.map((r, i) =>
          ev({
            id: `p${String(i).padStart(3, '0')}`,
            eventType: r.type,
            purpose: r.purpose,
            level: r.type === 'grant' ? r.level : 'none',
            source: r.source,
            disclosureId: r.disc ? 'd' : null,
            evidenceObjectId: r.disc ? 'o' : null,
            expiresAt: r.level === 'inquiry' ? T(days(1)) : null,
            occurredAt: T(r.t * 1000),
          }),
        );
        const shuffled = [...events].sort((a, b) => ((a.id.charCodeAt(3) * seed) % 7) - ((b.id.charCodeAt(3) * seed) % 7));
        expect([...projectConsent(shuffled, NOW).entries()].sort()).toEqual([...projectConsent(events, NOW).entries()].sort());
      }),
    );
  });
});

describe('projectConsent: imports (R-CONSENT-3)', () => {
  it('R-CONSENT-3 E40 an imported FUB unsubscribe takes effect at full strength', () => {
    const s = state([
      ev({ eventType: 'grant', level: 'express', occurredAt: T(-days(400)) }),
      ev({ eventType: 'revoke', source: 'import_fub', imported: true, occurredAt: T(-days(200)) }),
    ]);
    expect(s?.status).toBe('revoked');
  });

  it('R-CONSENT-3 E43 import_revert voids the imported grant it cites and never an imported revocation', () => {
    const impGrant = ev({ eventType: 'grant', source: 'import_fub', imported: true, level: 'imported_unverified', occurredAt: T(-days(5)) });
    const impRevoke = ev({ eventType: 'revoke', source: 'import_fub', imported: true, occurredAt: T(-days(4)), addressHmac: H2 });
    const events = [
      impGrant,
      impRevoke,
      ev({ eventType: 'import_revert', source: 'import_fub', imported: true, revertsEventId: impGrant.id, occurredAt: T(-hours(1)) }),
      ev({ eventType: 'import_revert', source: 'import_fub', imported: true, revertsEventId: impRevoke.id, occurredAt: T(-hours(1)), addressHmac: H2 }),
    ];
    expect(state(events)).toMatchObject({ status: 'none', level: 'none' });
    expect(state(events, 'informational', NOW, 'sms', H2)?.status).toBe('revoked');
  });

  it('R-CONSENT-3 import_revert never voids a native grant, and an unknown target is ignored', () => {
    const native = ev({ eventType: 'grant', level: 'express', occurredAt: T(-days(5)) });
    const s = state([
      native,
      ev({ eventType: 'import_revert', source: 'import_csv', imported: true, revertsEventId: native.id, occurredAt: T(-hours(1)) }),
      ev({ eventType: 'import_revert', source: 'import_csv', imported: true, revertsEventId: 'missing', occurredAt: T(-hours(1)) }),
    ]);
    expect(s).toMatchObject({ status: 'granted', level: 'express', basisEventId: native.id });
  });

  it('R-CONSENT-3 an imported grant after an opt-out never reinstates it', () => {
    const s = state([
      ev({ eventType: 'revoke', source: 'inbound_keyword', occurredAt: T(-days(5)) }),
      ev({ eventType: 'grant', source: 'import_fub', imported: true, level: 'imported_unverified', disclosureId: 'd', occurredAt: T(-days(1)) }),
    ]);
    expect(s?.status).toBe('revoked');
  });
});

describe('projectConsent: reinstatement only by the person (R-CONSENT-10)', () => {
  const stop = (t: number) => ev({ eventType: 'revoke', source: 'inbound_keyword', occurredAt: T(t) });
  const start = (t: number) => ev({ eventType: 'resubscribe', source: 'inbound_keyword', occurredAt: T(t) });
  const base = (t: number) => ev({ eventType: 'grant', level: 'express', source: 'inbound_first_contact', purpose: 'informational', occurredAt: T(t) });

  it.each([
    ['agent_entry', { source: 'agent_entry', level: 'express' }],
    ['verbal_on_call', { source: 'verbal_on_call', level: 'express' }],
    ['inbound_first_contact', { source: 'inbound_first_contact', level: 'express' }],
    ['web_form without a disclosure', { source: 'web_form', level: 'express' }],
    ['signed_document without evidence', { source: 'signed_document', level: 'express_written' }],
    ['lead_provider without a disclosure', { source: 'lead_provider', level: 'inquiry', expiresAt: T(days(30)) }],
  ] as const)('R-CONSENT-10 a %s grant does not reinstate an opt-out (no staff override)', (_n, g) => {
    expect(state([base(-hours(9)), stop(-hours(5)), ev({ eventType: 'grant', occurredAt: T(-hours(1)), ...g })])?.status).toBe('revoked');
  });

  it.each([
    ['a new web form with a disclosure', { source: 'web_form', level: 'express_written', disclosureId: 'd1' }, 'express_written'],
    ['a lead-provider form with a disclosure', { source: 'lead_provider', level: 'inquiry', disclosureId: 'd2', expiresAt: T(days(90)) }, 'inquiry'],
    ['a signed document with evidence', { source: 'signed_document', level: 'express_written', evidenceObjectId: 'o1' }, 'express_written'],
  ] as const)('R-CONSENT-10 %s reinstates', (_n, g, level) => {
    const s = state([base(-hours(9)), stop(-hours(5)), ev({ eventType: 'grant', occurredAt: T(-hours(1)), ...g })]);
    expect(s).toMatchObject({ status: 'granted', level });
  });

  it('R-CONSENT-10 START restores the pre-STOP state exactly; grants recorded while opted out stay ignored', () => {
    const b = base(-hours(9));
    const s = state([b, stop(-hours(5)), ev({ eventType: 'grant', source: 'agent_entry', level: 'express', purpose: 'marketing', occurredAt: T(-hours(4)) }), start(-hours(1))], 'marketing');
    expect(s).toMatchObject({ status: 'none' });
    expect(state([b, stop(-hours(5)), start(-hours(1))])).toMatchObject({ status: 'granted', level: 'express', basisEventId: b.id });
  });

  it('R-CONSENT-10 START with no prior basis restores "none", not consent', () => {
    expect(state([stop(-hours(2)), start(-hours(1))])).toMatchObject({ status: 'none', level: 'none' });
  });

  it('R-CONSENT-10 "STOP STOP" twice then START restores; START before any STOP does nothing', () => {
    expect(state([base(-hours(9)), stop(-hours(5)), stop(-hours(4)), start(-hours(1))])?.status).toBe('granted');
    expect(state([start(-hours(10)), base(-hours(9))])?.status).toBe('granted');
    expect(state([start(-hours(10))])?.status).toBe('none');
  });

  it.each(['agent_revoke', 'inbound_language', 'provider_report', 'wrong_number', 'import_csv'] as const)(
    'R-CONSENT-10 START never undoes a %s revoke',
    (source) => {
      const r = ev({ eventType: 'revoke', source, imported: source === 'import_csv', occurredAt: T(-hours(5)) });
      expect(state([base(-hours(9)), r, start(-hours(1))])?.status).toBe('revoked');
    },
  );

  it('R-CONSENT-10 START undoes only the keyword revokes on top: language revoke under or over a STOP stays', () => {
    const lang = (t: number) => ev({ eventType: 'revoke', source: 'inbound_language', occurredAt: T(t) });
    expect(state([base(-hours(9)), lang(-hours(6)), stop(-hours(5)), start(-hours(1))])?.status).toBe('revoked');
    expect(state([base(-hours(9)), stop(-hours(6)), lang(-hours(5)), start(-hours(1))])?.status).toBe('revoked');
  });

  it('R-CONSENT-10 after a reinstatement, ordinary grants count again; expire clears saved pre-STOP grants', () => {
    const s = state([base(-hours(9)), stop(-hours(8)), ev({ eventType: 'grant', source: 'web_form', disclosureId: 'd', level: 'express', occurredAt: T(-hours(7)) }), ev({ eventType: 'grant', source: 'verbal_on_call', level: 'express_written', disclosureId: 'd', occurredAt: T(-hours(6)) })]);
    expect(s).toMatchObject({ status: 'granted', level: 'express_written' });
    expect(state([base(-hours(9)), stop(-hours(5)), ev({ eventType: 'expire', source: 'system_expiry', occurredAt: T(-hours(3)) }), start(-hours(1))])?.status).toBe('none');
  });
});

describe('"not an opt-out" review (R-CONSENT-8)', () => {
  const ids = () => sequentialIds({ prefix: 9 });
  const langRevoke = spec({ id: 'rv-lang', eventType: 'revoke', level: 'none', source: 'inbound_language', needsReview: true, occurredAt: T(-hours(1)) });

  it('R-CONSENT-8 restores the prior level when its basis still exists', () => {
    const basis = spec({ id: 'g1', eventType: 'grant', level: 'express', source: 'inbound_first_contact', purpose: 'informational', occurredAt: T(-days(2)) });
    const r = planNotAnOptOut({ events: [basis, langRevoke], revokeEventId: 'rv-lang', userId: 'u-agent', now: NOW, ids: ids() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toMatchObject({ eventType: 'grant', source: 'agent_entry', level: 'express', actor: { kind: 'user', userId: 'u-agent' }, evidence: { [VOIDS_REVOKE_EVIDENCE_KEY]: 'rv-lang' }, purpose: 'all' });
    expect(validateConsentEventSpec(r.event)).toEqual([]);
    expect(r.restored.map((x) => [x.purpose, x.status, x.level])).toEqual([
      ['marketing', 'none', 'none'],
      ['informational', 'granted', 'express'],
    ]);
  });

  it('R-CONSENT-8 an expired basis is not restored', () => {
    const basis = spec({ id: 'g2', eventType: 'grant', level: 'inquiry', source: 'lead_provider', disclosureId: 'd', expiresAt: T(-hours(2)), occurredAt: T(-days(90)) });
    const r = planNotAnOptOut({ events: [basis, langRevoke], revokeEventId: 'rv-lang', userId: 'u', now: NOW, ids: ids() });
    expect(r.ok && r.restored.every((x) => x.status === 'none')).toBe(true);
  });

  it('R-CONSENT-8 a purpose-specific revoke restores only that purpose', () => {
    const rv = spec({ id: 'rv-m', eventType: 'revoke', level: 'none', source: 'inbound_language', purpose: 'marketing', occurredAt: T(-hours(1)) });
    const r = planNotAnOptOut({ events: [rv], revokeEventId: 'rv-m', userId: 'u', now: NOW, ids: ids() });
    expect(r.ok && r.restored.map((x) => x.purpose)).toEqual(['marketing']);
  });

  it('R-CONSENT-8 keyword STOPs, provider reports and wrong numbers can never be reviewed away', () => {
    for (const source of ['inbound_keyword', 'provider_report', 'wrong_number', 'agent_revoke'] as const) {
      const rv = spec({ id: `rv-${source}`, eventType: 'revoke', level: 'none', source, occurredAt: T(-hours(1)) });
      expect(planNotAnOptOut({ events: [rv], revokeEventId: rv.id, userId: 'u', now: NOW, ids: ids() })).toEqual({ ok: false, code: 'NOT_AN_OPT_OUT_LANGUAGE_REVOKE' });
    }
    const g = spec({ id: 'g-x' });
    expect(planNotAnOptOut({ events: [g], revokeEventId: 'g-x', userId: 'u', now: NOW, ids: ids() })).toEqual({ ok: false, code: 'NOT_AN_OPT_OUT_LANGUAGE_REVOKE' });
    expect(planNotAnOptOut({ events: [], revokeEventId: 'nope', userId: 'u', now: NOW, ids: ids() })).toEqual({ ok: false, code: 'CONSENT_EVENT_NOT_FOUND' });
  });

  it('R-CONSENT-8 a revoke is reviewed once', () => {
    const first = planNotAnOptOut({ events: [langRevoke], revokeEventId: 'rv-lang', userId: 'u', now: NOW, ids: ids() });
    if (!first.ok) throw new Error('expected ok');
    expect(planNotAnOptOut({ events: [langRevoke, first.event], revokeEventId: 'rv-lang', userId: 'u', now: NOW, ids: ids() })).toEqual({ ok: false, code: 'ALREADY_REVIEWED' });
  });

  it('R-CONSENT-8 R-CONSENT-10 a void marker is never a grant and cannot override a keyword STOP', () => {
    const marker = (target: string, actorKind: 'user' | 'system' = 'user', t = 0) =>
      ev({ eventType: 'grant', source: 'agent_entry', level: 'express', actorKind, occurredAt: T(t), evidence: { [VOIDS_REVOKE_EVIDENCE_KEY]: target } });
    // alone it grants nothing
    expect(state([marker('nothing')])?.status).toBe('none');
    // forged against a keyword STOP it is ignored
    const stop = ev({ id: 'kw', eventType: 'revoke', source: 'inbound_keyword', occurredAt: T(-hours(1)) });
    expect(state([ev({ eventType: 'grant', occurredAt: T(-hours(2)) }), stop, marker('kw')])?.status).toBe('revoked');
    // a system-written marker, or one dated before the revoke, does not void it
    const lang = ev({ id: 'lg', eventType: 'revoke', source: 'inbound_language', occurredAt: T(-hours(1)) });
    const grant = ev({ eventType: 'grant', occurredAt: T(-hours(2)) });
    expect(state([grant, lang, marker('lg', 'system')])?.status).toBe('revoked');
    expect(state([grant, lang, marker('lg', 'user', -hours(3))])?.status).toBe('revoked');
    expect(state([grant, lang, marker('lg', 'user')])?.status).toBe('granted');
  });
});

describe('effectiveLevel', () => {
  it('R-CONSENT-2 grants only from a granted, unexpired row', () => {
    expect(effectiveLevel(undefined, NOW)).toBe('none');
    expect(effectiveLevel(grantRow({ status: 'revoked', level: 'none' }), NOW)).toBe('none');
    expect(effectiveLevel(grantRow({ expiresAt: NOW }), NOW)).toBe('none');
    expect(effectiveLevel(grantRow({ expiresAt: T(1) }), NOW)).toBe('express');
    expect(effectiveLevel(grantRow({ level: 'inquiry', expiresAt: null }), NOW)).toBe('none');
    expect(effectiveLevel(grantRow({ level: 'inquiry', expiresAt: T(1) }), NOW)).toBe('inquiry');
  });
});

// R-CONSENT-4 / R-CONSENT-3 write-side rules are DB CHECKs on consent_events (smoke-tested in
// packages/db). These tests prove the core mirror the API uses to reject bad specs early.
describe('validateConsentEventSpec (mirror of the consent_events CHECKs)', () => {
  it('accepts well-formed specs', () => {
    expect(validateConsentEventSpec(spec())).toEqual([]);
    expect(validateConsentEventSpec(spec({ eventType: 'revoke', level: 'none', source: 'inbound_keyword' }))).toEqual([]);
    expect(validateConsentEventSpec(spec({ eventType: 'resubscribe', level: 'none', source: 'inbound_keyword' }))).toEqual([]);
    expect(validateConsentEventSpec(spec({ addressKind: 'email', channel: 'email' }))).toEqual([]);
    expect(validateConsentEventSpec(spec({ source: 'import_fub', imported: true, level: 'imported_unverified', importRecordId: 'ir', originalProvenance: {} }))).toEqual([]);
    expect(validateConsentEventSpec(spec({ eventType: 'import_revert', level: 'none', source: 'import_fub', imported: true, importRecordId: 'ir', originalProvenance: {}, revertsEventId: 'x' }))).toEqual([]);
  });

  it.each([
    ['CHANNEL_KIND_MISMATCH', { addressKind: 'email', channel: 'sms' }],
    ['CHANNEL_KIND_MISMATCH', { addressKind: 'phone', channel: 'email' }],
    ['IMPORTED_SOURCE_MISMATCH', { source: 'import_csv', imported: false }],
    ['IMPORTED_SOURCE_MISMATCH', { source: 'web_form', imported: true, importRecordId: 'r', originalProvenance: {}, level: 'imported_unverified' }],
    ['IMPORTED_PROVENANCE_MISSING', { source: 'import_csv', imported: true, level: 'imported_unverified', importRecordId: 'r' }],
    ['IMPORTED_PROVENANCE_MISSING', { source: 'import_csv', imported: true, level: 'imported_unverified', originalProvenance: {} }],
    ['IMPORTED_GRANT_ABOVE_CAP', { source: 'import_csv', imported: true, level: 'express', importRecordId: 'r', originalProvenance: {} }],
    ['UNVERIFIED_LEVEL_NOT_IMPORTED', { level: 'imported_unverified' }],
    ['EXPRESS_WRITTEN_WITHOUT_EVIDENCE', { level: 'express_written' }],
    ['VERBAL_WITHOUT_CALL', { source: 'verbal_on_call' }],
    ['AGENT_ENTRY_ABOVE_EXPRESS', { source: 'agent_entry', level: 'express_written', disclosureId: 'd' }],
    ['INBOUND_FIRST_CONTACT_SHAPE', { source: 'inbound_first_contact', purpose: 'all' }],
    ['INBOUND_FIRST_CONTACT_SHAPE', { source: 'inbound_first_contact', purpose: 'informational', level: 'inquiry', expiresAt: NOW }],
    ['SIGNED_DOCUMENT_WITHOUT_EVIDENCE', { source: 'signed_document' }],
    ['NON_GRANT_WITH_LEVEL', { eventType: 'revoke', level: 'express' }],
    ['NON_GRANT_WITH_LEVEL', { eventType: 'expire', level: 'inquiry', expiresAt: NOW }],
    ['GRANT_WITHOUT_LEVEL', { level: 'none' }],
    ['RESUBSCRIBE_SHAPE', { eventType: 'resubscribe', level: 'none', source: 'web_form' }],
    ['RESUBSCRIBE_SHAPE', { eventType: 'resubscribe', level: 'none', source: 'inbound_keyword', channel: 'voice' }],
    ['REVERT_REFERENCE', { eventType: 'import_revert', level: 'none' }],
    ['REVERT_REFERENCE', { revertsEventId: 'x' }],
    ['INQUIRY_WITHOUT_EXPIRY', { level: 'inquiry' }],
    ['HINT_TOO_LONG', { addressHint: 'x'.repeat(41) }],
    ['NEGATIVE_CALL_OFFSET', { evidenceCallOffsetMs: -1 }],
  ] as const)('reports %s', (issue, o) => {
    expect(validateConsentEventSpec(spec(o as never))).toContain(issue);
  });

  it('agent_entry at none (a revoke) and express are both allowed', () => {
    expect(validateConsentEventSpec(spec({ source: 'agent_entry', level: 'express' }))).toEqual([]);
    expect(validateConsentEventSpec(spec({ source: 'agent_entry', eventType: 'revoke', level: 'none' }))).toEqual([]);
  });

  it('toConsentEvent keeps every field the fold reads', () => {
    const s = spec({ actor: { kind: 'user', userId: 'u1' }, evidence: { a: 1 } });
    expect(toConsentEvent(s)).toMatchObject({ id: s.id, actorKind: 'user', evidence: { a: 1 }, occurredAt: s.occurredAt });
  });
});

// E38 / R-CONSENT-4: a lead provider's text naming another company records `inquiry` (the storage
// of the full disclosure is a DB concern, tested in packages/db and api/leads).
describe('levelForDisclosure', () => {
  const tenantNames = ['Acme Realty Group, LLC', 'The Smith Team', null];
  it('names this brokerage or team ⇒ express_written', () => {
    expect(disclosureNamesTenant('acme realty group llc', tenantNames)).toBe(true);
    expect(disclosureNamesTenant('By submitting you agree that The Smith Team of Acme may text you', tenantNames)).toBe(true);
    expect(levelForDisclosure({ namesSeller: 'ACME REALTY GROUP LLC', tenantNames, occurredAt: NOW, inquiryBasisDays: 90 })).toEqual({ level: 'express_written', expiresAt: null });
  });
  it('names another company ⇒ inquiry expiring after the pack window', () => {
    expect(disclosureNamesTenant('Zillow Group and its partners', tenantNames)).toBe(false);
    expect(disclosureNamesTenant('Acme Mortgage', tenantNames)).toBe(false);
    expect(disclosureNamesTenant('', tenantNames)).toBe(false);
    expect(disclosureNamesTenant('Acme', [''])).toBe(false);
    expect(levelForDisclosure({ namesSeller: 'Zillow Group', tenantNames, occurredAt: NOW, inquiryBasisDays: 90 })).toEqual({ level: 'inquiry', expiresAt: T(days(90)) });
  });
});
