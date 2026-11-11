// Sign in, two-step verification (verify + enroll), and choosing a team.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Button, Card, Notice, TextField, safeUrl } from '../../design/index.js';
import { pathAfterAuth, sessionGate } from '../authApi.js';
import { useSession, useShell } from '../context.js';
import { ROLE_LABEL } from '../Layout.js';
import { useWithReauth } from '../reauth.js';
import { AuthFrame, FormError, useAuthAction, useNextParam } from './AuthFrame.js';

export function LoginPage() {
  const { auth } = useShell();
  const { session, setSession } = useSession();
  const navigate = useNavigate();
  const next = useNextParam();
  const a = useAuthAction();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (session && sessionGate(session) === 'ready') return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await a.run(() => auth.login(email.trim(), password));
    if (!res) {
      setPassword('');
      return;
    }
    setSession(res.session);
    navigate(pathAfterAuth(res.session, next), { replace: true });
  };

  return (
    <AuthFrame
      title="Sign in"
      footer={
        <>
          <Link className="inline-flex min-h-tap items-center text-accent" to="/forgot-password">
            Forgot your password?
          </Link>
          <p className="text-ink-muted">
            New team?{' '}
            <Link className="text-accent underline underline-offset-4" to="/signup">
              Create an account
            </Link>
          </p>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate={false}>
        <TextField label="Email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <FormError message={a.error} />
        <Button type="submit" block pending={a.pending} pendingLabel="Signing in">
          Sign in
        </Button>
      </form>
    </AuthFrame>
  );
}

export function MfaVerifyPage() {
  const { auth } = useShell();
  const { session, setSession, signOut } = useSession();
  const navigate = useNavigate();
  const next = useNextParam();
  const a = useAuthAction();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');

  if (session === null) return <Navigate to="/login" replace />;
  if (session && sessionGate(session) !== 'mfa_verify') return <Navigate to={pathAfterAuth(session, next)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await a.run(() => auth.mfaVerify(useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() }));
    if (!res) {
      setCode('');
      return;
    }
    setSession(res.session);
    navigate(pathAfterAuth(res.session, next), { replace: true });
  };

  return (
    <AuthFrame
      title="Two-step verification"
      intro={useRecovery ? 'Enter one of the recovery codes you saved when you set up two-step verification. Each code works once.' : 'Enter the 6-digit code from your authenticator app.'}
      footer={
        <>
          <button
            type="button"
            className="inline-flex min-h-tap items-center text-left text-accent"
            onClick={() => {
              setUseRecovery((v) => !v);
              setCode('');
              a.setError(null);
            }}
          >
            {useRecovery ? 'Use the authenticator code instead' : 'Lost your phone? Use a recovery code'}
          </button>
          <button type="button" className="inline-flex min-h-tap items-center text-left text-accent" onClick={() => void signOut()}>
            Sign out
          </button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {useRecovery ? (
          <TextField key="recovery" label="Recovery code" autoComplete="off" autoCapitalize="none" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} required minLength={8} maxLength={32} />
        ) : (
          <TextField
            key="totp"
            label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
          />
        )}
        <FormError message={a.error} />
        <Button type="submit" block pending={a.pending} pendingLabel="Checking">
          Continue
        </Button>
      </form>
    </AuthFrame>
  );
}

