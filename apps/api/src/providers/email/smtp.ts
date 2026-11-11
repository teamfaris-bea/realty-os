// Generic outbound SMTP email adapter (Postmark, Amazon SES, SendGrid, Mailgun SMTP relays, or any
// RFC 5321 submission server). No dependencies beyond node:net / node:tls / node:dns.
//
// - One connection per message: connect (implicit TLS, STARTTLS or plain), EHLO (HELO fallback),
//   AUTH PLAIN/LOGIN when credentials are set, MAIL FROM, RCPT TO, DATA (dot-stuffed), QUIT.
// - AUTH is never sent over an unencrypted connection unless `secure: 'none'` was chosen explicitly.
//   With `secure: 'starttls'` a server that does not offer STARTTLS fails the send (no downgrade).
// - Error mapping (ProviderError, see types.ts):
//     timeout / connection loss AFTER the message body was sent → 'timeout' (outcome unknown: the
//       dispatch layer reconciles; it never blind-resends)
//     timeout / connection error before that → 'unavailable' (nothing was handed over)
//     4xx → 'unavailable' SMTP_<code>; 5xx → 'rejected' SMTP_<code>; AUTH 5xx → 'not_configured' SMTP_AUTH
// - Errors and logs never carry addresses, subjects, bodies or credentials: only kind + code.
import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import {
  type AccountMailer,
  type DomainVerification,
  type EmailProvider,
  type EmailRequest,
  ProviderError,
  type ProviderMessageStatus,
} from '../types.js';
import { buildMessage, checkAddress, dotStuff, makeMessageId } from './mime.js';

export type SmtpVendor = 'generic' | 'postmark' | 'sendgrid' | 'ses' | 'mailgun';

/** The part of node:dns/promises verifyDomain uses (injectable for tests). */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** 'tls' = implicit TLS (465), 'starttls' = required STARTTLS upgrade (587), 'none' = plaintext (explicit opt-in) */
  secure: 'tls' | 'starttls' | 'none';
  username?: string;
  password?: string;
  /** EHLO name (default 'localhost') */
  heloName?: string;
  /** socket idle timeout per step (default 30 000 ms) */
  timeoutMs?: number;
  vendor?: SmtpVendor;
  postmarkMessageStream?: string;
  sesConfigurationSet?: string;
  /** default true; set false in tests only */
  tlsRejectUnauthorized?: boolean;
  /** PEM CA bundle to trust instead of the default roots (e.g. a private relay) */
  ca?: string;
  now?: () => Date;
  /** verifyDomain: DKIM selectors to check at `<selector>._domainkey.<domain>` (default []) */
  dkimSelectors?: string[];
  /** verifyDomain: CNAME targets per selector, for the records the operator should publish */
  dkimTargets?: Record<string, string>;
  /** verifyDomain: the vendor's SPF include (e.g. 'spf.mtasv.net', 'amazonses.com') */
  spfInclude?: string;
  /** verifyDomain: DNS resolver (default node:dns/promises with a 5 s timeout) */
  resolver?: DnsResolver;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 64 * 1024;
const REALTY_REF_HEADER = 'x-realty-ref';

interface Reply {
  code: number;
  lines: string[]; // text after "NNN-" / "NNN "
}

type Phase = 'before_data' | 'after_data';

const fail = (kind: ProviderError['kind'], code: string) => new ProviderError(kind, code);

/** 4xx → unavailable, 5xx → rejected, anything else unexpected → unavailable SMTP_PROTOCOL. */
function replyError(r: Reply): ProviderError {
  if (r.code >= 400 && r.code < 500) return fail('unavailable', `SMTP_${r.code}`);
  if (r.code >= 500 && r.code < 600) return fail('rejected', `SMTP_${r.code}`);
  return fail('unavailable', 'SMTP_PROTOCOL');
}

/** One SMTP client connection. Reads multi-line replies; maps socket failures by phase. */
class SmtpConnection {
  private socket: net.Socket;
  private buf = '';
  private current: string[] = [];
  private readonly replies: Reply[] = [];
  private waiter: { resolve: (r: Reply) => void; reject: (e: ProviderError) => void } | null = null;
  private failure: ProviderError | null = null;
  phase: Phase = 'before_data';
  encrypted: boolean;

