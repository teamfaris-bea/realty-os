// CRM read API: Owner token management, and the tenant-wide reads a token is allowed to make.
//
// Reads run as the system actor of the token's tenant (tenant-wide under RLS). They do not impersonate
// the Owner, so deal commission stays behind deal.financials, which admits only a human with that grant.
// Each read audits the token, the collection and the count. The secret never enters the audit row.
import { randomBytes } from 'node:crypto';
import type { IdGenerator, UserActor } from '@realty/core/foundation';
import { CONTACT_STAGES } from '@realty/core/ownership';
import type { Database, Tx } from '@realty/db';
import { withTenantTx } from '@realty/db';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import { sha256Token } from './auth.js';
import { type EventCursor, type EventKind, CursorError, decodeEvent, decodePair, encodeEvent, encodePair, eventId, parseEventId } from './cursor.js';
import {
  type AddressRow,
  type DealRow,
  type EventRow,
  type Keyset,
  type PartyRow,
  type PersonRow,
  type PointRow,
  type TagRow,
  type UserRow,
  addressesOf,
  dealPeople,
  dealUsers,
  getDeal,
  getEvent,
  getPerson,
  getUser,
  listDeals,
  listEvents,
  listPeople,
  listUsers,
  pointsOf,
  stageClock,
  tagsOf,
} from './repos/read.js';
import { insertToken, listTokens, revokeToken } from './repos/tokens.js';

type PersonStage = (typeof CONTACT_STAGES)[number];
type DealSide = 'buy' | 'sell' | 'dual' | 'lease';
type MemberRole = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';
type MemberStatus = 'invited' | 'active' | 'suspended' | 'deactivating' | 'removed';

const DEAL_STAGES = ['prospect', 'agreement_signed', 'active', 'under_contract', 'closed', 'lost'] as const;

export interface ReadScope {
  tenantId: string;
  tokenId: string;
}

export interface PageInput {
  limit: number;
  cursor?: string;
  updatedSince?: string;
  type?: EventKind;
  pipeline?: 'people' | 'deals';
}

function mint(): { token: string; prefix: string; hash: Buffer } {
  const token = `ros_${randomBytes(32).toString('base64url')}`;
  return { token, prefix: token.slice(0, 10), hash: sha256Token(token) };
}

function summary(row: { id: string; name: string; prefix: string; created_at: string; revoked_at: string | null }) {
  return { id: row.id, name: row.name, prefix: row.prefix, createdAt: row.created_at, revokedAt: row.revoked_at };
}

export async function createReadToken(actor: UserActor, db: Database, ids: IdGenerator, name: string) {
  const minted = mint();
  const id = ids.next<'CrmReadTokenId'>();
  const row = await withTenantTx(
    actor,
    async (tx) => {
      const inserted = await insertToken(tx, { id, name, hash: minted.hash, prefix: minted.prefix });
      await audit(tx, actor, {
        action: 'crm_read.token_created',
        entity: { type: 'crm_read_token', id },
        changes: redactSnapshot({ id, name, status: 'active' }, { entity: 'crm_read_token' }),
        reason: 'CREATED',
      });
      return inserted;
    },
    { db },
  );
  return { ...summary(row), token: minted.token };
}

export async function listReadTokens(actor: UserActor, db: Database) {
  const rows = await withTenantTx(actor, (tx) => listTokens(tx), { db });
  return { tokens: rows.map(summary) };
}

export async function revokeReadToken(actor: UserActor, db: Database, id: string) {
  const row = await withTenantTx(
    actor,
    async (tx) => {
      const result = await revokeToken(tx, id);
      if (!result.row) return null;
      if (result.changed) {
        await audit(tx, actor, {
          action: 'crm_read.token_revoked',
          entity: { type: 'crm_read_token', id },
          changes: redactSnapshot({ id, status: 'revoked' }, { entity: 'crm_read_token' }),
          reason: 'REVOKED',
        });
      }
      return result.row;
    },
    { db },
  );
  if (!row) throw new AppError('NOT_FOUND');
  return summary(row);
}

