// "I've handled it; the AI may continue" (§4.4): the agent clears a held topic. Escalation resolution is the user's
// own write of the machine projection, audited; nothing is sent by it.
import type { UserActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { type EscalationClass, type IsaFacts, step } from './coreSeam.js';
import type { IsaDeps } from './effects.js';
import { assignmentById, lockForTurn } from './repo.js';

export async function resolveEscalation(actor: UserActor, deps: IsaDeps, assignmentId: string, cls: string): Promise<{ assignmentId: string; cleared: string }> {
  return withTenantTx(actor, async (tx, now) => {
    const peek = await assignmentById(tx, assignmentId);
    if (peek === null || peek.endedAt !== null) throw new AppError('NOT_FOUND');
    await lockForTurn(tx, peek.contactId, peek.id);
    const a = (await assignmentById(tx, assignmentId, 'update'))!;
    if (!a.machine.held.some((h) => h.class === cls)) throw new AppError('NOT_FOUND');
    const r = step(a.machine, { type: 'escalation_resolved', at: now, class: cls as EscalationClass }, {} as IsaFacts);
    await sql`UPDATE ai_isa_assignments SET machine = ${JSON.stringify(r.state)}::jsonb, state = ${r.state.phase},
        awaiting_agent = ${JSON.stringify(r.state.held.map((h) => ({ class: h.class, since: h.since })))}::jsonb
      WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx);
    await audit(tx, actor, { action: 'ai_isa.escalation_resolved', entity: { type: 'ai_isa_assignment', id: a.id }, reason: cls });
    void deps;
    return { assignmentId: a.id, cleared: cls };
  }, { db: deps.db, retries: 2 });
}
