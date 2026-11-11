// The one-contact context an assistant run is built from (R-AST-14, ARCHITECTURE §11): the contact,
// their own messages, calls (decrypted transcripts, only for the calls asked for), notes, deals,
// listings and behavior events, plus the tenant identity and the requesting agent's own last sent
// messages for tone. Read as the system actor inside one transaction; nothing here crosses contacts
// except the voice samples, which core.buildPrompt scrubs and labels as other conversations.
import type { ContactBundle, IdentityFacts, PromptAttribute, TranscriptSegment } from '@realty/core/assistant';
import type { ContactId, IanaZone, TenantId } from '@realty/core/foundation';
import { ianaZone, instantFromDate } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { redactNames } from '@realty/core/assistant';
import type { EnvelopeService } from '../../crypto/envelope.js';

export interface ContactCore {
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  stage: string;
  zone: IanaZone;
  ownerUserId: string | null;
  ownershipState: string;
  periodSeq: number | null;
  deleted: boolean;
  /**
   * Merged away into another record (merged_into_contact_id set): never a send or enrollment target (F1, F2). A stage
   * entry skips it as person_removed (stageAutomation/decide.ts), and the merge stops its enrollment (R-OWN-24).
   */
  merged: boolean;
}

export async function contactCore(tx: Tx, contactId: string): Promise<ContactCore | null> {
  const r = await sql<{ id: string; first_name: string | null; last_name: string | null; display_name: string; stage: string; timezone: string | null; default_timezone: string; owner_user_id: string | null; ownership_state: string; ownership_period_seq: string | null; deleted: boolean; merged: boolean }>`
    SELECT c.id, c.first_name, c.last_name, c.display_name, c.stage, c.timezone, s.default_timezone, c.owner_user_id, c.ownership_state,
           c.ownership_period_seq, c.deleted_at IS NOT NULL AS deleted, c.merged_into_contact_id IS NOT NULL AS merged
      FROM contacts c JOIN tenant_settings s ON s.tenant_id = c.tenant_id
     WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}`.execute(tx);
  const c = r.rows[0];
  if (!c) return null;
  const z = ianaZone(c.timezone) ?? ianaZone(c.default_timezone) ?? ('America/New_York' as IanaZone);
  return {
    id: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    displayName: c.display_name,
    stage: c.stage,
    zone: z,
    ownerUserId: c.owner_user_id,
    ownershipState: c.ownership_state,
    periodSeq: c.ownership_period_seq === null ? null : Number(c.ownership_period_seq),
    deleted: c.deleted,
    merged: c.merged,
  };
}

export interface InquiryFacts {
  id: string;
  type: string;
  sourceName: string;
  message: string | null;
  receivedAt: number;
  vaLoanIndicated: boolean;
  propertyText: string | null;
  listingAddress: string | null;
}

const VA_RE = /\bva\s*(?:home\s*)?loans?\b/i;

/** The latest inquiry; the VA question depends only on what the source or form indicated (R-AST-12). */
export async function latestInquiry(tx: Tx, contactId: string): Promise<InquiryFacts | null> {
  const r = await sql<{ id: string; inquiry_type: string; name: string; message: string | null; received_at: Date; source_detail: Record<string, unknown>; property_text: string | null; address_line1: string | null }>`
    SELECT i.id, i.inquiry_type, s.name, i.message, i.received_at, i.source_detail, i.property_text, l.address_line1
      FROM lead_inquiries i JOIN lead_sources s ON s.tenant_id = i.tenant_id AND s.id = i.lead_source_id
      LEFT JOIN listings l ON l.tenant_id = i.tenant_id AND l.id = i.listing_id
     WHERE i.tenant_id = app.tenant_id() AND i.contact_id = ${contactId} AND i.outcome <> 'duplicate_ignored'
     ORDER BY i.received_at DESC, i.id DESC LIMIT 1`.execute(tx);
  const i = r.rows[0];
  if (!i) return null;
  const d = i.source_detail ?? {};
  const flag = d.va_loan ?? d.vaLoan ?? d.va;
  const vaLoanIndicated = flag === true || (typeof flag === 'string' && /^(1|true|yes|y)$/i.test(flag.trim())) || (i.message !== null && VA_RE.test(i.message));
  return { id: i.id, type: i.inquiry_type, sourceName: i.name, message: i.message, receivedAt: instantFromDate(i.received_at), vaLoanIndicated, propertyText: i.property_text, listingAddress: i.address_line1 };
}

const transcriptAad = (rowId: string) => ({ table: 'transcripts', column: 'segments_enc', rowId });

export interface CallTranscript {
  callId: string;
  contactId: string;
  agentUserId: string | null;
  direction: 'inbound' | 'outbound';
  startedAt: number;
  segments: TranscriptSegment[];
  transcriptId: string;
}

