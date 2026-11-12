// api/people response shapes (apps/api/src/people/schemas.ts), restated field for field (apps/web does not
// import @realty/api), and the queries the people surfaces share.
import { useQuery } from '@tanstack/react-query';
import { type ApiError, useApi } from '../../shell/index.js';

export interface StageInfo {
  stage: string;
  label: string;
  locked: string[];
  lockedReason: string | null;
}
export interface AddressView {
  id: string;
  kind: string;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string;
}
export interface CollaboratorView {
  userId: string;
  displayName: string | null;
  role: string;
  expiresAt: string | null;
}
export interface RelationshipView {
  id: string;
  kind: string;
  label: string | null;
  direction: 'outgoing' | 'incoming';
  other: { id: string; displayName: string };
  createdAt: string;
}
export interface RemovedPointView {
  id: string;
  kind: 'phone' | 'email';
  tail: string;
  reason: string | null;
  stillBlocks: boolean;
  optedOut: boolean;
  removedAt: string;
}
export interface PointDetail {
  id: string;
  kind: 'phone' | 'email';
  address: string;
  label: string;
  status: string;
  isPrimary: boolean;
  /** the remove route would accept reason wrong_number: the consent ledger holds a wrong-number report for it (R-PAR-12) */
  wrongNumberReported?: boolean;
}
export interface Details {
  contactId: string;
  rowVersion: number;
  doNotContact: boolean;
  stage: StageInfo;
  stageLabels: Record<string, string>;
  addresses: AddressView[];
  collaborators: CollaboratorView[];
  relationships: RelationshipView[];
  removedPoints: RemovedPointView[];
  canEdit: boolean;
  canManageCollaborators: boolean;
}
export interface NoteView {
  id: string;
  contactId: string;
  body: string;
  pinned: boolean;
  source: string;
  author: { userId: string; displayName: string | null } | null;
  createdAt: string;
  editedAt: string | null;
  loggedActivity: { kind: string; direction: string | null; at: string; outcome: string | null; verified: false } | null;
  mentions: { userId: string; displayName: string | null }[];
  canEdit: boolean;
  canDelete: boolean;
  canPin: boolean;
}
export interface MentionOutcome {
  userId: string;
  displayName: string | null;
  status: 'notified' | 'no_access' | 'already_notified';
}
export interface Candidate {
  userId: string;
  displayName: string | null;
  role: string;
  canSee: boolean;
}

export const detailsKey = (id: string) => ['people', 'details', id] as const;
export const notesKey = (id: string) => ['people', 'notes', id] as const;
export const pointsKey = (id: string) => ['people', 'points', id] as const;

/** Everything a page refreshes after an edit of this person. */
export const personKeys = (id: string) => [detailsKey(id), notesKey(id), pointsKey(id), ['contact', id], ['timeline', id], ['contact-timeline', id], ['reachability', id], ['tasks', 'contact', id]];

export function useDetails(contactId: string) {
  const api = useApi();
  return useQuery<{ details: Details }, ApiError>({ queryKey: detailsKey(contactId), queryFn: ({ signal }) => api.get<{ details: Details }>(`/contacts/${contactId}/details`, { signal }) });
}

export function useNotes(contactId: string) {
  const api = useApi();
  return useQuery<{ notes: NoteView[]; nextCursor: string | null; audience: string }, ApiError>({ queryKey: notesKey(contactId), queryFn: ({ signal }) => api.get(`/contacts/${contactId}/notes`, { signal }) });
}

export function useCandidates(contactId: string, enabled: boolean) {
  const api = useApi();
  return useQuery<{ members: Candidate[] }, ApiError>({ queryKey: ['people', 'mention-candidates', contactId], enabled, staleTime: 60_000, queryFn: ({ signal }) => api.get(`/contacts/${contactId}/mention-candidates`, { signal }) });
}

export const STAGE_KEYS = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const;
export const DEFAULT_STAGE_LABEL: Record<string, string> = { new: 'New', attempting: 'Attempting', connected: 'Connected', nurture: 'Nurture', active: 'Active', under_contract: 'Under contract', closed: 'Closed', lost: 'Lost' };
export const stageLabelOf = (key: string, labels: Record<string, string>) => labels[key] ?? DEFAULT_STAGE_LABEL[key] ?? key.replace(/_/g, ' ');

export const RELATIONSHIP_LABEL: Record<string, string> = { spouse_partner: 'Spouse / partner', family: 'Family', household: 'Household', co_buyer: 'Co-buyer', co_seller: 'Co-seller', referred_by: 'Referred by', other: 'Other' };

/** Error sentences for codes the people surfaces show (looked up before the shell's). */
export const PEOPLE_ERROR_MESSAGES: Record<string, string> = {
  STALE_CONTACT: 'Someone else changed this person a moment ago. Your view was refreshed; try again.',
  FIELD_NOT_EDITABLE: 'That field can’t be changed here.',
  // R-PAR-14: owner decision D8 made a reply in the website chat first contact too (R-OWN-14)
  STAGE_NEEDS_CONTACT: 'Reach them first (a call, text, email or reply in their website chat), or close the lead.',
  POINT_EXISTS: 'That number or email is already on this person.',
  POINT_UNCHANGED: 'That is the same number or email.',
  POINT_REMOVED: 'That number or email was already removed.',
  WRONG_NUMBER_NOT_RECORDED: 'Only a number reported as a wrong number (from a call outcome or a reply) can be removed as one.',
  // R-PAR-12: the API answers this for a phone or an email (a "wrong person" reply) removed as a confirmed wrong number
  WRONG_NUMBER_FINAL: 'That number or email was confirmed as reaching someone else (a wrong number), so it can’t be added back to this person.',
  COLLABORATOR_NOT_ELIGIBLE: 'That person can’t be added as a collaborator.',
  RELATIONSHIP_EXISTS: 'These two are already linked that way.',
  MENTION_LIMIT: 'A note can mention at most 10 people.',
  NOTE_READ_ONLY: 'Imported notes and call summaries can’t be changed.',
  NOTE_AUTHOR_ONLY: 'Only the person who wrote this note can change it.',
  ACTIVITY_IN_FUTURE: 'That time is in the future.',
  ACTIVITY_TOO_OLD: 'That is more than a year ago.',
  ACTIVITY_OUT_OF_WINDOW: 'That time is outside what can be logged.',
  OUTCOME_CALLS_ONLY: 'An outcome is only for calls.',
  NO_ADDRESS_TO_REVOKE: 'This person has no phone or email to record that on.',
  // module 57: the Undo of an address delete is honored for 10 minutes
  ADDRESS_RESTORE_EXPIRED: 'It’s too late to undo that: the address was removed more than 10 minutes ago.',
  DUPLICATE_CONTACT: 'This person may already be in Realty OS.',
  PHONE_INVALID: 'That phone number doesn’t look right.',
  EMAIL_INVALID: 'That email doesn’t look right.',
};

export function firstNameOf(name: string): string {
  return name.split(' ')[0] ?? name;
}
