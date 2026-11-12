// INTERIM (lane V1-C, until lane V1-A merges): the licence pack's `valuation` section and the client sold fields.
//
// V1-A adds `valuation` (with its own counsel stamp) to core/listings' LicensePack, `valuationUse()` to read it, and the
// sold fields to DISPLAY_FIELDS for applyDisplayRules. Until then core parseLicensePack drops unknown keys, so this reads
// the stored JSON itself, with the same strictest-default rule: a missing or invalid key never allows anything.
//
// Stored shape (snake_case, inside integration_connections.license_pack), VERIFY WITH MLS / COUNSEL (V1, V4, V6):
//   "valuation": {
//     "reviewed_by_counsel_at": ISO | null,     the section's own counsel stamp
//     "agent_cma": boolean,                     MLS sold data may be used for agents' CMAs (owner question (a))
//     "client_cma": boolean,                    ... for CMAs shared with clients
//     "automated_notes": boolean,               ... for automated notes and seller-update value ranges
//     "avm_flag_scope": "all_client_outputs" | "internet_display_only",   InternetAutomatedValuationDisplayYN's reach (V6)
//     "statements": { "<USPS state>": "<statement entered from counsel>" }  per state; none is shipped (V4)
//   }
// The client audience's sold fields: "closePrice" and "closeDate" in audiences.client.fields (V1-A's names; VERIFY at
// merge). No legal text is shipped here.
import { instantFromIso } from '@realty/core/foundation';

export type AvmFlagScope = 'all_client_outputs' | 'internet_display_only';

export interface ValuationUse {
  reviewedByCounselAt: string | null;
  agentCma: boolean;
  clientCma: boolean;
  automatedNotes: boolean;
  avmFlagScope: AvmFlagScope;
  statements: Readonly<Record<string, string>>;
}

export const STRICTEST_VALUATION_USE: ValuationUse = Object.freeze({
  reviewedByCounselAt: null,
  agentCma: false,
  clientCma: false,
  automatedNotes: false,
  avmFlagScope: 'all_client_outputs',
  statements: Object.freeze({}),
});

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The valuation section of a stored licence pack. Never throws; missing or invalid keys are strictest. */
export function valuationUse(storedPack: unknown): ValuationUse {
  const v = obj(obj(storedPack)?.['valuation']);
  if (v === null) return STRICTEST_VALUATION_USE;
  const stamp = typeof v['reviewed_by_counsel_at'] === 'string' && instantFromIso(v['reviewed_by_counsel_at']) !== null ? v['reviewed_by_counsel_at'] : null;
  const statements: Record<string, string> = {};
  const s = obj(v['statements']);
  if (s) {
    for (const [k, t] of Object.entries(s)) {
      if (/^[A-Z]{2}$/.test(k) && typeof t === 'string' && t.trim().length > 0 && t.length <= 4000) statements[k] = t.trim();
    }
  }
  return {
    reviewedByCounselAt: stamp,
    agentCma: v['agent_cma'] === true,
    clientCma: v['client_cma'] === true,
    automatedNotes: v['automated_notes'] === true,
    avmFlagScope: v['avm_flag_scope'] === 'internet_display_only' ? 'internet_display_only' : 'all_client_outputs',
    statements,
  };
}

export const SOLD_CLIENT_FIELDS = ['closePrice', 'closeDate'] as const;

/** Whether the pack lets clients see sold prices and dates (both fields in the client audience). */
export function soldFieldsAllowed(storedPack: unknown): boolean {
  const f = obj(obj(obj(storedPack)?.['audiences'])?.['client'])?.['fields'];
  return Array.isArray(f) && SOLD_CLIENT_FIELDS.every((x) => f.includes(x));
}
