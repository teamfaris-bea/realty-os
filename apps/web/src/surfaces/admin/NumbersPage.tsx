// Phone numbers, texting registration, sending domains and email senders (BUILD_PLAN module 17
// admin; api/comms module 12 admin endpoints). Owner/Admin.
//
// - Texting from a number needs an approved carrier registration (A2P 10DLC or toll-free
//   verification). The page shows each number's registration status in words and never claims a
//   number can text before the carrier approved it.
// - Releasing a number asks for the password again (R-PERM-13) and is final.
// - A sending domain shows the DNS records to add and its SPF / DKIM / DMARC check results.
//   Phase 1 has no list endpoint for domains (api/comms exposes add + verify only), so this page shows
//   the domains added or checked during this visit; that limit is stated on the page.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { formatPhone } from '../feed/lib/format.js';
import { formatDate, roleLabel } from './lib/format.js';
import { useAction, useAnnounce } from './lib/hooks.js';
import { ADMIN_MESSAGES } from './lib/messages.js';
import { IncomingCallsSettings } from './IncomingCallsSettings.js';
import type { EmailIdentity, MembersResponse, PhoneNumber, Registration, SendingDomain } from './lib/types.js';
import { ErrorLine, Pill, Section, SelectField, StatusLine, TextArea } from './lib/ui.js';

const NUMBERS_KEY = ['admin', 'numbers'] as const;

const PURPOSES = [
  { value: 'team_main', label: 'Team main line' },
  { value: 'agent_direct', label: 'An agent’s direct line' },
  { value: 'pond', label: 'Pond line' },
  { value: 'tracking', label: 'Tracking (one per ad or source)' },
] as const;

export function registrationWords(status: string | null): { text: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' } {
  switch (status) {
    case 'approved':
      return { text: 'Texting approved', tone: 'ok' };
    case 'submitted':
      return { text: 'Texting registration waiting for the carrier', tone: 'warn' };
    case 'draft':
      return { text: 'Texting registration not submitted', tone: 'warn' };
    case 'rejected':
      return { text: 'Texting registration rejected', tone: 'danger' };
    case 'suspended':
      return { text: 'Texting suspended by the carrier', tone: 'danger' };
    default:
      return { text: 'Not registered for texting', tone: 'neutral' };
  }
}

export default function NumbersPage() {
  const api = useApi();
  const [status, announce] = useAnnounce();
  const numbers = useQuery<{ numbers: PhoneNumber[] }, ApiError>({ queryKey: NUMBERS_KEY, queryFn: ({ signal }) => api.get('/numbers', { signal }) });
  const members = useQuery<MembersResponse, ApiError>({ queryKey: ['admin', 'members'], queryFn: ({ signal }) => api.get('/members', { signal }) });
  const people = (members.data?.members ?? []).filter((m) => m.status === 'active');
  const nameOf = (id: string | null) => (id ? (people.find((m) => m.userId === id)?.displayName ?? 'a former member') : null);
  const live = (numbers.data?.numbers ?? []).filter((n) => !n.releasedAt);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  return (
    <div className="flex w-full flex-col gap-8">
      <StatusLine text={status} />
      <Section title="Phone numbers" description="Calls and texts to and from clients use these numbers.">
        {numbers.isError ? <Notice tone="error">{messageFor(numbers.error, ADMIN_MESSAGES)}</Notice> : null}
        {numbers.data && live.length === 0 ? <Notice tone="warn">There are no numbers yet, so nobody can call or text clients from the app.</Notice> : null}
        <ul className="flex flex-col gap-2">
          {live.map((n) => (
            <li key={n.id}>
              <NumberRow number={n} assignee={nameOf(n.assignedUserId)} registrations={registrations} onDone={announce} />
            </li>
          ))}
        </ul>
        <AcquireForm people={people.filter((m) => m.role !== 'tc').map((m) => ({ id: m.userId, label: `${m.displayName} · ${roleLabel(m.role)}` }))} registrations={registrations} onDone={announce} />
      </Section>
      <IncomingCallsSettings onDone={announce} />
      <RegistrationForm onCreated={(r) => (setRegistrations((x) => [r, ...x]), announce('Registration saved'))} />
      <Domains onDone={announce} />
      <Identities people={people.map((m) => ({ id: m.userId, label: m.displayName }))} onDone={announce} />
    </div>
  );
}

