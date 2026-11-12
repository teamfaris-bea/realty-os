// Recording counsel review of platform clearance packs on a deployment (R-INT-6; docs/DEPLOY.md §10.1).
//
//   pnpm --filter @realty/db counsel-review -- --keys platform:<name>@<version>[,...] --reviewed-on YYYY-MM-DD --reference "<source>" [--apply]
//   pnpm --filter @realty/db counsel-review -- --revoke --keys platform:<name>@<version>[,...] --reference "<source>" [--apply]
//   node packages/db/dist/scripts/counsel-review.js <same flags>          (in the api image)
//
// A platform pack (jurisdiction_packs key 'platform:<name>') gates its capability through app.platform_cleared
// (0018): cleared once the published version has reviewed_by_counsel_at and, where the database also asks for a
// vendor check (voice, Gmail), rules.vendor_ready_at. Packs ship unreviewed and the migrations stay that way; this
// command is the one writer of reviewed_by_counsel_at. Each key is pinned to the version counsel reviewed
// (platform:<name>@<version>) and is recorded only while that version is the PUBLISHED one: a later version ships
// unreviewed and turns its capability off again, and an old pin (a standing runbook command replayed after a pack
// bump) is refused rather than stamped onto a version counsel never saw. It sets reviewed_by_counsel_at on that
// version (00:00 UTC of --reviewed-on) and appends one note: when it was recorded, by which database role, the
// version, the review date and the reported source (--reference). --revoke withdraws a recorded review the same
// way: reviewed_by_counsel_at back to NULL and a withdrawal note. It never writes rules, so it never sets or changes
// vendor_ready_at: vendor checks are separate (Google's verification for Gmail, a real vendor's latency check for
// voice).
//
// All or nothing, in one transaction: a refused key, a bad flag or a role that cannot write the packs changes
// nothing. A pack already recorded with the same date by this command (its own note for that version is the last
// review event in the notes) is reported unchanged (idempotent); one recorded with a different date is refused,
// never overwritten (withdraw it with --revoke first); one whose review was set outside this command is refused and
// named, never reported as recorded. A dry run (the default) makes the same changes inside the transaction to
// report the outcome, then rolls back; --apply commits.
//
// Runs as the database owner role only: app_user has SELECT on jurisdiction_packs and nothing more, and the table
// is FORCE ROW LEVEL SECURITY with a read policy only, so the writer must also be superuser or BYPASSRLS (the
// owner that applies the migrations). There is no platform-level audit table (audit_log is per tenant), so the
// audit trail is the pack's notes plus this command's printed output (keep it with the deploy log).
import pg from 'pg';

export const COUNSEL_REVIEW_USAGE = [
  'Usage: pnpm --filter @realty/db counsel-review -- --keys platform:<name>@<version>[,...] --reviewed-on YYYY-MM-DD --reference "<reported source>" [--apply]',
  '       pnpm --filter @realty/db counsel-review -- --revoke --keys platform:<name>@<version>[,...] --reference "<reported source>" [--apply]',
  '   or: node packages/db/dist/scripts/counsel-review.js <same flags>   (in the api image)',
  'Records (with --revoke: withdraws) counsel review on each named platform pack, as the database owner role',
  '(MIGRATION_DATABASE_URL). <version> is the version counsel reviewed; it must be the published one.',
  'A dry run by default (--dry-run): prints before and after per key and changes nothing; --apply commits.',
  'Never sets rules.vendor_ready_at: voice and Gmail also wait for their vendor checks.',
].join('\n');

/** D2: packs that are never cleared (apps/api/src/integrations/catalog.ts NEVER_CLEARED_PACKS; 0025 notes "Do not clear"). */
export const NEVER_CLEARED_PACKS: readonly string[] = ['platform:meta'];

/** No platform pack existed before this date (0018 seeds version 2026.11.0): an earlier review date is a typing error. */
export const EARLIEST_REVIEW_DATE = '2026-01-01';

const PLATFORM_KEY = /^platform:[a-z_]+$/; // the 0018 jurisdiction_packs_key_check for platform packs
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
/** a version named YYYY.MM[.N] (every pack so far) did not exist before the first day of that month */
const VERSION_MONTH = /^(\d{4})\.(0[1-9]|1[0-2])(?:\.|$)/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REFERENCE = 300;
/** control (Cc), format (Cf: bidi overrides, zero-width), private-use, unassigned, line and paragraph separators */
const NOT_PLAIN_TEXT = /[\p{C}\p{Zl}\p{Zp}]/u;
/** the notes this command appends; read back to tell its own record from a review set outside it */
const NOTE_EVENT =
  /Counsel review (recorded|withdrawn) \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z by database role .+?: version ([^\s,]+)(?: reviewed on (\d{4}-\d{2}-\d{2});|, recorded as reviewed on )/g;
