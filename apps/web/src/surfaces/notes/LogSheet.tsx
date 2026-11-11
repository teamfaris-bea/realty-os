// Log an outside call, text or email (PARITY_PLAN §5: Log (Call preselected) → outcome → Save = 3 taps).
// It is a note, never a call or message record and never a touch (R-PAR-30, R-PAR-32): the sheet says so.
// "Remind me in N days" makes an ordinary task. If the note reads like "they asked not to be contacted",
// the sheet asks, and offers the real person-level do-not-contact: a note alone never blocks anything (E193).
import { ACTIVITY_MAX_AHEAD_MS, CALL_OUTCOMES, suggestsDoNotContact } from '@realty/core/parity/people';
import { useId, useState } from 'react';
import { Button, Dialog, Notice } from '../../design/index.js';
import { firstNameOf } from '../people-edit/api.js';
import { Chip, selectClass, textareaClass, usePersonAction, useToast } from '../people-edit/hooks.js';

const KINDS = [
  { key: 'call', label: 'Call' },
  { key: 'text', label: 'Text' },
  { key: 'email', label: 'Email' },
] as const;
export const OUTCOME_LABEL: Record<(typeof CALL_OUTCOMES)[number], string> = { connected: 'Talked', left_voicemail: 'Left voicemail', no_answer: 'No answer', wrong_number: 'Wrong number', other: 'Other' };
const REMIND = [0, 1, 2, 3, 7, 14, 30];

function localInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function LogSheet({ contactId, contactName, onClose }: { contactId: string; contactName: string; onClose: () => void }) {
  const [kind, setKind] = useState<'call' | 'text' | 'email'>('call');
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const [outcome, setOutcome] = useState<(typeof CALL_OUTCOMES)[number] | null>(null);
  const [when, setWhen] = useState(() => localInputValue(new Date()));
  const [body, setBody] = useState('');
  const [remind, setRemind] = useState(0);
  const [askDnc, setAskDnc] = useState(false);
  const act = usePersonAction<{ suggestDoNotContact: boolean; taskId: string | null }>(contactId);
  const dnc = usePersonAction<{ alreadySet: boolean }>(contactId);
  const toast = useToast();
  const first = firstNameOf(contactName);
  const ids = { when: useId(), body: useId(), remind: useId(), note: useId() };
  const at = new Date(when);
  const future = Number.isFinite(at.getTime()) && at.getTime() > Date.now() + ACTIVITY_MAX_AHEAD_MS;

  const save = async () => {
    const r = await act.run('POST', `/contacts/${contactId}/activities`, {
      kind,
      direction,
      at: at.toISOString(),
      ...(kind === 'call' && outcome ? { outcome } : {}),
      ...(body.trim() ? { body: body.trim() } : {}),
      ...(remind > 0 ? { remindInDays: remind } : {}),
      noteId: globalThis.crypto.randomUUID(),
    });
    if (!r.ok) return;
    if (r.data.suggestDoNotContact) {
      setAskDnc(true);
      return;
    }
    toast({ text: `${KINDS.find((k) => k.key === kind)!.label} logged${r.data.taskId ? `, reminder in ${remind} day${remind === 1 ? '' : 's'}` : ''}` });
    onClose();
  };

  const recordDnc = async () => {
    const r = await dnc.run('POST', `/contacts/${contactId}/do-not-contact`, { reason: kind === 'call' ? 'asked_on_call' : 'asked_in_writing' });
    if (!r.ok) return;
    toast({ text: `Recorded: do not contact ${first}` });
    onClose();
  };

  if (askDnc) {
    return (
      <Dialog
        title={`Did ${first} ask not to be contacted?`}
        description="Your note was saved. A note alone doesn’t stop anything from being sent."
        onClose={onClose}
        footer={
          <div className="flex flex-col gap-2">
            <Button block onClick={() => void recordDnc()} pending={dnc.pending}>
              Yes, record do not contact
            </Button>
            <Button block variant="secondary" onClick={onClose}>
              No
            </Button>
          </div>
        }
      >
        <p className="text-[15px] text-ink">Recording it stops every text, email and call to {first} from anyone on the team. Only {first} can undo it.</p>
        {dnc.error ? <Notice tone="error">{dnc.error}</Notice> : null}
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Log for ${contactName}`}
      description={`Something that happened outside Realty OS. It shows as logged by you and doesn’t count as reaching ${first}.`}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          <Button block onClick={() => void save()} pending={act.pending} disabled={future}>
            Save
          </Button>
          <Button block variant="quiet" onClick={() => setAskDnc(true)}>
            They asked not to be contacted…
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div role="group" aria-label="What happened" className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <Chip key={k.key} selected={kind === k.key} onClick={() => setKind(k.key)}>
              {k.label}
            </Chip>
          ))}
        </div>
        <div role="group" aria-label="Direction" className="flex flex-wrap gap-2">
          <Chip selected={direction === 'outbound'} onClick={() => setDirection('outbound')}>
            {kind === 'call' ? 'I called' : 'I sent'}
          </Chip>
          <Chip selected={direction === 'inbound'} onClick={() => setDirection('inbound')}>
            {kind === 'call' ? `${first} called` : `${first} sent`}
          </Chip>
        </div>
        {kind === 'call' ? (
          <div role="group" aria-label="Outcome" className="flex flex-wrap gap-2">
            {CALL_OUTCOMES.map((o) => (
              <Chip key={o} selected={outcome === o} onClick={() => setOutcome(outcome === o ? null : o)}>
                {OUTCOME_LABEL[o]}
              </Chip>
            ))}
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.when} className="text-[15px] font-medium text-ink">
            When
          </label>
          <input id={ids.when} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={selectClass} aria-invalid={future || undefined} />
          {future ? <p className="text-[14px] font-medium text-danger">That time is in the future.</p> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.body} className="text-[15px] font-medium text-ink">
            Note (optional)
          </label>
          <textarea id={ids.body} value={body} onChange={(e) => setBody(e.target.value)} className={textareaClass} maxLength={20000} />
          {suggestsDoNotContact(body) ? <p className="text-[14px] text-ink-muted">If {first} asked not to be contacted, use “They asked not to be contacted…” below: a note alone doesn’t stop anything.</p> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.remind} className="text-[15px] font-medium text-ink">
            Remind me
          </label>
          <select id={ids.remind} value={remind} onChange={(e) => setRemind(Number(e.target.value))} className={selectClass}>
            {REMIND.map((d) => (
              <option key={d} value={d}>
                {d === 0 ? 'No reminder' : `In ${d} day${d === 1 ? '' : 's'}`}
              </option>
            ))}
          </select>
        </div>
        {act.error ? <Notice tone="error">{act.error}</Notice> : null}
      </div>
    </Dialog>
  );
}
