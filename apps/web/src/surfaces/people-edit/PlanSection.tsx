// Add task / Add appointment from the person's page (PARITY_PLAN §1: the APIs exist; no screen switch).
import { useId, useState } from 'react';
import { Button, Dialog, Notice, TextField } from '../../design/index.js';
import { firstNameOf } from './api.js';
import { selectClass, usePersonAction, useToast } from './hooks.js';

function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function tomorrowAt(h: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, 0, 0, 0);
  return d;
}

const APPT_KINDS = [
  ['buyer_consult', 'Buyer consult'],
  ['listing_appointment', 'Listing appointment'],
  ['consult', 'Consult'],
  ['other', 'Other'],
] as const;

export function PlanSection({ contactId, name }: { contactId: string; name: string }) {
  const [open, setOpen] = useState<'task' | 'appointment' | null>(null);
  const first = firstNameOf(name);
  const [title, setTitle] = useState(`Follow up with ${first}`);
  const [due, setDue] = useState(() => localInput(tomorrowAt(9)));
  const [kind, setKind] = useState<string>('consult');
  const [start, setStart] = useState(() => localInput(tomorrowAt(10)));
  const [minutes, setMinutes] = useState(60);
  const ids = { kind: useId(), len: useId(), due: useId(), start: useId() };
  const act = usePersonAction(contactId);
  const toast = useToast();
  const close = () => setOpen(null);

  const addTask = async () => {
    const r = await act.run('POST', '/tasks', { title: title.trim(), kind: 'follow_up', contactId, dueAt: new Date(due).toISOString() });
    if (r.ok) {
      toast({ text: 'Task added' });
      close();
    }
  };
  const addAppointment = async () => {
    const s = new Date(start);
    const r = await act.run('POST', '/appointments', { kind, startsAt: s.toISOString(), endsAt: new Date(s.getTime() + minutes * 60_000).toISOString(), contactId });
    if (r.ok) {
      toast({ text: 'Appointment added' });
      close();
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" icon="checklist" onClick={() => setOpen('task')}>
        Add task
      </Button>
      <Button variant="secondary" icon="calendar" onClick={() => setOpen('appointment')}>
        Add appointment
      </Button>
      {open === 'task' ? (
        <Dialog title={`Task for ${name}`} onClose={close} footer={<div className="flex flex-col gap-2"><Button block pending={act.pending} disabled={title.trim() === ''} onClick={() => void addTask()}>Add task</Button><Button block variant="secondary" onClick={close}>Cancel</Button></div>}>
          <div className="flex flex-col gap-3">
            <TextField label="What" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.due} className="text-[15px] font-medium text-ink">
                Due
              </label>
              <input id={ids.due} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={selectClass} />
            </div>
            {act.error ? <Notice tone="error">{act.error}</Notice> : null}
          </div>
        </Dialog>
      ) : null}
      {open === 'appointment' ? (
        <Dialog title={`Appointment with ${name}`} onClose={close} footer={<div className="flex flex-col gap-2"><Button block pending={act.pending} onClick={() => void addAppointment()}>Add appointment</Button><Button block variant="secondary" onClick={close}>Cancel</Button></div>}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.kind} className="text-[15px] font-medium text-ink">
                Kind
              </label>
              <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value)} className={selectClass}>
                {APPT_KINDS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.start} className="text-[15px] font-medium text-ink">
                Starts
              </label>
              <input id={ids.start} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={selectClass} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.len} className="text-[15px] font-medium text-ink">
                Length
              </label>
              <select id={ids.len} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={selectClass}>
                {[30, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </select>
            </div>
            {act.error ? <Notice tone="error">{act.error}</Notice> : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
