// The ONLY system-actor factory (CONVENTIONS §2/§6, ARCHITECTURE §2 "Processes", §16).
//
// A `system` actor is tenant-wide inside one tenant (RLS treats it like Owner/Admin and more), so it
// may be built only from a job row (the worker) or from a webhook/intake resolver result. The lint
// rule `realty/no-system-actor` rejects `{ kind: 'system', ... }` literals everywhere except
// apps/api/src/worker/** (and tests); webhook and intake code imports this factory instead. The
// architecture test in systemActor.test.ts proves no other source file builds one.
//
// The tenant id must come from a job row or a definer resolver (R-TEN-3), never from request input.
import type { SystemActor, SystemVia, TenantId } from '@realty/core/foundation';
import { parseId } from '@realty/core/foundation';

export const SYSTEM_VIAS: readonly SystemVia[] = ['timer', 'provider', 'assistant', 'import', 'worker'];

export class SystemActorError extends TypeError {
  override readonly name = 'SystemActorError';
}

/**
 * Builds the system actor of one tenant. `via` says why the system acts (timer, provider webhook,
 * assistant, import, generic worker); `jobId` ties it to the job row it runs for.
 */
export function systemActor(tenantId: TenantId | string, via: SystemVia, jobId?: string | bigint): SystemActor {
  const id = typeof tenantId === 'string' ? parseId<'TenantId'>(tenantId) : null;
  if (id === null) throw new SystemActorError('system actor needs a uuid tenant id from a job row or a resolver');
  if (!SYSTEM_VIAS.includes(via)) throw new SystemActorError(`unknown system via: ${String(via)}`);
  const actor: SystemActor = { kind: 'system', tenantId: id, via };
  if (jobId !== undefined) {
    const j = String(jobId);
    if (!/^[0-9]{1,19}$/.test(j)) throw new SystemActorError('jobId must be a jobs.id');
    actor.jobId = j;
  }
  return actor;
}
