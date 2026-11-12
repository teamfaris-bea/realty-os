// Deals (BUILD_PLAN module 14; A7d closed-loop attribution + commission capture; R-PERM-10; C20 fixed stages).
//
//   GET  /deals                         deals the caller can see (RLS)                            self
//   POST /deals                         create from a contact; attribution copied in this call    deal.edit (contact facts)
//   GET  /deals/:id                     deal + dates, members, contacts, stage history            deal.view
//   PATCH /deals/:id                    name / price / expected close / listing (row_version)    deal.edit
//   POST /deals/:id/stage               stage change (history row written by the DB trigger)      deal.edit
//   GET|PUT /deals/:id/financials       commission fields, HUMAN actors only (R-PERM-10)          deal.financials
//   POST /deals/:id/dates, PATCH /deal-dates/:id   key dates (TCs may edit dates only)           deal.edit (datesOnly)
//   POST /deals/:id/members, DELETE /deals/:id/members/:userId                                     deal.edit
//   POST /deals/:id/contacts                                                                        deal.edit
//
// Attribution (A7d): lead source, campaign, ad and the originating inquiry are copied from the contact's
// first-touch attribution when the deal is created and are immutable afterwards (DB trigger
// ATTRIBUTION_IMMUTABLE); no input field can set or change them. The commission lives in deal_financials,
// whose own policy admits only human Owner/Admin, the deal owner and the owner's Team Lead: the assistant
// and every system job can neither read nor write it. Every commission write is audited with a diff
// (money is not PII: from/to values are kept).
//
// A deal reaching `closed` enqueues assistant.deal_closed (the post-closing playbook enrolls only when it
// is approved, api/assistant).
import type { Actor, IdGenerator, Instant, ResourceFacts, UserActor } from '@realty/core/foundation';
import { enqueueJob, type Tx } from '@realty/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import { ASSISTANT_JOBS } from '../assistant/types.js';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { confirmInTx, updateDateInTx } from '../transactions/confirm.js';
import { assertAssignable, iso, isoOrNull } from './common.js';
import type { CreateDealBody, DealDateBody, DealDetailSchema, DealSchema, DealsQuery, FinancialsBody, FinancialsSchema, StageBody, UpdateDealBody, UpdateDealDateBody } from './schemas.js';
import { assertRefsVisible } from './tasks.js';

export type DealView = z.infer<typeof DealSchema>;
export type DealDetail = z.infer<typeof DealDetailSchema>;
export type FinancialsView = z.infer<typeof FinancialsSchema>;

/** The caller's §3 relation to a visible deal (null: invisible or nonexistent, R-PERM-5). */
export async function dealFacts(tx: Tx, dealId: string): Promise<ResourceFacts | null> {
  const r = await sql<{ own: boolean; team: boolean; member: boolean }>`
    SELECT d.owner_user_id = app.user_id() AS own, d.owner_user_id = ANY (app.my_team_member_ids()) AS team,
           EXISTS (SELECT 1 FROM deal_members m WHERE m.tenant_id = d.tenant_id AND m.deal_id = d.id AND m.user_id = app.user_id()) AS member
      FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.id = ${dealId}`.execute(tx);
  const f = r.rows[0];
  if (!f) return null;
  return { own: f.own === true, team: f.team === true, deal: f.member === true };
}

/** Deal id of a deal date, when visible. */
export async function dealOfDate(tx: Tx, dateId: string): Promise<string | null> {
  const r = await sql<{ deal_id: string }>`SELECT deal_id FROM deal_dates WHERE tenant_id = app.tenant_id() AND id = ${dateId}`.execute(tx);
  return r.rows[0]?.deal_id ?? null;
}

