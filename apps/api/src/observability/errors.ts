// Error reporting behind an adapter (docs/OPERATIONS.md "Error reporting").
//
//   createErrorReporter(cfg)          Sentry-compatible envelope sender when ERROR_REPORTING_DSN is set,
//                                     otherwise the in-memory fake (dev, test, and staging without a DSN)
//   reporter.capture(err, context)    never throws, never blocks the request
//
// What leaves the process (scrubEvent): the error type, its message with quoted segments removed and
// emails / phone numbers masked, stack frames (function, file relative to the app, line, column), the
// release, the environment and these tags only: request_id (the one every error body already carries),
// route TEMPLATE, method, status, code, job_kind, process. Never request bodies, headers, cookies, query
// strings, user / tenant / contact ids, payloads or message text. Postgres errors keep only their
// SQLSTATE and constraint / table / column names (their messages quote the offending value).
import { randomBytes } from 'node:crypto';
import { maskPii } from '../audit.js';
import { parseDsn } from './config.js';

export interface ErrorContext {
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  code?: string;
  jobKind?: string;
  process?: 'api' | 'worker';
  level?: 'error' | 'fatal' | 'warning';
}

export interface StackFrame {
  function: string;
  filename: string;
  lineno?: number;
  colno?: number;
}

export interface ErrorEvent {
  event_id: string;
  timestamp: number;
  platform: 'node';
  level: 'error' | 'fatal' | 'warning';
  release: string;
  environment: string;
  tags: Record<string, string>;
  exception: { values: { type: string; value: string; stacktrace?: { frames: StackFrame[] } }[] };
}

export interface ErrorReporter {
  capture(err: unknown, ctx?: ErrorContext): void;
  /** waits for pending sends (graceful stop), at most `timeoutMs` */
  flush(timeoutMs?: number): Promise<void>;
}

const TAG_RE = /^[A-Za-z0-9_.:/{}*+-]{1,120}$/;

