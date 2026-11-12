// Settings of module 78 api/homeowner (owner decision D10). Platform defaults, on the predict/settings.ts pattern:
// each is one constant an owner question can change (owner questions 1-18 keep the recommended defaults).
// VERIFY WITH COUNSEL: the retention ceiling (R-DATA-6: at most 12 months for property records and homeowner profiles).

export interface HomeownerSettings {
  /** a profile is re-checked this many days after its last answered lookup (monthly, D10) */
  refreshAgeDays: number;
  /** after a failure the county is tried again this many days later (E572) */
  failureRetryDays: number;
  /** county lookups per tenant per local date at most (E586) */
  lookupBudgetPerDay: number;
  /** a profile is kept this many days after its last answered lookup (1-365; R-DATA-6) */
  retentionDays: number;
  /** contacts per page of the candidate scan */
  pageSize: number;
  /** pages per pass at most (bounds one pass) */
  maxPages: number;
  /** the tag keys (lower NFKC, as tags.name_key) that recognise a homeowner; a protected-proxy tag never does */
  homeownerTagKeys: readonly string[];
  /** failures in one pass with no success that raise the P2 PUBLIC_RECORDS_SOURCE_FAILING alert */
  failureAlertThreshold: number;
  /** the local night window [start, end) the pass acts in */
  nightStartHour: number;
  nightEndHour: number;
  /** rows each purge statement deletes at most per pass */
  purgeLimit: number;
}

export const MAX_RETENTION_DAYS = 365;
export const HOMEOWNER_REFRESH_EVERY_MS = 3_600_000;

export const HOMEOWNER_SETTINGS: Readonly<HomeownerSettings> = Object.freeze({
  refreshAgeDays: 30,
  failureRetryDays: 1,
  lookupBudgetPerDay: 100,
  retentionDays: 365,
  pageSize: 200,
  maxPages: 25,
  homeownerTagKeys: Object.freeze(['homeowner']),
  failureAlertThreshold: 5,
  nightStartHour: 2,
  nightEndHour: 5,
  purgeLimit: 1000,
});

export function resolveHomeownerSettings(o: Partial<HomeownerSettings> = {}): HomeownerSettings {
  const s = { ...HOMEOWNER_SETTINGS, ...o, homeownerTagKeys: (o.homeownerTagKeys ?? HOMEOWNER_SETTINGS.homeownerTagKeys).map((k) => k.normalize('NFKC').toLowerCase()) };
  if (!(Number.isInteger(s.retentionDays) && s.retentionDays >= 1 && s.retentionDays <= MAX_RETENTION_DAYS)) throw new RangeError('retentionDays: 1 to 365 (R-DATA-6)');
  if (!(Number.isSafeInteger(s.lookupBudgetPerDay) && s.lookupBudgetPerDay >= 0)) throw new RangeError('lookupBudgetPerDay: a whole number ≥ 0');
  if (!(s.refreshAgeDays >= 1 && s.refreshAgeDays <= s.retentionDays)) throw new RangeError('refreshAgeDays: 1 to retentionDays');
  if (!(s.failureRetryDays >= 1)) throw new RangeError('failureRetryDays ≥ 1');
  if (!(s.pageSize >= 1 && s.maxPages >= 1 && s.purgeLimit >= 1)) throw new RangeError('pageSize, maxPages, purgeLimit ≥ 1');
  if (!(s.failureAlertThreshold >= 1)) throw new RangeError('failureAlertThreshold ≥ 1');
  if (!(s.nightStartHour >= 0 && s.nightStartHour < s.nightEndHour && s.nightEndHour <= 24)) throw new RangeError('night window');
  return s;
}
