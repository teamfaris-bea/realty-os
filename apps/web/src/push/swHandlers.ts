// Lock-screen alerts slice 2 (DATA_MODEL R-PUSH-6 to R-PUSH-9): the service worker's three handlers as PURE functions.
// Nothing here touches a DOM or worker global: the caller (a future service worker, not written yet) passes in the
// registration, the clients object and its own origin. Nothing registers a worker, adds a manifest or is imported by
// main.tsx; nothing here makes a network call (the subscription-change handler only DESCRIBES the POST to make).
//
//   push                    the payload the API builds (apps/api/src/workspace/lockScreen.ts leadAlertLockScreen over
//                           lockScreenPayload: { title, body, url, tag }) becomes showNotification(title, { body, tag,
//                           data: { url } }); any other field is dropped. Missing or malformed data shows a generic
//                           notification, never a partial or raw one.
//   notificationclick       goes only to a same-origin RELATIVE path ("/contacts/<id>?team=<slug>"); anything else
//                           (an absolute URL, "//host", javascript:, data:, a backslash, whitespace or control
//                           characters, another origin) goes to "/".
//   pushsubscriptionchange  re-subscribes with the existing applicationServerKey and returns the body for the existing
//                           device route POST /push-subscriptions (apps/api/src/auth/devices.ts: exactly endpoint and
//                           keys, strict), or says why there is nothing to post.

/** What the API's lock-screen builder sends (title at most 120, body at most 240: the notifications table's limits). */
export interface LockScreenPush {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export interface ShownNotification {
  title: string;
  options: { body: string; tag?: string; data: { url: string } };
}

/** Shown when the push has no data or data this module does not accept. Says nothing about anyone. */
export const GENERIC_NOTIFICATION = Object.freeze({ title: 'New notification', body: 'Open the app for details.' });

/** The existing device route (apps/api/src/auth/devices.ts) behind the web app's API base ('/api', shell/api.ts). */
export const PUSH_SUBSCRIPTIONS_PATH = '/api/push-subscriptions';

const MAX_TITLE = 120;
const MAX_BODY = 240;
const MAX_PATH = 2048;
// the bidi/direction marks that can disguise text on a lock screen
const DIRECTION_MARKS = new Set([0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const TAG = /^[\x21-\x7E]{1,200}$/;
// the device route's strict body (apps/api/src/auth/devices.ts)
const P256DH = /^[A-Za-z0-9_-]{20,200}={0,2}$/;
const AUTH = /^[A-Za-z0-9_-]{8,100}={0,2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A C0 or C1 control character (incl. tab, newline, NUL). */
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function hasUnsafeChar(v: string, alsoSpace: boolean): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (isControl(c) || DIRECTION_MARKS.has(c) || (alsoSpace && /\s/.test(v[i] as string))) return true;
  }
  return false;
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max || hasUnsafeChar(v, false)) return null;
  return v;
}

/**
 * The in-app path a tap may open, or '/'. Only a same-origin relative path is accepted: it starts with exactly one
 * '/', holds no backslash, whitespace or control character, and still resolves to `origin`.
 */
export function safeInAppPath(raw: unknown, origin: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH) return '/';
  if (raw[0] !== '/' || raw[1] === '/' || raw.includes('\\') || hasUnsafeChar(raw, true)) return '/';
  let u: URL;
  try {
    u = new URL(raw, origin);
  } catch {
    return '/';
  }
  if (u.origin !== origin) return '/';
  return `${u.pathname}${u.search}${u.hash}`;
}

function generic(): ShownNotification {
  return { title: GENERIC_NOTIFICATION.title, options: { body: GENERIC_NOTIFICATION.body, data: { url: '/' } } };
}

/**
 * The showNotification arguments for a push payload. Only title, body, tag and url are read; a missing or bad title or
 * body gives the generic notification, a bad tag is dropped, a bad url taps to '/'. `origin` only checks the url.
 */
export function buildPushNotification(payload: unknown, origin = 'https://app.invalid'): ShownNotification {
  if (!isRecord(payload)) return generic();
  const title = cleanText(payload.title, MAX_TITLE);
  const body = cleanText(payload.body, MAX_BODY);
  if (title === null || body === null) return generic();
  const url = safeInAppPath(payload.url, origin);
  const tag = typeof payload.tag === 'string' && TAG.test(payload.tag) ? payload.tag : null;
  return { title, options: tag === null ? { body, data: { url } } : { body, tag, data: { url } } };
}

