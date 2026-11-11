// Row → response mappers of api/people.
import type { UserActor } from '@realty/core/foundation';
import { maskedTail, mentionTokens, pointCountsForOptOut } from '@realty/core/parity/people';
import type * as repo from './repos/people.js';

export function addressView(a: repo.AddressRow) {
  return { id: a.id, kind: a.kind, line1: a.line1, line2: a.line2, city: a.city, region: a.region, postalCode: a.postal_code, country: a.country };
}

export function collaboratorView(c: repo.CollaboratorRow) {
  return { userId: c.user_id, displayName: c.display_name, role: c.role, expiresAt: c.expires_at ? c.expires_at.toISOString() : null };
}

export function relationshipView(r: repo.RelationshipRow, viewedFrom: string) {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    // referred_by is directional: "outgoing" = this person was referred by the other
    direction: (r.contact_id === viewedFrom ? 'outgoing' : 'incoming') as 'outgoing' | 'incoming',
    other: { id: r.other_id, displayName: r.other_name },
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * A live point. `wrongNumberReported`: the consent ledger holds a wrong-number report for the address (a call
 * outcome or a reply), so POST /contacts/:id/points/:pointId/remove accepts reason wrong_number (R-PAR-12).
 */
export function pointView(p: repo.PointRow) {
  return { id: p.id, kind: p.kind, address: p.address, label: p.label, status: p.status, isPrimary: p.is_primary, wrongNumberReported: p.wrong_number_reported };
}

/** R-PAR-12: a removed point shows only its tail and whether it still blocks the person's other phones. */
export function removedPointView(p: repo.PointRow) {
  const tail = p.kind === 'phone' ? maskedTail(p.address) : `${p.address.slice(0, 1)}•••@${p.address.split('@')[1] ?? ''}`;
  return { id: p.id, kind: p.kind, tail, reason: p.removed_reason, stillBlocks: pointCountsForOptOut({ removed: true, removedReason: p.removed_reason }), optedOut: p.opted_out, removedAt: (p.removed_at ?? new Date(0)).toISOString() };
}

export function noteView(n: repo.NoteRow, actor: UserActor, names: Map<string, string | null>) {
  const mine = n.author_user_id === actor.userId;
  const wide = actor.role === 'owner' || actor.role === 'admin';
  const editable = mine && (n.source === 'manual' || n.source === 'logged_activity');
  const seen = new Set<string>();
  const mentions = [];
  for (const t of mentionTokens(n.body)) {
    if (seen.has(t.userId)) continue;
    seen.add(t.userId);
    mentions.push({ userId: t.userId, displayName: names.get(t.userId) ?? null });
  }
  return {
    id: n.id,
    contactId: n.contact_id!,
    body: n.body,
    pinned: n.pinned,
    source: n.source,
    author: n.author_user_id ? { userId: n.author_user_id, displayName: n.author_name } : null,
    createdAt: n.created_at.toISOString(),
    editedAt: n.edited_at ? n.edited_at.toISOString() : null,
    loggedActivity:
      n.source === 'logged_activity' && n.activity_kind && n.activity_at
        ? { kind: n.activity_kind, direction: n.activity_direction, at: n.activity_at.toISOString(), outcome: n.activity_outcome, verified: false as const }
        : null,
    mentions,
    canEdit: editable,
    canDelete: wide || editable,
    canPin: wide || mine,
  };
}
