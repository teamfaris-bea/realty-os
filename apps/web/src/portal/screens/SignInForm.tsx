// module 46 (R-PORTALWEB-4; E704, E706, E707, E719): the sign-in request. The team comes only from ?team= or the
// remembered slug, never guessed; without one there is no form, only how to get in. Every answer is 45's sentence,
// verbatim, in the visible notice and the live region; the page never says a link was sent. The form has no action:
// a submit is handled in script, and the portal CSP's form-action 'none' stops a no-JS submit from putting the
// address in a URL.
import { type FormEvent, useId, useState } from 'react';
import { PortalError } from '../api.js';
import { API_SENTENCES, COPY, sentenceFor } from '../copy.js';
import { usePortal } from '../context.js';
import { parseLoginAccepted } from '../view/index.js';
import { primaryButton, secondaryButton } from './common.js';

type Channel = 'email' | 'sms';

export function NoTeam() {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-[19px] font-semibold text-ink">{COPY.noTeamTitle}</h2>
      <p className="text-[16px] text-ink">{COPY.noTeamBody}</p>
    </div>
  );
}

export function SignInForm({ onUnavailable }: { onUnavailable(): void }) {
  const { api, team, announce } = usePortal();
  const [channel, setChannel] = useState<Channel>('email');
  const [address, setAddress] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const ids = { email: useId(), sms: useId(), field: useId(), notice: useId() };
  if (!team) return <NoTeam />;

  const say = (text: string, tone: 'ok' | 'error') => {
    setNotice({ text, tone });
    announce(text);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    // b15 audit P46-UI-1: 45 sends by email when the address holds '@' and by text otherwise, so an address that does
    // not fit the chosen channel is refused here, with 45's sentence: the page never claims a choice it does not apply
    const a = address.trim();
    if (a.length < 3 || (channel === 'email') !== a.includes('@')) {
      say(channel === 'email' ? API_SENTENCES.EMAIL_INVALID : API_SENTENCES.PHONE_INVALID, 'error');
      return;
    }
    setPending(true);
    try {
      await api.request('POST', '/api/portal/login', parseLoginAccepted, { team, address: a });
      setAccepted(true);
      setAddress('');
      say(API_SENTENCES.SIGNIN_ACCEPTED, 'ok');
    } catch (err) {
      const code = err instanceof PortalError ? err.code : 'BAD_RESPONSE';
      const ch = err instanceof PortalError ? err.details?.channel : undefined;
      if (code === 'PORTAL_NOT_AVAILABLE' && (ch === 'sms' || ch === 'email')) say(ch === 'sms' ? COPY.smsOff : COPY.emailOff, 'error');
      else if (code === 'PORTAL_NOT_AVAILABLE') onUnavailable();
      else say(sentenceFor(code), 'error');
    } finally {
      setPending(false);
    }
  };

  if (accepted) {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
        <p className="text-[16px] text-ink">{notice?.text ?? API_SENTENCES.SIGNIN_ACCEPTED}</p>
        <button
          type="button"
          className={`${secondaryButton} self-start`}
          onClick={() => {
            setAccepted(false);
            setNotice(null);
            setAddress('');
          }}
        >
          {COPY.useDifferent}
        </button>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={submit} aria-describedby={notice ? ids.notice : undefined} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[15px] font-semibold text-ink">{COPY.sendBy}</legend>
        <div className="flex flex-wrap gap-2">
          {(['email', 'sms'] as const).map((c) => (
            <label key={c} htmlFor={ids[c]} className="inline-flex min-h-tap cursor-pointer items-center gap-2 rounded-xl border border-line px-3 text-[16px] text-ink has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
              <input
                id={ids[c]}
                type="radio"
                name="portal-channel"
                value={c}
                checked={channel === c}
                onChange={() => {
                  setChannel(c);
                  setAddress('');
                  setNotice(null);
                }}
                className="h-5 w-5 accent-[var(--accent)]"
              />
              {c === 'email' ? COPY.byEmail : COPY.byText}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.field} className="text-[15px] font-semibold text-ink">
          {channel === 'email' ? COPY.emailLabel : COPY.phoneLabel}
        </label>
        <input
          id={ids.field}
          key={channel}
          type={channel === 'email' ? 'email' : 'tel'}
          inputMode={channel === 'email' ? 'email' : 'tel'}
          autoComplete={channel === 'email' ? 'email' : 'tel'}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={320}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="min-h-tap w-full rounded-xl border border-line bg-surface-2 px-3 text-[17px] text-ink"
        />
      </div>
      {notice ? (
        <p id={ids.notice} className={`rounded-lg px-3 py-2 text-[15px] text-ink ${notice.tone === 'error' ? 'bg-danger-soft' : 'bg-ok-soft'}`}>
          {notice.text}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={`${primaryButton} self-start`}>
        {pending ? COPY.sending : COPY.sendLink}
      </button>
    </form>
  );
}
