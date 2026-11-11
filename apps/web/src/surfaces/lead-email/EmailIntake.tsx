// Email intake of one lead source (Owner/Admin; shown on Lead routing under "Lead sources").
//
// - Off: "Turn on lead email" with the sender domains pre-filled from the server's suggestions (each a
//   removable chip). The suggestions are guesses (VERIFY with each portal which domain really signs its
//   mail): a suggested chip says "suggested" after the portal's name, and one plain sentence under the
//   chips says they are unconfirmed until a test lead from each portal becomes a lead automatically (the
//   trust sentence's own words: a test lead that arrives but waits in Needs review, signed by the portal's
//   email vendor say, confirms nothing). The VERIFY marker itself is for engineers and counsel and never
//   shows.
// - On: the inbound address (read-only, with Copy and an announced "Copied"), the allowed sender
//   domains (add / remove, Save), and "Get a new address", which asks first because the old address
//   stops working at once.
// Turning it on, saving domains and a new address are re-auth actions (🔒): useAction opens the shell's
// password prompt on REAUTH_REQUIRED and sends the same request again. Codes are never shown: every
// failure is a sentence (messages.ts).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Dialog, Notice, TextField } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { formatStamp } from '../admin/lib/format.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import type { LeadSource } from '../admin/lib/types.js';
import { Pill, Section } from '../admin/lib/ui.js';
import { LEAD_EMAIL_ERROR_MESSAGES, sentenceFor } from './messages.js';
import { INBOX_KEY, type Inbox, type InboxResponse, REVIEWS_KEY } from './types.js';

export const MAX_DOMAINS = 10;
export const TRUST_SENTENCE = 'Only emails DKIM-signed by an allowed domain become leads automatically; everything else waits in Needs review.';
export const ROTATE_WARNING = 'The old address stops working at once: emails sent to it from now on are not received. Give the new address to every portal that uses the old one.';
/** Under the sender-domain chips while any of them is one of the server's suggestions. */
export const SUGGESTED_UNCONFIRMED = 'Suggested domains are unconfirmed until a test lead from each portal becomes a lead automatically.';

/** "Zillow.com." / "@zillow.com" → "zillow.com"; null when it is not even shaped like a domain. */
export function cleanDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