/** Groups a base32 secret for reading aloud / typing: "ABCD EFGH ...". */
export function groupSecret(s: string): string {
  return s.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

export function MfaEnrollPage() {
  const { auth } = useShell();
  const { session, setSession, signOut } = useSession();
  const navigate = useNavigate();
  const next = useNextParam();
  const withReauth = useWithReauth();
  const start = useAuthAction();
  const confirm = useAuthAction();
  const [secret, setSecret] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const canEnroll = session != null && !session.mfa.enabled;

  // Start enrollment exactly once per page visit: every POST /auth/mfa/enroll issues a NEW secret,
  // so a second call (React StrictMode runs effects twice in development) would make the key on
  // screen stale. The ref survives StrictMode's simulated remount.
  const started = useRef(false);
  const begin = () => void start.run(() => withReauth(() => auth.mfaEnroll())).then((r) => r && setSecret(r));
  useEffect(() => {
    if (!canEnroll || started.current) return;
    started.current = true;
    begin();
  });

  if (session === null) return <Navigate to="/login" replace />;
  if (session && session.mfa.enabled && !recovery) return <Navigate to={pathAfterAuth(session, next)} replace />;

  if (recovery) {
    const text = recovery.join('\n');
    return (
      <AuthFrame title="Save your recovery codes" intro="If you lose your phone, each of these codes lets you sign in once. Store them somewhere safe, like a password manager. You won't see them again.">
        <Card>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-[16px] text-ink" aria-label="Recovery codes">
            {recovery.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Card>
        <div className="mt-4 flex flex-col gap-3">
          <Button
            variant="secondary"
            block
            onClick={() => {
              void navigator.clipboard
                ?.writeText(text)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? 'Copied' : 'Copy codes'}
          </Button>
          <Button block onClick={() => navigate(pathAfterAuth(session ?? null, next), { replace: true })}>
            I saved them, continue
          </Button>
        </div>
      </AuthFrame>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await confirm.run(() => withReauth(() => auth.mfaEnrollConfirm(code.trim())));
    if (!res) {
      setCode('');
      return;
    }
    setRecovery(res.recoveryCodes);
    setSession(res.session);
  };

  // the deep link comes from the API response: only an otpauth: URI may become an href
  const authenticatorLink = secret ? safeUrl(secret.otpauthUri, { allow: ['otpauth:'] }) : null;

  return (
    <AuthFrame
      title="Set up two-step verification"
      intro={session?.mfa.enrollmentRequired ? 'Your role needs a second step at sign-in. It takes about a minute.' : 'Add a second step at sign-in. It takes about a minute.'}
      footer={
        <button type="button" className="inline-flex min-h-tap items-center text-left text-accent" onClick={() => void signOut()}>
          Sign out
        </button>
      }
    >
      <ol className="flex list-decimal flex-col gap-4 pl-5 text-[16px] text-ink">
        <li>Open an authenticator app on your phone (for example 1Password, Google Authenticator or Microsoft Authenticator).</li>
        <li>
          Add an account with this setup key.
          {secret ? (
            <div className="mt-2 flex flex-col gap-2">
              <code className="block select-all rounded-xl bg-surface-2 px-3 py-2 font-mono text-[17px] tracking-wider text-ink" aria-label="Setup key">
                {groupSecret(secret.secret)}
              </code>
              {authenticatorLink ? (
                <a className="inline-flex min-h-tap items-center text-accent md:hidden" href={authenticatorLink}>
                  Open in authenticator app
                </a>
              ) : null}
            </div>
          ) : start.pending ? (
            <p className="mt-2 text-ink-muted">Getting your setup key…</p>
          ) : null}
        </li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {start.error ? (
        <div className="mt-4 flex flex-col gap-3">
          <FormError message={start.error} />
          <Button variant="secondary" onClick={begin}>
            Try again
          </Button>
        </div>
      ) : null}
      <form className="mt-5 flex flex-col gap-4" onSubmit={submit}>
        <TextField
          label="Code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          disabled={!secret}
          required
        />
        <FormError message={confirm.error} />
        <Button type="submit" block pending={confirm.pending} pendingLabel="Checking" disabled={!secret}>
          Turn on two-step verification
        </Button>
      </form>
    </AuthFrame>
  );
}

export function ChooseTeamPage() {
  const { auth } = useShell();
  const { session, setSession, signOut } = useSession();
  const navigate = useNavigate();
  const next = useNextParam();
  const a = useAuthAction();
  const [choosing, setChoosing] = useState<string | null>(null);

  if (session === null) return <Navigate to="/login" replace />;
  if (!session) return null;
  const gate = sessionGate(session);
  if (gate === 'mfa_verify' || gate === 'mfa_enroll') return <Navigate to={pathAfterAuth(session, next)} replace />;

  const choose = async (slug: string) => {
    if (session.tenant?.slug === slug) {
      navigate(next, { replace: true });
      return;
    }
    setChoosing(slug);
    const res = await a.run(() => auth.tenantSwitch(slug));
    setChoosing(null);
    if (!res) return;
    setSession(res.session);
    navigate(pathAfterAuth(res.session, next), { replace: true });
  };

  return (
    <AuthFrame
      title="Choose a team"
      intro={session.tenants.length === 0 ? undefined : 'You belong to more than one team. You can switch later from your account.'}
      footer={
        <button type="button" className="inline-flex min-h-tap items-center text-left text-accent" onClick={() => void signOut()}>
          Sign out
        </button>
      }
    >
      {session.tenants.length === 0 ? (
        <Notice tone="info" title="You're not on a team yet">
          Ask your team's admin to send you an invite. The link in that email adds you to the team.
        </Notice>
      ) : (
        <ul className="flex flex-col gap-2">
          {session.tenants.map((t) => (
            <li key={t.id}>
              <Button variant="secondary" block className="justify-between" pending={choosing === t.slug} onClick={() => void choose(t.slug)} aria-current={session.tenant?.id === t.id ? 'true' : undefined}>
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{t.name}</span>
                  <span className="text-[14px] font-normal text-ink-muted">{ROLE_LABEL[t.role]}</span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <FormError message={a.error} />
      </div>
    </AuthFrame>
  );
}
