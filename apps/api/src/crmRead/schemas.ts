// Response and query schemas for the CRM read API (WP3a).
//
// Every field a client can receive is named here. Objects are strict, so a column that is not listed
// (a hash, a tenant id, a fair-housing attribute, a recording) cannot ride along on the response.
// There is no record/passthrough/catchall. Timestamps are text the server formatted; the query clock
// `updatedSince` is an ISO-8601 instant with an offset.
import { CONTACT_STAGES } from '@realty/core/ownership';
import { z } from 'zod';

const uuid = z.uuid();
const stamp = z.string();
const UPDATED_SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export const UpdatedSince = z.string().regex(UPDATED_SINCE).refine((s) => !Number.isNaN(Date.parse(s)), { message: 'instant' });

const limit = z.coerce.number().int().min(1).max(100).default(100);
const cursor = z.string().min(8).max(300).optional();

export const PageQuery = z.strictObject({
  limit,
  cursor,
  updatedSince: UpdatedSince.optional(),
});

export const EventQuery = z.strictObject({
  limit,
  cursor,
  updatedSince: UpdatedSince.optional(),
  type: z.enum(['call', 'text', 'email', 'note', 'appointment']).optional(),
});

export const StageQuery = z.strictObject({
  updatedSince: UpdatedSince.optional(),
  pipeline: z.enum(['people', 'deals']).optional(),
});

const Meta = z.strictObject({
  collection: z.enum(['people', 'events', 'deals', 'users', 'stages']),
  limit: z.number().int(),
  next: z.string().nullable(),
  updatedSince: z.string().nullable(),
});

const Point = z.strictObject({
  value: z.string(),
  type: z.enum(['mobile', 'home', 'work', 'other']),
  status: z.string(),
  isPrimary: z.boolean(),
});

const Address = z.strictObject({
  type: z.enum(['home', 'mailing', 'property', 'interest']),
  street: z.string().nullable(),
  street2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  code: z.string().nullable(),
  country: z.string(),
});

/** One person, in the shape a Follow Up Boss people sync reads: identity, stage, source, assignee, points. */
export const Person = z.strictObject({
  id: uuid,
  created: stamp,
  updated: stamp,
  name: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  stage: z.enum(CONTACT_STAGES),
  source: z.string().nullable(),
  sourceId: uuid.nullable(),
  assignedUserId: uuid.nullable(),
  contacted: z.boolean(),
  emails: z.array(Point),
  phones: z.array(Point),
  addresses: z.array(Address),
  tags: z.array(z.string()),
});

/** One activity. Unused columns of a kind are null, and they are still named. */
export const Activity = z.strictObject({
  id: z.string(),
  type: z.enum(['call', 'text', 'email', 'note', 'appointment']),
  created: stamp,
  updated: stamp,
  occurredAt: stamp,
  personId: uuid.nullable(),
  userId: uuid.nullable(),
  dealId: uuid.nullable(),
  direction: z.enum(['inbound', 'outbound']).nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  phone: z.string().nullable(),
  outcome: z.string().nullable(),
  status: z.string().nullable(),
  appointmentKind: z.string().nullable(),
  startsAt: stamp.nullable(),
  endsAt: stamp.nullable(),
  location: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  activityKind: z.string().nullable(),
});

const Party = z.strictObject({ id: uuid, role: z.string() });

/** A deal. Price is dollars (Follow Up Boss) and cents (the stored value). Commission is not on this API. */
export const Deal = z.strictObject({
  id: uuid,
  name: z.string(),
  created: stamp,
  updated: stamp,
  status: z.string(),
  stageId: z.string(),
  side: z.enum(['buy', 'sell', 'dual', 'lease']),
  price: z.number().nullable(),
  priceCents: z.number().int().nullable(),
  projectedCloseDate: z.string().nullable(),
  closedAt: stamp.nullable(),
  people: z.array(Party),
  users: z.array(Party),
});

export const Agent = z.strictObject({
  id: uuid,
  name: z.string(),
  email: z.string(),
  role: z.enum(['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc']),
  status: z.enum(['invited', 'active', 'suspended', 'deactivating', 'removed']),
  acceptingLeads: z.boolean(),
  created: stamp,
  updated: stamp,
});

export const Stage = z.strictObject({
  id: z.string(),
  name: z.string(),
  pipeline: z.enum(['people', 'deals']),
  order: z.number().int(),
  updated: stamp,
});

export const PeoplePage = z.strictObject({ people: z.array(Person), _metadata: Meta });
export const EventsPage = z.strictObject({ events: z.array(Activity), _metadata: Meta });
export const DealsPage = z.strictObject({ deals: z.array(Deal), _metadata: Meta });
export const UsersPage = z.strictObject({ users: z.array(Agent), _metadata: Meta });
export const StagesPage = z.strictObject({ stages: z.array(Stage), _metadata: Meta });

export const IdParams = z.strictObject({ id: uuid });
export const EventIdParams = z.strictObject({ id: z.string().min(10).max(80) });

const hasControl = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 31 || c === 127) return true;
  }
  return false;
};

export const CreateTokenBody = z.strictObject({
  name: z.string().trim().min(1).max(80).refine((s) => !hasControl(s), { message: 'control' }),
});

export const TokenParams = z.strictObject({ id: uuid });

/** What an Owner sees again. The secret is not here. */
export const TokenSummary = z.strictObject({
  id: uuid,
  name: z.string(),
  prefix: z.string(),
  createdAt: stamp,
  revokedAt: stamp.nullable(),
});

/** Shown once, on create. The secret is this object and nowhere else. */
export const CreatedToken = z.strictObject({
  id: uuid,
  name: z.string(),
  prefix: z.string(),
  createdAt: stamp,
  revokedAt: stamp.nullable(),
  token: z.string(),
});
export const TokenList = z.strictObject({ tokens: z.array(TokenSummary) });

export const CRM_RESPONSE_SCHEMAS = {
  Person,
  Activity,
  Deal,
  Agent,
  Stage,
  PeoplePage,
  EventsPage,
  DealsPage,
  UsersPage,
  StagesPage,
  CreatedToken,
  TokenList,
} as const;
