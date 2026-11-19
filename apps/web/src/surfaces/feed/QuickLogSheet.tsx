// The sheets behind the header's "Log a call or conversation" (feed/QuickLog.tsx; R-TODAY-9): pick the person, then
// the person page's own Log sheet.
//
// The picker is the app's two existing reads, nothing new on the server:
//   - before anything is typed: the people the viewer can see, most recent activity first (GET /people, the People
//     page's own list and order);
//   - from two letters: the app's search (GET /search), contacts only. Someone the viewer sees only as a pond or offer
//     card cannot be logged on, so they are not offered.
// Loading, nobody yet, nobody matching and a failed read are each said in plain words (R-TODAY-8).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { LogSheet } from '../notes/LogSheet.js';
import { AGENT_ERROR_MESSAGES } from './lib/messages.js';
import type { SearchResponse } from './lib/types.js';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;
const SHOWN = 8;

interface Who {
  id: string;
  name: string;
}

export default function QuickLogSheet({ title, onClose }: { /** the entry's own name: the picker is titled by it */ title: string; onClose: () => void }) {
  const [who, setWho] = useState<Who | null>(null);
  const qc = useQueryClient();
  if (who) {
    return (
      <LogSheet
        contactId={who.id}
        contactName={who.name}
        // one pass: the follow-up the outcome suggests is preselected, and the closing toast says the whole result
        onePass={{}}
        onClose={() => {
          // Today's card for this person (their last touch, their next step) is read again when the agent returns to it
          void qc.invalidateQueries({ queryKey: ['feed'] });
          onClose();
        }}
      />
    );
  }
  return <PersonPicker title={title} onPick={setWho} onClose={onClose} />;
}

function PersonPicker({ title, onPick, onClose }: { title: string; onPick: (w: Who) => void; onClose: () => void }) {
  const api = useApi();
  const id = useId();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  const searching = q.length >= MIN_QUERY;
  const recent = useQuery<{ people: { id: string; displayName: string }[] }, ApiError>({
    queryKey: ['quick-log', 'recent'],
    queryFn: ({ signal }) => api.get('/people?sort=last_activity_desc', { signal }),
    staleTime: 30_000,
  });
  const found = useQuery<SearchResponse, ApiError>({
    queryKey: ['search', q],
    queryFn: ({ signal }) => api.get<SearchResponse>(`/search?q=${encodeURIComponent(q)}`, { signal }),
    enabled: searching,
    staleTime: 15_000,
  });
  const active = searching ? found : recent;
  const people: Who[] = searching
    ? (found.data?.contacts ?? []).filter((c) => c.view === 'full').map((c) => ({ id: c.id, name: c.name }))
    : (recent.data?.people ?? []).slice(0, SHOWN).map((p) => ({ id: p.id, name: p.displayName }));
  return (
    <Dialog title={title} description="Something that happened outside Realty OS: a call from your own phone, a text, an email." onClose={onClose} closeButton>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-q`} className="text-[15px] font-medium text-ink">
            Who was it with?
          </label>
          <input
            id={`${id}-q`}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Name, phone or email"
            autoComplete="off"
            className="min-h-tap w-full rounded-xl border border-line bg-surface px-3 text-[17px] text-ink placeholder:text-ink-muted"
          />
        </div>
        <p id={`${id}-h`} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
          {searching ? 'People found' : 'Recent people'}
        </p>
        {active.isPending ? (
          <p role="status" className="text-[15px] text-ink-muted">
            Loading
          </p>
        ) : active.isError ? (
          <Notice tone="error" title={searching ? "Can't search right now" : "Can't load your people"} action={<Button variant="secondary" onClick={() => void active.refetch()}>Try again</Button>}>
            {messageFor(active.error, AGENT_ERROR_MESSAGES)}
          </Notice>
        ) : people.length === 0 ? (
          <p className="text-[15px] text-ink-muted [overflow-wrap:anywhere]">{searching ? `Nobody you can see matches “${q}”.` : 'No people yet. Add a person first, then log what happened.'}</p>
        ) : (
          <ul aria-labelledby={`${id}-h`} className="flex flex-col gap-1">
            {people.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-label={`Log for ${p.name}`}
                  onClick={() => onPick(p)}
                  className="flex min-h-tap w-full items-center rounded-xl border border-line bg-surface px-3 text-left text-[16px] font-medium text-ink [overflow-wrap:anywhere] hover:bg-surface-2"
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
