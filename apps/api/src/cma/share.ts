// Sharing a CMA (module 71, D9 V2-A; R-CMA-9, R-CMA-7, R-CMA-8, D1, R-GATE-14, R-FH-1; E376, E600-E614, E618).
//
//   previewShare  GET /cma/:id/share-preview: the exact report, the recipient's D1 decision (comms' preview, never
//                 stored) and every blocker, in words. Read only.
//   shareCma      POST /cma/:id/share: one human tap. (1) comms' preview: a deny is CMA_RECIPIENT_BLOCKED, nothing
//                 stored. (2) One transaction as the person: the row locked, cma.share re-authorized on fresh facts,
//                 every check again (readiness, the content and report hashes, the sales and the MLS data date, the
//                 disclosure, fair housing, the statements and the length), then the human email (comms
//                 createHumanEmailInTx, its dispatch job in the same transaction) and the freeze, one UPDATE the S0
//                 guard stamps; audited with ids only. (3) After commit, dispatchOutbound as the person: the send-time
//                 gate decides (D1); a blocked send leaves the CMA shared, as the person approved it.
//
// Only the creator previews or shares (owner question g): anyone else is 404. Only the CMA's contact, or a co_seller or
// spouse_partner relation the sharer sees and may message (comms.send), at one of their email points, receives it
// (owner question b). A research CMA or one whose subject is a listing is never shared (owner question k).
import type { ResourceFacts, UserActor } from '@realty/core/foundation';
import { can } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import {
  type CommsDeps,
  type DecisionView,
  type DisplayListing,
  createHumanEmailInTx,
  dispatchOutbound,
  fairHousingCheck,
  fairHousingPack,
  feedStale,
  identityOf,
  previewHumanMessage,
  saleOfRow,
  valuationStatement,
} from './deps.js';
import { type Blocker, ESTIMATE_SENTENCE, asOfSentence, clientSale, compListingIds, readinessConnectionIds } from './gates.js';
import { REPORT_MAX_EMAIL_CHARS, type Report, type ReportComp, type ReportWarning, buildReport, emailText, longestParts, refusalFor, reportSha256 } from './report.js';
import { type CmaRow, getCma, listingRows } from './repos.js';
import { type CmaView, type DisclosureField, type Readiness, type StoredResult, type StoredSubject, assertContact, disclosureMissing, getView, listingOf, readinessOf, zoneOf } from './service.js';

/** The relationship kinds that may receive a CMA besides its own contact (owner question b). */
export const SHARE_RELATIONSHIPS = ['co_seller', 'spouse_partner'] as const;
type Relationship = 'self' | (typeof SHARE_RELATIONSHIPS)[number];

export interface RecipientEmail {
  id: string;
  address: string;
  status: string;
}
export interface Recipient {
  contactId: string;
  name: string;
  firstName: string;
  relationship: Relationship;
  emails: RecipientEmail[];
}

// ---- reads ---------------------------------------------------------------------------------------------

/** The caller's relation to a contact whose detail they see and which is live (null: invisible or merged away). */
async function liveContactFacts(tx: Tx, contactId: string): Promise<(ResourceFacts & { name: string; firstName: string }) | null> {
  const r = await sql<{ own: boolean; collab: boolean; team: boolean; deal: boolean; display_name: string; first_name: string | null }>`
    SELECT COALESCE(c.owner_user_id = app.user_id(), false) AS own, c.id = ANY (app.my_collab_contact_ids()) AS collab,
           COALESCE(c.owner_user_id = ANY (app.my_team_member_ids()), false) AS team, c.id = ANY (app.my_deal_contact_ids()) AS deal,
           c.display_name, c.first_name
      FROM contacts c
     WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}::uuid AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
       AND app.contact_detail_visible(c.tenant_id, c.id)`.execute(tx);
  const f = r.rows[0];
  if (!f) return null;
  const first = (f.first_name ?? '').trim() || f.display_name.trim().split(/\s+/)[0] || f.display_name;
  return { own: f.own === true, collaborator: f.collab === true, team: f.team === true, deal: f.deal === true, name: f.display_name, firstName: first };
}

