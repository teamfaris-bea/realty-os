// Add a task from the contact page (phone first). Kind, due, assignee (defaults to me) and a note,
// through POST /tasks. A promise is a kind the data model already stores. Opening the sheet, picking
// Promise and tapping Add is three taps; typing the title is not a tap.
import { type FormEvent, useId, useRef, useState } from 'react';
import { Button, Dialog, Notice, TextField } from '../../design/index.js';
import { useSession } from '../../shell/index.js';
import { useAgentSheets } from '../feed/lib/AgentSheets.js';
import { useMutate } from '../feed/lib/hooks.js';
import type { TaskView } from '../feed/lib/types.js';
import { useFilterOptions } from '../people/api.js';

export const TASK_KIND_CHOICES = [
  { kind: 'todo', label: 'To-do' },
  { kind: 'callback', label: 'Call back' },
  { kind: 'follow_up', label: 'Follow-up' },
  { kind: 'promise', label: 'Promise' },
] as const;

export type AddTaskKind = (typeof TASK_KIND_CHOICES)[number]['kind'];

const fieldClass = 'min-h-tap w-full rounded-xl border border-line bg-surface px-3 text-[17px] text-ink';

export function AddTaskButton({ contactId, contactName }: { contactId: string; contactName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Add a task
      </Button>
      {open ? <AddTaskSheet contactId={contactId} contactName={contactName} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function AddTaskSheet({ contactId, contactName, onClose }: { contactId: string; contactName: string; onClose: () => void }) {
  const { announce } = useAgentSheets();
  const { session } = useSession();
  const titleRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [kind, setKind] = useState<AddTaskKind>('todo');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [assignee, setAssignee] = useState('');
  const [notes, setNotes] = useState('');
  const members = useFilterOptions(true);
  const me = session?.user.id ?? null;
  const others = (members.data?.members ?? []).filter((m) => m.active && m.userId !== me);
  const m = useMutate<Record<string, unknown>, { task: TaskView }>('POST', { invalidate: [['tasks'], ['feed'], ['timeline', contactId]] });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const at = due ? new Date(due) : null;
    if (at && Number.isNaN(at.getTime())) return;
    const r = await m.run('/tasks', {
      title: t,
      kind,
      contactId,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(at ? { dueAt: at.toISOString() } : {}),
      ...(assignee ? { assigneeUserId: assignee } : {}),
    });
    if (r.ok) {
      announce(kind === 'promise' ? `Promise saved: ${t}` : `Task saved: ${t}`);
      onClose();
    }
  };

  return (
    <Dialog
      title={`Add a task for ${contactName}`}
      onClose={onClose}
      initialFocus={titleRef}
      closeButton
      footer={
        <div className="flex flex-col gap-2">
          {m.error ? <Notice tone="error">{m.error.message}</Notice> : null}
          <Button type="submit" form={formId} block pending={m.pending} disabled={title.trim().length === 0}>
            Add
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Kind" className="flex flex-wrap gap-2">
          {TASK_KIND_CHOICES.map((k) => (
            <label key={k.kind} className={`inline-flex min-h-tap cursor-pointer items-center rounded-full border px-4 text-[15px] font-medium ${kind === k.kind ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface text-ink'}`}>
              <input type="radio" name={`${formId}-kind`} value={k.kind} checked={kind === k.kind} onChange={() => setKind(k.kind)} className="sr-only" />
              {k.label}
            </label>
          ))}
        </div>
        {kind === 'promise' ? <p className="text-[14px] text-ink-muted">Something you told them you would do. It shows on Promises, and turns red once it is past due.</p> : null}
        <TextField ref={titleRef} label="What" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} autoComplete="off" />
        <label className="flex flex-col gap-1.5 text-[15px] font-medium text-ink">
          Due
          <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1.5 text-[15px] font-medium text-ink">
          Assign to
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={fieldClass}>
            <option value="">Me</option>
            {others.map((person) => (
              <option key={person.userId} value={person.userId}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[15px] font-medium text-ink">
          Note
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} rows={3} className="min-h-[96px] w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink" />
        </label>
      </form>
    </Dialog>
  );
}
