// @vitest-environment node
// Lock-screen alerts slice 2 (R-PUSH-6 to R-PUSH-9): the service-worker handlers as pure functions. The node
// environment is deliberate: there is no window, document, self or clients here, which proves the module imports
// and runs with only what the caller injects. Not registered anywhere; every payload, id and key below is invented.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GENERIC_NOTIFICATION, PUSH_SUBSCRIPTIONS_PATH, buildPushNotification, onNotificationClick, onPush, onPushSubscriptionChange, safeInAppPath } from './swHandlers.js';

const ORIGIN = 'https://app.example.invalid';
const TAG = '0190f5a0-0000-7000-8000-0000000000aa:0190f5a0-0000-7000-8000-000000000001';
const GOOD = { title: 'A new lead is waiting for a call', body: 'Open the app to see who.', url: '/contacts/0190f5a0-0000-7000-8000-000000000002?team=harbor', tag: TAG };

const data = (v: unknown) => ({ json: () => v });
const raw = (text: string) => ({ json: () => JSON.parse(text) as unknown });

function registration() {
  const shown: { title: string; options: unknown }[] = [];
  return { shown, showNotification: vi.fn(async (title: string, options: unknown) => void shown.push({ title, options })) };
}

afterEach(() => vi.restoreAllMocks());

describe('service-worker push handler (pure)', () => {
  it('R-PUSH-6 E1228: a well-formed lock-screen payload becomes exactly title, body, tag and a data.url; extra fields never surface', async () => {
    const extra = { ...GOOD, image: 'https://evil.example.invalid/x.png', actions: [{ action: 'dial-now' }], phone: '+18435550142', email: 'test.lead.a@example.invalid', requireInteraction: true, data: { secret: 'x' } };
    expect(buildPushNotification(extra)).toEqual({ title: GOOD.title, options: { body: GOOD.body, tag: TAG, data: { url: GOOD.url } } });
    const reg = registration();
    await onPush(data(extra), reg);
    expect(reg.showNotification).toHaveBeenCalledTimes(1);
    expect(reg.shown[0]).toEqual({ title: GOOD.title, options: { body: GOOD.body, tag: TAG, data: { url: GOOD.url } } });
    const shownText = JSON.stringify(reg.shown);
    for (const leak of ['evil', 'dial-now', 'actions', '5550142', '@example', 'secret', 'requireInteraction']) expect(shownText).not.toContain(leak);
    // a payload whose url is not a same-origin relative path keeps its text but taps to '/'
    expect(buildPushNotification({ ...GOOD, url: 'https://evil.example.invalid/' }).options.data).toEqual({ url: '/' });
    // a payload without a tag shows without one
    expect(buildPushNotification({ title: GOOD.title, body: GOOD.body, url: GOOD.url }).options).toEqual({ body: GOOD.body, data: { url: GOOD.url } });
  });

  it('R-PUSH-6 E1229: missing, unreadable or malformed data shows the generic notification, never a partial or raw one', async () => {
    const generic = { title: GENERIC_NOTIFICATION.title, options: { body: GENERIC_NOTIFICATION.body, data: { url: '/' } } };
    const bad: unknown[] = [
      null,
      undefined,
      'A new lead: Test Lead A (843) 555-0142',
      42,
      [],
      {},
      { ...GOOD, title: '' },
      { ...GOOD, title: '   ' },
      { ...GOOD, title: 7 },
      { ...GOOD, body: null },
      { ...GOOD, title: 'x'.repeat(121) },
      { ...GOOD, body: 'y'.repeat(241) },
      { ...GOOD, title: 'New lead\u202Eevil' },
      { ...GOOD, title: 'New\u0000lead' },
      { ...GOOD, body: 'line\nbreak' },
    ];
    for (const b of bad) expect(buildPushNotification(b)).toEqual(generic);
    // a bad tag alone is dropped (the text is still the server's generic text), never shown
    expect(buildPushNotification({ ...GOOD, tag: 'x'.repeat(201) }).options).toEqual({ body: GOOD.body, data: { url: GOOD.url } });
    expect(buildPushNotification({ ...GOOD, tag: 5 }).options).toEqual({ body: GOOD.body, data: { url: GOOD.url } });
    // no data at all, data that is not JSON, and data whose reader throws
    for (const d of [null, undefined, raw('{not json'), { json: () => { throw new Error('boom'); } }]) {
      const reg = registration();
      await onPush(d, reg);
      expect(reg.shown).toEqual([generic]);
    }
  });
});

