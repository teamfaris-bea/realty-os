// The tenant switch and the agent's opt-in (R-ISA-32, R-ISA-15; docs/AI_ISA.md §3.3, §3.5). Default off. Only the
// Owner turns the switch on or raises the cap (re-auth plus a typed attestation; the DB guard backstops); Owner or
// Admin turns it off, which ends every assignment (`tenant_off`) with one notice per owner. An agent opts in as
// themselves on the approved version, with re-auth on create or widen; the attestation text embeds the version hash
// and its sha256 is recomputed by the DB guard. Revoking the opt-in ends every assignment of the agent.
import type { Instant, UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import { continueCare, currentPolicy, systemEndInTx } from './controls.js';
import { sha256, type IsaDeps } from './effects.js';
import { assignmentById, lockForTurn, tenantIsaFacts } from './repo.js';

export const NOTICE_SENTENCE = 'The AI assistant (ISA) uses engineering defaults for consent evidence, quiet hours and frequency limits on its own messages. These are not legal advice and have not been reviewed by counsel.';

export function attestationText(versionSha: string): string {
  return `I opt in to the team's AI assistant policy version ${versionSha}. I'm responsible for leads I put in AI care.`;
}

export async function adminView(tx: Tx, liveSends: boolean) {
  const t = await tenantIsaFacts(tx);
  const s = await sql<{ by: string | null; at: Date | null }>`SELECT ai_isa_enabled_by AS by, ai_isa_enabled_at AS at FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const c = await sql<{ live: number; overdue: number }>`SELECT (SELECT count(*)::int FROM ai_isa_assignments WHERE tenant_id = app.tenant_id() AND ended_at IS NULL) AS live,
    (SELECT count(*)::int FROM ai_isa_handoffs WHERE tenant_id = app.tenant_id() AND sla_met_at IS NULL AND sla_due_at < now()) AS overdue`.execute(tx);
  const hold = !t.packCleared ? 'Waiting on counsel review (platform:ai_isa). Nothing is sent until counsel clears it.'
    : !liveSends ? 'AI assistant sending is off on this deployment.'
    : t.sentToday >= t.dailyCap ? "The team's daily AI assistant limit is reached; it continues tomorrow." : null;
  return { enabled: t.isaEnabled, aiEnabled: t.aiEnabled, dailyCap: t.dailyCap, sentToday: t.sentToday, packCleared: t.packCleared, liveSends, holdSentence: hold,
    enabledByUserId: s.rows[0]?.by ?? null, enabledAt: s.rows[0]?.at?.toISOString() ?? null, overdueHandoffs: c.rows[0]!.overdue, underCare: c.rows[0]!.live, noticeSentence: NOTICE_SENTENCE };
}

/** Whether a tenant PUT loosens (turns on or raises the cap): the MATRIX `loosening` fact. */
export async function adminLoosening(tx: Tx, body: { enabled: boolean; dailyCap: number }): Promise<boolean> {
  const t = await tenantIsaFacts(tx);
  return (body.enabled && !t.isaEnabled) || body.dailyCap > t.dailyCap;
}

export async function adminPut(actor: UserActor, deps: IsaDeps, body: { enabled: boolean; dailyCap: number; attestation?: string }): Promise<{ ended: number }> {
  const was = await withTenantTx(actor, async (tx, now) => {
    const t = await tenantIsaFacts(tx);
    const on = body.enabled && !t.isaEnabled;
    await sql`UPDATE tenant_settings SET ai_isa_enabled = ${body.enabled}, ai_isa_daily_cap = ${body.dailyCap}
        ${on ? sql`, ai_isa_enabled_by = ${actor.userId}, ai_isa_enabled_at = ${new Date(now)}` : sql``}
      WHERE tenant_id = app.tenant_id()`.execute(tx);
    if (on) await audit(tx, actor, { action: 'ai_isa.tenant_enabled', entity: { type: 'tenant_settings', id: actor.tenantId }, reason: `attested:${sha256(body.attestation ?? '').slice(0, 16)}` });
    if (!body.enabled && t.isaEnabled) await audit(tx, actor, { action: 'ai_isa.tenant_disabled', entity: { type: 'tenant_settings', id: actor.tenantId } });
    if (body.dailyCap !== t.dailyCap) await audit(tx, actor, { action: 'ai_isa.tenant_cap_changed', entity: { type: 'tenant_settings', id: actor.tenantId }, changes: { ai_isa_daily_cap: { from: t.dailyCap, to: body.dailyCap } } as never });
    return t.isaEnabled;
  }, { db: deps.db, retries: 2 });
  if (body.enabled || !was) return { ended: 0 };
  return { ended: await endAll(deps, actor.tenantId, 'tenant_off', null) };
}

/** E522: ends every live assignment (of the tenant, or of one owner) as the system, each with its one handoff. */
export async function endAll(deps: IsaDeps, tenantId: string, reason: 'tenant_off' | 'optin_revoked', ownerUserId: string | null): Promise<number> {
  const sa = systemActor(tenantId, 'assistant');
  const ids = await withTenantTx(sa, async (tx) => (await sql<{ id: string }>`SELECT id FROM ai_isa_assignments WHERE tenant_id = app.tenant_id() AND ended_at IS NULL
    ${ownerUserId ? sql`AND owner_user_id = ${ownerUserId}` : sql``}`.execute(tx)).rows.map((r) => r.id), { db: deps.db });
  let n = 0;
  for (const id of ids) {
    await withTenantTx(sa, async (tx, now) => {
      const peek = await assignmentById(tx, id);
      if (!peek) return;
      await lockForTurn(tx, peek.contactId, id);
      const a = await assignmentById(tx, id, 'update');
      if (a && (await systemEndInTx(tx, deps, sa, a, reason, now))) n += 1;
    }, { db: deps.db, retries: 2 });
  }
  return n;
}

export async function meView(tx: Tx, actor: UserActor) {
  const pol = await currentPolicy(tx);
  const o = await sql<{ id: string; v: string; capabilities: string[]; channels: string[]; timezone: string; availability: unknown; booking: { kinds?: string[] }; created_at: Date }>`
    SELECT id, playbook_version_id AS v, capabilities, channels, timezone, availability, booking, created_at FROM ai_isa_agent_optins
     WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId} AND status = 'active'`.execute(tx);
  const cal = await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM user_calendar_links WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId}
    AND status IN ('connected','degraded') AND revoked_at IS NULL) AS ok`.execute(tx);
  const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ai_isa_assignments WHERE tenant_id = app.tenant_id() AND owner_user_id = ${actor.userId} AND ended_at IS NULL`.execute(tx);
  const opt = o.rows[0];
  const content = pol?.steps as { capabilities?: string[]; channels?: string[] } | undefined;
  return {
    optIn: opt ? { id: opt.id, versionId: opt.v, capabilities: opt.capabilities, channels: opt.channels, timezone: opt.timezone, availability: opt.availability as never, bookingKinds: opt.booking.kinds ?? [], createdAt: opt.created_at.toISOString() } : null,
    policy: pol ? { versionId: pol.versionId, versionSha: pol.sha, capabilities: content?.capabilities ?? ['converse'], channels: content?.channels ?? ['sms', 'email'] } : null,
    attestationText: pol ? attestationText(pol.sha) : null,
    needsReattest: opt !== undefined && pol !== null && opt.v !== pol.versionId,
    calendarLive: cal.rows[0]!.ok,
    underCare: n.rows[0]!.n,
    sentence: pol === null ? 'Your team has no approved AI assistant policy yet.' : opt ? 'You are opted in.' : 'You have not opted in. Nothing is sent for your leads.',
  };
}

export interface OptInBody {
  versionId: string;
  capabilities: string[];
  channels: ('sms' | 'email')[];
  timezone: string;
  availability: { weekday: number; start: string; end: string }[];
  bookingKinds: string[];
}

/** The MATRIX `loosening` fact of an opt-in: a create or anything wider than the current one (re-auth). */
export async function optInLoosening(tx: Tx, actor: UserActor, b: Pick<OptInBody, 'capabilities' | 'channels'>): Promise<boolean> {
  const o = await sql<{ capabilities: string[]; channels: string[] }>`SELECT capabilities, channels FROM ai_isa_agent_optins WHERE tenant_id = app.tenant_id()
    AND user_id = ${actor.userId} AND status = 'active'`.execute(tx);
  const cur = o.rows[0];
  if (!cur) return true;
  return !b.capabilities.every((c) => cur.capabilities.includes(c)) || !b.channels.every((c) => cur.channels.includes(c));
}

export async function optIn(actor: UserActor, deps: IsaDeps, b: OptInBody): Promise<{ optInId: string; change: 'created' | 'narrowed' | 'superseded' }> {
  if (actor.role === 'tc' || actor.role === 'isa') throw new AppError('AI_ISA_ROLE_NOT_ELIGIBLE');
  return withTenantTx(actor, async (tx) => {
    const pol = await currentPolicy(tx);
    if (pol === null || pol.versionId !== b.versionId) throw new AppError('AI_ISA_POLICY_NOT_APPROVED');
    if (b.capabilities.includes('book_appointments')) {
      const cal = await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM user_calendar_links WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId}
        AND status IN ('connected','degraded') AND revoked_at IS NULL) AS ok`.execute(tx);
      if (!cal.rows[0]!.ok) throw new AppError('AI_ISA_CALENDAR_REQUIRED');
    }
    const caps = b.capabilities.includes('converse') ? b.capabilities : ['converse', ...b.capabilities];
    const loosening = await optInLoosening(tx, actor, { capabilities: caps, channels: b.channels });
    const prev = await sql<{ id: string }>`UPDATE ai_isa_agent_optins SET status = 'superseded' WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId} AND status = 'active' RETURNING id`.execute(tx);
    const id = deps.ids.next<'X'>() as string;
    const text = attestationText(pol.sha);
    await sql`INSERT INTO ai_isa_agent_optins (tenant_id, id, user_id, playbook_version_id, attestation, attestation_sha256, capabilities, channels, timezone, availability, booking)
      VALUES (app.tenant_id(), ${id}, ${actor.userId}, ${pol.versionId}, ${text}, ${sha256(text)}, ${caps}::text[], ${b.channels}::text[], ${b.timezone},
              ${JSON.stringify(b.availability)}::jsonb, ${JSON.stringify({ kinds: b.bookingKinds })}::jsonb)`.execute(tx);
    const change = prev.rows.length === 0 ? 'created' : loosening ? 'superseded' : 'narrowed';
    await audit(tx, actor, { action: change === 'created' ? 'ai_isa.optin_created' : change === 'narrowed' ? 'ai_isa.optin_narrowed' : 'ai_isa.optin_superseded', entity: { type: 'ai_isa_agent_optin', id } });
    if (prev.rows.length > 0) {
      // assignments keep their bound opt-in id (immutable); a new opt-in row means they continue only through re-attestation
      await sql`SELECT 1`.execute(tx);
    }
    return { optInId: id, change };
  }, { db: deps.db, retries: 2 });
}

