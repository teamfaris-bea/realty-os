// Duplicates surface: types (mirroring api/duplicates schemas) and pure helpers (unit-tested).

export interface DupPoint {
  kind: 'phone' | 'email';
  address: string;
  label: string;
}

export interface DupSide {
  id: string;
  displayName: string;
  stage: string;
  ownershipState: string;
  owner: { userId: string; displayName: string | null } | null;
  ownedAt: string | null;
  createdAt: string;
  source: string | null;
  doNotContact: boolean;
  phones: DupPoint[];
  emails: DupPoint[];
  counts: { notes: number; tags: number; fieldValues: number; relationships: number };
}

export type DupOwner =
  | { rule: 'same'; userId: string | null }
  | { rule: 'choose'; preselectedUserId: string; options: { userId: string; displayName: string | null }[] };

export interface DupPair {
  id: string;
  matchReason: string;
  reasonText: string;
  status: 'open' | 'merged' | 'dismissed';
  createdAt: string;
  suggestedSurvivorId: string;
  owner: DupOwner;
  canMerge: boolean;
  a: DupSide;
  b: DupSide;
}

export interface DuplicatesResponse {
  duplicates: DupPair[];
  nextCursor: string | null;
}

export const DUPLICATES_KEY = ['duplicates'] as const;

/** The survivor and the loser for the current choice (default: the suggested survivor). */
export function sidesOf(p: DupPair, survivorId: string = p.suggestedSurvivorId): { keep: DupSide; merge: DupSide } {
  return survivorId === p.b.id ? { keep: p.b, merge: p.a } : { keep: p.a, merge: p.b };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the merge moves from the record that goes away, in plain words (never hides a category). */
export function movesSentence(merge: DupSide): string {
  const parts = [
    merge.counts.notes > 0 ? plural(merge.counts.notes, 'note') : null,
    merge.counts.tags > 0 ? plural(merge.counts.tags, 'tag') : null,
    merge.counts.fieldValues > 0 ? plural(merge.counts.fieldValues, 'custom field') : null,
    merge.counts.relationships > 0 ? plural(merge.counts.relationships, 'relationship') : null,
    merge.phones.length + merge.emails.length > 0 ? plural(merge.phones.length + merge.emails.length, 'phone or email', 'phones and emails') : null,
  ].filter((x): x is string => x !== null);
  const head = parts.length > 0 ? parts.join(', ') : 'its history';
  return `Moves to the kept record: ${head}, plus texts, calls, emails and stage history.`;
}

/** The honest opt-out line: a merge never lifts an opt-out, and the page says so before the tap. */
export function optOutSentence(p: DupPair): string {
  if (p.a.doNotContact || p.b.doNotContact) {
    const who = p.a.doNotContact && p.b.doNotContact ? 'Both records are' : `${p.a.doNotContact ? p.a.displayName : p.b.displayName} is`;
    return `${who} marked "do not contact". The merged person stays do-not-contact.`;
  }
  return 'Every opt-out on either record stays. If either person asked not to be texted or emailed, the merged person won’t be either.';
}

export const STAGE_LABEL: Record<string, string> = {
  new: 'New',
  attempting: 'Attempting',
  connected: 'Connected',
  nurture: 'Nurture',
  active: 'Active',
  under_contract: 'Under contract',
  closed: 'Closed',
  lost: 'Lost',
};

export const DUPLICATE_DECIDED_TEXT = 'Someone already decided this one. The list is up to date now.';

export const DUPLICATES_MESSAGES: Record<string, string> = {
  DUPLICATE_ALREADY_DECIDED: DUPLICATE_DECIDED_TEXT,
  MERGE_OWNER_REQUIRED: 'These two belong to different agents. Choose who keeps the merged person.',
  CONTACT_MERGED: 'One of these was already merged. The list is up to date now.',
  LEAD_STATE_CHANGED: 'One of these people changed just now. Check the details and try again.',
  NOT_FOUND: 'You no longer have access to one of these people.',
};