describe('service-worker notificationclick handler (pure)', () => {
  it('R-PUSH-7 E1230: a same-origin relative path focuses an open app window and navigates it there, else opens one', async () => {
    expect(safeInAppPath(GOOD.url, ORIGIN)).toBe(GOOD.url);
    expect(safeInAppPath('/notifications', ORIGIN)).toBe('/notifications');
    expect(safeInAppPath('/contacts/a?team=harbor#top', ORIGIN)).toBe('/contacts/a?team=harbor#top');

    const close = vi.fn();
    const focus = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    const openWindow = vi.fn(async () => null);
    const matchAll = vi.fn(async () => [
      { url: 'https://other.example.invalid/', focus: vi.fn(), navigate: vi.fn() },
      { url: `${ORIGIN}/today`, focus, navigate },
    ]);
    const r = await onNotificationClick({ close, data: { url: GOOD.url } }, { matchAll, openWindow }, ORIGIN);
    expect(close).toHaveBeenCalledTimes(1);
    expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(navigate).toHaveBeenCalledWith(GOOD.url);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
    expect(r).toEqual({ action: 'focused', url: GOOD.url });

    const open2 = vi.fn(async () => null);
    const r2 = await onNotificationClick({ close: vi.fn(), data: { url: '/notifications' } }, { matchAll: async () => [], openWindow: open2 }, ORIGIN);
    expect(open2).toHaveBeenCalledWith('/notifications');
    expect(r2).toEqual({ action: 'opened', url: '/notifications' });
  });

  it('R-PUSH-7 E1231: absolute, protocol-relative, javascript:, data:, backslash, whitespace and other-origin targets all fall back to "/"', async () => {
    const hostile: unknown[] = [
      'https://evil.example.invalid/contacts/1',
      `${ORIGIN}/contacts/1`,
      'http://app.example.invalid/contacts/1',
      '//evil.example.invalid/x',
      '///evil.example.invalid/x',
      '/\\evil.example.invalid',
      '\\\\evil.example.invalid',
      '/contacts\\..\\x',
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'contacts/1',
      '../contacts/1',
      ' /contacts/1',
      '/\t/evil.example.invalid',
      '/\n/evil.example.invalid',
      '/x\u0000y',
      `/${'a'.repeat(2048)}`,
      '',
      null,
      undefined,
      42,
      { url: '/contacts/1' },
    ];
    for (const h of hostile) expect(safeInAppPath(h, ORIGIN)).toBe('/');

    for (const h of hostile) {
      const openWindow = vi.fn(async () => null);
      const r = await onNotificationClick({ close: vi.fn(), data: { url: h } }, { matchAll: async () => [], openWindow }, ORIGIN);
      expect(openWindow).toHaveBeenCalledWith('/');
      expect(r).toEqual({ action: 'opened', url: '/' });
    }
    // no data at all, or data that is not an object
    for (const d of [undefined, null, 'x', 3]) {
      const openWindow = vi.fn(async () => null);
      expect(await onNotificationClick({ close: vi.fn(), data: d }, { matchAll: async () => [], openWindow }, ORIGIN)).toEqual({ action: 'opened', url: '/' });
    }
    // an open window of ANOTHER origin is never focused or navigated
    const foreign = { url: 'https://evil.example.invalid/', focus: vi.fn(), navigate: vi.fn() };
    const openWindow = vi.fn(async () => null);
    await onNotificationClick({ close: vi.fn(), data: { url: GOOD.url } }, { matchAll: async () => [foreign], openWindow }, ORIGIN);
    expect(foreign.focus).not.toHaveBeenCalled();
    expect(foreign.navigate).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith(GOOD.url);
  });
});

