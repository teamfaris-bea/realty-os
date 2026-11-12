// The Google Ads lead form path (apps/api/src/leadForms; R-GADS-*). Off: the inquiry type its leads get (Buying,
// Selling, Renting, Home value, General) and, when the source has consent text, "This consent text is shown on the
// Google form"; "Turn on the Google lead form" (🔒). On: the webhook URL and key (re-showable to Owner/Admin) with copy
// buttons, the steps in Google Ads, and what has arrived, in words: the test lead (which adds no one), the last real
// lead, and leads Google sent that we couldn't read. A deployment with no public https address says so and offers
// nothing to turn on. Getting a new key and turning it off are 🔒 and ask first.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Dialog, Notice } from '../../../design/index.js';
import { type ApiError, useApi } from '../../../shell/index.js';
import { formatStamp } from '../../admin/lib/format.js';
import { useAction, useAnnounce } from '../../admin/lib/hooks.js';
import { Check, SelectField, StatusLine } from '../../admin/lib/ui.js';
import { SOURCE_KEYS } from '../hooks.js';
import { sentenceFor } from '../messages.js';
import { GOOGLE_KEY, type GoogleKeyResponse, type GoogleLeadForm, type InquiryType, type SourceOverview } from '../types.js';
import { CopyField, Muted, Steps } from '../ui.js';
import { GOOGLE_NOT_AVAILABLE, INQUIRY_TYPES, googleTestLine, googleUnreadableLine, inquiryWords } from '../words.js';

export const CONSENT_ON_FORM = 'This consent text is shown on the Google form';
export const ROTATE_KEY_WARNING = 'The old key stops working at once: leads Google sends with it from now on are not received. Paste the new key into Google Ads.';
export const GOOGLE_OFF_WARNING = 'Leads Google sends to this source from now on are not received. Google does not resend; its leads stay downloadable in Google Ads for 30 days.';

/**
 * Where the URL and key go in Google Ads. VERIFY these menu names against Google Ads before relying on them (they
 * change): support.google.com/google-ads/answer/9423234 (lead form assets) and answer/16729613 (webhook delivery).
 */
export const GOOGLE_STEPS = [
  'In Google Ads, open the lead form asset of your campaign.',
  'Under Lead delivery, choose Webhook integration.',
  'Paste the webhook URL and the key from here.',
  'Tap Send test data.',
];

export function GooglePath({ source }: { source: SourceOverview }) {
  const api = useApi();
  const g0 = source.paths.googleLeadForm;
  const q = useQuery<GoogleLeadForm, ApiError>({
    queryKey: GOOGLE_KEY(source.id),
    queryFn: ({ signal }) => api.get<GoogleLeadForm>(`/lead-sources/${source.id}/google-lead-form`, { signal }),
    enabled: g0.state !== 'not_available',
  });
  const [fresh, setFresh] = useState<GoogleKeyResponse | null>(null);
  const [status, announce] = useAnnounce();
  const g = q.data;
  // the overview's facts stand in until (or when) the form's own read is not available
  const state = g?.state ?? g0.state;
  const hasConsent = g?.sourceHasConsentText ?? source.hasConsentText;
  if (state === 'not_available') return <Muted>{GOOGLE_NOT_AVAILABLE}</Muted>;
  if (!source.active) return <Muted>This source is off, so Google lead form leads sent to it are not received. Turn it on to set this up.</Muted>;
  const key = g?.key ?? fresh?.key ?? null;
  const url = g?.webhookUrl ?? fresh?.webhookUrl ?? null;
  const lastTestAt = g?.lastTestAt ?? g0.lastTestAt;
  const unreadable = googleUnreadableLine(g?.unreadableCount ?? g0.unreadableCount, g?.lastUnreadableAt ?? g0.lastUnreadableAt);
  return (
    <>
      <StatusLine text={status} />
      {q.isError ? <Notice tone="error">{sentenceFor(q.error)}</Notice> : null}
      {state === 'off' ? (
        <TurnOn source={source} hasConsent={hasConsent} onOn={(r) => (setFresh(r), announce('The Google lead form is on'))} />
      ) : (
        <>
          {url ? <CopyField label="Webhook URL" value={url} /> : null}
          {key ? <CopyField label="Key" value={key} /> : null}
          <section aria-label="Steps in Google Ads" className="flex flex-col gap-2">
            <h3 className="text-[17px] font-semibold text-ink">In Google Ads</h3>
            <Steps items={GOOGLE_STEPS} />
          </section>
          <ul aria-label="What Google has sent" className="flex flex-col gap-1 text-[15px] text-ink">
            <li>{googleTestLine(lastTestAt)}</li>
            {g ? <li>{g.lastLeadAt ? `Last lead ${formatStamp(g.lastLeadAt)}` : 'No lead from the form yet.'}</li> : null}
            {unreadable ? <li className="font-medium">{unreadable}</li> : null}
          </ul>
          {g ? <Settings source={source} form={g} hasConsent={hasConsent} onDone={announce} /> : null}
          <OnActions source={source} onRotated={(r) => (setFresh(r), announce('New key made. Paste it into Google Ads.'))} onOff={() => (setFresh(null), announce('The Google lead form is off'))} />
        </>
      )}
    </>
  );
}

