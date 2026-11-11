// Every sentence the Gmail settings page and the Gmail admin page say about state, in plain words. The page
// never shows a raw code: callback results, revoke reasons and API error codes all land here.
import type { MailLinkView, RevokeReason } from './types.js';

/** Copy the API contract fixes word for word (VERIFY WITH COUNSEL: the disconnect sentence). */
export const COPY = {
  disconnect: 'Your copies disappear from Realty OS now and are deleted within a few minutes; backup copies expire on their own schedule.',
  providerRevoked: 'Google access was removed: connect again',
  confirmTitle: 'Sync Gmail with these clients?',
  onlyConfirmed: "Nothing is copied for an address you haven't confirmed. Mail with anyone else stays in Gmail.",
} as const;

/** `?result=` codes the OAuth callback sends back (GET /me/mail-link/callback → 303 /settings/mail?result=CODE). */
export const RESULT_WORDS: Record<string, { tone: 'ok' | 'info' | 'error'; text: string }> = {
  CONNECTED: { tone: 'ok', text: 'Gmail is connected. Choose which clients to sync below.' },
  CANCELLED: { tone: 'info', text: "You didn't finish in Google, so Gmail was not connected." },
  STATE_INVALID: { tone: 'error', text: "That connect link wasn't valid, so Gmail was not connected. Tap Connect Gmail to try again." },
  STATE_EXPIRED: { tone: 'error', text: 'That connect link expired, so Gmail was not connected. Tap Connect Gmail to try again.' },
  STATE_REPLAYED: { tone: 'error', text: 'That connect link was already used. Tap Connect Gmail to start again.' },
  SCOPE_NOT_ALLOWED: { tone: 'error', text: 'Google granted access other than read-only Gmail, so nothing was connected or kept. Try again and allow read-only access only.' },
  MAILBOX_LINKED_ELSEWHERE: { tone: 'error', text: 'This Gmail address is already connected to another Realty OS account, so it was not connected here.' },
  ALREADY_CONNECTED: { tone: 'info', text: 'Your Gmail is already connected.' },
  MAIL_SYNC_OFF: { tone: 'error', text: 'Gmail sync is turned off for your team, so Gmail was not connected.' },
  PROVIDER_REFUSED: { tone: 'error', text: "Google didn't finish the connection, so Gmail was not connected. Try again in a moment." },
};

export function resultWords(code: string | null): { tone: 'ok' | 'info' | 'error'; text: string } | null {
  if (!code) return null;
  return RESULT_WORDS[code] ?? { tone: 'error', text: 'Gmail was not connected. Tap Connect Gmail to try again.' };
}

const REVOKE_WORDS: Record<RevokeReason, string> = {
  PROVIDER_REVOKED: COPY.providerRevoked,
  USER_DISCONNECTED: 'Gmail is disconnected. Your copies were removed from Realty OS.',
  MEMBER_INACTIVE: "Gmail was disconnected because your account isn't active on this team.",
  SYNC_TURNED_OFF: 'Gmail was disconnected because Gmail sync was turned off for your team.',
  PLATFORM_NOT_CLEARED: "Gmail was disconnected because Gmail sync isn't available right now.",
};

export function formatWhen(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return 'at an unknown time';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(t);
}

export function formatDay(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return 'an unknown date';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(t);
}

/** The status line of a link. */
export function statusWords(l: MailLinkView): string {
  if (l.status === 'revoked') return l.revokeReason ? REVOKE_WORDS[l.revokeReason] : 'Gmail is disconnected.';
  if (l.status === 'degraded') return l.statusSentence || `Connected: ${l.mailboxAddress}, but the last sync didn't finish. Realty OS tries again on its own.`;
  return `Connected: ${l.mailboxAddress}. ${l.lastSyncedAt ? `Last synced ${formatWhen(l.lastSyncedAt)}.` : 'Not synced yet.'}`;
}

/** What the backfill is doing, or null when nothing is pending. */
export function backfillWords(l: MailLinkView, days: number): string | null {
  if (l.status === 'revoked' || !l.backfillRequestedAt) return null;
  if (l.backfillDoneAt && Date.parse(l.backfillDoneAt) >= Date.parse(l.backfillRequestedAt)) return days > 0 ? `Mail from the last ${days} days with your synced clients was imported.` : null;
  return days > 0 ? `Importing mail from the last ${days} days with your synced clients.` : 'Only new mail is copied: your team imports no past mail.';
}

/** Error code → sentence for the mail pages (also registered on the surfaces' errorMessages). */
export const MAIL_ERROR_MESSAGES: Record<string, string> = {
  MAIL_SYNC_OFF: "Gmail sync isn't turned on for your team, so you can't connect Gmail yet.",
  MAIL_ALREADY_CONNECTED: 'Your Gmail is already connected.',
  MAIL_DISCLOSURE_STALE: 'The text on this page changed. Reload the page, read it again, then connect.',
  MAIL_PROVIDER_NOT_CONFIGURED: "Gmail isn't set up on this deployment, so it can't be connected.",
  MAIL_NOT_CONNECTED: 'Gmail is not connected. Connect it first.',
  MAIL_SYNC_NOT_CLEARED: "Gmail sync can't be turned on until it is reviewed by counsel and verified by Google.",
  OWNER_REQUIRED: 'Only the Owner can do that.',
};