export async function revokeOptIn(actor: UserActor, deps: IsaDeps, userId: string = actor.userId): Promise<number> {
  await withTenantTx(actor, async (tx, now: Instant) => {
    const r = await sql<{ id: string }>`UPDATE ai_isa_agent_optins SET status = 'revoked', revoked_at = ${new Date(now)}, revoked_by_user_id = ${actor.userId}
      WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND status = 'active' RETURNING id`.execute(tx);
    if (r.rows[0]) await audit(tx, actor, { action: 'ai_isa.optin_revoked', entity: { type: 'ai_isa_agent_optin', id: r.rows[0].id } });
  }, { db: deps.db, retries: 2 });
  return endAll(deps, actor.tenantId, 'optin_revoked', userId);
}

/** §3.2 re-attestation after a widening supersede: one opt-in on the new version continues every paused assignment. */
export async function reattest(actor: UserActor, deps: IsaDeps, versionId: string) {
  const current = await withTenantTx(actor, (tx) => sql<{ capabilities: string[]; channels: string[]; timezone: string; availability: unknown; booking: { kinds?: string[] } }>`
    SELECT capabilities, channels, timezone, availability, booking FROM ai_isa_agent_optins WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId}
      AND status IN ('active','superseded') ORDER BY created_at DESC LIMIT 1`.execute(tx), { db: deps.db });
  const c = current.rows[0];
  if (!c) throw new AppError('AI_ISA_NO_OPTIN');
  await optIn(actor, deps, { versionId, capabilities: c.capabilities, channels: c.channels as ('sms' | 'email')[], timezone: c.timezone, availability: c.availability as never, bookingKinds: c.booking.kinds ?? [] });
  const paused = await withTenantTx(actor, (tx) => sql<{ contact_id: string }>`SELECT contact_id FROM ai_isa_assignments WHERE tenant_id = app.tenant_id() AND owner_user_id = ${actor.userId}
    AND ended_at IS NULL AND pause_reason IN ('policy_updated','approval_revoked')`.execute(tx), { db: deps.db });
  const continued: { contactId: string; assignmentId: string }[] = [];
  const notContinued: { contactId: string; code: string; sentence: string }[] = [];
  for (const p of paused.rows) {
    try {
      const r = await continueCare(actor, deps, p.contact_id);
      continued.push({ contactId: p.contact_id, assignmentId: r.assignmentId });
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'INTERNAL_ERROR';
      notContinued.push({ contactId: p.contact_id, code, sentence: `Not continued: ${code}.` });
    }
  }
  return { continued, notContinued };
}
