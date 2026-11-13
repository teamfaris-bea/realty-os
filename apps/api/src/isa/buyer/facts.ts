// The buyer facts message (ISA-2b item 11, D7b; R-ISA-17, R-ISA-21, R-ISA-7, R-ISA-8; docs/AI_ISA.md §6.1, §6.2).
// Server text only: factsMessage(FACT_INTROS.listings, the lines, each distinct pack's attribution and disclaimer once)
// through composeMessage. No model text. In TX-B every handle's row is re-read and every rule re-run; a changed row is
// dropped (FACT_CHANGED_AT_BUILD); nothing left → no message (NO_FACTS_RENDERABLE). Channel plan (Q7): the inbound's,
// if its initiated tier passes and, for SMS, the composed body fits 3 segments; else email if bound and passing; else
// SMS dropping WHOLE listing lines from the end until it fits (never a cut line; attribution and disclaimer kept; at
// least one line); else nothing (FACTS_DO_NOT_FIT). Never the "I can email you" pointer. contentGuard runs over the
// full body (TEMPLATE_GUARD:<issue>). At TX1 every pending fact is checked again (factChangedAtSendInTx).
//
// VERIFY WITH COUNSEL (C-ISA-5): the AI identity on a facts message (the platform intro and sign-off say "AI
// assistant"; the same holds for offers and confirmations). VERIFY WITH COUNSEL (C-ISA-7): whether an unlicensed
// assistant may state asking prices (and schedule consults); the price is the MLS's asking price, server-rendered,
// never the model's. VERIFY WITH COUNSEL (C-ISA-1/4): the initiated tier for listing shares and the DNC freshness it
// relies on (initiatedTierPassesInTx). (batch 13 audit ISA2B-12)
import { contentGuard } from '@realty/core/assistant';
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { mlsEligibility } from '../../mls/eligibility.js';
import { FACT_INTROS, factsMessage, fitsSms } from '../coreSeam.js';
import type { IsaContext } from '../effects.js';
import { initiatedTierPassesInTx } from '../send.js';
import type { BuyerBundle } from './bundle.js';
import { type ShareableFact, shareableFactInTx } from './search.js';

/** Q6: at most this many listings per message. VERIFY. */
export const FACTS_PER_MESSAGE = 3;

export type FactsRefusal = 'NO_FACTS_RENDERABLE' | 'FACTS_DO_NOT_FIT' | 'CONSENT_TIER_MISSING' | `TEMPLATE_GUARD:${string}`;

export interface PlannedFacts {
  channel: 'sms' | 'email';
  body: string;
  facts: ShareableFact[];
  dropped: string[];
}

function footer(facts: readonly ShareableFact[]): { attribution: string | null; disclaimer: string | null } {
  const att = [...new Set(facts.map((f) => f.attribution).filter((x): x is string => x !== null && x.trim() !== ''))];
  const dis = [...new Set(facts.map((f) => f.disclaimer).filter((x): x is string => x !== null && x.trim() !== ''))];
  return { attribution: att.length > 0 ? att.join(' ') : null, disclaimer: dis.length > 0 ? dis.join(' ') : null };
}