  private constructor(
    socket: net.Socket,
    encrypted: boolean,
    private readonly timeoutMs: number,
  ) {
    this.socket = socket;
    this.encrypted = encrypted;
    this.attach(socket);
  }

  static async open(o: SmtpOptions): Promise<SmtpConnection> {
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const socket: net.Socket =
      o.secure === 'tls'
        ? tls.connect({ host: o.host, port: o.port, ...tlsOpts(o) })
        : net.connect({ host: o.host, port: o.port });
    const conn = new SmtpConnection(socket, o.secure === 'tls', timeoutMs);
    await conn.waitConnected(o.secure === 'tls' ? 'secureConnect' : 'connect');
    return conn;
  }

  private onData = (chunk: Buffer | string) => {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) return this.abort(fail('unavailable', 'SMTP_PROTOCOL'));
      this.current.push(m[3] ?? '');
      if (m[2] !== '-') {
        const reply = { code: Number(m[1]), lines: this.current };
        this.current = [];
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w.resolve(reply);
        } else this.replies.push(reply);
      }
    }
    if (this.buf.length > MAX_REPLY_BYTES) this.abort(fail('unavailable', 'SMTP_PROTOCOL'));
  };

  /** Socket-level failure: after the body went out the outcome is unknown ('timeout'). */
  private lost(code: string): ProviderError {
    return this.phase === 'after_data' ? fail('timeout', code) : fail('unavailable', code);
  }
  private onTimeout = () => this.abort(this.lost('SMTP_TIMEOUT'));
  private onError = (e: NodeJS.ErrnoException) => {
    const tlsFailure = typeof e?.code === 'string' && /CERT|TLS|SSL|SELF_SIGNED|HOSTNAME|ERR_SSL/.test(e.code);
    this.abort(this.lost(tlsFailure && this.phase === 'before_data' ? 'SMTP_TLS' : 'SMTP_CONNECTION'));
  };
  private onClose = () => this.abort(this.lost('SMTP_CONNECTION'));

  private attach(s: net.Socket) {
    s.setTimeout(this.timeoutMs);
    s.on('data', this.onData);
    s.on('timeout', this.onTimeout);
    s.on('error', this.onError);
    s.on('close', this.onClose);
  }
  private detach(s: net.Socket) {
    s.off('data', this.onData);
    s.off('timeout', this.onTimeout);
    s.off('error', this.onError);
    s.off('close', this.onClose);
  }

  private abort(e: ProviderError) {
    if (!this.failure) this.failure = e;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(this.failure);
    }
    this.connectWaiter?.(this.failure);
    this.socket.destroy();
  }

  private connectWaiter: ((e: ProviderError) => void) | null = null;

  private waitConnected(event: 'connect' | 'secureConnect'): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      const done = () => {
        this.connectWaiter = null;
        resolve();
      };
      this.connectWaiter = (e) => {
        this.socket.off(event, done);
        this.connectWaiter = null;
        reject(e);
      };
      this.socket.once(event, done);
    });
  }

  read(): Promise<Reply> {
    const r = this.replies.shift();
    if (r) return Promise.resolve(r);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  write(data: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(data, 'latin1');
  }

  async command(line: string): Promise<Reply> {
    this.write(line + '\r\n');
    return this.read();
  }

  /** STARTTLS: wrap the existing socket. Any data the server sent past the 220 is an injection attempt. */
  async upgrade(o: SmtpOptions): Promise<void> {
    if (this.buf.length > 0 || this.replies.length > 0) throw fail('unavailable', 'SMTP_PROTOCOL');
    const plain = this.socket;
    this.detach(plain);
    plain.setTimeout(0);
    const secure = tls.connect({ socket: plain, ...tlsOpts(o) });
    this.socket = secure;
    this.attach(secure);
    await this.waitConnected('secureConnect');
    this.encrypted = true;
  }

  async quit(): Promise<void> {
    try {
      if (!this.failure) {
        this.socket.setTimeout(Math.min(this.timeoutMs, 2000));
        await this.command('QUIT');
      }
    } catch {
      // the message is already accepted; QUIT problems do not matter
    } finally {
      this.close();
    }
  }

  close(): void {
    if (!this.failure) this.failure = fail('unavailable', 'SMTP_CONNECTION');
    this.waiter = null;
    this.socket.destroy();
  }
}

