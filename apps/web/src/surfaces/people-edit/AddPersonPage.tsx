// Add a person (PARITY_PLAN §5: + → Save = 2 taps, +1 on a duplicate warning; desktop + → ↵ = 1).
// It is the existing POST /contacts, which dedups exactly as intake does (R-OWN-25, R-PAR-44): an exact
// phone/email match is shown before anything is created. A match the agent can see links to it; one they
// cannot see names only its owner ("Ask Sam to share"), never the person (R-PERM-12). "Create anyway" is
// for people who really share a number or email (spouses); a duplicate candidate is recorded.
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, Notice, TextField, useStickyBottom } from '../../design/index.js';
import { ApiError, newCommandId, useApi } from '../../shell/index.js';
import { intentLabel } from '../feed/lib/format.js';
import { peopleMessage, selectClass } from './hooks.js';

const INTENTS = ['buyer', 'seller', 'buyer_seller', 'renter', 'landlord', 'investor'] as const;

interface Match {
  contactId: string | null;
  ownerDisplayName: string | null;
}

export default function AddPersonPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [intent, setIntent] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const commandId = useRef(newCommandId());
  const intentId = useId();
  const stickyRef = useStickyBottom<HTMLDivElement>();

  const save = async (confirmDistinct: boolean) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const r = await api.request<{ contact: { id: string } }>('POST', '/contacts', {
        commandId: commandId.current,
        ...(first.trim() ? { firstName: first.trim() } : {}),
        ...(last.trim() ? { lastName: last.trim() } : {}),
        ...(phone.trim() ? { phones: [phone.trim()] } : {}),
        ...(email.trim() ? { emails: [email.trim()] } : {}),
        ...(intent ? { intent } : {}),
        ...(confirmDistinct ? { confirmDistinct: true } : {}),
      });
      navigate(`/contacts/${r.contact.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_CONTACT') {
        setMatches(((e.details?.matches as Match[] | undefined) ?? []).slice(0, 5));
      } else setError(peopleMessage(e));
    } finally {
      setPending(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void save(false);
  };

  const empty = !first.trim() && !last.trim();
  return (
    <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-xl flex-col gap-4 md:mx-0" aria-label="Add a person">
      <Card className="flex flex-col gap-4">
        <TextField label="First name" value={first} onChange={(e) => setFirst(e.target.value)} autoFocus autoComplete="off" />
        <TextField label="Last name" value={last} onChange={(e) => setLast(e.target.value)} autoComplete="off" />
        <TextField label="Mobile" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
        <TextField label="Email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={intentId} className="text-[15px] font-medium text-ink">
            Looking to
          </label>
          <select id={intentId} value={intent} onChange={(e) => setIntent(e.target.value)} className={selectClass}>
            <option value="">Not set</option>
            {INTENTS.map((x) => (
              <option key={x} value={x}>
                {intentLabel(x)}
              </option>
            ))}
          </select>
        </div>
        <p className="text-[14px] text-ink-muted">They’re yours once saved. Nothing is sent to them.</p>
      </Card>
      {matches ? (
        <Notice tone="warn">
          <span className="block font-semibold">This may already be someone in Realty OS.</span>
          <ul className="mt-1 flex flex-col gap-1">
            {matches.map((m, i) => (
              <li key={m.contactId ?? `hidden-${i}`}>
                {m.contactId ? (
                  <Link to={`/contacts/${m.contactId}`} className="inline-flex min-h-tap items-center font-medium text-accent underline">
                    Open the existing person
                  </Link>
                ) : (
                  <span>Someone {m.ownerDisplayName ? `${m.ownerDisplayName} works with` : 'on the team works with'} has this phone or email. Ask them to share.</span>
                )}
              </li>
            ))}
          </ul>
          <Button variant="secondary" className="mt-2" pending={pending} onClick={() => void save(true)}>
            Create anyway (a different person)
          </Button>
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div ref={stickyRef} data-sticky className="sticky bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+8px)] md:static">
        <Button type="submit" block pending={pending} disabled={empty}>
          Save
        </Button>
      </div>
    </form>
  );
}
