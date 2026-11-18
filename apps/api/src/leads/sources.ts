// The Lead sources page's API (module 22 intake continuation; DATA_MODEL R-LSRC-1..5, E333–E339, E597).
//
//   GET   /lead-sources/overview          settings.routing   every source with its facts and paths, in one read
//   PATCH /lead-sources/:id               settings.routing   rename; a new consent text (a new consent_disclosures row)
//   POST  /lead-sources/:id/off | /on     integration.manage 🔒  turn every path of a source off / on (audited)
//   POST  /lead-sources/:id/webhook       integration.manage 🔒  a new intake URL token + signing secret, shown once
//   POST  /lead-sources/:id/preview       settings.routing   read-only: who a lead arriving now would be offered to
//
// The overview and the webhook rotation run as the SYSTEM actor after re-reading the caller's role (the getInbox
// pattern of leadEmail/service.ts): lead_source_webhook_secrets is system-only and the lead-email address is decrypted
// for display. Every write to a source's credentials (Google lead form hook, webhook secret) takes the source's
// credential lock first (lockCredentials), then re-reads the source; lead_sources is never locked FOR UPDATE (every
// lead insert's FK check would wait on it). PATCH, off/on and the preview run as the person (Owner/Admin are
// tenant-wide under RLS). The preview writes and sends nothing, not even an audit row (R-LSRC-4).
import { createHash, randomBytes } from 'node:crypto';
import type { IdGenerator, Instant, SystemActor, UserActor } from '@realty/core/foundation';
import type { InquiryFacts, RoutingPreview, SkipReason } from '@realty/core/ownership';
import { matchRule, previewRouting } from '@realty/core/ownership';
import { type Database, type Tx, loadRoutingCandidates, loadRuleMembers, loadRules, loadTenantFacts, lockAddresses, withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { enqueueStep } from '../assistant/enrollments.js';
import { firstResponseWouldQueue } from '../assistant/firstResponse.js';
import { audit, redactSnapshot } from '../audit.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { inboundAddress } from '../leadEmail/formats.js';
import * as le from '../leadEmail/repos/leadEmail.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { systemActor } from '../worker/systemActor.js';
import { actorOf, leadsTx, platformOf } from './common.js';
import { noAutomatedContactSentence, withdrawAutomatedDrafts } from './automatedContact.js';
import { type ImportLabelRow, labelRows, tenantLabels, unlabeledGroups, unlabeledMappings, unlabeledRow } from './importLabels.js';
import { disclosureSourceKind, storeDisclosure } from './intakeConsent.js';
import { NOTHING_STOPPED as NOTHING, type Stopped, askCareForATurn, stopAutomatedContactForPeople } from './sourceStop.js';
import { AiCareBody, AiCareResponse, ImportLabelBody, ImportLabelResponse, ImportLabelsResponse, OnOffResponse, OverviewResponse, PatchBody, PreviewBody, PreviewResponse, SourceResponse, WebhookRotatedResponse } from './sourcesSchemas.js';
import { type TelephonyMode, telephonyMode } from '../comms/telephonyMode.js';


export interface SourcesDeps {
  db: Database;
  envelope: EnvelopeService;
  ids: IdGenerator;
  publicBaseUrl: string;
  inboundDomain: string | null;
  /** R-TWL-1: whether texts and calls reach a phone (comms/telephonyMode.ts); 'simulated' when not given */
  telephony?: TelephonyMode;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const MANAGERS = ['owner', 'admin'] as const;

/** Whether the deployment has a public https address (Google posts only there; R-GADS-4, E339). */
export function publicHttps(publicBaseUrl: string): boolean {
  try {
    const u = new URL(publicBaseUrl);
    return u.protocol === 'https:' && u.hostname !== 'localhost';
  } catch {
    return false;
  }
}

/** Re-reads the caller's role inside the system transaction (a stale session cannot act as Owner/Admin). */
export async function requireManager(tx: Tx, userId: string): Promise<void> {
  const role = await le.activeRole(tx, userId);
  if (!role || !(MANAGERS as readonly string[]).includes(role)) throw new AppError('NOT_FOUND');
}

/** The person's request, run as the system actor of their tenant (R-PERM-13: the role is re-read first). */
export function asSystem<T>(db: Database, actor: UserActor, fn: (tx: Tx, sys: SystemActor, now: Instant) => Promise<T>): Promise<T> {
  const sys = systemActor(actor.tenantId, 'provider');
  return withTenantTx(
    sys,
    async (tx, now) => {
      await requireManager(tx, actor.userId);
      return fn(tx, sys, now);
    },
    { db, retries: 2 },
  );
}

/**
 * The credential lock of a source (scope 3): every write to google_lead_form_hooks or lead_source_webhook_secrets
 * takes it first (global lock order step 1, an address-class lock), then re-reads the source. Two Owners rotating at
 * once serialize here (E338): never on lead_sources rows, and a 23505 never reaches the caller.
 */
export async function lockCredentials(tx: Tx, leadSourceId: string): Promise<{ id: string; name: string; active: boolean; kind: string } | null> {
  await lockAddresses(tx, [sha256(`lead-source-credentials:${leadSourceId}`).toString('hex')]);
  const r = await sql<{ id: string; name: string; active: boolean; kind: string }>`
    SELECT id, name, active, kind FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${leadSourceId}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

// ---- overview (R-LSRC-1) ------------------------------------------------------------------------

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  created_at: Date;
  active_changed_at: Date | null;
  has_token: boolean;
  has_disclosure: boolean;
  last_lead_at: Date | null;
  leads_30d: number;
  held: number;
  confirmations: number;
  last_email_at: Date | null;
  secret_created_at: Date | null;
  skipped_30d: number;
  no_ai_care: boolean;
}

/**
 * b18 item f, renamed by b18 review B18S-5 (owner product boundary, 2026-11-14): the lead source's "No automated contact
 * for leads from this source" line (leads/automatedContact.ts), the same words on the sources screen, the Owner's
 * answer and the AI care panel (isa/sentences.ts). The column, the API field noAiCare and the route keep their names.
 */
export const noAiCareSentence = noAutomatedContactSentence;

/**
 * The people a source marked "No automated contact for leads from this source" sent, made safe now: each of their live
 * AI care is asked for a turn now, whose chain (link 11) pauses it source_no_ai_care, and each of their active plans for a
 * step now, which stops it (assistant/enrollments.ts, before any due check). The pending drafts a plan step or a
 * trigger wrote for them are withdrawn here, in this transaction, and their cards closed (round 3 item 3). Only this
 * source's people are counted (app.person_from_lead_source, 0099).
 */
export async function stopAutomatedContactNow(tx: Tx, sourceId: string, now: Instant): Promise<Stopped> {
  const live = await sql<{ id: string; epoch: number }>`SELECT a.id, a.epoch FROM ai_isa_assignments a
     WHERE a.tenant_id = app.tenant_id() AND a.ended_at IS NULL AND a.paused_at IS NULL
       AND app.person_from_lead_source(a.tenant_id, a.contact_id, ${sourceId}::uuid) ORDER BY a.id`.execute(tx);
  for (const a of live.rows) await askCareForATurn(tx, a);
  const plans = await sql<{ id: string }>`SELECT e.id FROM playbook_enrollments e
     WHERE e.tenant_id = app.tenant_id() AND e.state = 'active' AND app.person_from_lead_source(e.tenant_id, e.contact_id, ${sourceId}::uuid) ORDER BY e.id`.execute(tx);
  for (const e of plans.rows) await enqueueStep(tx, e.id, now);
  const withdrawn = await withdrawAutomatedDrafts(tx, { sourceId }, now);
  return { pausing: live.rows.length, stopping: plans.rows.length, withdrawn };
}

/** Which mapping the Owner changes: an imported label, or the people one import brought in with no label. */
export type ImportSourceKey = { label: string } | { unlabeledImportId: string };

/**
 * PUT /lead-sources/import-labels: the Owner maps an imported label, or one import's no-label group, to a source (moving
 * it off any other), or removes the mapping. After every change the people's state follows it, in both directions:
 *  - to a MARKED source: its people are refused for that reason, and stopAutomatedContactNow stops their automation;
 *  - to an unmarked source: the refusal lifts for the people whose every imported source is now reviewed (nothing is
 *    restarted: a stopped plan stays stopped and a withdrawn draft stays withdrawn);
 *  - removed (or the key now held by two sources): its committed people are unclassified again, and
 *    stopAutomatedContactForPeople stops their running plans, pauses their live AI care and withdraws their drafts.
 * The audit row carries who, when, the sources, a digest of the label (never its text) and what was asked to stop.
 * The sources are locked FOR NO KEY UPDATE, in id order: a lead insert's foreign-key check on lead_sources never waits
 * on this transaction (the file's rule, line 12), and it takes no other lock.
 */
export async function setImportSource(tx: Tx, actor: UserActor, key: ImportSourceKey, leadSourceId: string | null, now: Instant): Promise<{ label: ImportLabelRow } & Stopped> {
  const byLabel = 'label' in key;
  if (!byLabel) {
    // the import must be this tenant's (the Owner reads import_batches under RLS); never another tenant's id
    const b = await sql`SELECT 1 FROM import_batches WHERE tenant_id = app.tenant_id() AND id = ${key.unlabeledImportId}::uuid`.execute(tx);
    if (b.rows.length === 0) throw new AppError('NOT_FOUND');
  }
  const holds = byLabel ? sql`${key.label}::text = ANY (import_labels)` : sql`${key.unlabeledImportId}::uuid = ANY (import_unlabeled_batches)`;
  // the sources that hold the key now and the target, locked in one order (the ai-care route locks a source the same way)
  const held = await sql<{ id: string; no_ai_care: boolean; has: boolean }>`
    SELECT id, no_ai_care, ${holds} AS has FROM lead_sources
     WHERE tenant_id = app.tenant_id() AND (${holds} OR id = ${leadSourceId}::uuid) ORDER BY id FOR NO KEY UPDATE`.execute(tx);
  if (leadSourceId !== null && !held.rows.some((s) => s.id === leadSourceId)) throw new AppError('NOT_FOUND');
  const from = held.rows.filter((s) => s.has && s.id !== leadSourceId);
  const target = held.rows.find((s) => s.id === leadSourceId) ?? null;
  const added = target !== null && !target.has;
  for (const s of from) {
    if (byLabel) await sql`UPDATE lead_sources SET import_labels = array_remove(import_labels, ${key.label}::text), updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${s.id}::uuid`.execute(tx);
    else await sql`UPDATE lead_sources SET import_unlabeled_batches = array_remove(import_unlabeled_batches, ${key.unlabeledImportId}::uuid), updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${s.id}::uuid`.execute(tx);
  }
  if (added) {
    if (byLabel) await sql`UPDATE lead_sources SET import_labels = array_append(import_labels, ${key.label}::text), updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${target.id}::uuid`.execute(tx);
    else await sql`UPDATE lead_sources SET import_unlabeled_batches = array_append(import_unlabeled_batches, ${key.unlabeledImportId}::uuid), updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${target.id}::uuid`.execute(tx);
  }
  // the people follow the mapping now. A marked target: that source's people (0099's reading: the key's committed
  // people, and a label's matched people too). Otherwise: the key's own committed people who are refused after the
  // change (unclassified again, ambiguous, or still carrying another unreviewed or marked source).
  const safe: Stopped = target?.no_ai_care ? await stopAutomatedContactNow(tx, target.id, now) : await stopAutomatedContactForPeople(tx, key, now);
  if (from.length > 0 || added || safe.pausing + safe.stopping + safe.withdrawn > 0) {
    await audit(tx, actor, {
      action: 'routing.changed',
      // the source it was mapped to or taken from; when no source is involved (a removal that only stopped what was
      // still running for a group nobody had mapped), the import, or the team
      entity: target ?? from[0] ? { type: 'lead_source', id: (target ?? from[0]!).id } : byLabel ? { type: 'tenant', id: actor.tenantId } : { type: 'import_batch', id: key.unlabeledImportId },
      changes: redactSnapshot({
        fromLeadSourceIds: from.map((s) => s.id),
        toLeadSourceId: target?.id ?? null,
        ...(byLabel ? { labelSha256: createHash('sha256').update(key.label, 'utf8').digest('hex') } : { importBatchId: key.unlabeledImportId }),
        aiCarePausingCount: safe.pausing,
        plansStoppingCount: safe.stopping,
        draftsWithdrawnCount: safe.withdrawn,
      }, { entity: 'lead_source' }),
      reason: byLabel ? (target ? 'LEAD_SOURCE_IMPORT_LABEL_MAPPED' : 'LEAD_SOURCE_IMPORT_LABEL_UNMAPPED') : target ? 'LEAD_SOURCE_IMPORT_UNLABELED_MAPPED' : 'LEAD_SOURCE_IMPORT_UNLABELED_UNMAPPED',
    });
  }
  const row = byLabel
    ? ((await tenantLabels(tx)).find((r) => r.label === key.label) ?? labelRows(new Map([[key.label, 0]]), new Map())[0]!)
    : ((await unlabeledGroups(tx, { importId: key.unlabeledImportId }))[0] ?? unlabeledRow(key.unlabeledImportId, 0, (await unlabeledMappings(tx)).get(key.unlabeledImportId) ?? null));
  return { label: row, ...safe };
}

/** The label form of setImportSource (its first name; imports and tests call it). */
export function setImportLabel(tx: Tx, actor: UserActor, label: string, leadSourceId: string | null, now: Instant): Promise<{ label: ImportLabelRow } & Stopped> {
  return setImportSource(tx, actor, { label }, leadSourceId, now);
}

export async function overview(deps: SourcesDeps, actor: UserActor): Promise<z.infer<typeof OverviewResponse>> {
  return asSystem(deps.db, actor, async (tx, sys) => {
    const rows = (
      await sql<SourceRow>`
        SELECT s.id, s.name, s.kind, s.active, s.created_at, s.active_changed_at, s.no_ai_care,
               s.ingest_token_hash IS NOT NULL AS has_token, s.consent_disclosure_id IS NOT NULL AS has_disclosure,
               (SELECT i.received_at FROM lead_inquiries i WHERE i.tenant_id = s.tenant_id AND i.lead_source_id = s.id
                   AND i.outcome IN ('new_contact','attached','reinquiry') ORDER BY i.received_at DESC LIMIT 1) AS last_lead_at,
               (SELECT count(*)::int FROM lead_inquiries i WHERE i.tenant_id = s.tenant_id AND i.lead_source_id = s.id
                   AND i.outcome IN ('new_contact','attached','reinquiry') AND i.received_at >= now() - interval '30 days') AS leads_30d,
               (SELECT count(*)::int FROM lead_email_messages m WHERE m.tenant_id = s.tenant_id AND m.lead_source_id = s.id
                   AND m.status = 'needs_review' AND m.hold_code IS DISTINCT FROM 'FORWARDING_CONFIRMATION') AS held,
               (SELECT count(*)::int FROM lead_email_messages m WHERE m.tenant_id = s.tenant_id AND m.lead_source_id = s.id
                   AND m.status = 'needs_review' AND m.hold_code = 'FORWARDING_CONFIRMATION') AS confirmations,
               (SELECT max(m.received_at) FROM lead_email_messages m WHERE m.tenant_id = s.tenant_id AND m.lead_source_id = s.id) AS last_email_at,
               (SELECT w.created_at FROM lead_source_webhook_secrets w WHERE w.tenant_id = s.tenant_id AND w.lead_source_id = s.id) AS secret_created_at,
               (SELECT count(*)::int FROM lead_source_skips k WHERE k.tenant_id = s.tenant_id AND k.lead_source_id = s.id
                   AND k.skipped_at >= now() - interval '30 days') AS skipped_30d
          FROM lead_sources s WHERE s.tenant_id = app.tenant_id() ORDER BY s.name, s.id`.execute(tx)
    ).rows;
    const hooks = (
      await sql<{ lead_source_id: string; created_at: Date; inquiry_type: string; cites_source_disclosure: boolean; last_test_at: Date | null; last_unreadable_at: Date | null; unreadable_count: number }>`
        SELECT lead_source_id, created_at, inquiry_type, cites_source_disclosure, last_test_at, last_unreadable_at, unreadable_count
          FROM google_lead_form_hooks WHERE tenant_id = app.tenant_id() AND retired_at IS NULL`.execute(tx)
    ).rows;
    const numbers = (
      await sql<{ id: string; e164: string; lead_source_id: string }>`
        SELECT id, e164, lead_source_id FROM phone_numbers WHERE tenant_id = app.tenant_id() AND lead_source_id IS NOT NULL AND released_at IS NULL
         ORDER BY e164`.execute(tx)
    ).rows;
    const conns = (
      await sql<{ lead_source_id: string; kind: string; status: string }>`
        SELECT lead_source_id, kind, status FROM integration_connections
         WHERE tenant_id = app.tenant_id() AND lead_source_id IS NOT NULL AND kind IN ('zillow_feed','realtor_feed','web_chat_widget') AND status <> 'disconnected'
         ORDER BY kind, id`.execute(tx)
    ).rows;
    const https = publicHttps(deps.publicBaseUrl);
    const sources = [];
    for (const s of rows) {
      const inbox = await le.inboxOfSource(tx, s.id);
      const inboxOn = inbox !== null && (inbox.status === 'connected' || inbox.status === 'degraded');
      let address: string | null = null;
      if (inboxOn && deps.inboundDomain) {
        const k = await le.currentKey(tx, inbox!.id);
        if (k) {
          const key = Buffer.from(await deps.envelope.inTx(tx, sys.tenantId).decrypt(sys.tenantId, { table: 'lead_email_inbox_keys', column: 'key_enc', rowId: k.id }, k.key_enc)).toString('utf8');
          address = inboundAddress(key, deps.inboundDomain);
        }
      }
      const hook = hooks.find((x) => x.lead_source_id === s.id) ?? null;
      sources.push({
        id: s.id,
        name: s.name,
        kind: s.kind,
        active: s.active,
        createdAt: s.created_at.toISOString(),
        offSince: s.active ? null : iso(s.active_changed_at),
        lastLeadAt: iso(s.last_lead_at),
        leadsLast30Days: s.leads_30d,
        heldEmails: s.held,
        forwardingConfirmations: s.confirmations,
        skippedWhileOffLast30Days: s.skipped_30d,
        paths: {
          email: { state: !deps.inboundDomain ? ('not_available' as const) : inboxOn ? ('on' as const) : ('off' as const), address, lastEmailAt: iso(s.last_email_at) },
          webhook: { hasToken: s.has_token, ownSecret: s.secret_created_at !== null, secretCreatedAt: iso(s.secret_created_at) },
          googleLeadForm: {
            state: !https ? ('not_available' as const) : hook ? ('on' as const) : ('off' as const),
            createdAt: iso(hook?.created_at),
            inquiryType: hook?.inquiry_type ?? null,
            citesSourceDisclosure: hook ? hook.cites_source_disclosure : null,
            lastTestAt: iso(hook?.last_test_at),
            lastUnreadableAt: iso(hook?.last_unreadable_at),
            unreadableCount: hook?.unreadable_count ?? 0,
          },
          trackingNumbers: numbers.filter((n) => n.lead_source_id === s.id).map((n) => ({ id: n.id, e164: n.e164 })),
          partnerFeeds: conns.filter((c) => c.lead_source_id === s.id && c.kind !== 'web_chat_widget').map((c) => ({ kind: c.kind, status: c.status })),
          webChats: conns.filter((c) => c.lead_source_id === s.id && c.kind === 'web_chat_widget').map((c) => ({ status: c.status })),
        },
        hasConsentText: s.has_disclosure,
        noAiCare: s.no_ai_care,
        noAiCareSentence: noAiCareSentence(s.no_ai_care),
      });
    }
    return { sources, deployment: { inboundEmail: deps.inboundDomain !== null, publicHttps: https, telephony: deps.telephony ?? 'simulated' } };
  });
}

// ---- rename, consent text, off / on (R-LSRC-2) ------------------------------------------------------

interface ViewRow {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  active_changed_at: Date | null;
  has_token: boolean;
  created_at: Date;
  consent_disclosure_id: string | null;
}
async function sourceRow(tx: Tx, id: string): Promise<ViewRow | null> {
  const r = await sql<ViewRow>`
    SELECT id, name, kind, active, active_changed_at, ingest_token_hash IS NOT NULL AS has_token, created_at, consent_disclosure_id
      FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}
const view = (s: ViewRow) => ({ id: s.id, name: s.name, kind: s.kind, active: s.active, offSince: s.active ? null : iso(s.active_changed_at), hasToken: s.has_token, createdAt: s.created_at.toISOString() });

/** The paths of a source that stop when it is turned off (or work again when on), in words (R-LSRC-2, E597). */
async function pathWords(tx: Tx, id: string, has_token: boolean): Promise<string[]> {
  const r = await sql<{ email: boolean; google: boolean; numbers: number; feeds: number; chats: number }>`
    SELECT EXISTS (SELECT 1 FROM integration_connections c WHERE c.tenant_id = app.tenant_id() AND c.lead_source_id = ${id}::uuid AND c.kind = 'lead_email' AND c.status IN ('connected','degraded')) AS email,
           EXISTS (SELECT 1 FROM google_lead_form_hooks h WHERE h.tenant_id = app.tenant_id() AND h.lead_source_id = ${id}::uuid AND h.retired_at IS NULL) AS google,
           (SELECT count(*)::int FROM phone_numbers n WHERE n.tenant_id = app.tenant_id() AND n.lead_source_id = ${id}::uuid AND n.released_at IS NULL) AS numbers,
           (SELECT count(*)::int FROM integration_connections c WHERE c.tenant_id = app.tenant_id() AND c.lead_source_id = ${id}::uuid AND c.kind IN ('zillow_feed','realtor_feed') AND c.status <> 'disconnected') AS feeds,
           (SELECT count(*)::int FROM integration_connections c WHERE c.tenant_id = app.tenant_id() AND c.lead_source_id = ${id}::uuid AND c.kind = 'web_chat_widget' AND c.status <> 'disconnected') AS chats`.execute(tx);
  const x = r.rows[0]!;
  const out: string[] = [];
  if (x.email) out.push('Lead emails sent to its address');
  if (has_token) out.push('Leads your website or system posts to its webhook address');
  if (x.google) out.push('Google Ads lead form leads');
  if (x.numbers > 0) out.push(x.numbers === 1 ? 'New callers and texters on its tracking number (calls still ring, as unknown callers)' : `New callers and texters on its ${x.numbers} tracking numbers (calls still ring, as unknown callers)`);
  if (x.feeds > 0) out.push('Partner feed leads');
  if (x.chats > 0) out.push('Website chat');
  return out;
}

export const OFF_SENTENCE =
  "What is sent to it while it's off is not received. Google does not resend; its leads stay downloadable in Google Ads for 30 days. Tracked calls still ring, as unknown callers. Website chat stops.";

async function setActive(tx: Tx, actor: UserActor, id: string, active: boolean): Promise<z.infer<typeof OnOffResponse>> {
  const s = await sourceRow(tx, id);
  if (!s) throw new AppError('NOT_FOUND');
  if (s.active !== active) {
    await sql`UPDATE lead_sources SET active = ${active}, active_changed_at = now(), updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
    await audit(tx, actor, { action: 'routing.changed', entity: { type: 'lead_source', id }, changes: redactSnapshot({ active }, { entity: 'lead_source' }), reason: active ? 'LEAD_SOURCE_REACTIVATED' : 'LEAD_SOURCE_DEACTIVATED' });
  }
  const after = (await sourceRow(tx, id))!;
  const paths = await pathWords(tx, id, after.has_token);
  return {
    source: view(after),
    paths,
    sentence: active ? 'Leads are received again on every path listed.' : OFF_SENTENCE,
  };
}

// ---- webhook credentials (R-LSRC-3) ------------------------------------------------------------------

export async function rotateWebhook(deps: SourcesDeps, actor: UserActor, id: string): Promise<z.infer<typeof WebhookRotatedResponse>> {
  const token = randomBytes(32).toString('base64url');
  const secret = randomBytes(32).toString('hex');
  return asSystem(deps.db, actor, async (tx, sys) => {
    const s = await lockCredentials(tx, id);
    if (!s) throw new AppError('NOT_FOUND');
    if (!s.active) throw new AppError('LEAD_SOURCE_OFF');
    await sql`UPDATE lead_sources SET ingest_token_hash = ${sha256(token)}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
    const enc = await deps.envelope.inTx(tx, sys.tenantId).encrypt(sys.tenantId, { table: 'lead_source_webhook_secrets', column: 'secret_enc', rowId: id }, Buffer.from(secret, 'utf8'));
    const r = await sql<{ created_at: Date }>`
      INSERT INTO lead_source_webhook_secrets (tenant_id, lead_source_id, secret_enc, created_by_user_id, created_at)
      VALUES (app.tenant_id(), ${id}::uuid, ${Buffer.from(enc)}, ${actor.userId}::uuid, clock_timestamp())
      ON CONFLICT (tenant_id, lead_source_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, created_by_user_id = EXCLUDED.created_by_user_id, created_at = EXCLUDED.created_at
      RETURNING created_at`.execute(tx);
    // no token or secret in the audit row
    await audit(tx, sys, { action: 'lead_source.webhook_rotated', entity: { type: 'lead_source', id }, changes: redactSnapshot({ by_user_id: actor.userId }), reason: 'ROTATED' });
    return { intakeUrl: new URL(`/api/intake/${token}`, deps.publicBaseUrl).toString(), signingSecret: secret, createdAt: r.rows[0]!.created_at.toISOString() };
  });
}

/**
 * The source's own signing secret, decrypted as the system actor of its tenant (the webhook guard, leads/webhookAuth.ts).
 * null: the source has none (it keeps the deployment secret).
 */
export async function webhookSecretOf(tx: Tx, envelope: EnvelopeService, tenantId: string, leadSourceId: string): Promise<string | null> {
  const r = await sql<{ secret_enc: Buffer }>`
    SELECT secret_enc FROM lead_source_webhook_secrets WHERE tenant_id = app.tenant_id() AND lead_source_id = ${leadSourceId}::uuid`.execute(tx);
  const row = r.rows[0];
  if (!row) return null;
  return Buffer.from(await envelope.inTx(tx, tenantId as never).decrypt(tenantId as never, { table: 'lead_source_webhook_secrets', column: 'secret_enc', rowId: leadSourceId }, row.secret_enc)).toString('utf8');
}

// ---- preview (R-LSRC-4) -------------------------------------------------------------------------------

/** Each skip reason in words (never a code on the page). */
export const SKIP_WORDS: Record<SkipReason, string> = {
  MEMBERSHIP_INACTIVE: 'is suspended or no longer active',
  ROLE_NOT_ELIGIBLE: "has a role that doesn't take leads",
  NOT_ACCEPTING_LEADS: 'is not accepting leads',
  NO_CRITICAL_CHANNEL: "has no way to get an urgent alert (no push and no verified alert phone)",
  ALREADY_OFFERED: 'was already offered this lead',
  RELEASE_COOLDOWN: 'released this lead recently',
  CAPACITY_REACHED: 'already has the most new leads they may hold before calling them',
};
const POND_REASON: Record<Exclude<RoutingPreview, { kind: 'offer' }>['reasonCode'], string> = {
  NO_RULE_MATCH: 'No routing rule matches a lead like this.',
  RULE_POND: 'The matching rule sends leads like this to a pond.',
  MAX_OFFERS_REACHED: 'The matching rule allows no offers.',
  NO_ELIGIBLE_AGENT: 'Nobody in the matching rule can take a lead right now.',
};

export async function preview(tx: Tx, id: string, body: z.infer<typeof PreviewBody>, now: Instant): Promise<z.infer<typeof PreviewResponse>> {
  const s = await sourceRow(tx, id);
  if (!s) throw new AppError('NOT_FOUND');
  if (body.priceMinCents !== undefined && body.priceMaxCents !== undefined && body.priceMinCents > body.priceMaxCents) {
    throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/priceMinCents', code: 'price_band' }] });
  }
  const inquiry: InquiryFacts = {
    leadSourceId: id as InquiryFacts['leadSourceId'],
    inquiryType: body.inquiryType ?? 'general',
    postalCode: body.postalCode ?? null,
    priceMinCents: body.priceMinCents ?? null,
    priceMaxCents: body.priceMaxCents ?? null,
  };
  const facts = await loadTenantFacts(tx);
  const rules = await loadRules(tx);
  const rule = matchRule(rules, inquiry);
  // the router's own candidate query, without its locks and with no contact yet (no release cooldown)
  const candidates = rule ? await loadRoutingCandidates(tx, await loadRuleMembers(tx, rule), null, now, facts) : [];
  // the rotation cursor, read only: never FOR UPDATE, never the INSERT the router does
  const cursor = rule ? ((await sql<{ cursor: Record<string, unknown> }>`SELECT cursor FROM routing_rotation_state WHERE tenant_id = app.tenant_id() AND rule_id = ${rule.id}`.execute(tx)).rows[0]?.cursor ?? {}) : {};
  const p = previewRouting(rules, inquiry, candidates, cursor, { defaultPondId: facts.settings.defaultPondId, maxOffers: facts.settings.maxOffers, uncontactedCapacityCap: facts.settings.uncontactedCapacityCap });
  const ids = [...new Set([...p.considered.map((c) => c.userId), ...(p.kind === 'offer' ? [p.userId] : [])])];
  const names = new Map(
    (await sql<{ user_id: string; display_name: string }>`SELECT m.user_id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = app.tenant_id() AND m.user_id = ANY (${ids}::uuid[])`.execute(tx)).rows.map((r) => [r.user_id, r.display_name]),
  );
  const nameOf = (u: string) => names.get(u) ?? 'A former member';
  const considered = p.considered.map((c) => ({ userId: c.userId, name: nameOf(c.userId), eligible: c.eligible, reason: c.skipReason ? `${nameOf(c.userId)} ${SKIP_WORDS[c.skipReason]}.` : null }));
  // b18 review B18S-5: a source marked "No automated contact for leads from this source" never gets the instant reply
  const marked = (await sql<{ v: boolean }>`SELECT no_ai_care AS v FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${s.id}::uuid`.execute(tx)).rows[0]?.v === true;
  const queued = !marked && (await firstResponseWouldQueue(tx, now));
  const ruleOut = p.rule ? { id: p.rule.id, name: p.rule.name ?? 'Unnamed rule' } : null;
  if (p.kind === 'offer') {
    return { rule: ruleOut, outcome: { kind: 'offer', userId: p.userId, name: nameOf(p.userId) }, considered, sentence: `If a lead came in now, it would be offered to ${nameOf(p.userId)}.`, firstResponse: queued ? 'queued' : 'off' };
  }
  const pond = (await sql<{ name: string }>`SELECT name FROM ponds WHERE tenant_id = app.tenant_id() AND id = ${p.pondId}::uuid`.execute(tx)).rows[0];
  const pondName = pond?.name ?? 'the default pond';
  return {
    rule: ruleOut,
    outcome: { kind: 'pond', pondId: p.pondId, pondName, reason: POND_REASON[p.reasonCode] },
    considered,
    sentence: `If a lead came in now, it would go to ${pondName}. ${POND_REASON[p.reasonCode]}`,
    firstResponse: queued ? 'queued' : 'off',
  };
}

// ---- routes ---------------------------------------------------------------------------------------------

export function sourcesDeps(req: FastifyRequest): SourcesDeps {
  const p = platformOf(req);
  return { db: p.db, envelope: p.envelope, ids: p.ids, publicBaseUrl: p.config.publicBaseUrl, inboundDomain: p.config.leadEmail.inboundDomain, telephony: telephonyMode(p.config) };
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const routing = { config: { auth: 'settings.routing' as const }, preHandler: authorize('settings.routing', () => ({})) };
  const manage = { config: { auth: 'integration.manage' as const }, preHandler: authorize('integration.manage', () => ({})) };
  const Params = z.object({ id: z.uuid() }).strict();

  r.get('/lead-sources/overview', { ...routing, schema: { response: { 200: OverviewResponse } } }, async (req) => overview(sourcesDeps(req), actorOf(req)));

  r.patch('/lead-sources/:id', { ...routing, schema: { params: Params, body: PatchBody, response: { 200: SourceResponse } } }, async (req) => {
    const p = platformOf(req);
    return leadsTx(req, async (tx, _now, actor) => {
      const s = await sourceRow(tx, req.params.id);
      if (!s) throw new AppError('NOT_FOUND');
      if (req.body.name !== undefined && req.body.name !== s.name) {
        try {
          await sql`UPDATE lead_sources SET name = ${req.body.name}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${s.id}::uuid`.execute(tx);
        } catch (e) {
          if ((e as { code?: string }).code === '23505') throw new AppError('VERSION_CONFLICT', { field: 'name' });
          throw e;
        }
        await audit(tx, actor, { action: 'routing.changed', entity: { type: 'lead_source', id: s.id }, changes: redactSnapshot({ renamed: true }, { entity: 'lead_source' }), reason: 'LEAD_SOURCE_RENAMED' });
      }
      if (req.body.consentDisclosure) {
        // a new text is a new consent_disclosures row; earlier inquiries keep citing theirs (R-CONSENT-4, E337)
        const d = await storeDisclosure(tx, p.ids, req.body.consentDisclosure, disclosureSourceKind(s.kind));
        if (d.id !== s.consent_disclosure_id) {
          await sql`UPDATE lead_sources SET consent_disclosure_id = ${d.id}::uuid, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${s.id}::uuid`.execute(tx);
          await audit(tx, actor, { action: 'routing.changed', entity: { type: 'lead_source', id: s.id }, changes: redactSnapshot({ consentDisclosureId: d.id }, { entity: 'lead_source' }), reason: 'LEAD_SOURCE_DISCLOSURE_CHANGED' });
        }
      }
      return { source: view((await sourceRow(tx, s.id))!) };
    });
  });

  // b18 item f / B18S-5: the Owner-only "No automated contact for leads from this source" (🔒 when turning it off: that
  // re-allows automated contact). Turning it on also asks each live AI care of the source's people for a turn now, whose
  // chain (link 11) pauses it source_no_ai_care with the note, and each of their active plans for a step now, which
  // stops it at once, due or not (source_no_automated_contact; round 3 item 4); dispatch TX1 refuses any automated
  // message still queued for them meanwhile. `pausing` and `stopping` count this source's people only.
  r.put('/lead-sources/:id/ai-care', {
    config: { auth: 'lead_source.ai_care' },
    preHandler: authorize('lead_source.ai_care', (req) => ({ loosening: (req.body as { noAiCare?: unknown } | undefined)?.noAiCare !== true })),
    schema: { params: Params, body: AiCareBody, response: { 200: AiCareResponse } },
  }, async (req) =>
    leadsTx(req, async (tx, now, actor) => {
      const s = await sourceRow(tx, req.params.id);
      if (!s) throw new AppError('NOT_FOUND');
      const was = (await sql<{ v: boolean }>`SELECT no_ai_care AS v FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${s.id}::uuid FOR NO KEY UPDATE`.execute(tx)).rows[0]!.v;
      if (was !== req.body.noAiCare) {
        await sql`UPDATE lead_sources SET no_ai_care = ${req.body.noAiCare}, no_ai_care_changed_at = now(), updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${s.id}::uuid`.execute(tx);
        await audit(tx, actor, { action: 'routing.changed', entity: { type: 'lead_source', id: s.id }, changes: redactSnapshot({ noAiCare: { from: was, to: req.body.noAiCare } }, { entity: 'lead_source' }), reason: req.body.noAiCare ? 'LEAD_SOURCE_NO_AI_CARE_ON' : 'LEAD_SOURCE_NO_AI_CARE_OFF' });
      }
      // round 3 item 4: only THIS source's people are asked and counted (app.person_from_lead_source, 0099), never the
      // people of another marked source; round 3 item 3: their pending plan and alert drafts are withdrawn here
      const safe = req.body.noAiCare ? await stopAutomatedContactNow(tx, s.id, now) : NOTHING;
      return { source: { id: s.id, name: s.name, noAiCare: req.body.noAiCare, noAiCareSentence: noAiCareSentence(req.body.noAiCare) }, ...safe };
    }),
  );

  // b18 round 3 item 1 (E728): imported source labels. Anyone who manages routing sees every label in the CRM and the source
  // it means; only the Owner maps, moves or unmaps one (core lead_source.ai_care, 🔒 every time: a move can loosen the
  // setting for the people it labels; app.lead_sources_import_labels_guard in the database). A label mapped to a source
  // with "No automated contact for leads from this source" on stops its people's plans and pauses their AI care now.
  r.get('/lead-sources/import-labels', { ...routing, schema: { response: { 200: ImportLabelsResponse } } }, async (req) =>
    leadsTx(req, async (tx, _now, actor) => ({ labels: await tenantLabels(tx), canChange: actor.role === 'owner' })),
  );
  r.put('/lead-sources/import-labels', {
    config: { auth: 'lead_source.ai_care' },
    preHandler: authorize('lead_source.ai_care', () => ({ loosening: true })),
    schema: { body: ImportLabelBody, response: { 200: ImportLabelResponse } },
  }, async (req) => leadsTx(req, (tx, now, actor) => setImportSource(tx, actor, 'label' in req.body ? { label: req.body.label } : { unlabeledImportId: req.body.unlabeledImportId }, req.body.leadSourceId, now)));

  r.post('/lead-sources/:id/off', { ...manage, schema: { params: Params, response: { 200: OnOffResponse } } }, async (req) => leadsTx(req, (tx, _now, actor) => setActive(tx, actor, req.params.id, false)));
  r.post('/lead-sources/:id/on', { ...manage, schema: { params: Params, response: { 200: OnOffResponse } } }, async (req) => leadsTx(req, (tx, _now, actor) => setActive(tx, actor, req.params.id, true)));

  r.post('/lead-sources/:id/webhook', { ...manage, schema: { params: Params, response: { 200: WebhookRotatedResponse } } }, async (req) => rotateWebhook(sourcesDeps(req), actorOf(req), req.params.id));

  r.post('/lead-sources/:id/preview', { ...routing, schema: { params: Params, body: PreviewBody, response: { 200: PreviewResponse } } }, async (req) =>
    leadsTx(req, (tx, now) => preview(tx, req.params.id, req.body, now)),
  );
}

export const leadSourcesRoutes: RouteModule = { name: 'lead-sources', register };