async function emailsOf(tx: Tx, contactId: string): Promise<RecipientEmail[]> {
  return (
    await sql<RecipientEmail>`SELECT id, address, status FROM contact_points
      WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND kind = 'email' AND removed_at IS NULL AND status <> 'removed'
      ORDER BY (status = 'active') DESC, is_primary DESC, created_at, id`.execute(tx)
  ).rows;
}

/** The co_seller and spouse_partner relations of a contact, either direction (RLS decides which rows the caller reads). */
async function relationsOf(tx: Tx, contactId: string): Promise<{ contactId: string; kind: string }[]> {
  return (
    await sql<{ contactId: string; kind: string }>`
      SELECT related_contact_id AS "contactId", kind FROM contact_relationships WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid
      UNION
      SELECT contact_id AS "contactId", kind FROM contact_relationships WHERE tenant_id = app.tenant_id() AND related_contact_id = ${contactId}::uuid
      ORDER BY 1, 2`.execute(tx)
  ).rows;
}

/** Whether the caller may send to the contact (comms.send on its facts; dispatch checks the same at send time). */
function maySend(actor: UserActor, f: ResourceFacts): boolean {
  return can(actor, 'comms.send', { tenantId: actor.tenantId, ...f }).ok;
}

/** Everyone who may receive this CMA from the caller (owner question b), the CMA's contact first. */
export async function recipientsOf(tx: Tx, actor: UserActor, contactId: string): Promise<Recipient[]> {
  const out: Recipient[] = [];
  const self = await liveContactFacts(tx, contactId);
  if (self !== null && maySend(actor, self)) out.push({ contactId, name: self.name, firstName: self.firstName, relationship: 'self', emails: await emailsOf(tx, contactId) });
  const seen = new Set([contactId]);
  for (const rel of await relationsOf(tx, contactId)) {
    if (!(SHARE_RELATIONSHIPS as readonly string[]).includes(rel.kind) || seen.has(rel.contactId)) continue;
    const f = await liveContactFacts(tx, rel.contactId);
    if (f === null || !maySend(actor, f)) continue;
    seen.add(rel.contactId);
    out.push({ contactId: rel.contactId, name: f.name, firstName: f.firstName, relationship: rel.kind as Relationship, emails: await emailsOf(tx, rel.contactId) });
  }
  return out;
}

/**
 * The share's recipient rules (E613, E618, R-PERM-5): a contact the caller cannot see, or may not message, is 404; a
 * visible one that is neither the CMA's contact nor its co_seller / spouse_partner, or a point that is not one of the
 * recipient's email addresses, is VALIDATION_FAILED.
 */
async function recipientFor(tx: Tx, actor: UserActor, cmaContactId: string, recipientContactId: string, toPointId: string): Promise<{ recipient: Recipient; point: RecipientEmail }> {
  const f = await liveContactFacts(tx, recipientContactId);
  if (f === null || !maySend(actor, f)) throw new AppError('NOT_FOUND');
  let relationship: Relationship = 'self';
  if (recipientContactId !== cmaContactId) {
    const rel = (await relationsOf(tx, cmaContactId)).find((r) => r.contactId === recipientContactId && (SHARE_RELATIONSHIPS as readonly string[]).includes(r.kind));
    if (!rel) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/recipientContactId', code: 'not_a_share_relation' }] });
    relationship = rel.kind as Relationship;
  }
  const emails = await emailsOf(tx, recipientContactId);
  const point = emails.find((p) => p.id === toPointId);
  if (!point) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/toPointId', code: 'not_an_email_of_recipient' }] });
  return { recipient: { contactId: recipientContactId, name: f.name, firstName: f.firstName, relationship, emails }, point };
}

async function agentName(tx: Tx, userId: string): Promise<string> {
  const r = await sql<{ n: string }>`SELECT u.display_name AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = app.tenant_id() AND m.user_id = ${userId}::uuid`.execute(tx);
  return r.rows[0]?.n?.trim() || 'Your agent';
}

// ---- the report of a stored CMA -------------------------------------------------------------------------

export type StaleReason = 'DATA_OLD' | 'SALE_CHANGED';