// regexp over pg_proc.prosrc: the packs whose gates call app.platform_cleared(key, true) (the integrations test uses the same scan)
const VENDOR_CHECK_CALLS = String.raw`platform_cleared\('(platform:[a-z_]+)',\s*true\)`;

/** A refusal: the operator's input or the deployment's state, never a crash. Nothing was changed. */
export class CounselReviewRefused extends Error {
  override name = 'CounselReviewRefused';
}

export type CounselReviewMode = 'record' | 'revoke';

/** A key pinned to the version counsel reviewed. */
export interface PackPin {
  key: string;
  version: string;
}

export interface CounselReviewArgs {
  /** record (the default) or revoke (--revoke) */
  mode: CounselReviewMode;
  packs: PackPin[];
  /** record: the date counsel reviewed the pinned versions; revoke: null */
  reviewedOn: string | null;
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
  /** false: nothing written (record: already recorded with this date; revoke: not reviewed by counsel) */
  changed: boolean;
  before: PackState;
  after: PackState;
}

export interface CounselReviewResult {
  mode: CounselReviewMode;
  apply: boolean;
  role: string;
  changes: PackChange[];
}

/** UTC calendar date (YYYY-MM-DD) of an instant. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Why a pin cannot be named for this mode, or null. */
function pinProblem(p: PackPin, mode: CounselReviewMode): string | null {
  if (!PLATFORM_KEY.test(p.key)) {
    return `'${p.key}' is not a platform pack key (platform:<name>@<version>); jurisdiction packs such as 'US' are not recorded with this command`;
  }
  if (p.version === '') {
    return `${p.key} names no version: pin the version counsel reviewed (${p.key}@<version>, e.g. @2026.11.0); a review is recorded only while that version is the published one`;
  }
  if (!VERSION.test(p.version)) return `'${p.version}' is not a pack version (${p.key}@<version>, e.g. @2026.11.0)`;
  if (mode === 'record' && NEVER_CLEARED_PACKS.includes(p.key)) {
    return `${p.key} is never cleared (owner decision D2): nothing in the product waits on it and its notes say "Do not clear"`;
  }
  return null;
}

function parsePins(tokens: readonly string[], mode: CounselReviewMode): PackPin[] {
  const pins = new Map<string, string>();
  for (const t of tokens) {
    const at = t.indexOf('@');
    const p = at < 0 ? { key: t, version: '' } : { key: t.slice(0, at), version: t.slice(at + 1) };
    const problem = pinProblem(p, mode);
    if (problem) throw new CounselReviewRefused(problem);
    const prev = pins.get(p.key);
    if (prev !== undefined && prev !== p.version) {
      throw new CounselReviewRefused(`${p.key} is named with two versions (${prev}, ${p.version}): name the one version counsel reviewed`);
    }
    pins.set(p.key, p.version);
  }
  return [...pins].map(([key, version]) => ({ key, version }));
}

function checkReviewDate(d: string, pins: readonly PackPin[], today: string): void {
  if (!DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || utcDate(new Date(`${d}T00:00:00Z`)) !== d) {
    throw new CounselReviewRefused(`--reviewed-on must be a date YYYY-MM-DD (got '${d}')`);
  }
  // also keeps year 0000 (which Postgres rejects) from ever reaching the database
  if (d < EARLIEST_REVIEW_DATE) throw new CounselReviewRefused(`--reviewed-on ${d} is before ${EARLIEST_REVIEW_DATE}: no platform pack existed then`);
  for (const p of pins) {
    const m = VERSION_MONTH.exec(p.version);
    if (m && d < `${m[1]}-${m[2]}-01`) {
      throw new CounselReviewRefused(`--reviewed-on ${d} is before version ${p.version} of ${p.key} existed (${m[1]}-${m[2]}): counsel cannot have reviewed that version then`);
    }
  }
  if (d > today) throw new CounselReviewRefused(`--reviewed-on ${d} is in the future (today is ${today} UTC)`);
}

/**
 * Parses the command line. `today` is the UTC date the review date may not exceed (an early check on the client's
 * clock; recordCounselReview checks the database's clock too). Throws CounselReviewRefused.
 */
