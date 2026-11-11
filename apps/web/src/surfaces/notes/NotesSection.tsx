// The person's notes: pinned first, then newest. Logged outside activity always says "Logged by <name>" and
// "not verified", at the time it happened (R-PAR-30). Mentions show the member's current name, never the
// label typed into the token. The author edits their own note; author or Owner/Admin pin; the author (or
// an Owner/Admin) deletes, with Undo-free confirmation in place because a delete is not reversible.
import { renderMentions } from '@realty/core/parity/people';
import { useState } from 'react';
import { Button, Notice } from '../../design/index.js';
import { formatDateTime } from '../feed/lib/format.js';
import { type NoteView, useNotes } from '../people-edit/api.js';
import { textareaClass, usePersonAction, useToast } from '../people-edit/hooks.js';
import { OUTCOME_LABEL } from './LogSheet.js';

const KIND_WORD: Record<string, string> = { call: 'call', text: 'text', email: 'email' };

export function loggedLine(n: Pick<NoteView, 'loggedActivity' | 'author'>): string | null {
  const a = n.loggedActivity;
  if (!a) return null;
  const what = `${a.direction === 'inbound' ? 'Inbound' : 'Outbound'} ${KIND_WORD[a.kind] ?? a.kind}`;
  const outcome = a.outcome ? ` · ${OUTCOME_LABEL[a.outcome as keyof typeof OUTCOME_LABEL] ?? a.outcome}` : '';
  return `${what}${outcome} · Logged by ${n.author?.displayName ?? 'a teammate'} · not verified`;
}

export function NoteBody({ note }: { note: NoteView }) {
  const names = new Map(note.mentions.map((m) => [m.userId, m.displayName]));
  return <p className="whitespace-pre-wrap text-[16px] text-ink [overflow-wrap:anywhere]">{renderMentions(note.body, (id) => names.get(id) ?? null)}</p>;
}

function NoteItem({ note, contactId }: { note: NoteView; contactId: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const act = usePersonAction(contactId);
  const toast = useToast();
  const logged = loggedLine(note);
  const at = note.loggedActivity?.at ?? note.createdAt;
  return (
    <li className={`flex flex-col gap-1 rounded-xl border px-3 py-2 ${note.pinned ? 'border-accent bg-accent-soft' : 'border-line bg-surface'}`}>
      <p className="text-[14px] text-ink-muted">
        {note.pinned ? <span className="font-semibold text-ink">Pinned · </span> : null}
        {logged ?? `${note.author?.displayName ?? (note.source === 'import' ? 'Imported' : 'Note')}`} · {formatDateTime(at)}
        {note.editedAt ? ' · edited' : ''}
        {note.source === 'import' ? ' · Imported' : ''}
      </p>
      {editing ? (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`edit-${note.id}`}>
            Edit note
          </label>
          <textarea id={`edit-${note.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} className={textareaClass} />
          <div className="flex gap-2">
            <Button pending={act.pending} onClick={() => void act.run('PATCH', `/notes/${note.id}`, { body: draft }).then((r) => r.ok && setEditing(false))}>
              Save
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <NoteBody note={note} />
      )}
      {!editing ? (
        <div className="flex flex-wrap gap-1">
          {note.canEdit ? (
            <Button variant="quiet" onClick={() => { setDraft(note.body); setEditing(true); }} aria-label="Edit note">
              Edit
            </Button>
          ) : null}
          {note.canPin ? (
            <Button variant="quiet" onClick={() => void act.run('POST', `/notes/${note.id}/pin`, { pinned: !note.pinned })}>
              {note.pinned ? 'Unpin' : 'Pin'}
            </Button>
          ) : null}
          {note.canDelete ? (
            confirmDelete ? (
              <>
                <Button variant="secondary" pending={act.pending} onClick={() => void act.run('DELETE', `/notes/${note.id}`).then((r) => r.ok && toast({ text: 'Note deleted' }))}>
                  Delete for good
                </Button>
                <Button variant="quiet" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button variant="quiet" onClick={() => setConfirmDelete(true)} aria-label="Delete note">
                Delete
              </Button>
            )
          ) : null}
        </div>
      ) : null}
      {act.error ? <Notice tone="error">{act.error}</Notice> : null}
    </li>
  );
}

export function NotesList({ contactId, firstName }: { contactId: string; firstName: string }) {
  const q = useNotes(contactId);
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{q.error.message}</Notice>;
  if (q.data.notes.length === 0) return <p className="text-[15px] text-ink-muted">No notes yet.</p>;
  return (
    <>
      {/* R-PAR-1: there are no private notes */}
      <p className="text-[14px] text-ink-muted md:hidden">Everyone who can see {firstName} can read these notes.</p>
      <ol className="flex flex-col gap-2" aria-label="Notes">
        {q.data.notes.map((n) => (
          <NoteItem key={n.id} note={n} contactId={contactId} />
        ))}
      </ol>
    </>
  );
}
