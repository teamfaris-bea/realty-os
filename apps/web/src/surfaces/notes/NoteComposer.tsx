// Note composer with @mention picker (PARITY_PLAN §5 "Add a note": phone Note → Save = 2 taps; desktop type
// in the always-visible box → ⌘↵ = 1; "@" + tap a name adds no tap).
//
// The box shows "@Sam Lee"; each picked member is kept aside and turned into the server's mention token
// at save, so nobody types or sees ids. The picker says who can see the person: a mention never grants
// access (R-PAR-2). After the save, the server's answer is shown as it is: "Sam can't see Jane, so they
// weren't told", with Share (adds a collaborator, audited) for those who may share. There are no private
// notes: the composer says who can read it (R-PAR-1).
import { mentionToken } from '@realty/core/parity/people';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { Button, Notice } from '../../design/index.js';
import { type Candidate, type MentionOutcome, type NoteView, firstNameOf, useCandidates } from '../people-edit/api.js';
import { textareaClass, usePersonAction, useToast } from '../people-edit/hooks.js';

interface Picked {
  userId: string;
  name: string;
}

/** The body with "@Name" of each picked member replaced by its token (the first unreplaced occurrence). */
export function withTokens(text: string, picked: readonly Picked[]): string {
  let out = text;
  for (const p of picked) {
    const at = `@${p.name}`;
    const i = out.indexOf(at);
    if (i >= 0) out = out.slice(0, i) + mentionToken(p.userId, p.name) + out.slice(i + at.length);
  }
  return out;
}

/** The word being typed after an "@" at the caret, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([\p{L}\p{N}'-]{0,30})$/u.exec(before);
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

export function NoteComposer({ contactId, contactName, canShare, autoFocus = false, onSaved, compact = false }: { contactId: string; contactName: string; canShare: boolean; autoFocus?: boolean; onSaved?: (n: NoteView) => void; compact?: boolean }) {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [q, setQ] = useState<{ start: number; query: string } | null>(null);
  const [outcomes, setOutcomes] = useState<MentionOutcome[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const listId = useId();
  const candidates = useCandidates(contactId, q !== null || picked.length > 0);
  const act = usePersonAction<{ note: NoteView; mentions: MentionOutcome[] }>(contactId);
  const share = usePersonAction(contactId);
  const toast = useToast();
  const first = firstNameOf(contactName);

  const matches = useMemo(() => {
    if (!q) return [];
    const needle = q.query.toLowerCase();
    return (candidates.data?.members ?? []).filter((m) => (m.displayName ?? '').toLowerCase().split(/\s+/).some((w) => w.startsWith(needle)) || (m.displayName ?? '').toLowerCase().startsWith(needle)).slice(0, 6);
  }, [q, candidates.data]);

  const onChange = (v: string, caret: number) => {
    setText(v);
    setQ(mentionQuery(v, caret));
  };

  const pick = (m: Candidate) => {
    if (!q) return;
    const name = m.displayName ?? 'member';
    const next = `${text.slice(0, q.start)}@${name} ${text.slice(q.start + 1 + q.query.length)}`;
    setText(next);
    setPicked((p) => (p.some((x) => x.userId === m.userId) ? p : [...p, { userId: m.userId, name }]));
    setQ(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const pos = q.start + name.length + 2;
      el.setSelectionRange(pos, pos);
    });
  };

  const save = async () => {
    const body = withTokens(text.trim(), picked.filter((p) => text.includes(`@${p.name}`)));
    if (!body) return;
    const r = await act.run('POST', `/contacts/${contactId}/notes`, { body, noteId: globalThis.crypto.randomUUID() });
    if (!r.ok) return;
    setText('');
    setPicked([]);
    const missed = r.data.mentions.filter((m) => m.status === 'no_access');
    setOutcomes(missed);
    const told = r.data.mentions.filter((m) => m.status === 'notified').map((m) => m.displayName ?? 'a teammate');
    toast({ text: told.length > 0 ? `Note saved. Told ${told.join(', ')}.` : 'Note saved' });
    onSaved?.(r.data.note);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
    if (e.key === 'Escape' && q) setQ(null);
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="sr-only" htmlFor={`${listId}-box`}>
        Note about {contactName}
      </label>
      <textarea
        id={`${listId}-box`}
        ref={ref}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={onKey}
        placeholder={`Write a note about ${first}… type @ to mention a teammate`}
        aria-describedby={hintId}
        aria-autocomplete="list"
        aria-controls={matches.length > 0 ? listId : undefined}
        className={`${textareaClass} ${compact ? 'min-h-[72px]' : ''}`}
        maxLength={20000}
      />
      {matches.length > 0 ? (
        <ul id={listId} aria-label="Mention a teammate" className="flex flex-col gap-1 rounded-xl border border-line bg-surface p-1">
          {matches.map((m) => (
            <li key={m.userId}>
              <button type="button" onClick={() => pick(m)} className="flex min-h-tap w-full items-center justify-between rounded-lg px-3 text-left text-[16px] text-ink hover:bg-surface-2">
                <span>{m.displayName ?? 'Member'}</span>
                <span className="text-[14px] text-ink-muted">{m.canSee ? `sees ${first}` : `can’t see ${first}`}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p id={hintId} className="text-[14px] text-ink-muted">
        Everyone who can see {first} can read this note.
      </p>
      <div className="flex items-center gap-2">
        <Button onClick={() => void save()} pending={act.pending} disabled={text.trim() === ''}>
          Save note
        </Button>
        <span className="hidden text-[14px] text-ink-muted md:inline">⌘↵ to save</span>
      </div>
      {act.error ? <Notice tone="error">{act.error}</Notice> : null}
      {outcomes.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Not told">
          {outcomes.map((o) => (
            <li key={o.userId} className="flex flex-wrap items-center gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[15px] text-ink">
              <span className="flex-1">
                {o.displayName ?? 'They'} can’t see {first}, so they weren’t told.
              </span>
              {canShare ? (
                <Button
                  variant="secondary"
                  pending={share.pending}
                  onClick={() =>
                    void share.run('POST', `/contacts/${contactId}/collaborators`, { userId: o.userId }).then((r) => {
                      if (!r.ok) return;
                      setOutcomes((xs) => xs.filter((x) => x.userId !== o.userId));
                      toast({ text: `${o.displayName ?? 'They'} can now see ${first}` });
                    })
                  }
                >
                  Share
                </Button>
              ) : null}
            </li>
          ))}
          {share.error ? <Notice tone="error">{share.error}</Notice> : null}
        </ul>
      ) : null}
    </div>
  );
}
