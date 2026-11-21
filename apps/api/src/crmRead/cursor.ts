// Opaque keyset cursors for the CRM read API (WP3a).
//
// A cursor is the last row the client already has, ordered by (updated_at, id) or, for the activity
// union, (updated_at, kind, id). The next page is strictly after that pair, so a tie on the clock
// cannot skip or repeat a row. The timestamp is UTC with microseconds, the same text Postgres
// `to_char(..., 'US')` emits, so the comparison round-trips.

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EVENT_KINDS = ['appointment', 'call', 'email', 'note', 'text'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export class CursorError extends Error {
  override readonly name = 'CursorError';
}

export interface PairCursor {
  updatedAt: string;
  id: string;
}

export interface EventCursor extends PairCursor {
  kind: EventKind;
}

export function encodePair(updatedAt: string, id: string): string {
  return Buffer.from(`${updatedAt}\n${id}`, 'utf8').toString('base64url');
}

export function encodeEvent(updatedAt: string, kind: EventKind, id: string): string {
  return Buffer.from(`${updatedAt}\n${kind}\n${id}`, 'utf8').toString('base64url');
}

export function decodePair(token: string): PairCursor {
  const parts = decode(token);
  if (parts.length !== 2) throw new CursorError('pair');
  const [updatedAt, id] = parts;
  if (!updatedAt || !id || !STAMP.test(updatedAt) || !UUID.test(id)) throw new CursorError('pair');
  return { updatedAt, id: id.toLowerCase() };
}

export function decodeEvent(token: string): EventCursor {
  const parts = decode(token);
  if (parts.length !== 3) throw new CursorError('event');
  const [updatedAt, kind, id] = parts;
  if (!updatedAt || !kind || !id || !STAMP.test(updatedAt) || !UUID.test(id) || !isKind(kind)) throw new CursorError('event');
  return { updatedAt, kind, id: id.toLowerCase() };
}

function decode(token: string): string[] {
  if (token.length < 8 || token.length > 300 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new CursorError('shape');
  const text = Buffer.from(token, 'base64url').toString('utf8');
  if (text.includes('\u0000')) throw new CursorError('nul');
  return text.split('\n');
}

function isKind(s: string): s is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(s);
}

/** `call_<uuid>` as the client-facing event id. The cursor itself keeps the kind and the uuid apart. */
export function eventId(kind: EventKind, id: string): string {
  return `${kind}_${id}`;
}

export function parseEventId(value: string): { kind: EventKind; id: string } {
  const i = value.indexOf('_');
  const kind = value.slice(0, i);
  const id = value.slice(i + 1);
  if (!isKind(kind) || !UUID.test(id)) throw new CursorError('event id');
  return { kind, id: id.toLowerCase() };
}
