import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone } from './normalize.js';

describe('normalizePhone (US default)', () => {
  it.each([
    ['2125551234', '+12125551234'],
    ['(212) 555-1234', '+12125551234'],
    ['212.555.1234', '+12125551234'],
    ['  212 555 1234  ', '+12125551234'],
    ['12125551234', '+12125551234'],
    ['1 (212) 555-1234', '+12125551234'],
    ['+1 212-555-1234', '+12125551234'],
    ['+12125551234', '+12125551234'],
    ['tel:+12125551234', '+12125551234'],
    ['212-555-0100', '+12125550100'],
    ['800-555-1212', '+18005551212'],
    ['011 44 20 7946 0958', '+442079460958'],
    ['+44 20 7946 0958', '+442079460958'],
    ['２１２５５５１２３４', '+12125551234'], // full-width digits (NFKC)
  ])('10/11-digit and formatted numbers: %s → %s', (raw, e164) => {
    expect(normalizePhone(raw, 'US')).toEqual({ ok: true, e164 });
  });

  it.each([
    ['212-555-1234 x123', '+12125551234', '123'],
    ['(212) 555-1234 ext. 45', '+12125551234', '45'],
    ['212.555.1234 extension 7', '+12125551234', '7'],
    ['+1 212 555 1234;ext=5', '+12125551234', '5'],
  ])('extensions are stripped from E.164 and returned separately: %s', (raw, e164, extension) => {
    expect(normalizePhone(raw, 'US')).toEqual({ ok: true, e164, extension });
  });

  it.each([
    ['12345', 'SMS short code'],
    ['898287', '6-digit short code'],
    ['911', 'N11 service code'],
    ['411', 'N11 service code'],
    ['555-0100', 'E45: 7 digits without an area code'],
    ['5550100', '7 digits'],
    ['212555123', '9 digits'],
    ['212 555 12345', '11 digits not starting with 1'],
    ['22125551234', '11 digits not starting with 1'],
    ['1 (999) 555-1234', 'unassigned area code'],
    ['+1 212 155 1234', 'exchange starting with 1'],
    ['1-800-FLOWERS', 'vanity letters'],
    ['call me', 'no digits'],
    ['', 'empty'],
    ['   ', 'blank'],
    ['0', 'too short'],
    ['+', 'sign only'],
    ['1'.repeat(80), 'absurdly long'],
  ])('rejects %s (%s)', (raw) => {
    expect(normalizePhone(raw, 'US')).toEqual({ ok: false, code: 'PHONE_INVALID' });
  });

  it('rejects non-string input from untyped callers', () => {
    expect(normalizePhone(12125551234 as unknown as string, 'US')).toEqual({ ok: false, code: 'PHONE_INVALID' });
    expect(normalizeEmail(null as unknown as string)).toEqual({ ok: false, code: 'EMAIL_INVALID' });
  });

  it('is idempotent on its own output (property)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[2-9][0-8]\d[2-9]\d{6}$/), (digits) => {
        const first = normalizePhone(digits, 'US');
        if (!first.ok) return true;
        const again = normalizePhone(first.e164, 'US');
        return again.ok && again.e164 === first.e164;
      }),
    );
  });

  it('never throws on arbitrary input (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const r = normalizePhone(s, 'US');
        return r.ok ? /^\+[1-9]\d{6,14}$/.test(r.e164) : r.code === 'PHONE_INVALID';
      }),
    );
  });
});

describe('normalizeEmail', () => {
  it.each([
    ['Jane.Doe@Example.COM', 'jane.doe@example.com'],
    ['  jane@example.com  ', 'jane@example.com'],
    ['mailto:jane@example.com', 'jane@example.com'],
    ['<jane@example.com>', 'jane@example.com'],
    ['jane+homes@example.co.uk', 'jane+homes@example.co.uk'],
    ["o'brien@example.org", "o'brien@example.org"],
    ['first.last@sub.example-mail.com', 'first.last@sub.example-mail.com'],
    ['jane@xn--bcher-kva.example', 'jane@xn--bcher-kva.example'],
    ['josé@bücher.de', 'josé@bücher.de'],
  ])('normalizes %s → %s', (raw, email) => {
    expect(normalizeEmail(raw)).toEqual({ ok: true, email });
  });

  it('keeps provider-specific variants distinct (no Gmail dot or +tag folding)', () => {
    expect(normalizeEmail('j.ane@gmail.com')).toEqual({ ok: true, email: 'j.ane@gmail.com' });
    expect(normalizeEmail('jane+x@gmail.com')).toEqual({ ok: true, email: 'jane+x@gmail.com' });
  });

  it.each([
    '',
    'jane',
    'jane@',
    '@example.com',
    'jane@@example.com',
    'jane@ex@ample.com',
    'jane@example',
    'jane@example.c',
    'jane@-example.com',
    'jane@example-.com',
    'jane@exa_mple.com',
    'jane@example..com',
    '.jane@example.com',
    'jane.@example.com',
    'ja..ne@example.com',
    'ja ne@example.com',
    '"jane"@example.com',
    'Jane Doe <jane@example.com>',
    'jane@[192.168.0.1]',
    'jane@192.168.0.1',
    `${'a'.repeat(65)}@example.com`,
    `jane@${'a'.repeat(250)}.com`,
  ])('rejects %j', (raw) => {
    expect(normalizeEmail(raw)).toEqual({ ok: false, code: 'EMAIL_INVALID' });
  });

  it('is idempotent and never throws (property)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.emailAddress(), fc.string({ maxLength: 60 })), (s) => {
        const r = normalizeEmail(s);
        if (!r.ok) return r.code === 'EMAIL_INVALID';
        const again = normalizeEmail(r.email);
        return again.ok && again.email === r.email && r.email === r.email.toLowerCase();
      }),
    );
  });
});
