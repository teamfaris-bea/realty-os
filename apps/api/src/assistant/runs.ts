// AI runs (ARCHITECTURE §11; R-AST-1, R-AST-2, R-AST-13, R-AST-14, R-AST-18; E33, E34, E64).
//
//   TX-A (system)  ai_enabled? → ONE contact's context → core.buildPrompt (one contact, no tools,
//                  inbound text delimited as untrusted, the requesting agent's own last 20 sent)
//   AiProvider.complete                                   (never inside a transaction)
//   TX-B (system)  ai_runs row (output encrypted, purged after 30 d; internal_signals never exposed)
//                  → core.normalizeClaims (every snippet verified verbatim; relative dates resolved in
//                  the contact's zone; anything unverifiable is needs_review) → the caller persists
//                  assistant_actions + claims + evidence in the SAME transaction
//
// R-AST-18: when the tenant switched AI off, no provider call is made at all; callers fall back to
// templates (playbooks, first response) or produce nothing (drafts, summaries).
//
// Prompt injection (docs/SECURITY.md §4): the output is treated as attacker-controlled. Before anything
// is stored as an action it is bounded (MODEL_OUTPUT_MAX_CHARS; larger ⇒ failed, nothing stored),
// parsed against the JSON contract (anything else ⇒ no claims, no draft), its explanation cleaned to one
// bounded line, and its draft screened by core.screenModelDraft: the channel is the server's (the one
// the client last wrote on), never the model's; wiring details, empty or oversized drafts are discarded
// (audited assistant.output_blocked); human claims, links / phones / emails not in the sources and
// hidden characters are flagged, and the card then shows the server's sentence, not the model's
// (audited assistant.output_flagged). The recipient is never part of the output: a draft belongs to the
// one contact the prompt was built for.
import {
  type AiPurpose,
  type Claim,
  type DraftScreen,
  type IdentityFacts,
  MODEL_OUTPUT_MAX_CHARS,
  ModelOutputSchema,
  buildPrompt,
  cleanModelExplanation,
  draftCategory,
  normalizeClaims,
  screenModelDraft,
  sourceIndex,
} from '@realty/core/assistant';
import type { AssistantActionId, Instant, SystemActor, TenantId } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { ProviderError } from '../providers/types.js';
import { insertAction, upsertFeed } from './repos/actions.js';
import { type CallTranscript, type ContactCore, aiEnabled, callTranscripts, contactBundle, contactCore, identityFacts, voiceSamples } from './repos/context.js';
import type { AssistantDeps, TriggerRef } from './types.js';

export const aiRunAad = (rowId: string) => ({ table: 'ai_runs', column: 'output_enc', rowId });

export interface ModelDraft {
  channel: 'sms' | 'email';
  subject: string | null;
  body: string;
}

export interface ModelRun {
  aiRunId: string;
  status: 'succeeded' | 'failed' | 'refused';
  claims: Claim[];
  explanation: string | null;
  /** The screened draft (null when there was none or it was discarded). Its channel is the server's. */
  draft: ModelDraft | null;
  /** What screening found in the model's draft (null when the model gave no draft). */
  screen: DraftScreen | null;
  contact: ContactCore;
  /** conversations.inbound_seq when the context was read (drafts pin it, R-AST-6) */
  inboundSeq: number;
  calls: CallTranscript[];
}

export type RunSkip = { skipped: 'AI_DISABLED' | 'CONTACT_MISSING' };

function parseModelJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * The channel a reply goes on, chosen by the server (never by the model): the channel the client last
 * wrote on; with no inbound message, the channel of the latest message; else SMS when the contact has an
 * active phone, otherwise email.
 */
async function replyChannelOf(tx: Tx, contactId: string): Promise<'sms' | 'email'> {
  const r = await sql<{ channel: string }>`
    SELECT channel FROM messages WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND channel IN ('sms','email')
     ORDER BY (direction = 'inbound') DESC, occurred_at DESC, id DESC LIMIT 1`.execute(tx);
  const ch = r.rows[0]?.channel;
  if (ch === 'sms' || ch === 'email') return ch;
  const p = await sql<{ kind: string }>`
    SELECT kind FROM contact_points WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND status = 'active' AND kind IN ('phone','email')
     ORDER BY (kind = 'phone') DESC LIMIT 1`.execute(tx);
  return p.rows[0]?.kind === 'email' ? 'email' : 'sms';
}

