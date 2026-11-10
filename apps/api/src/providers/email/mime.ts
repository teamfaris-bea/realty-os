// RFC 5322 / MIME message builder for the SMTP email adapter (smtp.ts). Pure: no I/O, no clock,
// no randomness (the multipart boundary is derived from the Message-ID).
//
// Header injection is impossible by construction: every header value, address and display name is
// checked for CR/LF (and other control characters) before anything is assembled, caller header
// names must match /^[A-Za-z0-9-]+$/, and caller headers may not override the structural ones.
// Errors carry only a stable code, never the offending value (it may be an address or a subject).
import { createHash } from 'node:crypto';
import { ProviderError } from '../types.js';

export interface MimeInput {
  from: { address: string; name: string };
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  /** caller headers (e.g. X-Realty-Ref, List-Unsubscribe): emitted verbatim, in insertion order */
  headers?: Record<string, string>;
  /** vendor metadata headers added by the adapter itself (names may contain `_`, e.g. X-PM-Metadata-realty_ref) */
  vendorHeaders?: readonly (readonly [string, string])[];
  /** `<id@domain>` (see makeMessageId) */
  messageId: string;
  date: Date;
}

const CRLF = '\r\n';
const MAX_LINE = 998;

/** Headers the message structure owns. Caller headers may not set them (compared case-insensitively). */
const STRUCTURAL = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'sender',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'return-path',
  'received',
]);

const headerInvalid = () => new ProviderError('rejected', 'EMAIL_HEADER_INVALID');
const addressInvalid = () => new ProviderError('rejected', 'EMAIL_ADDRESS_INVALID');

const hasCrLf = (s: string) => /[\r\n]/.test(s);
// Any C0 control except TAB, plus DEL.
// eslint-disable-next-line no-control-regex
const hasControl = (s: string) => /[\u0000-\u0008\u000a-\u001f\u007f]/.test(s);
// eslint-disable-next-line no-control-regex
const isAscii = (s: string) => /^[\u0000-\u007f]*$/.test(s);

/** Text that becomes (part of) a header: CR/LF or other control characters → EMAIL_HEADER_INVALID. */
function checkHeaderText(s: string): void {
  if (typeof s !== 'string' || hasCrLf(s) || hasControl(s)) throw headerInvalid();
}

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const ADDRESS_RE = new RegExp(`^[A-Za-z0-9.!#$%&'*+/=?^_\`{|}~-]{1,64}@(?:${LABEL}\\.)+${LABEL}$`);

/**
 * A bare ASCII addr-spec (no display name, no comments, no SMTPUTF8). CR/LF → EMAIL_HEADER_INVALID,
 * anything else malformed → EMAIL_ADDRESS_INVALID. Returns the address unchanged.
 */
export function checkAddress(address: string): string {
  if (typeof address !== 'string') throw addressInvalid();
  checkHeaderText(address);
  if (address.length > 254 || !ADDRESS_RE.test(address)) throw addressInvalid();
  const local = address.slice(0, address.lastIndexOf('@'));
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) throw addressInvalid();
  return address;
}