/** The "Lead sources" section of Lead routing: every source, each with its email intake. */
export function LeadSourcesSection({ sources, loading }: { sources: LeadSource[]; loading: boolean }) {
  return (
    <Section title="Lead sources" description="Where new leads come from. Each source can have its own address that portals send their lead emails to.">
      {loading ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {!loading && sources.length === 0 ? <p className="text-[15px] text-ink-muted">There are no lead sources yet.</p> : null}
      <ul className="flex flex-col gap-3">
        {sources.map((s) => (
          <li key={s.id}>
            <LeadSourceCard source={s} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function LeadSourceCard({ source }: { source: LeadSource }) {
  const hid = useId();
  return (
    <Card as="article" aria-labelledby={hid} className="flex flex-col gap-3">
      <h3 id={hid} className="text-[17px] font-semibold text-ink">
        {source.name} {!source.active ? <Pill tone="warn">Off</Pill> : null}
      </h3>
      {source.active ? <EmailIntake source={source} /> : <p className="text-[15px] text-ink-muted">This source is off, so it takes no leads by email.</p>}
    </Card>
  );
}

export function EmailIntake({ source }: { source: LeadSource }) {
  const api = useApi();
  const q = useQuery<InboxResponse, ApiError>({ queryKey: INBOX_KEY(source.id), queryFn: ({ signal }) => api.get<InboxResponse>(`/lead-sources/${source.id}/lead-email`, { signal }) });
  const inbox = q.data?.inbox;
  return (
    <section aria-label={`Email intake for ${source.name}`} className="flex flex-col gap-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[16px] font-semibold text-ink">
          Email intake
        </h4>
        {inbox ? inbox.enabled ? <Pill tone="ok">On</Pill> : <Pill>Off</Pill> : null}
      </div>
      <p className="text-[15px] text-ink-muted">
        {TRUST_SENTENCE.replace(' Needs review.', ' ')}
        <Link to="/team/lead-email" className="text-accent underline">
          Needs review
        </Link>
        .
      </p>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{sentenceFor(q.error)}</Notice> : null}
      {inbox && !inbox.enabled && !inbox.inboundDomainConfigured ? <Notice tone="warn">{LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NOT_CONFIGURED}</Notice> : null}
      {inbox && !inbox.enabled && inbox.inboundDomainConfigured ? <TurnOn source={source} inbox={inbox} /> : null}
      {inbox?.enabled ? <Enabled source={source} inbox={inbox} /> : null}
    </section>
  );
}

function useInboxAction(method: 'POST' | 'PUT', source: LeadSource) {
  const qc = useQueryClient();
  const a = useAction<Record<string, unknown>, InboxResponse>(method, { invalidate: [[...INBOX_KEY(source.id)], [...REVIEWS_KEY]] });
  const run = async (path: string, body?: Record<string, unknown>) => {
    const r = await a.run(path, body);
    if (r.ok) qc.setQueryData(INBOX_KEY(source.id), r.data);
    return r;
  };
  return { run, pending: a.pending, error: a.error ? sentenceFor(a.error) : null };
}

function TurnOn({ source, inbox }: { source: LeadSource; inbox: Inbox }) {
  const enable = useInboxAction('POST', source);
  return (
    <DomainEditor
      initial={inbox.suggestedSenderDomains.map((s) => s.domain)}
      inbox={inbox}
      sourceName={source.name}
      submitLabel="Turn on lead email"
      pending={enable.pending}
      error={enable.error}
      alwaysSubmittable
      onSubmit={(domains) => enable.run(`/lead-sources/${source.id}/lead-email`, { allowedSenderDomains: domains })}
    />
  );
}

function Enabled({ source, inbox }: { source: LeadSource; inbox: Inbox }) {
  const field = useRef<HTMLInputElement>(null);
  const [copyStatus, announceCopy] = useAnnounce(5000);
  const [confirming, setConfirming] = useState(false);
  const [rotated, announceRotated] = useAnnounce(8000);
  const save = useInboxAction('PUT', source);
  const rotate = useInboxAction('POST', source);
  const address = inbox.address ?? '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      announceCopy('Copied');
    } catch {
      field.current?.select();
      announceCopy("Couldn't copy here. The address is selected: copy it from the field.");
    }
  };
  const doRotate = async () => {
    setConfirming(false);
    const r = await rotate.run(`/lead-sources/${source.id}/lead-email/rotate`);
    if (r.ok) announceRotated('New address made. The old one no longer works.');
  };
  return (
    <div className="flex flex-col gap-4">
      {address ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <TextField
            ref={field}
            label={`Inbound address for ${source.name}`}
            value={address}
            readOnly
            className="min-w-0 sm:flex-1"
            onFocus={(e) => e.currentTarget.select()}
            hint={inbox.addressCreatedAt ? `Made ${formatStamp(inbox.addressCreatedAt)}. Give it to the portal as the address for new-lead emails.` : undefined}
            spellCheck={false}
          />
          <Button variant="secondary" onClick={() => void copy()} aria-label={`Copy the inbound address for ${source.name}`}>
            Copy
          </Button>
        </div>
      ) : (
        <Notice tone="warn">{LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NOT_CONFIGURED}</Notice>
      )}
      <p role="status" aria-live="polite" className="min-h-[1px] text-[15px] text-ok">
        {copyStatus ?? rotated ?? ''}
      </p>
      <DomainEditor
        key={inbox.allowedSenderDomains.join(' ')}
        initial={inbox.allowedSenderDomains}
        inbox={inbox}
        sourceName={source.name}
        submitLabel="Save sender domains"
        pending={save.pending}
        error={save.error}
        onSubmit={(domains) => save.run(`/lead-sources/${source.id}/lead-email/sender-domains`, { domains })}
        savedText="Sender domains saved"
      />
      <div className="flex flex-col gap-2">
        <div>
          <Button variant="secondary" pending={rotate.pending} onClick={() => setConfirming(true)}>
            Get a new address
          </Button>
        </div>
        {rotate.error ? <Notice tone="error">{rotate.error}</Notice> : null}
      </div>
      {confirming ? (
        <Dialog
          title="Get a new address?"
          description={ROTATE_WARNING}
          onClose={() => setConfirming(false)}
          footer={
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="danger" onClick={() => void doRotate()}>
                Get a new address now
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Keep this address
              </Button>
            </div>
          }
        >
          <p className="text-[15px] text-ink">The current address is {address}.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function DomainEditor(p: {
  initial: string[];
  inbox: Inbox;
  sourceName: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  alwaysSubmittable?: boolean;
  savedText?: string;
  onSubmit(domains: string[]): Promise<{ ok: boolean }>;
}) {
  const [domains, setDomains] = useState<string[]>(p.initial);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saved, announceSaved] = useAnnounce();
  const listId = useId();
  const noteId = useId();
  const labelOf = (d: string) => p.inbox.suggestedSenderDomains.find((s) => s.domain === d)?.label ?? null;
  const anySuggested = domains.some((d) => labelOf(d) !== null);
  const changed = domains.join(' ') !== p.initial.join(' ');
  const full = domains.length >= MAX_DOMAINS;
  const add = (e: FormEvent) => {
    e.preventDefault();
    const d = cleanDomain(draft);
    if (!d) {
      setDraftError('Enter a domain like zillow.com.');
      return;
    }
    setDraftError(null);
    setDraft('');
    if (!domains.includes(d)) setDomains((x) => [...x, d]);
  };
  const submit = async () => {
    const r = await p.onSubmit(domains);
    if (r.ok && p.savedText) announceSaved(p.savedText);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <p id={listId} className="text-[15px] font-medium text-ink">
          Allowed sender domains
        </p>
        {domains.length === 0 ? <p className="text-[15px] text-ink-muted">None. Every email to this address will wait in Needs review.</p> : null}
        <ul aria-labelledby={listId} aria-describedby={anySuggested ? noteId : undefined} className="flex flex-wrap gap-2">
          {domains.map((d) => {
            const label = labelOf(d);
            return (
              <li key={d} className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface-2 pl-3.5 text-[15px] text-ink">
                <span className="min-w-0 break-words py-1">
                  <span className="font-medium">{d}</span>
                  {label ? <span className="text-ink-muted"> · {label} · suggested</span> : null}
                </span>
                <button
                  type="button"
                  className="inline-flex min-h-tap min-w-tap shrink-0 items-center justify-center rounded-full text-[20px] leading-none text-ink-muted active:bg-surface"
                  aria-label={`Remove ${d}`}
                  onClick={() => setDomains((x) => x.filter((y) => y !== d))}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            );
          })}
        </ul>
        {anySuggested ? (
          <p id={noteId} className="text-[15px] text-ink-muted">
            {SUGGESTED_UNCONFIRMED}
          </p>
        ) : null}
      </div>
      <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={add} aria-label={`Add a sender domain for ${p.sourceName}`}>
        <TextField
          label="Add a sender domain"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          className="min-w-0 sm:flex-1"
          error={draftError}
          hint={full ? `Up to ${MAX_DOMAINS} domains.` : 'The domain the portal sends its lead emails from, like zillow.com.'}
          disabled={full}
        />
        <Button type="submit" variant="secondary" disabled={full || !draft.trim()}>
          Add domain
        </Button>
      </form>
      {p.error ? <Notice tone="error">{p.error}</Notice> : null}
      <p role="status" aria-live="polite" className="min-h-[1px] text-[15px] text-ok">
        {saved ?? ''}
      </p>
      <div>
        <Button pending={p.pending} disabled={!p.alwaysSubmittable && !changed} onClick={() => void submit()}>
          {p.submitLabel}
        </Button>
      </div>
    </div>
  );
}
