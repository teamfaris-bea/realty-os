// Coaching settings (module 41; module 36's API; R-COACH-1, R-COACH-3, R-INT-6, D-COACH, E283). The Owner and
// Admins open it; the Owner changes everything here, and an Admin can only turn call reviews off (owner decision
// 2026-11-11, the Gmail sync rule; the API and the database refuse an Admin anything else).
//
//   - "Not reviewed by counsel" while the platform:coaching pack is unreviewed: call reviews cannot be
//     turned on, and the page says why (the database refuses it too);
//   - call reviews on/off (on asks for the Owner's password again: re-auth; an Admin's switch only turns them off,
//     and says "Only the Owner can turn call reviews on." while they are off);
//   - whether Team Leads see their team's call reviews and tips (off by default; on asks for re-auth);
//   - which checklist items are used (at least one).
// For an Admin, Team Lead visibility and the checklist are read-only, each with a sentence that says so.
// Each switch is one tap (plus the password when it widens who is reviewed or who sees reviews).
// VERIFY WITH COUNSEL: recording and employee-monitoring law (counsel item C11); nothing here is legal advice.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Button, Card, Notice } from '../../../design/index.js';
import { type ApiError, messageFor, useApi, useSession, useWithReauth } from '../../../shell/index.js';
import type { CoachingSettingsView } from '../../coaching/types.js';

export const COACHING_SETTINGS_KEY = ['admin', 'coaching'] as const;

const MESSAGES: Record<string, string> = {
  COACHING_NOT_CLEARED: 'Call reviews cannot be turned on until counsel has reviewed them.',
  OWNER_REQUIRED: 'Only the Owner can do that. An Admin can only turn call reviews off.',
};

type Body = { scoringEnabled: boolean; tlSeesCallScores: boolean; disabledKeys: string[] };