export interface PushDataLike {
  json(): unknown;
}
export interface RegistrationLike {
  showNotification(title: string, options: ShownNotification['options']): Promise<void>;
}

/** The `push` event: `event.data` and `self.registration` are passed in. Always shows exactly one notification. */
export async function onPush(data: PushDataLike | null | undefined, registration: RegistrationLike, origin?: string): Promise<ShownNotification> {
  let payload: unknown;
  try {
    payload = data ? data.json() : null;
  } catch {
    payload = null;
  }
  const n = buildPushNotification(payload, origin);
  await registration.showNotification(n.title, n.options);
  return n;
}

export interface WindowClientLike {
  url: string;
  focus(): Promise<unknown> | unknown;
  navigate?(url: string): Promise<unknown> | unknown;
}
export interface ClientsLike {
  matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<unknown>;
}
export interface NotificationLike {
  data?: unknown;
  close(): void;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The `notificationclick` event: closes the notification, then focuses an open window of THIS origin and navigates it
 * to the safe path, else opens a new window there. Another origin's window is never touched.
 */
export async function onNotificationClick(notification: NotificationLike, clients: ClientsLike, origin: string): Promise<{ action: 'focused' | 'opened'; url: string }> {
  notification.close();
  const url = safeInAppPath(isRecord(notification.data) ? notification.data.url : undefined, origin);
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const mine = windows.find((c) => originOf(c.url) === origin);
  if (mine) {
    try {
      await mine.focus();
      if (mine.navigate) await mine.navigate(url);
      return { action: 'focused', url };
    } catch {
      // a window this worker does not control cannot be navigated: open a new one instead
    }
  }
  await clients.openWindow(url);
  return { action: 'opened', url };
}

export interface SubscriptionLike {
  toJSON(): unknown;
}
export interface SubscriptionChangeLike {
  oldSubscription?: { options?: { applicationServerKey?: ArrayBuffer | null } | null } | null;
  newSubscription?: SubscriptionLike | null;
}
export interface PushManagerRegistrationLike {
  pushManager: { subscribe(o: { userVisibleOnly: true; applicationServerKey: ArrayBuffer }): Promise<SubscriptionLike> };
}
export type SubscriptionChangeResult =
  | { kind: 'post'; method: 'POST'; path: typeof PUSH_SUBSCRIPTIONS_PATH; body: { endpoint: string; keys: { p256dh: string; auth: string } } }
  | { kind: 'skip'; reason: 'NO_APPLICATION_SERVER_KEY' | 'SUBSCRIBE_FAILED' | 'SUBSCRIPTION_INVALID' };

function postBody(sub: SubscriptionLike): SubscriptionChangeResult {
  const j = sub.toJSON();
  const keys = isRecord(j) && isRecord(j.keys) ? j.keys : null;
  const endpoint = isRecord(j) ? j.endpoint : undefined;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || originOf(endpoint) === null || !endpoint.startsWith('https://')) return { kind: 'skip', reason: 'SUBSCRIPTION_INVALID' };
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || !P256DH.test(keys.p256dh) || !AUTH.test(keys.auth)) return { kind: 'skip', reason: 'SUBSCRIPTION_INVALID' };
  return { kind: 'post', method: 'POST', path: PUSH_SUBSCRIPTIONS_PATH, body: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } };
}

/**
 * The `pushsubscriptionchange` event: uses the browser's new subscription when it gives one, else re-subscribes with the
 * old subscription's applicationServerKey. Returns what to POST (the caller sends it, signed in); sends nothing itself.
 */
export async function onPushSubscriptionChange(event: SubscriptionChangeLike, registration: PushManagerRegistrationLike): Promise<SubscriptionChangeResult> {
  if (event.newSubscription) return postBody(event.newSubscription);
  const key = event.oldSubscription?.options?.applicationServerKey ?? null;
  if (key === null) return { kind: 'skip', reason: 'NO_APPLICATION_SERVER_KEY' };
  let sub: SubscriptionLike;
  try {
    sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    return { kind: 'skip', reason: 'SUBSCRIBE_FAILED' };
  }
  return postBody(sub);
}