export function parseCounselReviewArgs(argv: readonly string[], today: string): CounselReviewArgs | 'help' {
  const tokens: string[] = [];
  let reviewedOn: string | undefined;
  let reference: string | undefined;
  let apply: boolean | undefined;
  let revoke = false;
  const seen = new Set<string>();
  const once = (flag: string): void => {
    if (seen.has(flag)) throw new CounselReviewRefused(`${flag} is given more than once`);
    seen.add(flag);
  };
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
        tokens.push(...value().split(',').map((k) => k.trim()).filter((k) => k !== ''));
        break;
      case '--reviewed-on':
        once(flag);
        reviewedOn = value();
        break;
      case '--reference':
        once(flag);
        reference = value();
        break;
      case '--apply':
      case '--dry-run':
      case '--revoke':
        if (eq > 0) throw new CounselReviewRefused(`${flag} takes no value`);
        once(flag);
        if (flag === '--revoke') {
          revoke = true;
        } else {
          if (apply !== undefined) throw new CounselReviewRefused('--apply and --dry-run cannot be combined: give one (a dry run is the default)');
          apply = flag === '--apply';
        }
        break;
      default:
        throw new CounselReviewRefused(`unknown option ${flag}`);
    }
  }
  const mode: CounselReviewMode = revoke ? 'revoke' : 'record';
  if (tokens.length === 0) throw new CounselReviewRefused('--keys is required: one or more platform:<name>@<version> keys, comma-separated');
  const packs = parsePins(tokens, mode);
  if (mode === 'record') {
    if (reviewedOn === undefined) throw new CounselReviewRefused('--reviewed-on is required: the date counsel reviewed the packs (YYYY-MM-DD)');
    checkReviewDate(reviewedOn, packs, today);
  } else if (reviewedOn !== undefined) {
    throw new CounselReviewRefused('--reviewed-on is not used with --revoke: it withdraws the review recorded on each pinned version');
  }
  const ref = reference?.trim() ?? '';
  if (ref === '') throw new CounselReviewRefused('--reference is required: who reported the review (or its withdrawal) and where it is recorded, e.g. "counsel review reported by the owner, 2026-11-12"');
  if (NOT_PLAIN_TEXT.test(ref)) throw new CounselReviewRefused('--reference must be one line of plain text (no control, format or line-separator characters)');
  if (/counsel review (recorded|withdrawn)/i.test(ref)) throw new CounselReviewRefused("--reference may not contain this command's own note text ('Counsel review recorded' or 'withdrawn')");
  if (ref.length > MAX_REFERENCE) throw new CounselReviewRefused(`--reference is longer than ${MAX_REFERENCE} characters`);
  return { mode, packs, reviewedOn: reviewedOn ?? null, reference: ref, apply: apply ?? false };
}

const sourceOf = (reference: string): string => (/[.!?]$/.test(reference) ? reference : `${reference}.`);

/** The note appended to a pack's notes when its review is recorded. */
export function counselReviewNote(o: { recordedAt: string; role: string; version: string; reviewedOn: string; reference: string; vendorChecked: boolean }): string {
  const vendor = o.vendorChecked ? ' The vendor check (rules.vendor_ready_at) is separate and was not recorded.' : '';
  return `Counsel review recorded ${o.recordedAt} by database role ${o.role}: version ${o.version} reviewed on ${o.reviewedOn}; source: ${sourceOf(o.reference)}${vendor}`;
}

/** The note appended to a pack's notes when its review is withdrawn (--revoke). */
export function counselWithdrawalNote(o: { recordedAt: string; role: string; version: string; wasReviewedOn: string; reference: string }): string {
  return `Counsel review withdrawn ${o.recordedAt} by database role ${o.role}: version ${o.version}, recorded as reviewed on ${o.wasReviewedOn}; source: ${sourceOf(o.reference)}`;
}

/** The last review event this command wrote into `notes` for `version` (a record or a withdrawal), or null. */
export function lastCounselReviewEvent(notes: string | null, version: string): { kind: 'recorded' | 'withdrawn'; reviewedOn: string | null } | null {
  let last: { kind: 'recorded' | 'withdrawn'; reviewedOn: string | null } | null = null;
  for (const m of (notes ?? '').matchAll(NOTE_EVENT)) {
    if (m[2] === version) last = { kind: m[1] as 'recorded' | 'withdrawn', reviewedOn: m[3] ?? null };
  }
  return last;
}