interface DealRow {
  id: string;
  name: string;
  side: DealView['side'];
  stage: DealView['stage'];
  stage_entered_at: Date;
  primary_contact_id: string;
  contact_name: string | null;
  owner_user_id: string;
  listing_id: string | null;
  price_cents: string | null;
  expected_close_date: string | null;
  agreement_signed_at: Date | null;
  under_contract_at: Date | null;
  closed_at: Date | null;
  lost_reason: string | null;
  lead_source_id: string | null;
  lead_source_name: string | null;
  campaign_ref: string | null;
  ad_ref: string | null;
  source_inquiry_id: string | null;
  row_version: number;
  created_at: Date;
}

const SELECT = sql`
  SELECT d.id, d.name, d.side, d.stage, d.stage_entered_at, d.primary_contact_id, c.display_name AS contact_name, d.owner_user_id, d.listing_id,
         d.price_cents, d.expected_close_date::text AS expected_close_date, d.agreement_signed_at, d.under_contract_at, d.closed_at, d.lost_reason,
         d.lead_source_id, ls.name AS lead_source_name, d.campaign_ref, d.ad_ref, d.source_inquiry_id, d.row_version, d.created_at
    FROM deals d
    LEFT JOIN contacts c ON c.tenant_id = d.tenant_id AND c.id = d.primary_contact_id
    LEFT JOIN lead_sources ls ON ls.tenant_id = d.tenant_id AND ls.id = d.lead_source_id`;

function view(r: DealRow): DealView {
  return {
    id: r.id,
    name: r.name,
    side: r.side,
    stage: r.stage,
    stageEnteredAt: iso(r.stage_entered_at),
    primaryContact: r.contact_name ? { id: r.primary_contact_id, name: r.contact_name } : null,
    ownerUserId: r.owner_user_id,
    listingId: r.listing_id,
    priceCents: r.price_cents === null ? null : Number(r.price_cents),
    expectedCloseDate: r.expected_close_date,
    agreementSignedAt: isoOrNull(r.agreement_signed_at),
    underContractAt: isoOrNull(r.under_contract_at),
    closedAt: isoOrNull(r.closed_at),
    lostReason: r.lost_reason,
    attribution: { leadSourceId: r.lead_source_id, leadSourceName: r.lead_source_name, campaignRef: r.campaign_ref, adRef: r.ad_ref, sourceInquiryId: r.source_inquiry_id },
    rowVersion: r.row_version,
    createdAt: iso(r.created_at),
  };
}

export async function listDeals(tx: Tx, actor: UserActor, q: z.infer<typeof DealsQuery>): Promise<DealView[]> {
  const open = q.open === undefined ? null : q.open === 'true';
  const mine = q.mine === 'true';
  const r = await sql<DealRow>`${SELECT}
     WHERE d.tenant_id = app.tenant_id()
       AND (${q.stage ?? null}::text IS NULL OR d.stage = ${q.stage ?? null})
       AND (${open}::boolean IS NULL OR (d.stage NOT IN ('closed','lost')) = ${open}::boolean)
       AND (${q.contactId ?? null}::uuid IS NULL OR d.primary_contact_id = ${q.contactId ?? null}::uuid
            OR EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id AND dc.contact_id = ${q.contactId ?? null}::uuid))
       AND (NOT ${mine} OR d.owner_user_id = ${actor.userId})
     ORDER BY (d.stage IN ('closed','lost')), d.expected_close_date NULLS LAST, d.created_at DESC LIMIT 200`.execute(tx);
  return r.rows.map(view);
}

