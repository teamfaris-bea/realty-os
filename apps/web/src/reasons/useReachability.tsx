// Who can be texted, emailed or called before anyone taps (GET /contacts/:id/reachability), and the
// feed's cards at once (GET /reachability?contactIds=…, one request for the whole page).
//
// This replaces the old stand-in preview (POST …/messages/preview with the text "Hi" only to learn
// whether a channel was blocked). The summary never decides a send: the send-time check does, with
// the real text. While the summary is loading or failed, nothing is disabled (honest: we don't know).
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, createContext, useContext, useMemo } from 'react';
import { type ApiError, useApi } from '../shell/index.js';
import { reachSentence } from './sentences.js';
import type { ChannelReach, ReachChannel, Reachability } from './types.js';

export const REACHABILITY_KEY = ['reachability'] as const;

interface Batch {
  ids: ReadonlySet<string>;
  byId: ReadonlyMap<string, Reachability>;
  pending: boolean;
}
const BatchCtx = createContext<Batch | null>(null);

/** Loads the summaries of every contact on a page in one request; useReachability reads from it. */
export function ReachabilityBatch({ contactIds, children }: { contactIds: readonly string[]; children: ReactNode }) {
  const api = useApi();
  const ids = useMemo(() => [...new Set(contactIds)].sort().slice(0, 50), [contactIds]);
  const q = useQuery<{ reachability: Reachability[] }, ApiError>({
    queryKey: [...REACHABILITY_KEY, 'batch', ids.join(',')],
    queryFn: ({ signal }) => api.get<{ reachability: Reachability[] }>(`/reachability?contactIds=${ids.join(',')}`, { signal }),
    enabled: ids.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const pending = ids.length > 0 && q.isPending;
  const value = useMemo<Batch>(() => ({ ids: new Set(ids), byId: new Map((q.data?.reachability ?? []).map((r) => [r.contactId, r])), pending }), [ids, q.data, pending]);
  return <BatchCtx.Provider value={value}>{children}</BatchCtx.Provider>;
}

/**
 * The summary for one contact (null while unknown: loading, failed, not visible) and whether it is still loading, so a
 * box can wait instead of saying something it then takes back (finding UXA-8). `refetchMs`: ask again on that
 * interval (the thread, while a web chat is live: a chat that ends is then said by the summary too).
 */
export function useReachabilityQuery(contactId: string | null | undefined, o: { refetchMs?: number | undefined } = {}): { summary: Reachability | null; pending: boolean } {
  const api = useApi();
  const batch = useContext(BatchCtx);
  const inBatch = !!contactId && batch !== null && batch.ids.has(contactId);
  const enabled = !!contactId && !inBatch;
  const q = useQuery<{ reachability: Reachability }, ApiError>({
    queryKey: [...REACHABILITY_KEY, contactId],
    queryFn: ({ signal }) => api.get<{ reachability: Reachability }>(`/contacts/${contactId}/reachability`, { signal }),
    enabled,
    staleTime: 15_000,
    retry: false,
    refetchInterval: o.refetchMs ?? false,
  });
  if (!contactId) return { summary: null, pending: false };
  if (inBatch) return { summary: batch.byId.get(contactId) ?? null, pending: batch.pending };
  return { summary: q.data?.reachability ?? null, pending: enabled && q.isPending };
}

/** The summary for one contact, or null while unknown (loading, failed, not visible). */
export function useReachability(contactId: string | null | undefined): Reachability | null {
  return useReachabilityQuery(contactId).summary;
}

export interface ChannelState {
  /** a send or call on this channel would be blocked whatever it says */
  blocked: boolean;
  /** the sentence to show next to the action ("Texted STOP on Nov 10"); null when nothing to say */
  sentence: string | null;
  /** an opt-out that does not block this send but is still true (a marketing-only unsubscribe on a reply) */
  note: string | null;
}

const NONE: ChannelState = { blocked: false, sentence: null, note: null };

export function channelState(r: Reachability | null, ch: ReachChannel): ChannelState {
  if (!r) return NONE;
  const c: ChannelReach = r.channels[ch];
  if (c.blocked && c.reasons[0]) return { blocked: true, sentence: reachSentence(c.reasons[0], ch), note: null };
  const def = c.points.find((p) => p.pointId === c.defaultPointId);
  const other = def?.reasons[0];
  return other ? { blocked: false, sentence: null, note: reachSentence(other, ch) } : NONE;
}

/** Shorthand: the summary and the state of one channel. */
export function useChannelState(contactId: string | null | undefined, ch: ReachChannel | null): ChannelState {
  const r = useReachability(contactId);
  return ch ? channelState(r, ch) : NONE;
}