function tlsOpts(o: SmtpOptions): tls.ConnectionOptions {
  return {
    ...(net.isIP(o.host) ? {} : { servername: o.host }),
    rejectUnauthorized: o.tlsRejectUnauthorized ?? true,
    ...(o.ca ? { ca: o.ca } : {}),
    minVersion: 'TLSv1.2',
  };
}

function want(r: Reply, ok: (code: number) => boolean): Reply {
  if (!ok(r.code)) throw replyError(r);
  return r;
}

/** EHLO keywords (upper-cased) → parameters. */
function extensions(r: Reply): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of r.lines.slice(1)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*)(?:[ =](.*))?$/.exec(line.trim());
    if (m) out.set(m[1]!.toUpperCase(), (m[2] ?? '').toUpperCase());
  }
  return out;
}

/**
 * The provider's id from the 250 reply to the end of DATA, or null:
 * Postfix/SendGrid/Postmark "Ok: queued as ABC123", SES "Ok 0100018b…-000000", Exim "OK id=1qXy-…".
 */
export function queueIdFromReply(text: string): string | null {
  const t = text.replace(/^\d\.\d{1,3}\.\d{1,3}\s+/, '').trim();
  const m =
    /queued as\s+<?([A-Za-z0-9][A-Za-z0-9._@+=-]*)>?/i.exec(t) ??
    /\bid=<?([A-Za-z0-9][A-Za-z0-9._@+=-]*)>?/i.exec(t) ??
    /^ok\s+<?([A-Za-z0-9][A-Za-z0-9._@+=-]{7,})>?\s*$/i.exec(t);
  const id = m?.[1];
  return id && id.length <= 200 ? id : null;
}

/** Vendor metadata so bounce/complaint webhooks echo our ref (in addition to X-Realty-Ref itself). */
export function vendorHeaders(o: Pick<SmtpOptions, 'vendor' | 'postmarkMessageStream' | 'sesConfigurationSet'>, headers: Record<string, string> | undefined): [string, string][] {
  const out: [string, string][] = [];
  const ref = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === REALTY_REF_HEADER)?.[1];
  switch (o.vendor ?? 'generic') {
    case 'postmark':
      if (ref !== undefined) out.push(['X-PM-Metadata-realty_ref', ref]);
      if (o.postmarkMessageStream) out.push(['X-PM-Message-Stream', o.postmarkMessageStream]);
      break;
    case 'sendgrid':
      if (ref !== undefined) out.push(['X-SMTPAPI', JSON.stringify({ unique_args: { realty_ref: ref } })]);
      break;
    case 'mailgun':
      if (ref !== undefined) out.push(['X-Mailgun-Variables', JSON.stringify({ realty_ref: ref })]);
      break;
    case 'ses':
      // SES tag values allow only [A-Za-z0-9_.@-]; a ref outside that set would fail the whole send,
      // so it is left to the X-Realty-Ref header (SES notifications can include original headers).
      if (ref !== undefined && /^[A-Za-z0-9_.@-]{1,256}$/.test(ref)) out.push(['X-SES-MESSAGE-TAGS', `realty_ref=${ref}`]);
      if (o.sesConfigurationSet) out.push(['X-SES-CONFIGURATION-SET', o.sesConfigurationSet]);
      break;
    case 'generic':
      break;
  }
  return out;
}

/** The shared SMTP submit used by SmtpEmail and SmtpAccountMailer. */
class SmtpTransport {
  constructor(private readonly o: SmtpOptions) {}

