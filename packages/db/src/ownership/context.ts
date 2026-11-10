// Loads the inputs core/ownership.decide needs, inside the command transaction, AFTER the locks.
// Everything is read under the caller's RLS. Inputs that span other users (routing candidates, their
// push subscriptions, claim stats, the rotation cursor) are only read for the system actor
// (ARCHITECTURE §5 "Routing never runs under a user actor", Design Review F1).
import type { BusinessCalendar, ContactId, Instant, PondId, Role, RuleId, UserId } from '@realty/core/foundation';
import { HOUR_MS, businessCalendar, instant, plusMs, startOfLocalDay, toIso, zone } from '@realty/core/foundation';
import {
  type Candidate,
  type EffectiveLeadSettings,
  type InquiryFacts,
  type MemberFacts,
  type MembershipStatus,
  type OwnershipEvent,
  type PeopleFacts,
  type PondFacts,
  type RotationCursor,
  type RoutingSnapshot,
  type RuleFacts,
  matchRule,
  offeredInCurrentSequence,
  parseRoutingMatch,
} from '@realty/core/ownership';
import { sql } from 'kysely';
import type { Tx } from '../tenantTx.js';

// ---- tenant facts ---------------------------------------------------------------------------------

export interface TenantFacts {
  settings: EffectiveLeadSettings;
  calendar: BusinessCalendar;
  defaultPondCooldownHours: number;
}

interface SettingsRow {
  default_timezone: string;
  routing_hours_start: string;
  routing_hours_end: string;
  offer_window_seconds: number;
  max_offers: number;
  first_touch_sla_seconds: number;
  first_touch_release_seconds: number | null;
  reinquiry_sla_after_days: number;
  inactivity_release_days: number | null;
  inactivity_warning_hours: number;
  auto_pause_after_misses: number;
  uncontacted_capacity_cap: number;
  isa_access_after_handoff_days: number;
  soft_delete_purge_days: number;
  operating_jurisdictions: string[];
  default_pond_id: string | null;
  default_pond_cooldown: number | null;
  p_id: string | null;
}

export class TenantNotReadyError extends Error {
  override readonly name = 'TenantNotReadyError';
}

