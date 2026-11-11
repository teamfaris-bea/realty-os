// Bulk action API shapes (parity module 63) and the plain words for every skip reason (module 64).
export type BulkKind = 'tag' | 'untag' | 'stage' | 'assign' | 'enroll' | 'email' | 'text';
export type BulkStatus = 'draft' | 'confirmed' | 'running' | 'completed' | 'canceled' | 'failed';

export interface BulkCounts {
  selected: number;
  done: number;
  skipped: number;
  blocked: number;
  failed: number;
  canceled: number;
  pending: number;
  byReason: Record<string, number>;
}

export interface BulkActionView {
  id: string;
  kind: BulkKind;
  status: BulkStatus;
  mine: boolean;
  selected: number;
  targetCount: number;
  preflight: Record<string, number>;
  sharedAddresses: number;
  counts: BulkCounts;
  templateId: string | null;
  templateVersion: number | null;
  subject: string | null;
  body: string | null;
  failureCode: string | null;
  createdAt: string;
  confirmedAt: string | null;
  finishedAt: string | null;
}

export const BULK_KEY = ['bulk-actions'] as const;

/** What the confirm button and the result say for each kind. */
export const KIND_WORDS: Record<BulkKind, { verb: string; done: string; noun: string }> = {
  tag: { verb: 'Tag', done: 'Tagged', noun: 'tag' },
  untag: { verb: 'Remove tag from', done: 'Untagged', noun: 'tag removal' },
  stage: { verb: 'Move', done: 'Moved', noun: 'stage change' },
  assign: { verb: 'Assign', done: 'Assigned', noun: 'assignment' },
  enroll: { verb: 'Enroll', done: 'Enrolled', noun: 'enrollment' },
  email: { verb: 'Email', done: 'Emailed', noun: 'email' },
  text: { verb: 'Text', done: 'Texted', noun: 'text' },
};

/** Every skip reason, in words a person reads after a count ("9 opted out"). Unknown codes say so honestly. */
export const REASON_WORDS: Record<string, string> = {
  NOT_VISIBLE: "aren't yours to reach",
  MERGED: 'were merged into someone else',
  DELETED: 'were deleted',
  NOT_PERMITTED: "aren't allowed for your role",
  NO_ADDRESS: 'have no address for this',
  SHARED_ADDRESS: 'share an address with someone already included (one message per address)',
  RECIPIENT_OPTED_OUT: 'opted out',
  RECIPIENT_SUPPRESSED: 'bounced or complained',
  PERSON_DO_NOT_CONTACT: 'asked not to be contacted',
  RECENT_INBOUND: 'wrote in the last 24 hours (answer them one to one)',
  MERGE_FIELD_EMPTY: 'are missing a value the template needs',
  ALREADY_TAGGED: 'already have the tag',
  NOT_TAGGED: "don't have the tag",
  TAG_LIMIT: 'already have 100 tags',
  ALREADY_IN_STAGE: 'are already in that stage',
  STAGE_NEEDS_CONTACT: "haven't been reached yet (call or text them first)",
  ALREADY_OWNER: 'are already theirs',
  ALREADY_ENROLLED: 'are already in a plan',
  UNREACHABLE: "can't be reached by text or email",
  CLIENT_REPLIED: 'replied before it was sent',
  BATCH_TEXT_DISABLED: 'were stopped when batch text was turned off',
  CANCELED: 'were canceled',
  CREATOR_INACTIVE: 'were stopped (the sender is no longer active)',
  SEND_BLOCKED: 'were blocked when sending',
  TARGET_NOT_ELIGIBLE: "can't be assigned to that person",
};

export function reasonWords(code: string): string {
  return REASON_WORDS[code] ?? `were left out (${code.toLowerCase().replace(/_/g, ' ')})`;
}

export const BULK_ERROR_MESSAGES: Record<string, string> = {
  BULK_EMPTY: 'Select at least one person.',
  BULK_TOO_LARGE: 'That is more people than one bulk action can take. Narrow the list.',
  BULK_DAILY_EMAIL_CAP: "The team's bulk email limit for today is used up. Try again tomorrow.",
  BULK_NOT_PERMITTED: "Your role can't run this bulk action.",
  BULK_PARAMS_INVALID: 'Choose what to apply first.',
  BULK_NOT_DRAFT: 'This action was already confirmed or canceled.',
  BULK_NOT_LIVE: 'This action already finished.',
  BULK_NOTHING_TO_DO: 'Everyone selected is left out, so there is nothing to send.',
  BULK_CONFIRM_ROLE_CHANGED: 'Your role changed since you started. Start the action again.',
  AUDIENCE_PROTECTED_PROXY: "This group was picked with a protected tag (a fair-housing safeguard), so it can't get bulk messages or plans.",
  TAG_PROTECTED: "This tag is protected (a fair-housing safeguard), so it can't be added or removed in bulk.",
  BATCH_TEXT_DISABLED: 'Batch text is off. Only the Owner can turn it on, in Settings.',
  EMAIL_DOMAIN_UNVERIFIED: 'Bulk email needs a verified sending domain. Ask an Admin.',
  POSTAL_ADDRESS_MISSING: "Bulk email needs the brokerage's postal address. Ask the Owner.",
  BROKERAGE_IDENTITY_MISSING: "Bulk messages need the brokerage's name. Ask the Owner.",
  SMS_MARKETING_NOT_REGISTERED: 'Batch text needs a texting registration approved for marketing.',
  TEMPLATE_CHANNEL_MISMATCH: 'Pick a template for this kind of message.',
  LIST_TOO_SLOW: 'This list took too long to load. Narrow it with another filter and try again.',
};