/** The PII-free text of an error message. */
export function scrubMessage(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown; severity?: unknown; constraint?: unknown; table?: unknown; column?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  const ident = (v: unknown) => (typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(v) ? v : null);
  if (typeof e?.severity === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    const parts = [`SQLSTATE ${code}`];
    for (const [k, v] of [['constraint', e.constraint], ['table', e.table], ['column', e.column]] as const) {
      const id = ident(v);
      if (id) parts.push(`${k}=${id}`);
    }
    return parts.join(' ');
  }
  const raw = typeof e?.message === 'string' ? e.message : typeof err === 'string' ? err : '';
  return maskPii(raw.replace(/"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”/g, '[quoted]'))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .slice(0, 500);
}

/** Stack frames without arguments or absolute paths beyond the app (node_modules frames kept by package). */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n').slice(1, 50)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    let file = m[2]!.replace(/^file:\/\//, '');
    const nm = file.lastIndexOf('/node_modules/');
    if (nm >= 0) file = file.slice(nm + 1);
    else {
      const app = file.search(/\/(?:apps|packages)\//);
      file = app >= 0 ? file.slice(app + 1) : file.split('/').slice(-2).join('/');
    }
    frames.push({ function: maskPii((m[1] ?? '<anonymous>').slice(0, 120)), filename: maskPii(file).slice(0, 200), lineno: Number(m[3]), colno: Number(m[4]) });
  }
  return frames.reverse(); // Sentry order: oldest call first
}

export function buildEvent(err: unknown, ctx: ErrorContext, meta: { release: string; environment: string; now?: number; eventId?: string }): ErrorEvent {
  const e = err as { name?: unknown; stack?: unknown } | null;
  const type = typeof e?.name === 'string' && /^[A-Za-z0-9_$]{1,60}$/.test(e.name) ? e.name : 'Error';
  const tags: Record<string, string> = {};
  const tag = (k: string, v: string | number | undefined) => {
    if (v === undefined) return;
    const s = String(v);
    if (TAG_RE.test(s)) tags[k] = s;
  };
  tag('request_id', ctx.requestId);
  tag('route', ctx.route);
  tag('method', ctx.method);
  tag('status', ctx.status);
  tag('code', ctx.code);
  tag('job_kind', ctx.jobKind);
  tag('process', ctx.process);
  const frames = parseStack(typeof e?.stack === 'string' ? e.stack : undefined);
  return {
    event_id: meta.eventId ?? randomBytes(16).toString('hex'),
    timestamp: (meta.now ?? Date.now()) / 1000,
    platform: 'node',
    level: ctx.level ?? 'error',
    release: meta.release,
    environment: meta.environment,
    tags,
    exception: { values: [{ type, value: scrubMessage(err), ...(frames.length ? { stacktrace: { frames } } : {}) }] },
  };
}

/** The fake: keeps the scrubbed events in memory (dev default; tests inspect `events`). */
export class MemoryErrorReporter implements ErrorReporter {
  readonly events: ErrorEvent[] = [];
  constructor(
    private readonly meta: { release: string; environment: string } = { release: 'dev', environment: 'test' },
    private readonly keep = 200,
  ) {}
  capture(err: unknown, ctx: ErrorContext = {}): void {
    try {
      this.events.push(buildEvent(err, ctx, this.meta));
      if (this.events.length > this.keep) this.events.splice(0, this.events.length - this.keep);
    } catch {
      // reporting never fails the caller
    }
  }
  async flush(): Promise<void> {}
}

export interface SentryReporterOptions {
  dsn: string;
  release: string;
  environment: string;
  fetch?: typeof fetch;
  /** at most this many events per minute leave the process (default 60); the rest are dropped and counted */
  perMinute?: number;
  now?: () => number;
}

/** Sends events as Sentry envelopes (store endpoint `/api/<project>/envelope/`), fire-and-forget. */
export class SentryErrorReporter implements ErrorReporter {
  private readonly endpoint: string;
  private readonly auth: string;
  private readonly pending = new Set<Promise<unknown>>();
  private windowStart = 0;
  private sentInWindow = 0;
  dropped = 0;
  failed = 0;
  constructor(private readonly o: SentryReporterOptions) {
    const d = parseDsn(o.dsn);
    this.endpoint = d.endpoint;
    this.auth = `Sentry sentry_version=7, sentry_key=${d.publicKey}, sentry_client=realty-os/1.0`;
  }
  capture(err: unknown, ctx: ErrorContext = {}): void {
    try {
      const now = (this.o.now ?? Date.now)();
      if (now - this.windowStart >= 60_000) {
        this.windowStart = now;
        this.sentInWindow = 0;
      }
      if (this.sentInWindow >= (this.o.perMinute ?? 60)) {
        this.dropped++;
        return;
      }
      this.sentInWindow++;
      const ev = buildEvent(err, ctx, { release: this.o.release, environment: this.o.environment, now });
      const body = `${JSON.stringify({ event_id: ev.event_id, sent_at: new Date(now).toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(ev)}\n`;
      const f = this.o.fetch ?? fetch;
      const p = f(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': this.auth }, body, signal: AbortSignal.timeout(5_000) })
        .then((r) => {
          if (!r.ok) this.failed++;
        })
        .catch(() => {
          this.failed++;
        })
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    } catch {
      // reporting never fails the caller
    }
  }
  async flush(timeoutMs = 2_000): Promise<void> {
    let t: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => (t = setTimeout(r, timeoutMs)))]);
    clearTimeout(t);
  }
}

export function createErrorReporter(cfg: { dsn: string | null; release: string; environment: string }, o: { fetch?: typeof fetch } = {}): ErrorReporter {
  if (!cfg.dsn) return new MemoryErrorReporter({ release: cfg.release, environment: cfg.environment });
  return new SentryErrorReporter({ dsn: cfg.dsn, release: cfg.release, environment: cfg.environment, ...(o.fetch ? { fetch: o.fetch } : {}) });
}
