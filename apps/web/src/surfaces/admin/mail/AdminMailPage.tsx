// Admin → Gmail sync (module 69; R-GMAIL-1, R-INT-6 platform:gmail). The Owner turns Gmail sync on (only
// while platform:gmail is cleared) and sets the backfill window (0–90 days); an Admin can only turn it off.
// Both are 🔒 writes: REAUTH_REQUIRED opens the shell's password prompt and re-sends once.
//
//   GET /admin/mail-sync → { enabled, backfillDays, pack: { cleared, reviewedByCounsel, vendorReady, sentence }, canTurnOn, role }
//   PUT /admin/mail-sync { enabled, backfillDays }
//
// This page shows NO per-agent mailbox, token or sync state: the API returns none, and nothing here asks.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../../design/index.js';
import { type ApiError, messageFor, useApi, useWithReauth } from '../../../shell/index.js';
import { MAIL_ERROR_MESSAGES } from '../../settings/mail/words.js';

export interface MailPackView {
  cleared: boolean;
  reviewedByCounsel: boolean;
  vendorReady: boolean;
  sentence: string;
}

export interface AdminMailView {
  enabled: boolean;
  backfillDays: number;
  pack: MailPackView;
  canTurnOn: boolean;
  role: 'owner' | 'admin';
}

export const ADMIN_MAIL_KEY = ['admin', 'mail-sync'] as const;
export const MAX_BACKFILL_DAYS = 90;

/** The platform:gmail review state, in words ("not reviewed by counsel" / "waiting for Google verification" where true). */
export function packWords(p: MailPackView): string {
  if (p.cleared) return 'Gmail sync is reviewed by counsel and verified by Google.';
  const missing = [!p.reviewedByCounsel ? 'not reviewed by counsel' : null, !p.vendorReady ? 'waiting for Google verification' : null].filter((x): x is string => x !== null);
  if (missing.length === 0) return p.sentence || "Gmail sync isn't cleared yet.";
  const what = missing.join(' and ');
  return `Gmail sync is ${what}, so it can't be turned on yet.`;
}

export default function AdminMailPage() {
  const api = useApi();
  const qc = useQueryClient();
  const withReauth = useWithReauth();
  const id = useId();
  const [pending, setPending] = useState<'on' | 'off' | 'days' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const q = useQuery<AdminMailView, ApiError>({ queryKey: [...ADMIN_MAIL_KEY], queryFn: ({ signal }) => api.get<AdminMailView>('/admin/mail-sync', { signal }) });

  const put = async (what: 'on' | 'off' | 'days', body: { enabled: boolean; backfillDays: number }) => {
    if (pending) return;
    setPending(what);
    setMsg(null);
    try {
      const r = await withReauth(() => api.request<AdminMailView>('PUT', '/admin/mail-sync', body));
      qc.setQueryData([...ADMIN_MAIL_KEY], r);
      setDays(null);
      setMsg({
        tone: 'ok',
        text: what === 'days' ? `Saved. New connections import up to ${r.backfillDays} days of past mail.` : r.enabled ? 'Gmail sync is on. Each person connects their own Gmail in Settings → Gmail.' : 'Gmail sync is off. Connected Gmail accounts are disconnected at the next sync, and their copies leave Realty OS.',
      });
    } catch (e) {
      void qc.invalidateQueries({ queryKey: [...ADMIN_MAIL_KEY] });
      setMsg({ tone: 'error', text: messageFor(e as ApiError, MAIL_ERROR_MESSAGES) });
    } finally {
      setPending(null);
    }
  };

  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error, MAIL_ERROR_MESSAGES) : null}</Notice>;
  const v = q.data;
  const owner = v.role === 'owner';
  const review = packWords(v.pack);
  const typed = days ?? String(v.backfillDays);
  const n = /^\d{1,2}$/.test(typed.trim()) ? Number(typed.trim()) : NaN;
  const daysOk = Number.isInteger(n) && n >= 0 && n <= MAX_BACKFILL_DAYS;

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-4 md:mx-0">
      <Card aria-labelledby={`${id}-state`} className="flex flex-col gap-2">
        <h2 id={`${id}-state`} className="text-[19px] font-semibold text-ink">
          Gmail sync is {v.enabled ? 'on' : 'off'}
        </h2>
        <p className="text-[15px] text-ink">
          {v.enabled
            ? 'Each person can connect their own Gmail, read-only, and choose which clients it syncs. Their mail with those clients shows in the client’s conversation.'
            : 'Nobody can connect Gmail. Mail stays in Gmail.'}
        </p>
        <p className="text-[14px] text-ink-muted">Nobody here sees anyone’s mailbox, Google access or sync state: each person manages their own.</p>
      </Card>

      <Card aria-labelledby={`${id}-review`} className="flex flex-col gap-2">
        <h2 id={`${id}-review`} className="text-[19px] font-semibold text-ink">
          Review
        </h2>
        <p id={`${id}-review-words`} className="text-[15px] text-ink">
          {review}
        </p>
      </Card>

      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}

      {v.enabled ? (
        <Button variant="danger" className="self-start" pending={pending === 'off'} pendingLabel="Turning off" disabled={pending !== null && pending !== 'off'} onClick={() => void put('off', { enabled: false, backfillDays: v.backfillDays })}>
          Turn Gmail sync off
        </Button>
      ) : owner ? (
        <div className="flex flex-col gap-1">
          <Button
            className="self-start"
            disabled={!v.canTurnOn || !v.pack.cleared || (pending !== null && pending !== 'on')}
            aria-describedby={!v.canTurnOn || !v.pack.cleared ? `${id}-review-words` : undefined}
            pending={pending === 'on'}
            pendingLabel="Turning on"
            onClick={() => void put('on', { enabled: true, backfillDays: v.backfillDays })}
          >
            Turn Gmail sync on
          </Button>
          <p className="text-[14px] text-ink-muted">You'll be asked for your password.</p>
        </div>
      ) : (
        <Notice tone="info">Only the Owner can turn Gmail sync on.</Notice>
      )}

      <Card aria-labelledby={`${id}-window`} className="flex flex-col gap-2">
        <h2 id={`${id}-window`} className="text-[19px] font-semibold text-ink">
          Past mail
        </h2>
        {owner ? (
          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (daysOk) void put('days', { enabled: v.enabled, backfillDays: n });
            }}
          >
            <TextField
              label="Days of past mail to import when someone connects"
              inputMode="numeric"
              value={typed}
              onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, '').slice(0, 2))}
              hint={`0 to ${MAX_BACKFILL_DAYS}. 0 imports no past mail: only new mail is copied.`}
              error={daysOk ? null : `Enter a number from 0 to ${MAX_BACKFILL_DAYS}.`}
            />
            <Button type="submit" variant="secondary" className="self-start" disabled={!daysOk || n === v.backfillDays || (pending !== null && pending !== 'days')} pending={pending === 'days'} pendingLabel="Saving">
              Save
            </Button>
          </form>
        ) : (
          <p className="text-[15px] text-ink">
            {v.backfillDays > 0 ? `New connections import up to ${v.backfillDays} days of past mail.` : 'New connections import no past mail: only new mail is copied.'} Only the Owner can change this.
          </p>
        )}
      </Card>
    </div>
  );
}
