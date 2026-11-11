// Per-person facts for core bulkPreflight (parity module 63), read in the CREATOR's transaction, so RLS
// decides what they see now (at draft for the preview, and again for every item at run time, R-PAR-34).
//
// For sends the facts include the full send-time gate input (comms buildGateInput, the same input
// dispatchOutbound's TX1 builds) PLUS the consent rows of the person's REMOVED phones (R-PAR-12: removing
// a number never un-blocks the person; only a point removed as a confirmed wrong number is exempt, as in
// the DB guards). comms' own fan-out reads live points only, so without this core would see less than the
// DB guard; core may deny more than the guard, never less.
import { type Channel, type ConsentStateRow, type GateInput } from '@realty/core/compliance';
import type { Instant, ResourceFacts } from '@realty/core/foundation';
import { type BulkKindFacts, type BulkPersonFacts, type Stage, isStage } from '@realty/core/parity/bulk';
import { type OnePersonContext, renderForSend } from '@realty/core/parity/templates';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { buildGateInput } from '../comms/gateInput.js';
import { renderHumanBody } from '../comms/render.js';
import { reachabilityOf } from '../comms/reachability.js';
import { contactFacts } from '../comms/repos/contacts.js';
import * as g from '../comms/repos/gate.js';
import * as P from '../assistant/repos/playbooks.js';
import { onePersonContext, senderContext } from '../templates/repos/context.js';
import type { ActionRow } from './repos/bulk.js';

export interface PersonRow {
  id: string;
  detailVisible: boolean;
  deleted: boolean;
  merged: boolean;
  stage: string;
  ownerUserId: string | null;
  ownershipState: string;
  firstTouchPending: boolean;
  lastInboundAt: Instant | null;
}

/** The person as the creator sees them now; null when RLS hides the row entirely. */
export async function personRow(tx: Tx, contactId: string): Promise<PersonRow | null> {
  const r = await sql<{ id: string; v: boolean; deleted: boolean; merged: boolean; stage: string; owner_user_id: string | null; ownership_state: string; ftp: boolean; last_inbound_at: Date | null }>`
    SELECT c.id, app.contact_detail_visible(c.tenant_id, c.id) AS v, c.deleted_at IS NOT NULL AS deleted,
           c.merged_into_contact_id IS NOT NULL AS merged, c.stage, c.owner_user_id, c.ownership_state,
           (c.ownership_state = 'owned' AND c.first_touch_due_at IS NOT NULL AND c.first_touch_at IS NULL) AS ftp,
           c.last_inbound_at
      FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}`.execute(tx);
  const x = r.rows[0];
  if (!x) return null;
  return { id: x.id, detailVisible: x.v, deleted: x.deleted, merged: x.merged, stage: x.stage, ownerUserId: x.owner_user_id, ownershipState: x.ownership_state, firstTouchPending: x.ftp, lastInboundAt: x.last_inbound_at ? (x.last_inbound_at.getTime() as Instant) : null };
}

export async function personFacts(tx: Tx, p: PersonRow | null): Promise<BulkPersonFacts> {
  if (!p || !p.detailVisible) return { detailVisible: false, merged: false, deleted: false, access: {} };
  const access: ResourceFacts = (await contactFacts(tx, p.id)) ?? {};
  return { detailVisible: true, merged: p.merged, deleted: p.deleted, access };
}

/** The send's frozen recipient point: the person's primary active point of the channel's kind. */
export async function sendPoint(tx: Tx, contactId: string, kind: 'email' | 'text'): Promise<g.PointRow | null> {
  const want = kind === 'email' ? 'email' : 'phone';
  return (await g.contactPoints(tx, contactId)).find((pt) => pt.kind === want && pt.status === 'active' && (kind === 'email' || pt.lineType !== 'landline')) ?? null;
}