function reader(tenantId: string) {
  return systemActor(tenantId, 'worker');
}

function keyset(input: PageInput, mode: 'pair' | 'event'): Keyset {
  let pair: { updatedAt: string; id: string } | null = null;
  let event: EventCursor | null = null;
  if (input.cursor) {
    try {
      if (mode === 'event') event = decodeEvent(input.cursor);
      else pair = decodePair(input.cursor);
    } catch (e) {
      if (e instanceof CursorError) throw new AppError('VALIDATION_FAILED');
      throw e;
    }
  }
  const cursor = event ?? pair;
  return {
    since: input.updatedSince ?? null,
    cursorAt: cursor?.updatedAt ?? null,
    cursorId: cursor?.id ?? null,
    cursorKind: event?.kind ?? null,
    limit: input.limit + 1,
    only: input.type ?? null,
  };
}

function meta(collection: 'people' | 'events' | 'deals' | 'users' | 'stages', limit: number, next: string | null, updatedSince: string | undefined) {
  return { collection, limit, next, updatedSince: updatedSince ?? null };
}

function groupBy<T extends { contact_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.contact_id);
    if (list) list.push(row);
    else out.set(row.contact_id, [row]);
  }
  return out;
}

function toPerson(row: PersonRow, points: Map<string, PointRow[]>, addresses: Map<string, AddressRow[]>, tags: Map<string, TagRow[]>) {
  const mine = points.get(row.id) ?? [];
  const point = (p: PointRow) => ({ value: p.address, type: p.label as 'mobile' | 'home' | 'work' | 'other', status: p.status, isPrimary: p.is_primary });
  return {
    id: row.id,
    created: row.created,
    updated: row.updated,
    name: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    stage: row.stage as PersonStage,
    source: row.source_name,
    sourceId: row.source_id,
    assignedUserId: row.assigned_user_id,
    contacted: row.contacted,
    emails: mine.filter((p) => p.kind === 'email').map(point),
    phones: mine.filter((p) => p.kind === 'phone').map(point),
    addresses: (addresses.get(row.id) ?? []).map((a) => ({
      type: a.kind as 'home' | 'mailing' | 'property' | 'interest',
      street: a.line1,
      street2: a.line2,
      city: a.city,
      state: a.region,
      code: a.postal_code,
      country: a.country,
    })),
    tags: (tags.get(row.id) ?? []).map((t) => t.name),
  };
}

async function loadPeople(tx: Tx, rows: PersonRow[]) {
  const ids = rows.map((r) => r.id);
  const points = groupBy(await pointsOf(tx, ids));
  const addresses = groupBy(await addressesOf(tx, ids));
  const tags = groupBy(await tagsOf(tx, ids));
  return rows.map((r) => toPerson(r, points, addresses, tags));
}

export async function readPeople(db: Database, scope: ReadScope, input: PageInput) {
  const q = keyset(input, 'pair');
  return withTenantTx(
    reader(scope.tenantId),
    async (tx) => {
      const rows = await listPeople(tx, q);
      const more = rows.length > input.limit;
      const page = more ? rows.slice(0, input.limit) : rows;
      const people = await loadPeople(tx, page);
      const last = page[page.length - 1];
      await writeRead(tx, scope, 'people', people.length, input.updatedSince, null);
      return { people, _metadata: meta('people', input.limit, more && last ? encodePair(last.updated, last.id) : null, input.updatedSince) };
    },
    { db },
  );
}

export async function readPerson(db: Database, scope: ReadScope, id: string) {
  return withTenantTx(
    reader(scope.tenantId),
    async (tx) => {
      const row = await getPerson(tx, id);
      await writeRead(tx, scope, 'people', row ? 1 : 0, undefined, id);
      if (!row) return null;
      const [person] = await loadPeople(tx, [row]);
      return person ?? null;
    },
    { db },
  );
}