  async deliver(r: EmailRequest): Promise<{ providerRef: string; status: ProviderMessageStatus }> {
    const o = this.o;
    // Everything that can be rejected locally is rejected before connecting.
    const from = checkAddress(r.from.address);
    const to = checkAddress(r.to);
    const messageId = makeMessageId(r.idempotencyKey, from);
    const message = buildMessage({
      from: r.from,
      to,
      ...(r.replyTo !== undefined ? { replyTo: r.replyTo } : {}),
      subject: r.subject,
      text: r.text,
      ...(r.html !== undefined ? { html: r.html } : {}),
      ...(r.headers ? { headers: r.headers } : {}),
      vendorHeaders: vendorHeaders(o, r.headers),
      messageId,
      date: (o.now ?? (() => new Date()))(),
    });
    if ((o.username === undefined) !== (o.password === undefined)) throw fail('not_configured', 'SMTP_AUTH_INCOMPLETE');
    const hasCredentials = o.username !== undefined && o.password !== undefined;
    const helo = o.heloName ?? 'localhost';
    if (!/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/.test(helo)) throw fail('not_configured', 'SMTP_HELO_INVALID');

    const conn = await SmtpConnection.open(o);
    try {
      want(await conn.read(), (c) => c === 220);
      let ext = await this.hello(conn, helo);

      if (o.secure === 'starttls') {
        if (!ext.has('STARTTLS')) throw fail('not_configured', 'SMTP_STARTTLS_UNAVAILABLE');
        want(await conn.command('STARTTLS'), (c) => c === 220);
        await conn.upgrade(o);
        ext = await this.hello(conn, helo);
      }

      if (hasCredentials) {
        // Never send credentials in the clear unless plaintext was chosen explicitly.
        if (!conn.encrypted && o.secure !== 'none') throw fail('not_configured', 'SMTP_AUTH_PLAINTEXT');
        await this.auth(conn, ext, o.username!, o.password!);
      }

      want(await conn.command(`MAIL FROM:<${from}>`), (c) => c === 250);
      want(await conn.command(`RCPT TO:<${to}>`), (c) => c === 250 || c === 251);
      want(await conn.command('DATA'), (c) => c === 354);

      // From here on the server may have the message: a lost connection is an unknown outcome.
      conn.phase = 'after_data';
      conn.write(dotStuff(message) + '.\r\n');
      const done = want(await conn.read(), (c) => c === 250);
      const providerRef = queueIdFromReply(done.lines.join(' ')) ?? messageId.slice(1, -1);
      await conn.quit();
      // module 22 (R-GMAIL-12): the Message-ID we generated, reported only where the relay keeps it. A plain SMTP
      // server does; SES, Mailgun, SendGrid and Postmark may assign their own (VERIFY per vendor), so none is reported.
      return { providerRef, status: 'queued', ...((o.vendor ?? 'generic') === 'generic' ? { rfcMessageId: messageId } : {}) };
    } finally {
      conn.close();
    }
  }

  private async hello(conn: SmtpConnection, helo: string): Promise<Map<string, string>> {
    const ehlo = await conn.command(`EHLO ${helo}`);
    if (ehlo.code === 250) return extensions(ehlo);
    if (ehlo.code >= 500 && ehlo.code < 600) {
      want(await conn.command(`HELO ${helo}`), (c) => c === 250);
      return new Map();
    }
    throw replyError(ehlo);
  }

  private async auth(conn: SmtpConnection, ext: Map<string, string>, user: string, pass: string): Promise<void> {
    const mechs = new Set((ext.get('AUTH') ?? '').split(/\s+/).filter(Boolean));
    const authFail = (r: Reply) => (r.code >= 500 ? fail('not_configured', 'SMTP_AUTH') : replyError(r));
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    if (mechs.has('PLAIN')) {
      const r = await conn.command(`AUTH PLAIN ${b64(`\u0000${user}\u0000${pass}`)}`);
      if (r.code !== 235) throw authFail(r);
      return;
    }
    if (mechs.has('LOGIN')) {
      let r = await conn.command('AUTH LOGIN');
      if (r.code !== 334) throw authFail(r);
      r = await conn.command(b64(user));
      if (r.code !== 334) throw authFail(r);
      r = await conn.command(b64(pass));
      if (r.code !== 235) throw authFail(r);
      return;
    }
    throw fail('not_configured', 'SMTP_AUTH_UNSUPPORTED');
  }
}

function defaultResolver(): DnsResolver {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  return { resolveTxt: (n) => r.resolveTxt(n), resolveCname: (n) => r.resolveCname(n) };
}

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SELECTOR_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})$/;

export class SmtpEmail implements EmailProvider {
  private readonly transport: SmtpTransport;

  constructor(private readonly o: SmtpOptions) {
    this.transport = new SmtpTransport(o);
  }

  async sendEmail(r: EmailRequest): Promise<{ providerRef: string; status: ProviderMessageStatus }> {
    return this.transport.deliver(r);
  }

  /**
   * Generic SMTP cannot be queried by idempotency key, so this always answers null. For a
   * dispatch_unknown message (timeout after DATA) the dispatch layer keeps waiting for a delivery /
   * bounce webhook that echoes X-Realty-Ref, then fails the message after its reconcile window. It
   * never re-sends blindly.
   */
  async lookupMessage(_idempotencyKey: string): Promise<{ providerRef: string; status: ProviderMessageStatus } | null> {
    return null;
  }

