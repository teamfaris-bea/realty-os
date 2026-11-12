// Partner lead feeds (module 22; R-INBOX-9, E79; PHASE2_3_PLAN §5.4 #22 `leads.feed_poll`).
//
// The per-tenant reconcile handler `leads.feed_poll` (every 60 s, worker/handlers/index.ts) reads its stored instants
// (integration_connections.next_sync_at, R-OWN-27) for each zillow_feed / realtor_feed connection:
//   - not configured, and the platform has no partner agreement (the adapter reports needs_partner_access): the
//     connection says so honestly (status needs_partner_access, the status machine's partner_access_required);
//     nothing is polled, ever
//   - connected / degraded and due: decrypt the stored token as the system (in memory only), then
//     LeadFeedProvider.poll from the stored cursor, OUTSIDE any transaction; each page commits in its own system
//     transaction through the SAME intake as a lead email or web form (ingestInquiryInTx: dedupe by phone/email, so
//     the same person by feed and by lead email is one contact (E79); routing through the ownership engine; the
//     60-second first response); the cursor advances only with its page
//   - a feed that lost access or fails keeps its status; the error code is recorded and it is tried again next time
// Fakes only in this build: the deterministic FakeLeadFeed in tests and demos; production has PartnerLeadFeed, which
// reports needs_partner_access and never polls. No real partner API is called (VERIFY the partner APIs with
// Zillow / realtor.com before any real adapter exists).
import type { IdGenerator, Instant, TenantId } from '@realty/core/foundation';
import { MINUTE_MS, plusMs, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { EnvelopeService } from '../crypto/envelope.js';
import { ingestInquiryInTx } from '../leads/intake.js';
import type { FeedLead, LeadFeedProvider } from '../providers/integrations/types.js';
import { ProviderError } from '../providers/types.js';
import type { StandaloneJobContext } from '../worker/types.js';

export const FEED_POLL_KIND = 'leads.feed_poll' as const;
export const FEED_POLL_EVERY_MS = MINUTE_MS;
/** pages per connection per run (a large backlog drains over several runs) */
export const MAX_PAGES = 5;
let savepoints = 0;

export interface FeedPollDeps {
  envelope: EnvelopeService;
  ids: IdGenerator;
}

interface FeedRow {
  id: string;
  kind: 'zillow_feed' | 'realtor_feed';
  status: string;
  lead_source_id: string | null;
  external_account_id: string | null;
  credential_id: string | null;
  sync_cursor: string | null;
  next_sync_at: Date | null;
}

export interface FeedPollSummary {
  polled: number;
  leads: number;
  markedNeedsPartnerAccess: number;
  errors: number;
}

const providerOf = (ctx: StandaloneJobContext, kind: FeedRow['kind']): LeadFeedProvider => (kind === 'zillow_feed' ? ctx.providers.integrations.leadFeeds.zillow : ctx.providers.integrations.leadFeeds.realtor);

export async function pollFeeds(ctx: StandaloneJobContext, deps: FeedPollDeps): Promise<FeedPollSummary> {
  const out: FeedPollSummary = { polled: 0, leads: 0, markedNeedsPartnerAccess: 0, errors: 0 };
  const rows = await ctx.withTx(async (tx) =>
    (
      await sql<FeedRow>`
        SELECT id, kind, status, lead_source_id, external_account_id, credential_id, sync_cursor, next_sync_at FROM integration_connections
         WHERE tenant_id = app.tenant_id() AND kind IN ('zillow_feed','realtor_feed') AND status IN ('not_configured','connected','degraded')
         ORDER BY id`.execute(tx)
    ).rows,
  );
  for (const c of rows) {
    const feed = providerOf(ctx, c.kind);
    if (c.status === 'not_configured') {
      if (feed.access === 'needs_partner_access') {
        await ctx.withTx((tx) => sql`UPDATE integration_connections SET status = 'needs_partner_access', status_reason = 'PARTNER_ACCESS_REQUIRED'
                                      WHERE tenant_id = app.tenant_id() AND id = ${c.id}::uuid AND status = 'not_configured'`.execute(tx));
        out.markedNeedsPartnerAccess++;
      }
      continue;
    }
    if (c.next_sync_at !== null && c.next_sync_at.getTime() > ctx.now) continue;
    if (!c.lead_source_id || !c.external_account_id || !c.credential_id) continue;
    if (feed.access === 'needs_partner_access') {
      await recordError(ctx, c.id, 'NEEDS_PARTNER_ACCESS');
      out.errors++;
      continue;
    }
    out.polled++;
    try {
      const token = await ctx.withTx((tx) => accessToken(tx, deps.envelope, ctx.actor.tenantId as TenantId, c.credential_id!));
      if (!token) {
        await recordError(ctx, c.id, 'CREDENTIAL_UNAVAILABLE');
        out.errors++;
        continue;
      }
      let cursor = c.sync_cursor;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await feed.poll({ externalAccountId: c.external_account_id, accessToken: token, cursor });
        const next = res.cursor;
        const n = await ctx.withTx(async (tx, now) => {
          // the cursor fence: only the run that read this cursor may advance it
          const cur = await sql<{ sync_cursor: string | null; status: string }>`
            SELECT sync_cursor, status FROM integration_connections WHERE tenant_id = app.tenant_id() AND id = ${c.id}::uuid FOR UPDATE`.execute(tx);
          const row = cur.rows[0];
          if (!row || (row.status !== 'connected' && row.status !== 'degraded') || row.sync_cursor !== cursor) return -1;
          let count = 0;
          for (const lead of res.leads) if (await ingestFeedLead(tx, ctx, deps, c, feed.source, lead, now)) count++;
          await sql`UPDATE integration_connections SET sync_cursor = ${next}, last_synced_at = clock_timestamp(), last_error_code = NULL
                     WHERE tenant_id = app.tenant_id() AND id = ${c.id}::uuid`.execute(tx);
          return count;
        });
        if (n < 0) break;
        out.leads += n;
        if (res.leads.length === 0 || next === cursor) break;
        cursor = next;
      }
      await ctx.withTx((tx, now) => sql`UPDATE integration_connections SET next_sync_at = ${toIso(plusMs(now, FEED_POLL_EVERY_MS))}::timestamptz
                                         WHERE tenant_id = app.tenant_id() AND id = ${c.id}::uuid`.execute(tx));
    } catch (e) {
      await recordError(ctx, c.id, e instanceof ProviderError ? (e.providerCode ?? `PROVIDER_${e.kind.toUpperCase()}`) : 'FEED_POLL_FAILED');
      out.errors++;
    }
  }
  return out;
}