export async function dealById(tx: Tx, id: string): Promise<DealDetail> {
  const r = await sql<DealRow>`${SELECT} WHERE d.tenant_id = app.tenant_id() AND d.id = ${id}`.execute(tx);
  const d = r.rows[0];
  if (!d) throw new AppError('NOT_FOUND');
  const [dates, members, contacts, history] = await Promise.all([
    sql<{ id: string; kind: DealDetail['dates'][number]['kind']; label: string | null; due_on: string; completed_at: Date | null }>`
      SELECT id, kind, label, due_on::text AS due_on, completed_at FROM deal_dates WHERE tenant_id = app.tenant_id() AND deal_id = ${id} ORDER BY due_on, id`.execute(tx),
    sql<{ user_id: string; role: 'co_agent' | 'tc' | 'isa' }>`SELECT user_id, role FROM deal_members WHERE tenant_id = app.tenant_id() AND deal_id = ${id} ORDER BY user_id`.execute(tx),
    sql<{ contact_id: string; role: DealDetail['contacts'][number]['role'] }>`SELECT contact_id, role FROM deal_contacts WHERE tenant_id = app.tenant_id() AND deal_id = ${id} ORDER BY contact_id`.execute(tx),
    sql<{ from_stage: string | null; to_stage: string; changed_at: Date; changed_by_user_id: string | null }>`
      SELECT from_stage, to_stage, changed_at, changed_by_user_id FROM deal_stage_history WHERE tenant_id = app.tenant_id() AND deal_id = ${id} ORDER BY changed_at, id`.execute(tx),
  ]);
  return {
    ...view(d),
    dates: dates.rows.map((x) => ({ id: x.id, kind: x.kind, label: x.label, dueOn: x.due_on, completedAt: isoOrNull(x.completed_at) })),
    members: members.rows.map((m) => ({ userId: m.user_id, role: m.role })),
    contacts: contacts.rows.map((c) => ({ contactId: c.contact_id, role: c.role })),
    history: history.rows.map((h) => ({ fromStage: h.from_stage, toStage: h.to_stage, changedAt: iso(h.changed_at), byUserId: h.changed_by_user_id })),
  };
}

const SIDE_NAME: Record<DealView['side'], string> = { buy: 'Buy', sell: 'Sell', dual: 'Buy & sell', lease: 'Lease' };
const SIDE_ROLE: Record<DealView['side'], 'buyer' | 'seller' | 'other'> = { buy: 'buyer', sell: 'seller', dual: 'buyer', lease: 'other' };

/** POST /deals: one call from the contact; attribution comes from the contact, never from the request (A7d). */
export async function createDeal(tx: Tx, actor: UserActor, ids: IdGenerator, b: z.infer<typeof CreateDealBody>, now: Instant): Promise<string> {
  const c = await sql<{ display_name: string; owner_user_id: string | null; original_lead_source_id: string | null; original_campaign_ref: string | null; original_ad_ref: string | null; detail: boolean }>`
    SELECT display_name, owner_user_id, original_lead_source_id, original_campaign_ref, original_ad_ref, app.contact_detail_visible(tenant_id, id) AS detail
      FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${b.primaryContactId} AND deleted_at IS NULL`.execute(tx);
  const contact = c.rows[0];
  if (!contact || !contact.detail) throw new AppError('NOT_FOUND');
  if (b.listingId) await assertRefsVisible(tx, { listingId: b.listingId });
  const owner = b.ownerUserId ?? (contact.owner_user_id && contact.owner_user_id !== actor.userId && actor.role !== 'agent' ? contact.owner_user_id : actor.userId);
  await assertAssignable(tx, actor, owner, { canOwnLeads: true });
  // the inquiry that brought the lead in: the earliest one from the contact's original source, else the earliest
  const inq = await sql<{ id: string }>`
    SELECT id FROM lead_inquiries WHERE tenant_id = app.tenant_id() AND contact_id = ${b.primaryContactId}
     ORDER BY (lead_source_id IS NOT DISTINCT FROM ${contact.original_lead_source_id}::uuid) DESC, received_at, id LIMIT 1`.execute(tx);
  const id = ids.next<'DealId'>();
  const nowIso = new Date(now).toISOString();
  await sql`
    INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, listing_id, price_cents, expected_close_date,
                       lead_source_id, campaign_ref, ad_ref, source_inquiry_id, created_by_user_id)
    VALUES (app.tenant_id(), ${id}, ${b.name ?? `${contact.display_name} · ${SIDE_NAME[b.side]}`}, ${b.side}, 'prospect', ${nowIso}::timestamptz,
            ${b.primaryContactId}, ${owner}, ${b.listingId ?? null}, ${b.priceCents ?? null}, ${b.expectedCloseDate ?? null}::date,
            ${contact.original_lead_source_id}, ${contact.original_campaign_ref}, ${contact.original_ad_ref}, ${inq.rows[0]?.id ?? null}, ${actor.userId})`.execute(tx);
  await sql`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES (app.tenant_id(), ${id}, ${b.primaryContactId}, ${b.contactRole ?? SIDE_ROLE[b.side]})`.execute(tx);
  return id;
}

