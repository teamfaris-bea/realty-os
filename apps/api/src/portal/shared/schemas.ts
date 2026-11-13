// Zod schemas of every portal route (R-PORTAL-8, R-PORTAL-16). webContract.ts generates webContract.json from these
// very objects, so modules 46 and 55 are checked against what the routes validate and serialize with. Clients only
// ever see portal ids (grant, item) and their own account's status.
import { z } from 'zod';

const iso = z.iso.datetime({ offset: true });
/** a grant title: 1-120 characters, no control character (portal_grants_display_shape refuses them too) */
const Title = z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]*$/u);
const date = z.iso.date();
export const Uuid = z.uuid();

// ---- sign-in (pre-session) ----------------------------------------------------------------------------------------
export const TEAM_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
export const LoginBody = z.strictObject({
  team: z.string().trim().regex(TEAM_RE),
  address: z.string().trim().min(3).max(320),
});
export const LoginAccepted = z.strictObject({ status: z.literal('sent_if_matched'), message: z.string() });
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const SessionBody = z.strictObject({ token: z.string().regex(LINK_TOKEN_RE) });
export const SessionResponse = z.strictObject({ csrfToken: z.string(), idleExpiresAt: iso, absoluteExpiresAt: iso });

// ---- client (a portal session) ------------------------------------------------------------------------------------
export const Contact = z.strictObject({ agentName: z.string().nullable(), textTo: z.string().nullable(), emailTo: z.string().nullable() });
export const Grant = z.strictObject({
  id: Uuid,
  scope: z.enum(['purchase', 'sale', 'listing']).nullable(),
  title: z.string(),
  contact: Contact.nullable(),
  expiresOn: date.nullable(),
});
export const MeResponse = z.strictObject({
  account: z.strictObject({ status: z.literal('active') }),
  csrfToken: z.string(),
  session: z.strictObject({ idleHours: z.number().int(), absoluteDays: z.number().int() }),
  grants: z.array(Grant),
});
export const GrantQuery = z.strictObject({ grantId: z.string().max(64) });
export const Item = z.strictObject({
  itemId: Uuid,
  kind: z.enum(['milestone', 'showing', 'feedback', 'seller_update', 'next_step']),
  title: z.string(),
  body: z.string().nullable(),
  occursOn: date.nullable(),
  publishedAt: iso,
});
export const TimelineResponse = z.strictObject({ grantId: Uuid, items: z.array(Item), nextSteps: z.array(Item) });
export const DocumentItem = z.strictObject({ itemId: Uuid, title: z.string(), body: z.string().nullable(), publishedAt: iso });
export const DocumentsResponse = z.strictObject({ grantId: Uuid, documents: z.array(DocumentItem) });
export const ItemParams = z.strictObject({ itemId: z.string().max(64) });
export const StreamTokenResponse = z.strictObject({ url: z.string(), expiresAt: iso, fileName: z.string(), contentType: z.string(), byteSize: z.number().int().nonnegative() });
export const FileParams = z.strictObject({ token: z.string().max(128) });

// ---- staff (the /api staff guard) ---------------------------------------------------------------------------------
export const IdParams = z.strictObject({ id: Uuid });
export const InviteBody = z.strictObject({
  contactId: Uuid,
  loginPointId: Uuid.optional(),
  title: Title.optional(),
  resend: z.boolean().optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});
export const Decision = z.strictObject({ outcome: z.string(), reasons: z.array(z.string()), explanation: z.string() });
export const Notice = z.strictObject({ sent: z.boolean(), text: z.string(), channel: z.enum(['sms', 'email']).nullable(), decision: Decision.nullable() });
export const AccountStaff = z.strictObject({
  id: Uuid,
  contactId: Uuid,
  status: z.enum(['invited', 'active', 'disabled']),
  statusText: z.string(),
  loginPoint: z.strictObject({ id: Uuid, kind: z.enum(['email', 'phone']), hint: z.string(), status: z.string(), usable: z.boolean() }).nullable(),
  signInImpossible: z.string().nullable(),
  disabledReason: z.string().nullable(),
});
export const GrantStaff = z.strictObject({
  id: Uuid,
  accountId: Uuid,
  state: z.enum(['live', 'revoked', 'lapsed', 'not_a_party', 'account_disabled']),
  stateText: z.string(),
  grantedAt: iso,
  expiresAt: iso.nullable(),
  revokedAt: iso.nullable(),
  revokedBy: z.string().nullable(),
  view: Grant,
});
export const ItemStaff = z.strictObject({
  id: Uuid,
  grantId: Uuid,
  kind: z.enum(['milestone', 'document', 'showing', 'feedback', 'seller_update', 'next_step']),
  title: z.string(),
  occursOn: date.nullable(),
  publishedAt: iso,
  publishedBy: z.string(),
  retractedAt: iso.nullable(),
  retractedBy: z.string().nullable(),
  note: z.string().nullable(),
});
export const ChannelsStaff = z.strictObject({ email: z.enum(['real', 'test', 'off']), sms: z.enum(['real', 'test', 'off']), text: z.array(z.string()) });
export const PortalStateResponse = z.strictObject({
  portalCleared: z.boolean(),
  portalText: z.string().nullable(),
  channels: ChannelsStaff,
  accounts: z.array(AccountStaff),
  grants: z.array(GrantStaff),
  items: z.array(ItemStaff),
});
export const InviteResponse = z.strictObject({ account: AccountStaff, grant: GrantStaff, created: z.strictObject({ account: z.boolean(), grant: z.boolean() }), notice: Notice });
export const PreviewResponse = z.strictObject({
  visibleNow: z.boolean(),
  why: z.array(z.string()),
  grant: Grant,
  timeline: z.strictObject({ items: z.array(Item), nextSteps: z.array(Item) }),
  documents: z.array(DocumentItem),
});
export const PORTAL_KINDS = ['milestone', 'document', 'showing', 'feedback', 'seller_update', 'next_step'] as const;
export const ItemPreviewBody = z.strictObject({ grantId: Uuid, kind: z.enum(PORTAL_KINDS), sourceId: Uuid });
export const ItemPreviewResponse = z.strictObject({
  publishable: z.boolean(),
  code: z.string().nullable(),
  text: z.string().nullable(),
  item: z.strictObject({ kind: z.string(), title: z.string(), body: z.string().nullable(), occursOn: date.nullable() }).nullable(),
});
export const PublishBody = z.strictObject({ kind: z.enum(PORTAL_KINDS), sourceId: Uuid, grantIds: z.array(Uuid).min(1).max(10) });
export const PublishResponse = z.strictObject({
  results: z.array(z.strictObject({ grantId: Uuid, result: z.string(), itemId: Uuid.nullable(), text: z.string().nullable() })),
});
export const DisableBody = z.strictObject({ reason: z.enum(['CLIENT_ASKED', 'WRONG_PERSON', 'NO_LONGER_A_CLIENT']) });
export const LoginPointBody = z.strictObject({ pointId: Uuid });
export const DisplayBody = z.strictObject({ title: Title });
export const OkResponse = z.strictObject({ ok: z.literal(true), text: z.string().nullable() });