async function recordError(ctx: StandaloneJobContext, id: string, code: string): Promise<void> {
  const c = /^[A-Z][A-Z0-9_]*$/.test(code) ? code.slice(0, 60) : 'FEED_POLL_FAILED';
  await ctx.withTx((tx, now) => sql`UPDATE integration_connections SET last_error_code = ${c}, next_sync_at = ${toIso(plusMs(now, FEED_POLL_EVERY_MS))}::timestamptz
                                     WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx));
}

async function accessToken(tx: Tx, envelope: EnvelopeService, tenantId: TenantId, credentialId: string): Promise<string | null> {
  const r = await sql<{ secret_enc: Buffer | null; status: string }>`
    SELECT secret_enc, status FROM provider_credentials WHERE tenant_id = app.tenant_id() AND id = ${credentialId}::uuid`.execute(tx);
  const c = r.rows[0];
  if (!c || c.status !== 'active' || !c.secret_enc) return null;
  const pt = await envelope.inTx(tx, tenantId).decrypt(tenantId, { table: 'provider_credentials', column: 'secret_enc', rowId: credentialId }, new Uint8Array(c.secret_enc));
  const parsed = JSON.parse(new TextDecoder().decode(pt)) as { accessToken?: unknown };
  return typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0 ? parsed.accessToken : null;
}

/** One feed lead through the shared intake. False when it carries nothing to reach the person (skipped, not held). */
async function ingestFeedLead(tx: Tx, ctx: StandaloneJobContext, deps: FeedPollDeps, c: FeedRow, source: 'zillow' | 'realtor', lead: FeedLead, now: Instant): Promise<boolean> {
  const phones = lead.phone ? [lead.phone.slice(0, 40)] : [];
  const emails = lead.email && !/[\r\n]/.test(lead.email) ? [lead.email.slice(0, 254)] : [];
  const name = (lead.name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 120);
  if (phones.length + emails.length === 0 && !name) return false;
  const externalId = `${source}-feed:${lead.externalLeadId}`.slice(0, 200);
  const receivedAt = Number.isNaN(Date.parse(lead.receivedAt)) ? undefined : new Date(lead.receivedAt).toISOString();
  savepoints = (savepoints + 1) % 1_000_000;
  const name_ = sql.raw(`feed_lead_${savepoints}`);
  await sql`SAVEPOINT ${name_}`.execute(tx);
  try {
    await ingestInquiryInTx(
      tx,
      ctx.actor,
      {
        leadSourceId: c.lead_source_id!,
        externalId,
        ...(receivedAt ? { receivedAt } : {}),
        ...(name ? { fullName: name } : {}),
        phones,
        emails,
        ...(lead.message ? { message: lead.message.slice(0, 4000) } : {}),
        ...(lead.listingRef ? { propertyText: lead.listingRef.slice(0, 500) } : {}),
        sourceDetail: { channel: 'partner_feed', feed: source, ...(lead.listingRef ? { listing_ref: lead.listingRef.slice(0, 64) } : {}) },
      },
      now,
      { envelope: deps.envelope, ids: deps.ids },
    );
    await sql`RELEASE SAVEPOINT ${name_}`.execute(tx);
    return true;
  } catch (e) {
    await sql`ROLLBACK TO SAVEPOINT ${name_}`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name_}`.execute(tx);
    // a serialization failure or a deadlock is not the lead's fault: the page transaction runs again (withTx retries
    // it; the cursor fence keeps the page), so the lead is never dropped for it (review D8-R5)
    const code = (e as { code?: string }).code;
    if (code === '40001' || code === '40P01') throw e;
    // a malformed lead (invalid phone/email) is skipped visibly in the log, never blocks the page
    ctx.log.warn('feed lead skipped', { kind: FEED_POLL_KIND, code: code ?? 'INVALID' });
    return false;
  }
}
