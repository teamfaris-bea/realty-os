// SMTP adapter against a fake SMTP server (node:net / node:tls on 127.0.0.1:0).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type EmailRequest, ProviderError } from '../types.js';
import { buildMessage, dotStuff, makeMessageId } from './mime.js';
import { type DnsResolver, queueIdFromReply, SmtpAccountMailer, SmtpEmail, type SmtpOptions } from './smtp.js';

// ---- throwaway self-signed certificate ---------------------------------------------------------

function makeCert(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'realty-smtp-test-'));
  const base = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')];
  try {
    try {
      execFileSync('openssl', [...base, '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
    } catch {
      execFileSync('openssl', base, { stdio: 'ignore' });
    }
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CERT = makeCert();
if (!CERT) console.warn('[smtp.test] openssl unavailable: skipping the STARTTLS / implicit TLS tests only');

// ---- fake SMTP server --------------------------------------------------------------------------

type Stage = 'GREETING' | 'EHLO' | 'MAIL' | 'RCPT' | 'DATA' | 'END';

interface Behaviour {
  implicitTls?: boolean;
  advertiseStartTls?: boolean;
  authMechs?: string[];
  acceptAuth?: boolean;
  ehloUnsupported?: boolean;
  failAt?: { stage: Stage; reply: string };
  /** stop answering at a stage (GREETING = never greet; END = got the message, never reply) */
  hangAt?: Stage;
  /** close the connection after receiving the message instead of replying */
  dropAfterData?: boolean;
  endReply?: string;
}

interface FakeServer {
  port: number;
  connections: number;
  commands: string[];
  /** messages as received after un-dot-stuffing */
  messages: string[];
  /** raw DATA lines as they arrived on the wire (still dot-stuffed) */
  rawData: string[];
  auth: { user: string; pass: string; overTls: boolean }[];
  close(): Promise<void>;
}

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function startServer(b: Behaviour = {}): Promise<FakeServer> {
  const sockets = new Set<net.Socket>();
  const state: FakeServer = {
    port: 0,
    connections: 0,
    commands: [],
    messages: [],
    rawData: [],
    auth: [],
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const mechs = b.authMechs ?? ['PLAIN', 'LOGIN'];

  const serve = (socket: net.Socket, overTls: boolean) => {
    sockets.add(socket);
    socket.on('error', () => {});
    let buf = '';
    let mode: 'cmd' | 'data' | 'login_user' | 'login_pass' | 'done' = 'cmd';
    let dataLines: string[] = [];
    let loginUser = '';
    const reply = (s: string) => socket.write(s + '\r\n');
    const failOr = (stage: Stage, ok: () => void) => {
      if (b.hangAt === stage) return;
      if (b.failAt?.stage === stage) return reply(b.failAt.reply);
      ok();
    };
    const onLine = (line: string) => {
      if (mode === 'done') return;
      if (mode === 'data') {
        state.rawData.push(line);
        if (line === '.') {
          mode = 'cmd';
          const msg = dataLines.map((l) => (l.startsWith('.') ? l.slice(1) : l)).join('\r\n') + '\r\n';
          state.messages.push(msg);
          dataLines = [];
          if (b.dropAfterData) return void socket.destroy();
          return failOr('END', () => reply(b.endReply ?? '250 2.0.0 Ok: queued as ABC123XYZ'));
        }
        dataLines.push(line);
        return;
      }
      if (mode === 'login_user') {
        loginUser = Buffer.from(line, 'base64').toString('utf8');
        mode = 'login_pass';
        return reply('334 UGFzc3dvcmQ6');
      }
      if (mode === 'login_pass') {
        mode = 'cmd';
        state.auth.push({ user: loginUser, pass: Buffer.from(line, 'base64').toString('utf8'), overTls });
        return reply(b.acceptAuth === false ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 Authentication successful');
      }
      state.commands.push(line);
      const verb = line.split(' ')[0]!.toUpperCase();
      switch (verb) {
        case 'EHLO':
          if (b.ehloUnsupported) return reply('502 5.5.2 Command not recognized');
          return failOr('EHLO', () => {
            const ext = ['250-fake.test greets you', '250-PIPELINING', '250-8BITMIME'];
            if (b.advertiseStartTls && !overTls) ext.push('250-STARTTLS');
            if (mechs.length) ext.push(`250-AUTH ${mechs.join(' ')}`);
            ext.push('250 SMTPUTF8');
            socket.write(ext.join('\r\n') + '\r\n');
          });
        case 'HELO':
          return reply('250 fake.test');
        case 'STARTTLS': {
          if (!CERT || !b.advertiseStartTls) return reply('502 5.5.1 no');
          reply('220 2.0.0 Ready to start TLS');
          socket.removeAllListeners('data');
          const secure = new tls.TLSSocket(socket, { isServer: true, key: CERT.key, cert: CERT.cert });
          mode = 'done';
          serve(secure, true);
          return;
        }
        case 'AUTH': {
          const [, mech, initial] = line.split(' ');
          if (mech === 'PLAIN' && initial) {
            const [, user, pass] = Buffer.from(initial, 'base64').toString('utf8').split('\u0000');
            state.auth.push({ user: user ?? '', pass: pass ?? '', overTls });
            return reply(b.acceptAuth === false ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 Authentication successful');
          }
          if (mech === 'LOGIN') {
            mode = 'login_user';
            return reply('334 VXNlcm5hbWU6');
          }
          return reply('504 5.5.4 Unrecognized authentication type');
        }
        case 'MAIL':
          return failOr('MAIL', () => reply('250 2.1.0 Ok'));
        case 'RCPT':
          return failOr('RCPT', () => reply('250 2.1.5 Ok'));
        case 'DATA':
          return failOr('DATA', () => {
            mode = 'data';
            reply('354 End data with <CR><LF>.<CR><LF>');
          });
        case 'QUIT':
          reply('221 2.0.0 Bye');
          return void socket.end();
        default:
          return reply('500 5.5.1 unknown');
      }
    };
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      let i: number;
      while (mode !== 'done' && (i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    });
  };

  const onConnection = (socket: net.Socket, overTls: boolean) => {
    state.connections++;
    if (b.hangAt === 'GREETING') {
      sockets.add(socket);
      socket.on('error', () => {});
      return;
    }
    socket.write('220 fake.test ESMTP ready\r\n');
    serve(socket, overTls);
  };
  const server: net.Server =
    b.implicitTls && CERT
      ? tls.createServer({ key: CERT.key, cert: CERT.cert }, (s) => onConnection(s, true))
      : net.createServer((s) => onConnection(s, false));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  state.port = (server.address() as net.AddressInfo).port;
  servers.push(state);
  return state;
}

// ---- helpers -----------------------------------------------------------------------------------

const FIXED = new Date('2026-11-10T15:04:05Z');
const SECRET_PASSWORD = 'pw-Sup3rSecret!';

const opts = (port: number, o: Partial<SmtpOptions> = {}): SmtpOptions => ({
  host: '127.0.0.1',
  port,
  secure: 'none',
  timeoutMs: 1500,
  now: () => FIXED,
  ...o,
});

const req = (over: Partial<EmailRequest> = {}): EmailRequest => ({
  from: { address: 'dana.agent@realty.example.com', name: 'Dana Agent' },
  to: 'pat.client@buyer.example.org',
  replyTo: 'r+abcdefghijklmnop@in.realty.example.com',
  subject: 'Your showing on Elm Street',
  text: 'Hello Pat,\nSee you at 3pm at 12 Elm Street.\n',
  headers: {
    'X-Realty-Ref': 'ref_ABC-123',
    'List-Unsubscribe': '<https://app.example.com/api/email/unsubscribe/tok_123>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  },
  idempotencyKey: '0190a0b1-1111-7000-8000-000000000001',
  ...over,
});

/** Every thrown error is kept; the last test checks none of them leaks PII or credentials. */
const thrown: unknown[] = [];
async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    thrown.push(e);
    if (e instanceof ProviderError) return e;
    throw e;
  }
  throw new Error('expected a ProviderError');
}

function parse(msg: string): { headers: [string, string][]; header: (n: string) => string | undefined; body: string } {
  const split = msg.indexOf('\r\n\r\n');
  const head = msg.slice(0, split).replace(/\r\n[ \t]/g, ' ');
  const headers = head.split('\r\n').map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i), l.slice(i + 1).replace(/^ /, '')] as [string, string];
  });
  return {
    headers,
    header: (n) => headers.find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1],
    body: msg.slice(split + 4),
  };
}

