// Security review (templates, R-PAR-24): invisible / bidi / control characters that used to survive the
// renderer or a subject save. Each case failed before the fix in render.ts / validate.ts.
import { describe, expect, it } from 'vitest';
import { cleanValue, renderForSend, validateTemplate, type OnePersonContext } from './index.js';

const ctx = (firstName: string | null): OnePersonContext => ({
  contact: { firstName, lastName: 'Doe', displayName: 'Jane Doe' },
  agent: { firstName: 'Sam', lastName: 'Agent', phone: '+14155550100', email: 'sam@example.test' },
  team: { name: 'Team' },
  brokerage: { name: 'Harbor Realty LLC' },
  fields: {},
});

describe('secreview: merge values are plain, visible, single-line text', () => {
  it('every Unicode Bidi_Control character is removed from a value (U+061C ARABIC LETTER MARK included)', () => {
    for (const ch of ['؜', '‎', '‏', '‪', '‮', '⁦', '⁩']) {
      expect(cleanValue(`A${ch}B`), `U+${ch.codePointAt(0)!.toString(16)}`).toBe('AB');
    }
  });

  it('a value made only of invisible characters is empty: MERGE_FIELD_EMPTY, never "Hi ,"', () => {
    const tpl = { channel: 'sms' as const, subject: null, body: 'Hi {{contact.first_name}}, quick question.' };
    // U+E0041.. TAG LATIN letters (invisible "ASCII smuggling"), U+00AD soft hyphen, U+3164 Hangul filler, U+034F CGJ, U+180E MVS
    for (const v of ['\u{E0048}\u{E0069}', '­', 'ㅤ', '͏', '᠎']) {
      const r = renderForSend(tpl, ctx(v));
      expect(r.ok ? JSON.stringify(r.body) : r.code, JSON.stringify(v)).toBe('MERGE_FIELD_EMPTY');
    }
  });

  it('a template subject with C1 controls, a line/paragraph separator or a bidi override is refused at save', () => {
    for (const s of ['Hello\u0085Bcc', 'Hello World', 'Price ‮0001$', 'A\u009b31mB']) {
      expect(validateTemplate({ channel: 'email', name: 'x', subject: s, body: 'b' }, new Set()), JSON.stringify(s)).toMatchObject({ ok: false, code: 'TEMPLATE_SUBJECT_INVALID' });
    }
  });
});
