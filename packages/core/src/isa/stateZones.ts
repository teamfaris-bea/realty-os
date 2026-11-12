// State and territory → every IANA zone it spans (docs/AI_ISA.md §5.3; R-ISA-10). Versioned static data.
// EVERY ROW VERIFY: a state that spans two zones lists both (the union is conservative by design). Seeded into the
// DB reference table `ai_isa_state_zones` by ISA-2's migration; a test keeps the two equal.
//
// Also the 3-digit ZIP prefix → state ranges used to read the inquiry postal code's state. VERIFY: a handful of
// prefixes are shared or military (APO/FPO/DPO prefixes map to no state and add nothing).
export const STATE_ZONES_VERSION = 'isa-state-zones/2026.11.0';

export const STATE_ZONES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  AL: ['America/Chicago'],
  AK: ['America/Anchorage', 'America/Adak'],
  AZ: ['America/Phoenix', 'America/Denver'],
  AR: ['America/Chicago'],
  CA: ['America/Los_Angeles'],
  CO: ['America/Denver'],
  CT: ['America/New_York'],
  DE: ['America/New_York'],
  DC: ['America/New_York'],
  FL: ['America/New_York', 'America/Chicago'],
  GA: ['America/New_York'],
  HI: ['Pacific/Honolulu'],
  ID: ['America/Boise', 'America/Los_Angeles'],
  IL: ['America/Chicago'],
  IN: ['America/Indiana/Indianapolis', 'America/Chicago'],
  IA: ['America/Chicago'],
  KS: ['America/Chicago', 'America/Denver'],
  KY: ['America/New_York', 'America/Chicago'],
  LA: ['America/Chicago'],
  ME: ['America/New_York'],
  MD: ['America/New_York'],
  MA: ['America/New_York'],
  MI: ['America/Detroit', 'America/Menominee'],
  MN: ['America/Chicago'],
  MS: ['America/Chicago'],
  MO: ['America/Chicago'],
  MT: ['America/Denver'],
  NE: ['America/Chicago', 'America/Denver'],
  NV: ['America/Los_Angeles', 'America/Denver'],
  NH: ['America/New_York'],
  NJ: ['America/New_York'],
  NM: ['America/Denver'],
  NY: ['America/New_York'],
  NC: ['America/New_York'],
  ND: ['America/Chicago', 'America/Denver'],
  OH: ['America/New_York'],
  OK: ['America/Chicago'],
  OR: ['America/Los_Angeles', 'America/Boise'],
  PA: ['America/New_York'],
  RI: ['America/New_York'],
  SC: ['America/New_York'],
  SD: ['America/Chicago', 'America/Denver'],
  TN: ['America/Chicago', 'America/New_York'],
  TX: ['America/Chicago', 'America/Denver'],
  UT: ['America/Denver'],
  VT: ['America/New_York'],
  VA: ['America/New_York'],
  WA: ['America/Los_Angeles'],
  WV: ['America/New_York'],
  WI: ['America/Chicago'],
  WY: ['America/Denver'],
  // territories
  PR: ['America/Puerto_Rico'],
  VI: ['America/St_Thomas'],
  GU: ['Pacific/Guam'],
  AS: ['Pacific/Pago_Pago'],
  MP: ['Pacific/Saipan'],
  // Canada (NANP numbers)
  AB: ['America/Edmonton'],
  BC: ['America/Vancouver', 'America/Edmonton', 'America/Creston'],
  MB: ['America/Winnipeg'],
  NB: ['America/Moncton'],
  NL: ['America/St_Johns', 'America/Goose_Bay'],
  NS: ['America/Halifax'],
  PE: ['America/Halifax'],
  ON: ['America/Toronto', 'America/Winnipeg'],
  QC: ['America/Toronto', 'America/Halifax'],
  SK: ['America/Regina'],
  YT: ['America/Whitehorse'],
  NT: ['America/Yellowknife'],
  NU: ['America/Iqaluit', 'America/Winnipeg', 'America/Edmonton'],
});

/** [first, last] 3-digit ZIP prefix → state. VERIFY. */
export const ZIP3_RANGES: readonly (readonly [number, number, string])[] = Object.freeze([
  [5, 5, 'NY'],
  [6, 7, 'PR'],
  [8, 8, 'VI'],
  [9, 9, 'PR'],
  [10, 27, 'MA'],
  [28, 29, 'RI'],
  [30, 38, 'NH'],
  [39, 49, 'ME'],
  [50, 59, 'VT'],
  [60, 69, 'CT'],
  [70, 89, 'NJ'],
  [100, 149, 'NY'],
  [150, 196, 'PA'],
  [197, 199, 'DE'],
  [200, 205, 'DC'],
  [206, 219, 'MD'],
  [220, 246, 'VA'],
  [247, 268, 'WV'],
  [270, 289, 'NC'],
  [290, 299, 'SC'],
  [300, 319, 'GA'],
  [320, 349, 'FL'],
  [350, 369, 'AL'],
  [370, 385, 'TN'],
  [386, 397, 'MS'],
  [398, 399, 'GA'],
  [400, 427, 'KY'],
  [430, 458, 'OH'],
  [460, 479, 'IN'],
  [480, 499, 'MI'],
  [500, 528, 'IA'],
  [530, 549, 'WI'],
  [550, 567, 'MN'],
  [569, 569, 'DC'],
  [570, 577, 'SD'],
  [580, 588, 'ND'],
  [590, 599, 'MT'],
  [600, 629, 'IL'],
  [630, 658, 'MO'],
  [660, 679, 'KS'],
  [680, 693, 'NE'],
  [700, 714, 'LA'],
  [716, 729, 'AR'],
  [730, 732, 'OK'],
  [733, 733, 'TX'],
  [734, 749, 'OK'],
  [750, 799, 'TX'],
  [800, 816, 'CO'],
  [820, 831, 'WY'],
  [832, 838, 'ID'],
  [840, 847, 'UT'],
  [850, 865, 'AZ'],
  [870, 884, 'NM'],
  [885, 885, 'TX'],
  [889, 898, 'NV'],
  [900, 961, 'CA'],
  [967, 968, 'HI'],
  [969, 969, 'GU'],
  [970, 979, 'OR'],
  [980, 994, 'WA'],
  [995, 999, 'AK'],
]);

/** The state of a US postal code ("94110", "94110-1234"), or null. */
export function stateOfPostalCode(postal: string | null | undefined): string | null {
  if (typeof postal !== 'string') return null;
  const m = /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(postal);
  if (m === null) return null;
  const p = Number((m[1] as string).slice(0, 3));
  for (const [a, b, st] of ZIP3_RANGES) if (p >= a && p <= b) return st;
  return null;
}

/** The zones of a state code (upper-cased), or []. */
export function zonesOfState(state: string | null | undefined): readonly string[] {
  if (typeof state !== 'string') return [];
  return STATE_ZONES[state.trim().toUpperCase()] ?? [];
}