function NumberRow({ number, assignee, registrations, onDone }: { number: PhoneNumber; assignee: string | null; registrations: Registration[]; onDone(t: string): void }) {
  const [confirming, setConfirming] = useState(false);
  const release = useAction<Record<string, never>, { number: PhoneNumber }>('POST', { invalidate: [[...NUMBERS_KEY]] });
  const refresh = useAction<Record<string, never>, { registration: Registration }>('POST', { invalidate: [[...NUMBERS_KEY]] });
  const attach = useAction<{ registrationId: string | null }, { number: PhoneNumber }>('PATCH', { invalidate: [[...NUMBERS_KEY]] });
  const reg = registrationWords(number.registrationStatus);
  const failure = release.error ?? refresh.error ?? attach.error;
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-semibold tabular-nums text-ink">{formatPhone(number.e164)}</p>
          <p className="text-[14px] text-ink-muted">
            {PURPOSES.find((p) => p.value === number.purpose)?.label ?? number.purpose}
            {assignee ? ` · ${assignee}` : ''} · {[number.voiceCapable ? 'calls' : null, number.smsCapable ? 'texts' : null].filter(Boolean).join(' and ') || 'no calls or texts'}
          </p>
        </div>
        <Pill tone={reg.tone}>{reg.text}</Pill>
      </div>
      <div className="flex flex-wrap gap-2">
        {number.registrationId && number.registrationStatus !== 'approved' ? (
          <Button variant="secondary" pending={refresh.pending} onClick={async () => (await refresh.run(`/sender-registrations/${number.registrationId}/refresh`, {})).ok && onDone('Registration status checked')}>
            Check registration status
          </Button>
        ) : null}
        {!number.registrationId && registrations.length > 0 ? (
          <Button variant="secondary" pending={attach.pending} onClick={async () => (await attach.run(`/numbers/${number.id}/registration`, { registrationId: registrations[0]!.id })).ok && onDone('Number added to the registration')}>
            Add to “{registrations[0]!.useCase}”
          </Button>
        ) : null}
        {!confirming ? (
          <Button variant="quiet" onClick={() => setConfirming(true)}>
            Release number
          </Button>
        ) : (
          <>
            <Button variant="danger" pending={release.pending} onClick={async () => (await release.run(`/numbers/${number.id}/release`, {})).ok && onDone(`${formatPhone(number.e164)} released`)}>
              Release {formatPhone(number.e164)} for good
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </>
        )}
      </div>
      {confirming ? <p className="text-[14px] text-ink-muted">Clients who text or call this number afterwards won't reach the team. Released numbers can't be recovered.</p> : null}
      <ErrorLine message={failure?.message} />
    </Card>
  );
}