  /** SPF, DKIM (configured selectors) and DMARC from DNS. DNS errors count as "not found"; never throws. */
  async verifyDomain(domain: string): Promise<DomainVerification> {
    const d = String(domain ?? '').trim().toLowerCase().replace(/\.$/, '');
    const selectors = (this.o.dkimSelectors ?? []).filter((s) => SELECTOR_RE.test(s));
    const records: DomainVerification['records'] = [
      { type: 'TXT', name: d, value: this.o.spfInclude ? `v=spf1 include:${this.o.spfInclude} ~all` : 'v=spf1 mx ~all' },
      ...selectors.map((s) => {
        const target = this.o.dkimTargets?.[s];
        return target
          ? { type: 'CNAME' as const, name: `${s}._domainkey.${d}`, value: target }
          : { type: 'TXT' as const, name: `${s}._domainkey.${d}`, value: 'v=DKIM1; k=rsa; p=<public key from your email provider>' };
      }),
      { type: 'TXT', name: `_dmarc.${d}`, value: 'v=DMARC1; p=quarantine' },
    ];
    if (!DOMAIN_RE.test(d)) return { domain: d, spf: false, dkim: false, dmarc: false, records };

    const resolver = this.o.resolver ?? defaultResolver();
    const txt = async (name: string): Promise<string[]> => {
      try {
        return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
      } catch {
        return [];
      }
    };
    const cname = async (name: string): Promise<string[]> => {
      try {
        return await resolver.resolveCname(name);
      } catch {
        return [];
      }
    };
    const startsWith = (values: string[], prefix: RegExp) => values.some((v) => prefix.test(v.trim()));

    const [spfTxt, dmarcTxt, dkimOk] = await Promise.all([
      txt(d),
      txt(`_dmarc.${d}`),
      Promise.all(
        selectors.map(async (s) => {
          const name = `${s}._domainkey.${d}`;
          const [t, c] = await Promise.all([txt(name), cname(name)]);
          return c.length > 0 || t.some((v) => /(^|;)\s*(v=DKIM1|p=)/i.test(v));
        }),
      ),
    ]);
    return {
      domain: d,
      spf: startsWith(spfTxt, /^v=spf1(\s|$)/i),
      dkim: dkimOk.length > 0 && dkimOk.every(Boolean),
      dmarc: startsWith(dmarcTxt, /^v=DMARC1(\s*;|\s*$)/i),
      records,
    };
  }
}

function humanDuration(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (m % 1440 === 0) return unit(m / 1440, 'day');
  if (m % 60 === 0) return unit(m / 60, 'hour');
  return unit(m, 'minute');
}

/** Account-security email to a USER (password reset, invite). Not a contact communication. */
export class SmtpAccountMailer implements AccountMailer {
  private readonly transport: SmtpTransport;
  private readonly from: { address: string; name: string };

  constructor(o: SmtpOptions & { from: { address: string; name: string } }) {
    const { from, ...smtp } = o;
    this.from = from;
    this.transport = new SmtpTransport(smtp);
  }

  async deliverAccountEmail(r: { to: string; kind: 'password_reset' | 'invite'; link: string; expiresInMinutes: number }): Promise<void> {
    if (!/^https?:\/\/\S+$/.test(r.link)) throw fail('rejected', 'EMAIL_LINK_INVALID');
    const expires = humanDuration(r.expiresInMinutes);
    const content =
      r.kind === 'password_reset'
        ? {
            subject: 'Reset your password',
            text: [
              'Someone asked to reset the password of your account. Use this link to choose a new password:',
              '',
              r.link,
              '',
              `The link expires in ${expires} and works once.`,
              'If you did not ask for this, ignore this email: your password stays the same.',
            ].join('\n'),
          }
        : {
            subject: 'You are invited',
            text: [
              'You have been invited to join your team. Use this link to accept the invitation and set up your account:',
              '',
              r.link,
              '',
              `The link expires in ${expires}.`,
              'If you were not expecting this invitation, ignore this email.',
            ].join('\n'),
          };
    await this.transport.deliver({
      from: this.from,
      to: r.to,
      subject: content.subject,
      text: content.text,
      headers: { 'Auto-Submitted': 'auto-generated' },
      idempotencyKey: randomUUID(),
    });
  }
}