const decodeWords = (v: string) =>
  v.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8')).trim();
const b64 = (s: string) => Buffer.from(s.replace(/\r\n/g, ''), 'base64').toString('utf8');

// ---- tests -------------------------------------------------------------------------------------

describe('SmtpEmail.sendEmail', () => {
  it('delivers with List-Unsubscribe, List-Unsubscribe-Post, X-Realty-Ref and Reply-To verbatim, deterministic Message-ID and queue id', async () => {
    const srv = await startServer();
    const out = await new SmtpEmail(opts(srv.port)).sendEmail(req());
    expect(out).toMatchObject({ providerRef: 'ABC123XYZ', status: 'queued' });
    expect(srv.messages).toHaveLength(1);
    const m = parse(srv.messages[0]!);
    // module 22 (R-GMAIL-12): a plain SMTP relay keeps our Message-ID, so it is reported for the hash
    expect(out.rfcMessageId).toBe(m.header('Message-ID'));
    expect(m.header('List-Unsubscribe')).toBe('<https://app.example.com/api/email/unsubscribe/tok_123>');
    expect(m.header('List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
    expect(m.header('X-Realty-Ref')).toBe('ref_ABC-123');
    expect(m.header('Reply-To')).toBe('r+abcdefghijklmnop@in.realty.example.com');
    expect(m.header('From')).toBe('Dana Agent <dana.agent@realty.example.com>');
    expect(m.header('To')).toBe('pat.client@buyer.example.org');
    expect(m.header('Message-ID')).toBe('<0190a0b1-1111-7000-8000-000000000001@realty.example.com>');
    expect(m.header('Date')).toBe('Tue, 10 Nov 2026 15:04:05 +0000');
    expect(m.header('MIME-Version')).toBe('1.0');
    expect(b64(m.body)).toBe('Hello Pat,\r\nSee you at 3pm at 12 Elm Street.\r\n');
    expect(srv.commands).toEqual([
      'EHLO localhost',
      'MAIL FROM:<dana.agent@realty.example.com>',
      'RCPT TO:<pat.client@buyer.example.org>',
      'DATA',
      'QUIT',
    ]);
    // the same request builds the same bytes (Message-ID and boundary are deterministic)
    await new SmtpEmail(opts(srv.port)).sendEmail(req());
    expect(srv.messages[1]).toBe(srv.messages[0]);
  });

  it('falls back to the Message-ID as providerRef when the 250 reply carries no queue id', async () => {
    const srv = await startServer({ endReply: '250 Great success' });
    const out = await new SmtpEmail(opts(srv.port)).sendEmail(req());
    expect(out.providerRef).toBe('0190a0b1-1111-7000-8000-000000000001@realty.example.com');
  });

  it('dot-stuffing: leading dots are doubled on the wire, and the delivered message equals buildMessage output byte for byte', async () => {
    expect(dotStuff('.a\r\nb\r\n..c\r\n.\r\n')).toBe('..a\r\nb\r\n...c\r\n..\r\n');
    expect(dotStuff('no dots\r\n')).toBe('no dots\r\n');
    const raw = 'Subject: x\r\n\r\n.leading dot\r\n..two dots\r\n.\r\nend\r\n';
    const stuffed = dotStuff(raw);
    expect(stuffed.split('\r\n')).toEqual(['Subject: x', '', '..leading dot', '...two dots', '..', 'end', '']);
    expect(
      stuffed
        .split('\r\n')
        .map((l) => (l.startsWith('.') ? l.slice(1) : l))
        .join('\r\n'),
    ).toBe(raw);

    const srv = await startServer();
    await new SmtpEmail(opts(srv.port)).sendEmail(req({ headers: { 'X-Note': '.dot' } }));
    const expected = buildMessage({
      from: req().from,
      to: req().to,
      replyTo: req().replyTo!,
      subject: req().subject,
      text: req().text,
      headers: { 'X-Note': '.dot' },
      messageId: makeMessageId(req().idempotencyKey, req().from.address),
      date: FIXED,
    });
    expect(srv.messages[0]).toBe(expected);
    expect(srv.rawData.at(-1)).toBe('.');
  });

  it('round-trips a UTF-8 subject, display name and text + html bodies (multipart/alternative)', async () => {
    const srv = await startServer();
    const subject = 'Besichtigung: Grüße aus München — 家 🏠 ' + 'ä'.repeat(40);
    await new SmtpEmail(opts(srv.port)).sendEmail(
      req({ subject, from: { address: 'dana.agent@realty.example.com', name: 'Zoë Ägent' }, text: 'Grüße\n— Zoë 🏠', html: '<p>Grüße — Zoë 🏠</p>' }),
    );
    const raw = srv.messages[0]!;
    for (const line of raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(raw)).toBe(true);
    const m = parse(raw);
    expect(decodeWords(m.header('Subject')!)).toBe(subject);
    expect(decodeWords(m.header('From')!.replace(/\s*<[^>]+>$/, ''))).toBe('Zoë Ägent');
    const ct = m.header('Content-Type')!;
    const boundary = /boundary="([^"]+)"/.exec(ct)![1]!;
    expect(ct).toMatch(/^multipart\/alternative;/);
    expect(boundary).toMatch(/^=_realty_[0-9a-f]{32}$/);
    const parts = m.body.split(`--${boundary}`).slice(1, 3).map((p) => parse(p.replace(/^\r\n/, '')));
    expect(parts[0]!.header('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(parts[0]!.header('Content-Transfer-Encoding')).toBe('base64');
    expect(b64(parts[0]!.body)).toBe('Grüße\r\n— Zoë 🏠');
    expect(parts[1]!.header('Content-Type')).toBe('text/html; charset=utf-8');
    expect(b64(parts[1]!.body)).toBe('<p>Grüße — Zoë 🏠</p>');
    expect(m.body.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it('quotes ASCII display names with specials', async () => {
    const srv = await startServer();
    await new SmtpEmail(opts(srv.port)).sendEmail(req({ from: { address: 'dana.agent@realty.example.com', name: 'Agent, Dana "DJ"' } }));
    expect(parse(srv.messages[0]!).header('From')).toBe('"Agent, Dana \\"DJ\\"" <dana.agent@realty.example.com>');
  });

  it('rejects CRLF injection in subject, header value, header name, address and display name before connecting', async () => {
    const srv = await startServer();
    const p = new SmtpEmail(opts(srv.port));
    const cases: Partial<EmailRequest>[] = [
      { subject: 'Hi\r\nBcc: victim@evil.example.com' },
      { subject: 'Hi\nBcc: victim@evil.example.com' },
      { headers: { 'X-Realty-Ref': 'ref\r\nBcc: victim@evil.example.com' } },
      { headers: { 'X-Bad\r\nBcc': 'x' } },
      { headers: { 'X Bad': 'x' } },
      { to: 'pat.client@buyer.example.org\r\nBcc: victim@evil.example.com' },
      { replyTo: 'r+abc@in.example.com\nBcc: victim@evil.example.com' },
      { from: { address: 'dana.agent@realty.example.com', name: 'Dana\r\nBcc: victim@evil.example.com' } },
    ];
    for (const c of cases) {
      const e = await failure(p.sendEmail(req(c)));
      expect(e.kind).toBe('rejected');
      expect(e.providerCode).toBe('EMAIL_HEADER_INVALID');
    }
    // structural headers cannot be overridden by the caller
    for (const name of ['From', 'to', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type', 'content-transfer-encoding', 'Bcc', 'Reply-To']) {
      const e = await failure(p.sendEmail(req({ headers: { [name]: 'x' } })));
      expect(e.providerCode).toBe('EMAIL_HEADER_INVALID');
    }
    const bad = await failure(p.sendEmail(req({ to: 'not an address' })));
    expect(bad.providerCode).toBe('EMAIL_ADDRESS_INVALID');
    expect(srv.connections).toBe(0);
  });

  it('never sends AUTH over plaintext: secure starttls against a server without STARTTLS fails closed', async () => {
    const srv = await startServer({ advertiseStartTls: false });
    const e = await failure(new SmtpEmail(opts(srv.port, { secure: 'starttls', username: 'apikey', password: SECRET_PASSWORD })).sendEmail(req()));
    expect(e.kind).toBe('not_configured');
    expect(e.providerCode).toBe('SMTP_STARTTLS_UNAVAILABLE');
    expect(srv.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
    expect(srv.auth).toHaveLength(0);
    expect(srv.messages).toHaveLength(0);
  });

  it("sends AUTH over plaintext only when secure 'none' was chosen explicitly", async () => {
    const srv = await startServer();
    await new SmtpEmail(opts(srv.port, { secure: 'none', username: 'user1', password: SECRET_PASSWORD })).sendEmail(req());
    expect(srv.auth).toEqual([{ user: 'user1', pass: SECRET_PASSWORD, overTls: false }]);
    expect(srv.commands[1]).toMatch(/^AUTH PLAIN /);
  });

  it('falls back to AUTH LOGIN when PLAIN is not offered', async () => {
    const srv = await startServer({ authMechs: ['LOGIN'] });
    await new SmtpEmail(opts(srv.port, { username: 'user1', password: SECRET_PASSWORD })).sendEmail(req());
    expect(srv.commands[1]).toBe('AUTH LOGIN');
    expect(srv.auth).toEqual([{ user: 'user1', pass: SECRET_PASSWORD, overTls: false }]);
    expect(srv.messages).toHaveLength(1);
  });

  it('falls back to HELO when EHLO is not supported', async () => {
    const srv = await startServer({ ehloUnsupported: true });
    await new SmtpEmail(opts(srv.port, { heloName: 'mta.realty.example.com' })).sendEmail(req());
    expect(srv.commands.slice(0, 2)).toEqual(['EHLO mta.realty.example.com', 'HELO mta.realty.example.com']);
    expect(srv.messages).toHaveLength(1);
  });

  it.skipIf(!CERT)('STARTTLS: upgrades, says EHLO again, then AUTHs over TLS (trusting the test CA)', async () => {
    const srv = await startServer({ advertiseStartTls: true });
    const out = await new SmtpEmail(opts(srv.port, { secure: 'starttls', username: 'user1', password: SECRET_PASSWORD, ca: CERT!.cert })).sendEmail(req());
    expect(out.status).toBe('queued');
    expect(srv.commands.slice(0, 4)).toEqual(['EHLO localhost', 'STARTTLS', 'EHLO localhost', srv.commands[3]]);
    expect(srv.commands[3]).toMatch(/^AUTH PLAIN /);
    expect(srv.auth).toEqual([{ user: 'user1', pass: SECRET_PASSWORD, overTls: true }]);
    expect(srv.messages).toHaveLength(1);
  });

  it.skipIf(!CERT)('STARTTLS with tlsRejectUnauthorized:false also works; an untrusted certificate fails as unavailable SMTP_TLS', async () => {
    const srv = await startServer({ advertiseStartTls: true });
    await new SmtpEmail(opts(srv.port, { secure: 'starttls', tlsRejectUnauthorized: false })).sendEmail(req());
    expect(srv.messages).toHaveLength(1);
    const e = await failure(new SmtpEmail(opts(srv.port, { secure: 'starttls', username: 'u', password: SECRET_PASSWORD })).sendEmail(req()));
    expect(e.kind).toBe('unavailable');
    expect(e.providerCode).toBe('SMTP_TLS');
    expect(srv.auth).toHaveLength(0);
  });

  it.skipIf(!CERT)('implicit TLS (secure tls) delivers and AUTHs over TLS', async () => {
    const srv = await startServer({ implicitTls: true });
    await new SmtpEmail(opts(srv.port, { secure: 'tls', username: 'user1', password: SECRET_PASSWORD, ca: CERT!.cert })).sendEmail(req());
    expect(srv.auth).toEqual([{ user: 'user1', pass: SECRET_PASSWORD, overTls: true }]);
    expect(srv.messages).toHaveLength(1);
  });

  it('535 at AUTH → not_configured SMTP_AUTH', async () => {
    const srv = await startServer({ acceptAuth: false });
    const e = await failure(new SmtpEmail(opts(srv.port, { username: 'user1', password: SECRET_PASSWORD })).sendEmail(req()));
    expect(e.kind).toBe('not_configured');
    expect(e.providerCode).toBe('SMTP_AUTH');
    expect(srv.commands.some((c) => c.startsWith('MAIL'))).toBe(false);
  });

  it('450 at RCPT → unavailable SMTP_450', async () => {
    const srv = await startServer({ failAt: { stage: 'RCPT', reply: '450 4.2.1 Mailbox busy' } });
    const e = await failure(new SmtpEmail(opts(srv.port)).sendEmail(req()));
    expect(e.kind).toBe('unavailable');
    expect(e.providerCode).toBe('SMTP_450');
  });

  it('550 at RCPT → rejected SMTP_550; 554 after DATA → rejected SMTP_554; 451 after DATA → unavailable SMTP_451', async () => {
    const a = await startServer({ failAt: { stage: 'RCPT', reply: '550 5.1.1 User unknown' } });
    const e1 = await failure(new SmtpEmail(opts(a.port)).sendEmail(req()));
    expect([e1.kind, e1.providerCode]).toEqual(['rejected', 'SMTP_550']);
    const b = await startServer({ failAt: { stage: 'END', reply: '554 5.7.1 Message rejected' } });
    const e2 = await failure(new SmtpEmail(opts(b.port)).sendEmail(req()));
    expect([e2.kind, e2.providerCode]).toEqual(['rejected', 'SMTP_554']);
    const c = await startServer({ failAt: { stage: 'END', reply: '451 4.3.0 Try later' } });
    const e3 = await failure(new SmtpEmail(opts(c.port)).sendEmail(req()));
    expect([e3.kind, e3.providerCode]).toEqual(['unavailable', 'SMTP_451']);
  });

  it('server hangs after DATA (message sent, no reply) → timeout (outcome unknown)', async () => {
    const srv = await startServer({ hangAt: 'END' });
    const e = await failure(new SmtpEmail(opts(srv.port, { timeoutMs: 300 })).sendEmail(req()));
    expect(e.kind).toBe('timeout');
    expect(srv.messages).toHaveLength(1);
  });

  it('connection dropped after the message was sent → timeout (outcome unknown)', async () => {
    const srv = await startServer({ dropAfterData: true });
    const e = await failure(new SmtpEmail(opts(srv.port)).sendEmail(req()));
    expect(e.kind).toBe('timeout');
  });

  it('timeouts before DATA are unavailable: no greeting, and no reply to DATA', async () => {
    const a = await startServer({ hangAt: 'GREETING' });
    const e1 = await failure(new SmtpEmail(opts(a.port, { timeoutMs: 300 })).sendEmail(req()));
    expect([e1.kind, e1.providerCode]).toEqual(['unavailable', 'SMTP_TIMEOUT']);
    const b = await startServer({ hangAt: 'DATA' });
    const e2 = await failure(new SmtpEmail(opts(b.port, { timeoutMs: 300 })).sendEmail(req()));
    expect([e2.kind, e2.providerCode]).toEqual(['unavailable', 'SMTP_TIMEOUT']);
  });

  it('connection refused → unavailable', async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const e = await failure(new SmtpEmail(opts(port)).sendEmail(req()));
    expect(e.kind).toBe('unavailable');
    expect(e.providerCode).toBe('SMTP_CONNECTION');
  });

  describe('vendor metadata headers echo X-Realty-Ref', () => {
    const cases: { vendor: SmtpOptions['vendor']; extra: Partial<SmtpOptions>; expected: [string, string][] }[] = [
      {
        vendor: 'postmark',
        extra: { postmarkMessageStream: 'outbound' },
        expected: [
          ['X-PM-Metadata-realty_ref', 'ref_ABC-123'],
          ['X-PM-Message-Stream', 'outbound'],
        ],
      },
      { vendor: 'sendgrid', extra: {}, expected: [['X-SMTPAPI', '{"unique_args":{"realty_ref":"ref_ABC-123"}}']] },
      { vendor: 'mailgun', extra: {}, expected: [['X-Mailgun-Variables', '{"realty_ref":"ref_ABC-123"}']] },
      {
        vendor: 'ses',
        extra: { sesConfigurationSet: 'realty-events' },
        expected: [
          ['X-SES-MESSAGE-TAGS', 'realty_ref=ref_ABC-123'],
          ['X-SES-CONFIGURATION-SET', 'realty-events'],
        ],
      },
    ];
    for (const c of cases) {
      it(`${c.vendor}`, async () => {
        const srv = await startServer();
        await new SmtpEmail(opts(srv.port, { vendor: c.vendor, ...c.extra })).sendEmail(req());
        const m = parse(srv.messages[0]!);
        for (const [k, v] of c.expected) expect(m.header(k)).toBe(v);
        expect(m.header('X-Realty-Ref')).toBe('ref_ABC-123');
      });
    }

    it('generic adds none; no X-Realty-Ref means no ref metadata', async () => {
      const srv = await startServer();
      await new SmtpEmail(opts(srv.port)).sendEmail(req());
      await new SmtpEmail(opts(srv.port, { vendor: 'mailgun' })).sendEmail(req({ headers: {} }));
      expect(parse(srv.messages[0]!).headers.filter(([k]) => /^X-(PM|SMTPAPI|Mailgun|SES)/i.test(k))).toEqual([]);
      expect(parse(srv.messages[1]!).header('X-Mailgun-Variables')).toBeUndefined();
    });
  });

  it('lookupMessage returns null (generic SMTP cannot be queried)', async () => {
    expect(await new SmtpEmail(opts(1)).lookupMessage('0190a0b1-1111-7000-8000-000000000001')).toBeNull();
  });
});

describe('queueIdFromReply', () => {
  it('extracts Postfix/SendGrid/Postmark, SES and Exim ids', () => {
    expect(queueIdFromReply('2.0.0 Ok: queued as ABC123')).toBe('ABC123');
    expect(queueIdFromReply('Ok: queued as <9f1c2b3a-1111-2222-3333-444455556666>')).toBe('9f1c2b3a-1111-2222-3333-444455556666');
    expect(queueIdFromReply('Ok 0100018b2f1e7c3a-abcdef12-0000-0000-0000-000000000000-000000')).toBe('0100018b2f1e7c3a-abcdef12-0000-0000-0000-000000000000-000000');
    expect(queueIdFromReply('OK id=1qXyZa-000AbC-12')).toBe('1qXyZa-000AbC-12');
    expect(queueIdFromReply('Great success')).toBeNull();
    expect(queueIdFromReply('2.0.0 Ok')).toBeNull();
  });
});

describe('SmtpAccountMailer', () => {
  it('sends the password-reset link with what it is for and when it expires (and no marketing)', async () => {
    const srv = await startServer();
    const mailer = new SmtpAccountMailer({ ...opts(srv.port), from: { address: 'no-reply@realty.example.com', name: 'Realty OS' } });
    const link = 'https://app.realty.example.com/reset/tok_abcdef123456';
    await mailer.deliverAccountEmail({ to: 'agent.user@brokerage.example.com', kind: 'password_reset', link, expiresInMinutes: 60 });
    const m = parse(srv.messages[0]!);
    expect(m.header('To')).toBe('agent.user@brokerage.example.com');
    expect(m.header('Subject')).toBe('Reset your password');
    expect(m.header('List-Unsubscribe')).toBeUndefined();
    const text = b64(m.body);
    expect(text).toContain(link);
    expect(text).toContain('reset the password');
    expect(text).toContain('expires in 1 hour');
  });

  it('sends the invite link', async () => {
    const srv = await startServer();
    const mailer = new SmtpAccountMailer({ ...opts(srv.port), from: { address: 'no-reply@realty.example.com', name: 'Realty OS' } });
    const link = 'https://app.realty.example.com/invite/tok_zyx987';
    await mailer.deliverAccountEmail({ to: 'new.agent@brokerage.example.com', kind: 'invite', link, expiresInMinutes: 7 * 24 * 60 });
    const text = b64(parse(srv.messages[0]!).body);
    expect(text).toContain(link);
    expect(text).toContain('accept the invitation');
    expect(text).toContain('expires in 7 days');
  });
});

describe('SmtpEmail.verifyDomain', () => {
  const stub = (txt: Record<string, string[][]>, cname: Record<string, string[]> = {}): DnsResolver => ({
    async resolveTxt(name) {
      const r = txt[name];
      if (!r) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
      return r;
    },
    async resolveCname(name) {
      const r = cname[name];
      if (!r) throw Object.assign(new Error('queryCname ENODATA'), { code: 'ENODATA' });
      return r;
    },
  });

  it('reports SPF, DKIM (TXT or CNAME per selector) and DMARC, with the records to publish', async () => {
    const p = new SmtpEmail({
      ...opts(1),
      dkimSelectors: ['pm', 's2'],
      dkimTargets: { s2: 's2.dkim.vendor.example.net' },
      spfInclude: 'spf.vendor.example.net',
      resolver: stub(
        {
          'realty.example.com': [['google-site-verification=abc'], ['v=spf1 include:spf.vendor', '.example.net ~all']],
          '_dmarc.realty.example.com': [['v=DMARC1; p=none']],
          'pm._domainkey.realty.example.com': [['k=rsa; p=MIGfMA0']],
        },
        { 's2._domainkey.realty.example.com': ['s2.dkim.vendor.example.net'] },
      ),
    });
    const v = await p.verifyDomain('Realty.Example.com.');
    expect(v).toEqual({
      domain: 'realty.example.com',
      spf: true,
      dkim: true,
      dmarc: true,
      records: [
        { type: 'TXT', name: 'realty.example.com', value: 'v=spf1 include:spf.vendor.example.net ~all' },
        { type: 'TXT', name: 'pm._domainkey.realty.example.com', value: 'v=DKIM1; k=rsa; p=<public key from your email provider>' },
        { type: 'CNAME', name: 's2._domainkey.realty.example.com', value: 's2.dkim.vendor.example.net' },
        { type: 'TXT', name: '_dmarc.realty.example.com', value: 'v=DMARC1; p=quarantine' },
      ],
    });
  });

  it('DNS errors and missing records are false, never a throw; no selectors means dkim false', async () => {
    const throwing: DnsResolver = {
      resolveTxt: async () => {
        throw new Error('ESERVFAIL');
      },
      resolveCname: async () => {
        throw new Error('ESERVFAIL');
      },
    };
    const v = await new SmtpEmail({ ...opts(1), resolver: throwing }).verifyDomain('realty.example.com');
    expect([v.spf, v.dkim, v.dmarc]).toEqual([false, false, false]);
    const w = await new SmtpEmail({ ...opts(1), dkimSelectors: ['a', 'b'], resolver: stub({ 'a._domainkey.x.example.com': [['v=DKIM1; p=abc']] }) }).verifyDomain('x.example.com');
    expect([w.spf, w.dkim, w.dmarc]).toEqual([false, false, false]); // selector b missing
    const bad = await new SmtpEmail({ ...opts(1), resolver: throwing }).verifyDomain('not a domain');
    expect([bad.spf, bad.dkim, bad.dmarc]).toEqual([false, false, false]);
  });
});

describe('error hygiene', () => {
  it('no thrown error carries an address, subject, body text or credential', () => {
    expect(thrown.length).toBeGreaterThan(20);
    const forbidden = [
      'pat.client',
      'buyer.example.org',
      'dana.agent',
      'realty.example.com',
      'victim',
      'evil.example.com',
      'Elm Street',
      'Hello Pat',
      'showing',
      SECRET_PASSWORD,
      'user1',
      '127.0.0.1',
    ];
    for (const e of thrown) {
      const text = [String(e), (e as Error).message, (e as Error).stack ?? '', JSON.stringify(e), JSON.stringify((e as { cause?: unknown }).cause ?? null)].join('\n');
      for (const f of forbidden) expect(text, `error leaks ${f}`).not.toContain(f);
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as Error).message).toMatch(/^provider (timeout|rejected|unavailable|not_configured)(: [A-Z0-9_]+)?$/);
    }
  });
});

afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