export async function loadTenantFacts(tx: Tx): Promise<TenantFacts> {
  const r = await sql<SettingsRow>`
    SELECT s.default_timezone, s.routing_hours_start::text, s.routing_hours_end::text, s.offer_window_seconds, s.max_offers,
           s.first_touch_sla_seconds, s.first_touch_release_seconds, s.reinquiry_sla_after_days, s.inactivity_release_days,
           s.inactivity_warning_hours, s.auto_pause_after_misses, s.uncontacted_capacity_cap, s.isa_access_after_handoff_days,
           s.soft_delete_purge_days, s.operating_jurisdictions,
           (SELECT p.id FROM ponds p WHERE p.tenant_id = s.tenant_id AND p.is_default) AS default_pond_id,
           (SELECT p.claim_cooldown_hours FROM ponds p WHERE p.tenant_id = s.tenant_id AND p.is_default) AS default_pond_cooldown,
           v.id AS p_id
      FROM tenant_settings s
      LEFT JOIN compliance_policy_versions v ON v.tenant_id = s.tenant_id AND v.id = s.active_policy_id
     WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const s = r.rows[0];
  if (!s) throw new TenantNotReadyError('tenant settings are not visible in this context');
  if (!s.default_pond_id || !s.p_id) throw new TenantNotReadyError('tenant has no default pond or active policy');
  const tz = zone(s.default_timezone);
  const settings: EffectiveLeadSettings = {
    offerWindowSeconds: s.offer_window_seconds,
    maxOffers: s.max_offers,
    firstTouchSlaSeconds: s.first_touch_sla_seconds,
    firstTouchReleaseSeconds: s.first_touch_release_seconds,
    reinquirySlaAfterDays: s.reinquiry_sla_after_days,
    inactivityReleaseDays: s.inactivity_release_days,
    inactivityWarningHours: s.inactivity_warning_hours,
    autoPauseAfterMisses: s.auto_pause_after_misses,
    uncontactedCapacityCap: s.uncontacted_capacity_cap,
    isaAccessAfterHandoffDays: s.isa_access_after_handoff_days,
    softDeletePurgeDays: s.soft_delete_purge_days,
    defaultPondId: s.default_pond_id as PondId,
    tenantZone: tz,
  };
  const calendar = businessCalendar({ zone: tz, open: s.routing_hours_start, close: s.routing_hours_end });
  return { settings, calendar, defaultPondCooldownHours: s.default_pond_cooldown ?? 72 };
}

/**
 * First contactable instant ≥ from for the contact (SLA base, R-OWN-13). Since core-compliance/2.0.0
 * there is no contact window (owner decision), so every instant is contactable and the first-touch SLA
 * counts from the moment ownership starts. Kept as a function so core/ownership's interface is unchanged.
 */
export function nextContactableFn(): (from: Instant) => Instant {
  return (from: Instant) => from;
}

// ---- members, ponds, people -----------------------------------------------------------------------

interface MemberRow {
  user_id: string;
  role: Role;
  status: MembershipStatus;
  accepting_leads: boolean;
  consecutive_missed_offers: number;
}

export async function loadMember(tx: Tx, userId: UserId, actorTeam?: ReadonlySet<string>): Promise<(MemberFacts & { missedOffers: number }) | undefined> {
  const r = await sql<MemberRow>`
    SELECT user_id, role, status, accepting_leads, consecutive_missed_offers FROM memberships
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId}`.execute(tx);
  const m = r.rows[0];
  if (!m) return undefined;
  return {
    userId: m.user_id as UserId,
    role: m.role,
    status: m.status,
    acceptingLeads: m.accepting_leads,
    ...(actorTeam ? { inActorTeam: actorTeam.has(m.user_id) } : {}),
    missedOffers: m.consecutive_missed_offers,
  };
}

/** Members of the teams the caller leads (app.my_team_member_ids(); empty unless a Team Lead). */
export async function myTeamMemberIds(tx: Tx): Promise<Set<string>> {
  const r = await sql<{ ids: string[] | null }>`SELECT app.my_team_member_ids() AS ids`.execute(tx);
  return new Set(r.rows[0]?.ids ?? []);
}

export async function loadPond(tx: Tx, pondId: PondId, actorUserId: UserId | null): Promise<PondFacts | undefined> {
  const r = await sql<{
    id: string; is_default: boolean; archived_at: Date | null; open_to_all: boolean; eligible_roles: Role[];
    claims_per_day: number; claim_cooldown_hours: number; reinquiry: 'reroute' | 'stay'; is_member: boolean;
  }>`
    SELECT p.id, p.is_default, p.archived_at, p.open_to_all, p.eligible_roles, p.claims_per_day, p.claim_cooldown_hours,
           p.reinquiry,
           EXISTS (SELECT 1 FROM pond_members pm WHERE pm.tenant_id = p.tenant_id AND pm.pond_id = p.id
                     AND pm.user_id = ${actorUserId}) AS is_member
      FROM ponds p WHERE p.tenant_id = app.tenant_id() AND p.id = ${pondId}`.execute(tx);
  const p = r.rows[0];
  if (!p) return undefined;
  return {
    pondId: p.id as PondId,
    isDefault: p.is_default,
    archived: p.archived_at !== null,
    openToAll: p.open_to_all,
    eligibleRoles: p.eligible_roles,
    actorIsMember: p.is_member,
    claimsPerDay: p.claims_per_day,
    claimCooldownHours: p.claim_cooldown_hours,
    reinquiry: p.reinquiry,
  };
}

export async function loadPeople(tx: Tx): Promise<PeopleFacts> {
  const admins = await sql<{ user_id: string }>`
    SELECT user_id FROM memberships WHERE tenant_id = app.tenant_id() AND role IN ('owner', 'admin') AND status = 'active'
     ORDER BY user_id`.execute(tx);
  const leads = await sql<{ member: string; lead: string }>`
    SELECT DISTINCT tm.user_id AS member, l.user_id AS lead
      FROM team_members tm
      JOIN team_members l ON l.tenant_id = tm.tenant_id AND l.team_id = tm.team_id AND l.is_lead
      JOIN memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id AND m.status = 'active'
     WHERE tm.tenant_id = app.tenant_id()
     ORDER BY 1, 2`.execute(tx);
  const teamLeadsOf: Record<string, UserId[]> = {};
  for (const row of leads.rows) (teamLeadsOf[row.member] ??= []).push(row.lead as UserId);
  return { admins: admins.rows.map((a) => a.user_id as UserId), teamLeadsOf };
}

/** app.claim_stats for the claimer (counts span contacts the caller may not see). */
export async function loadClaimStats(tx: Tx, userId: UserId, contactId: ContactId, now: Instant, facts: TenantFacts, cooldownHours: number) {
  const dayStart = startOfLocalDay(now, facts.settings.tenantZone);
  const since = plusMs(now, -cooldownHours * HOUR_MS);
  const r = await sql<{ claims_today: number; in_cooldown: boolean; uncontacted_owned: number }>`
    SELECT * FROM app.claim_stats(${userId}::uuid, ${contactId}::uuid, ${toIso(dayStart)}::timestamptz, ${toIso(since)}::timestamptz)`.execute(tx);
  const s = r.rows[0];
  return s ? { claimsToday: s.claims_today, inCooldown: s.in_cooldown, uncontactedOwned: s.uncontacted_owned } : { claimsToday: Number.MAX_SAFE_INTEGER, inCooldown: true, uncontactedOwned: Number.MAX_SAFE_INTEGER };
}

/** A deal on the contact (primary or linked) that is not closed/lost, visible to the caller. */
export async function loadDealOpen(tx: Tx, contactId: ContactId): Promise<boolean> {
  const r = await sql<{ open: boolean }>`
    SELECT EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.primary_contact_id = ${contactId}
                     AND d.stage NOT IN ('closed', 'lost'))
        OR EXISTS (SELECT 1 FROM deal_contacts dc JOIN deals d ON d.tenant_id = dc.tenant_id AND d.id = dc.deal_id
                    WHERE dc.tenant_id = app.tenant_id() AND dc.contact_id = ${contactId} AND d.stage NOT IN ('closed', 'lost'))
           AS open`.execute(tx);
  return r.rows[0]?.open ?? false;
}

export async function loadIsCollaborator(tx: Tx, contactId: ContactId, userId: UserId, now: Instant): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT EXISTS (SELECT 1 FROM contact_collaborators WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}
                     AND user_id = ${userId} AND removed_at IS NULL
                     AND (expires_at IS NULL OR expires_at > ${toIso(now)}::timestamptz)) AS ok`.execute(tx);
  return r.rows[0]?.ok ?? false;
}

