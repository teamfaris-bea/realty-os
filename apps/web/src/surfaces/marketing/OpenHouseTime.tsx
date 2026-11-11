// Setting an open-house invite's time (module 38): the time is a bound fact of the piece, never typed into the
// copy (R-MKT-3), so an invite cannot be approved until it is set here. PATCH /marketing-pieces/:id {openHouse}.
import { type FormEvent, useState } from 'react';
import { Button, Notice } from '../../design/index.js';
import { useMutate } from '../feed/lib/hooks.js';
import { MARKETING_KEY, errorText } from './lib.js';
import type { PieceView } from './types.js';

const local = (iso: string | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function OpenHouseTime({ piece }: { piece: PieceView }) {
  const [starts, setStarts] = useState(local(piece.openHouse?.startsAt));
  const [ends, setEnds] = useState(local(piece.openHouse?.endsAt));
  const [failure, setFailure] = useState<string | null>(null);
  const m = useMutate<{ openHouse: { startsAt: string; endsAt: string } }, { piece: PieceView }>('PATCH', { invalidate: [[...MARKETING_KEY], ['feed']] });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    const a = new Date(starts);
    const b = new Date(ends);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return;
    if (b <= a) return setFailure('The open house ends before it starts.');
    const r = await m.run(`/marketing-pieces/${piece.id}`, { openHouse: { startsAt: a.toISOString(), endsAt: b.toISOString() } });
    if (!r.ok) setFailure(errorText(r));
  };
  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2 md:flex-row md:items-end" aria-label="Open-house time">
      <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
        Open house starts
        <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink" />
      </label>
      <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
        Ends
        <input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink" />
      </label>
      <Button type="submit" variant="quiet" pending={m.pending} disabled={!starts || !ends}>
        Set the time
      </Button>
      {failure ? <Notice tone="error">{failure}</Notice> : null}
    </form>
  );
}
