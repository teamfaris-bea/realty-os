// Duplicates (PARITY_PLAN module 66, §5 "Resolve a duplicate": Duplicates → pair → Merge = 3 taps).
//
// The list shows open suggestions whose two people the viewer can see ("Showing people you can see").
// The pair page puts both records side by side, says in plain words what the merge moves and that every
// opt-out stays, and offers Merge (the existing POST /leads/:id/merge, so the ownership engine decides)
// and "Not the same person" (dismiss, with Undo instead of a confirm modal: it is reversible).
// A merge is not reversible, so the page shows everything before the tap instead of a dialog after it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, EmptyState, Notice, announce, useStickyBottom } from '../../design/index.js';
import { type ApiError, messageFor, newCommandId, useApi } from '../../shell/index.js';
import { DUPLICATES_KEY, DUPLICATES_MESSAGES, type DupPair, type DupSide, type DuplicatesResponse, STAGE_LABEL, movesSentence, optOutSentence, sidesOf } from './lib.js';

function SideSummary({ side, role }: { side: DupSide; role: 'keep' | 'merge' }) {
  const hid = useId();
  return (
    <Card as="article" aria-labelledby={hid} className="flex flex-col gap-1.5">
      <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">{role === 'keep' ? 'Keep' : 'Merge into the kept record'}</p>
      <h2 id={hid} className="text-[19px] font-semibold text-ink">
        <Link to={`/contacts/${side.id}`} className="inline-flex min-h-tap items-center hover:underline">
          {side.displayName}
        </Link>
      </h2>
      <p className="text-[15px] text-ink-muted">
        {[STAGE_LABEL[side.stage] ?? side.stage, side.owner ? `Owner: ${side.owner.displayName ?? 'a teammate'}` : 'No owner', side.source ? `From ${side.source}` : null, `Added ${new Date(side.createdAt).toLocaleDateString()}`]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {side.doNotContact ? <p className="text-[15px] font-semibold text-danger">Do not contact</p> : null}
      <ul className="flex flex-col gap-0.5 text-[15px] text-ink" aria-label={`${side.displayName}'s phones and emails`}>
        {[...side.phones, ...side.emails].map((p) => (
          <li key={`${p.kind}:${p.address}`} className="break-all">
            {p.address} <span className="text-ink-muted">({p.label})</span>
          </li>
        ))}
        {side.phones.length + side.emails.length === 0 ? <li className="text-ink-muted">No phone or email</li> : null}
      </ul>
      <p className="text-[14px] text-ink-muted">
        {side.counts.notes} notes · {side.counts.tags} tags · {side.counts.fieldValues} custom fields
      </p>
    </Card>
  );
}

function PairCard({ pair }: { pair: DupPair }) {
  const { keep, merge } = sidesOf(pair);
  const hid = useId();
  return (
    <Card as="article" aria-labelledby={hid} className="flex h-full flex-col gap-2">
      <h2 id={hid} className="text-[17px] font-semibold text-ink">
        {keep.displayName} <span className="text-ink-muted">and</span> {merge.displayName}
      </h2>
      <p className="text-[15px] text-ink-muted">{pair.reasonText}</p>
      <div className="mt-auto">
        <Link to={`/duplicates/${pair.id}`} className="inline-flex min-h-tap items-center font-semibold text-accent hover:underline" aria-label={`Review ${keep.displayName} and ${merge.displayName}`}>
          Review
        </Link>
      </div>
    </Card>
  );
}

export function DuplicatesPage() {
  const api = useApi();
  const location = useLocation();
  const undo = (location.state as { dismissed?: { id: string; names: string } } | null)?.dismissed ?? null;
  const qc = useQueryClient();
  const [undone, setUndone] = useState<string | null>(null);
  const q = useQuery<DuplicatesResponse, ApiError>({
    queryKey: [...DUPLICATES_KEY, 'list'],
    queryFn: ({ signal }) => api.get<DuplicatesResponse>('/duplicates?limit=50', { signal }),
  });
  const restore = async (id: string) => {
    await api.post(`/duplicates/${id}/restore`, {});
    setUndone(id);
    announce('Brought back');
    await qc.invalidateQueries({ queryKey: [...DUPLICATES_KEY] });
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[15px] text-ink-muted">Possible duplicates among the people you can see. Nothing is merged until you choose Merge.</p>
      {undo && undone !== undo.id ? (
        <Notice tone="ok" action={<Button variant="quiet" onClick={() => void restore(undo.id)}>Undo</Button>}>
          Marked {undo.names} as different people.
        </Notice>
      ) : null}
      {q.isPending ? <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, DUPLICATES_MESSAGES)}</Notice> : null}
      {q.data && q.data.duplicates.length === 0 ? (
        <EmptyState icon="people" title="No possible duplicates">
          When two records look like the same person (same phone, same email or a very similar name), they show up here.
        </EmptyState>
      ) : null}
      {q.data && q.data.duplicates.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {q.data.duplicates.map((p) => (
            <li key={p.id}>
              <PairCard pair={p} />
            </li>
          ))}
        </ul>
      ) : null}
      {q.data?.nextCursor ? <p className="text-[14px] text-ink-muted">Showing the newest 50. Resolve these to see more.</p> : null}
    </div>
  );
}

