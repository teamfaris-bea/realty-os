// Handler registry (BUILD_PLAN module 9: `registerHandler<P>(h: JobHandler<P>): void`).
//
// The process-wide registry is filled once at worker start from `handlers/index.ts` (the shared
// handler list, CONVENTIONS §3). Tests build their own `HandlerRegistry`. Registration validates the
// handler (kind shape, queue, no duplicate kind, the sweeper contract's queue for sweeper-issued
// kinds, a periodic payload that passes its own schema).
import { JOB_KIND_RE, QUEUES, type Tx, enqueueJob } from '@realty/db';
import type { Instant } from '@realty/core/foundation';
import { SWEEPER_KIND_QUEUES } from './contracts.js';
import type { JobHandler } from './types.js';

export class HandlerRegistrationError extends TypeError {
  override readonly name = 'HandlerRegistrationError';
}

export class HandlerRegistry {
  readonly #byKind = new Map<string, JobHandler<unknown>>();

  register<P>(h: JobHandler<P>): void {
    if (!JOB_KIND_RE.test(h.kind)) throw new HandlerRegistrationError(`job kind must match area.verb: ${h.kind}`);
    if (!(QUEUES as readonly string[]).includes(h.queue)) throw new HandlerRegistrationError(`unknown queue ${h.queue} for ${h.kind}`);
    if (this.#byKind.has(h.kind)) throw new HandlerRegistrationError(`a handler for ${h.kind} is already registered`);
    const contracted = SWEEPER_KIND_QUEUES[h.kind];
    if (contracted !== undefined && contracted !== h.queue) {
      throw new HandlerRegistrationError(`${h.kind} must run on queue ${contracted} (sweeper contract), not ${h.queue}`);
    }
    if (h.every !== undefined) {
      if (!Number.isInteger(h.every.ms) || h.every.ms < 60_000) throw new HandlerRegistrationError(`${h.kind}: periodic interval must be ≥ 60 s`);
      if (!h.schema.safeParse(h.periodicPayload ?? {}).success) throw new HandlerRegistrationError(`${h.kind}: periodicPayload must pass the handler schema`);
    }
    this.#byKind.set(h.kind, h as JobHandler<unknown>);
  }

  registerAll(list: readonly JobHandler<unknown>[]): this {
    for (const h of list) this.register(h);
    return this;
  }

  get(kind: string): JobHandler<unknown> | undefined {
    return this.#byKind.get(kind);
  }

  has(kind: string): boolean {
    return this.#byKind.has(kind);
  }

  kinds(): string[] {
    return [...this.#byKind.keys()].sort();
  }

  periodic(): JobHandler<unknown>[] {
    return [...this.#byKind.values()].filter((h) => h.every !== undefined);
  }
}

/** The worker process's registry. */
export const registry = new HandlerRegistry();

export function registerHandler<P>(h: JobHandler<P>): void {
  registry.register(h);
}

export class PayloadRejectedError extends TypeError {
  override readonly name = 'PayloadRejectedError';
  constructor(readonly kind: string) {
    super(`payload rejected by the ${kind} schema (ids, codes, fences and instants only: R-TEN-7)`);
  }
}

/**
 * Enqueues a job of `h.kind` in the caller's transaction after validating the payload against the
 * handler's schema (R-TEN-7). The error never echoes the payload. Returns false when a live job with
 * the dedupe key already exists.
 */
export async function enqueueTyped<P>(
  tx: Tx,
  h: Pick<JobHandler<P>, 'kind' | 'queue' | 'schema' | 'priority' | 'maxAttempts'>,
  payload: P,
  opts: { runAt?: Instant; dedupeKey?: string; priority?: number; maxAttempts?: number } = {},
): Promise<boolean> {
  const parsed = h.schema.safeParse(payload);
  if (!parsed.success) throw new PayloadRejectedError(h.kind);
  const priority = opts.priority ?? h.priority;
  const maxAttempts = opts.maxAttempts ?? h.maxAttempts;
  return enqueueJob(tx, {
    queue: h.queue,
    kind: h.kind,
    payload: parsed.data as never,
    ...(opts.runAt === undefined ? {} : { runAt: opts.runAt }),
    ...(opts.dedupeKey === undefined ? {} : { dedupeKey: opts.dedupeKey }),
    ...(priority === undefined ? {} : { priority }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
}