interface Row {
  key: string;
  version: string;
  status: string;
  notes: string | null;
  reviewed_on: string | null;
  /** reviewed_by_counsel_at is 00:00 UTC, as this command writes it */
  reviewed_at_midnight: boolean | null;
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

/** Refuses unless the pinned version is the key's published version; returns that row. */
function publishedPin(rows: readonly Row[], pin: PackPin, mode: CounselReviewMode): Row {
  const versions = rows.filter((r) => r.key === pin.key);
  if (versions.length === 0) throw new CounselReviewRefused(`${pin.key}: no such pack on this deployment`);
  const pub = versions.find((r) => r.status === 'published');
  if (!pub) {
    throw new CounselReviewRefused(`${pin.key} has no published version (${versions.map((v) => `${v.status} ${v.version}`).join(', ')}); counsel review is recorded on the published version`);
  }
  if (pub.version === pin.version) return pub;
  const pinned = versions.find((r) => r.version === pin.version);
  let why: string;
  if (!pinned) why = `there is no version ${pin.version}`;
  else if (pinned.status === 'draft') why = `${pin.version} is a draft, not yet published; record its review once it is published`;
  else if (mode === 'record') why = `${pin.version} is ${pinned.status}, so the version counsel reviewed is no longer the published one; ${pub.version} needs its own counsel review`;
  else why = `${pin.version} is ${pinned.status}; a review is withdrawn from the published version only`;
  throw new CounselReviewRefused(`${pin.key}@${pin.version} is not the published version ${pub.version}: ${why}`);
}

/**
 * Records (or with mode 'revoke' withdraws) counsel review of the pinned packs in one transaction on `c` (a
 * connected client, no open transaction). Commits only with args.apply; otherwise rolls back. Throws
 * CounselReviewRefused (nothing changed) on any refusal.
 */
export async function recordCounselReview(c: pg.ClientBase, args: CounselReviewArgs): Promise<CounselReviewResult> {
  for (const p of args.packs) {
    const problem = pinProblem(p, args.mode);
    if (problem) throw new CounselReviewRefused(problem);
  }
  const reviewedOn = args.reviewedOn;
  if (args.mode === 'record' && reviewedOn === null) throw new CounselReviewRefused('--reviewed-on is required');

  await c.query('BEGIN');
  try {
    await c.query("SET LOCAL lock_timeout = '10s'");
    const who = (
      await c.query<{ role: string; su: boolean; bypass: boolean; can_update: boolean; recorded_at: string; db_today: string }>(
        `SELECT current_user AS role, r.rolsuper AS su, r.rolbypassrls AS bypass,
                has_table_privilege('public.jurisdiction_packs', 'UPDATE') AS can_update,
                to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recorded_at,
                to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS db_today
           FROM pg_roles r WHERE r.rolname = current_user`,
      )
    ).rows[0]!;
    if (!who.can_update) {
      throw new CounselReviewRefused(`database role ${who.role} cannot update jurisdiction_packs: run this as the database owner role (MIGRATION_DATABASE_URL), never the app's login`);
    }
    if (!who.su && !who.bypass) {
      throw new CounselReviewRefused(`database role ${who.role} is subject to row-level security on jurisdiction_packs (not superuser, no BYPASSRLS): run this as the owner role that applies the migrations`);
    }

    const rows = (
      await c.query<Row>(
        `SELECT key, version, status, notes, to_char(reviewed_by_counsel_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS reviewed_on,
                (reviewed_by_counsel_at AT TIME ZONE 'UTC')::time = time '00:00' AS reviewed_at_midnight,
                rules->>'vendor_ready_at' AS vendor_ready_at
           FROM public.jurisdiction_packs WHERE key = ANY ($1::text[]) ORDER BY key, version FOR UPDATE`,
        [args.packs.map((p) => p.key)],
      )
    ).rows;
    const vendorChecked = new Set(
      (await c.query<{ key: string }>('SELECT DISTINCT m[1] AS key FROM pg_proc p CROSS JOIN LATERAL regexp_matches(p.prosrc, $1, \'g\') AS m', [VENDOR_CHECK_CALLS])).rows.map(
        (r) => r.key,
      ),
    );

    const targets = args.packs.map((pin) => ({ key: pin.key, row: publishedPin(rows, pin, args.mode), vendorChecked: vendorChecked.has(pin.key) }));

    if (reviewedOn !== null && reviewedOn > who.db_today) {
      // the parser checked the client's clock; this is the database's (the clock of the note's recorded time)
      throw new CounselReviewRefused(`--reviewed-on ${reviewedOn} is after today on the database clock (${who.db_today} UTC)`);
    }
    if (args.mode === 'record') {
      for (const { key, row } of targets) {
        if (row.reviewed_on === null) continue;
        if (row.reviewed_on !== reviewedOn) {
          throw new CounselReviewRefused(
            `${key} is already recorded as reviewed by counsel on ${row.reviewed_on} (version ${row.version}); this command never overwrites a recorded review: if that is wrong, withdraw it with --revoke, then record the right date`,
          );
        }
        const last = lastCounselReviewEvent(row.notes, row.version);
        if (!row.reviewed_at_midnight || last?.kind !== 'recorded' || last.reviewedOn !== reviewedOn) {
          throw new CounselReviewRefused(
            `${key} has reviewed_by_counsel_at on ${row.reviewed_on} (version ${row.version}) but no note from this command recording that review: it was set outside this command (by hand, by a test or from a backup) and needs the owner's attention; if counsel did review this version, withdraw it with --revoke and record it again`,
          );
        }
      }
    }

    const changes: PackChange[] = [];
    for (const t of targets) {
      const before = await stateOf(c, t.key, t.vendorChecked);
      const changed = args.mode === 'record' ? t.row.reviewed_on === null : t.row.reviewed_on !== null;
      if (changed) {
        const u =
          args.mode === 'record'
            ? await c.query(
                `UPDATE public.jurisdiction_packs SET reviewed_by_counsel_at = $3::timestamptz, notes = concat_ws(' ', notes, $4::text)
                  WHERE key = $1 AND version = $2 AND status = 'published' AND reviewed_by_counsel_at IS NULL`,
                [
                  t.key,
                  t.row.version,
                  `${reviewedOn!}T00:00:00Z`,
                  counselReviewNote({ recordedAt: who.recorded_at, role: who.role, version: t.row.version, reviewedOn: reviewedOn!, reference: args.reference, vendorChecked: t.vendorChecked }),
                ],
              )
            : await c.query(
                `UPDATE public.jurisdiction_packs SET reviewed_by_counsel_at = NULL, notes = concat_ws(' ', notes, $3::text)
                  WHERE key = $1 AND version = $2 AND status = 'published' AND reviewed_by_counsel_at IS NOT NULL`,
                [
                  t.key,
                  t.row.version,
                  counselWithdrawalNote({ recordedAt: who.recorded_at, role: who.role, version: t.row.version, wasReviewedOn: t.row.reviewed_on!, reference: args.reference }),
                ],
              );
        if (u.rowCount !== 1) throw new Error(`${t.key}: expected to update 1 row, updated ${u.rowCount ?? 0}`);
      }
      changes.push({ key: t.key, version: t.row.version, vendorChecked: t.vendorChecked, changed, before, after: await stateOf(c, t.key, t.vendorChecked) });
    }

    await c.query(args.apply ? 'COMMIT' : 'ROLLBACK');
    return { mode: args.mode, apply: args.apply, role: who.role, changes };
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
  const revoke = r.mode === 'revoke';
  const lines = [
    `counsel-review${revoke ? ' --revoke' : ''}: ${r.apply ? '--apply' : 'dry run'} as database role ${r.role}`,
    revoke ? `withdrawing the recorded review; source: ${args.reference}` : `reviewed on ${args.reviewedOn}; source: ${args.reference}`,
  ];
  for (const ch of r.changes) {
    lines.push(`${ch.key} (version ${ch.version})`);
    if (ch.changed) {
      lines.push(`  before: ${describeState(ch.before, ch.vendorChecked)}`);
      lines.push(`  after:  ${describeState(ch.after, ch.vendorChecked)}`);
    } else if (revoke) {
      lines.push(`  unchanged: ${describeState(ch.before, ch.vendorChecked)} (nothing to withdraw)`);
    } else {
      lines.push(`  unchanged: already recorded as ${describeState(ch.before, ch.vendorChecked)}`);
    }
  }
  const n = r.changes.filter((ch) => ch.changed).length;
  const same = r.changes.length - n;
  const [done, would, rest, again] = revoke
    ? ['withdrawn', 'would be withdrawn', 'not reviewed by counsel', 'to withdraw']
    : ['recorded', 'would be recorded', 'already recorded', 'to record'];
  if (n === 0) lines.push(`nothing to change: ${same} ${rest}; nothing was changed`);
  else if (r.apply) lines.push(`applied: ${n} ${done}, ${same} ${rest}`);
  else lines.push(`dry run: ${n} ${would}, ${same} ${rest}; nothing was changed (run again with --apply ${again})`);
  return lines;
}

export interface RunCounselReviewOptions {
  /** owner connection URL (MIGRATION_DATABASE_URL); undefined/empty is refused */
  url: string | undefined;
  log: (line: string) => void;
  error: (line: string) => void;
  /** the client clock for the early "not in the future" check (tests); the database clock is checked as well */
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
