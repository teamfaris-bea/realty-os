// Recording counsel review of platform clearance packs on a deployment (R-INT-6; docs/DEPLOY.md §10.1).
//
//   pnpm --filter @realty/db counsel-review -- --keys platform:<name>[,...] --reviewed-on YYYY-MM-DD --reference "<source>" [--apply]
//   node packages/db/dist/scripts/counsel-review.js <same flags>          (in the api image)
//
// A platform pack (jurisdiction_packs key 'platform:<name>') gates its capability through app.platform_cleared
// (0018): cleared once the published version has reviewed_by_counsel_at and, where the database also asks for a
// vendor check (voice, Gmail), rules.vendor_ready_at. Packs ship unreviewed and the migrations stay that way; this
// command is the one writer of reviewed_by_counsel_at. For each named key it sets reviewed_by_counsel_at on the
// PUBLISHED version only (00:00 UTC of --reviewed-on) and appends one note: when it was recorded, by which
// database role, the review date and the reported source (--reference). It never writes rules, so it never sets
// or changes vendor_ready_at: vendor checks are separate (Google's verification for Gmail, a real vendor's
// latency check for voice).
//
// All or nothing, in one transaction: a refused key, a bad flag or a role that cannot write the packs changes
// nothing. A pack already recorded with the same date is reported unchanged (idempotent); one recorded with a
// different date is refused, never overwritten. A dry run (the default) makes the same changes inside the
// transaction to report the outcome, then rolls back; --apply commits.
//
// Runs as the database owner role only: app_user has SELECT on jurisdiction_packs and nothing more, and the table
// is FORCE ROW LEVEL SECURITY with a read policy only, so the writer must also be superuser or BYPASSRLS (the
// owner that applies the migrations). There is no platform-level audit table (audit_log is per tenant), so the
// audit trail is the pack's notes plus this command's printed output (keep it with the deploy log).
import pg from 'pg';

export const COUNSEL_REVIEW_USAGE = [
  'Usage: pnpm --filter @realty/db counsel-review -- --keys platform:<name>[,platform:<name>...] --reviewed-on YYYY-MM-DD --reference "<reported source>" [--apply]',
  '   or: node packages/db/dist/scripts/counsel-review.js <same flags>   (in the api image)',
  'Records counsel review on each named platform pack\'s published version, as the database owner role',
  '(MIGRATION_DATABASE_URL). A dry run by default: prints before and after per key and changes nothing.',
  'Never sets rules.vendor_ready_at: voice and Gmail also wait for their vendor checks.',
].join('\n');

/** D2: packs that are never cleared (apps/api/src/integrations/catalog.ts NEVER_CLEARED_PACKS; 0025 notes "Do not clear"). */
export const NEVER_CLEARED_PACKS: readonly string[] = ['platform:meta'];

const PLATFORM_KEY = /^platform:[a-z_]+$/; // the 0018 jurisdiction_packs_key_check for platform packs
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REFERENCE = 300;
// regexp over pg_proc.prosrc: the packs whose gates call app.platform_cleared(key, true) (the integrations test uses the same scan)
const VENDOR_CHECK_CALLS = String.raw`platform_cleared\('(platform:[a-z_]+)',\s*true\)`;

/** A refusal: the operator's input or the deployment's state, never a crash. Nothing was changed. */
export class CounselReviewRefused extends Error {
  override name = 'CounselReviewRefused';
}

export interface CounselReviewArgs {
  keys: string[];
  reviewedOn: string;
  reference: string;
  apply: boolean;
}

export interface PackState {
  /** UTC date of reviewed_by_counsel_at, or null */
  reviewedOn: string | null;
  vendorReadyAt: string | null;
  /** app.platform_cleared(key, vendorChecked): what the database gates on */
  cleared: boolean;
}

export interface PackChange {
  key: string;
  version: string;
  vendorChecked: boolean;
  /** false: already recorded with this date; nothing written */
  changed: boolean;
  before: PackState;
  after: PackState;
}

export interface CounselReviewResult {
  apply: boolean;
  role: string;
  changes: PackChange[];
}

