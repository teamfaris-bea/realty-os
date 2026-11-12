// "Where would a new lead go?" (POST /lead-sources/:id/preview, read-only): for a chosen inquiry type, ZIP and
// price band, the server's sentence, the rule that decides it, a pond and its reason in words, who was considered
// and why someone was skipped, and whether the 60-second reply would be queued. Nothing is changed by asking.
import { type FormEvent, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../design/index.js';
import { dollarsToCents } from '../admin/lib/format.js';
import { useAction } from '../admin/lib/hooks.js';
import { SelectField } from '../admin/lib/ui.js';
import { sentenceFor } from './messages.js';
import type { InquiryType, PreviewResponse } from './types.js';
import { INQUIRY_TYPES } from './words.js';

export function firstResponseWords(f: PreviewResponse['firstResponse']): string {
  return f === 'queued'
    ? 'The 60-second reply would be queued (it is still checked against consent before it is sent).'
    : "No 60-second reply would be queued: the team's new-lead reply is not approved and on.";
}

export function Preview({ sourceId }: { sourceId: string }) {
  const [type, setType] = useState<InquiryType>('general');
  const [zip, setZip] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const a = useAction<Record<string, unknown>, PreviewResponse>('POST');
  const minC = dollarsToCents(min);
  const maxC = dollarsToCents(max);
  const zipOk = zip === '' || /^\d{5}(-\d{4})?$/.test(zip.trim());
  const bandOk = minC === null || maxC === null || minC <= maxC;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run(`/lead-sources/${sourceId}/preview`, { inquiryType: type, ...(zip.trim() ? { postalCode: zip.trim() } : {}), ...(minC !== null ? { priceMinCents: minC } : {}), ...(maxC !== null ? { priceMaxCents: maxC } : {}) });
    if (r.ok) setResult(r.data);
  };
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-[18px] font-semibold text-ink">Where would a new lead go?</h2>
      <form aria-label="Where would a new lead go?" className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <SelectField label="What the lead is about" value={type} onChange={(e) => setType(e.target.value as InquiryType)}>
          {INQUIRY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </SelectField>
        <TextField label="ZIP code (optional)" inputMode="numeric" maxLength={10} value={zip} onChange={(e) => setZip(e.target.value)} error={zipOk ? null : 'Enter a 5-digit ZIP code.'} />
        <div className="grid grid-cols-2 gap-2">
          <TextField label="Lowest price ($)" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} />
          <TextField label="Highest price ($)" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
        {!bandOk ? <p className="text-[14px] font-medium text-danger">The lowest price is above the highest.</p> : null}
        <div>
          <Button type="submit" variant="secondary" pending={a.pending} disabled={!zipOk || !bandOk}>
            Check
          </Button>
        </div>
      </form>
      {a.error ? <Notice tone="error">{sentenceFor(a.error)}</Notice> : null}
      {result ? <PreviewResult result={result} /> : null}
    </Card>
  );
}

export function PreviewResult({ result }: { result: PreviewResponse }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="text-[16px] font-medium text-ink">{result.sentence}</p>
      <p className="text-[15px] text-ink-muted">{result.rule ? `Decided by the rule "${result.rule.name}".` : 'No routing rule decides it.'}</p>
      {result.considered.length > 0 ? (
        <ul aria-label="Who was considered" className="flex flex-col gap-1 text-[15px] text-ink">
          {result.considered.map((c) => (
            <li key={c.userId}>{c.eligible ? `${c.name} could take it.` : (c.reason ?? `${c.name} can't take it right now.`)}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-[15px] text-ink">{firstResponseWords(result.firstResponse)}</p>
    </div>
  );
}
