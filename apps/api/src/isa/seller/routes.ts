// The seller panel routes (ISA-3; docs/AI_ISA.md §9.1). Every read runs as the viewer under RLS; the panel never calls
// the comps pipeline (it shows the last check). Writes are the owner's own, as themselves (the DB guard is the
// backstop), audited with ids and codes only.
//   GET  /contacts/:id/ai-isa/seller                        ai_isa.view
//   POST /contacts/:id/ai-isa/confirm-subject               ai_isa.subject_confirm (the live seller assignment's owner)
//   POST /contacts/:id/ai-isa/seller/subject-disputed       ai_isa.pause (anyone who may pause; owner question 9)
//   POST /contacts/:id/ai-isa/seller/near-match-different   ai_isa.subject_confirm (records the dismissal; the pause
//                                                           lifts only on the owner's ISA-2 resume, R-ISA-15)
//   POST /contacts/:id/ai-isa/seller/resume-comps           ai_isa.subject_confirm ("Let the assistant keep sharing")
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { type Instant, type UserActor, can } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import { audit } from '../../audit.js';
import { chooseEmailIdentity, emailIdentityFacts } from '../../comms/repos/gate.js';
import { AppError } from '../../errors.js';
import { detailFacts, liveDetailFacts } from '../../people/common.js';
import { authorize } from '../../rbac.js';
import type { RouteModule } from '../../routes.js';
import { actorOf, platformOf } from '../../workspace/common.js';
import { EmptyBody, IdParams } from '../schemas.js';
import { AI_ISA_PACK, AI_ISA_SELLER_PACK, CMA_PLATFORM_PACK, clientReadiness, mlsEligibility, nearMatches, notLivingAreaSize, platformCleared, readinessConnections } from './cmaSeam.js';
import { COUNT_SENTENCE, marketCountsInTx } from './counts.js';
import { assignmentSubjectLinkInTx, compsSuspendedNowInTx, sellerGatesInTx } from './gates.js';
import { type AssignmentRow, liveAssignmentOf } from './isa2Seam.js';
import * as S from './schemas.js';
import { confirmationCodes, currentSubjectInTx, ensureWatchInTx, watchOf } from './subject.js';

const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
/**
 * The packs a comps email waits on, in order, with the names the Integrations page gives them (integrations/catalog.ts
 * PACK_GATES); readiness 'ai_isa' requires all three (cma/gates.ts).
 */
const SELLER_PACK_NAMES: readonly (readonly [string, string])[] = [
  [CMA_PLATFORM_PACK, 'the Client CMAs pack (platform:cma)'],
  [AI_ISA_SELLER_PACK, 'the assistant’s recent-sales emails pack (platform:ai_isa_seller_data)'],
  [AI_ISA_PACK, 'the assistant’s ISA texts and emails pack (platform:ai_isa)'],
];
const MISSING_WORDS = {
  licence: 'your MLS licence pack does not say sold data may be emailed to seller leads by the assistant (MLS admin page, Valuation use)',
  postal: 'the brokerage’s postal address is not set (Brokerage settings)',
  domain: 'the team’s sending domain is not verified (Sending domains)',
} as const;

/**
 * b17 review B17R-1: the "no" names what a comps email still waits on and nothing else: only the packs counsel has not
 * reviewed (b17 named all three whenever one waited, so recorded packs read as awaiting review), then the licence, the
 * postal address and the sending domain when they are missing, as the Integrations line names each pack with its own
 * review state (catalog.ts PACK_ALSO_NEEDS).
 */