export function DuplicatePage() {
  const { duplicateId = '' } = useParams();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [survivorId, setSurvivorId] = useState<string | null>(null);
  const [ownerChoice, setOwnerChoice] = useState<string | null>(null);
  const [pending, setPending] = useState<'merge' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ownerLegend = useId();
  const bar = useStickyBottom<HTMLDivElement>();
  const q = useQuery<{ duplicate: DupPair }, ApiError>({
    queryKey: [...DUPLICATES_KEY, 'one', duplicateId],
    queryFn: ({ signal }) => api.get<{ duplicate: DupPair }>(`/duplicates/${duplicateId}`, { signal }),
  });
  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="error">{messageFor(q.error, DUPLICATES_MESSAGES)}</Notice>
        <Link to="/duplicates" className="inline-flex min-h-tap items-center font-semibold text-accent">
          Back to duplicates
        </Link>
      </div>
    );
  }
  const pair = q.data.duplicate;
  const { keep, merge } = sidesOf(pair, survivorId ?? pair.suggestedSurvivorId);
  const chosenOwner = pair.owner.rule === 'choose' ? (ownerChoice ?? pair.owner.preselectedUserId) : null;
  const decided = pair.status !== 'open';

  const doMerge = async () => {
    setPending('merge');
    setError(null);
    try {
      await api.post(`/leads/${keep.id}/merge`, { commandId: newCommandId(), loserId: merge.id, ...(chosenOwner ? { ownerChoice: chosenOwner } : {}) });
      announce(`Merged into ${keep.displayName}`);
      await qc.invalidateQueries({ queryKey: [...DUPLICATES_KEY] });
      navigate(`/contacts/${keep.id}`);
    } catch (e) {
      setError(messageFor(e as ApiError, DUPLICATES_MESSAGES));
      await qc.invalidateQueries({ queryKey: [...DUPLICATES_KEY] });
    } finally {
      setPending(null);
    }
  };
  const doDismiss = async () => {
    setPending('dismiss');
    setError(null);
    try {
      await api.post(`/duplicates/${pair.id}/dismiss`, {});
      announce('Marked as different people');
      await qc.invalidateQueries({ queryKey: [...DUPLICATES_KEY] });
      navigate('/duplicates', { state: { dismissed: { id: pair.id, names: `${keep.displayName} and ${merge.displayName}` } } });
    } catch (e) {
      setError(messageFor(e as ApiError, DUPLICATES_MESSAGES));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-4 pb-24 md:pb-0">
      <p className="text-[15px] text-ink">{pair.reasonText}</p>
      {decided ? <Notice tone="info">{pair.status === 'merged' ? 'These two were merged.' : 'These were marked as different people.'}</Notice> : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SideSummary side={keep} role="keep" />
        <SideSummary side={merge} role="merge" />
      </div>
      <div>
        <Button variant="secondary" onClick={() => setSurvivorId(merge.id)} disabled={pending !== null}>
          Keep {merge.displayName === keep.displayName ? 'the other record' : merge.displayName} instead
        </Button>
      </div>
      <Notice tone="info">{movesSentence(merge)}</Notice>
      <Notice tone="warn">{optOutSentence(pair)}</Notice>
      {pair.owner.rule === 'choose' && pair.canMerge ? (
        <fieldset className="flex flex-col gap-1" aria-labelledby={ownerLegend}>
          <legend id={ownerLegend} className="text-[15px] font-semibold text-ink">
            They belong to different agents. Who keeps the merged person?
          </legend>
          {pair.owner.options.map((o) => (
            <label key={o.userId} className="flex min-h-tap items-center gap-3 text-[17px]">
              <input type="radio" name="owner" className="h-5 w-5" checked={chosenOwner === o.userId} onChange={() => setOwnerChoice(o.userId)} />
              {o.displayName ?? 'A teammate'}
            </label>
          ))}
          <p className="text-[14px] text-ink-muted">The other agent is told the person moved to the new owner.</p>
        </fieldset>
      ) : null}
      {!pair.canMerge && !decided ? (
        <Notice tone="info">{pair.owner.rule === 'choose' ? 'These belong to different agents, so a Team Lead or Admin merges them.' : 'You can’t merge these. A Team Lead or Admin can.'}</Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!decided ? (
        <div ref={bar} data-sticky className="sticky bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] -mx-4 flex flex-col gap-2 border-t border-line bg-canvas/95 px-4 py-3 md:static md:mx-0 md:flex-row md:border-0 md:bg-transparent md:px-0 [@media(max-height:559.98px)]:static">
          {pair.canMerge ? (
            <Button onClick={() => void doMerge()} pending={pending === 'merge'} pendingLabel="Merging" disabled={pending === 'dismiss'} block>
              Merge into {keep.displayName}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => void doDismiss()} pending={pending === 'dismiss'} pendingLabel="Saving" disabled={pending === 'merge'} block>
            Not the same person
          </Button>
        </div>
      ) : null}
    </div>
  );
}