async function lockedVersion(tx: Tx, id: string): Promise<{ row_version: number; stage: string }> {
  const r = await sql<{ row_version: number; stage: string }>`SELECT row_version, stage FROM deals WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx);
  if (!r.rows[0]) throw new AppError('NOT_FOUND');
  return r.rows[0];
}

export async function updateDeal(tx: Tx, id: string, b: z.infer<typeof UpdateDealBody>): Promise<void> {
  const cur = await lockedVersion(tx, id);
  if (cur.row_version !== b.rowVersion) throw new AppError('VERSION_CONFLICT', { rowVersion: cur.row_version });
  if (b.listingId) await assertRefsVisible(tx, { listingId: b.listingId });
  await sql`
    UPDATE deals SET name = COALESCE(${b.name ?? null}, name),
           listing_id = CASE WHEN ${b.listingId !== undefined} THEN ${b.listingId ?? null}::uuid ELSE listing_id END,
           price_cents = CASE WHEN ${b.priceCents !== undefined} THEN ${b.priceCents ?? null}::bigint ELSE price_cents END,
           expected_close_date = CASE WHEN ${b.expectedCloseDate !== undefined} THEN ${b.expectedCloseDate ?? null}::date ELSE expected_close_date END,
           row_version = row_version + 1, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/** POST /deals/:id/stage. The DB trigger resets stage_entered_at and appends deal_stage_history. */
export async function changeStage(tx: Tx, id: string, b: z.infer<typeof StageBody>, now: Instant): Promise<void> {
  const cur = await lockedVersion(tx, id);
  if (cur.row_version !== b.rowVersion) throw new AppError('VERSION_CONFLICT', { rowVersion: cur.row_version, stage: cur.stage });
  if (cur.stage === b.stage) throw new AppError('DEAL_STAGE_INVALID', { reason: 'SAME_STAGE' });
  if (b.stage === 'lost' && !b.lostReason) throw new AppError('DEAL_STAGE_INVALID', { reason: 'LOST_REASON_REQUIRED' });
  const nowIso = new Date(now).toISOString();
  await sql`
    UPDATE deals SET stage = ${b.stage},
           agreement_signed_at = CASE WHEN ${b.stage} IN ('agreement_signed','active','under_contract','closed') THEN COALESCE(agreement_signed_at, ${nowIso}::timestamptz) ELSE agreement_signed_at END,
           under_contract_at = CASE WHEN ${b.stage} IN ('under_contract','closed') THEN COALESCE(under_contract_at, ${nowIso}::timestamptz) ELSE under_contract_at END,
           closed_at = CASE WHEN ${b.stage} = 'closed' THEN ${nowIso}::timestamptz ELSE NULL END,
           lost_reason = CASE WHEN ${b.stage} = 'lost' THEN ${b.lostReason ?? null} ELSE NULL END,
           row_version = row_version + 1, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  if (b.stage === 'closed') {
    await enqueueJob(tx, { queue: 'default', kind: ASSISTANT_JOBS.dealClosed, payload: { dealId: id }, dedupeKey: `${ASSISTANT_JOBS.dealClosed}:${id}` });
  }
}

// ---- commission (R-PERM-10) --------------------------------------------------------------------------------

interface FinRow {
  gross_commission_cents: string | null;
  commission_rate_bps: number | null;
  team_split_bps: number | null;
  agent_split_bps: number | null;
  referral_fee_cents: string | null;
  commission_status: FinancialsView['commissionStatus'];
  updated_by_user_id: string;
  updated_at: Date;
}

function finView(f: FinRow): FinancialsView {
  return {
    grossCommissionCents: f.gross_commission_cents === null ? null : Number(f.gross_commission_cents),
    commissionRateBps: f.commission_rate_bps,
    teamSplitBps: f.team_split_bps,
    agentSplitBps: f.agent_split_bps,
    referralFeeCents: f.referral_fee_cents === null ? null : Number(f.referral_fee_cents),
    commissionStatus: f.commission_status,
    updatedByUserId: f.updated_by_user_id,
    updatedAt: iso(f.updated_at),
  };
}

/** Commission of a deal as the caller's RLS shows it (null: none recorded yet). */
export async function getFinancials(tx: Tx, dealId: string): Promise<FinancialsView | null> {
  const r = await sql<FinRow>`
    SELECT gross_commission_cents, commission_rate_bps, team_split_bps, agent_split_bps, referral_fee_cents, commission_status, updated_by_user_id, updated_at
      FROM deal_financials WHERE tenant_id = app.tenant_id() AND deal_id = ${dealId}`.execute(tx);
  return r.rows[0] ? finView(r.rows[0]) : null;
}

const FIN_COLUMNS = {
  grossCommissionCents: 'gross_commission_cents',
  commissionRateBps: 'commission_rate_bps',
  teamSplitBps: 'team_split_bps',
  agentSplitBps: 'agent_split_bps',
  referralFeeCents: 'referral_fee_cents',
  commissionStatus: 'commission_status',
} as const;

/** PUT /deals/:id/financials: upsert by a human (RLS admits only the human roles of R-PERM-10), audited with a diff. */
export async function putFinancials(tx: Tx, actor: UserActor, dealId: string, b: z.infer<typeof FinancialsBody>): Promise<FinancialsView> {
  const before = await sql<FinRow>`
    SELECT gross_commission_cents, commission_rate_bps, team_split_bps, agent_split_bps, referral_fee_cents, commission_status, updated_by_user_id, updated_at
      FROM deal_financials WHERE tenant_id = app.tenant_id() AND deal_id = ${dealId} FOR UPDATE`.execute(tx);
  const prev = before.rows[0] ? finView(before.rows[0]) : null;
  const next = {
    grossCommissionCents: b.grossCommissionCents !== undefined ? b.grossCommissionCents : (prev?.grossCommissionCents ?? null),
    commissionRateBps: b.commissionRateBps !== undefined ? b.commissionRateBps : (prev?.commissionRateBps ?? null),
    teamSplitBps: b.teamSplitBps !== undefined ? b.teamSplitBps : (prev?.teamSplitBps ?? null),
    agentSplitBps: b.agentSplitBps !== undefined ? b.agentSplitBps : (prev?.agentSplitBps ?? null),
    referralFeeCents: b.referralFeeCents !== undefined ? b.referralFeeCents : (prev?.referralFeeCents ?? null),
    commissionStatus: b.commissionStatus ?? prev?.commissionStatus ?? 'estimated',
  };
  if ((next.teamSplitBps ?? 0) + (next.agentSplitBps ?? 0) > 10000) throw new AppError('VALIDATION_FAILED', { reason: 'SPLITS_OVER_100' });
  await sql`
    INSERT INTO deal_financials (tenant_id, deal_id, gross_commission_cents, commission_rate_bps, team_split_bps, agent_split_bps, referral_fee_cents,
                                 commission_status, updated_by_user_id)
    VALUES (app.tenant_id(), ${dealId}, ${next.grossCommissionCents}, ${next.commissionRateBps}, ${next.teamSplitBps}, ${next.agentSplitBps},
            ${next.referralFeeCents}, ${next.commissionStatus}, ${actor.userId})
    ON CONFLICT (tenant_id, deal_id) DO UPDATE SET gross_commission_cents = EXCLUDED.gross_commission_cents, commission_rate_bps = EXCLUDED.commission_rate_bps,
      team_split_bps = EXCLUDED.team_split_bps, agent_split_bps = EXCLUDED.agent_split_bps, referral_fee_cents = EXCLUDED.referral_fee_cents,
      commission_status = EXCLUDED.commission_status, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`.execute(tx);
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(FIN_COLUMNS)) {
    from[col] = prev ? prev[k as keyof typeof FIN_COLUMNS] : null;
    to[col] = next[k as keyof typeof FIN_COLUMNS];
  }
  await audit(tx, actor, { action: 'deal.financials_changed', entity: { type: 'deal', id: dealId }, changes: redactDiff(from, to, { entity: 'deal_financials' }) });
  return (await getFinancials(tx, dealId)) as FinancialsView;
}

// ---- dates, members, contacts -----------------------------------------------------------------------------

// Module 31 (sole Phase 2 editor of these functions): every date written here goes through the one confirm path
// (transactions/confirm.ts), so a date typed on the deal screen is confirmed by the person who typed it and gets its
// stored instants (due_at, reminder_at) at write time (R-TXN-1, R-TXN-2).
type DateView = { id: string; kind: z.infer<typeof DealDateBody>['kind']; label: string | null; dueOn: string; completedAt: string | null };

async function dateView(tx: Tx, id: string): Promise<DateView> {
  const r = await sql<{ id: string; kind: DateView['kind']; label: string | null; due_on: string; completed_at: Date | null }>`
    SELECT id, kind, label, due_on::text AS due_on, completed_at FROM deal_dates WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  const x = r.rows[0];
  if (!x) throw new AppError('NOT_FOUND');
  return { id: x.id, kind: x.kind, label: x.label, dueOn: x.due_on, completedAt: isoOrNull(x.completed_at) };
}

export async function addDealDate(tx: Tx, actor: Actor, ids: IdGenerator, dealId: string, b: z.infer<typeof DealDateBody>, now: Instant): Promise<DateView> {
  const id = await confirmInTx(tx, actor, ids, { dealId, dateId: null, kind: b.kind, label: b.label ?? null, dueOn: b.dueOn }, now);
  return dateView(tx, id);
}

export async function updateDealDate(tx: Tx, actor: Actor, ids: IdGenerator, id: string, b: z.infer<typeof UpdateDealDateBody>, now: Instant): Promise<DateView> {
  await updateDateInTx(tx, actor, ids, id, b, now);
  return dateView(tx, id);
}

export async function addDealMember(tx: Tx, actor: UserActor, dealId: string, userId: string, role: 'co_agent' | 'tc' | 'isa'): Promise<void> {
  const m = await sql<{ status: string; role: string }>`SELECT status, role FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}`.execute(tx);
  if (!m.rows[0] || m.rows[0].status !== 'active') throw new AppError('ASSIGNEE_NOT_ELIGIBLE');
  void actor;
  await sql`INSERT INTO deal_members (tenant_id, deal_id, user_id, role) VALUES (app.tenant_id(), ${dealId}, ${userId}, ${role})
            ON CONFLICT (tenant_id, deal_id, user_id) DO UPDATE SET role = EXCLUDED.role`.execute(tx);
}

export async function removeDealMember(tx: Tx, dealId: string, userId: string): Promise<void> {
  const r = await sql`DELETE FROM deal_members WHERE tenant_id = app.tenant_id() AND deal_id = ${dealId} AND user_id = ${userId}`.execute(tx);
  if (Number(r.numAffectedRows ?? 0) === 0) throw new AppError('NOT_FOUND');
}

export async function addDealContact(tx: Tx, dealId: string, contactId: string, role: string): Promise<void> {
  await assertRefsVisible(tx, { contactId });
  await sql`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES (app.tenant_id(), ${dealId}, ${contactId}, ${role})
            ON CONFLICT (tenant_id, deal_id, contact_id) DO UPDATE SET role = EXCLUDED.role`.execute(tx);
}
