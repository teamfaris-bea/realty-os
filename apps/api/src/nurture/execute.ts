// executeTriggerRun (PHASE2_3_PLAN §5.4 #26; R-NURT-1, R-NURT-3, R-NURT-4, R-NURT-5, R-NURT-7, R-NURT-8,
// R-FH-2, R-AST-20, R-MLS-2; E82, E83, E84).
//
// The job trigger.step {stepRunId} runs this as the system actor under the contact lock (the lock inbound
// ingestion, dispatch and the ownership engine take), so a client reply and a firing never interleave.
// For the woken run and every other due firing of the same contact and playbook (one digest batch):
//   1. re-check, per item: the contact is a live record (merged-away or deleted records never get anything),
//      the version is APPROVED and its latest approval approves exactly its hash (a draft, superseded or
//      revoked version never fires), the owner (an agent-scoped playbook only while its agent owns the
//      contact; an unowned contact gets nothing), and the fact itself (core recheckFact: still on the market,
//      still below the alerted price, MLS fresh and displayable, the deal still closed, the date unchanged);
//      a stale item is `skipped_ineligible` with its visible reason (never a silent drop);
//   2. compose ONE message for what still holds (R-NURT-3: the approved template for one item, the digest
//      wording for several), with the current price (E83), the MLS display rules, attribution and disclaimer;
//   3. decide: the same core authorizeAutonomousAction dispatch repeats at send time, the content guard's
//      fair-housing view (R-FH-2), and the pause (R-NURT-5). Plainly sendable ⇒ an autonomous_message and a
//      queued message for comms/dispatch.ts; anything else ⇒ a draft for the owner (`converted_to_draft`)
//      showing why; wiring details ⇒ skipped (never sendable).
// Every message and draft carries its evidence: one fact claim per item with its source and time (the
// evidence_refs rows) and payload.evidence. Trigger sends are never touches and never move ownership
// (R-NURT-8): the assistant initiates them, so dispatch records no touch.
import {
  type Claim,
  type PlaybookContent,
  type PlaybookStep,
  type SlotValues,
  type TriggerStep,
  INTENT_RULES,
  approvalCurrent,
  authorizeAutonomousAction,
  contentGuard,
  downgradeExplanation,
  formatDue,
  formatPriceCents,
  renderStep,
  signOffFor,
  storedContent,
  triggerStepAsPlaybookStep,
  triggerStepFor,
} from '@realty/core/assistant';
import type { ActionCategory } from '@realty/core/compliance';
import { type AssistantClaimId, type ContactId, type IanaZone, type Instant, ianaZone } from '@realty/core/foundation';
import { type FactState, type Firing, alertItemLine, planBatch, planTriggerRun } from '@realty/core/nurture';
import { type Tx, lockContact } from '@realty/db';
import { sql } from 'kysely';
import * as A from '../assistant/repos/actions.js';
import { contactCore, identityFacts } from '../assistant/repos/context.js';
import { EMAIL_UNSUBSCRIBE_LINE, firstInThread } from '../assistant/steps.js';
import { queueOutboundInTx } from '../comms/index.js';
import { resolvedPolicy } from '../comms/gateInput.js';
import { LISTING_COLS, type ListingRow, type MlsEligibility, clientView, mlsEligibility } from '../mls/eligibility.js';
import { DIGEST_SUBJECT, type RunSkipReason, apiSkip, decideBatch, digestTemplate, draftExplanation, firingOfRow, literal } from './decide.js';
import * as R from './repos.js';
import type { NurtureDeps } from './types.js';
import { KIND_TEXT } from '../transactions/types.js';

export type TriggerOutcome =
  | { kind: 'queued'; messageId: string; actionId: string; runIds: string[] }
  | { kind: 'drafted'; actionId: string; runIds: string[]; reasons: string[] }
  | { kind: 'skipped'; runIds: string[]; reasons: RunSkipReason[] }
  | { kind: 'noop'; reason: 'MISSING' | 'NOT_A_TRIGGER_RUN' | 'ALREADY_HANDLED' | 'NOT_DUE' };

