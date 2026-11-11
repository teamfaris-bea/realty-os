// Batch text settings (parity module 64; R-PAR-40, Q-PAR-5, counsel item C-PAR-1). Owner and Admin open it;
// only the Owner turns batch text on, after re-entering their password (re-auth) and typing the attestation.
// The page shows the counsel text the server holds (one source), before the switch, in full. An Admin
// sees the same text and can only turn it off. Nothing here is pre-ticked or pre-filled.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Button, Card, Notice } from '../../../design/index.js';
import { type ApiError, messageFor, useApi, useSession, useWithReauth } from '../../../shell/index.js';

export interface BatchTextView {
  enabled: boolean;
  counselText: string;
  attestation: string;
  maxRecipients: number;
}

export const BATCH_TEXT_KEY = ['batch-text'] as const;

const MESSAGES: Record<string, string> = {
  ATTESTATION_REQUIRED: 'Type the sentence exactly as shown to turn batch text on.',
  BATCH_TEXT_ATTESTATION_REQUIRED: 'Type the sentence exactly as shown to turn batch text on.',
  OWNER_REQUIRED: 'Only the Owner can turn batch text on.',
};

export default function BatchTextPage() {
  const api = useApi();
  const qc = useQueryClient();
  const id = useId();
  const withReauth = useWithReauth();
  const { session } = useSession();
  const isOwner = session?.tenant?.role === 'owner';
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const q = useQuery<{ batchText: BatchTextView }, ApiError>({ queryKey: [...BATCH_TEXT_KEY], queryFn: ({ signal }) => api.get<{ batchText: BatchTextView }>('/batch-text', { signal }) });

  const put = async (enabled: boolean) => {
    setPending(true);
    setMsg(null);
    try {
      const r = await withReauth(() => api.request<{ batchText: BatchTextView }>('PUT', '/batch-text', enabled ? { enabled, attestation: typed } : { enabled }));
      qc.setQueryData([...BATCH_TEXT_KEY], r);
      setTyped('');
      setMsg({ tone: 'ok', text: r.batchText.enabled ? 'Batch text is on.' : 'Batch text is off. Any batch text that is running stops before its next message.' });
    } catch (e) {
      setMsg({ tone: 'error', text: messageFor(e as ApiError, MESSAGES) });
    } finally {
      setPending(false);
    }
  };

  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error) : null}</Notice>;
  const v = q.data.batchText;
  const matches = typed.trim().replace(/\s+/g, ' ').toLowerCase() === v.attestation.toLowerCase();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 md:mx-0">
      <Card aria-labelledby={`${id}-state`} className="flex flex-col gap-2">
        <h2 id={`${id}-state`} className="text-[19px] font-semibold text-ink">
          Batch text is {v.enabled ? 'on' : 'off'}
        </h2>
        <p className="text-[15px] text-ink">
          {v.enabled
            ? `Agents can send one marketing text to up to ${v.maxRecipients} people at a time. People who opted out are always left out.`
            : 'Agents cannot send texts in bulk. Bulk email, tags, stages and plans are not affected.'}
        </p>
      </Card>
      <Card aria-labelledby={`${id}-counsel`} className="flex flex-col gap-2">
        <h2 id={`${id}-counsel`} className="text-[19px] font-semibold text-ink">
          Read this first
        </h2>
        {v.counselText.split('\n\n').map((para, i) => (
          <p key={i} className="text-[15px] text-ink">
            {para}
          </p>
        ))}
        <p className="text-[14px] text-ink-muted">This note is not legal advice. Confirm it with your counsel.</p>
      </Card>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      {v.enabled ? (
        <Button variant="danger" className="self-start" pending={pending} pendingLabel="Turning off" onClick={() => void put(false)}>
          Turn batch text off
        </Button>
      ) : isOwner ? (
        <Card className="flex flex-col gap-2">
          <form
            className="flex flex-col gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void put(true);
            }}
          >
            <label htmlFor={`${id}-att`} className="text-[15px] font-medium text-ink">
              To turn it on, type: <q className="font-semibold">{v.attestation}</q>
            </label>
            <input id={`${id}-att`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-describedby={`${id}-att-hint`} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
            <p id={`${id}-att-hint`} className="text-[14px] text-ink-muted">
              You'll be asked for your password. The sentence you type is kept in the audit log.
            </p>
            <Button type="submit" className="self-start" disabled={!matches} pending={pending} pendingLabel="Turning on">
              Turn batch text on
            </Button>
          </form>
        </Card>
      ) : (
        <Notice tone="info">Only the Owner can turn batch text on.</Notice>
      )}
    </div>
  );
}
