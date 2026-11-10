// Worker logging, metrics and platform alerts (ARCHITECTURE §15).
//
// - Logs are JSON lines carrying ids, codes and timings only; every field goes through the platform's
//   `redactForLog` (PII keys dropped, emails / E.164 / phone numbers masked), so a handler error that
//   quotes a phone number never reaches the log verbatim (R-TEN-7).
// - Alerts are P1/P2 platform alerts (dead jobs, ownership/consent drift, sweeper lateness). The sink is
//   an interface: the default writes a structured `alert` log line that the log pipeline pages on; a
//   real pager integration plugs in here. Alert details are ids and codes only.
// - Metrics are kept in-process (counters, gauges, timing samples) and emitted by the maintenance pass;
//   a metrics backend can replace `MemoryMetrics` without touching the worker.
import { maskPii, redactForLog } from '../audit.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Masks emails / phone numbers in every string of a value (structure kept; for worker-built values). */
export function scrubDeep(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof v === 'string') return maskPii(v);
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Error) return redactForLog(v);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubDeep(x, depth + 1)]));
}

/**
 * Top-level keys the worker itself fills with ids, codes, counts and timings: kept, with PII masked in
 * their strings. Every other key goes through the platform classification (unknown keys are dropped).
 */
const WORKER_KEYS = new Set([
  'alert',
  'severity',
  'details',
  'worker',
  'queue',
  'queues',
  'attempts',
  'error',
  'errorCode',
  'workKind',
  'jobKind',
  'tenants',
  'enqueued',
  'skipped',
  'due',
  'result',
  'fields',
  'step',
]);

function safeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = WORKER_KEYS.has(k) ? scrubDeep(v) : (redactForLog({ [k]: v }) as LogFields)[k];
  }
  return out;
}

/** JSON-lines logger on `write` (default stdout) at or above `level`; fields are redacted. */
export function jsonLogger(opts: { level?: LogLevel | 'silent'; write?: (line: string) => void; base?: LogFields } = {}): Logger {
  const min = opts.level === 'silent' ? Number.POSITIVE_INFINITY : LEVELS[opts.level ?? 'info'];
  const write = opts.write ?? ((l: string) => void process.stdout.write(l + '\n'));
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[level] < min) return;
    const safe = safeFields({ ...opts.base, ...fields });
    write(JSON.stringify({ level, time: new Date().toISOString(), msg: maskPii(msg), module: 'worker', ...safe }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = jsonLogger({ level: 'silent' });

/** Collects redacted log lines in memory (tests). */
export function memoryLogger(): Logger & { lines: LogFields[] } {
  const lines: LogFields[] = [];
  const log = jsonLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l) as LogFields) });
  return Object.assign(log, { lines });
}

// ---- alerts --------------------------------------------------------------------------------------

export type AlertCode =
  | 'JOB_DEAD' // a job exhausted its attempts or failed permanently (ARCHITECTURE §6)
  | 'OWNERSHIP_DRIFT' // fold(ledger) != projection (R-OWN-4)
  | 'CONSENT_DRIFT' // consent_state != projectConsent(ledger) (R-CONSENT-6)
  | 'SWEEPER_LATE' // the sweeper has not completed a pass for over 60 s (ARCHITECTURE §15)
  | 'WORKER_ERROR'; // a maintenance step failed

export interface Alert {
  severity: 'P1' | 'P2';
  code: AlertCode;
  tenantId?: string | null;
  /** ids, codes, counts and instants only */
  details: Record<string, string | number | boolean | null>;
}

export interface AlertSink {
  raise(a: Alert): void;
}

/** Default sink: one structured `alert` log line per alert (the log pipeline pages on `alert: true`). */
export function logAlertSink(log: Logger): AlertSink {
  return { raise: (a) => log.error('platform alert', { alert: true, severity: a.severity, code: a.code, tenantId: a.tenantId ?? null, details: a.details }) };
}

export function memoryAlerts(): AlertSink & { alerts: Alert[] } {
  const alerts: Alert[] = [];
  return { alerts, raise: (a) => void alerts.push(scrubDeep(a) as Alert) };
}

// ---- metrics -------------------------------------------------------------------------------------

export interface Metrics {
  inc(name: string, labels?: Record<string, string>, by?: number): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
}

const keyOf = (name: string, labels?: Record<string, string>) =>
  labels && Object.keys(labels).length > 0
    ? `${name}{${Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')}}`
    : name;

/** In-process metrics: counters, last-value gauges and a bounded window of samples per series. */
export class MemoryMetrics implements Metrics {
  readonly counters = new Map<string, number>();
  readonly gauges = new Map<string, number>();
  readonly samples = new Map<string, number[]>();
  constructor(private readonly window = 10_000) {}
  inc(name: string, labels?: Record<string, string>, by = 1): void {
    const k = keyOf(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }
  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.set(keyOf(name, labels), value);
  }
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const k = keyOf(name, labels);
    const s = this.samples.get(k) ?? [];
    s.push(value);
    if (s.length > this.window) s.splice(0, s.length - this.window);
    this.samples.set(k, s);
  }
  /** The q-quantile (0..1) of a series' samples, or null without samples. */
  quantile(name: string, q: number, labels?: Record<string, string>): number | null {
    const s = this.samples.get(keyOf(name, labels));
    if (!s || s.length === 0) return null;
    const sorted = [...s].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  }
  counter(name: string, labels?: Record<string, string>): number {
    return this.counters.get(keyOf(name, labels)) ?? 0;
  }
  gaugeValue(name: string, labels?: Record<string, string>): number | null {
    return this.gauges.get(keyOf(name, labels)) ?? null;
  }
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) out[k] = v;
    for (const [k, v] of this.gauges) out[k] = v;
    for (const k of this.samples.keys()) {
      const name = k.includes('{') ? k.slice(0, k.indexOf('{')) : k;
      const labels = k.includes('{') ? Object.fromEntries(k.slice(k.indexOf('{') + 1, -1).split(',').map((p) => p.split('=') as [string, string])) : undefined;
      out[`${k}:p95`] = this.quantile(name, 0.95, labels) ?? 0;
    }
    return out;
  }
}