/** UTC calendar date (YYYY-MM-DD) of an instant. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parses the command line. `today` is the UTC date the review date may not exceed. Throws CounselReviewRefused. */
export function parseCounselReviewArgs(argv: readonly string[], today: string): CounselReviewArgs | 'help' {
  const keys: string[] = [];
  let reviewedOn: string | undefined;
  let reference: string | undefined;
  let apply = false;
  const rest = [...argv];
  while (rest.length > 0) {
    const raw = rest.shift()!;
    if (raw === '--') continue; // pnpm passes the separator through
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const value = (): string => {
      if (eq > 0) return raw.slice(eq + 1);
      const v = rest.shift();
      if (v === undefined || v.startsWith('--')) throw new CounselReviewRefused(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--help':
      case '-h':
        return 'help';
      case '--keys':
        keys.push(...value().split(',').map((k) => k.trim()).filter((k) => k !== ''));
        break;
      case '--reviewed-on':
        reviewedOn = value();
        break;
      case '--reference':
        reference = value();
        break;
      case '--apply':
        if (eq > 0) throw new CounselReviewRefused('--apply takes no value');
        apply = true;
        break;
      case '--dry-run':
        if (eq > 0) throw new CounselReviewRefused('--dry-run takes no value');
        apply = false;
        break;
      default:
        throw new CounselReviewRefused(`unknown option ${flag}`);
    }
  }
  if (keys.length === 0) throw new CounselReviewRefused('--keys is required: one or more platform:<name> keys, comma-separated');
  if (reviewedOn === undefined) throw new CounselReviewRefused('--reviewed-on is required: the date counsel reviewed the packs (YYYY-MM-DD)');
  if (!DATE.test(reviewedOn) || Number.isNaN(Date.parse(`${reviewedOn}T00:00:00Z`)) || utcDate(new Date(`${reviewedOn}T00:00:00Z`)) !== reviewedOn) {
    throw new CounselReviewRefused(`--reviewed-on must be a date YYYY-MM-DD (got '${reviewedOn}')`);
  }
  if (reviewedOn > today) throw new CounselReviewRefused(`--reviewed-on ${reviewedOn} is in the future (today is ${today} UTC)`);
  const ref = reference?.trim() ?? '';
  if (ref === '') throw new CounselReviewRefused('--reference is required: who reported the review and where it is recorded, e.g. "counsel review reported by the owner, 2026-11-12"');
  if (/\p{Cc}/u.test(ref)) throw new CounselReviewRefused('--reference must be one line of text (no control characters)');
  if (ref.length > MAX_REFERENCE) throw new CounselReviewRefused(`--reference is longer than ${MAX_REFERENCE} characters`);
  return { keys: [...new Set(keys)], reviewedOn, reference: ref, apply };
}

/** The note appended to a pack's notes when its review is recorded. */
export function counselReviewNote(o: { recordedAt: string; role: string; reviewedOn: string; reference: string; vendorChecked: boolean }): string {
  const source = /[.!?]$/.test(o.reference) ? o.reference : `${o.reference}.`;
  const vendor = o.vendorChecked ? ' The vendor check (rules.vendor_ready_at) is separate and was not recorded.' : '';
  return `Counsel review recorded ${o.recordedAt} by database role ${o.role}: reviewed on ${o.reviewedOn}; source: ${source}${vendor}`;
}

interface Row {
  key: string;
  version: string;
  status: string;
  reviewed_on: string | null;
  vendor_ready_at: string | null;
}

async function stateOf(c: pg.ClientBase, key: string, vendorChecked: boolean): Promise<PackState> {
  const { rows } = await c.query<{ reviewed_on: string | null; vendor_ready_at: string | null; cleared: boolean }>(
    `SELECT to_char(reviewed_by_counsel_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS reviewed_on, rules->>'vendor_ready_at' AS vendor_ready_at,
            app.platform_cleared($1, $2) AS cleared
       FROM public.jurisdiction_packs WHERE key = $1 AND status = 'published'`,
    [key, vendorChecked],
  );
  const r = rows[0]!;
  return { reviewedOn: r.reviewed_on, vendorReadyAt: r.vendor_ready_at, cleared: r.cleared };
}

/**
 * Records counsel review of the named packs in one transaction on `c` (a connected client, no open transaction).
 * Commits only with args.apply; otherwise rolls back. Throws CounselReviewRefused (nothing changed) on any refusal.
 */
export async function recordCounselReview(c: pg.ClientBase, args: CounselReviewArgs): Promise<CounselReviewResult> {
  await c.query('BEGIN');
  try {
    await c.query("SET LOCAL lock_timeout = '10s'");
    const who = (
      await c.query<{ role: string; su: boolean; bypass: boolean; can_update: boolean; recorded_at: string }>(
        `SELECT current_user AS role, r.rolsuper AS su, r.rolbypassrls AS bypass,
                has_table_privilege('public.jurisdiction_packs', 'UPDATE') AS can_update,
                to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recorded_at
           FROM pg_roles r WHERE r.rolname = current_user`,
      )
    ).rows[0]!;
    if (!who.can_update) {
      throw new CounselReviewRefused(`database role ${who.role} cannot update jurisdiction_packs: run this as the database owner role (MIGRATION_DATABASE_URL), never the app's login`);
    }
    if (!who.su && !who.bypass) {
      throw new CounselReviewRefused(`database role ${who.role} is subject to row-level security on jurisdiction_packs (not superuser, no BYPASSRLS): run this as the owner role that applies the migrations`);
    }

    for (const key of args.keys) {
      if (!PLATFORM_KEY.test(key)) {
        throw new CounselReviewRefused(`'${key}' is not a platform pack key (platform:<name>); jurisdiction packs such as 'US' are not recorded with this command`);
      }
      if (NEVER_CLEARED_PACKS.includes(key)) {
        throw new CounselReviewRefused(`${key} is never cleared (owner decision D2): nothing in the product waits on it and its notes say "Do not clear"`);
      }
    }
    const rows = (
      await c.query<Row>(
        `SELECT key, version, status, to_char(reviewed_by_counsel_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS reviewed_on,
                rules->>'vendor_ready_at' AS vendor_ready_at
           FROM public.jurisdiction_packs WHERE key = ANY ($1::text[]) ORDER BY key, version FOR UPDATE`,
        [args.keys],
      )
    ).rows;
    const vendorChecked = new Set(
      (await c.query<{ key: string }>('SELECT DISTINCT m[1] AS key FROM pg_proc p CROSS JOIN LATERAL regexp_matches(p.prosrc, $1, \'g\') AS m', [VENDOR_CHECK_CALLS])).rows.map(
        (r) => r.key,
      ),
    );

    const targets: { key: string; row: Row; vendorChecked: boolean }[] = [];
    for (const key of args.keys) {
      const versions = rows.filter((r) => r.key === key);
      const row = versions.find((r) => r.status === 'published');
      if (versions.length === 0) throw new CounselReviewRefused(`${key}: no such pack on this deployment`);
      if (!row) {
        throw new CounselReviewRefused(`${key} has no published version (${versions.map((v) => `${v.status} ${v.version}`).join(', ')}); counsel review is recorded on the published version`);
      }
      if (row.reviewed_on !== null && row.reviewed_on !== args.reviewedOn) {
        throw new CounselReviewRefused(
          `${key} is already recorded as reviewed by counsel on ${row.reviewed_on} (version ${row.version}); this command never changes a recorded review`,
        );
      }
      targets.push({ key, row, vendorChecked: vendorChecked.has(key) });
    }

    const changes: PackChange[] = [];
    for (const t of targets) {
      const before = await stateOf(c, t.key, t.vendorChecked);
      const changed = t.row.reviewed_on === null;
      if (changed) {
        const note = counselReviewNote({ recordedAt: who.recorded_at, role: who.role, reviewedOn: args.reviewedOn, reference: args.reference, vendorChecked: t.vendorChecked });
        const u = await c.query(
          `UPDATE public.jurisdiction_packs SET reviewed_by_counsel_at = $3::timestamptz, notes = concat_ws(' ', notes, $4::text)
            WHERE key = $1 AND version = $2 AND status = 'published' AND reviewed_by_counsel_at IS NULL`,
          [t.key, t.row.version, `${args.reviewedOn}T00:00:00Z`, note],
        );
        if (u.rowCount !== 1) throw new Error(`${t.key}: expected to update 1 row, updated ${u.rowCount ?? 0}`);
      }
      changes.push({ key: t.key, version: t.row.version, vendorChecked: t.vendorChecked, changed, before, after: await stateOf(c, t.key, t.vendorChecked) });
    }

    await c.query(args.apply ? 'COMMIT' : 'ROLLBACK');
    return { apply: args.apply, role: who.role, changes };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

function describeState(s: PackState, vendorChecked: boolean): string {
  const review = s.reviewedOn === null ? 'not reviewed by counsel' : `reviewed by counsel on ${s.reviewedOn}`;
  if (s.cleared) return `${review}; cleared`;
  if (s.reviewedOn !== null && vendorChecked && s.vendorReadyAt === null) {
    return `${review}; not cleared: still waits for the vendor check (rules.vendor_ready_at; this command never sets it)`;
  }
  return `${review}; not cleared`;
}

/** The printed report: a header, per key before and after (or unchanged), and a summary line. */
export function formatCounselReview(r: CounselReviewResult, args: CounselReviewArgs): string[] {
  const lines = [
    `counsel-review: ${r.apply ? '--apply' : 'dry run'} as database role ${r.role}`,
    `reviewed on ${args.reviewedOn}; source: ${args.reference}`,
  ];
  for (const ch of r.changes) {
    lines.push(`${ch.key} (version ${ch.version})`);
    if (ch.changed) {
      lines.push(`  before: ${describeState(ch.before, ch.vendorChecked)}`);
      lines.push(`  after:  ${describeState(ch.after, ch.vendorChecked)}`);
    } else {
      lines.push(`  unchanged: already recorded as ${describeState(ch.before, ch.vendorChecked)}`);
    }
  }
  const n = r.changes.filter((ch) => ch.changed).length;
  const same = r.changes.length - n;
  if (n === 0) lines.push(`nothing to change: ${same} already recorded; nothing was changed`);
  else if (r.apply) lines.push(`applied: ${n} recorded, ${same} already recorded`);
  else lines.push(`dry run: ${n} would be recorded, ${same} already recorded; nothing was changed (run again with --apply to record)`);
  return lines;
}

export interface RunCounselReviewOptions {
  /** owner connection URL (MIGRATION_DATABASE_URL); undefined/empty is refused */
  url: string | undefined;
  log: (line: string) => void;
  error: (line: string) => void;
  /** the clock for the "not in the future" check (tests) */
  now?: Date;
}

/** The command: parse, connect as the owner, record, print. Returns the exit code (0 ok, 1 refused or failed). */
export async function runCounselReview(argv: readonly string[], o: RunCounselReviewOptions): Promise<number> {
  let args: CounselReviewArgs;
  try {
    const parsed = parseCounselReviewArgs(argv, utcDate(o.now ?? new Date()));
    if (parsed === 'help') {
      o.log(COUNSEL_REVIEW_USAGE);
      return 0;
    }
    args = parsed;
  } catch (err) {
    if (!(err instanceof CounselReviewRefused)) throw err;
    o.error(`counsel-review refused: ${err.message}; nothing was changed`);
    o.error(COUNSEL_REVIEW_USAGE);
    return 1;
  }
  if (!o.url) {
    o.error('counsel-review refused: MIGRATION_DATABASE_URL is not set (the database owner role); nothing was changed');
    return 1;
  }
  const c = new pg.Client({ connectionString: o.url, application_name: 'realty-counsel-review' });
  try {
    await c.connect();
    const r = await recordCounselReview(c, args);
    for (const line of formatCounselReview(r, args)) o.log(line);
    return 0;
  } catch (err) {
    if (err instanceof CounselReviewRefused) o.error(`counsel-review refused: ${err.message}; nothing was changed`);
    else o.error(`counsel-review failed: ${err instanceof Error ? err.message : String(err)} (a re-run is safe: a pack already recorded is reported unchanged)`);
    return 1;
  } finally {
    await c.end().catch(() => {});
  }
}