/** R-PAR-12: opt-out rows of the person's REMOVED phones (except confirmed wrong numbers), for texts. */
async function removedPhoneConsent(tx: Tx, contactId: string, channel: Channel): Promise<ConsentStateRow[]> {
  if (channel !== 'sms') return [];
  const r = await sql<{ h: Buffer }>`
    SELECT address_hmac AS h FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND kind = 'phone' AND removed_at IS NOT NULL
       AND removed_reason IS DISTINCT FROM 'wrong_number'`.execute(tx);
  return g.consentRows(tx, 'sms', r.rows.map((x) => x.h.toString('hex')));
}

/** Everything about the send that is the same for every person of the action (read once per transaction). */
export interface SendContext {
  channel: 'email' | 'sms';
  senderPhoneId: string | null;
  senderEmailId: string | null;
  sender: Pick<OnePersonContext, 'agent' | 'team' | 'brokerage'>;
  brokerage: string;
  postalAddress: string | null;
  signature: string | null;
}

export async function sendContext(tx: Tx, kind: 'email' | 'text', userId: string): Promise<SendContext> {
  const nums = await g.candidateNumbers(tx, userId);
  const tenant = await g.tenantFacts(tx);
  const sig = await sql<{ s: string | null }>`SELECT email_signature AS s FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}`.execute(tx);
  return {
    channel: kind === 'email' ? 'email' : 'sms',
    senderPhoneId: kind === 'text' ? (nums.direct ?? nums.teamMain) : null,
    senderEmailId: kind === 'email' ? await g.chooseEmailIdentity(tx, userId) : null,
    sender: await senderContext(tx),
    brokerage: tenant.brokerageLegalName,
    postalAddress: tenant.postalAddress,
    signature: kind === 'email' ? (sig.rows[0]?.s ?? null) : null,
  };
}

/** R-PAR-40: a batch text names the brokerage and ends with the opt-out line. VERIFY WITH COUNSEL (wording). */
export function batchTextBody(text: string, brokerage: string): string {
  return `${text.trim()}\n— ${brokerage}. Reply STOP to opt out.`;
}

export interface SendFacts {
  facts: Extract<BulkKindFacts, { kind: 'email' | 'text' }>;
  point: g.PointRow | null;
  /** the person's rendered text (the template applied), as handed to compose; null when not renderable */
  text: { subject: string | null; body: string } | null;
}

/** The send facts of one person: the frozen point, the full gate input, the rendered template. */
export async function sendFacts(tx: Tx, a: Pick<ActionRow, 'kind' | 'subjectSnapshot' | 'bodySnapshot'>, ctx: SendContext, contactId: string, p: PersonRow, seen: Set<string> | null, now: Instant, frozenHmac?: string | null): Promise<SendFacts> {
  const kind = a.kind as 'email' | 'text';
  const point = frozenHmac !== undefined
    ? ((await g.contactPoints(tx, contactId)).find((pt) => pt.hmac === frozenHmac && pt.status === 'active') ?? null)
    : await sendPoint(tx, contactId, kind);
  const one = await onePersonContext(tx, contactId);
  const rendered = one ? renderForSend({ channel: ctx.channel, subject: a.subjectSnapshot, body: a.bodySnapshot ?? '' }, { ...one, ...ctx.sender }) : null;
  const text = rendered && rendered.ok ? { subject: rendered.subject, body: kind === 'text' ? batchTextBody(rendered.body, ctx.brokerage) : rendered.body } : null;
  const base = { kind, lastInboundAt: p.lastInboundAt, rendered: rendered && rendered.ok ? ({ ok: true } as const) : ({ ok: false, code: rendered && !rendered.ok ? rendered.code : 'MERGE_FIELD_EMPTY' } as const) };
  if (!point) return { facts: { ...base, addressHmac: null, sharedWithEarlier: false, gate: null } as SendFacts['facts'], point: null, text };
  const shared = seen !== null && seen.has(point.hmac);
  seen?.add(point.hmac);
  const body = renderHumanBody(text?.body ?? 'x', { channel: ctx.channel, purpose: 'marketing', identity: { brokerageLegalName: ctx.brokerage, postalAddress: ctx.postalAddress }, unsubscribe: ctx.channel === 'email' ? '(unsubscribe link)' : null, signature: ctx.signature });
  const gate: GateInput = await buildGateInput(tx, {
    contactId,
    recipient: { kind: 'contact', addressHmac: point.hmac, channel: ctx.channel, pointId: point.id },
    purpose: 'marketing',
    initiator: 'human',
    category: 'none',
    sender: { phoneNumberId: ctx.senderPhoneId, emailIdentityId: ctx.senderEmailId },
    body,
  }, now);
  const extra = await removedPhoneConsent(tx, contactId, ctx.channel);
  return { facts: { ...base, addressHmac: point.hmac, sharedWithEarlier: shared, gate: { ...gate, consent: [...gate.consent, ...extra] } } as SendFacts['facts'], point, text };
}

