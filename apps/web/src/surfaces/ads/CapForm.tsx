// The Owner's Google Ads cap (module 55 item 10; R-STAFF-4; E670). POST /ads/caps {monthlyCapCents, dailyCeilingCents,
// attestation}: the Owner only ('ads.cap_set', re-authenticated: useAction opens the shell's password prompt on
// REAUTH_REQUIRED and sends the same request again). Dollars typed are sent as cents. The attestation is the sentence
// the API rebuilds from the amounts (words.ts capAttestation mirrors it); if the API answers ATTESTATION_REQUIRED, its
// details.expected is shown verbatim and the Owner confirms that exact sentence. Never retried automatically.
import { type FormEvent, useState } from 'react';
import { Button, Notice, TextField, announce } from '../../design/index.js';
import { dollarsToCents } from '../admin/lib/format.js';
import { useAction } from '../admin/lib/hooks.js';
import { Check } from '../admin/lib/ui.js';
import { ADS_KEY, type CapResponse, type CapView } from './types.js';
import { capAttestation, dollars, refusalWords } from './words.js';

const MAX_CENTS = 100_000_000_00;

export function CapForm({ cap }: { cap: CapView | null }) {
  const [monthly, setMonthly] = useState(cap ? String(cap.monthlyCapCents / 100) : '');
  const [daily, setDaily] = useState(cap ? String(cap.dailyCeilingCents / 100) : '');
  const [agreed, setAgreed] = useState(false);
  const [expected, setExpected] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const save = useAction<{ monthlyCapCents: number; dailyCeilingCents: number; attestation: string }, CapResponse>('POST', { invalidate: [ADS_KEY] });

  const m = dollarsToCents(monthly);
  const d = dollarsToCents(daily);
  const valid = m !== null && d !== null && m <= MAX_CENTS && d <= MAX_CENTS;
  const sentence = valid ? capAttestation(m, d) : null;
  const invalidWords = !valid && (monthly !== '' || daily !== '') ? 'Enter both amounts in dollars, like 1,500 or 1500.00.' : valid && d! > m! ? 'The daily ceiling cannot be above the monthly cap.' : null;

  const send = async (attestation: string) => {
    if (!valid || d! > m!) return;
    setProblem(null);
    setSaved(null);
    const r = await save.run('/ads/caps', { monthlyCapCents: m!, dailyCeilingCents: d!, attestation });
    if (r.ok) {
      setExpected(null);
      setAgreed(false);
      setSaved(r.data.reconcileQueued ? `Saved. Month-to-date spend is already at or above this cap; the next spend check runs now.` : 'Saved.');
      announce(`Cap saved: ${dollars(r.data.cap.monthlyCapCents)} a month and ${dollars(r.data.cap.dailyCeilingCents)} a day.`);
      return;
    }
    if (r.code === 'ATTESTATION_REQUIRED' && typeof r.details?.expected === 'string') {
      setExpected(r.details.expected);
      return;
    }
    setProblem(refusalWords(r));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (sentence && agreed) void send(sentence);
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label="Monthly cap and daily ceiling">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField label="Monthly cap (dollars)" inputMode="decimal" autoComplete="off" value={monthly} onChange={(e) => { setMonthly(e.target.value); setExpected(null); setAgreed(false); }} />
        <TextField label="Daily ceiling (dollars)" inputMode="decimal" autoComplete="off" value={daily} onChange={(e) => { setDaily(e.target.value); setExpected(null); setAgreed(false); }} />
      </div>
      {invalidWords ? <p className="text-[14px] font-medium text-danger">{invalidWords}</p> : null}
      {sentence && !invalidWords ? <Check label={sentence} checked={agreed} onChange={setAgreed} /> : null}
      {expected ? (
        <Notice tone="warn" title="Confirm this sentence">
          <p>{expected}</p>
          <div className="mt-2">
            <Button pending={save.pending} pendingLabel="Saving" onClick={() => void send(expected)}>
              Confirm and save
            </Button>
          </div>
        </Notice>
      ) : null}
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {saved ? <Notice tone="ok">{saved}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={save.pending} pendingLabel="Saving" disabled={!sentence || !agreed || invalidWords !== null || expected !== null}>
          Save cap
        </Button>
      </div>
    </form>
  );
}
