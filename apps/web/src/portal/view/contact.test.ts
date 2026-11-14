// module 46 (R-PORTALWEB-8, E695): the only hrefs built from data.
import { describe, expect, it } from 'vitest';
import { mailtoHref, smsHref } from './contact.js';

describe('view/contact.ts (R-PORTALWEB-8)', () => {
  it('R-PORTALWEB-8: sms: only from E.164', () => {
    expect(smsHref('+15555550123')).toBe('sms:+15555550123');
    expect(smsHref('+442071838750')).toBe('sms:+442071838750');
    for (const v of ['5555550123', '+0555550123', '+1555', '+1 555 555 0123', '+1555555012３', '+١٥٥٥٥٥٥٠١٢٣', '+15555550123?body=hi', '+15555550123;ext=1', '+15555550123\r\n', 'javascript:alert(1)', 'sms:+15555550123', '', null, undefined]) {
      expect(smsHref(v as string | null), String(v)).toBeNull();
    }
  });

  it('E695: mailto: only from one plain address', () => {
    expect(mailtoHref('replies@example.test')).toBe('mailto:replies@example.test');
    expect(mailtoHref("o'neil+homes@example.test")).toBe("mailto:o'neil%2Bhomes@example.test");
    for (const v of ['javascript:alert(1)', 'mailto:a@example.test', 'a@example.test?body=x', 'a@example.test?cc=b@example.test', 'a@example.test,b@example.test', 'a@example.test;b@example.test', 'a@example.test\r\nBcc: b@example.test', '<a@example.test>', '"a"@example.test', 'a b@example.test', 'a@example', 'a%0a@example.test', 'a@exa‮mple.test', '', null]) {
      expect(mailtoHref(v as string | null), String(v)).toBeNull();
    }
  });
});