export interface BuiltReport {
  /** null when there is no value (readiness says NO_VALUE) */
  report: Report | null;
  /** the stored MLS data date or a comp's sale no longer matches the live data (E602a, E602c) */
  stale: StaleReason | null;
  connectionIds: string[];
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/**
 * The client report of a stored CMA as it renders for clients now (report.ts), and the stale checks: a comp's live
 * close price, close date, beds, baths or size differing from the stored sale (SALE_CHANGED), or the stored MLS data
 * date outside the freshness window of a connection in the set (DATA_OLD). Under the caller's RLS.
 */
export async function reportOf(tx: Tx, now: number, row: CmaRow, rd: Readiness): Promise<BuiltReport> {
  const s = row.subject as unknown as StoredSubject;
  const r = row.result as unknown as StoredResult;
  const e = rd.input.conns.e;
  const rows = await listingRows(tx, compListingIds(rd.input));
  const byId = new Map(rows.map((x) => [x.id, x]));
  const connectionIds = readinessConnectionIds(rd.input, rows);
  let stale: StaleReason | null = null;
  const comps: ReportComp[] = [];
  for (const c of r.comps) {
    const l = listingOf(r, c.ref.identity);
    const sale = byId.get(l.saleListingId);
    const team = l.teamListingId === null ? undefined : byId.get(l.teamListingId);
    if (sale !== undefined) {
      const live = saleOfRow(sale, team ?? null);
      if (!(same(live.closePriceCents, c.sale.closePriceCents) && same(live.closeDate, c.sale.closeDate) && same(live.beds, c.sale.beds) && same(live.bathsX10, c.sale.bathsX10) && same(live.sqft, c.sale.sqft))) stale = 'SALE_CHANGED';
    }
    const rendering: DisplayListing | null = clientSale(e, sale, team);
    if (rendering !== null) comps.push({ rendering, distanceM: c.distanceM, tier: c.tier, adjustedPriceCents: c.adjustedPriceCents, adjustments: c.adjustments.map((a) => ({ feature: a.feature, amountCents: a.amountCents })) });
  }
  const conns = connectionIds.map((id) => e.connections.find((x) => x.id === id)).filter((x) => x !== undefined);
  const asOf = row.mls_data_as_of === null ? null : row.mls_data_as_of.getTime();
  if (stale === null && conns.some((c) => feedStale(asOf as never, now as never, c.pack))) stale = 'DATA_OLD';
  if (row.low_cents === null || row.high_cents === null) return { report: null, stale, connectionIds };
  const statements = conns.flatMap((c) => valuationStatement(c.pack, s.resolved.state) ?? []);
  const a = s.resolved.address;
  const identity = await identityOf(tx);
  const report = buildReport({
    subjectAddress: [[a.line1, a.line2].filter(Boolean).join(' '), a.city].filter((x) => x).join(', ') || [a.region, a.postalCode].filter(Boolean).join(' '),
    lowCents: Number(row.low_cents),
    highCents: Number(row.high_cents),
    estimateSentence: ESTIMATE_SENTENCE,
    agentName: await agentName(tx, row.created_by_user_id),
    brokerageName: identity.brokerageLegalName || identity.teamName,
    statements,
    attributions: conns.flatMap((c) => c.pack.attributionText ?? []),
    disclaimers: conns.flatMap((c) => c.pack.disclaimerText ?? []),
    asOfSentence: asOfSentence(row.mls_data_as_of, await zoneOf(tx)),
    comps,
    purpose: row.purpose,
    inspection: row.inspection,
    inspectedOn: row.inspected_on,
    disclosure: { intendedUsers: row.intended_users, agentInterest: row.agent_interest, conflicts: row.conflicts, valueDefinition: row.value_definition, limitingConditions: row.limiting_conditions },
    notes: row.agent_notes,
  });
  return { report, stale, connectionIds };
}

// ---- fair housing on the agent's own text (R-FH-1, E608) ------------------------------------------------

export interface FairHousingMatch {
  termId: string;
  label: string;
  where: 'notes' | DisclosureField;
}

/** The fair-housing check of the agent's text that the report carries: the notes, and the SoP items for 'other'. */
async function fairHousingOf(tx: Tx, row: CmaRow): Promise<{ hard: FairHousingMatch[]; soft: FairHousingMatch[] }> {
  const pack = await fairHousingPack(tx, (await identityOf(tx)).jurisdictions); // fails closed (FAIR_HOUSING_PACK_UNAVAILABLE)
  const texts: [FairHousingMatch['where'], string | null][] = [['notes', row.agent_notes]];
  if (row.purpose === 'other') {
    texts.push(['intendedUsers', row.intended_users], ['agentInterest', row.agent_interest], ['conflicts', row.conflicts], ['valueDefinition', row.value_definition], ['limitingConditions', row.limiting_conditions]);
  }
  const hard: FairHousingMatch[] = [];
  const soft: FairHousingMatch[] = [];
  for (const [where, text] of texts) {
    if (text === null || text.trim() === '') continue;
    const r = fairHousingCheck(text, pack);
    for (const m of r.hard) hard.push({ termId: m.termId, label: m.label, where });
    for (const m of r.soft) soft.push({ termId: m.termId, label: m.label, where });
  }
  return { hard, soft };
}

// ---- the preview (GET /cma/:id/share-preview) ------------------------------------------------------------

export interface PreviewQuery {
  recipientContactId?: string | undefined;
  toPointId?: string | undefined;
}

export interface SharePreview {
  cmaId: string;
  contentSha256: string;
  reportSha256: string | null;
  subject: string | null;
  reportText: string | null;
  /** the email exactly as comms renders it (signature, footer, "(unsubscribe link)" when marketing) */
  body: string | null;
  recipients: Recipient[];
  recipientContactId: string | null;
  toPointId: string | null;
  /** the send-time check's answer now (D1; never stored), null without an email address */
  decision: DecisionView | null;
  warnings: ReportWarning[];
  statement: { ok: boolean; part: string | null; reason: string | null; codePoints: string[] };
  tooLong: { parts: ReturnType<typeof longestParts> } | null;
  disclosureMissing: DisclosureField[];
  fairHousing: { hard: FairHousingMatch[]; soft: FairHousingMatch[] };
  blockers: Blocker[];
  stale: StaleReason | null;
  canShare: boolean;
  /** why the Email button is off, in words (null when canShare) */
  sentence: string | null;
}

/** The share's own words (VERIFY WITH COUNSEL). */
export const SHARE_SENTENCES = {
  noEmail: (first: string) => `No email address for ${first}.`,
  noRecipient: 'To share, prepare it from the seller’s page.',
  blockers: 'This CMA can’t be shown to a client yet:',
  disclosure: 'Fill in the disclosure items before sharing.',
  fairHousing: 'Edit the notes: this can’t be sent.',
  statement: 'The MLS statement can’t be printed as written, so this CMA can’t be shared.',
  emailTypeSize: 'This state’s statement needs a larger type size than an email can promise, so this CMA can’t be emailed.',
  tooLong: 'The report is too long for one email. Shorten the notes or disclosure items.',
  dataOld: 'Prepare it again to use the latest sales.',
  saleChanged: 'A sale changed since this CMA was prepared. Prepare it again.',
  blocked: 'The send-time check would block this email now.',
} as const;

interface Prepared {
  row: CmaRow;
  recipients: Recipient[];
  recipient: Recipient | null;
  point: RecipientEmail | null;
  rd: Readiness;
  built: BuiltReport;
  fh: { hard: FairHousingMatch[]; soft: FairHousingMatch[] };
  missing: DisclosureField[];
}

/** The rows a share reads, under the caller's RLS; refuses what is never shared (creator only, a draft, a contact). */
async function shareable(tx: Tx, actor: UserActor, row: CmaRow | null): Promise<CmaRow & { contact_id: string }> {
  if (row === null || row.created_by_user_id !== actor.userId) throw new AppError('NOT_FOUND');
  if (row.status !== 'draft') throw new AppError('CMA_NOT_DRAFT', { status: row.status });
  if (row.contact_id === null) throw new AppError('CMA_NO_RECIPIENT', { reason: 'NO_CONTACT' });
  if ((row.subject as unknown as StoredSubject).resolved.kind === 'listing') throw new AppError('CMA_NO_RECIPIENT', { reason: 'LISTING_SUBJECT' });
  await assertContact(tx, row.contact_id);
  return row as CmaRow & { contact_id: string };
}

async function prepareShare(tx: Tx, actor: UserActor, now: number, id: string, q: PreviewQuery): Promise<Prepared> {
  const row = await shareable(tx, actor, await getCma(tx, id));
  const recipients = await recipientsOf(tx, actor, row.contact_id);
  const firstEmail = (r: Recipient | null) => r?.emails.find((p) => p.status === 'active') ?? r?.emails[0] ?? null;
  let recipient: Recipient | null = recipients.find((r) => r.relationship === 'self') ?? null;
  if (q.recipientContactId !== undefined) {
    recipient = recipients.find((r) => r.contactId === q.recipientContactId) ?? null;
    // not listed: the recipient rules say why (404 invisible or not messageable; 422 another relation)
    if (recipient === null) await recipientFor(tx, actor, row.contact_id, q.recipientContactId, q.toPointId ?? '00000000-0000-0000-0000-000000000000');
    if (recipient === null) throw new AppError('NOT_FOUND');
  }
  let point = firstEmail(recipient);
  if (q.toPointId !== undefined) {
    point = recipient?.emails.find((p) => p.id === q.toPointId) ?? null;
    if (point === null) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/toPointId', code: 'not_an_email_of_recipient' }] });
  }
  const rd = await readinessOf(tx, now as never, row);
  const built = await reportOf(tx, now, row, rd);
  const fh = await fairHousingOf(tx, row);
  const missing = disclosureMissing({ ...row, disclosure: { intendedUsers: row.intended_users, agentInterest: row.agent_interest, conflicts: row.conflicts, valueDefinition: row.value_definition, limitingConditions: row.limiting_conditions } });
  return { row, recipients, recipient, point, rd, built, fh, missing };
}

export type AdminTx = <T>(fn: (tx: Tx, now: number, actor: UserActor) => Promise<T>) => Promise<T>;

export async function previewShare(run: AdminTx, deps: CommsDeps, actor: UserActor, id: string, q: PreviewQuery): Promise<SharePreview> {
  const p = await run((tx, now) => prepareShare(tx, actor, now, id, q));
  const report = p.built.report;
  const text = report === null ? null : emailText(report.blocks);
  const refusal = report === null ? null : refusalFor(report, 'email');
  const tooLong = text !== null && text.length > REPORT_MAX_EMAIL_CHARS ? { parts: longestParts(report!.blocks) } : null;
  let decision: DecisionView | null = null;
  let body: string | null = null;
  if (p.recipient !== null && p.point !== null && report !== null && text !== null) {
    const v = await previewHumanMessage(actor, p.recipient.contactId, { channel: 'email', body: text, subject: report.subject, toPointId: p.point.id }, deps);
    decision = v.decision;
    body = v.body;
  }
  const blockers = p.rd.share.blockers;
  const sentence =
    p.recipient === null
      ? SHARE_SENTENCES.noRecipient
      : p.point === null
        ? SHARE_SENTENCES.noEmail(p.recipient.firstName)
        : blockers.length > 0
          ? SHARE_SENTENCES.blockers
          : p.missing.length > 0
            ? SHARE_SENTENCES.disclosure
            : p.fh.hard.length > 0
              ? SHARE_SENTENCES.fairHousing
              : p.built.stale === 'DATA_OLD'
                ? SHARE_SENTENCES.dataOld
                : p.built.stale === 'SALE_CHANGED'
                  ? SHARE_SENTENCES.saleChanged
                  : refusal !== null
                    ? refusal.reason === 'EMAIL_TYPE_SIZE'
                      ? SHARE_SENTENCES.emailTypeSize
                      : SHARE_SENTENCES.statement
                    : tooLong !== null
                      ? SHARE_SENTENCES.tooLong
                      : decision !== null && decision.outcome !== 'allow'
                        ? `${SHARE_SENTENCES.blocked} ${decision.explanation}`
                        : null;
  return {
    cmaId: p.row.id,
    contentSha256: p.row.content_sha256,
    reportSha256: report === null ? null : reportSha256(report),
    subject: report?.subject ?? null,
    reportText: text,
    body,
    recipients: p.recipients,
    recipientContactId: p.recipient?.contactId ?? null,
    toPointId: p.point?.id ?? null,
    decision,
    warnings: report?.warnings ?? [],
    statement: { ok: refusal === null, part: refusal?.part ?? null, reason: refusal?.reason ?? null, codePoints: refusal?.codePoints ?? [] },
    tooLong,
    disclosureMissing: p.missing,
    fairHousing: p.fh,
    blockers,
    stale: p.built.stale,
    canShare: sentence === null && decision !== null && decision.outcome === 'allow',
    sentence,
  };
}

// ---- the share (POST /cma/:id/share) --------------------------------------------------------------------

export interface ShareBody {
  recipientContactId: string;
  toPointId: string;
  contentSha256: string;
  reportSha256: string;
}

export interface ShareResult {
  cma: CmaView;
  message: { id: string; status: string; result: string };
}

export interface ShareOptions {
  /** tests only (unreachable over HTTP): leave the email queued for the sweep and R-GATE-14 tests */
  dispatch?: boolean;
  /** re-authorizes cma.share inside the write transaction on facts read under the row lock (routes.ts recheck) */
  recheck: (tx: Tx, row: CmaRow) => Promise<void>;
}

/** The method version and ids the audit holds (never cents, an address or text). */
function auditOf(row: CmaRow, messageId: string, recipientContactId: string, connectionIds: string[], soft: FairHousingMatch[]) {
  return redactSnapshot({ message_id: messageId, recipient_contact_id: recipientContactId, connection_ids: connectionIds, soft_term_ids: [...new Set(soft.map((m) => m.termId))].sort(), method_version: row.method_version });
}

/** The share's idempotency key: one email per CMA (E600). */
export const shareKey = (cmaId: string) => `cma-share:${cmaId}`;

export async function shareCma(run: AdminTx, deps: CommsDeps, actor: UserActor, id: string, b: ShareBody, o: ShareOptions): Promise<ShareResult> {
  // (1) the recipient's D1 decision now, from the report as it stands (never stored): a deny stores nothing
  const pre = await run(async (tx, now) => {
    const row = await shareable(tx, actor, await getCma(tx, id)).catch(async (e: unknown) => {
      const replay = await replayOf(tx, actor, await getCma(tx, id), b);
      if (replay !== null) return null;
      throw e;
    });
    if (row === null) return null;
    await recipientFor(tx, actor, row.contact_id, b.recipientContactId, b.toPointId);
    const built = await reportOf(tx, now, row, await readinessOf(tx, now as never, row));
    return built.report === null ? null : { subject: built.report.subject, text: emailText(built.report.blocks) };
  });
  if (pre !== null) {
    const v = await previewHumanMessage(actor, b.recipientContactId, { channel: 'email', body: pre.text, subject: pre.subject, toPointId: b.toPointId }, deps);
    if (v.decision.outcome !== 'allow') throw new AppError('CMA_RECIPIENT_BLOCKED', { reasons: v.decision.reasons });
  }

  // (2) one transaction as the person
  const done = await run(async (tx, now) => {
    const locked = await getCma(tx, id, { lock: true });
    if (locked === null) throw new AppError('NOT_FOUND');
    await o.recheck(tx, locked);
    const replay = await replayOf(tx, actor, locked, b);
    if (replay !== null) return { messageId: replay, created: false };
    const row = await shareable(tx, actor, locked);
    await recipientFor(tx, actor, row.contact_id, b.recipientContactId, b.toPointId);
    if (row.content_sha256 !== b.contentSha256) throw new AppError('CMA_STALE', { reason: 'CONTENT_CHANGED' });
    const missing = disclosureMissing({ ...row, disclosure: { intendedUsers: row.intended_users, agentInterest: row.agent_interest, conflicts: row.conflicts, valueDefinition: row.value_definition, limitingConditions: row.limiting_conditions } });
    if (missing.length > 0) throw new AppError('CMA_DISCLOSURE_INCOMPLETE', { missing, paths: missing.map((m) => (m === 'inspectedOn' ? '/inspectedOn' : `/disclosure/${m}`)) });
    const fh = await fairHousingOf(tx, row);
    if (fh.hard.length > 0) throw new AppError('CMA_FAIR_HOUSING', { termIds: [...new Set(fh.hard.map((m) => m.termId))].sort() });
    const rd = await readinessOf(tx, now as never, row);
    if (rd.share.blockers.length > 0) throw new AppError('CMA_NOT_SHAREABLE', { blockers: rd.share.blockers.map((x) => x.code) });
    const built = await reportOf(tx, now, row, rd);
    if (built.stale !== null) throw new AppError('CMA_STALE', { reason: built.stale });
    const report = built.report!;
    const refusal = refusalFor(report, 'email');
    if (refusal !== null) throw new AppError('CMA_STATEMENT_NOT_RENDERABLE', { part: refusal.part, reason: refusal.reason, ...(refusal.codePoints ? { codePoints: refusal.codePoints } : {}) });
    const text = emailText(report.blocks);
    if (text.length > REPORT_MAX_EMAIL_CHARS) throw new AppError('CMA_REPORT_TOO_LONG', { parts: longestParts(report.blocks) });
    if (reportSha256(report) !== b.reportSha256) throw new AppError('CMA_STALE', { reason: 'REPORT_CHANGED' });
    const m = await createHumanEmailInTx(tx, deps, actor, { contactId: b.recipientContactId, toPointId: b.toPointId, subject: report.subject, body: text, idempotencyKey: shareKey(row.id) }, now as never);
    if (!m.ok) throw new AppError('CMA_RECIPIENT_BLOCKED', { reasons: [m.code] });
    const u = await sql`UPDATE cma_reports SET status = 'shared', shared_by_user_id = app.user_id(), shared_message_id = ${m.messageId}::uuid
       WHERE tenant_id = app.tenant_id() AND id = ${row.id}::uuid AND status = 'draft'`.execute(tx);
    if (Number(u.numAffectedRows ?? 0) !== 1) throw new AppError('NOT_FOUND');
    await audit(tx, actor, { action: 'cma.shared', entity: { type: 'cma_report', id: row.id }, changes: auditOf(row, m.messageId, b.recipientContactId, built.connectionIds, fh.soft) });
    return { messageId: m.messageId, created: true };
  });

  // (3) after commit: the send-time gate decides (D1, R-GATE-14). A blocked send leaves the CMA shared.
  let result = 'queued';
  if (done.created && o.dispatch !== false) result = (await dispatchOutbound(done.messageId, deps, { tenantId: actor.tenantId, actor })).kind;
  else if (!done.created) result = 'replayed';
  const out = await run(async (tx, now) => {
    const status = (await sql<{ status: string }>`SELECT status FROM messages WHERE tenant_id = app.tenant_id() AND id = ${done.messageId}::uuid`.execute(tx)).rows[0]?.status ?? 'unknown';
    return { cma: await getView(tx, actor, now as never, id), status };
  });
  return { cma: out.cma, message: { id: done.messageId, status: out.status, result } };
}

/** The caller's own completed share to the same recipient and address, replayed (E600: a double tap, a retry). */
async function replayOf(tx: Tx, actor: UserActor, row: CmaRow | null, b: Pick<ShareBody, 'recipientContactId' | 'toPointId'>): Promise<string | null> {
  if (row === null || row.status !== 'shared' || row.shared_by_user_id !== actor.userId || row.shared_message_id === null) return null;
  const r = await sql<{ id: string }>`SELECT m.id FROM messages m JOIN contact_points p ON p.tenant_id = m.tenant_id AND p.id = ${b.toPointId}::uuid AND p.contact_id = m.contact_id AND p.address = m.to_address
     WHERE m.tenant_id = app.tenant_id() AND m.id = ${row.shared_message_id}::uuid AND m.contact_id = ${b.recipientContactId}::uuid`.execute(tx);
  return r.rows[0]?.id ?? null;
}
