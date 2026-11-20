// Response and body schemas of the Lead sources routes (module 22; DATA_MODEL R-LSRC-1..5). No confidence or score
// field and no tenant id in any response (R-AST-13, R-TEN-3; matrix.test.ts checks LEAD_SOURCES_RESPONSE_SCHEMAS).
import { COVERAGE_WARNING_CODES, MEMBERSHIP_STATUSES } from '@realty/core/ownership';
import { z } from 'zod';
import { ConsentDisclosureInput } from './schemas.js';
import { TelephonyMode } from '../comms/telephonyMode.js';

const Id = z.uuid();
const Iso = z.string();

export const PathState = z.enum(['on', 'off', 'not_available']);

/**
 * b19 step 2 (R-TEAMQ-10, R-TEAMQ-11): a source's coverage. `covered` is true only while the switch (`setting`) is
 * on and the owner and the backup are both active members; `sentence` says the state in words ("Covered: …",
 * "Not covered: no backup is named."); `warnings` are computed, each a code and a sentence. A suspended or
 * deactivated member stays named (their `status` says so): nothing is reassigned.
 */
export const CoverageMemberView = z.object({ userId: Id, name: z.string().nullable(), status: z.enum(MEMBERSHIP_STATUSES) });
export const CoverageView = z.object({
  owner: CoverageMemberView.nullable(),
  backup: CoverageMemberView.nullable(),
  highIntent: z.boolean(),
  covered: z.boolean(),
  setting: z.boolean(),
  sentence: z.string(),
  warnings: z.array(z.object({ code: z.enum(COVERAGE_WARNING_CODES), sentence: z.string() })),
  /** R-TEAMQ-24: what happens to this source's leads now, in words: the minute-three alert, then the automatic return to the pond with the team's own time */
  effects: z.array(z.string()),
  /** when the owner, the backup, the mark or the switch last changed (null: never set) */
  changedAt: Iso.nullable(),
});
export const CoverageResponse = z.object({ coverage: CoverageView });
/** PUT /lead-sources/:id/coverage: the whole coverage. `covered` true needs both people (422 otherwise). */
export const CoverageBody = z.strictObject({ ownerUserId: Id.nullable(), backupUserId: Id.nullable(), highIntent: z.boolean(), covered: z.boolean() });

export const SourceOverview = z.object({
  id: Id,
  name: z.string(),
  kind: z.string(),
  active: z.boolean(),
  createdAt: Iso,
  /** active_changed_at while the source is off */
  offSince: Iso.nullable(),
  lastLeadAt: Iso.nullable(),
  leadsLast30Days: z.number().int(),
  heldEmails: z.number().int(),
  forwardingConfirmations: z.number().int(),
  /** partner-feed leads skipped because the source was off, in the last 30 days (R-LSRC-2, E597) */
  skippedWhileOffLast30Days: z.number().int(),
  paths: z.object({
    email: z.object({ state: PathState, address: z.string().nullable(), lastEmailAt: Iso.nullable() }),
    webhook: z.object({ hasToken: z.boolean(), ownSecret: z.boolean(), secretCreatedAt: Iso.nullable() }),
    googleLeadForm: z.object({
      state: PathState,
      createdAt: Iso.nullable(),
      inquiryType: z.string().nullable(),
      citesSourceDisclosure: z.boolean().nullable(),
      lastTestAt: Iso.nullable(),
      lastUnreadableAt: Iso.nullable(),
      unreadableCount: z.number().int(),
    }),
    trackingNumbers: z.array(z.object({ id: Id, e164: z.string() })),
    partnerFeeds: z.array(z.object({ kind: z.string(), status: z.string() })),
    webChats: z.array(z.object({ status: z.string() })),
  }),
  hasConsentText: z.boolean(),
  /** b18 item f / B18S-5: "No automated contact for leads from this source" (an Owner setting; the field keeps its b18 name) and its sentence */
  noAiCare: z.boolean(),
  noAiCareSentence: z.string(),
  /** b19 step 2: the source's owner, backup, high-intent mark, covered state and warnings (R-TEAMQ-10, R-TEAMQ-11) */
  coverage: CoverageView,
});
export const OverviewResponse = z.object({ sources: z.array(SourceOverview), deployment: z.object({ inboundEmail: z.boolean(), publicHttps: z.boolean(), telephony: TelephonyMode }) });

export const SourceView = z.object({ id: Id, name: z.string(), kind: z.string(), active: z.boolean(), offSince: Iso.nullable(), hasToken: z.boolean(), createdAt: Iso });
export const SourceResponse = z.object({ source: SourceView });
export const OnOffResponse = z.object({
  source: SourceView,
  /** off: every path that stops, in words; on: every path that works again */
  paths: z.array(z.string()),
  sentence: z.string(),
});
export const WebhookRotatedResponse = z.object({ intakeUrl: z.string(), signingSecret: z.string(), createdAt: Iso });

