// A plan's name as one viewer is shown it (R-PERM-5, R-PERM-12; security review of module 67): the name only if the
// viewer's OWN row-level security shows that playbook. An agent's private plan is invisible to every other agent and
// ISA (playbooks_select: team scope, own, or sees-all-detail), so a collaborator who changes the stage, previews it or
// opens the status is told "the owner's plan" instead. One rule for the stage change's answer, the preview and the
// playbook status.
import type { UserActor } from '@realty/core/foundation';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';

export const HIDDEN_PLAN = "the owner's plan";

/** The playbook ids among `ids` the viewer's own RLS shows (run in the viewer's transaction). */
export async function visiblePlaybookIds(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await sql<{ id: string }>`SELECT id FROM playbooks WHERE tenant_id = app.tenant_id() AND id = ANY (${[...ids]}::uuid[])`.execute(tx);
  return new Set(r.rows.map((x) => x.id));
}

/** A function naming each plan as `viewer` is shown it: its name, or HIDDEN_PLAN. `plans` were read by the system. */
export async function planNamer(db: Database, viewer: UserActor, plans: readonly { id: string; name: string }[]): Promise<(id: string) => string> {
  const names = new Map(plans.map((p) => [p.id, p.name]));
  const visible = plans.length === 0 ? new Set<string>() : await withTenantTx(viewer, (tx) => visiblePlaybookIds(tx, [...names.keys()]), { db });
  return (id) => (visible.has(id) ? (names.get(id) ?? HIDDEN_PLAN) : HIDDEN_PLAN);
}