/** Builds the facts message of `handles` for TX-B. `compose` wraps the facts text with the AI disclosure and sign-off. */
export async function planFactsMessageInTx(tx: Tx, ctx: IsaContext, i: { bundle: BuyerBundle; handles: readonly string[]; preferred: 'sms' | 'email'; now: Instant; compose: (core: string, channel: 'sms' | 'email') => string }): Promise<{ ok: true; plan: PlannedFacts } | { ok: false; code: FactsRefusal; dropped: string[] }> {
  const e = await mlsEligibility(tx, i.now);
  const facts: ShareableFact[] = [];
  const dropped: string[] = [];
  for (const h of [...new Set(i.handles)].slice(0, FACTS_PER_MESSAGE)) {
    const was = i.bundle.items[h];
    if (!was) continue;
    const now = await shareableFactInTx(tx, e, was.listingId, ctx.who.teamName, i.now);
    if (!now.ok || now.fact.status !== was.status || now.fact.priceCents !== was.priceCents) {
      dropped.push(`FACT_CHANGED_AT_BUILD:${h}`);
      continue;
    }
    facts.push(now.fact);
  }
  if (facts.length === 0) return { ok: false, code: 'NO_FACTS_RENDERABLE', dropped };
  const render = (ch: 'sms' | 'email', fs: readonly ShareableFact[]) => i.compose(factsMessage({ intro: FACT_INTROS.listings, lines: fs.map((f) => f.line), ...footer(fs), channel: ch }), ch);
  const passes = async (ch: 'sms' | 'email') => ctx.channels.includes(ch) && (await initiatedTierPassesInTx(tx, ctx.a, ch));
  const order: ('sms' | 'email')[] = i.preferred === 'email' ? ['email', 'sms'] : ['sms', 'email'];
  let plan: PlannedFacts | null = null;
  let anyTier = false;
  for (const ch of order) {
    if (!(await passes(ch))) continue;
    anyTier = true;
    const body = render(ch, facts);
    if (ch === 'email' || fitsSms(body)) {
      plan = { channel: ch, body, facts, dropped };
      break;
    }
  }
  if (plan === null && anyTier && (await passes('sms'))) {
    // SMS, dropping whole listing lines from the end (attribution and disclaimer kept; at least one line)
    for (let n = facts.length - 1; n >= 1 && plan === null; n -= 1) {
      const body = render('sms', facts.slice(0, n));
      if (fitsSms(body)) plan = { channel: 'sms', body, facts: facts.slice(0, n), dropped };
    }
  }
  if (plan === null) return { ok: false, code: anyTier ? 'FACTS_DO_NOT_FIT' : 'CONSENT_TIER_MISSING', dropped };
  const g = contentGuard(plan.body, { channel: plan.channel, purpose: 'marketing', maxLength: plan.channel === 'sms' ? 1600 : 20_000 },
    { brokerageLegalName: ctx.who.brokerageName, teamName: ctx.who.teamName, agentFirstName: ctx.who.agentFirstName, scope: 'agent', allowedLinkHosts: [], brokeragePostalAddress: null },
    { firstInThread: false, requireSignOff: false });
  if (!g.pass) return { ok: false, code: `TEMPLATE_GUARD:${g.issues[0]?.code ?? 'UNKNOWN'}`, dropped };
  return { ok: true, plan };
}

/** One pending fact row per listing kept (TX-B, with the queued message). */
export async function insertPendingFactsInTx(tx: Tx, ids: { next: <T>() => T }, ctx: IsaContext, turnId: string | null, messageId: string, facts: readonly ShareableFact[], displayRulesVersion: string): Promise<void> {
  const { createHash } = await import('node:crypto');
  for (const f of facts) {
    await sql`INSERT INTO ai_isa_shared_facts (tenant_id, id, assignment_id, contact_id, turn_id, message_id, fact_kind, listing_id, mls_connection_id, price_kind, price_cents,
        status_at_build, as_of, display_rules_version, line_sha256)
      VALUES (app.tenant_id(), ${ids.next<string>()}, ${ctx.a.id}, ${ctx.a.contactId}, ${turnId}, ${messageId}, ${f.factKind}, ${f.listingId}, ${f.connectionId}, 'asking',
        ${f.priceCents}, ${f.status}, ${new Date(f.asOf)}, ${displayRulesVersion}, ${createHash('sha256').update(f.line, 'utf8').digest('hex')})`.execute(tx);
  }
}

/**
 * TX1 (R-ISA-17): every pending listing fact of the message still passes every rule with an unchanged status and price;
 * otherwise FACT_CHANGED (replan: the message is canceled and a new turn plans again). An as-of change alone never
 * cancels. The switch on fact_kind leaves ISA-3's seller kinds to their own check.
 */
export async function factChangedAtSendInTx(tx: Tx, messageId: string, teamName: string, now: Instant): Promise<boolean> {
  const r = await sql<{ fact_kind: string; listing_id: string | null; price_cents: string | null; status_at_build: string | null }>`SELECT fact_kind, listing_id, price_cents, status_at_build
    FROM ai_isa_shared_facts WHERE tenant_id = app.tenant_id() AND message_id = ${messageId} AND status = 'pending'`.execute(tx);
  if (r.rows.length === 0) return false;
  const e = await mlsEligibility(tx, now);
  for (const f of r.rows) {
    switch (f.fact_kind) {
      case 'listing_active':
      case 'listing_coming_soon': {
        if (f.listing_id === null) return true;
        const x = await shareableFactInTx(tx, e, f.listing_id, teamName, now);
        if (!x.ok || x.fact.status !== f.status_at_build || x.fact.priceCents !== Number(f.price_cents)) return true;
        break;
      }
      default:
        break; // seller kinds: ISA-3's check
    }
  }
  return false;
}
