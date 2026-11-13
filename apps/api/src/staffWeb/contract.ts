// The module 55 contract the web app's Phase 3 staff screens are built against (PHASE2_3_PLAN §5.4 #55, owner question
// 13): every route those screens call (voice, ads, documents with the extraction review, GBP, coaching trends, a call's
// AI session, marketing generate and the assistant approve), with the JSON Schema of its request (body, query) and of its
// success response, generated from the very Zod schemas those routes validate and serialize with, plus the error codes the
// screens turn into words, with their HTTP status (errors.ts). Modelled on module 22's channels/webContract.ts: apps/web
// may not import @realty/api code, so it reads the generated JSON (contract.json, next to this file) in its tests
// (apps/web/src/test/staffContract.ts): every request a screen sends must satisfy the route's request schema, and every
// answer a fake gives must satisfy the route's response schema. contract.test.ts fails when the committed JSON is not
// exactly what this generates, and checks every route against the server's own route table.
//
// Multipart uploads carry no JSON body: the contract names the form fields the route reads (`multipart`), and the web's
// wrapper refuses any other field (a commandId included). GET /likely is not in it: predict/** keeps its importers to
// the route table and the worker (predict/architecture.test.ts).
//
//   regenerate: pnpm --filter @realty/api exec tsx --conditions=@realty/source src/staffWeb/contract.ts --write
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as Ads from '../ads/schemas.js';
import * as A from '../assistant/schemas.js';
import * as Trends from '../coaching/trends/schemas.js';
import * as Docs from '../documents/schemas.js';
import { ERROR_STATUS, type ErrorCode } from '../errors.js';
import * as Gbp from '../gbp/schemas.js';
import { GenerateBody, PiecesResponse } from '../marketing/routes.js';
import { zodInputKeys } from '../rbac.js';
import * as Txn from '../transactions/schemas.js';
import * as Voice from '../voice/schemas.js';

export const STAFF_CONTRACT_FILE = fileURLToPath(new URL('./contract.json', import.meta.url));

export interface RouteSpec {
  body?: z.ZodType;
  query?: z.ZodType;
  /** the success response (200, or 201 where the route creates) */
  response: z.ZodType;
  status?: 200 | 201;
  /** a multipart route: the form fields it reads (anything else is VALIDATION_FAILED UNKNOWN_FIELD, documents/upload.ts) */
  multipart?: readonly string[];
}

const UPLOAD = ['file', 'kind', 'displayName'] as const;