function AcquireForm({ people, registrations, onDone }: { people: { id: string; label: string }[]; registrations: Registration[]; onDone(t: string): void }) {
  const [purpose, setPurpose] = useState<string>('team_main');
  const [area, setArea] = useState('');
  const [user, setUser] = useState('');
  const a = useAction<Record<string, unknown>, { number: PhoneNumber }>('POST', { invalidate: [[...NUMBERS_KEY]] });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run('/numbers', { purpose, ...(area ? { areaCode: area } : {}), ...(purpose === 'agent_direct' && user ? { assignedUserId: user } : {}), ...(registrations[0] ? { registrationId: registrations[0].id } : {}) });
    if (r.ok) {
      setArea('');
      onDone(`${formatPhone(r.data.number.e164)} added`);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 md:flex-row md:items-end" aria-label="Get a number">
      <SelectField label="New number for" value={purpose} onChange={(e) => setPurpose(e.target.value)} className="md:w-64">
        {PURPOSES.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </SelectField>
      {purpose === 'agent_direct' ? (
        <SelectField label="Agent" value={user} onChange={(e) => setUser(e.target.value)} className="md:w-64">
          <option value="">Pick someone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </SelectField>
      ) : null}
      <TextField label="Area code (optional)" inputMode="numeric" maxLength={3} value={area} onChange={(e) => setArea(e.target.value.replace(/\D/g, ''))} className="md:w-48" />
      <Button type="submit" pending={a.pending} disabled={(area !== '' && !/^[2-9]\d{2}$/.test(area)) || (purpose === 'agent_direct' && !user)}>
        Get number
      </Button>
      <ErrorLine message={a.error?.message} />
    </form>
  );
}

function RegistrationForm({ onCreated }: { onCreated(r: Registration): void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'a2p_campaign' | 'toll_free_verification'>('a2p_campaign');
  const [useCase, setUseCase] = useState('');
  const [sample, setSample] = useState('');
  const [optIn, setOptIn] = useState('');
  const a = useAction<Record<string, unknown>, { registration: Registration }>('POST', { invalidate: [[...NUMBERS_KEY]] });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run('/sender-registrations', { kind, useCase: useCase.trim(), sampleMessages: sample.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5), optInDescription: optIn.trim() });
    if (r.ok) {
      setOpen(false);
      onCreated(r.data.registration);
    }
  };
  return (
    <Section
      title="Texting registration"
      description="Carriers require every business that texts to register what it sends and how people agree to it. Numbers can text once a registration is approved."
      actions={
        !open ? (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Start a registration
          </Button>
        ) : null
      }
    >
      {open ? (
        <Card>
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
            <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="a2p_campaign">Local numbers (A2P 10DLC campaign)</option>
              <option value="toll_free_verification">Toll-free number verification</option>
            </SelectField>
            <TextField label="What you text people about" value={useCase} onChange={(e) => setUseCase(e.target.value)} maxLength={200} hint="For example: replies to home buyers and sellers who contacted the team." />
            <TextArea label="Example messages" value={sample} onChange={(e) => setSample(e.target.value)} hint="One per line, up to 5." />
            <TextArea label="How people agree to texts" value={optIn} onChange={(e) => setOptIn(e.target.value)} hint="For example: a checkbox on our website form that says we may text them." />
            <ErrorLine message={a.error?.message} />
            <div className="flex gap-2">
              <Button type="submit" pending={a.pending} disabled={useCase.trim().length < 3 || !sample.trim() || optIn.trim().length < 10}>
                Save registration
              </Button>
              <Button variant="quiet" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
    </Section>
  );
}

function checkTone(v: string): 'ok' | 'danger' | 'neutral' {
  return v === 'pass' ? 'ok' : v === 'fail' ? 'danger' : 'neutral';
}

function checkWord(v: string): string {
  return v === 'pass' ? 'passing' : v === 'fail' ? 'failing' : 'not checked yet';
}

function Domains({ onDone }: { onDone(t: string): void }) {
  const [domain, setDomain] = useState('');
  const [seen, setSeen] = useState<SendingDomain[]>([]);
  const add = useAction<{ domain: string }, { domain: SendingDomain }>('POST');
  const verify = useAction<Record<string, never>, { domain: SendingDomain }>('POST');
  const keep = (d: SendingDomain) => setSeen((s) => [d, ...s.filter((x) => x.id !== d.id)]);
  return (
    <Section title="Sending domains" description="Email to clients goes out from your own domain, so add these DNS records where your domain is managed.">
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await add.run('/sending-domains', { domain: domain.trim().toLowerCase() });
          if (r.ok) {
            keep(r.data.domain);
            setDomain('');
            onDone(`${r.data.domain.domain} added`);
          }
        }}
      >
        <TextField label="Domain" placeholder="mail.yourteam.com" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={domain} onChange={(e) => setDomain(e.target.value)} className="sm:flex-1" />
        <Button type="submit" variant="secondary" pending={add.pending} disabled={!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim())}>
          Add domain
        </Button>
      </form>
      <ErrorLine message={(add.error ?? verify.error)?.message} />
      {seen.length === 0 ? <p className="text-[14px] text-ink-muted">Domains added earlier are not listed here yet; add one again to see its records and check it.</p> : null}
      <ul className="flex flex-col gap-2">
        {seen.map((d) => (
          <li key={d.id}>
            <Card className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="flex-1 text-[16px] font-semibold text-ink">{d.domain}</p>
                {d.verifiedAt ? <Pill tone="ok">Verified {formatDate(d.verifiedAt)}</Pill> : <Pill tone="warn">Not verified</Pill>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Pill tone={checkTone(d.spf)}>SPF {checkWord(d.spf)}</Pill>
                <Pill tone={checkTone(d.dkim)}>DKIM {checkWord(d.dkim)}</Pill>
                <Pill tone={checkTone(d.dmarc)}>DMARC {checkWord(d.dmarc)}</Pill>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[14px]">
                  <thead className="text-ink-muted">
                    <tr>
                      <th scope="col" className="py-1 pr-3 font-semibold">
                        Type
                      </th>
                      <th scope="col" className="py-1 pr-3 font-semibold">
                        Name
                      </th>
                      <th scope="col" className="py-1 font-semibold">
                        Value
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.records.map((r) => (
                      <tr key={`${r.type}:${r.name}`} className="border-t border-line align-top">
                        <td className="py-1 pr-3 font-mono">{r.type}</td>
                        <td className="break-all py-1 pr-3 font-mono">{r.name}</td>
                        <td className="break-all py-1 font-mono">{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <Button
                  variant="secondary"
                  pending={verify.pending}
                  onClick={async () => {
                    const r = await verify.run(`/sending-domains/${d.id}/verify`, {});
                    if (r.ok) {
                      keep(r.data.domain);
                      onDone(r.data.domain.verifiedAt ? `${d.domain} is verified` : `${d.domain} is not verified yet`);
                    }
                  }}
                >
                  Check DNS now
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Identities({ people, onDone }: { people: { id: string; label: string }[]; onDone(t: string): void }) {
  const [from, setFrom] = useState('');
  const [name, setName] = useState('');
  const [user, setUser] = useState('');
  const [added, setAdded] = useState<EmailIdentity[]>([]);
  const a = useAction<Record<string, unknown>, { identity: EmailIdentity }>('POST');
  return (
    <Section title="Email senders" description="The name and address clients see on email from the team or from one agent.">
      <form
        className="flex flex-col gap-3 md:flex-row md:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await a.run('/email-identities', { fromAddress: from.trim(), displayName: name.trim(), ...(user ? { userId: user } : {}) });
          if (r.ok) {
            setAdded((x) => [r.data.identity, ...x]);
            setFrom('');
            setName('');
            onDone(`${r.data.identity.fromAddress} added`);
          }
        }}
      >
        <TextField label="From address" type="email" value={from} onChange={(e) => setFrom(e.target.value)} className="md:flex-1" />
        <TextField label="Name clients see" value={name} onChange={(e) => setName(e.target.value)} className="md:flex-1" maxLength={100} />
        <SelectField label="Used by" value={user} onChange={(e) => setUser(e.target.value)} className="md:w-56">
          <option value="">The whole team</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </SelectField>
        <Button type="submit" variant="secondary" pending={a.pending} disabled={!from.includes('@') || !name.trim()}>
          Add sender
        </Button>
      </form>
      <ErrorLine message={a.error?.message} />
      {added.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {added.map((i) => (
            <li key={i.id} className="text-[15px] text-ink">
              {i.displayName} &lt;{i.fromAddress}&gt;
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
