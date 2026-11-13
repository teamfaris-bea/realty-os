// Publish and retract portal items as a person (R-PORTAL-14; E654, E655, E657). publishable() decides first (core
// refuses before the DB); the item is rendered by renderPortalItem() and inserted as the person, so the items guard and
// the insert policy re-check it. A batch publishes into each grant in its own savepoint: one grant's refusal never
// undoes another's item. A retraction is final and records its person; the source can then be published again.
import type { UserActor } from '@realty/core/foundation';
import { type PortalKind, publishable, renderPortalItem } from '@realty/core/portal';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../../audit.js';
import { AppError } from '../../errors.js';
import { sentenceFor } from '../shared/copy.js';
import { dbCodeOf, grantFacts } from './common.js';
import { sourceFacts } from './sources.js';

export interface PublishOutcome {
  grantId: string;
  result: string;
  itemId: string | null;
  text: string | null;
}

let sp = 0;

/** One grant, in a savepoint. `allowed` is the per-grant portal.manage check (else NOT_FOUND, R-PERM-5). */
async function publishOne(tx: Tx, actor: UserActor, grantId: string, kind: PortalKind, sourceId: string, allowed: (f: Awaited<ReturnType<typeof grantFacts>>) => boolean): Promise<PublishOutcome> {
  const fail = (code: string): PublishOutcome => ({ grantId, result: code, itemId: null, text: sentenceFor(code) });
  const f = await grantFacts(tx, grantId);
  if (!f || !allowed(f)) return fail('NOT_FOUND');
  const facts = await sourceFacts(tx, grantId, kind, sourceId, 'user');
  if (!facts) return fail('PORTAL_SOURCE_NOT_IN_GRANT');
  const ok = publishable(kind, facts);
  if (!ok.ok) return fail(ok.reason);
  const spec = renderPortalItem(facts);
  const live = await sql<{ id: string }>`
    SELECT id FROM portal_items WHERE tenant_id = app.tenant_id() AND grant_id = ${grantId} AND source_type = ${spec.sourceType}
       AND source_id = ${spec.sourceId} AND source_version = ${spec.sourceVersion} AND retracted_at IS NULL`.execute(tx);
  if (live.rows[0]) return { grantId, result: 'already_published', itemId: live.rows[0].id, text: null };
  const name = sql.raw(`portal_pub_${(sp = (sp + 1) % 1_000_000)}`);
  await sql`SAVEPOINT ${name}`.execute(tx);
  try {
    const id = (await sql<{ id: string }>`
      INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, body, occurs_on, document_id, source_type, source_id, source_version,
                                published_by_kind, published_by_user_id, published_at)
      VALUES (app.tenant_id(), gen_random_uuid(), ${grantId}, ${spec.kind}, ${spec.title}, ${spec.body}, ${spec.occursOn}::date, ${spec.documentId},
              ${spec.sourceType}, ${spec.sourceId}, ${spec.sourceVersion}, 'user', ${actor.userId}, now())
      RETURNING id`.execute(tx)).rows[0]!.id;
    await audit(tx, actor, { action: 'portal.item_published', entity: { type: 'portal_item', id }, reason: kind });
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    return { grantId, result: 'published', itemId: id, text: null };
  } catch (e) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    const code = dbCodeOf(e);
    if (code === 'PORTAL_SOURCE_NOT_IN_GRANT' || code === 'PORTAL_NOT_SELLER_SIDE') return fail(code);
    if ((e as { code?: string }).code === '23505') return { grantId, result: 'already_published', itemId: null, text: null };
    if ((e as { code?: string }).code === '42501') return fail('NOT_FOUND');
    throw e;
  }
}

export async function publishBatch(tx: Tx, actor: UserActor, kind: PortalKind, sourceId: string, grantIds: readonly string[], allowed: (f: Awaited<ReturnType<typeof grantFacts>>) => boolean): Promise<PublishOutcome[]> {
  const out: PublishOutcome[] = [];
  for (const g of [...new Set(grantIds)]) out.push(await publishOne(tx, actor, g, kind, sourceId, allowed));
  return out;
}

/** The staff item preview: what publishable() says and what renderPortalItem() would publish (no write). */
export async function itemPreview(tx: Tx, grantId: string, kind: PortalKind, sourceId: string) {
  const facts = await sourceFacts(tx, grantId, kind, sourceId, 'user');
  if (!facts) return { publishable: false, code: 'PORTAL_SOURCE_NOT_IN_GRANT', text: sentenceFor('PORTAL_SOURCE_NOT_IN_GRANT'), item: null };
  const ok = publishable(kind, facts);
  if (!ok.ok) return { publishable: false, code: ok.reason, text: sentenceFor(ok.reason), item: null };
  const s = renderPortalItem(facts);
  return { publishable: true, code: null, text: null, item: { kind: s.kind, title: s.title, body: s.body, occursOn: s.occursOn } };
}

/** Retract as the person (final; 409 on a second retract). */
export async function retractItem(tx: Tx, actor: UserActor, itemId: string): Promise<void> {
  const cur = await sql<{ retracted_at: Date | null }>`SELECT retracted_at FROM portal_items WHERE tenant_id = app.tenant_id() AND id = ${itemId} FOR UPDATE`.execute(tx);
  const row = cur.rows[0];
  if (!row) throw new AppError('NOT_FOUND');
  if (row.retracted_at) throw new AppError('PORTAL_ITEM_RETRACTED');
  const r = await sql`UPDATE portal_items SET retracted_at = now(), retracted_by_user_id = ${actor.userId}
                       WHERE tenant_id = app.tenant_id() AND id = ${itemId} AND retracted_at IS NULL`.execute(tx);
  if (Number(r.numAffectedRows ?? 0) !== 1) throw new AppError('NOT_FOUND');
  await audit(tx, actor, { action: 'portal.item_retracted', entity: { type: 'portal_item', id: itemId }, reason: 'BY_PERSON' });
}