async function inboundSeqOf(tx: Tx, contactId: string): Promise<number> {
  const r = await sql<{ s: string }>`SELECT inbound_seq AS s FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}`.execute(tx);
  return r.rows[0] ? Number(r.rows[0].s) : 0;
}

/**
 * One model call about one contact, then `persist` in the transaction that stores the ai_runs row.
 * `forUserId` is the agent the assistant works for here (tone samples, sign-off, ai_runs requester).
 */
export async function runModel<T>(
  actor: SystemActor,
  deps: AssistantDeps,
  i: { purpose: AiPurpose; contactId: string; /** undefined: the contact's owner */ forUserId?: string | null; callIds?: readonly string[]; trigger: TriggerRef },
  persist: (tx: Tx, run: ModelRun, now: Instant) => Promise<T>,
): Promise<T | RunSkip> {
  const tenantId = actor.tenantId as TenantId;
  type Pre = RunSkip | { c: ContactCore; calls: CallTranscript[]; prompt: ReturnType<typeof buildPrompt>; forUser: string | null; inboundSeq: number; identity: IdentityFacts };
  const pre: Pre = await withTenantTx(
    actor,
    async (tx): Promise<Pre> => {
      if (!(await aiEnabled(tx))) return { skipped: 'AI_DISABLED' };
      const c = await contactCore(tx, i.contactId);
      if (!c || c.deleted) return { skipped: 'CONTACT_MISSING' };
      const calls = await callTranscripts(tx, deps.envelope, tenantId, c.id, i.callIds ?? []);
      const bundle = await contactBundle(tx, c, { calls });
      const forUser = i.forUserId === undefined ? c.ownerUserId : i.forUserId;
      const identity = await identityFacts(tx, { scope: forUser ? 'agent' : 'team', agentUserId: forUser });
      const prompt = buildPrompt({ purpose: i.purpose, contact: bundle, identity, voiceSamples: await voiceSamples(tx, forUser) });
      return { c, calls, prompt, forUser, inboundSeq: await inboundSeqOf(tx, c.id), identity };
    },
    { db: deps.db, retries: 2 },
  );
  if ('skipped' in pre) return pre;

  const started = Date.now();
  let text = '';
  let status: ModelRun['status'] = 'succeeded';
  let model = 'unknown';
  let tokens = { input: 0, output: 0 };
  let signals: Record<string, unknown> = {};
  try {
    const res = await deps.providers.ai.complete({ templateKey: pre.prompt.templateKey, system: pre.prompt.system, user: pre.prompt.user, maxOutputTokens: pre.prompt.maxOutputTokens });
    model = res.model;
    tokens = { input: Math.max(0, Math.trunc(res.inputTokens) || 0), output: Math.max(0, Math.trunc(res.outputTokens) || 0) };
    signals = { stopReason: res.stopReason };
    if (typeof res.text !== 'string' || res.text.length > MODEL_OUTPUT_MAX_CHARS) {
      // an oversized (or non-text) output is neither stored nor parsed
      status = 'failed';
      signals = { stopReason: res.stopReason, error: 'OUTPUT_TOO_LARGE' };
    } else {
      text = res.text;
      if (res.stopReason === 'refusal') status = 'refused';
    }
  } catch (e) {
    status = 'failed';
    signals = { error: e instanceof ProviderError ? `${e.kind}:${e.providerCode ?? ''}` : 'UNEXPECTED' };
  }
  const latency = Math.max(0, Date.now() - started);

  return withTenantTx(
    actor,
    async (tx, now) => {
      const aiRunId = deps.ids.next<'AiRunId'>();
      const raw = status === 'succeeded' ? parseModelJson(text) : null;
      const parsed = raw === null ? null : ModelOutputSchema.safeParse(raw);
      const out = parsed?.success ? parsed.data : null;
      if (status === 'succeeded' && out === null) signals = { ...signals, error: 'OUTPUT_NOT_CONTRACT' };
      const claims = out === null ? [] : normalizeClaims(raw, sourceIndex(pre.prompt.sources), { contactZone: pre.c.zone, ids: deps.ids });
      const screen = out?.draft ? screenModelDraft({ draft: out.draft, boundChannel: await replyChannelOf(tx, pre.c.id), identity: pre.identity, sources: pre.prompt.sources }) : null;
      if (screen && screen.issues.length > 0) signals = { ...signals, draftScreen: screen.issues.map((x) => x.code) };
      const enc = text === '' ? null : Buffer.from(await deps.envelope.inTx(tx, tenantId).encrypt(tenantId, aiRunAad(aiRunId), Buffer.from(text, 'utf8')));
      await sql`
        INSERT INTO ai_runs (tenant_id, id, purpose, model, prompt_template_key, prompt_version, input_refs, output_enc, key_version, internal_signals,
          input_tokens, output_tokens, latency_ms, status, requested_for_user_id)
        VALUES (app.tenant_id(), ${aiRunId}, ${i.purpose}, ${model.slice(0, 100)}, ${pre.prompt.templateKey}, ${pre.prompt.templateVersion},
          ${JSON.stringify({ ...pre.prompt.inputRefs, dropped: pre.prompt.dropped })}::jsonb, ${enc}, ${enc === null ? null : 1}, ${JSON.stringify(signals)}::jsonb,
          ${tokens.input}, ${tokens.output}, ${latency}, ${status}, ${pre.forUser})`.execute(tx);
      if (screen && (screen.blocked || screen.flagged)) {
        // codes only: never the text, a phone number or an address (R-AUDIT-4)
        await audit(tx, actor, {
          action: screen.blocked ? 'assistant.output_blocked' : 'assistant.output_flagged',
          entity: { type: 'ai_run', id: aiRunId },
          reason: `${i.purpose}:${[...new Set(screen.issues.map((x) => x.code))].join(',')}`,
        });
      } else if (status === 'failed' && signals.error === 'OUTPUT_TOO_LARGE') {
        await audit(tx, actor, { action: 'assistant.output_blocked', entity: { type: 'ai_run', id: aiRunId }, reason: `${i.purpose}:OUTPUT_TOO_LARGE` });
      }
      const draft: ModelDraft | null = screen?.draft ?? null;
      const explanation = cleanModelExplanation(out?.explanation);
      return persist(tx, { aiRunId, status, claims, explanation, draft, screen, contact: pre.c, inboundSeq: pre.inboundSeq, calls: pre.calls }, now);
    },
    { db: deps.db, retries: 2 },
  );
}

