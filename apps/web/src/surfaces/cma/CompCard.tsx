// One comparable sale (R-CMA-2, R-CMA-3): its sold price and date, its distance or "distance not known", why it was
// chosen and its labels; it expands to each adjustment with its sentence, the adjusted price and its weight. The
// creator of a draft can remove it (PATCH exclude).
import { useId, useState } from 'react';
import { Button } from '../../design/index.js';
import { type CompView, day, money, miles, share, signedMoney, streetLine } from './lib.js';
import { W, featureWords } from './words.js';

export function CompCard({ comp, canEdit, busy, onRemove }: { comp: CompView; canEdit: boolean; busy: boolean; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const hid = useId();
  const panel = useId();
  const street = streetLine(comp.address);
  return (
    <article aria-labelledby={hid} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 id={hid} className="text-[17px] font-semibold text-ink [overflow-wrap:anywhere]">
          {street}
        </h3>
        <span className="text-[14px] text-ink-muted">
          {comp.address.city}, {comp.address.region}
        </span>
      </div>
      <p className="text-[15px] text-ink">
        <span className="font-semibold tabular-nums">{comp.closeDate ? W.sold(money(comp.closePriceCents), day(comp.closeDate)) : W.soldNoDate(money(comp.closePriceCents))}</span>
        <span className="text-ink-muted"> · {miles(comp.distanceM)}</span>
        <span className="text-ink-muted"> · {comp.sourceLabel === 'Team' ? W.teamSale : W.mlsSale}</span>
      </p>
      {comp.labels.length > 0 || comp.includedByAgent ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Labels">
          {comp.includedByAgent ? <li className="rounded-lg bg-accent-soft px-2 py-0.5 text-[13px] text-ink">{W.includedByYou}</li> : null}
          {comp.labels.map((l) => (
            <li key={l} className="rounded-lg bg-surface-2 px-2 py-0.5 text-[13px] text-ink">
              {l}
            </li>
          ))}
        </ul>
      ) : null}
      {comp.why.length > 0 ? (
        <div>
          <p className="text-[14px] font-medium text-ink-muted">{W.why}</p>
          <ul className="list-disc pl-5 text-[15px] text-ink">
            {comp.why.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {comp.listingBrokerageName ? <p className="text-[14px] text-ink-muted">{W.brokerage(comp.listingBrokerageName)}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
          {open ? W.hideAdjustments : W.showAdjustments}
        </Button>
        {canEdit ? (
          <Button variant="quiet" aria-label={W.removeLabel(street)} pending={busy} onClick={onRemove}>
            {W.remove}
          </Button>
        ) : null}
      </div>
      <div id={panel} hidden={!open} className="flex flex-col gap-2 border-t border-line pt-2">
        <p className="text-[14px] font-medium text-ink-muted">{W.adjustmentsHeading}</p>
        {comp.adjustments.length === 0 ? (
          <p className="text-[15px] text-ink">{W.noAdjustments}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {comp.adjustments.map((a, i) => (
              <li key={`${a.feature}-${i}`} className="text-[15px] text-ink">
                <span className="font-medium">{featureWords(a.feature)}</span> <span className="tabular-nums">{signedMoney(a.amountCents)}</span>
                {a.sentence ? <span className="block text-[14px] text-ink-muted">{a.sentence}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[15px] font-semibold text-ink tabular-nums">{W.adjustedPrice(money(comp.adjustedPriceCents))}</p>
        <p className="text-[15px] text-ink">{W.weight(share(comp.weightBps))}</p>
      </div>
    </article>
  );
}