/** Keyed "METHOD url" exactly as the route table lists it, without the /api prefix. */
export const STAFF_ROUTES: Readonly<Record<string, RouteSpec>> = {
  // module 48: AI call answering
  'GET /voice/answering': { response: Voice.AnsweringResponse },
  'PUT /voice/answering/settings': { body: Voice.AnsweringSettingsBody, response: Voice.AnsweringResponse },
  'POST /voice/answering/enable': { body: Voice.EnableBody, response: Voice.AnsweringResponse },
  'POST /voice/answering/disable': { body: Voice.DisableBody, response: Voice.AnsweringResponse },
  'POST /voice/test-call': { body: Voice.TestCallBody, response: Voice.TestCallResponse },
  'GET /calls/:id/voice': { response: Voice.CallVoiceResponse },
  // module 52: Google Ads
  'GET /ads': { response: Ads.OverviewResponse },
  'GET /ads/ledger': { query: Ads.LedgerQuery, response: Ads.LedgerResponse },
  'POST /ads/caps': { body: Ads.CapBody, response: Ads.CapResponse, status: 201 },
  'PATCH /ads/campaigns/:id': { body: Ads.LinkBody, response: Ads.CampaignResponse },
  'POST /ads/campaigns/:id/resume': { response: Ads.RunResponse },
  'POST /ads/proposals/:id/approve': { response: Ads.RunResponse },
  'POST /ads/proposals/:id/reject': { response: Ads.DecisionResponse },
  // module 42: documents and the contract-date review
  'POST /deals/:id/documents': { response: Docs.UploadResponse, status: 201, multipart: UPLOAD },
  'POST /listings/:id/documents': { response: Docs.UploadResponse, status: 201, multipart: UPLOAD },
  'POST /contacts/:id/documents': { response: Docs.UploadResponse, status: 201, multipart: UPLOAD },
  'POST /documents/:id/versions': { response: Docs.UploadResponse, status: 201, multipart: ['file', 'displayName'] },
  'GET /deals/:id/documents': { response: Docs.ListResponse },
  'GET /listings/:id/documents': { response: Docs.ListResponse },
  'GET /contacts/:id/documents': { response: Docs.ListResponse },
  'GET /documents/extractions': { response: Docs.OpenExtractionsResponse },
  'GET /documents/:id': { response: Docs.DetailResponse },
  'POST /documents/:id/share': { body: Docs.ShareBody, response: Docs.ShareResponse },
  'POST /documents/:id/hold': { body: Docs.HoldBody, response: Docs.DetailResponse },
  'PUT /documents/:id/retention': { body: Docs.RetentionBody, response: Docs.DetailResponse },
  'GET /documents/:id/extraction': { response: Docs.ExtractionResponse },
  'POST /documents/:id/extraction/run': { response: Docs.ExtractionResponse },
  'POST /documents/:id/extraction/claims/:claimId/confirm': { body: Docs.ConfirmClaimBody, response: Docs.ClaimDecisionResponse },
  'POST /documents/:id/extraction/claims/:claimId/reject': { body: Docs.RejectClaimBody, response: Docs.ClaimDecisionResponse },
  // module 31: canConfirm for the date review
  'GET /deals/:id/milestones': { response: Txn.MilestonesResponse },
  // module 53: Google Business Profile
  'GET /gbp/status': { response: Gbp.StatusResponse },
  'GET /gbp/reviews': { query: Gbp.ReviewsQuery, response: Gbp.ReviewsResponse },
  'POST /gbp/reviews/:id/draft': { body: Gbp.DraftBody, response: Gbp.ReviewResponse },
  'POST /gbp/reviews/:id/reply': { body: Gbp.ReplyBody, response: Gbp.ReplyResponse },
  'POST /gbp/reviews/:id/discard': { body: Gbp.DiscardBody, response: Gbp.ReviewResponse },
  // module 54: coaching trends
  'GET /coaching/trends': { query: Trends.TrendsQuery, response: Trends.OwnTrendsResponse },
  'GET /coaching/trends/team': { query: Trends.TrendsQuery, response: Trends.TeamTrendsResponse },
  // module 38: "Make a Google post"
  'POST /listings/:id/marketing/generate': { body: GenerateBody, response: PiecesResponse },
  // the voice handback's one-tap Send of a confirmation draft (the existing approve; R-VOICE-17)
  'POST /assistant/actions/:id/approve': { body: A.ApproveBody, response: A.ApproveResponse },
};

/** The error codes the staff screens turn into words, with the status the API answers them with. */
const ERRORS = [
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'REAUTH_REQUIRED',
  'OWNER_REQUIRED',
  'ATTESTATION_REQUIRED',
  'VERSION_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'CONTACT_MERGED',
  'ACTION_NOT_PENDING',
  'ASSISTANT_UNAVAILABLE',
  'DRAFT_STALE',
  'DRAFT_INVALIDATED',
  'CHANNEL_NOT_CONNECTED',
  'PLATFORM_NOT_CLEARED',
  // voice
  'VOICE_PLAYBOOK_NOT_APPROVED',
  'VOICE_ANSWERING_OFF',
  'VOICE_NOT_CLEARED',
  'VOICE_VENDOR_NOT_CONFIGURED',
  'VOICE_FAKE_ON_REAL_TELEPHONY',
  'VOICE_RECORDING_OFF',
  // documents
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_RETENTION_OUT_OF_RANGE',
  'DOCUMENT_TOO_LARGE',
  'DOCUMENT_QUARANTINED',
  'DOCUMENT_NOT_SHAREABLE',
  'DOCUMENT_VERSION_CONFLICT',
  'DOCUMENT_RETAINED',
  'DOCUMENT_SUPERSEDED',
  'DOCUMENT_BLOCKED',
  'DOCUMENT_HOLD_OWNER_ADMIN',
  'EXTRACTION_EXISTS',
  'EXTRACTION_CLOSED',
  'EXTRACTION_CLAIM_NEEDS_REVIEW',
  'EXTRACTION_CLAIM_DECIDED',
  'EXTRACTION_TARGET_KIND',
  'EXTRACTION_USE_DOCUMENT',
  'DATE_HUMAN_CONFIRMATION',
  // ads
  'ADS_NOT_CLEARED',
  'ADS_GOOGLE_ONLY',
  'ADS_CONNECTION_NOT_LIVE',
  'AD_APPROVAL_FROZEN',
  'AD_CAP_EXCEEDED',
  'AD_CAP_VERSION_STALE',
  'AD_SHIFT_NOT_IN_APPROVAL',
  'AD_SHIFT_NOT_APPROVED',
  'AD_CREATIVE_NOT_APPROVED',
  'AD_BUDGET_THROUGH_LEDGER',
  'AD_APPLY_WITHOUT_PLAN',
  'ADS_PROPOSAL_STALE',
  'ADS_APPROVAL_NOT_FROM_ADS',
  'ADS_MONTHLY_CAP_REACHED',
  'ADS_CAMPAIGN_NOT_ELIGIBLE',
  'ADS_NO_CAP',
  'ADS_NO_LEAD_SOURCE',
  'AD_CAP_CHANGED',
  'AD_CAP_INVALID',
  // gbp
  'GBP_NOT_CLEARED',
  'GBP_NOT_CONFIGURED',
  'REPLY_PRIVACY',
  'REPLY_STALE',
  'REPLY_IN_PROGRESS',
  // coaching trends
  'COACHING_TRENDS_SCOPE',
] as const satisfies readonly ErrorCode[];

