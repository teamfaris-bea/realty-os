// The tracking-number path: the live numbers tied to this source (each can stop crediting it), "Get a tracking
// number" (POST /numbers purpose tracking with leadSourceId; a notice from the server says when it was bought but
// could not be tied) and "Use one of your tracking numbers" (PATCH /numbers/:id/lead-source). Then exactly what a
// tracked call or text does, with a link to the Phone and email page (registration lives there).
// R-TWL-1 (b9 ui/F3): GET /numbers says whether texts and calls reach a phone. With the kill switch off or a simulated
// provider the path says so first; with the switch off "Get a tracking number" is not offered (it can only be refused),
// while tying a number the team already has still works.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Notice, TextField } from '../../../design/index.js';
import { type ApiError, useApi } from '../../../shell/index.js';
import { formatPhone } from '../../feed/lib/format.js';
import { useAction, useAnnounce } from '../../admin/lib/hooks.js';
import { type TelephonyMode, canBuyNumber, telephonyNotice } from '../../admin/lib/telephony.js';
import type { PhoneNumber } from '../../admin/lib/types.js';
import { SelectField, StatusLine } from '../../admin/lib/ui.js';
import { SOURCE_KEYS } from '../hooks.js';
import { sentenceFor } from '../messages.js';
import { NUMBERS_KEY, type SourceOverview } from '../types.js';
import { Muted } from '../ui.js';
import { PAGES, TRACKING_SENTENCE } from '../words.js';

export function PhonePath({ source, sourceName }: { source: SourceOverview; sourceName(id: string): string }) {
  const api = useApi();
  const numbers = useQuery<{ numbers: PhoneNumber[]; telephony?: TelephonyMode }, ApiError>({ queryKey: NUMBERS_KEY, queryFn: ({ signal }) => api.get('/numbers', { signal }) });
  const [status, announce] = useAnnounce(8000);
  const [area, setArea] = useState('');
  const [pick, setPick] = useState('');
  const keys = { invalidate: [...SOURCE_KEYS, [...NUMBERS_KEY]] };
  const buy = useAction<Record<string, unknown>, { number: PhoneNumber; notice?: string }>('POST', keys);
  const tie = useAction<{ leadSourceId: string | null }, { number: PhoneNumber }>('PATCH', keys);
  const live = (numbers.data?.numbers ?? []).filter((n) => !n.releasedAt && n.purpose === 'tracking');
  const mine = live.filter((n) => n.leadSourceId === source.id);
  const others = live.filter((n) => n.leadSourceId !== source.id);
  const failure = buy.error ?? tie.error;
  const mode = numbers.data?.telephony;
  const notice = telephonyNotice(mode);
  return (
    <>
      <StatusLine text={status} />
      {notice.length > 0 ? (
        <Notice tone="warn">
          {notice.map((t) => (
            <span key={t} className="block">
              {t}
            </span>
          ))}
        </Notice>
      ) : null}
      {numbers.isError ? <Notice tone="error">{sentenceFor(numbers.error)}</Notice> : null}
      {mine.length > 0 ? (
        <ul aria-label={`Tracking numbers of ${source.name}`} className="flex flex-col gap-2">
          {mine.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-[17px] font-semibold tabular-nums text-ink">{formatPhone(n.e164)}</span>
              <Button variant="quiet" pending={tie.pending} onClick={async () => (await tie.run(`/numbers/${n.id}/lead-source`, { leadSourceId: null })).ok && announce(`${formatPhone(n.e164)} no longer credits ${source.name}`)}>
                Stop crediting
              </Button>
            </li>
          ))}
        </ul>
      ) : numbers.data ? (
        <Muted>No tracking number is tied to this source.</Muted>
      ) : null}
      {source.active ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <TextField label="Area code (optional)" inputMode="numeric" maxLength={3} value={area} onChange={(e) => setArea(e.target.value.replace(/\D/g, ''))} className="sm:w-48" />
            <Button
              pending={buy.pending}
              disabled={!canBuyNumber(mode) || (area !== '' && !/^[2-9]\d{2}$/.test(area))}
              onClick={async () => {
                const r = await buy.run('/numbers', { purpose: 'tracking', leadSourceId: source.id, ...(area ? { areaCode: area } : {}) });
                if (r.ok) {
                  setArea('');
                  announce(r.data.notice ?? `${formatPhone(r.data.number.e164)} now credits ${source.name}`);
                }
              }}
            >
              Get a tracking number
            </Button>
          </div>
          {others.length > 0 ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <SelectField label="Use one of your tracking numbers" value={pick} onChange={(e) => setPick(e.target.value)} className="sm:flex-1">
                <option value="">Pick a number</option>
                {others.map((n) => (
                  <option key={n.id} value={n.id}>
                    {formatPhone(n.e164)}
                    {n.leadSourceId ? ` (now credits ${sourceName(n.leadSourceId)})` : ''}
                  </option>
                ))}
              </SelectField>
              <Button
                variant="secondary"
                pending={tie.pending}
                disabled={!pick}
                onClick={async () => {
                  const n = others.find((x) => x.id === pick);
                  const r = await tie.run(`/numbers/${pick}/lead-source`, { leadSourceId: source.id });
                  if (r.ok && n) {
                    setPick('');
                    announce(`${formatPhone(n.e164)} now credits ${source.name}`);
                  }
                }}
              >
                Use this number
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <Muted>This source is off. Turn it on to tie a number to it.</Muted>
      )}
      {failure ? <Notice tone="error">{sentenceFor(failure)}</Notice> : null}
      <p className="text-[15px] text-ink">{TRACKING_SENTENCE}</p>
      <p className="text-[15px]">
        <Link to={PAGES.numbers} className="inline-flex min-h-tap items-center text-accent underline">
          Numbers and texting registration: Phone and email
        </Link>
      </p>
    </>
  );
}
