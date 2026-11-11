// A small Prometheus registry (text exposition format 0.0.4): counters, gauges and histograms, with no
// dependency. Labels are where PII and unbounded ids leak into a metrics backend, so the registry
// enforces two rules itself (docs/OPERATIONS.md "Metrics"):
//   - label NAMES come from a fixed allowlist (no tenant, user, contact, message or job ids, ever);
//   - label VALUES are bounded: a short identifier-like string, never a UUID, an email address or a
//     phone number. Anything else is exported as `OTHER`, and each family keeps at most
//     MAX_SERIES_PER_FAMILY series (later ones collapse into one `OTHER` series).
export const ALLOWED_LABELS = new Set([
  'method',
  'route',
  'status_class',
  'code',
  'kind',
  'queue',
  'outcome',
  'state',
  'channel',
  'status',
  'result',
  'reason',
  'quantile',
  'bucket',
  'release',
  'work_kind',
  'item',
  'process',
  'check',
  'severity',
]);

export const MAX_SERIES_PER_FAMILY = 500;

export type Labels = Record<string, string>;

const NAME_RE = /^[a-z_:][a-z0-9_:]*$/;
const VALUE_RE = /^[A-Za-z0-9_.:/{}*+-]{0,100}$/;
const UUIDISH = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const LONG_DIGITS = /\d{7,}/;

/** The exported form of a label value: itself when bounded and id-free, else OTHER. */
export function safeLabelValue(v: string): string {
  if (!VALUE_RE.test(v) || UUIDISH.test(v) || LONG_DIGITS.test(v) || v.includes('@')) return 'OTHER';
  return v;
}

function checkLabels(family: string, labels: Labels | undefined): Labels {
  const out: Labels = {};
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (!ALLOWED_LABELS.has(k)) throw new Error(`metric ${family}: label "${k}" is not allowed (ids and PII never become labels)`);
    out[k] = safeLabelValue(String(v));
  }
  return out;
}

const escapeValue = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const keyOf = (l: Labels) =>
  Object.keys(l)
    .sort()
    .map((k) => `${k}="${escapeValue(l[k]!)}"`)
    .join(',');
const fmt = (n: number) => (Number.isFinite(n) ? String(n) : n > 0 ? '+Inf' : n < 0 ? '-Inf' : 'NaN');

abstract class Family {
  constructor(
    readonly name: string,
    readonly help: string,
  ) {
    if (!NAME_RE.test(name)) throw new Error(`invalid metric name ${name}`);
  }
  abstract readonly type: 'counter' | 'gauge' | 'histogram';
  abstract lines(): string[];
}

class Series<T> {
  readonly map = new Map<string, { labels: Labels; value: T }>();
  constructor(
    readonly family: string,
    readonly init: () => T,
  ) {}
  get(labels: Labels | undefined): { labels: Labels; value: T } {
    let l = checkLabels(this.family, labels);
    let k = keyOf(l);
    let s = this.map.get(k);
    if (!s) {
      if (this.map.size >= MAX_SERIES_PER_FAMILY) {
        l = Object.fromEntries(Object.keys(l).map((x) => [x, 'OTHER']));
        k = keyOf(l);
        s = this.map.get(k);
        if (s) return s;
      }
      s = { labels: l, value: this.init() };
      this.map.set(k, s);
    }
    return s;
  }
}

export class Counter extends Family {
  readonly type = 'counter' as const;
  private readonly s = new Series<{ v: number }>(this.name, () => ({ v: 0 }));
  inc(labels?: Labels, by = 1): void {
    if (!(by >= 0)) return;
    this.s.get(labels).value.v += by;
  }
  value(labels?: Labels): number {
    return this.s.map.get(keyOf(checkLabels(this.name, labels)))?.value.v ?? 0;
  }
  lines(): string[] {
    return [...this.s.map.values()].map(({ labels, value }) => `${this.name}${braces(keyOf(labels))} ${fmt(value.v)}`);
  }
}

export class Gauge extends Family {
  readonly type = 'gauge' as const;
  private readonly s = new Series<{ v: number }>(this.name, () => ({ v: 0 }));
  set(value: number, labels?: Labels): void {
    this.s.get(labels).value.v = value;
  }
  inc(labels?: Labels, by = 1): void {
    this.s.get(labels).value.v += by;
  }
  /** Drops every series (a collector that re-reads the full state sets them again). */
  reset(): void {
    this.s.map.clear();
  }
  value(labels?: Labels): number | null {
    return this.s.map.get(keyOf(checkLabels(this.name, labels)))?.value.v ?? null;
  }
  lines(): string[] {
    return [...this.s.map.values()].map(({ labels, value }) => `${this.name}${braces(keyOf(labels))} ${fmt(value.v)}`);
  }
}

/** Default buckets in seconds: 5 ms .. 2 min (HTTP, jobs, dispatch, timer lateness). */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export class Histogram extends Family {
  readonly type = 'histogram' as const;
  private readonly s: Series<{ counts: number[]; sum: number; count: number }>;
  constructor(
    name: string,
    help: string,
    readonly buckets: readonly number[] = DEFAULT_BUCKETS,
  ) {
    super(name, help);
    this.s = new Series(name, () => ({ counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
  }
  observe(value: number, labels?: Labels): void {
    if (!Number.isFinite(value)) return;
    const s = this.s.get(labels).value;
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) s.counts[i]!++;
    s.sum += value;
    s.count++;
  }
  count(labels?: Labels): number {
    return this.s.map.get(keyOf(checkLabels(this.name, labels)))?.value.count ?? 0;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const { labels, value } of this.s.map.values()) {
      const base = keyOf(labels);
      const join = (extra: string) => braces(base ? `${base},${extra}` : extra);
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket${join(`le="${fmt(b)}"`)} ${value.counts[i]}`));
      out.push(`${this.name}_bucket${join('le="+Inf"')} ${value.count}`);
      out.push(`${this.name}_sum${braces(base)} ${fmt(value.sum)}`);
      out.push(`${this.name}_count${braces(base)} ${value.count}`);
    }
    return out;
  }
}

const braces = (s: string) => (s ? `{${s}}` : '');

export type Collector = () => Promise<void> | void;

export class Registry {
  private readonly families = new Map<string, Family>();
  private readonly collectors: Collector[] = [];

  private add<F extends Family>(f: F): F {
    const cur = this.families.get(f.name);
    if (cur) {
      if (cur.type !== f.type) throw new Error(`metric ${f.name} already registered as ${cur.type}`);
      return cur as F;
    }
    this.families.set(f.name, f);
    return f;
  }
  counter(name: string, help: string): Counter {
    return this.add(new Counter(name, help));
  }
  gauge(name: string, help: string): Gauge {
    return this.add(new Gauge(name, help));
  }
  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    return this.add(new Histogram(name, help, buckets));
  }
  get(name: string): Family | undefined {
    return this.families.get(name);
  }
  /** Runs before every exposition (e.g. reads pool or database state). A failing collector is skipped. */
  onCollect(c: Collector): void {
    this.collectors.push(c);
  }
  async render(): Promise<string> {
    for (const c of this.collectors) {
      try {
        await c();
      } catch {
        // a collector reports its own failure through a metric; the exposition still answers
      }
    }
    const out: string[] = [];
    for (const f of [...this.families.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const lines = f.lines();
      out.push(`# HELP ${f.name} ${f.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`, `# TYPE ${f.name} ${f.type}`, ...lines);
    }
    return `${out.join('\n')}\n`;
  }
}