/** A string Zod trims before its checks (module 22's x-trim; apps/web/src/test/contract.ts trims first). */
function trims(s: unknown): boolean {
  const def = (s as { _zod?: { def?: { type?: string; checks?: { _zod?: { def?: { check?: string; tx?: (v: string) => unknown } } }[] } } })._zod?.def;
  if (def?.type !== 'string') return false;
  return (def.checks ?? []).some((c) => {
    const d = c._zod?.def;
    if (d?.check !== 'overwrite' || typeof d.tx !== 'function') return false;
    try {
      return d.tx('  x  ') === 'x';
    } catch {
      return false;
    }
  });
}

const json = (s: z.ZodType, io: 'input' | 'output') => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, {
    io,
    reused: 'ref',
    override: (ctx) => {
      if (io === 'input' && trims(ctx.zodSchema)) (ctx.jsonSchema as Record<string, unknown>)['x-trim'] = true;
    },
  }) as Record<string, unknown>;
  return rest;
};
const params = (url: string) => [...url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);

export interface StaffContract {
  $comment: string;
  routes: Record<string, { inputKeys: string[]; body: unknown; query: unknown; response: unknown; status: number; multipart: string[] | null }>;
  errors: Record<(typeof ERRORS)[number], number>;
}

export function staffContract(): StaffContract {
  return {
    $comment: 'GENERATED from the API Zod schemas by apps/api/src/staffWeb/contract.ts (--write). Do not edit: apps/api/src/staffWeb/contract.test.ts fails when this file drifts.',
    routes: Object.fromEntries(
      Object.entries(STAFF_ROUTES).map(([key, r]) => {
        const url = key.split(' ')[1]!;
        const inputKeys = [...new Set([...params(url), ...zodInputKeys(r.body), ...zodInputKeys(r.query)])].sort();
        return [
          key,
          {
            inputKeys,
            body: r.body ? json(r.body, 'input') : null,
            query: r.query ? json(r.query, 'input') : null,
            response: json(r.response, 'output'),
            status: r.status ?? 200,
            multipart: r.multipart ? [...r.multipart] : null,
          },
        ];
      }),
    ),
    errors: Object.fromEntries(ERRORS.map((c) => [c, ERROR_STATUS[c]])) as StaffContract['errors'],
  };
}

export const staffContractText = (): string => `${JSON.stringify(staffContract(), null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = staffContractText();
  if (process.argv.includes('--write')) writeFileSync(STAFF_CONTRACT_FILE, text);
  else if (readFileSync(STAFF_CONTRACT_FILE, 'utf8') !== text) {
    console.error('staffWeb/contract.json is stale: run with --write');
    process.exit(1);
  }
}