/** The domain of an address, lower-cased. */
export function domainOf(address: string): string {
  return checkAddress(address).slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * `<{key}@{from domain}>`. The key is sanitized collision-free: [A-Za-z0-9_+-] stay, every other
 * UTF-8 byte becomes `=XX`, so the left side is always a valid dot-atom.
 */
export function makeMessageId(idempotencyKey: string, fromAddress: string): string {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 200) throw headerInvalid();
  let left = '';
  for (const byte of Buffer.from(idempotencyKey, 'utf8')) {
    const c = String.fromCharCode(byte);
    left += /[A-Za-z0-9_+-]/.test(c) ? c : '=' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return `<${left}@${domainOf(fromAddress)}>`;
}

/** RFC 2047 B encoded-words (UTF-8), split on code-point boundaries, folded with CRLF SP. */
function encodeWords(s: string): string {
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const cp of s) {
    const n = Buffer.byteLength(cp, 'utf8');
    // 39 bytes → 52 base64 chars + 12 chars of =?UTF-8?B?…?= = 64 ≤ 75 (RFC 2047 §2), so even
    // "Subject: " + the first word stays within the 78-character line recommendation
    if (bytes + n > 39) {
      words.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += cp;
    bytes += n;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(CRLF + ' ');
}

/** Unstructured header text (Subject): ASCII as is when it fits, otherwise encoded-words. */
function encodeUnstructured(s: string, headerName: string): string {
  if (isAscii(s) && headerName.length + 2 + s.length <= MAX_LINE && !/=\?/.test(s)) return s;
  return encodeWords(s);
}

/** Display name as an RFC 5322 phrase: atoms as is, specials quoted, non-ASCII encoded-words. */
function encodeDisplayName(name: string): string {
  if (!isAscii(name)) return encodeWords(name);
  if (/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]*$/.test(name) && !/=\?/.test(name)) return name;
  return `"${name.replace(/(["\\])/g, '\\$1')}"`;
}

function mailbox(address: string, name: string): string {
  checkHeaderText(name);
  checkAddress(address);
  const n = name.trim();
  return n ? `${encodeDisplayName(n)} <${address}>` : address;
}

/** RFC 5322 date-time in UTC: `Tue, 10 Nov 2026 12:00:00 +0000`. */
function rfc5322Date(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw headerInvalid();
  return d.toUTCString().replace(/ GMT$/, ' +0000');
}

/** UTF-8 body as base64, wrapped at 76 characters, CRLF line ends (text normalized to CRLF first). */
function base64Body(s: string): string {
  const canonical = s.replace(/\r\n|\r|\n/g, CRLF);
  const b64 = Buffer.from(canonical, 'utf8').toString('base64');
  const lines = b64.match(/.{1,76}/g) ?? [];
  return lines.join(CRLF) + CRLF;
}

/**
 * Dot-stuffing for the SMTP DATA phase (RFC 5321 §4.5.2): every line that starts with "." gets one
 * more ".". Lines are CRLF-separated; the caller appends the terminating ".\r\n".
 */
export function dotStuff(data: string): string {
  return data.replace(/(^|\r\n)\./g, '$1..');
}

/** Builds the full message (CRLF line ends, ends with CRLF). Throws ProviderError('rejected', …) on bad input. */
export function buildMessage(m: MimeInput): string {
  checkHeaderText(m.subject);
  checkHeaderText(m.messageId);
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(m.messageId)) throw headerInvalid();

  const lines: string[] = [];
  lines.push(`From: ${mailbox(m.from.address, m.from.name)}`);
  lines.push(`To: ${checkAddress(m.to)}`);
  if (m.replyTo !== undefined) lines.push(`Reply-To: ${checkAddress(m.replyTo)}`);
  lines.push(`Subject: ${encodeUnstructured(m.subject, 'Subject')}`);
  lines.push(`Date: ${rfc5322Date(m.date)}`);
  lines.push(`Message-ID: ${m.messageId}`);
  lines.push('MIME-Version: 1.0');

  const seen = new Set<string>();
  const push = (name: string, value: string) => {
    checkHeaderText(value);
    const lower = name.toLowerCase();
    if (STRUCTURAL.has(lower) || lower.startsWith('content-') || seen.has(lower)) throw headerInvalid();
    if (!isAscii(value) || name.length + 2 + value.length > MAX_LINE) throw headerInvalid();
    seen.add(lower);
    lines.push(`${name}: ${value}`);
  };
  for (const [name, value] of Object.entries(m.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw headerInvalid();
    push(name, value);
  }
  for (const [name, value] of m.vendorHeaders ?? []) {
    // RFC 5322 field-name: printable ASCII except ":" (vendor names such as X-PM-Metadata-realty_ref)
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) throw headerInvalid();
    push(name, value);
  }

  if (typeof m.text !== 'string' || (m.html !== undefined && typeof m.html !== 'string')) throw headerInvalid();
  const textPart = ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Body(m.text)];

  if (m.html === undefined) {
    return lines.join(CRLF) + CRLF + textPart.join(CRLF);
  }

  // Deterministic boundary: "=_" can never occur in base64 content, so no collision is possible.
  const boundary = '=_realty_' + createHash('sha256').update(m.messageId, 'utf8').digest('hex').slice(0, 32);
  lines.push(`Content-Type: multipart/alternative;${CRLF} boundary="${boundary}"`);
  const htmlPart = ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Body(m.html)];
  return (
    lines.join(CRLF) +
    CRLF +
    CRLF +
    `--${boundary}` +
    CRLF +
    textPart.join(CRLF) +
    `--${boundary}` +
    CRLF +
    htmlPart.join(CRLF) +
    `--${boundary}--` +
    CRLF
  );
}
