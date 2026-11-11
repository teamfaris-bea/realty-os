// Job handlers of api/comms (registered through worker/handlers/index.ts):
//   comms.dispatch        (standalone) dispatchOutbound: TX1 → provider.send → TX2; sweeper-issued too
//   comms.reconcile       (standalone) provider lookup of a dispatch_unknown message (R-GATE-8)
//   comms.recording_copy  (standalone) copy + encrypt a provider recording (onRecordingReady)
//   comms.transcribe      (standalone) transcription, stored encrypted
//   comms.media_copy      (standalone) inbound MMS media → checked, encrypted storage (comms/media.ts)
// Standalone: dispatch must commit between its steps and never hold a transaction across a provider
// call (ARCHITECTURE §9). Each run is idempotent across a crash: TX1 only claims scheduled/queued
// messages, so a re-run never re-sends (E7); the reconcile and copy steps check state under lock.
import { jobPayload, zId } from '../worker/payload.js';
import { COMMS_DISPATCH, COMMS_RECONCILE, type MessagePayload } from '../worker/contracts.js';
import type { JobHandler, StandaloneJobHandler } from '../worker/types.js';
import { z } from 'zod';
import { dispatchOutbound, reconcileOutbound } from './dispatch.js';
import { RECORDING_COPY_JOB, TRANSCRIBE_JOB, onRecordingReady, transcribeRecording } from './recordings.js';
import { MEDIA_COPY_JOB, copyInboundMedia } from './media.js';
import { commsRuntime } from './runtime.js';
import type { CommsDeps } from './types.js';
import type { Providers } from '../providers/index.js';

type DepsFor = (providers: Providers) => CommsDeps;

const defaultDeps: DepsFor = (providers) => ({ ...commsRuntime(), providers });

export function dispatchHandler(depsFor: DepsFor = defaultDeps): StandaloneJobHandler<MessagePayload> {
  return {
    kind: COMMS_DISPATCH.kind,
    queue: COMMS_DISPATCH.queue,
    priority: COMMS_DISPATCH.priority,
    mode: 'standalone',
    via: 'worker',
    schema: COMMS_DISPATCH.schema,
    async run(ctx, p) {
      const r = await dispatchOutbound(p.messageId, depsFor(ctx.providers), { tenantId: ctx.actor.tenantId });
      if (r.kind === 'not_due') return { retryAt: r.due };
      ctx.log.info('dispatch', { kind: COMMS_DISPATCH.kind, jobId: ctx.job.id.toString(), code: r.kind });
    },
  };
}

export function reconcileHandler(depsFor: DepsFor = defaultDeps): StandaloneJobHandler<MessagePayload> {
  return {
    kind: COMMS_RECONCILE.kind,
    queue: COMMS_RECONCILE.queue,
    priority: COMMS_RECONCILE.priority,
    mode: 'standalone',
    via: 'provider',
    schema: COMMS_RECONCILE.schema,
    async run(ctx, p) {
      const r = await reconcileOutbound(p.messageId, depsFor(ctx.providers), ctx.actor.tenantId);
      if (r.kind === 'retry') return { retryAt: r.at };
    },
  };
}

export const RecordingCopyPayload = jobPayload({ callRef: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/), recordingRef: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/), durationS: z.number().int().min(0).max(86_400), voicemail: z.boolean().optional() });
export type RecordingCopyPayload = z.infer<typeof RecordingCopyPayload>;

export function recordingCopyHandler(depsFor: DepsFor = defaultDeps): StandaloneJobHandler<RecordingCopyPayload> {
  return {
    kind: RECORDING_COPY_JOB.kind as `${string}.${string}`,
    queue: RECORDING_COPY_JOB.queue,
    mode: 'standalone',
    via: 'provider',
    schema: RecordingCopyPayload,
    async run(ctx, p) {
      const r = await onRecordingReady({ tenantId: ctx.actor.tenantId, providerCallRef: p.callRef, recordingRef: p.recordingRef, durationS: p.durationS, ...(p.voicemail ? { voicemail: true } : {}) }, depsFor(ctx.providers), ctx.actor);
      ctx.log.info('recording', { kind: RECORDING_COPY_JOB.kind, jobId: ctx.job.id.toString(), code: r.kind === 'refused' ? r.reason : r.kind });
    },
  };
}

export const TranscribePayload = jobPayload({ recordingId: zId });

export function transcribeHandler(depsFor: DepsFor = defaultDeps): StandaloneJobHandler<z.infer<typeof TranscribePayload>> {
  return {
    kind: TRANSCRIBE_JOB.kind as `${string}.${string}`,
    queue: TRANSCRIBE_JOB.queue,
    mode: 'standalone',
    via: 'worker',
    schema: TranscribePayload,
    async run(ctx, p) {
      await transcribeRecording(p.recordingId, depsFor(ctx.providers), ctx.actor);
    },
  };
}

export const MediaCopyPayload = jobPayload({
  messageId: zId,
  items: z.array(z.object({ position: z.number().int().min(0).max(99), ref: z.string().regex(/^ME[0-9a-f]{32}$/).nullable(), declaredType: z.string().max(100).nullable() })).max(100),
});

export function mediaCopyHandler(depsFor: DepsFor = defaultDeps): StandaloneJobHandler<z.infer<typeof MediaCopyPayload>> {
  return {
    kind: MEDIA_COPY_JOB.kind as `${string}.${string}`,
    queue: MEDIA_COPY_JOB.queue,
    mode: 'standalone',
    via: 'provider',
    schema: MediaCopyPayload,
    async run(ctx, p) {
      const r = await copyInboundMedia(ctx.actor, p.messageId, p.items, depsFor(ctx.providers));
      ctx.log.info('mms media', { kind: MEDIA_COPY_JOB.kind, jobId: ctx.job.id.toString(), code: `stored:${r.stored},skipped:${r.skipped}` });
    },
  };
}

/** Everything api/comms registers with the worker (CONVENTIONS §3). */
export function makeCommsHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  return [dispatchHandler(depsFor), reconcileHandler(depsFor), recordingCopyHandler(depsFor), transcribeHandler(depsFor), mediaCopyHandler(depsFor)] as unknown as JobHandler<unknown>[];
}

export const commsHandlers: JobHandler<unknown>[] = makeCommsHandlers();
