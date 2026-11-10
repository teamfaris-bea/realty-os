// Serializers for api/leads responses. The card (R-PERM-6) is built from columns a card viewer may
// see; a pond card masks the last name to an initial. Detail (phones, emails, inquiries) is only
// serialized when the caller sees the contact's detail.
import type { OwnershipProjection } from '@realty/core/ownership';
import type { z } from 'zod';
import type { ContactRow, InquiryRow, PointRow } from './repos/contacts.js';
import type { ContactCard, ContactFull, ProjectionView } from './schemas.js';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoMs = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

/** "Jane Doe" → "Jane D."; a single word stays as is; the initial keeps only a letter. */
export function maskLastName(row: Pick<ContactRow, 'first_name' | 'last_name' | 'display_name'>): string {
  const first = row.first_name?.trim();
  const last = row.last_name?.trim();
  if (first) {
    const initial = last ? Array.from(last)[0] : undefined;
    return initial ? `${first} ${initial.toUpperCase()}.` : first;
  }
  const parts = row.display_name.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? row.display_name;
  const lastWord = parts[parts.length - 1]!;
  return `${parts.slice(0, -1).join(' ')} ${Array.from(lastWord)[0]!.toUpperCase()}.`;
}

export function projectionFromCore(p: OwnershipProjection): z.infer<typeof ProjectionView> {
  return {
    state: p.state,
    ownerUserId: p.ownerUserId,
    pondId: p.pondId,
    offerId: p.offerId,
    offeredToUserId: p.offeredToUserId,
    offerExpiresAt: isoMs(p.offerExpiresAt),
    offerRound: p.offerRound,
    ownedAt: isoMs(p.ownedAt),
    firstTouchDueAt: isoMs(p.firstTouchDueAt),
    firstTouchAt: isoMs(p.firstTouchAt),
    firstTouchBreachedAt: isoMs(p.firstTouchBreachedAt),
    releaseDueAt: isoMs(p.releaseDueAt),
    closedReason: p.closedReason,
    seq: p.seq,
  };
}

export function projectionFromRow(r: ContactRow): z.infer<typeof ProjectionView> {
  return {
    state: r.ownership_state,
    ownerUserId: r.owner_user_id,
    pondId: r.pond_id,
    offerId: r.offer_id,
    offeredToUserId: r.offered_to_user_id,
    offerExpiresAt: iso(r.offer_expires_at),
    offerRound: r.offer_round,
    ownedAt: iso(r.owned_at),
    firstTouchDueAt: iso(r.first_touch_due_at),
    firstTouchAt: iso(r.first_touch_at),
    firstTouchBreachedAt: iso(r.first_touch_breached_at),
    releaseDueAt: iso(r.release_due_at),
    closedReason: r.closed_reason,
    seq: Number(r.ownership_seq),
  };
}

function source(r: ContactRow) {
  return r.original_lead_source_id && r.source_name ? { id: r.original_lead_source_id, name: r.source_name, kind: r.source_kind ?? 'other' } : null;
}

export function cardOf(r: ContactRow, o: { masked: boolean }): z.infer<typeof ContactCard> {
  return {
    id: r.id,
    view: 'card',
    displayName: o.masked ? maskLastName(r) : r.display_name,
    intent: r.intent,
    source: source(r),
    createdAt: r.created_at.toISOString(),
    pondSummary: r.pond_summary,
    ownership: {
      state: r.ownership_state,
      pondId: r.pond_id,
      pondName: r.pond_name,
      // the offer id and expiry are the offeree's to act on; others see the state only
      offerId: r.rel_offer ? r.offer_id : null,
      offerExpiresAt: r.rel_offer ? iso(r.offer_expires_at) : null,
      offeredToMe: r.rel_offer,
      seq: Number(r.ownership_seq),
    },
  };
}

function pointView(p: PointRow) {
  return { id: p.id, address: p.address, label: p.label, lineType: p.line_type, status: p.status, isPrimary: p.is_primary };
}

export function fullOf(r: ContactRow, points: readonly PointRow[], inquiries: readonly InquiryRow[]): z.infer<typeof ContactFull> {
  return {
    id: r.id,
    view: 'full',
    displayName: r.display_name,
    firstName: r.first_name,
    lastName: r.last_name,
    intent: r.intent,
    stage: r.stage,
    contactType: r.contact_type,
    timezone: r.timezone,
    tags: r.tags,
    createdAt: r.created_at.toISOString(),
    lastHumanTouchAt: iso(r.last_human_touch_at),
    pondSummary: r.pond_summary,
    source: source(r),
    attribution: {
      leadSourceId: r.original_lead_source_id,
      campaignRef: r.original_campaign_ref,
      adRef: r.original_ad_ref,
      sourceDetail: r.original_source_detail ?? {},
    },
    owner: r.owner_user_id ? { userId: r.owner_user_id, displayName: r.owner_display_name } : null,
    ownership: { ...projectionFromRow(r), pondName: r.pond_name, offeredToMe: r.rel_offer, ownedByMe: r.rel_own },
    phones: points.filter((p) => p.kind === 'phone').map(pointView),
    emails: points.filter((p) => p.kind === 'email').map(pointView),
    inquiries: inquiries.map((i) => ({
      id: i.id,
      receivedAt: i.received_at.toISOString(),
      inquiryType: i.inquiry_type,
      source: i.source_name,
      postalCode: i.postal_code,
      priceMinCents: i.price_min_cents === null ? null : Number(i.price_min_cents),
      priceMaxCents: i.price_max_cents === null ? null : Number(i.price_max_cents),
      campaignRef: i.campaign_ref,
      adRef: i.ad_ref,
      propertyText: i.property_text,
      message: i.message,
      outcome: i.outcome,
    })),
    mergedIntoContactId: r.merged_into_contact_id,
  };
}

/**
 * Opaque keyset cursor: base64url("<timestamptz text>|<uuid>"). The timestamp is Postgres' own text
 * of the column (microsecond precision), so the next page starts exactly after the last row.
 */
export function encodeCursor(atText: string, id: string): string {
  return Buffer.from(`${atText}|${id}`).toString('base64url');
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}[ T][0-9:.]{8,15}(?:[+-]\d{2}(?::?\d{2})?|Z))\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function decodeCursor(c: string | undefined): { at: string; id: string } | null {
  if (!c || c.length > 200) return null;
  const m = CURSOR_RE.exec(Buffer.from(c, 'base64url').toString('utf8'));
  return m ? { at: m[1]!, id: m[2]! } : null;
}
