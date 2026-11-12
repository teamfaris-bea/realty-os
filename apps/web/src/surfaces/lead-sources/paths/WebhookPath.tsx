// The webhook path (for developers): "Make a webhook address" or, once there is one, "Get a new one" (🔒, behind a
// confirm because the old address and secret stop working at once). The address and signing secret are shown ONCE,
// with copy buttons and a warning; then the signing recipe and the fields the API reads (apps/api/src/leads/
// schemas.ts IntakeBody). A website that can only send email uses the lead-email address instead.
import { useState } from 'react';
import { Button, Dialog, Notice } from '../../../design/index.js';
import { formatStamp } from '../../admin/lib/format.js';
import { useAction } from '../../admin/lib/hooks.js';
import { SOURCE_KEYS } from '../hooks.js';
import { sentenceFor } from '../messages.js';
import type { SourceOverview, WebhookRotated } from '../types.js';
import { CopyField, Muted } from '../ui.js';

export const SHOWN_ONCE = "Copy both now: they are shown only once. When you leave this page they can't be shown again; if they are lost, get a new one.";
export const ROTATE_WEBHOOK_WARNING = 'The old address and secret stop working at once: leads your website or system sends to them from now on are not received.';

export const SIGNING_RECIPE = [
  'Send each lead as JSON in a POST to the address.',
  'Sign it: X-Realty-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>, where rawBody is the exact bytes you send.',
  'A signature older than 5 minutes is refused, so sign each request when you send it.',
];

/** apps/api/src/leads/schemas.ts IntakeBody, in words */
export const INTAKE_FIELDS: readonly [string, string][] = [
  ['fullName, or firstName and lastName', 'the person’s name'],
  ['phones', 'a list of phone numbers (up to 5)'],
  ['emails', 'a list of email addresses (up to 5)'],
  ['inquiryType', 'buy, sell, rent, value or general (general when left out)'],
  ['message', 'what they wrote (up to 4,000 characters)'],
  ['propertyText', 'the property they asked about (up to 500 characters)'],
  ['postalCode', 'a 5-digit ZIP code, or ZIP+4'],
  ['priceMinCents, priceMaxCents', 'their price band, in cents'],
  ['externalId', 'your own id for the lead, so a resend is not counted twice'],
  ['receivedAt', 'when they sent it (ISO 8601 with an offset)'],
  ['campaignRef, adRef', 'the campaign and ad it came from'],
  ['sourceDetail', 'any other short labelled values'],
  ['consentDisclosure', '{ text, namesSeller }: the consent text they agreed to, when it differs from this source’s'],
];

export function WebhookPath({ source }: { source: SourceOverview }) {
  const [shown, setShown] = useState<WebhookRotated | null>(null);
  const [confirming, setConfirming] = useState(false);
  const a = useAction<Record<string, never>, WebhookRotated>('POST', { invalidate: SOURCE_KEYS });
  const own = source.paths.webhook;
  const make = async () => {
    setConfirming(false);
    const r = await a.run(`/lead-sources/${source.id}/webhook`, {});
    if (r.ok) setShown(r.data);
  };
  return (
    <>
      {!source.active ? <Muted>This source is off. Turn it on to make a webhook address.</Muted> : null}
      {own.ownSecret && own.secretCreatedAt && !shown ? <p className="text-[15px] text-ink">A webhook address was made {formatStamp(own.secretCreatedAt)}. Its address and secret were shown once.</p> : null}
      {!own.ownSecret && !shown ? <Muted>Not set up. Make an address and a signing secret for your website or system.</Muted> : null}
      {shown ? (
        <div className="flex flex-col gap-2">
          <Notice tone="warn">{SHOWN_ONCE}</Notice>
          <CopyField label="Webhook address" value={shown.intakeUrl} />
          <CopyField label="Signing secret" value={shown.signingSecret} />
        </div>
      ) : null}
      {source.active ? (
        <div>
          <Button variant={own.ownSecret || shown ? 'secondary' : 'primary'} pending={a.pending} onClick={() => (own.ownSecret || shown ? setConfirming(true) : void make())}>
            {own.ownSecret || shown ? 'Get a new one' : 'Make a webhook address'}
          </Button>
        </div>
      ) : null}
      {a.error ? <Notice tone="error">{sentenceFor(a.error)}</Notice> : null}
      <p className="text-[15px] text-ink">If your website can only send email, use the lead email address.</p>
      <details className="rounded-xl bg-surface-2 px-3">
        <summary className="flex min-h-tap cursor-pointer items-center text-[15px] font-semibold text-ink">For developers: signing and fields</summary>
        <div className="flex flex-col gap-3 pb-3">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[15px] text-ink">
            {SIGNING_RECIPE.map((l) => (
              <li key={l} className="break-words">
                {l}
              </li>
            ))}
          </ul>
          <dl className="flex flex-col gap-1.5">
            {INTAKE_FIELDS.map(([k, v]) => (
              <div key={k} className="flex flex-col sm:flex-row sm:gap-3">
                <dt className="font-mono text-[14px] text-ink sm:w-56 sm:shrink-0">{k}</dt>
                <dd className="text-[15px] text-ink-muted">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[15px] text-ink-muted">A lead needs at least a name, a phone number or an email address.</p>
        </div>
      </details>
      {confirming ? (
        <Dialog
          title="Get a new webhook address?"
          description={ROTATE_WEBHOOK_WARNING}
          onClose={() => setConfirming(false)}
          footer={
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="danger" onClick={() => void make()}>
                Get a new one now
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Keep the current one
              </Button>
            </div>
          }
        >
          <p className="text-[15px] text-ink">Give the new address and secret to whoever runs your website or system.</p>
        </Dialog>
      ) : null}
    </>
  );
}