export default function CoachingSettingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const id = useId();
  const withReauth = useWithReauth();
  const { session } = useSession();
  // anyone but the Owner (an Admin: the page's other role) sees the Owner's settings read-only, and may turn reviews off
  const owner = session?.tenant?.role === 'owner';
  const [pending, setPending] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ at: string; tone: 'ok' | 'error'; text: string } | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  // where an Admin's focus goes once their switch has turned reviews off (that switch is then disabled)
  const scoringHeading = useRef<HTMLHeadingElement>(null);
  const q = useQuery<{ settings: CoachingSettingsView }, ApiError>({ queryKey: [...COACHING_SETTINGS_KEY], queryFn: ({ signal }) => api.get<{ settings: CoachingSettingsView }>('/admin/coaching', { signal }) });

  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error, MESSAGES) : null}</Notice>;
  const v = q.data.settings;
  const current: Body = { scoringEnabled: v.scoringEnabled, tlSeesCallScores: v.tlSeesCallScores, disabledKeys: v.rubric.filter((r) => !r.enabled).map((r) => r.key) };
  const disabled = draft ?? current.disabledKeys;

  const save = async (what: string, next: Body, done: string) => {
    setPending(what);
    setMsg(null);
    try {
      const r = await withReauth(() => api.request<{ settings: CoachingSettingsView }>('PUT', '/admin/coaching', next));
      qc.setQueryData([...COACHING_SETTINGS_KEY], r);
      void qc.invalidateQueries({ queryKey: ['coaching'] });
      // a switch keeps unsaved checklist edits; only saving the checklist clears them
      if (what === 'items') setDraft(null);
      setMsg({ at: what, tone: 'ok', text: done });
      if (!owner && what === 'scoring') scoringHeading.current?.focus();
    } catch (e) {
      // an Admin's request was refused: the Owner may have changed the settings since the page loaded, so load them again
      if (!owner) void qc.invalidateQueries({ queryKey: [...COACHING_SETTINGS_KEY] });
      setMsg({ at: what, tone: 'error', text: messageFor(e as ApiError, MESSAGES) });
    } finally {
      setPending(null);
    }
  };

  const toggleItem = (key: string, on: boolean) => setDraft(on ? disabled.filter((k) => k !== key) : [...new Set([...disabled, key])]);
  const itemsChanged = draft !== null && [...draft].sort().join(',') !== [...current.disabledKeys].sort().join(',');
  const noneLeft = disabled.length >= v.rubric.length;
  // an Admin's "on" switch is the Owner's: disabled, and it says so (with the counsel reason too while that applies)
  const onDescribedBy = owner ? (v.pack.cleared ? undefined : `${id}-why`) : v.pack.cleared ? `${id}-owner` : `${id}-owner ${id}-why`;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 md:mx-0">
      {v.pack.cleared ? null : (
        <Notice tone="warn" title="Not reviewed by counsel">
          {v.pack.sentence}
        </Notice>
      )}
      <Card aria-labelledby={`${id}-scoring`} className="flex flex-col gap-2">
        <h2 id={`${id}-scoring`} ref={scoringHeading} tabIndex={owner ? undefined : -1} className="text-[19px] font-semibold text-ink">
          Call reviews are {v.scoringEnabled ? (v.pack.cleared ? 'on' : 'paused') : 'off'}
        </h2>
        <p className="text-[15px] text-ink">{v.scoringSentence}</p>
        <p className="text-[14px] text-ink-muted">Only calls a person handled are reviewed, never calls the assistant answered or imported recordings. Agents see one tip a day; nobody is graded or ranked.</p>
        {v.scoringEnabled ? (
          <Button variant="danger" className="self-start" aria-describedby={owner ? undefined : `${id}-owner`} pending={pending === 'scoring'} pendingLabel="Turning off" onClick={() => void save('scoring', { ...current, scoringEnabled: false }, 'Call reviews are off. Today’s tips are gone.')}>
            Turn call reviews off
          </Button>
        ) : (
          <Button className="self-start" disabled={!owner || !v.pack.cleared} aria-describedby={onDescribedBy} pending={pending === 'scoring'} pendingLabel="Turning on" onClick={() => void save('scoring', { ...current, scoringEnabled: true }, 'Call reviews are on. Tips appear once an agent has 3 reviewed calls.')}>
            Turn call reviews on
          </Button>
        )}
        {owner ? null : (
          <p id={`${id}-owner`} className="text-[14px] text-ink-muted">
            {v.scoringEnabled ? 'Only the Owner can turn them on again.' : 'Only the Owner can turn call reviews on.'}
          </p>
        )}
        {v.pack.cleared ? null : (
          <p id={`${id}-why`} className="text-[14px] text-ink-muted">
            Waiting for counsel review.
          </p>
        )}
        {msg?.at === 'scoring' ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      </Card>

      <Card aria-labelledby={`${id}-tl`} className="flex flex-col gap-2">
        <h2 id={`${id}-tl`} className="text-[19px] font-semibold text-ink">
          Team Leads {v.tlSeesCallScores ? 'see' : 'do not see'} their team’s reviews
        </h2>
        <p className="text-[15px] text-ink">
          {v.tlSeesCallScores
            ? 'A Team Lead sees the call reviews and tips of the agents on their team, for calls they may play.'
            : owner
              ? 'Each agent’s reviews and tips are private to them, you and your Admins.'
              : 'Each agent’s reviews and tips are private to them, the Owner and Admins.'}
        </p>
        {owner ? (
          <Button
            variant={v.tlSeesCallScores ? 'secondary' : 'primary'}
            className="self-start"
            pending={pending === 'tl'}
            pendingLabel="Saving"
            onClick={() => void save('tl', { ...current, tlSeesCallScores: !v.tlSeesCallScores }, v.tlSeesCallScores ? 'Team Leads no longer see their team’s reviews.' : 'Team Leads now see their team’s reviews.')}
          >
            {v.tlSeesCallScores ? 'Stop sharing with Team Leads' : 'Let Team Leads see them'}
          </Button>
        ) : (
          <p className="text-[14px] text-ink-muted">Only the Owner can change whether Team Leads see call reviews.</p>
        )}
        {msg?.at === 'tl' ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      </Card>

      <Card aria-labelledby={`${id}-items`} className="flex flex-col gap-2">
        <h2 id={`${id}-items`} className="text-[19px] font-semibold text-ink">
          What calls are checked for
        </h2>
        <fieldset className="flex flex-col gap-1" aria-describedby={owner ? undefined : `${id}-items-owner`}>
          <legend className="sr-only">Checklist items</legend>
          {v.rubric.map((r) => {
            const on = !disabled.includes(r.key);
            return (
              <label key={r.key} className="flex min-h-tap items-start gap-3 py-1">
                <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={on} disabled={!owner} onChange={(e) => toggleItem(r.key, e.target.checked)} aria-labelledby={`${id}-${r.key}-l`} aria-describedby={`${id}-${r.key}`} />
                <span className="flex flex-col">
                  <span id={`${id}-${r.key}-l`} className="text-[16px] font-medium text-ink">
                    {r.label}
                  </span>
                  <span id={`${id}-${r.key}`} className="text-[14px] text-ink-muted">
                    {r.good}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        {owner ? (
          <>
            {noneLeft ? <p className="text-[14px] text-danger">Keep at least one item.</p> : null}
            <Button className="self-start" disabled={!itemsChanged || noneLeft} pending={pending === 'items'} pendingLabel="Saving" onClick={() => void save('items', { ...current, disabledKeys: disabled }, 'Checklist saved.')}>
              Save checklist
            </Button>
          </>
        ) : (
          <p id={`${id}-items-owner`} className="text-[14px] text-ink-muted">
            Only the Owner can change what calls are checked for.
          </p>
        )}
        {msg?.at === 'items' ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      </Card>
      <p className="text-[14px] text-ink-muted">This page is not legal advice. Confirm recording and employee-monitoring rules for your state with your counsel.</p>
    </div>
  );
}
