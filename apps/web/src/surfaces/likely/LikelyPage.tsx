// The Likely to move page (module 55; R-PRED-3..6, R-STAFF-3, R-STAFF-7, E677). Phone first.
//
//   - no approved model: the API's sentence, said as such, never "nobody is likely to move" (E677);
//   - otherwise, for each approved model: its platform back-test sentence once ("Of N people flagged in the
//     back-test, M transacted within D days."), then the viewer's own open cards it flagged: the name (opens the
//     contact), the band in words and the card's reasons;
//   - rows keep the API's order (band, then name): nothing is re-sorted here, and there is nothing hidden to sort by;
//   - the only action is opening the contact (R-PRED-4): no select-all, text, call, enroll or CMA control.
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import type { LikelyItemView, LikelyModelView, LikelyView } from './types.js';

export const LIKELY_KEY = ['likely'] as const;
/** the API's cap (predict/routes.ts LIKELY_LIMIT) */
const LIMIT = 200;

function Row({ item }: { item: LikelyItemView }) {
  const id = useId();
  return (
    <li aria-labelledby={id} className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <Link id={id} to={`/contacts/${encodeURIComponent(item.contactId)}`} className="inline-flex min-h-tap items-center break-words text-[17px] font-semibold text-accent hover:underline">
        {item.contactName}
      </Link>
      <p className="text-[15px] text-ink">{item.bandWords}</p>
      {item.reasons.length > 0 ? (
        <ul className="flex list-disc flex-col gap-0.5 pl-5 text-[15px] text-ink-muted" aria-label={`Why ${item.contactName} is on this list`}>
          {item.reasons.map((r, i) => (
            <li key={`${i}:${r}`}>{r}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ModelGroup({ model, items, heading }: { model: LikelyModelView | null; items: LikelyItemView[]; heading: string }) {
  const id = useId();
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-[19px] font-semibold text-ink">
        {heading}
      </h2>
      {model ? <p className="text-[15px] text-ink-muted">{model.sentence}</p> : null}
      {items.length === 0 ? (
        <p className="text-[15px] text-ink">None of your contacts has an open card from this model right now.</p>
      ) : (
        <ul className="flex flex-col" aria-label={heading}>
          {items.map((it) => (
            <Row key={`${it.modelVersion}:${it.contactId}`} item={it} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The models in the API's order, each with its rows in the API's order; a row of an unlisted model goes last. */
export function groupByModel(v: Pick<LikelyView, 'models' | 'items'>): { model: LikelyModelView | null; items: LikelyItemView[] }[] {
  const known = new Set(v.models.map((m) => m.version));
  const groups: { model: LikelyModelView | null; items: LikelyItemView[] }[] = v.models.map((m) => ({ model: m, items: v.items.filter((i) => i.modelVersion === m.version) }));
  const rest = v.items.filter((i) => !known.has(i.modelVersion));
  if (rest.length > 0) groups.push({ model: null, items: rest });
  return groups;
}

export default function LikelyPage() {
  const api = useApi();
  const q = useQuery<LikelyView, ApiError>({ queryKey: [...LIKELY_KEY], queryFn: ({ signal }) => api.get<LikelyView>('/likely', { signal }) });
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error) : null}</Notice>;
  const v = q.data;
  if (v.state === 'no_model') {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 md:mx-0">
        <Card>
          <EmptyState icon="people" title="No model is in use">
            <p>{v.sentence}</p>
          </EmptyState>
        </Card>
      </div>
    );
  }
  const groups = groupByModel(v);
  const many = groups.length > 1;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 md:mx-0">
      <p className="text-[15px] text-ink">{v.sentence}</p>
      {groups.map((g, i) => (
        <ModelGroup key={g.model?.version ?? '-'} model={g.model} items={g.items} heading={g.model === null ? 'Flagged by a model no longer listed' : many ? `Flagged by model ${i + 1} of ${groups.length}` : 'Flagged by the approved model'} />
      ))}
      {v.more ? <p className="text-[15px] text-ink-muted">Showing the first {LIMIT}.</p> : null}
    </div>
  );
}
