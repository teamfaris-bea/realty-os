// Incoming calls (Owner/Admin): how long a call rings the agent before voicemail, and the voicemail
// greeting (GET/PUT /voice-settings, audited). The fixed recording notice that follows every greeting is
// shown but not editable (VERIFY WITH COUNSEL: its wording per state).
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { useAction } from './lib/hooks.js';
import { ADMIN_MESSAGES } from './lib/messages.js';
import { ErrorLine, Section, TextArea } from './lib/ui.js';

export interface VoiceSettings {
  ringTimeoutSeconds: number;
  voicemailGreeting: string | null;
  defaultGreeting: string;
  recordingNotice: string;
  version: number;
}

const KEY = ['admin', 'voice-settings'] as const;

export function IncomingCallsSettings({ onDone }: { onDone(text: string): void }) {
  const api = useApi();
  const q = useQuery<{ settings: VoiceSettings }, ApiError>({ queryKey: KEY, queryFn: ({ signal }) => api.get('/voice-settings', { signal }) });
  const save = useAction<{ version: number; ringTimeoutSeconds: number; voicemailGreeting: string | null }, { settings: VoiceSettings }>('PUT', { invalidate: [[...KEY]] });
  const s = q.data?.settings;
  const [seconds, setSeconds] = useState('');
  const [greeting, setGreeting] = useState('');
  useEffect(() => {
    if (!s) return;
    setSeconds(String(s.ringTimeoutSeconds));
    setGreeting(s.voicemailGreeting ?? '');
  }, [s]);
  const n = Number(seconds);
  const valid = Number.isInteger(n) && n >= 5 && n <= 60;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!s || !valid) return;
    const r = await save.run('/voice-settings', { version: s.version, ringTimeoutSeconds: n, voicemailGreeting: greeting.trim() === '' ? null : greeting.trim() });
    if (r.ok) onDone('Incoming call settings saved');
  };
  return (
    <Section title="Incoming calls" description="A call to a team number rings the client's agent (or the agent on duty for new callers). If nobody answers, the caller can leave a voicemail, which is transcribed into the conversation.">
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {s ? (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <TextField
            label="Ring the agent for (seconds)"
            inputMode="numeric"
            value={seconds}
            onChange={(e) => setSeconds(e.target.value.replace(/\D/g, '').slice(0, 2))}
            hint="Between 5 and 60 seconds. The agent presses 1 to take the call."
            error={valid || seconds === '' ? undefined : 'Enter a number from 5 to 60.'}
            className="md:w-64"
          />
          <TextArea
            label="Voicemail greeting"
            value={greeting}
            maxLength={500}
            rows={3}
            onChange={(e) => setGreeting(e.target.value)}
            placeholder={s.defaultGreeting}
            hint={`Leave it empty to use: “${s.defaultGreeting}”. Callers always hear this after it: “${s.recordingNotice}”`}
          />
          <div>
            <Button type="submit" pending={save.pending} disabled={!valid}>
              Save incoming call settings
            </Button>
          </div>
          <ErrorLine message={save.error?.message} />
        </form>
      ) : null}
    </Section>
  );
}