/** Ready transcripts of these calls of this contact, decrypted (never logged). */
export async function callTranscripts(tx: Tx, envelope: EnvelopeService, tenantId: string, contactId: string, callIds: readonly string[]): Promise<CallTranscript[]> {
  if (callIds.length === 0) return [];
  const r = await sql<{ call_id: string; contact_id: string; agent_user_id: string | null; direction: 'inbound' | 'outbound'; started_at: Date; tid: string; segments_enc: Buffer }>`
    SELECT c.id AS call_id, c.contact_id, c.agent_user_id, c.direction, c.started_at, t.id AS tid, t.segments_enc
      FROM calls c JOIN recordings r ON r.tenant_id = c.tenant_id AND r.call_id = c.id
      JOIN transcripts t ON t.tenant_id = r.tenant_id AND t.recording_id = r.id
     WHERE c.tenant_id = app.tenant_id() AND c.contact_id = ${contactId} AND c.id = ANY (${callIds}::uuid[]) AND t.status = 'ready'
     ORDER BY c.started_at`.execute(tx);
  const env = envelope.inTx(tx, tenantId as TenantId);
  const out: CallTranscript[] = [];
  for (const x of r.rows) {
    const plain = Buffer.from(await env.decrypt(tenantId as TenantId, transcriptAad(x.tid), new Uint8Array(x.segments_enc))).toString('utf8');
    const raw = JSON.parse(plain) as { startMs: number; endMs: number; speaker?: string | null; text: string }[];
    const segments: TranscriptSegment[] = raw.map((s) => (s.speaker ? { startMs: s.startMs, endMs: s.endMs, speaker: s.speaker, text: s.text } : { startMs: s.startMs, endMs: s.endMs, text: s.text }));
    out.push({ callId: x.call_id, contactId: x.contact_id, agentUserId: x.agent_user_id, direction: x.direction, startedAt: instantFromDate(x.started_at), segments, transcriptId: x.tid });
  }
  return out;
}

/** Everything about ONE contact a prompt may contain (core drops anything that is not this contact's). */
export async function contactBundle(tx: Tx, c: ContactCore, o: { calls?: readonly CallTranscript[]; messageLimit?: number } = {}): Promise<ContactBundle> {
  const attrs = await sql<{ key: string; value: unknown; sensitivity: string }>`
    SELECT key, value, sensitivity FROM contact_attributes WHERE tenant_id = app.tenant_id() AND contact_id = ${c.id} ORDER BY key`.execute(tx);
  const attributes: PromptAttribute[] = [];
  for (const a of attrs.rows) {
    // R-AST-12: protected proxies never reach a prompt (dropped here AND by core's type)
    if (a.sensitivity !== 'normal') continue;
    const v = a.value;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attributes.push({ key: a.key, value: v, sensitivity: 'normal' });
  }
  const inq = await latestInquiry(tx, c.id);
  const msgs = await sql<{ id: string; contact_id: string; direction: 'inbound' | 'outbound'; channel: string; occurred_at: Date; body: string; initiator: string }>`
    SELECT id, contact_id, direction, channel, occurred_at, body, initiator FROM (
      SELECT id, contact_id, direction, channel, occurred_at, body, initiator FROM messages
       WHERE tenant_id = app.tenant_id() AND contact_id = ${c.id} AND status NOT IN ('canceled','blocked') AND length(btrim(body)) > 0
       ORDER BY occurred_at DESC, id DESC LIMIT ${o.messageLimit ?? 30}) m ORDER BY occurred_at, id`.execute(tx);
  const notes = await sql<{ id: string; contact_id: string; created_at: Date; body: string }>`
    SELECT id, contact_id, created_at, body FROM notes WHERE tenant_id = app.tenant_id() AND contact_id = ${c.id}
     ORDER BY created_at DESC LIMIT 10`.execute(tx);
  const deals = await sql<{ id: string; stage: string; side: string; closed_at: Date | null; expected_close_date: string | null }>`
    SELECT DISTINCT d.id, d.stage, d.side, d.closed_at, d.expected_close_date::text AS expected_close_date FROM deals d
      LEFT JOIN deal_contacts dc ON dc.tenant_id = d.tenant_id AND dc.deal_id = d.id
     WHERE d.tenant_id = app.tenant_id() AND (d.primary_contact_id = ${c.id} OR dc.contact_id = ${c.id}) LIMIT 5`.execute(tx);
  const events = await sql<{ id: string; contact_id: string; event_type: string; reliability: 'fact' | 'signal'; occurred_at: Date; listing_id: string | null }>`
    SELECT id, contact_id, event_type, reliability, occurred_at, listing_id FROM behavior_events
     WHERE tenant_id = app.tenant_id() AND contact_id = ${c.id} ORDER BY occurred_at DESC LIMIT 20`.execute(tx);
  const listingIds = [...new Set(events.rows.map((e) => e.listing_id).filter((x): x is string => x !== null))];
  const listings = await sql<{ id: string; address_line1: string; city: string; status: string; list_price_cents: string | null; beds: number | null; baths_x10: number | null; linked: boolean }>`
    SELECT l.id, l.address_line1, l.city, l.status, l.list_price_cents, l.beds, l.baths_x10,
           EXISTS (SELECT 1 FROM listing_contacts lc WHERE lc.tenant_id = l.tenant_id AND lc.listing_id = l.id AND lc.contact_id = ${c.id}) AS linked
      FROM listings l
     WHERE l.tenant_id = app.tenant_id()
       AND (l.id = ANY (${listingIds}::uuid[]) OR EXISTS (SELECT 1 FROM listing_contacts lc WHERE lc.tenant_id = l.tenant_id AND lc.listing_id = l.id AND lc.contact_id = ${c.id}))
     LIMIT 10`.execute(tx);
  const author = (m: { direction: string; initiator: string }) => (m.direction === 'inbound' ? 'client' : m.initiator === 'assistant' ? 'assistant' : m.initiator === 'system' ? 'system' : 'agent');
  return {
    contact: {
      id: c.id as ContactId,
      firstName: c.firstName,
      lastName: c.lastName,
      zone: c.zone,
      stage: c.stage,
      attributes,
      inquiry: inq ? { type: inq.type, sourceName: inq.sourceName, message: inq.message, receivedAt: inq.receivedAt as never, vaLoanIndicated: inq.vaLoanIndicated } : null,
    },
    messages: msgs.rows.map((m) => ({ id: m.id, contactId: m.contact_id, direction: m.direction, channel: m.channel === 'email' ? 'email' : 'sms', at: instantFromDate(m.occurred_at), body: m.body, author: author(m) })),
    calls: (o.calls ?? []).map((x) => ({ id: x.callId, contactId: x.contactId, startedAt: x.startedAt as never, direction: x.direction, segments: x.segments })),
    notes: notes.rows.map((n) => ({ id: n.id, contactId: n.contact_id, at: instantFromDate(n.created_at), body: n.body })),
    deals: deals.rows.map((d) => ({ id: d.id, contactIds: [c.id], stage: d.stage, side: d.side, closingAt: d.closed_at ? instantFromDate(d.closed_at) : d.expected_close_date ? (Date.parse(`${d.expected_close_date}T12:00:00Z`) as never) : null })),
    listings: listings.rows.map((l) => ({ id: l.id, contactIds: l.linked ? [c.id] : [], addressLine1: l.address_line1, city: l.city, status: l.status, listPriceCents: l.list_price_cents === null ? null : Number(l.list_price_cents), beds: l.beds, bathsX10: l.baths_x10 })),
    behaviorEvents: events.rows.map((e) => ({ id: e.id, contactId: e.contact_id, type: e.event_type, reliability: e.reliability, at: instantFromDate(e.occurred_at), listingId: e.listing_id })),
  };
}