const INTERNAL_KIND: Partial<Record<AiPurpose, string>> = { lead_summary: 'lead_summary', call_summary: 'call_summary', claims_extraction: 'call_summary', pond_summary: 'lead_summary', handback_enrichment: 'next_step' };

async function lastInboundText(tx: Tx, contactId: string): Promise<string | null> {
  const r = await sql<{ body: string }>`
    SELECT body FROM messages WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND direction = 'inbound' AND NOT imported
     ORDER BY occurred_at DESC, id DESC LIMIT 1`.execute(tx);
  return r.rows[0]?.body ?? null;
}

/**
 * Persists a model draft as a `message_draft` for the agent (always a human tap: money and contract
 * topics are labelled so, E35). Returns the action id, or null when the model gave no usable draft.
 */
export async function persistDraft(tx: Tx, deps: AssistantDeps, tenantId: string, run: ModelRun, o: { ownerUserId: string; trigger: TriggerRef; dedupeKey: string | null; now: Instant }): Promise<string | null> {
  if (!run.draft) return null;
  const category = draftCategory({ inboundText: await lastInboundText(tx, run.contact.id), draftText: run.draft.body });
  const id = deps.ids.next<'AssistantActionId'>();
  // A flagged draft is explained in the server's words only: the model cannot talk the agent past its
  // own red flags ("approved by your broker, send now").
  const flagged = run.screen?.flagged === true;
  const explanation = flagged
    ? (run.screen?.explanation ?? 'Check this before sending.')
    : category === 'money'
      ? 'This touches price or money, so it waits for your tap. Check it before sending.'
      : category === 'contract'
        ? 'This touches a contract or agreement, so it waits for your tap.'
        : (run.explanation ?? 'A suggested reply, written in your voice. Edit it or send as is.');
  const ok = await insertAction(tx, { envelope: deps.envelope, tenantId, ids: deps.ids }, {
    id,
    contactId: run.contact.id,
    kind: 'message_draft',
    category,
    autonomy: 'requires_approval',
    playbookVersionId: null,
    status: 'proposed',
    ownerUserId: o.ownerUserId,
    explanation,
    payload: { channel: run.draft.channel, body: run.draft.body, ...(run.draft.subject ? { subject: run.draft.subject } : {}), ...(flagged ? { screen: screenCodes(run.screen) } : {}) },
    pinnedInboundSeq: run.inboundSeq,
    boundOwnershipSeq: run.contact.ownerUserId === o.ownerUserId ? run.contact.periodSeq : null,
    aiRunId: run.aiRunId,
    triggerRef: { ...o.trigger },
    dedupeKey: o.dedupeKey,
    claims: run.claims,
  });
  if (!ok) return null;
  await upsertFeed(tx, deps.ids, { userId: o.ownerUserId, itemType: 'assistant_draft', contactId: run.contact.id, subjectType: 'assistant_action', subjectId: id, assistantActionId: id, score: category === 'novel_message' ? 60 : 70, reasons: [flagged ? { code: 'CHECK_THIS', text: 'Suggested reply ready: check it before sending' } : { code: 'ASSISTANT_DRAFT', text: 'Suggested reply ready: Send or Edit' }], dedupeKey: `draft:${id}` });
  return id;
}