export function packWaitsSentence(m: { packs: readonly string[]; licence: boolean; postal: boolean; domain: boolean }): string {
  const names = SELLER_PACK_NAMES.filter(([key]) => m.packs.includes(key)).map(([, name]) => name);
  const parts = [
    ...(names.length > 0 ? [`waiting for counsel review of ${names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`}`] : []),
    ...(m.licence ? [MISSING_WORDS.licence] : []),
    ...(m.postal ? [MISSING_WORDS.postal] : []),
    ...(m.domain ? [MISSING_WORDS.domain] : []),
  ];
  return `Can share recent sales: no — ${parts.join('; ')}.`;
}
/** b17: a passing build is still not a yes while every marketing email would be refused (R-GATE-12, R-PAR-39). */
const SENDING_MISSING = {
  postal: 'Can share recent sales: no — the brokerage’s postal address is not set (Brokerage settings), and every marketing email carries it.',
  domain: 'Can share recent sales: no — the team’s sending domain is not verified (Sending domains), and the assistant’s emails go out from it.',
  both: 'Can share recent sales: no — the brokerage’s postal address is not set (Brokerage settings) and the team’s sending domain is not verified (Sending domains).',
} as const;

/**
 * What a comps email needs of the tenant beyond the packs and the licence: the brokerage's postal address (gate check
 * 4, POSTAL_ADDRESS_MISSING; core isa/lines.ts composeMessage adds it) and a verified sending domain under the identity
 * the assistant sends from (gate check 3, EMAIL_DOMAIN_UNVERIFIED; comms compose.ts draftFor picks the team identity,
 * chooseEmailIdentity(tx, null)).
 */
async function sendingReadyInTx(tx: Tx): Promise<{ postal: boolean; domain: boolean }> {
  const r = await sql<{ postal: string | null }>`SELECT brokerage_postal_address AS postal FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const id = await chooseEmailIdentity(tx, null);
  const ident = id === null ? null : await emailIdentityFacts(tx, id);
  return { postal: (r.rows[0]?.postal ?? '').trim() !== '', domain: ident?.status === 'active' && ident.domain?.verifiedAt != null };
}

export const SUSPENSION_SENTENCE = 'Recent sales paused: they asked about price. Prepare or re-run a CMA, share one, or let the assistant keep sharing.';
export const WATCH_SENTENCE = 'Competition updates are not sent yet (not built yet).';

const sellerSide = (a: AssignmentRow | null): a is AssignmentRow => a !== null && a.endedAt === null && (a.side === 'seller' || a.side === 'both');

/** The live seller assignment the caller owns, or a refusal (404 when the contact is invisible: authorize did that). */
async function ownedSeller(tx: Tx, actor: UserActor, contactId: string): Promise<AssignmentRow> {
  const a = await liveAssignmentOf(tx, contactId);
  if (!sellerSide(a)) throw new AppError('SUBJECT_NOT_SELLER', { sentence: 'This lead is not under seller AI care.' });
  if (a.ownerUserId !== actor.userId) throw new AppError('NOT_FOUND');
  return a;
}

const NOT_SELLER = 'This lead is not under seller AI care.';
const act = (available: boolean, reason: string | null) => ({ available, reason: available ? null : reason });

/**
 * `mayPause`: whether THIS viewer passes ai_isa.pause on the contact (the subject-disputed route's own authorization),
 * computed by the caller from the same facts. Default false: a caller that does not say is offered no dispute.
 */
export async function sellerPanel(tx: Tx, viewer: UserActor, contactId: string, now: Instant, mayPause = false): Promise<z.infer<typeof S.SellerPanel>> {
  const a = await liveAssignmentOf(tx, contactId);
  const subject = await currentSubjectInTx(tx, contactId, now);
  const w = sellerSide(a) ? await watchOf(tx, a.id) : null;
  const codes = confirmationCodes(w, subject);
  // the comp-independent blockers, as V1-C words them (agent-only)
  const r = await clientReadiness(tx, { use: 'ai_isa', conns: await readinessConnections(tx, now), now, state: subject.facts ? (subject.addressKey?.split('|')[3]?.toUpperCase() ?? null) : null,
    addressKey: subject.addressKey, addressLine: subject.addressLine, subjectMlsListingId: subject.record?.listingId ?? null, compSales: [], readConnectionIds: [], nearMatchDismissed: [], hasValue: true,
    notLivingArea: notLivingAreaSize([subject.sizeSource]) }); // R-MLS-7: the subject's own size source (no comps here)
  const blockers = r.share.blockers.map((b) => ({ code: b.code, sentence: b.sentence }));
  const packWaits = blockers.some((b) => b.code === 'PLATFORM_NOT_CLEARED');
  // b17 review B17R-1: which packs, and whether the licence also lacks the assistant's use
  const waitingPacks: string[] = [];
  if (packWaits) for (const [key] of SELLER_PACK_NAMES) if (!(await platformCleared(tx, key))) waitingPacks.push(key);
  const licenceMissing = blockers.some((b) => b.code === 'CLIENT_USE_NOT_ALLOWED');
  const gates = sellerSide(a) ? await sellerGatesInTx(tx, viewer, a, now, 'competition') : null;
  const suspended = sellerSide(a) ? await compsSuspendedNowInTx(tx, viewer, a, w) : false;
  const built = sellerSide(a) && codes.length === 0 && blockers.length === 0 && !suspended && (w?.last_comps_check?.codes.length ?? 1) === 0;
  // b17: a passing build with no postal address or no verified sending domain would still be refused at the gate
  const named = packWaits || licenceMissing;
  const sending = built || named ? await sendingReadyInTx(tx) : { postal: true, domain: true };
  const compsOk = built && sending.postal && sending.domain;
  const compsSentence = compsOk
    ? 'Can share recent sales: yes, by email, the complete set only.'
    : built
      ? SENDING_MISSING[!sending.postal && !sending.domain ? 'both' : !sending.postal ? 'postal' : 'domain']
      : named
        ? packWaitsSentence({ packs: waitingPacks, licence: licenceMissing, postal: !sending.postal, domain: !sending.domain })
        : `Can share recent sales: no — ${[...codes, ...blockers.map((b) => b.code), ...(w?.last_comps_check?.codes ?? [])][0] ?? 'not checked yet'}.`;
  const link = sellerSide(a) ? await assignmentSubjectLinkInTx(tx, a) : { effect: 'ok' as const, code: null, sentence: 'Not under seller AI care.', listingIds: [] };
  let counts: { active: number; comingSoon: number; pending: number; sentence: string } | null = null;
  if (subject.state === 'ok' && subject.facts && subject.addressKey) {
    const zip = subject.addressKey.split('|')[4] ?? '';
    const c = await marketCountsInTx(tx, await mlsEligibility(tx, now), { postalCode: zip, facts: subject.facts }, now, null);
    counts = { ...c.counts, sentence: COUNT_SENTENCE };
  }
  const sent = sellerSide(a)
    ? (await sql<{ fact_kind: string; listing_id: string | null; created_at: Date }>`SELECT fact_kind, listing_id, created_at FROM ai_isa_shared_facts WHERE tenant_id = app.tenant_id()
        AND assignment_id = ${a.id} AND status = 'sent' AND fact_kind IN ('sold_comp_set','competitor') ORDER BY created_at DESC LIMIT 20`.execute(tx)).rows
    : [];
  // R-ISA-35: which of this panel's own actions the routes below would accept from this viewer now, each from the facts
  // its route checks (ownedSeller, the current subject, the watch row, link 10, the suspension). A control is drawn only
  // when `available` is true; the route still decides for itself, and its refusal carries its own sentence.
  const seller = sellerSide(a);
  const owner = seller && a.ownerUserId === viewer.userId;
  const confirmedNow = seller && codes.length === 0;
  const actions = {
    confirmSubject: act(owner && subject.state === 'ok' && !confirmedNow, !seller ? NOT_SELLER : !owner ? 'Only the lead’s owner confirms the home.' : confirmedNow ? 'The home is confirmed.' : subject.sentence),
    subjectDisputed: act(seller && mayPause && w?.subject_confirmed_at != null && w.subject_disputed_at == null,
      !seller ? NOT_SELLER : w?.subject_confirmed_at == null ? 'The owner has not confirmed the home yet.' : w.subject_disputed_at != null ? 'The home is already marked as not theirs.' : 'You cannot pause AI care for this lead, so you cannot mark the home.'),
    nearMatchDifferent: { ...act(owner && link.code === 'AI_ISA_POSSIBLE_LISTING' && link.listingIds.length > 0, !seller ? NOT_SELLER : link.code !== 'AI_ISA_POSSIBLE_LISTING' ? 'No live listing may be this home.' : 'Only the lead’s owner can say it is a different home.'),
      listingIds: owner && link.code === 'AI_ISA_POSSIBLE_LISTING' ? link.listingIds : [] },
    resumeComps: act(owner && suspended, !seller ? NOT_SELLER : !suspended ? 'Recent sales are not paused.' : 'Only the lead’s owner can let the assistant keep sharing recent sales.'),
  };
  return {
    contactId,
    assignmentId: a?.id ?? null,
    actions,
    side: a?.side ?? null,
    subject: {
      state: subject.state, code: subject.code, sentence: subject.sentence, nextStep: subject.nextStep, contactAddressId: subject.contactAddressId, addressLine: subject.addressLine,
      recordListingId: subject.record?.listingId ?? null, recordDate: subject.record?.modifiedAt ? new Date(subject.record.modifiedAt).toISOString() : null, facts: subject.facts,
      factsSha256: subject.factsSha256, confirmed: w?.subject_confirmed_at != null, confirmedAt: w?.subject_confirmed_at?.toISOString() ?? null, disputed: w?.subject_disputed_at != null,
      clearedReason: w?.subject_cleared_reason ?? null, codes,
    },
    blockers,
    lastCompsCheck: w?.last_comps_check ? { codes: w.last_comps_check.codes, checkedAt: w.last_comps_check.checked_at } : null,
    capabilities: { comps: { available: compsOk, sentence: compsSentence }, competition: { available: gates !== null && gates.codes.length === 0, sentence: gates !== null && gates.codes.length === 0 ? 'Can share new competing listings (asking prices).' : 'Can share competing listings: no — confirm the home first.' } },
    link: { effect: link.effect, code: link.code, sentence: link.sentence, listingIds: link.listingIds },
    suspension: { suspended, sentence: suspended ? SUSPENSION_SENTENCE : null },
    watch: { lastRunAt: w?.last_run_at?.toISOString() ?? null, sentence: WATCH_SENTENCE },
    counts,
    factsSent: sent.map((x) => ({ factKind: x.fact_kind, listingId: x.listing_id, sentAt: x.created_at.toISOString() })),
  };
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const facts = (req: FastifyRequest) => detailFacts(req, idOf);
  const live = (req: FastifyRequest) => liveDetailFacts(req, idOf);
  const tx = <T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>) => {
    const actor = actorOf(req);
    return withTenantTx(actor, (t, now) => fn(t, now, actor), { db: platformOf(req).db });
  };

  r.get('/contacts/:id/ai-isa/seller', { config: { auth: 'ai_isa.view' }, preHandler: authorize('ai_isa.view', facts), schema: { params: IdParams, response: { 200: S.SellerPanel } } },
    async (req) => {
      // the dispute route's own authorization, asked of the same facts (ai_isa.pause on this contact)
      const f = await facts(req);
      const mayPause = f !== null && can(actorOf(req), 'ai_isa.pause', f).ok;
      return tx(req, (t, now, actor) => sellerPanel(t, actor, req.params.id, now, mayPause));
    });

  r.post('/contacts/:id/ai-isa/confirm-subject', { config: { auth: 'ai_isa.subject_confirm' }, preHandler: authorize('ai_isa.subject_confirm', live), schema: { params: IdParams, body: S.ConfirmSubjectBody, response: { 200: S.SellerResult } } },
    async (req) => tx(req, async (t, now, actor) => {
      const a = await ownedSeller(t, actor, req.params.id);
      const cur = await currentSubjectInTx(t, a.contactId, now);
      if (cur.state !== 'ok') throw new AppError((cur.code ?? 'SUBJECT_INCOMPLETE') as never, { sentence: cur.sentence, nextStep: cur.nextStep });
      if (req.body.contactAddressId !== cur.contactAddressId || req.body.recordListingId !== cur.record!.listingId || req.body.factsSha256 !== cur.factsSha256) {
        throw new AppError('SUBJECT_CHANGED', { sentence: 'The home’s record or address changed since the panel was shown. Look again, then confirm.' });
      }
      await ensureWatchInTx(t, a);
      await sql`UPDATE ai_isa_seller_watch SET contact_address_id = ${cur.contactAddressId}, subject_address_key = ${cur.addressKey}, subject_connection_id = ${cur.record!.connectionId},
          subject_record_listing_id = ${cur.record!.listingId}, subject_record_date = ${cur.record!.modifiedAt === null ? null : new Date(cur.record!.modifiedAt)},
          subject_facts = ${JSON.stringify(cur.facts)}::jsonb, subject_confirmed_by_user_id = ${actor.userId}, subject_confirmed_at = now()
        WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}`.execute(t);
      await audit(t, actor, { action: 'ai_isa.subject_confirmed', entity: { type: 'ai_isa_assignment', id: a.id } });
      return { ok: true as const, sentence: 'Confirmed. The assistant compares recent sales with this home’s MLS record.' };
    }));

  r.post('/contacts/:id/ai-isa/seller/subject-disputed', { config: { auth: 'ai_isa.pause' }, preHandler: authorize('ai_isa.pause', facts), schema: { params: IdParams, body: EmptyBody, response: { 200: S.SellerResult } } },
    async (req) => tx(req, async (t, _now, actor) => {
      const a = await liveAssignmentOf(t, req.params.id);
      if (!sellerSide(a)) throw new AppError('SUBJECT_NOT_SELLER', { sentence: 'This lead is not under seller AI care.' });
      // never an INSERT here (ISA-3 audit F2): seller_watch_insert admits only the system and the assignment's owner, and
      // Postgres checks it before ON CONFLICT, so a Team Lead's or Admin's insert would abort the transaction. The
      // system makes the row at the first turn (H1); with no row there is no confirmed home to dispute.
      if ((await watchOf(t, a.id)) === null) return { ok: true as const, sentence: 'Nothing to mark yet: the owner has not confirmed the home.' };
      const u = await sql`UPDATE ai_isa_seller_watch SET subject_disputed_at = now() WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} AND subject_disputed_at IS NULL`.execute(t);
      if (Number(u.numAffectedRows ?? 0) > 0) await audit(t, actor, { action: 'ai_isa.subject_disputed', entity: { type: 'ai_isa_assignment', id: a.id } });
      return { ok: true as const, sentence: 'Marked disputed. Recent sales stop until the owner confirms the home again.' };
    }));

  r.post('/contacts/:id/ai-isa/seller/near-match-different', { config: { auth: 'ai_isa.subject_confirm' }, preHandler: authorize('ai_isa.subject_confirm', live), schema: { params: IdParams, body: S.NearMatchBody, response: { 200: S.SellerResult } } },
    async (req) => tx(req, async (t, _now, actor) => {
      const a = await ownedSeller(t, actor, req.params.id);
      const w = await watchOf(t, a.id);
      const key = w?.subject_address_key ?? (await currentSubjectInTx(t, a.contactId, _now)).addressKey;
      const near = new Set((await nearMatches(t, key, [])).map((m) => m.listingId));
      if (!req.body.listingIds.every((id) => near.has(id))) throw new AppError('NOT_FOUND');
      await ensureWatchInTx(t, a);
      const all = [...new Set([...(w?.near_match_dismissed ?? []), ...req.body.listingIds])].sort();
      await sql`UPDATE ai_isa_seller_watch SET near_match_dismissed = ${all}::uuid[] WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}`.execute(t);
      await audit(t, actor, { action: 'ai_isa.near_match_dismissed', entity: { type: 'ai_isa_assignment', id: a.id }, changes: { dismissed_listing_ids: { from: w?.near_match_dismissed ?? [], to: all } } as never });
      return { ok: true as const, sentence: 'Noted: a different home. Resume AI care to continue; recent sales stay off while a live listing may be this home.' };
    }));

  r.post('/contacts/:id/ai-isa/seller/resume-comps', { config: { auth: 'ai_isa.subject_confirm' }, preHandler: authorize('ai_isa.subject_confirm', live), schema: { params: IdParams, body: EmptyBody, response: { 200: S.SellerResult } } },
    async (req) => tx(req, async (t, _now, actor) => {
      const a = await ownedSeller(t, actor, req.params.id);
      await ensureWatchInTx(t, a);
      await sql`UPDATE ai_isa_seller_watch SET comps_resumed_at = now(), comps_resumed_by_user_id = ${actor.userId}, comps_resumed_reason = 'owner_resume'
        WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}`.execute(t);
      await audit(t, actor, { action: 'ai_isa.comps_resumed', entity: { type: 'ai_isa_assignment', id: a.id }, reason: 'owner_resume' });
      return { ok: true as const, sentence: 'The assistant may share recent sales again, by email, when every check passes.' };
    }));
}

export const sellerRoutes: RouteModule = { name: 'ai-isa-seller', register };
