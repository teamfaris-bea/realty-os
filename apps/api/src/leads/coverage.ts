// Source coverage (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-10, R-TEAMQ-11, E933 to E937).
//
//   GET /lead-sources/:id/coverage     settings.routing (Owner, Admin)   one source's coverage with its warnings
//   PUT /lead-sources/:id/coverage     settings.routing (Owner, Admin)   name the owner and the backup, mark high
//                                                                        intent, turn coverage on or off (audited)
//   GET /lead-sources/overview         (leads/sources.ts) carries the same `coverage` on every source
//
// A source is COVERED only while the switch is on and its owner and its backup are both active members (core
// coverageNow: the ONE definition, which the auto-release and the minute-three alert read too, R-TEAMQ-24; the view's
// `effects` say in words what follows from it right now, with the team's own release time). Suspending or deactivating a named member writes nothing here and cannot fail because of it: the
// read then flags the source and says it is not covered, and the person stays named. Nothing in this file moves a
// lead, alerts anyone or sends anything: what coverage changes is decided where it is used (the auto-release in
// core/ownership decide.ts, the minute-three backup alert in leads/backupAlert.ts). Switching coverage OFF queues one
// re-check of the releases that were waived while it was on (leads/releaseRecheck.ts, R-TEAMQ-20).
import { type IdGenerator, type LeadSourceId, type PondId, type UserActor, type UserId, canOwnLeads } from '@realty/core/foundation';
import { type CoverageMember, type SourceRouting, sourceCoverage, sourceRouting } from '@realty/core/ownership';
import { type Tx, loadRules, loadTenantFacts } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { leadsTx, platformOf } from './common.js';
import { queueReleaseRecheck } from './releaseRecheck.js';
import * as repo from './repos/coverage.js';
import { CoverageBody, CoverageResponse, type CoverageView } from './sourcesSchemas.js';

export type CoverageViewT = z.infer<typeof CoverageView>;

const member = (userId: string | null, name: string | null, status: CoverageMember['status'] | null): CoverageMember | null =>
  // a named member always has a membership row (the foreign key); a missing one reads as removed, never as active
  userId === null ? null : { userId: userId as UserId, name, status: status ?? 'removed' };

/**
 * Every source's coverage, by source id: the stored fields, whether it is covered now, the sentence and the
 * warnings. One pass: the tenant's sources, its enabled routing rules (the router's own facts) and its pond names.
 * "Shared fallback pond" compares the sources that are on (a source that is off receives nothing).
 */
export async function coverageBySource(tx: Tx): Promise<Map<string, CoverageViewT>> {
  const [rows, rules, facts, ponds, rotations] = [await repo.coverageRows(tx), await loadRules(tx), await loadTenantFacts(tx), await repo.pondNames(tx), await repo.ruleRotations(tx)];
  const routing = new Map<string, SourceRouting>(rows.map((s) => [s.id, sourceRouting(rules, s.id as LeadSourceId, facts.settings.defaultPondId as PondId)]));
  const out = new Map<string, CoverageViewT>();
  for (const s of rows) {
    const r = routing.get(s.id) as SourceRouting;
    const owner = member(s.owner_user_id, s.owner_name, s.owner_status);
    const backup = member(s.backup_user_id, s.backup_name, s.backup_status);
    const c = sourceCoverage({
      owner,
      backup,
      highIntent: s.high_intent,
      coveredSetting: s.covered,
      routing: r,
      fallbackPondName: ponds.get(r.pondId) ?? 'the default pond',
      sharedWith: rows.filter((o) => o.id !== s.id && o.active && (routing.get(o.id) as SourceRouting).pondId === r.pondId).map((o) => o.name),
      // R-TEAMQ-21: who is offered this source's leads (the backup among them is said on the card)
      rotation: (r.ruleId === null ? [] : (rotations.get(r.ruleId) ?? [])) as UserId[],
      // R-TEAMQ-24: the team's own release time, so the card never says a hard-coded 30 minutes
      releaseSeconds: facts.settings.firstTouchReleaseSeconds,
    });
    out.set(s.id, { owner, backup, highIntent: s.high_intent, covered: c.covered, setting: c.setting, sentence: c.sentence, warnings: c.warnings, effects: c.effects, changedAt: s.coverage_changed_at ? s.coverage_changed_at.toISOString() : null });
  }
  return out;
}

