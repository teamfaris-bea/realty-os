// Setting an open-house invite's time (module 38): the time is a bound fact of the piece, never typed into the
// copy (R-MKT-3), so an invite cannot be approved until it is set here. The fields are the TEAM's wall-clock time
// (piece.timezone), never the device's: the server reads {localStart, localEnd} in that zone.
import { type FormEvent, useId, useState } from 'react';
import { Button, Notice, announce } from '../../design/index.js';
import { useMutate } from '../feed/lib/hooks.js';
import { MARKETING_KEY, errorText } from './lib.js';
import type { PieceView } from './types.js';

/** 'YYYY-MM-DDTHH:mm' of an instant in a time zone. */
export function wallClock(iso: string | undefined, zone: string): string {
  if (!iso) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** "Eastern Time (America/New_York)" style name of the zone. */
export function zoneName(zone: string): string {
  try {
    const long = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
    return long ? `${long} (${zone})` : zone;
  } catch {
    return zone;
  }
}

export function OpenHouseTime({ piece }: { piece: PieceView }) {
  const zone = piece.openHouse?.zone ?? piece.timezone;
  const [starts, setStarts] = useState(wallClock(piece.openHouse?.startsAt, zone));
  const [ends, setEnds] = useState(wallClock(piece.openHouse?.endsAt, zone));
  const [failure, setFailure] = useState<string | null>(null);
  const hintId = useId();
  const errId = useId();
  const m = useMutate<{ openHouse: { localStart: string; localEnd: string } }, { piece: PieceView }>('PATCH', { invalidate: [[...MARKETING_KEY], ['feed']] });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    if (!starts || !ends) return;
    if (ends <= starts) return setFailure('The open house ends before it starts.');
    const r = await m.run(`/marketing-pieces/${piece.id}`, { openHouse: { localStart: starts, localEnd: ends } });
    if (!r.ok) setFailure(errorText(r));
    else announce('Open-house time set.');
  };
  const invalid = failure !== null;
  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2" aria-label="Open-house time">
      <p id={hintId} className="text-[14px] text-ink-muted">
        Set the open-house time below. Times are {zoneName(zone)}.
      </p>
      <div className="flex flex-col gap-2 md:flex-row md:items-end">
        <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
          Open house starts
          <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} aria-describedby={hintId} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
          Ends
          <input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${hintId} ${errId}` : hintId} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink" />
        </label>
        <Button type="submit" variant="quiet" pending={m.pending} disabled={!starts || !ends}>
          Set the time
        </Button>
      </div>
      {failure ? (
        <div id={errId}>
          <Notice tone="error">{failure}</Notice>
        </div>
      ) : null}
    </form>
  );
}