interface Item {
  run: R.RunRow;
  firing: Firing;
  current: FactState;
  /** the listing row and its client view (listing firings) */
  listing?: { row: ListingRow; view: ReturnType<typeof clientView> };
  deal?: { address: string; closedAt: Instant | null };
  /** deal-date firings (module 31): the date as stored now and the recipient's roles on the deal */
  dealDate?: { completed: boolean; label: string; dueAt: Instant | null; zone: IanaZone | null; roles: string[] };
}

async function listingRow(tx: Tx, id: string): Promise<ListingRow | null> {
  const r = await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${id}`.execute(tx);
  return r.rows[0] ?? null;
}

/** The fact as it stands now (R-NURT-4), read under the contact lock. */
async function currentFact(tx: Tx, f: Firing, e: MlsEligibility): Promise<Pick<Item, 'current' | 'listing' | 'deal' | 'dealDate'>> {
  const r = f.ref;
  switch (r.kind) {
    case 'price_drop':
    case 'back_on_market': {
      const row = await listingRow(tx, r.listingId);
      if (!row) return { current: { kind: 'gone' } };
      const view = clientView(e, row);
      // an MLS row reaches a client only through its display rules; a price drop needs the price to be shown
      // (a home that left the market is reported as that, the true reason, rather than as not displayable: the
      // licence pack hides off-market statuses from clients, so the display check would otherwise answer first)
      const onMarket = row.status === 'active' || row.status === 'coming_soon';
      const displayAllowed = row.source === 'team' || !onMarket ? true : view !== null && (r.kind !== 'price_drop' || (view.listPriceCents !== undefined && view.listPriceCents !== null));
      const feedFresh = row.source === 'team' ? true : row.mls_connection_id !== null && !e.staleIds.includes(row.mls_connection_id);
      // R-MLS-2: an MLS row's price is the one its pack lets a client see (none when the pack withholds it)
      const rowPrice = row.list_price_cents === null ? null : Number(row.list_price_cents);
      const priceCents = row.source === 'mls' && view !== null ? (view.listPriceCents ?? null) : rowPrice;
      return { current: { kind: 'listing', status: row.status, priceCents, displayAllowed, feedFresh }, listing: { row, view } };
    }
    case 'home_anniversary': {
      const d = await R.dealState(tx, r.dealId, f.contactId);
      if (!d) return { current: { kind: 'gone' } };
      return { current: { kind: 'deal', status: d.status, contactIsParty: d.contactIsParty }, deal: { address: d.address, closedAt: d.closedAt } };
    }
    case 'deal_date_upcoming': {
      // module 31: also completed_at (a date marked done after planning sends nothing: DATE_COMPLETED), the contract
      // date's zone (the slot shows the contract date, not the instant in the recipient's zone) and the recipient's
      // current roles on the deal (removed, or no longer in a named role: NOT_A_PARTY)
      const q = await sql<{ due_version: number; status: string; confirmed_by_user_id: string | null; due_at: Date | null; completed_at: Date | null; label: string | null; kind: keyof typeof KIND_TEXT; zone: string | null; roles: string[] }>`
        SELECT dd.due_version, dd.status, dd.confirmed_by_user_id, dd.due_at, dd.completed_at, dd.label, dd.kind, dd.basis->>'zone' AS zone,
               ARRAY(SELECT dc.role FROM deal_contacts dc WHERE dc.tenant_id = dd.tenant_id AND dc.deal_id = dd.deal_id AND dc.contact_id = ${f.contactId}) AS roles
          FROM deal_dates dd WHERE dd.tenant_id = app.tenant_id() AND dd.id = ${r.dealDateId} AND dd.deal_id = ${r.dealId}`.execute(tx);
      const x = q.rows[0];
      if (!x) return { current: { kind: 'gone' } };
      const dueAt = x.due_at ? (x.due_at.getTime() as Instant) : null;
      return {
        current: { kind: 'deal_date', dueVersion: x.due_version, confirmed: x.status === 'confirmed' && x.confirmed_by_user_id !== null, dueAt },
        // the date's stored label (or its kind's wording), never the copy in the run (a forged run cannot inject text)
        dealDate: { completed: x.completed_at !== null, label: x.label ?? KIND_TEXT[x.kind] ?? KIND_TEXT.custom, dueAt, zone: x.zone === null ? null : ianaZone(x.zone), roles: x.roles },
      };
    }
    case 'home_value':
      return { current: { kind: 'gone' } }; // wave 2C; apiSkip stops it first (NOT_AVAILABLE_YET)
  }
}

/** Where the client sees the home (MLS display rules decide what an MLS row may show, R-MLS-2). */
function whereOf(it: Item): string {
  const l = it.listing;
  if (!l) return it.deal?.address ?? (it.firing.ref as { address?: string }).address ?? 'your home';
  if (l.row.source === 'team') return `${l.row.address_line1}, ${l.row.city}`;
  const v = l.view;
  if (!v) return 'A home';
  return v.address ? `${v.address.line1}${v.locality ? `, ${v.locality.city}` : ''}` : v.locality ? `A home in ${v.locality.city}` : 'A home';
}

function currentPrice(it: Item): number | null {
  return it.current.kind === 'listing' ? it.current.priceCents : null;
}

/** One item's line (digest) and its slots (single-item message). */
function itemText(it: Item, zone: IanaZone): { line: string; slots: SlotValues } {
  const where = literal(whereOf(it));
  const r = it.firing.ref;
  // the MLS number is left out of client lines (the content guard reads a long digit run as an account number)
  const mlsPrice = it.listing?.row.source === 'mls' ? currentPrice(it) : undefined;
  const shown: Firing = { ...it.firing, ref: { ...r, address: where, ...(r.kind === 'price_drop' || r.kind === 'back_on_market' ? { mlsNumber: null } : {}), ...(r.kind === 'back_on_market' && mlsPrice !== undefined ? { priceCents: mlsPrice } : {}), ...(r.kind === 'deal_date_upcoming' && it.dealDate ? { label: literal(it.dealDate.label) } : {}) } as Firing['ref'] };
  let line = alertItemLine(shown, it.current);
  const broker = it.listing?.row.source === 'mls' ? it.listing.view?.listingBrokerageName : null;
  if (broker) line = `${line}. Listed by ${literal(broker)}`;
  const slots: SlotValues = { listing_address: where };
  const p = currentPrice(it);
  if (p !== null) slots.listing_price = formatPriceCents(p);
  if (r.kind === 'home_anniversary') {
    const years = r.year - Number(r.closedOn.slice(0, 4));
    slots.home_years = `${years} year${years === 1 ? '' : 's'}`;
  }
  if (r.kind === 'deal_date_upcoming') {
    // the current label and the CONTRACT date: the deadline instant shown in the zone it was confirmed in (basis.zone),
    // so a recipient in a zone east of the tenant's is not told the next day (E143)
    slots.document_name = literal(it.dealDate?.label ?? r.label);
    slots.due_date = formatDue(r.dueAt, true, it.dealDate?.zone ?? zone);
  }
  return { line, slots };
}

function sourceLabel(it: Item): { source: 'mls' | 'team' | 'deal'; text: string } {
  if (it.listing) return it.listing.row.source === 'mls' ? { source: 'mls', text: 'MLS' } : { source: 'team', text: 'team listing' };
  return { source: 'deal', text: 'closed deal' };
}

/** The fact claim of one item: what it says, from where and when (evidence over confidence). */
function claimOf(deps: Pick<NurtureDeps, 'ids'>, it: Item, ordinal: number, line: string, zone: IanaZone): Claim {
  const src = sourceLabel(it);
  const when = formatDue(it.firing.scheduledFor, false, zone);
  const ev = it.firing.evidence[0];
  const r = it.firing.ref;
  const p = currentPrice(it);
  const snippet = r.kind === 'price_drop' && p !== null ? `${formatPriceCents(p)} (was ${formatPriceCents(r.oldPriceCents)})` : (ev?.snippet ?? line);
  return {
    id: deps.ids.next<'AssistantClaimId'>() as AssistantClaimId,
    ordinal,
    kind: 'fact',
    text: `${line} (${src.text}, ${when})`.slice(0, 300),
    evidence: ev ? [{ ...ev, snippet: snippet.slice(0, 500), verified: true }] : [],
    needsReview: ev === undefined,
    reviewReasons: ev === undefined ? ['NO_EVIDENCE'] : [],
  };
}

const ONE_LISTING = (f: Firing): string | null => (f.ref.kind === 'price_drop' || f.ref.kind === 'back_on_market' ? f.ref.listingId : null);

/** executeTriggerRun in the caller's system transaction (the trigger.step job's). */
export async function executeTriggerRunInTx(tx: Tx, deps: NurtureDeps, tenantId: string, stepRunId: string, now: Instant): Promise<TriggerOutcome> {
  const peek = await R.runById(tx, stepRunId);
  if (!peek) return { kind: 'noop', reason: 'MISSING' };
  if (peek.enrollmentId !== null) return { kind: 'noop', reason: 'NOT_A_TRIGGER_RUN' };
  await lockContact(tx, peek.contactId as ContactId);
  const lead = await R.runById(tx, stepRunId, true);
  if (!lead || lead.status !== 'scheduled' || lead.messageId !== null || lead.actionId !== null) return { kind: 'noop', reason: 'ALREADY_HANDLED' };
  if (lead.scheduledFor > now) return { kind: 'noop', reason: 'NOT_DUE' };
  const leadFiring = firingOfRow(lead);
  if (leadFiring === null) {
    await R.skipRun(tx, lead.id, 'FACT_MISMATCH');
    return { kind: 'skipped', runIds: [lead.id], reasons: ['FACT_MISMATCH'] };
  }
  // the batch: every due, unbuilt firing of this contact and playbook (the lead among them)
  const runs = await R.openFirings(tx, lead.contactId, leadFiring.playbookId, { dueBy: now });
  if (!runs.some((r) => r.id === lead.id)) runs.unshift(lead);
  const contact = await R.contactState(tx, lead.contactId);
  const versions = new Map<string, R.VersionFacts | null>();
  const versionOf = async (id: string) => {
    if (!versions.has(id)) versions.set(id, await R.versionFacts(tx, id));
    return versions.get(id) ?? null;
  };
  const e = await mlsEligibility(tx, now);
  const skipped: { run: R.RunRow; reason: RunSkipReason }[] = [];
  const items: { item: Item; plan: ReturnType<typeof planTriggerRun> }[] = [];
  for (const run of runs) {
    const f = firingOfRow(run);
    if (f === null) {
      skipped.push({ run, reason: 'FACT_MISMATCH' });
      continue;
    }
    let v = await versionOf(run.versionId);
    // R-AST-4: a firing of a version superseded before the migrate job reached it is built from the playbook's
    // CURRENT approved version (approved by a person, hash-bound); apiSkip skips it if that version lost the step
    if (v !== null && v.status === 'superseded') {
      const curId = await R.currentApprovedVersionId(tx, v.playbookId);
      if (curId !== null) {
        v = await versionOf(curId);
        run.versionId = curId;
      }
    }
    const c = v === null ? null : storedContent(v.steps);
    const content = c !== null && c.kind === 'triggers' ? (c as unknown as Extract<PlaybookContent, { kind: 'triggers' }>) : null;
    const api = apiSkip({
      contactLive: contact !== null && contact.live,
      content,
      firing: f,
      stillFollowed: ONE_LISTING(f) === null ? true : await R.stillFollows(tx, f.contactId, ONE_LISTING(f)!),
      anniversaryAlreadySent: f.trigger === 'home_anniversary' ? await R.enrollmentAnniversarySent(tx, f.contactId, now) : false,
    });
    if (api !== null) {
      skipped.push({ run, reason: api });
      continue;
    }
    const cur = await currentFact(tx, f, e);
    if (cur.dealDate !== undefined) {
      // module 31: a completed date is reported as completed (never as unconfirmed or changed), and a recipient no
      // longer on the deal in a role the approved step names gets nothing (R-TXN-4)
      if (cur.dealDate.completed) {
        skipped.push({ run, reason: 'DATE_COMPLETED' });
        continue;
      }
      const named: readonly string[] = (content === null ? null : triggerStepFor(content, 'deal_date_upcoming'))?.roles ?? [];
      if (!cur.dealDate.roles.some((x) => named.includes(x))) {
        skipped.push({ run, reason: 'NOT_A_PARTY' });
        continue;
      }
    }
    const plan = planTriggerRun({
      firing: f,
      current: cur.current,
      now,
      approvalCurrent: v !== null && v.playbookStatus === 'active' && approvalCurrent({ status: v.status, contentSha256: v.contentSha256 }, v.latest),
      playbook: { scope: v!.scope, ownerUserId: v!.ownerUserId },
      contactOwnerUserId: contact!.ownerUserId,
      paused: false, // the pause is decided once for the whole message (decideBatch)
      guard: { hardBlock: false, fairHousing: false, otherIssues: false }, // the guard runs on the composed text
    });
    if (plan.action === 'skip') skipped.push({ run, reason: plan.reason });
    else items.push({ item: { run, firing: f, ...cur }, plan });
  }
  // one message = one step's channel, purpose and category (the ones dispatch re-checks): items of another step
  // shape are left scheduled and untouched, and the next reconcile pass builds them as their own message
  const sigOf = async (it: Item): Promise<string> => {
    const v = await versionOf(it.run.versionId);
    const c = v === null ? null : storedContent(v.steps);
    const t = c !== null && c.kind === 'triggers' ? (c as unknown as Extract<PlaybookContent, { kind: 'triggers' }>).triggers.find((x) => x.stepKey === it.firing.stepKey) : undefined;
    return t ? `${t.channel}|${t.purpose}|${t.category}` : 'none';
  };
  items.sort((a, b) => a.item.firing.scheduledFor - b.item.firing.scheduledFor || a.item.run.id.localeCompare(b.item.run.id));
  if (items.length > 1) {
    const sig0 = await sigOf(items[0]!.item);
    const same: typeof items = [];
    for (const x of items) if ((await sigOf(x.item)) === sig0) same.push(x);
    items.splice(0, items.length, ...same);
  }
  const finishSkips = async () => {
    for (const s of skipped) await R.skipRun(tx, s.run.id, s.reason);
  };
  const batch = planBatch(items.map((x) => ({ firing: x.item.firing, plan: x.plan })));
  if (batch.action === 'skip') {
    await finishSkips();
    return { kind: 'skipped', runIds: skipped.map((s) => s.run.id), reasons: skipped.map((s) => s.reason) };
  }
  // one line per home: a later firing for the same home replaces the earlier (the message shows the latest
  // fact and the current price, E83); the replaced run is covered by the same message
  const byHome = new Map<string, Item>();
  const kept: Item[] = [];
  const covered: Item[] = [];
  for (const x of [...items].sort((a, b) => a.item.firing.scheduledFor - b.item.firing.scheduledFor || a.item.run.id.localeCompare(b.item.run.id))) {
    const home = ONE_LISTING(x.item.firing);
    if (home === null) {
      kept.push(x.item);
      continue;
    }
    const prev = byHome.get(home);
    if (prev) {
      covered.push(prev);
      kept.splice(kept.indexOf(prev), 1);
    }
    byHome.set(home, x.item);
    kept.push(x.item);
  }
  const head = kept[0]!;
  const version = (await versionOf(head.run.versionId))!;
  const content = storedContent(version.steps) as unknown as Extract<PlaybookContent, { kind: 'triggers' }>;
  const tstep: TriggerStep = content.triggers.find((t) => t.stepKey === head.firing.stepKey)!;
  const step: PlaybookStep = triggerStepAsPlaybookStep(tstep);
  const c = (await contactCore(tx, lead.contactId))!;
  const identity = await identityFacts(tx, { scope: version.scope, agentUserId: version.ownerUserId });
  const first = await firstInThread(tx, c.id);
  const texts = kept.map((it) => itemText(it, c.zone));
  const renderId = { signOff: signOffFor(identity), brokerageName: identity.brokerageLegalName, firstInThread: first, postalAddress: identity.brokeragePostalAddress, unsubscribeUrl: null };
  const firstName = c.firstName?.trim() || 'there';
  const rendered =
    kept.length === 1
      ? renderStep(step, { first_name: firstName, ...texts[0]!.slots }, renderId)
      : renderStep({ ...step, template: digestTemplate(texts.map((t) => t.line)), slots: ['first_name'] }, { first_name: firstName }, renderId);
  if (!rendered.ok) {
    for (const it of [...kept, ...covered]) skipped.push({ run: it.run, reason: 'FACT_MISMATCH' });
    await finishSkips();
    return { kind: 'skipped', runIds: skipped.map((s) => s.run.id), reasons: skipped.map((s) => s.reason) };
  }
  // R-MLS-2: every MLS rendering carries its pack's attribution and disclaimer (once per pack)
  // (one home: the approved template has no brokerage slot, so the listing brokerage the pack requires is a note too)
  const broker = kept.length === 1 && kept[0]!.listing?.row.source === 'mls' ? kept[0]!.listing.view?.listingBrokerageName : null;
  const notes = [...new Set([...(broker ? [`Listed by ${broker}.`] : []), ...kept.flatMap((it) => (it.listing?.view && it.listing.row.source === 'mls' ? [it.listing.view.attribution, it.listing.view.disclaimer] : []))].filter((x): x is string => x !== null && x !== undefined).map(literal))];
  let text = notes.length > 0 ? `${rendered.text}\n${notes.join('\n')}` : rendered.text;
  if (step.channel === 'email' && step.purpose === 'marketing') text = `${text}\n${EMAIL_UNSUBSCRIBE_LINE}`;
  const subject = step.channel === 'email' ? (kept.length === 1 ? (rendered.subject ?? tstep.subject ?? 'A note from your agent') : DIGEST_SUBJECT(kept.length)) : undefined;

  const { policy } = await resolvedPolicy(tx);
  const verdict = authorizeAutonomousAction({
    category: step.category,
    playbookVersion: { status: version.status, contentSha256: version.contentSha256 },
    latestApproval: version.latest,
    tenantAutonomous: policy.autonomous,
    step,
    rendered: text,
    intentCheck: INTENT_RULES[step.intent].purpose === step.purpose ? 'match' : 'mismatch',
    identity,
    firstInThread: first,
  });
  const g = contentGuard(text, step, identity, { firstInThread: first, requireSignOff: true });
  const conv = await R.conversationPaused(tx, c.id);
  const decision = decideBatch({
    paused: conv.paused,
    itemsDraft: { draft: batch.action === 'draft', reasons: batch.reasons, checkThis: batch.checkThis },
    verdict: verdict.allow ? { allow: true } : { allow: false, downgrade: verdict.downgrade },
    guard: { hardBlock: g.hardBlock, fairHousing: g.issues.some((x) => x.code === 'FAIR_HOUSING') },
    ownerUserId: contact!.ownerUserId,
  });
  const allRuns = [...kept, ...covered].map((it) => it.run.id);
  if (decision.action === 'skip') {
    for (const it of [...kept, ...covered]) skipped.push({ run: it.run, reason: decision.reason });
    await finishSkips();
    return { kind: 'skipped', runIds: skipped.map((s) => s.run.id), reasons: skipped.map((s) => s.reason) };
  }
  await finishSkips();

  const claims = kept.map((it, i) => claimOf(deps, it, i, texts[i]!.line, c.zone));
  const evidence = kept.map((it, i) => ({ runId: it.run.id, trigger: it.firing.trigger, fact: texts[i]!.line, source: sourceLabel(it).source, sourceId: it.firing.evidence[0]?.sourceId ?? null, at: new Date(it.firing.scheduledFor).toISOString() }));
  const payload = { channel: step.channel, body: text, ...(subject ? { subject } : {}), stepKey: step.stepKey, playbookId: version.playbookId, trigger: head.firing.trigger, digest: kept.length, triggerRunIds: allRuns, evidence };
  const actionId = deps.ids.next<'AssistantActionId'>();
  const env = { envelope: deps.envelope, tenantId, ids: deps.ids };
  const triggerRef = { kind: 'trigger_run', stepRunId: head.run.id };
  const more = kept.length > 1 ? ` and ${kept.length - 1} more` : '';

  if (decision.action === 'draft') {
    const owner = contact!.ownerUserId!;
    const explanation = draftExplanation(decision, decision.downgrade === null ? null : downgradeExplanation(decision.downgrade, verdict.allow ? undefined : verdict.category));
    await A.insertAction(tx, env, {
      id: actionId,
      contactId: c.id,
      kind: 'message_draft',
      category: step.category,
      autonomy: 'requires_approval',
      playbookVersionId: null,
      status: 'proposed',
      ownerUserId: owner,
      explanation,
      payload: { ...payload, draftReasons: decision.reasons, ...(decision.downgrade ? { downgrade: decision.downgrade } : {}), ...(decision.checkThis ? { checkThis: true, screen: [...new Set(g.issues.map((x) => x.code))] } : {}) },
      pinnedInboundSeq: conv.inboundSeq,
      boundOwnershipSeq: contact!.periodSeq,
      aiRunId: null,
      triggerRef,
      dedupeKey: `trigger_draft:${head.run.id}:${version.id}`,
      claims,
    });
    await R.attachRuns(tx, allRuns, { status: 'converted_to_draft', actionId, messageId: null, versionId: version.id });
    await A.upsertFeed(tx, deps.ids, { userId: owner, itemType: 'assistant_draft', contactId: c.id, subjectType: 'assistant_action', subjectId: actionId, assistantActionId: actionId, score: 55, reasons: [decision.checkThis ? { code: 'CHECK_THIS', text: 'Alert ready: check this before sending' } : { code: 'NEEDS_YOUR_TAP', text: explanation }], dedupeKey: `draft:${actionId}` });
    return { kind: 'drafted', actionId, runIds: allRuns, reasons: decision.reasons };
  }

  await A.insertAction(tx, env, {
    id: actionId,
    contactId: c.id,
    kind: 'autonomous_message',
    category: step.category,
    autonomy: 'within_playbook',
    playbookVersionId: version.id,
    status: 'proposed',
    ownerUserId: contact!.ownerUserId,
    explanation: `From the approved playbook "${version.name}": ${texts[0]!.line}${more}.`,
    payload,
    pinnedInboundSeq: conv.inboundSeq,
    boundOwnershipSeq: contact!.periodSeq,
    aiRunId: null,
    triggerRef,
    dedupeKey: `trigger:${head.run.id}:${version.id}`,
    claims,
  });
  const q = await queueOutboundInTx(tx, deps, {
    contactId: c.id,
    channel: step.channel === 'email' ? 'email' : 'sms',
    body: text,
    ...(subject ? { subject } : {}),
    initiator: 'assistant',
    purpose: step.purpose,
    category: step.category as ActionCategory as never,
    assistantActionId: actionId,
    playbookStepRunId: head.run.id,
    idempotencyKey: `trigger-run:${head.run.id}:${version.id}`,
  }, now);
  if (!q.ok) {
    await A.setStatus(tx, actionId, 'blocked');
    for (const id of allRuns) await R.skipRun(tx, id, 'NOT_QUEUED');
    return { kind: 'skipped', runIds: allRuns, reasons: allRuns.map(() => 'NOT_QUEUED' as const) };
  }
  await R.attachRuns(tx, allRuns, { status: 'scheduled', actionId, messageId: q.messageId, versionId: version.id });
  return { kind: 'queued', messageId: q.messageId, actionId, runIds: allRuns };
}