/** Per-kind facts for the non-send kinds. */
export async function kindFacts(tx: Tx, a: Pick<ActionRow, 'kind' | 'params'>, p: PersonRow, now: Instant, target?: { role: ResourceFacts['target'] }): Promise<BulkKindFacts> {
  switch (a.kind) {
    case 'tag':
    case 'untag': {
      const tagId = String(a.params['tagId']);
      const r = await sql<{ tagged: boolean; n: string }>`
        SELECT EXISTS (SELECT 1 FROM contact_tags t WHERE t.tenant_id = app.tenant_id() AND t.contact_id = ${p.id} AND t.tag_id = ${tagId}) AS tagged,
               (SELECT count(*) FROM contact_tags t WHERE t.tenant_id = app.tenant_id() AND t.contact_id = ${p.id})::text AS n`.execute(tx);
      const x = r.rows[0]!;
      return a.kind === 'tag' ? { kind: 'tag', alreadyTagged: x.tagged, tagCount: Number(x.n) } : { kind: 'untag', tagged: x.tagged };
    }
    case 'stage': {
      const to = String(a.params['stage']);
      return { kind: 'stage', currentStage: (isStage(p.stage) ? p.stage : 'new') as Stage, toStage: (isStage(to) ? to : 'new') as Stage, firstTouchPending: p.firstTouchPending };
    }
    case 'assign':
      return { kind: 'assign', ownerUserId: p.ownerUserId, toUserId: String(a.params['toUserId']), target: target?.role ? { role: target.role.role, inMyTeam: target.role.inMyTeam === true } : { role: 'tc', inMyTeam: false } };
    case 'enroll': {
      const live = await P.liveEnrollmentOf(tx, p.id);
      const reach = await reachabilityOf(tx, p.id, now);
      const reachable = reach !== null && ((reach.channels.sms.hasAddress && !reach.channels.sms.blocked) || (reach.channels.email.hasAddress && !reach.channels.email.blocked));
      return { kind: 'enroll', liveEnrollment: live !== null, reachable };
    }
    default:
      throw new TypeError(`kindFacts: ${a.kind} is a send`);
  }
}

/** The assign target as the creator sees it (role, active, in a team they lead). */
export async function assignTarget(tx: Tx, toUserId: string): Promise<{ role: NonNullable<ResourceFacts['target']>; active: boolean } | null> {
  const r = await sql<{ role: string; status: string; in_team: boolean }>`
    SELECT role, status, ${toUserId}::uuid = ANY (app.my_team_member_ids()) AS in_team FROM memberships
     WHERE tenant_id = app.tenant_id() AND user_id = ${toUserId}`.execute(tx);
  const x = r.rows[0];
  if (!x) return null;
  return { role: { role: x.role as NonNullable<ResourceFacts['target']>['role'], inMyTeam: x.in_team }, active: x.status === 'active' };
}