// ---- routing (system actor only) -----------------------------------------------------------------

interface RuleRow {
  id: string; position: number; name: string; enabled: boolean; version: number; strategy: RuleFacts['strategy'];
  match: unknown; direct_user_id: string | null; target_pond_id: string | null; fallback_pond_id: string | null;
  offer_window_seconds: number | null; max_offers: number | null;
}

export async function loadRules(tx: Tx): Promise<RuleFacts[]> {
  const r = await sql<RuleRow>`
    SELECT id, position, name, enabled, version, strategy, match, direct_user_id, target_pond_id, fallback_pond_id,
           offer_window_seconds, max_offers
      FROM routing_rules WHERE tenant_id = app.tenant_id() AND enabled ORDER BY position`.execute(tx);
  const out: RuleFacts[] = [];
  for (const x of r.rows) {
    const m = parseRoutingMatch(x.match);
    // An invalid match never matches (fail closed: the lead falls through to later rules / the pond).
    if (!m.ok) continue;
    out.push({
      id: x.id as RuleId, position: x.position, name: x.name, enabled: x.enabled, version: x.version, strategy: x.strategy,
      match: m.match, directUserId: x.direct_user_id as UserId | null, targetPondId: x.target_pond_id as PondId | null,
      fallbackPondId: x.fallback_pond_id as PondId | null, offerWindowSeconds: x.offer_window_seconds, maxOffers: x.max_offers,
    });
  }
  return out;
}

export async function loadInquiry(tx: Tx, contactId: ContactId, inquiryId?: string): Promise<InquiryFacts> {
  const r = await sql<{ id: string; lead_source_id: string; inquiry_type: InquiryFacts['inquiryType']; postal_code: string | null; price_min_cents: string | null; price_max_cents: string | null }>`
    SELECT id, lead_source_id, inquiry_type, postal_code, price_min_cents, price_max_cents FROM lead_inquiries
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND (${inquiryId ?? null}::uuid IS NULL OR id = ${inquiryId ?? null}::uuid)
     ORDER BY received_at DESC, id DESC LIMIT 1`.execute(tx);
  const q = r.rows[0];
  if (!q) return { leadSourceId: null, inquiryType: null, postalCode: null, priceMinCents: null, priceMaxCents: null };
  return {
    inquiryId: q.id,
    leadSourceId: q.lead_source_id as InquiryFacts['leadSourceId'],
    inquiryType: q.inquiry_type,
    postalCode: q.postal_code,
    priceMinCents: q.price_min_cents === null ? null : Number(q.price_min_cents),
    priceMaxCents: q.price_max_cents === null ? null : Number(q.price_max_cents),
  };
}

const RELEASING_EVENTS = ['released', 'auto_released', 'inactivity_released', 'reassigned', 'sent_to_pond'];

/**
 * Locks membership rows in ascending user id order (global lock order step 4): FOR NO KEY UPDATE for
 * the rows this command will write (the offeree's missed-offer counter / auto-pause), FOR SHARE for
 * every other routing candidate. Acquiring every row in one global order, each in its final mode,
 * means two routings can never wait on each other in a cycle (no share → exclusive upgrades later).
 */
