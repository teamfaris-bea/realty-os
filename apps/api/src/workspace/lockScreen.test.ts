// Lock-screen alerts for leads (push-step1, R-PUSH): the pure payload builder only. No database, no push
// provider, no clock, no randomness. Every person below is invented; the assertions prove that none of
// their details (name, phone, email, address, message text, source detail) reaches the lock screen by default.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAD_ALERT_KINDS, LEAD_ALERT_TITLE, leadAlertLockScreen } from './lockScreen.js';
import { LOCK_SCREEN_TITLE } from './lockScreenWords.js';
import { lockScreenPayload } from './notifications.js';
import { NOTIFICATION_KINDS } from './schemas.js';

const TENANT_A = { id: '0190f5a0-0000-7000-8000-0000000000aa', slug: 'harbor' };
const TENANT_B = { id: '0190f5a0-0000-7000-8000-0000000000bb', slug: 'inlet' };
const NOTE_ID = '0190f5a0-0000-7000-8000-000000000001';
const CONTACT_ID = '0190f5a0-0000-7000-8000-000000000002';

// invented lead details: none may appear in a payload built with the defaults
const RAW = {
  fullName: 'Test Lead A',
  lastName: 'Lead A',
  email: 'test.lead.a@example.invalid',
  phoneE164: '+18435550142',
  phonePretty: '(843) 555-0142',
  address: '12 Example Lane',
  message: 'Can we see the house tomorrow at noon',
  source: 'Example Portal Premium',
};
// a stored in-app title as rich as a creator could make it (the in-app list may show more than a lock screen)
const RICH_TITLE = `${RAW.fullName} (${RAW.phonePretty}, ${RAW.email}) from ${RAW.source} at ${RAW.address}: "${RAW.message}"`;

const base = (kind: string, o: Partial<{ person: string | null; tenant: { id: string; slug: string }; title: string }> = {}) => ({
  id: NOTE_ID,
  kind,
  title: o.title ?? RICH_TITLE,
  subjectType: 'contact' as const,
  subjectId: CONTACT_ID,
  tenant: o.tenant ?? TENANT_A,
  person: o.person === undefined ? 'Test L.' : o.person,
});

const leaks = (text: string) => [RAW.fullName, RAW.lastName, RAW.email, RAW.phoneE164, RAW.phonePretty, '555-0142', '555 0142', RAW.address, RAW.message, RAW.source].filter((s) => text.includes(s));

afterEach(() => vi.restoreAllMocks());

