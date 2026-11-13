// The sales considered and not used (R-CMA-2): each with why, in one sentence, and a Use toggle when the agent may
// include it (PATCH include). The closest are listed; the count says how many of how many.
import { useId } from 'react';
import { Button } from '../../design/index.js';
import { type NotUsedView, miles } from './lib.js';
import { W } from './words.js';

export function NotUsed({ items, total, canEdit, busyId, onUse }: { items: NotUsedView[]; total: number; canEdit: boolean; busyId: string | null; onUse: (listingId: string) => void }) {
  const hid = useId();
  return (
    <section aria-labelledby={hid} className="flex flex-col gap-2">
      <h2 id={hid} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {W.notUsedHeading}
      </h2>
      {items.length === 0 ? (
        <p className="text-[15px] text-ink-muted">{W.notUsedNone}</p>
      ) : (
        <>
          <p className="text-[14px] text-ink-muted">{W.notUsedCount(items.length, Math.max(total, items.length))}</p>
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
            {items.map((n) => (
              <li key={n.listingId} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium text-ink [overflow-wrap:anywhere]">{n.address}</p>
                  <p className="text-[14px] text-ink-muted">
                    {n.sentence} · {miles(n.distanceM)}
                  </p>
                </div>
                {canEdit && n.includable ? (
                  <Button variant="secondary" aria-label={W.addLabel(n.address)} pending={busyId === n.listingId} onClick={() => onUse(n.listingId)}>
                    {W.use}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