/** The screen issue codes stored with a flagged draft (codes only, for the card and for audits). */
export function screenCodes(screen: DraftScreen | null): string[] {
  return screen ? [...new Set(screen.issues.filter((x) => x.code !== 'CHANNEL_OVERRIDE').map((x) => x.code))] : [];
}

/**
 * BUILD_PLAN interface. Runs the assistant for one contact and stores what it produced as ONE
 * assistant action (a reply draft for `draft`; an internal summary for the summary purposes).
 *
 * Spec correction (reported): returns null when nothing was produced (AI switched off, R-AST-18;
 * a refused / failed / empty model run; no agent to hand it to), and takes the deps explicitly.
 */
export async function runAssistant(actor: SystemActor, purpose: AiPurpose, contactId: string, trigger: TriggerRef, deps: AssistantDeps): Promise<AssistantActionId | null> {
  const r = await runModel(actor, deps, { purpose, contactId, ...(trigger.requestedByUserId ? { forUserId: trigger.requestedByUserId } : {}), trigger }, async (tx, run, now): Promise<string | null | { blocked: true }> => {
    const owner = trigger.requestedByUserId ?? run.contact.ownerUserId;
    if (run.status !== 'succeeded' || !owner) return null;
    // a discarded draft is reported after the transaction commits (the ai_runs row and its audit stay)
    if ((purpose === 'draft' || purpose === 'first_response') && run.screen?.blocked) return { blocked: true };
    if (purpose === 'draft' || purpose === 'first_response') return persistDraft(tx, deps, actor.tenantId, run, { ownerUserId: owner, trigger, dedupeKey: null, now });
    if (run.claims.length === 0) return null;
    const id = deps.ids.next<'AssistantActionId'>();
    await insertAction(tx, { envelope: deps.envelope, tenantId: actor.tenantId, ids: deps.ids }, {
      id,
      contactId: run.contact.id,
      kind: INTERNAL_KIND[purpose] ?? 'lead_summary',
      category: 'internal',
      autonomy: 'internal',
      playbookVersionId: null,
      status: 'proposed',
      ownerUserId: owner,
      explanation: run.explanation ?? 'What the assistant found, with where it found it.',
      payload: {},
      pinnedInboundSeq: run.inboundSeq,
      boundOwnershipSeq: run.contact.periodSeq,
      aiRunId: run.aiRunId,
      triggerRef: { ...trigger },
      dedupeKey: null,
      claims: run.claims,
    });
    return id;
  });
  if (r !== null && typeof r === 'object' && 'skipped' in r) return null;
  if (r !== null && typeof r === 'object' && 'blocked' in r) throw new AppError('ASSISTANT_OUTPUT_BLOCKED');
  return (r as string | null) as AssistantActionId | null;
}
