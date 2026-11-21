import { describe, expect, it } from 'vitest';
import { checkDraft, countSentences } from './voice.js';

const sms = (text: string, marketing = false) => checkDraft({ channel: 'sms', text, subject: null, marketing, brokerageName: 'Example Realty Group' }).map((i) => i.code);
const GOOD = 'Hi Jordan, got your message. Can I call you today? Thank you';

describe('CP-3 owner voice', () => {
  it('a short text that leads with the answer and ends with "Thank you" passes', () => {
    expect(sms(GOOD)).toEqual([]);
  });
  it('needs "Thank you", and nothing after it: no sign-off, no name, no "Best,"', () => {
    expect(sms('Hi Jordan, can I call you today?')).toContain('MISSING_THANK_YOU');
    expect(sms('Hi Jordan, can I call you today? Thank you, Alex')).toContain('SIGN_OFF_PRESENT');
    expect(sms('Hi Jordan, can I call you today? Thank you\n- Alex')).toContain('SIGN_OFF_PRESENT');
    expect(sms('Hi Jordan, can I call you today? Best regards, Thank you')).toContain('SIGN_OFF_PRESENT');
  });
  it('at most three sentences before "Thank you", within the SMS length', () => {
    expect(countSentences('One. Two? Three! Thank you')).toBe(3);
    expect(sms('Hi. One. Two. Can I call today? Thank you')).toContain('TOO_MANY_SENTENCES');
    expect(sms(`Hi Jordan, ${'a'.repeat(330)} today? Thank you`)).toContain('TOO_LONG');
  });
  it('needs a next step with a time window', () => {
    expect(sms('Hi Jordan, can I call you sometime? Thank you')).toContain('MISSING_TIME_WINDOW');
  });
});

describe('CP-4 team content rules', () => {
  it('no rental wording anywhere (rent, lease, landlord, tenant, property management), without catching "please" or "current"', () => {
    for (const w of ['Are you renting now?', 'When does your lease end?', 'Is your landlord ok?', 'Tenants welcome.', 'We do property management too.']) {
      expect(sms(`Hi Jordan, ${w} Can I call today? Thank you`)).toContain('RENTAL_WORDING');
    }
    expect(sms('Hi Jordan, please tell me your current plans. Can I call today? Thank you')).not.toContain('RENTAL_WORDING');
  });
  it('marketing needs the brokerage name; a follow-up text does not', () => {
    expect(sms(GOOD, true)).toContain('MISSING_BROKERAGE_NAME');
    expect(sms('Hi Jordan, this is Alex with Example Realty Group. Can I call you today? Thank you', true)).toEqual([]);
  });
  it('no promises about price, availability or representation; no money or contract topics', () => {
    expect(sms('Hi Jordan, I guarantee we sell fast. Can I call today? Thank you')).toContain('PROMISE');
    expect(sms('Hi Jordan, the house is still available. Can I call today? Thank you')).toContain('PROMISE');
    expect(sms('Hi Jordan, they might lower the price. Can I call today? Thank you')).toContain('MONEY_OR_CONTRACT');
  });
  it('no links, no placeholders, no AI wording, no look-alike letters', () => {
    expect(sms('Hi Jordan, see https://example.com today. Thank you')).toContain('LINK');
    expect(sms('Hi [Name], can I call today? Thank you')).toContain('UNFILLED_SLOT');
    expect(sms('Hi Jordan, as an AI assistant I can help today. Thank you')).toContain('AI_DISCLOSURE');
    expect(sms('Hi Jordan, are you r\u0435nting? Can I call today? Thank you')).toEqual(expect.arrayContaining(['OBFUSCATED_TEXT', 'RENTAL_WORDING']));
  });
  it('fair-housing terms are caught', () => {
    expect(sms('Hi Jordan, this area is perfect for young families. Can I call today? Thank you')).toContain('FAIR_HOUSING');
  });
});
