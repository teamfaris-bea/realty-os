// Rename, consent text, and turning a source off or on (POST /lead-sources/:id/off | /on, 🔒: the shell asks for the
// password on REAUTH_REQUIRED and sends the same request again). The off confirm lists every path that stops (from
// the overview), says what happens to what is sent while it is off, and has a second, explicit button.
import { type FormEvent, useState } from 'react';
import { Button, Card, Dialog, Notice, TextField } from '../../design/index.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import { StatusLine, TextArea } from '../admin/lib/ui.js';
import { SOURCE_KEYS } from './hooks.js';
import { sentenceFor } from './messages.js';
import type { OnOffResponse, SourceOverview, SourceView } from './types.js';
import { OFF_SENTENCE, stoppingPaths } from './words.js';

export const OFF_CONFIRM_LABEL = 'Turn off and stop receiving leads';

export function Manage({ source }: { source: SourceOverview }) {
  const [status, announce] = useAnnounce(8000);
  return (
    <Card className="flex flex-col gap-5">
      <h2 className="text-[18px] font-semibold text-ink">This source</h2>
      <StatusLine text={status} />
      <Rename source={source} onDone={announce} />
      <Consent source={source} onDone={announce} />
      <OnOff source={source} />
    </Card>
  );
}

function Rename({ source, onDone }: { source: SourceOverview; onDone(t: string): void }) {
  const [name, setName] = useState(source.name);
  const a = useAction<{ name: string }, { source: SourceView }>('PATCH', { invalidate: SOURCE_KEYS });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run(`/lead-sources/${source.id}`, { name: name.trim() });
    if (r.ok) onDone(`Renamed to ${r.data.source.name}`);
  };
  return (
    <form aria-label="Rename" className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => void submit(e)}>
      <TextField label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="min-w-0 sm:flex-1" error={a.error ? sentenceFor(a.error) : null} />
      <Button type="submit" variant="secondary" pending={a.pending} disabled={!name.trim() || name.trim() === source.name}>
        Rename
      </Button>
    </form>
  );
}

function Consent({ source, onDone }: { source: SourceOverview; onDone(t: string): void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [namesSeller, setNamesSeller] = useState('');
  const a = useAction<Record<string, unknown>, { source: SourceView }>('PATCH', { invalidate: SOURCE_KEYS });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run(`/lead-sources/${source.id}`, { consentDisclosure: { text: text.trim(), namesSeller: namesSeller.trim() } });
    if (r.ok) {
      setOpen(false);
      setText('');
      setNamesSeller('');
      onDone('Consent text saved');
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[15px] font-medium text-ink">Consent text</p>
      <p className="text-[15px] text-ink-muted">{source.hasConsentText ? 'This source has consent text: the words people agree to where they leave their details.' : 'No consent text yet.'}</p>
      {open ? (
        <form aria-label="Consent text" className="flex flex-col gap-2" onSubmit={(e) => void submit(e)}>
          <TextArea label="New consent text" value={text} maxLength={10_000} onChange={(e) => setText(e.target.value)} hint="New leads get this text; earlier leads keep the text they saw." />
          <TextField label="Who it names as the seller" value={namesSeller} maxLength={300} onChange={(e) => setNamesSeller(e.target.value)} />
          {a.error ? <Notice tone="error">{sentenceFor(a.error)}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="secondary" pending={a.pending} disabled={!text.trim() || !namesSeller.trim()}>
              Save consent text
            </Button>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {source.hasConsentText ? 'Replace the consent text' : 'Add consent text'}
          </Button>
        </div>
      )}
    </div>
  );
}

function OnOff({ source }: { source: SourceOverview }) {
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<OnOffResponse | null>(null);
  const a = useAction<Record<string, never>, OnOffResponse>('POST', { invalidate: SOURCE_KEYS });
  const paths = stoppingPaths(source);
  const turn = async (on: boolean) => {
    setAsking(false);
    const r = await a.run(`/lead-sources/${source.id}/${on ? 'on' : 'off'}`, {});
    if (r.ok) setDone(r.data);
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[15px] font-medium text-ink">{source.active ? 'On: leads are received' : 'Off: leads sent to it are not received'}</p>
      {done ? (
        <Notice tone={done.source.active ? 'ok' : 'warn'}>
          <p>{done.sentence}</p>
          {done.paths.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {done.paths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      <div>
        {source.active ? (
          <Button variant="secondary" pending={a.pending} onClick={() => setAsking(true)}>
            Turn off
          </Button>
        ) : (
          <Button pending={a.pending} onClick={() => void turn(true)}>
            Turn on
          </Button>
        )}
      </div>
      {a.error ? <Notice tone="error">{sentenceFor(a.error)}</Notice> : null}
      {asking ? (
        <Dialog
          title={`Turn off ${source.name}?`}
          onClose={() => setAsking(false)}
          footer={
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="danger" onClick={() => void turn(false)}>
                {OFF_CONFIRM_LABEL}
              </Button>
              <Button variant="secondary" onClick={() => setAsking(false)}>
                Keep it on
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-3 text-[15px] text-ink">
            {paths.length > 0 ? (
              <>
                <p className="font-medium">These stop:</p>
                <ul aria-label="These stop" className="list-disc pl-5">
                  {paths.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>No path of this source is set up yet.</p>
            )}
            <p>{OFF_SENTENCE}</p>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