/** b18 item f: PUT /lead-sources/:id/ai-care (the Owner only) */
export const AiCareBody = z.strictObject({ noAiCare: z.boolean() });
/**
 * `pausing`: live AI care of THIS source's people that this change sends to its chain now, to pause (on only);
 * `stopping`: their active plans, each asked for a step now, which stops it at once, due or not (round 3 item 4: both
 * count this source's people only); `withdrawn`: the pending drafts a plan step or a trigger wrote for them, withdrawn
 * in this request (round 3 item 3)
 */
export const AiCareResponse = z.object({ source: z.object({ id: Id, name: z.string(), noAiCare: z.boolean(), noAiCareSentence: z.string() }), pausing: z.number().int(), stopping: z.number().int(), withdrawn: z.number().int() });

/** The kind of an import: import_batches.source. */
const ImportKind = z.enum(['csv', 'fub_api', 'fub_export']);
/**
 * One row of the source review (R-LSRC-10, owner decision 2026-11-14; leads/importLabels.ts ImportLabelRow): an
 * imported source label EXACTLY as imported, or one import's no-label group (`label` is then '' and
 * `unlabeledImportId` is set).
 *   state              mapped (to the named lead source) | suggested (an exact known match: `suggestion` names the
 *                      source; nothing is applied until the Owner confirms) | ambiguous (two lead sources match or
 *                      hold it; nothing is suggested) | in_review
 *   inReview           true unless state is mapped: the people committed with it get no automated contact
 *   people             the CRM-wide list: people an import committed with it; an import's rows: that import's people
 *   committedPeople    of those, the people an import has committed with it
 *   matchedOnlyPeople  E755: only on an import's own row mapped to a marked source (null on every other row, so always
 *                      null on the CRM-wide list and on a mapping's answer): of `people`, those already in the CRM whom
 *                      the import only matched; the mapping does not cover them
 *   firstSeen          the import that first committed a person with it, its kind and when
 *   changedBy/At       who last mapped, re-mapped or un-mapped it, and when
 */
export const ImportLabel = z.object({
  id: Id.nullable(),
  label: z.string(),
  unlabeledImportId: Id.nullable(),
  people: z.number().int(),
  committedPeople: z.number().int(),
  matchedOnlyPeople: z.number().int().nullable(),
  state: z.enum(['mapped', 'suggested', 'ambiguous', 'in_review']),
  leadSourceId: Id.nullable(),
  leadSourceName: z.string().nullable(),
  noAutomatedContact: z.boolean(),
  inReview: z.boolean(),
  suggestion: z.object({ leadSourceId: Id, leadSourceName: z.string(), noAutomatedContact: z.boolean() }).nullable(),
  firstSeen: z.object({ importId: Id, kind: ImportKind, at: Iso }).nullable(),
  changedBy: z.object({ userId: Id, name: z.string() }).nullable(),
  changedAt: Iso.nullable(),
  sentence: z.string(),
});
export const ImportLabelsResponse = z.object({ labels: z.array(ImportLabel), canChange: z.boolean() });
/**
 * Either the label exactly as imported, compared whole (at most 32,768 characters, the longest an import keeps: no
 * imported label is too long to map), or `unlabeledImportId`: the import whose people came in with no source label
 * (R-LSRC-9). leadSourceId null removes the mapping.
 */
/** An imported label is never empty or only whitespace (core sourceLabel reads that as no label at all). */
const Label = z.string().min(1).max(32_768).refine((s) => s.trim() !== '', 'blank');
export const ImportLabelBody = z.union([
  z.strictObject({ label: Label, leadSourceId: Id.nullable() }),
  z.strictObject({ unlabeledImportId: Id, leadSourceId: Id.nullable() }),
]);
/** POST /lead-sources/import-labels/confirm: the suggestion the Owner was shown for this label (R-LSRC-10). */
export const ImportLabelConfirmBody = z.strictObject({ label: Label, leadSourceId: Id });
export const ImportLabelResponse = z.object({ label: ImportLabel, pausing: z.number().int(), stopping: z.number().int(), withdrawn: z.number().int() });

export const PatchBody = z.strictObject({ name: z.string().trim().min(1).max(80).optional(), consentDisclosure: ConsentDisclosureInput.optional() });

export const PreviewBody = z.strictObject({
  inquiryType: z.enum(['buy', 'sell', 'rent', 'value', 'general']).optional(),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/).optional(),
  priceMinCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  priceMaxCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const PreviewResponse = z.object({
  rule: z.object({ id: Id, name: z.string() }).nullable(),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('offer'), userId: Id, name: z.string() }),
    z.object({ kind: z.literal('pond'), pondId: Id, pondName: z.string(), reason: z.string() }),
  ]),
  considered: z.array(z.object({ userId: Id, name: z.string(), eligible: z.boolean(), reason: z.string().nullable() })),
  sentence: z.string(),
  firstResponse: z.enum(['queued', 'off']),
});

export const LEAD_SOURCES_RESPONSE_SCHEMAS = { OverviewResponse, SourceResponse, OnOffResponse, WebhookRotatedResponse, PreviewResponse, ImportLabelsResponse, ImportLabelResponse, CoverageResponse };