function toActivity(row: EventRow) {
  return {
    id: eventId(row.kind, row.id),
    type: row.kind,
    created: row.created,
    updated: row.updated,
    occurredAt: row.occurred_at,
    personId: row.person_id,
    userId: row.user_id,
    dealId: row.deal_id,
    direction: row.direction === 'inbound' || row.direction === 'outbound' ? (row.direction as 'inbound' | 'outbound') : null,
    subject: row.subject,
    body: row.body,
    from: row.from_address,
    to: row.to_address,
    phone: row.phone,
    outcome: row.outcome,
    status: row.status,
    appointmentKind: row.appointment_kind,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    durationSeconds: row.duration_s,
    activityKind: row.activity_kind,
  };
}

export async function readEvents(db: Database, scope: ReadScope, input: PageInput) {
  const q = keyset(input, 'event');
  return withTenantTx(
    reader(scope.tenantId),
    async (tx) => {
      const rows = await listEvents(tx, q);
      const more = rows.length > input.limit;
      const page = more ? rows.slice(0, input.limit) : rows;
      const last = page[page.length - 1];
      await writeRead(tx, scope, 'events', page.length, input.updatedSince, null);
      return {
        events: page.map(toActivity),
        _metadata: meta('events', input.limit, more && last ? encodeEvent(last.updated, last.kind, last.id) : null, input.updatedSince),
      };
    },
    { db },
  );
}

export async function readEvent(db: Database, scope: ReadScope, rawId: string) {
  let parsed: { kind: EventKind; id: string };
  try {
    parsed = parseEventId(rawId);
  } catch (e) {
    if (e instanceof CursorError) throw new AppError('VALIDATION_FAILED');
    throw e;
  }
  return withTenantTx(
    reader(scope.tenantId),
    async (tx) => {
      const row = await getEvent(tx, parsed.kind, parsed.id);
      await writeRead(tx, scope, 'events', row ? 1 : 0, undefined, rawId);
      return row ? toActivity(row) : null;
    },
    { db },
  );
}

function dollars(cents: string | null): { price: number | null; priceCents: number | null } {
  if (cents === null) return { price: null, priceCents: null };
  const priceCents = Number(cents);
  return { priceCents, price: priceCents / 100 };
}

function toDeal(row: DealRow, people: PartyRow[], users: PartyRow[]) {
  const linked = people.filter((p) => p.deal_id === row.id);
  const members = users.filter((p) => p.deal_id === row.id && p.id !== row.owner_user_id);
  const seen = new Set(linked.map((p) => p.id));
  const parties = seen.has(row.primary_contact_id) ? linked : [{ deal_id: row.id, id: row.primary_contact_id, role: 'primary' }, ...linked];
  const money = dollars(row.price_cents);
  return {
    id: row.id,
    name: row.name,
    created: row.created,
    updated: row.updated,
    status: row.stage,
    stageId: row.stage,
    side: row.side as DealSide,
    price: money.price,
    priceCents: money.priceCents,
    projectedCloseDate: row.expected_close_date ? row.expected_close_date.slice(0, 10) : null,
    closedAt: row.closed_at,
    people: parties.map((p) => ({ id: p.id, role: p.role })),
    users: [{ id: row.owner_user_id, role: 'owner' }, ...members.map((p) => ({ id: p.id, role: p.role }))],
  };
}

async function loadDeals(tx: Tx, rows: DealRow[]) {
  const ids = rows.map((r) => r.id);
  const people = await dealPeople(tx, ids);
  const users = await dealUsers(tx, ids);
  return rows.map((r) => toDeal(r, people, users));
}