async function coverageOf(tx: Tx, sourceId: string): Promise<CoverageViewT> {
  const c = (await coverageBySource(tx)).get(sourceId);
  if (!c) throw new AppError('NOT_FOUND');
  return c;
}

/**
 * A member being NEWLY named must be an active member of this team who can take leads (R-PERM-15: never a TC).
 * A member already named is left as they are, so the other fields can still be saved while they are suspended.
 */
async function checkNamed(tx: Tx, path: '/ownerUserId' | '/backupUserId', userId: string | null, was: string | null): Promise<void> {
  if (userId === null || userId === was) return;
  const m = await repo.memberOf(tx, userId);
  if (!m) throw new AppError('NOT_FOUND'); // not a member of this team (R-PERM-5: never says whose member it is)
  if (m.status !== 'active') throw new AppError('VALIDATION_FAILED', { issues: [{ path, code: 'member_not_active' }] });
  if (!canOwnLeads(m.role)) throw new AppError('VALIDATION_FAILED', { issues: [{ path, code: 'member_cannot_take_leads' }] });
}

/** PUT /lead-sources/:id/coverage: the whole coverage of a source, as the Owner or Admin set it. */
export async function setCoverage(tx: Tx, actor: UserActor, ids: IdGenerator, sourceId: string, b: z.infer<typeof CoverageBody>): Promise<CoverageViewT> {
  const was = await repo.lockStoredCoverage(tx, sourceId);
  if (!was) throw new AppError('NOT_FOUND');
  // R-TEAMQ-10: covered is on only while an owner and a backup are both named (the database holds the same rule)
  if (b.covered && (b.ownerUserId === null || b.backupUserId === null)) {
    throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/covered', code: 'coverage_needs_owner_and_backup' }] });
  }
  await checkNamed(tx, '/ownerUserId', b.ownerUserId, was.owner_user_id);
  await checkNamed(tx, '/backupUserId', b.backupUserId, was.backup_user_id);
  const next: repo.StoredCoverage = { owner_user_id: b.ownerUserId, backup_user_id: b.backupUserId, high_intent: b.highIntent, covered: b.covered };
  const changed = next.owner_user_id !== was.owner_user_id || next.backup_user_id !== was.backup_user_id || next.high_intent !== was.high_intent || next.covered !== was.covered;
  if (changed) {
    await repo.writeCoverage(tx, sourceId, next);
    // ids, two switches: nothing of a person beyond their id (R-AUDIT-4); only the fields that changed
    await audit(tx, actor, { action: 'routing.changed', entity: { type: 'lead_source', id: sourceId }, changes: redactDiff({ ...was }, { ...next }, { entity: 'lead_source' }), reason: 'LEAD_SOURCE_COVERAGE_CHANGED' });
    // R-TEAMQ-20: coverage switched off: releases waived for this source's leads apply again from this moment
    // (leads/releaseRecheck.ts decides per lead; it moves no lead itself)
    if (was.covered && !next.covered) await queueReleaseRecheck(tx, ids);
  }
  return coverageOf(tx, sourceId);
}

export async function registerCoverageRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const routing = { config: { auth: 'settings.routing' as const }, preHandler: authorize('settings.routing', () => ({})) };
  const Params = z.object({ id: z.uuid() }).strict();
  r.get('/lead-sources/:id/coverage', { ...routing, schema: { params: Params, response: { 200: CoverageResponse } } }, async (req) =>
    leadsTx(req, async (tx) => ({ coverage: await coverageOf(tx, req.params.id) })),
  );
  r.put('/lead-sources/:id/coverage', { ...routing, schema: { params: Params, body: CoverageBody, response: { 200: CoverageResponse } } }, async (req) =>
    leadsTx(req, async (tx, _now, actor) => ({ coverage: await setCoverage(tx, actor, platformOf(req).ids, req.params.id, req.body) })),
  );
}