export async function lockMemberships(tx: Tx, shareIds: readonly string[], writeIds: readonly string[]): Promise<void> {
  const write = new Set(writeIds);
  for (const id of [...new Set([...shareIds, ...writeIds])].sort()) {
    if (write.has(id)) await sql`SELECT 1 FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${id} FOR NO KEY UPDATE`.execute(tx);
    else await sql`SELECT 1 FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${id} FOR SHARE`.execute(tx);
  }
}

/**
 * The system router's snapshot (ARCHITECTURE §5 step 2): the matched rule, its candidates with
 * eligibility inputs (memberships locked FOR SHARE, sorted), the rotation cursor (locked FOR UPDATE),
 * and who was already offered this lead in the current sequence. `writeUserIds` are the memberships
 * this command will update (locked FOR NO KEY UPDATE in the same sorted pass).
 */
export async function loadRoutingSnapshot(
  tx: Tx,
  contactId: ContactId,
  inquiry: InquiryFacts,
  ledger: readonly OwnershipEvent[],
  now: Instant,
  facts: TenantFacts,
  writeUserIds: readonly string[],
): Promise<RoutingSnapshot> {
  const rules = await loadRules(tx);
  const rule = matchRule(rules, inquiry);
  const alreadyOffered = offeredInCurrentSequence(ledger);
  if (!rule || rule.strategy === 'pond') {
    await lockMemberships(tx, [], writeUserIds);
    return { rule, candidates: [], cursor: {}, alreadyOffered };
  }
  let cursor: RotationCursor = {};
  if (rule.strategy === 'round_robin' || rule.strategy === 'weighted') {
    await sql`INSERT INTO routing_rotation_state (tenant_id, rule_id) VALUES (app.tenant_id(), ${rule.id})
              ON CONFLICT (tenant_id, rule_id) DO NOTHING`.execute(tx);
    const c = await sql<{ cursor: RotationCursor }>`
      SELECT cursor FROM routing_rotation_state WHERE tenant_id = app.tenant_id() AND rule_id = ${rule.id} FOR UPDATE`.execute(tx);
    cursor = c.rows[0]?.cursor ?? {};
  }
  const members =
    rule.strategy === 'direct'
      ? [{ user_id: rule.directUserId as string, weight: 1 }]
      : (
          await sql<{ user_id: string; weight: number }>`
            SELECT user_id, weight FROM routing_rule_members WHERE tenant_id = app.tenant_id() AND rule_id = ${rule.id}
             ORDER BY user_id`.execute(tx)
        ).rows;
  const ids = members.map((m) => m.user_id);
  await lockMemberships(tx, ids, writeUserIds);
  const since = toIso(plusMs(now, -facts.defaultPondCooldownHours * HOUR_MS));
  const rows = await sql<{ user_id: string; role: Role; status: MembershipStatus; accepting_leads: boolean; critical: boolean; cooldown: boolean; uncontacted: number }>`
    SELECT m.user_id, m.role, m.status, m.accepting_leads,
           (m.alert_phone_verified_at IS NOT NULL OR EXISTS (
              SELECT 1 FROM push_subscriptions ps WHERE ps.tenant_id = m.tenant_id AND ps.user_id = m.user_id
                 AND ps.revoked_at IS NULL)) AS critical,
           EXISTS (SELECT 1 FROM lead_ownership_events e WHERE e.tenant_id = m.tenant_id AND e.contact_id = ${contactId}
                     AND e.prev_owner_user_id = m.user_id AND e.type = ANY (${RELEASING_EVENTS}::text[])
                     AND e.occurred_at >= ${since}::timestamptz) AS cooldown,
           (SELECT count(*)::int FROM contacts c WHERE c.tenant_id = m.tenant_id AND c.owner_user_id = m.user_id
               AND c.ownership_state = 'owned' AND c.first_touch_at IS NULL AND c.first_touch_due_at IS NOT NULL) AS uncontacted
      FROM memberships m WHERE m.tenant_id = app.tenant_id() AND m.user_id = ANY (${ids}::uuid[])`.execute(tx);
  const byId = new Map(rows.rows.map((r) => [r.user_id, r]));
  const candidates: Candidate[] = [];
  for (const m of members) {
    const x = byId.get(m.user_id);
    if (!x) continue; // not a member any more: never offered
    candidates.push({
      userId: m.user_id as UserId,
      weight: m.weight,
      role: x.role,
      status: x.status,
      acceptingLeads: x.accepting_leads,
      hasCriticalChannel: x.critical,
      inReleaseCooldown: x.cooldown,
      uncontactedOwned: x.uncontacted,
    });
  }
  return { rule, candidates, cursor, alreadyOffered };
}

export function instantOrNull(d: Date | null): Instant | null {
  return d ? instant(d.getTime()) : null;
}