/** The requesting agent's own most recent sent messages (tone only; core scrubs them). */
export async function voiceSamples(tx: Tx, userId: string | null): Promise<string[]> {
  if (!userId) return [];
  // Samples are other conversations: the recipient's own name is replaced, so the prompt about one
  // contact never names another (R-AST-14; core.scrubSample drops their numbers, emails and links).
  const r = await sql<{ body: string; first_name: string | null; last_name: string | null }>`
    SELECT m.body, c.first_name, c.last_name
      FROM messages m LEFT JOIN contacts c ON c.tenant_id = m.tenant_id AND c.id = m.contact_id
     WHERE m.tenant_id = app.tenant_id() AND m.direction = 'outbound' AND m.initiator = 'human' AND m.initiated_by_user_id = ${userId}
       AND NOT m.imported AND m.status IN ('sent','delivered') ORDER BY m.occurred_at DESC LIMIT 20`.execute(tx);
  return r.rows.map((x) => redactNames(x.body, [x.first_name, x.last_name]));
}

export async function firstNameOf(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const r = await sql<{ display_name: string | null }>`
    SELECT u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = app.tenant_id() AND m.user_id = ${userId}`.execute(tx);
  const n = r.rows[0]?.display_name?.trim();
  return n ? (n.split(/\s+/)[0] ?? null) : null;
}

/** The identity the assistant speaks for (the same facts dispatch re-checks the content guard with). */
export async function identityFacts(tx: Tx, o: { scope: 'team' | 'agent'; agentUserId: string | null }): Promise<IdentityFacts> {
  const r = await sql<{ brokerage_legal_name: string; team_name: string | null; brokerage_postal_address: string | null }>`
    SELECT brokerage_legal_name, team_name, brokerage_postal_address FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const s = r.rows[0];
  if (!s) throw new Error('tenant settings not visible');
  return {
    brokerageLegalName: s.brokerage_legal_name,
    teamName: s.team_name ?? s.brokerage_legal_name,
    agentFirstName: o.scope === 'agent' ? await firstNameOf(tx, o.agentUserId) : null,
    scope: o.scope,
    allowedLinkHosts: [],
    brokeragePostalAddress: s.brokerage_postal_address,
  };
}

export async function aiEnabled(tx: Tx): Promise<boolean> {
  const r = await sql<{ on: boolean }>`SELECT ai_enabled AS on FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  return r.rows[0]?.on === true;
}