describe('lead lock-screen alerts (pure builder)', () => {
  it('R-PUSH-1 E1220: the new lead, backup alert and pond arrival kinds show a fixed generic title and no lead details by default', () => {
    expect([...LEAD_ALERT_KINDS].sort()).toEqual(['first_touch_due', 'lead_offer', 'pond_new']);
    for (const kind of LEAD_ALERT_KINDS) {
      expect(NOTIFICATION_KINDS as readonly string[]).toContain(kind);
      const p = leadAlertLockScreen(base(kind));
      expect(p.title).toBe(LEAD_ALERT_TITLE[kind]);
      // the person's minimized label is NOT shown unless the caller opts in
      expect(p.title).not.toContain('Test');
      expect(leaks(JSON.stringify(p))).toEqual([]);
      // the body is the existing fixed sentence of the notification module, unchanged
      expect(p.body).toBe(lockScreenPayload(base(kind)).body);
    }
    expect(LEAD_ALERT_TITLE).toEqual({ lead_offer: 'New lead', first_touch_due: 'A new lead is waiting for a call', pond_new: 'New lead in the pond' });
  });

  it('R-PUSH-2 E1221: the name appears only on explicit opt-in, and only as the already-minimized first name and initial', () => {
    const p = leadAlertLockScreen(base('lead_offer'), { showName: true });
    expect(p.title).toBe('New lead: Test L.');
    expect(leaks(JSON.stringify(p))).toEqual([]);
    expect(p.body).not.toContain('Test');
    expect(leadAlertLockScreen(base('first_touch_due'), { showName: true }).title).toBe('A new lead is waiting for a call: Test L.');
    expect(leadAlertLockScreen(base('pond_new'), { showName: true }).title).toBe('New lead in the pond: Test L.');
    // showName: false is the same as the default
    expect(leadAlertLockScreen(base('lead_offer'), { showName: false })).toEqual(leadAlertLockScreen(base('lead_offer')));
  });

  it('R-PUSH-2 E1222: opted in but the tenant hides names (no label) gives the generic title', () => {
    expect(leadAlertLockScreen(base('lead_offer', { person: null }), { showName: true }).title).toBe('New lead');
    expect(leadAlertLockScreen(base('lead_offer', { person: '   ' }), { showName: true }).title).toBe('New lead');
  });

  it('R-PUSH-2 E1223: a label that is not a first name and initial is dropped, never masked into the title', () => {
    const hostile = [
      RAW.fullName,
      `Test (${RAW.phonePretty})`,
      RAW.email,
      RAW.phoneE164,
      RAW.address,
      'Test L. 555-0142',
      'Test\u202eL.',
      'Test\u0000L.',
      'T'.repeat(41),
      'Test L. <b>',
      'https://example.invalid/x',
    ];
    for (const person of hostile) {
      const p = leadAlertLockScreen(base('lead_offer', { person }), { showName: true });
      expect(p.title, person).toBe('New lead');
      expect(leaks(JSON.stringify(p)), person).toEqual([]);
    }
    // ordinary first names with accents, apostrophes or hyphens still pass
    expect(leadAlertLockScreen(base('lead_offer', { person: 'Zoë-Ann O.' }), { showName: true }).title).toBe('New lead: Zoë-Ann O.');
    expect(leadAlertLockScreen(base('lead_offer', { person: "D'Arcy" }), { showName: true }).title).toBe("New lead: D'Arcy");
  });

  it('R-PUSH-3 E1224: the destination is a relative in-app path to the contact with ?team= and nothing that signs in', () => {
    for (const kind of LEAD_ALERT_KINDS) {
      const { url } = leadAlertLockScreen(base(kind));
      expect(url).toBe(`/contacts/${CONTACT_ID}?team=harbor`);
      expect(url.startsWith('/')).toBe(true);
      expect(url.startsWith('//')).toBe(false);
      expect(url).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      const q = new URL(url, 'https://app.example.invalid').searchParams;
      expect([...q.keys()]).toEqual(['team']);
    }
    // a slug is encoded, never able to add a parameter or change the path
    const odd = leadAlertLockScreen(base('lead_offer', { tenant: { id: TENANT_A.id, slug: 'a&token=x/../y' } }));
    expect([...new URL(odd.url, 'https://app.example.invalid').searchParams.keys()]).toEqual(['team']);
    expect(new URL(odd.url, 'https://app.example.invalid').pathname).toBe(`/contacts/${CONTACT_ID}`);
  });

  it('R-PUSH-4 E1225: the tag is prefixed by the tenant so two teams never replace each other', () => {
    const a = leadAlertLockScreen(base('lead_offer'));
    const b = leadAlertLockScreen(base('lead_offer', { tenant: TENANT_B }));
    expect(a.tag).toBe(`${TENANT_A.id}:${NOTE_ID}`);
    expect(b.tag).toBe(`${TENANT_B.id}:${NOTE_ID}`);
    expect(b.url).toBe(`/contacts/${CONTACT_ID}?team=inlet`);
  });

  it('R-PUSH-5 R-PUSH-14 E1226: any other kind keeps exactly lockScreenPayload\'s body, url and tag, and its title is the kind\'s allowlisted generic words, never the stored title (slice 2e: fail closed)', () => {
    for (const kind of NOTIFICATION_KINDS.filter((k) => !(LEAD_ALERT_KINDS as readonly string[]).includes(k))) {
      for (const title of ['A task is due', RICH_TITLE]) {
        const n = base(kind, { title });
        const p = leadAlertLockScreen(n, { showName: true });
        expect(p).toEqual({ ...lockScreenPayload(n), title: LOCK_SCREEN_TITLE[kind] });
        expect(leaks(JSON.stringify(p))).toEqual([]);
        expect(p.title).not.toContain('Test');
      }
    }
  });

  it('R-PUSH-5 E1227: pure: no clock, no randomness, input untouched, same input same output', () => {
    const now = vi.spyOn(Date, 'now');
    const rnd = vi.spyOn(Math, 'random');
    const input = Object.freeze({ ...base('first_touch_due'), tenant: Object.freeze({ ...TENANT_A }) });
    const first = leadAlertLockScreen(input, { showName: true });
    expect(leadAlertLockScreen(input, { showName: true })).toEqual(first);
    expect(now).not.toHaveBeenCalled();
    expect(rnd).not.toHaveBeenCalled();
    expect(Object.keys(first).sort()).toEqual(['body', 'tag', 'title', 'url']);
  });
});
