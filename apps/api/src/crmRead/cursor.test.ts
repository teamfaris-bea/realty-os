import { describe, expect, it } from 'vitest';
import { CursorError, decodeEvent, decodePair, encodeEvent, encodePair, eventId, parseEventId } from './cursor.js';

const STAMP = '2024-06-01T12:00:00.123456Z';
const ID = '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b';

describe('CRM read cursors', () => {
  it('round-trips a person cursor and an activity cursor', () => {
    expect(decodePair(encodePair(STAMP, ID))).toEqual({ updatedAt: STAMP, id: ID });
    expect(decodeEvent(encodeEvent(STAMP, 'text', ID))).toEqual({ updatedAt: STAMP, kind: 'text', id: ID });
    expect(eventId('call', ID)).toBe(`call_${ID}`);
    expect(parseEventId(`email_${ID}`)).toEqual({ kind: 'email', id: ID });
  });

  it('refuses a cursor that is not the pair or triple this API emits', () => {
    expect(() => decodePair('not-a-cursor')).toThrow(CursorError);
    expect(() => decodePair(encodeEvent(STAMP, 'note', ID))).toThrow(CursorError);
    expect(() => decodeEvent(encodePair(STAMP, ID))).toThrow(CursorError);
    expect(() => decodePair(encodePair('2024-06-01T12:00:00.123Z', ID))).toThrow(CursorError);
    expect(() => parseEventId(ID)).toThrow(CursorError);
    expect(() => parseEventId(`nope_${ID}`)).toThrow(CursorError);
  });
});