describe('service-worker pushsubscriptionchange handler (pure)', () => {
  const KEY = new Uint8Array([4, 1, 2, 3]).buffer;
  const sub = (endpoint: string, p256dh = 'BPp256dh_invented_key_0123456789', auth = 'auth_invented_01') => ({
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
  });

  it('R-PUSH-8 E1232: re-subscribes with the existing applicationServerKey and returns the POST for the device route, without sending it', async () => {
    const subscribe = vi.fn(async () => sub('https://push.example.invalid/sub/new-1'));
    const r = await onPushSubscriptionChange({ oldSubscription: { options: { applicationServerKey: KEY } } }, { pushManager: { subscribe } });
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: KEY });
    expect(PUSH_SUBSCRIPTIONS_PATH).toBe('/api/push-subscriptions');
    // exactly the strict body of POST /push-subscriptions (apps/api/src/auth/devices.ts): no expirationTime
    expect(r).toEqual({
      kind: 'post',
      method: 'POST',
      path: '/api/push-subscriptions',
      body: { endpoint: 'https://push.example.invalid/sub/new-1', keys: { p256dh: 'BPp256dh_invented_key_0123456789', auth: 'auth_invented_01' } },
    });
    // a browser that already hands over the new subscription is not asked to subscribe again
    const subscribe2 = vi.fn();
    const r2 = await onPushSubscriptionChange({ oldSubscription: { options: { applicationServerKey: KEY } }, newSubscription: sub('https://push.example.invalid/sub/new-2') }, { pushManager: { subscribe: subscribe2 } });
    expect(subscribe2).not.toHaveBeenCalled();
    expect(r2).toMatchObject({ kind: 'post', body: { endpoint: 'https://push.example.invalid/sub/new-2' } });
  });

  it('R-PUSH-8 E1233: no existing key, a failed subscribe, a non-https endpoint or malformed keys describe no POST at all', async () => {
    const subscribe = vi.fn(async () => sub('https://push.example.invalid/sub/x'));
    expect(await onPushSubscriptionChange({}, { pushManager: { subscribe } })).toEqual({ kind: 'skip', reason: 'NO_APPLICATION_SERVER_KEY' });
    expect(await onPushSubscriptionChange({ oldSubscription: null }, { pushManager: { subscribe } })).toEqual({ kind: 'skip', reason: 'NO_APPLICATION_SERVER_KEY' });
    expect(await onPushSubscriptionChange({ oldSubscription: { options: { applicationServerKey: null } } }, { pushManager: { subscribe } })).toEqual({ kind: 'skip', reason: 'NO_APPLICATION_SERVER_KEY' });
    expect(subscribe).not.toHaveBeenCalled();
    const old = { oldSubscription: { options: { applicationServerKey: KEY } } };
    const failing = vi.fn(async () => {
      throw new Error('denied');
    });
    expect(await onPushSubscriptionChange(old, { pushManager: { subscribe: failing } })).toEqual({ kind: 'skip', reason: 'SUBSCRIBE_FAILED' });
    for (const s of [sub('http://push.example.invalid/x'), sub('not a url'), sub('https://push.example.invalid/x', 'short'), sub('https://push.example.invalid/x', 'BPp256dh_invented_key_0123456789', 'bad auth!'), { toJSON: () => ({}) }, { toJSON: () => null }]) {
      expect(await onPushSubscriptionChange(old, { pushManager: { subscribe: async () => s } })).toEqual({ kind: 'skip', reason: 'SUBSCRIPTION_INVALID' });
    }
  });
});

describe('service-worker handlers are pure', () => {
  it('R-PUSH-9 E1234: the module imports and runs with no DOM or worker globals and makes no network call', async () => {
    expect(typeof (globalThis as Record<string, unknown>).window).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>).document).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>).clients).toBe('undefined');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const reg = registration();
    await onPush(data(GOOD), reg);
    await onNotificationClick({ close: vi.fn(), data: { url: GOOD.url } }, { matchAll: async () => [], openWindow: async () => null }, ORIGIN);
    await onPushSubscriptionChange({ oldSubscription: { options: { applicationServerKey: new Uint8Array([4]).buffer } } }, { pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://push.example.invalid/s', keys: { p256dh: 'BPp256dh_invented_key_0123456789', auth: 'auth_invented_01' } }) }) } });
    expect(fetchSpy).not.toHaveBeenCalled();
    // same input, same output; the input is left untouched
    const frozen = Object.freeze({ ...GOOD });
    expect(buildPushNotification(frozen)).toEqual(buildPushNotification(frozen));
    expect(frozen).toEqual(GOOD);
  });
});
