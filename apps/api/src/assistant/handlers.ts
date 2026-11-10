// Job handlers of api/assistant (registered through worker/handlers/index.ts, CONVENTIONS §3).
//
//   assistant.first_response   realtime  tx          the 60-second first response (enqueued by lead intake)
//   playbook.step              default   tx          one due enrollment step (sweeper contract PLAYBOOK_STEP)
//   assistant.enrich_handback  default   standalone  suggested next step + reply (enqueued by inbound ingestion)
//   assistant.call_summary     default   standalone  transcript → claims, promise tasks, saved-search proposal
//   assistant.call_scan        default   tx, every 5 min   finds ready transcripts without a summary
//   assistant.playbook_migrate default   tx          enrollments of a superseded version → the new one
//   assistant.playbook_revoked default   tx          pause enrollments of a revoked version, cancel queued steps
//   assistant.match_listing    default   tx          one listing against the active saved searches (+ alerts)
//   assistant.search_scan      default   tx, every 10 min  recently changed listings + due alert digests
//   assistant.deal_closed      default   tx          post-closing enrollment when approved
//   assistant.closing_scan     default   tx, every 10 min  backs up deal_closed
// Model calls run in standalone handlers only (never inside a transaction). Every handler is idempotent:
// dedupe keys on actions and messages, state re-read under the contact lock.
import { enqueueJob } from '@realty/db';
import { type z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import type { Providers } from '../providers/index.js';
import { PLAYBOOK_STEP, type PlaybookStepPayload } from '../worker/contracts.js';
import { jobPayload, zId } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../worker/types.js';
import { CALL_SUMMARY_DEDUPE, callsAwaitingSummary, summarizeCall } from './callPipeline.js';
import { enrollOnDealClosedInTx, executePlaybookStepInTx, recentlyClosedDeals } from './enrollments.js';
import { sendFirstResponseInTx } from './firstResponse.js';
import { enrichHandback } from './handbacks.js';
import { migrateVersionEnrollments, pauseRevokedEnrollments } from './playbooks.js';
import { matchListingInTx, recentlyChangedListings, sendDueAlertsInTx } from './searches.js';
import { ASSISTANT_JOBS, type AssistantDeps } from './types.js';

type DepsFor = (providers: Providers) => AssistantDeps;
const defaultDeps: DepsFor = (providers) => ({ ...commsRuntime(), providers });

const ContactPayload = jobPayload({ contactId: zId });
const ActionPayload = jobPayload({ actionId: zId });
const CallPayload = jobPayload({ callId: zId });
const MigratePayload = jobPayload({ fromVersionId: zId, toVersionId: zId });
const VersionPayload = jobPayload({ versionId: zId });
const ListingPayload = jobPayload({ listingId: zId });
const DealPayload = jobPayload({ dealId: zId });
const Empty = jobPayload({});

/** How far back the listing scan looks (it runs every 10 min; matches are deduped by key). */
export const LISTING_SCAN_WINDOW_MS = 30 * 60_000;

export function makeAssistantHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const firstResponse: TxJobHandler<z.infer<typeof ContactPayload>> = {
    kind: ASSISTANT_JOBS.firstResponse,
    queue: 'realtime',
    priority: 20,
    via: 'assistant',
    schema: ContactPayload,
    async run(ctx, p) {
      const r = await sendFirstResponseInTx(ctx.tx, depsFor(ctx.providers), ctx.actor.tenantId, p.contactId, ctx.now);
      ctx.log.info('first_response', { jobId: ctx.job.id.toString(), code: r.kind === 'not_sent' || r.kind === 'skipped' || r.kind === 'noop' ? r.reason : r.kind });
    },
  };
  const step: TxJobHandler<PlaybookStepPayload> = {
    kind: PLAYBOOK_STEP.kind,
    queue: PLAYBOOK_STEP.queue,
    priority: PLAYBOOK_STEP.priority,
    via: 'assistant',
    schema: PLAYBOOK_STEP.schema,
    async run(ctx, p) {
      const r = await executePlaybookStepInTx(ctx.tx, depsFor(ctx.providers), ctx.actor.tenantId, p.enrollmentId, ctx.now);
      ctx.log.debug('playbook.step', { jobId: ctx.job.id.toString(), code: r.kind });
    },
  };
  const enrich: StandaloneJobHandler<z.infer<typeof ActionPayload>> = {
    kind: ASSISTANT_JOBS.enrichHandback,
    queue: 'default',
    mode: 'standalone',
    via: 'assistant',
    schema: ActionPayload,
    async run(ctx, p) {
      const r = await enrichHandback(ctx.actor, p.actionId, depsFor(ctx.providers));
      ctx.log.info('enrich_handback', { jobId: ctx.job.id.toString(), code: r.kind === 'skipped' ? r.reason : r.kind });
    },
  };
  const callSummary: StandaloneJobHandler<z.infer<typeof CallPayload>> = {
    kind: ASSISTANT_JOBS.callSummary,
    queue: 'default',
    mode: 'standalone',
    via: 'assistant',
    schema: CallPayload,
    async run(ctx, p) {
      const r = await summarizeCall(ctx.actor, p.callId, depsFor(ctx.providers));
      ctx.log.info('call_summary', { jobId: ctx.job.id.toString(), code: r.kind === 'skipped' ? r.reason : r.kind });
    },
  };
  const callScan: TxJobHandler<z.infer<typeof Empty>> = {
    kind: ASSISTANT_JOBS.callScan,
    queue: 'default',
    via: 'assistant',
    schema: Empty,
    every: { ms: 5 * 60_000 },
    periodicPayload: {},
    async run(ctx) {
      for (const callId of await callsAwaitingSummary(ctx.tx, ctx.now)) {
        await enqueueJob(ctx.tx, { queue: 'default', kind: ASSISTANT_JOBS.callSummary, payload: { callId }, dedupeKey: CALL_SUMMARY_DEDUPE(callId) });
      }
    },
  };
  const migrate: TxJobHandler<z.infer<typeof MigratePayload>> = {
    kind: ASSISTANT_JOBS.playbookMigrate,
    queue: 'default',
    via: 'assistant',
    schema: MigratePayload,
    async run(ctx, p) {
      const r = await migrateVersionEnrollments(ctx.tx, p, ctx.now);
      if (r.more) return { retryAt: ctx.now };
    },
  };
  const revoked: TxJobHandler<z.infer<typeof VersionPayload>> = {
    kind: ASSISTANT_JOBS.playbookRevoked,
    queue: 'default',
    via: 'assistant',
    schema: VersionPayload,
    async run(ctx, p) {
      const r = await pauseRevokedEnrollments(ctx.tx, p.versionId, ctx.now);
      if (r.more) return { retryAt: ctx.now };
    },
  };
  const matchListing: TxJobHandler<z.infer<typeof ListingPayload>> = {
    kind: ASSISTANT_JOBS.matchListing,
    queue: 'default',
    via: 'assistant',
    schema: ListingPayload,
    async run(ctx, p) {
      await matchListingInTx(ctx.tx, depsFor(ctx.providers), ctx.actor.tenantId, p.listingId, ctx.now);
    },
  };
  const searchScan: TxJobHandler<z.infer<typeof Empty>> = {
    kind: ASSISTANT_JOBS.searchScan,
    queue: 'default',
    via: 'assistant',
    schema: Empty,
    every: { ms: 10 * 60_000 },
    periodicPayload: {},
    async run(ctx) {
      const deps = depsFor(ctx.providers);
      for (const id of await recentlyChangedListings(ctx.tx, ctx.now, LISTING_SCAN_WINDOW_MS)) await matchListingInTx(ctx.tx, deps, ctx.actor.tenantId, id, ctx.now);
      await sendDueAlertsInTx(ctx.tx, deps, ctx.actor.tenantId, ctx.now, {});
    },
  };
  const dealClosed: TxJobHandler<z.infer<typeof DealPayload>> = {
    kind: ASSISTANT_JOBS.dealClosed,
    queue: 'default',
    via: 'assistant',
    schema: DealPayload,
    async run(ctx, p) {
      await enrollOnDealClosedInTx(ctx.tx, depsFor(ctx.providers), p.dealId, ctx.now);
    },
  };
  const closingScan: TxJobHandler<z.infer<typeof Empty>> = {
    kind: ASSISTANT_JOBS.closingScan,
    queue: 'default',
    via: 'assistant',
    schema: Empty,
    every: { ms: 10 * 60_000 },
    periodicPayload: {},
    async run(ctx) {
      const deps = depsFor(ctx.providers);
      for (const id of await recentlyClosedDeals(ctx.tx, ctx.now)) await enrollOnDealClosedInTx(ctx.tx, deps, id, ctx.now);
    },
  };
  return [firstResponse, step, enrich, callSummary, callScan, migrate, revoked, matchListing, searchScan, dealClosed, closingScan] as unknown as JobHandler<unknown>[];
}

/** Everything api/assistant registers with the worker (CONVENTIONS §3). */
export const assistantHandlers: JobHandler<unknown>[] = makeAssistantHandlers();