export async function readDeals(db: Database, scope: ReadScope, input: PageInput) {
  const q = keyset(input, 'pair');
  return withTenantTx(
    reader(scope.tenantId),
    async (tx) => {
      const rows = await listDeals(tx, q);
      const more = rows.length > input.limit;
      const page = more ? rows.slice(0, input.limit) : rows;
      const deals = await loadDeals(tx, page);
      const last = page[page.length - 1];
      await writeRead(tx, scope, 'deals', deals.length, input.updatedSince, null);
      return { deals, _metadata: meta('deals', input.limit, more && last ? encodePair(last.updated, last.id) : null, input.updatedSince) };
    },
    { db },
  );
}

export async function readDeal(db: Database, scope: ReadScope, id: string) {
  return withTenantTx(
    reader(scope.tenantId),
    async (tx) => {
      const row = await getDeal(tx, id);
      await writeRead(tx, scope, 'deals', row ? 1 : 0, undefined, id);
      if (!row) return null;
      const [deal] = await loadDeals(tx, [row]);
      return deal ?? null;
    },
    { db },
  );
}

function toAgent(row: UserRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as MemberRole,
    status: row.status as MemberStatus,
    acceptingLeads: row.accepting_leads,
    created: row.created,
    updated: row.updated,
  };
}

export async function readUsers(db: Database, scope: ReadScope, input: PageInput) {
  const q = keyset(input, 'pair');
  return withTenantTx(
    reader(scope.tenantId),
    async (tx) => {
      const rows = await listUsers(tx, q);
      const more = rows.length > input.limit;
      const page = more ? rows.slice(0, input.limit) : rows;
      const last = page[page.length - 1];
      await writeRead(tx, scope, 'users', page.length, input.updatedSince, null);
      return { users: page.map(toAgent), _metadata: meta('users', input.limit, more && last ? encodePair(last.updated, last.id) : null, input.updatedSince) };
    },
    { db },
  );
}

export async function readUser(db: Database, scope: ReadScope, id: string) {
  return withTenantTx(
    reader(scope.tenantId),
    async (tx) => {
      const row = await getUser(tx, id);
      await writeRead(tx, scope, 'users', row ? 1 : 0, undefined, id);
      return row ? toAgent(row) : null;
    },
    { db },
  );
}

function stageName(key: string, labels: Record<string, string>): string {
  return labels[key] ?? key.split('_').map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

export async function readStages(db: Database, scope: ReadScope, input: PageInput) {
  return withTenantTx(
    reader(scope.tenantId),
    async (tx) => {
      const clock = await stageClock(tx);
      const fresh = clock !== null && (input.updatedSince === undefined || Date.parse(clock.updated) >= Date.parse(input.updatedSince));
      const labels = clock?.labels ?? {};
      const updated = clock?.updated ?? '1970-01-01T00:00:00.000000Z';
      const people = CONTACT_STAGES.map((id, i) => ({ id, name: stageName(id, labels), pipeline: 'people' as const, order: i + 1, updated }));
      const deals = DEAL_STAGES.map((id, i) => ({ id, name: stageName(id, {}), pipeline: 'deals' as const, order: i + 1, updated }));
      const stages = (fresh ? [...people, ...deals] : []).filter((s) => input.pipeline === undefined || s.pipeline === input.pipeline);
      await writeRead(tx, scope, 'stages', stages.length, input.updatedSince, null);
      return { stages, _metadata: meta('stages', stages.length, null, input.updatedSince) };
    },
    { db },
  );
}

async function writeRead(tx: Tx, scope: ReadScope, kind: string, count: number, since: string | undefined, resourceId: string | null): Promise<void> {
  await audit(tx, reader(scope.tenantId), {
    action: 'crm_read.read',
    entity: { type: 'crm_read_token', id: scope.tokenId },
    changes: redactSnapshot(
      {
        kind,
        returned_count: count,
        ...(since ? { updated_since_at: since } : {}),
        ...(resourceId ? { resource_id: resourceId } : {}),
      },
      { entity: 'crm_read_token' },
    ),
    reason: 'READ',
  });
}