function TurnOn({ source, hasConsent, onOn }: { source: SourceOverview; hasConsent: boolean; onOn(r: GoogleKeyResponse): void }) {
  const [type, setType] = useState<InquiryType>('general');
  const [cites, setCites] = useState(false);
  const a = useAction<Record<string, unknown>, GoogleKeyResponse>('POST', { invalidate: [...SOURCE_KEYS, [...GOOGLE_KEY(source.id)]] });
  return (
    <div className="flex flex-col gap-3">
      <Muted>Google Ads sends each lead from your lead form straight here.</Muted>
      <SelectField label="What these leads are about" value={type} onChange={(e) => setType(e.target.value as InquiryType)}>
        {INQUIRY_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </SelectField>
      {hasConsent ? <Check label={CONSENT_ON_FORM} checked={cites} onChange={setCites} hint="Tick it only if the same words appear on your Google lead form." /> : null}
      {a.error ? <Notice tone="error">{sentenceFor(a.error)}</Notice> : null}
      <div>
        <Button pending={a.pending} onClick={async () => {
          const r = await a.run(`/lead-sources/${source.id}/google-lead-form`, { inquiryType: type, ...(hasConsent ? { citesSourceDisclosure: cites } : {}) });
          if (r.ok) onOn(r.data);
        }}>
          Turn on the Google lead form
        </Button>
      </div>
    </div>
  );
}

function Settings({ source, form, hasConsent, onDone }: { source: SourceOverview; form: GoogleLeadForm; hasConsent: boolean; onDone(t: string): void }) {
  const [type, setType] = useState<InquiryType>(form.inquiryType ?? 'general');
  const [cites, setCites] = useState(form.citesSourceDisclosure === true);
  const a = useAction<Record<string, unknown>, unknown>('PATCH', { invalidate: [...SOURCE_KEYS, [...GOOGLE_KEY(source.id)]] });
  const changed = type !== (form.inquiryType ?? 'general') || (hasConsent && cites !== (form.citesSourceDisclosure === true));
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <SelectField label="What these leads are about" value={type} onChange={(e) => setType(e.target.value as InquiryType)} hint={`Now: ${inquiryWords(form.inquiryType)}.`}>
        {INQUIRY_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </SelectField>
      {hasConsent ? <Check label={CONSENT_ON_FORM} checked={cites} onChange={setCites} /> : null}
      {a.error ? <Notice tone="error">{sentenceFor(a.error)}</Notice> : null}
      <div>
        <Button variant="secondary" pending={a.pending} disabled={!changed} onClick={async () => {
          const r = await a.run(`/lead-sources/${source.id}/google-lead-form`, { inquiryType: type, ...(hasConsent ? { citesSourceDisclosure: cites } : {}) });
          if (r.ok) onDone('Saved');
        }}>
          Save
        </Button>
      </div>
    </div>
  );
}

function OnActions({ source, onRotated, onOff }: { source: SourceOverview; onRotated(r: GoogleKeyResponse): void; onOff(): void }) {
  const [asking, setAsking] = useState<'rotate' | 'off' | null>(null);
  const keys = { invalidate: [...SOURCE_KEYS, [...GOOGLE_KEY(source.id)]] };
  const rotate = useAction<Record<string, never>, GoogleKeyResponse>('POST', keys);
  const off = useAction<Record<string, never>, unknown>('POST', keys);
  const failure = rotate.error ?? off.error;
  const go = async () => {
    const which = asking;
    setAsking(null);
    if (which === 'rotate') {
      const r = await rotate.run(`/lead-sources/${source.id}/google-lead-form/rotate`, {});
      if (r.ok) onRotated(r.data);
    } else if (which === 'off') {
      const r = await off.run(`/lead-sources/${source.id}/google-lead-form/off`, {});
      if (r.ok) onOff();
    }
  };
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" pending={rotate.pending} onClick={() => setAsking('rotate')}>
          Get a new key
        </Button>
        <Button variant="quiet" pending={off.pending} onClick={() => setAsking('off')}>
          Turn off the Google lead form
        </Button>
      </div>
      {failure ? <Notice tone="error">{sentenceFor(failure)}</Notice> : null}
      {asking ? (
        <Dialog
          title={asking === 'rotate' ? 'Get a new key?' : 'Turn off the Google lead form?'}
          description={asking === 'rotate' ? ROTATE_KEY_WARNING : GOOGLE_OFF_WARNING}
          onClose={() => setAsking(null)}
          footer={
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="danger" onClick={() => void go()}>
                {asking === 'rotate' ? 'Get a new key now' : 'Turn it off'}
              </Button>
              <Button variant="secondary" onClick={() => setAsking(null)}>
                {asking === 'rotate' ? 'Keep this key' : 'Keep it on'}
              </Button>
            </div>
          }
        >
          <p className="text-[15px] text-ink">{source.name}</p>
        </Dialog>
      ) : null}
    </>
  );
}
