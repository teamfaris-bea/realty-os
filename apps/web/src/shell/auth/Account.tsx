// Creating a team account, password reset (request + confirm), and accepting an invite.
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Button, Notice, TextField } from '../../design/index.js';
import { pathAfterAuth, sessionGate } from '../authApi.js';
import { useSession, useShell } from '../context.js';
import { AuthFrame, FormError, safeSession, useAuthAction, useHashToken } from './AuthFrame.js';

/** "Harbor Home Team" → "harbor-home-team" (the server's slug rule: [a-z0-9][a-z0-9-]{1,40}). */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/g, '');
}

function timeZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (list && list.length > 0) return list;
  } catch {
    // older browsers: fall through
  }
  return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

const PASSWORD_HINT = 'At least 12 characters. A few unrelated words work well.';

export function SignupPage() {
  const { auth } = useShell();
  const { session, setSession } = useSession();
  const navigate = useNavigate();
  const a = useAuthAction();
  const zones = useMemo(timeZones, []);
  const [f, setF] = useState({ displayName: '', email: '', password: '', teamName: '', slug: '', timezone: localZone(), brokerageLegalName: '' });
  const [slugEdited, setSlugEdited] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  if (session && sessionGate(session) === 'ready') return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await a.run(() => auth.signup({ ...f, email: f.email.trim(), slug: f.slug || slugify(f.teamName) }));
    if (!res) return;
    setSession(res.session);
    navigate(pathAfterAuth(res.session, '/'), { replace: true });
  };

  return (
    <AuthFrame
      title="Create your team"
      intro="You'll be the account owner. You can invite your agents next."
      footer={
        <p className="text-ink-muted">
          Already have an account?{' '}
          <Link className="text-accent underline underline-offset-4" to="/login">
            Sign in
          </Link>
        </p>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <TextField label="Your name" autoComplete="name" value={f.displayName} onChange={set('displayName')} required maxLength={120} />
        <TextField label="Email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" value={f.email} onChange={set('email')} required />
        <TextField label="Password" type="password" autoComplete="new-password" hint={PASSWORD_HINT} value={f.password} onChange={set('password')} required minLength={12} />
        <TextField
          label="Team name"
          autoComplete="organization"
          value={f.teamName}
          onChange={(e) => {
            const v = e.target.value;
            setF((x) => ({ ...x, teamName: v, slug: slugEdited ? x.slug : slugify(v) }));
          }}
          required
          maxLength={120}
        />
        <TextField
          label="Team web address"
          hint="Lowercase letters, numbers and dashes. Used to tell your teams apart."
          autoCapitalize="none"
          spellCheck={false}
          value={f.slug}
          onChange={(e) => {
            setSlugEdited(true);
            setF((x) => ({ ...x, slug: e.target.value.toLowerCase() }));
          }}
          pattern="[a-z0-9][a-z0-9\-]{1,40}"
          required
        />
        <TextField
          label="Brokerage legal name"
          hint="Shown on every marketing message your team sends."
          autoComplete="organization"
          value={f.brokerageLegalName}
          onChange={set('brokerageLegalName')}
          required
          maxLength={200}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="signup-tz" className="text-[15px] font-medium text-ink">
            Team time zone
          </label>
          <select id="signup-tz" className="min-h-tap w-full rounded-xl border border-line bg-surface px-3 text-[17px] text-ink" value={f.timezone} onChange={set('timezone')}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
        <FormError message={a.error} />
        <Button type="submit" block pending={a.pending} pendingLabel="Creating your team">
          Create team
        </Button>
      </form>
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const { auth } = useShell();
  const a = useAuthAction();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await a.run(() => auth.resetRequest(email.trim()));
    if (res) setSent(true);
  };

  return (
    <AuthFrame
      title="Reset your password"
      footer={
        <Link className="inline-flex min-h-tap items-center text-accent" to="/login">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        // the same answer whether or not the account exists (the server is uniform too)
        <Notice tone="ok" title="Check your email">
          If an account uses {email.trim()}, we sent it a link to choose a new password. The link works once and expires in 30 minutes.
        </Notice>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <TextField label="Email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <FormError message={a.error} />
          <Button type="submit" block pending={a.pending} pendingLabel="Sending">
            Send reset link
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

const RESET_KEY = 'realty.resetToken';

export function ResetPasswordPage() {
  const { auth } = useShell();
  const { setSession } = useSession();
  const token = useHashToken(RESET_KEY);
  const a = useAuthAction();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    const res = await a.run(() => auth.resetConfirm(token ?? '', password));
    if (!res) return;
    // the server revoked every session of this user (and cleared this browser's cookie)
    safeSession(() => window.sessionStorage.removeItem(RESET_KEY));
    setSession(null);
    setDone(true);
  };

  return (
    <AuthFrame title="Choose a new password">
      {!token ? (
        <Notice tone="error" title="This link is incomplete">
          Open the link from the email again, or{' '}
          <Link className="underline underline-offset-4" to="/forgot-password">
            request a new one
          </Link>
          .
        </Notice>
      ) : done ? (
        <div className="flex flex-col gap-4">
          <Notice tone="ok" title="Password changed">
            You were signed out everywhere, including other devices. Sign in with your new password.
          </Notice>
          <Link className="inline-flex min-h-tap items-center justify-center rounded-xl bg-accent px-4 text-[17px] font-semibold text-accent-ink" to="/login">
            Sign in
          </Link>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <TextField label="New password" type="password" autoComplete="new-password" hint={PASSWORD_HINT} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
          <TextField
            label="New password again"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            error={mismatch ? "The two passwords don't match." : null}
            required
          />
          <FormError message={a.error} />
          {a.code === 'RESET_TOKEN_INVALID' ? (
            <Link className="inline-flex min-h-tap items-center text-accent" to="/forgot-password">
              Request a new link
            </Link>
          ) : null}
          <Button type="submit" block pending={a.pending} pendingLabel="Saving">
            Save password
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

const INVITE_KEY = 'realty.pendingInvite';

export function InvitePage() {
  const { auth } = useShell();
  const { session, setSession } = useSession();
  const navigate = useNavigate();
  const params = useParams<{ token?: string }>();
  const hashToken = useHashToken(INVITE_KEY);
  const [token] = useState(() => {
    if (params.token) {
      safeSession(() => window.sessionStorage.setItem(INVITE_KEY, params.token!));
      return params.token;
    }
    return hashToken;
  });
  const a = useAuthAction();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');

  // keep the token out of the address bar (it is a bearer secret until accepted)
  useEffect(() => {
    if (params.token) navigate('/invite', { replace: true });
  }, [params.token, navigate]);

  const signedIn = session != null && sessionGate(session) !== 'mfa_verify';

  const accept = async (body: { displayName?: string; password?: string }) => {
    const res = await a.run(() => auth.acceptInvite(token ?? '', body));
    if (!res) return;
    safeSession(() => window.sessionStorage.removeItem(INVITE_KEY));
    setSession(res.session);
    navigate(pathAfterAuth(res.session, '/'), { replace: true });
  };

  if (!token) {
    return (
      <AuthFrame title="Join your team">
        <Notice tone="error" title="This invite link is incomplete">
          Open the link from your invite email again. If it still doesn't work, ask your team admin for a new invite.
        </Notice>
      </AuthFrame>
    );
  }

  if (a.code === 'LOGIN_REQUIRED' && !signedIn) {
    return (
      <AuthFrame title="Sign in to join" intro="This invite is for an email that already has an account. Sign in, and we'll bring you back here to finish joining.">
        <Link className="inline-flex min-h-tap w-full items-center justify-center rounded-xl bg-accent px-4 text-[17px] font-semibold text-accent-ink" to="/login?next=%2Finvite">
          Sign in
        </Link>
      </AuthFrame>
    );
  }

  if (signedIn) {
    return (
      <AuthFrame title="Join your team" intro={`You're signed in as ${session!.user.email}. Accepting adds this team to your account.`}>
        <div className="flex flex-col gap-4">
          <FormError message={a.error} />
          <Button block pending={a.pending} pendingLabel="Joining" onClick={() => void accept({})}>
            Accept invite
          </Button>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Join your team"
      intro="Create your account to accept the invite."
      footer={
        <p className="text-ink-muted">
          Already have an account?{' '}
          <Link className="text-accent underline underline-offset-4" to="/login?next=%2Finvite">
            Sign in first
          </Link>
        </p>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void accept({ displayName: displayName.trim(), password });
        }}
      >
        <TextField label="Your name" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={120} />
        <TextField label="Password" type="password" autoComplete="new-password" hint={PASSWORD_HINT} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
        <FormError message={a.error} />
        <Button type="submit" block pending={a.pending} pendingLabel="Joining">
          Join team
        </Button>
      </form>
    </AuthFrame>
  );
}
