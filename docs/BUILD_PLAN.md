# Realty OS: Phase 1 Build Plan

Phase 1 is built as 17 modules in dependency order. Each module lists its path, its public interface (TypeScript signatures), the rules it implements (ids from `docs/DATA_MODEL.md` §4), the tests it needs, and its acceptance criteria. The schema already exists: `packages/db/migrations/0001_init.sql` applies cleanly, and `packages/db/test/rls_smoke.sql` passes. Modules build on it and never weaken it. A module that needs a schema change ships a new numbered migration; `0001_init.sql` is never edited after it ships.

**Owner decision D1 (2026-11; ARCHITECTURE §9 and §20).** Every lead is treated as consented through its third-party source, and the send-time consent/compliance check was removed except for a narrow opt-out block (STOP and other keywords, unsubscribe, agent-recorded do-not-contact, active suppressions; no override). It shipped as migration `0013_simplify_send_gate.sql` and `RULES_VERSION = 'core-compliance/2.0.0'`. The module sections below are updated where the interface or the tests changed; rules R-CONSENT-13/14/15 and edge cases E29/E30/E36 are **Retired** in DATA_MODEL and need no test.

Ground rules for every module:
- **`packages/core` is pure.** No I/O, no `Date.now()`, no `Math.random()`. Clock and id generator are injected. It has 100 % branch coverage on decision functions.
- **Tests that touch Postgres run against a real PG16** (`realty_test`, migrated fresh per CI run) as `app_user`. Mocks are never used for RLS.
- **Every Zod response schema is snapshot-tested.** The snapshot test asserts there are no `confidence*` fields and no `tenant_id` input fields (R-AST-13, R-TEN-3).
- **ESLint architecture rules:**
  - `packages/core` imports nothing from db/api.
  - Only `apps/api/src/comms/dispatch.ts` imports provider `send`/`dial` (R-GATE-2).
  - `Actor{kind:'system'}` is constructed only in `apps/api/src/worker/**`.
  - `SET app.` without `LOCAL`/`set_config(...,true)` is banned.
  - `selectFrom` is banned outside `packages/db` and module repositories.

```
 1 core/foundation ─┬─► 2 core/compliance ─┬─► 3 core/ownership ─┬─► 5 core/priority
                    │                      ├─► 4 core/assistant ─┤
                    └─► 6 core/import ◄────┘                     │
 7 db/client  (needs 1–6 types) ─► 8 api/platform ─► 9 api/jobs-worker ─► 10 api/admin
 10 ─► 11 api/leads ─► 12 api/comms ─► 13 api/assistant ─► 14 api/workspace ─► 15 api/accountability
 11,12 ─► 16 api/imports
 8–16 ─► 17 web
```

---

## 1. `core/foundation`
**Path:** `packages/core/src/foundation/` (`ids.ts`, `time.ts`, `calendar.ts`, `tz.ts`, `normalize.ts`, `authz.ts`, `errors.ts`)

```ts
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type TenantId = Brand<string,'TenantId'>; export type UserId = Brand<string,'UserId'>;
export type ContactId = Brand<string,'ContactId'>; /* … one brand per table id … */
export type Instant = Brand<number,'Instant'>;            // epoch ms UTC
export interface Clock { now(): Instant }                 // tests: fixedClock(t), steppingClock()
export interface IdGenerator { next<T extends string>(): Brand<string,T> }   // UUIDv7; tests: sequentialIds()
export type IanaZone = Brand<string,'IanaZone'>;
export interface BusinessCalendar { zone: IanaZone; open: LocalTime; close: LocalTime; days: ReadonlySet<Weekday> }
export function addBusinessDuration(start: Instant, seconds: number, cal: BusinessCalendar): Instant;
export function nextOpening(at: Instant, cal: BusinessCalendar): Instant;
export function localWindowContains(at: Instant, zone: IanaZone, start: LocalTime, end: LocalTime): boolean;
export function nextWindowStart(at: Instant, zones: readonly IanaZone[], start: LocalTime, end: LocalTime): Instant; // intersection
export type TzSource = 'explicit'|'address'|'area_code'|'tenant_default';
export function resolveRecipientZones(i: { pointTz?: string; contactTz?: string; addressTz?: string;
  areaCodeZones: readonly IanaZone[]; tenantZone: IanaZone }): { zones: IanaZone[]; source: TzSource };
export function normalizePhone(raw: string, defaultCountry: 'US'): { ok: true; e164: string } | { ok: false; code: 'PHONE_INVALID' };
export function normalizeEmail(raw: string): { ok: true; email: string } | { ok: false; code: 'EMAIL_INVALID' };
export type Role = 'owner'|'admin'|'team_lead'|'agent'|'isa'|'tc';
export type Actor = { kind:'user'; userId: UserId; tenantId: TenantId; role: Role; sessionId: string }
                  | { kind:'system'; tenantId: TenantId; via: 'timer'|'provider'|'assistant'|'import'|'worker'; jobId?: string }
                  | { kind:'support'; userId: UserId; tenantId: TenantId; grantId: string };
export type Action = 'contact.view'|'contact.view_detail'|'lead.accept'|'lead.claim'|'lead.release'|'lead.reassign'
  |'comms.send'|'comms.call'|'recording.play'|'consent.record'|'suppression.lift'|'playbook.approve'|'import.run'
  |'exception.verify'|'deal.edit'|'deal.financials'|'settings.compliance'|'settings.identity'|'member.role' /* … */;
export function can(actor: Actor, action: Action, resource: ResourceFacts): { ok: true } | { ok: false; code: DenyCode; reauth?: true };
```
- **Rules:** R-PERM-1, R-PERM-13, R-PERM-15, R-OWN-15 (business time), R-TEN-3 (Actor shape). (The recipient-zone helpers built for R-CONSENT-13 remain in foundation; that rule is retired by D1.)
- **Tests:**
  - DST vectors for America/New_York, Chicago, Denver, Phoenix, Los_Angeles and Pacific/Honolulu, on the 2026 and 2027 transitions. Cover spring-forward boundaries inside the skipped hour, and fall-back ambiguity resolved to the later instant for windows and the earlier offset for elapsed time.
  - Property tests: `addBusinessDuration` is monotonic and additive.
  - Phone fixtures: 10/11-digit, extensions, short codes rejected.
  - A generated `can()` matrix test with one case per DATA_MODEL §3 cell.
- **Accept when:**
  - The DST suite is green.
  - The `can()` matrix covers every cell.
  - The module has zero imports from node built-ins except types.

## 2. `core/compliance`
**Path:** `packages/core/src/compliance/` (`gate.ts`, `policy.ts`, `consent.ts`, `inbound.ts`, `recording.ts`, `sender.ts`, `content.ts`)

```ts
export type Channel = 'sms'|'voice'|'email'; export type Purpose = 'marketing'|'informational';
export type Initiator = 'human'|'assistant'|'system';
export type ActionCategory = 'none'|'speed_to_lead_reply'|'reminder'|'booking_confirmation'|'document_chase'|'nurture_step'
  |'search_alert'|'opt_out_confirmation'|'help_reply'|'agent_alert'|'money'|'contract'|'novel_message'|'seller_update';
export interface ResolvedPolicy { version: { policyId: string; packs: Record<string,string> };
  autonomous: ReadonlySet<ActionCategory>; recordingMode: 'announce_all'|'one_party_where_permitted';
  keywords: Keywords; inquiryBasisDays: number }   // D1: no window, caps, human reply window, DNC validity or email quiet hours
export function resolvePolicy(floor: PlatformFloor, packs: JurisdictionPack[], tenant: TenantPolicyVersion): ResolvedPolicy; // only tightens
export interface GateInput { now: Instant; recipient: { kind:'contact'|'user'; addressHmac: string; channel: Channel };
  purpose: Purpose; initiator: Initiator; category: ActionCategory; consent: ConsentStateRow[]; suppressions: SuppressionRow[];
  contactPoint: { status: PointStatus; lineType: LineType } | null; automationPausedAt: Instant | null;
  sender: { kind:'phone'|'email'; registration:'ready'|'pending'|'blocked'; domainVerified?: boolean } | null;
  tenant: { suspended: boolean; brokerageNamePresent: boolean; postalAddressPresent: boolean };
  rendered?: { containsBrokerageName: boolean; containsOptOutHint: boolean; paymentInstructions: boolean };
  policy: ResolvedPolicy }
export interface GateDecision { outcome: 'allow'|'deny'; reasons: ReasonCode[];   // D1: no defer, no needs_confirmation
  explanation: string; rulesVersion: string; inputsDigest: string }
export function canContact(input: GateInput): GateDecision;
export function optedOut(rows: readonly ConsentStateRow[], channel: Channel, purpose: Purpose, addressHmac: string): boolean;
export function projectConsent(events: readonly ConsentEvent[], now: Instant): Map<ConsentKey, ConsentStateRow>;
export function classifyInbound(body: string, k: Keywords): { kind: 'stop'|'start'|'help'|'wrong_number'|'opt_out_language'|'none';
  matched?: string; needsReview: boolean };
export function decideRecording(i: { agentJurisdiction?: string; clientJurisdictions: string[]; packs: JurisdictionPack[];
  mode: ResolvedPolicy['recordingMode']; direction: 'inbound'|'outbound' }): { mode: 'announced_all_parties'|'one_party_no_announcement'|'off'; announce: boolean; basis: string };
export function chooseSender(i: { stickyNumber?: NumberFacts; ownerDirect?: NumberFacts; teamMain?: NumberFacts; firstResponse: boolean }): NumberFacts | null;
export function classifyHumanPurpose(i: { lastInboundAt: Instant | null; dealOrAppointmentContext: boolean; now: Instant }): Purpose;
export function detectPaymentInstructions(text: string): boolean;
```
- **Rules:** R-CONSENT-1…12 and 16…20 (13, 14, 15 retired by D1), R-GATE-5, R-GATE-6, R-GATE-7, R-GATE-11 (decision content), R-GATE-12.
- **Tests:**
  - A table-driven test for every row of ARCHITECTURE §9 (checks 0–8).
  - No override: an opt-out or suppression denies every initiator, consent level and channel; an SMS STOP on another of the contact's phones blocks texting; email unsubscribe; agent do-not-call of either purpose; the STOP/HELP exemption cannot be abused by other initiators or channels.
  - Property tests:
    - Determinism: the same input gives the same `inputsDigest`.
    - Monotonic denial: adding a revoke or a suppression never relaxes the outcome.
    - `resolvePolicy` never widens beyond the floor or packs.
  - `classifyInbound` fixtures for E24/E25 (`"Stop by at 5?"`, `"STOP STOP"`, `"stop 🙏"`, negations).
  - `projectConsent`: START restores only keyword revokes, expired inquiry ⇒ none, `import_revert` voids grants and never revocations.
- **Accept when:**
  - Every reason code has at least one test.
  - Mutation testing (Stryker) on `gate.ts` scores at least 90 %.
  - The core version string is exported as `RULES_VERSION` for `gate_decisions.core_rules_version`.

## 3. `core/ownership`
**Path:** `packages/core/src/ownership/` (`decide.ts`, `fold.ts`, `routing.ts`, `eligibility.ts`, `timers.ts`, `merge.ts`, `dedup.ts`)

```ts
export type OwnershipState = 'unassigned'|'offered'|'owned'|'in_pond'|'closed';
export interface OwnershipProjection { state: OwnershipState; ownerUserId: UserId|null; pondId: PondId|null; offerId: string|null;
  offeredToUserId: UserId|null; offerExpiresAt: Instant|null; offerRound: number; routingRuleId: RuleId|null; ownedAt: Instant|null;
  firstTouchDueAt: Instant|null; firstTouchAt: Instant|null; firstTouchBreachedAt: Instant|null; releaseDueAt: Instant|null;
  periodSeq: number|null;      // seq that started the current ownership period (owned only): timer fences, draft binding
  routeDueAt: Instant|null;    // unassigned, awaiting system routing (after a decline)
  closedReason: CloseReason|null; seq: number /* = ledger head */ }
export type OwnershipCommand =
  | { kind:'create'; via:'intake'|'self'|'inbound' } | { kind:'route'; inquiryId?: string }
  | { kind:'accept'; offerId: string } | { kind:'decline'; offerId: string; reason?: DeclineReason }
  | { kind:'claim'; pondId: PondId } | { kind:'release'; reason: ReleaseReason; note?: string; toPondId?: PondId }
  | { kind:'assign'|'reassign'; toUserId: UserId; reason: ReasonCode; note?: string } | { kind:'isa_handoff'; toUserId: UserId; note: string }
  | { kind:'timer'; deadline:'offer_expiry'|'first_touch_breach'|'auto_release'|'inactivity_warn'|'inactivity_release';
      fence: { offerId: string } | { periodSeq: number; dueAt: Instant } }
  | { kind:'touch'; via:'call'|'sms'|'email'; refId: string; at: Instant } | { kind:'reinquiry'; inquiryId: string }
  | { kind:'close'; reason: CloseReason } | { kind:'reopen' } | { kind:'soft_delete' }
  | { kind:'merge'; survivorId: ContactId; loserId: ContactId; ownerChoice: UserId|null }
  | { kind:'deactivate_owner'; destination: 'team_lead'|'default_pond'|'reroute'; deactivationId: string }
  | { kind:'import_assign'; target: { userId: UserId } | { pondId: PondId } | 'unassigned' };
export interface DecisionContext { now: Instant; ids: IdGenerator; actor: Actor; commandId: string; settings: EffectiveLeadSettings;
  calendar: BusinessCalendar; nextContactableAt: (from: Instant) => Instant;   // from core/compliance window + zones
  routing?: RoutingSnapshot; claimStats?: { claimsToday: number; inCooldown: boolean; uncontactedOwned: number };
  pond?: PondFacts; dealOpen?: boolean; lastHumanTouchAt?: Instant|null }
export type Effect = { kind:'enqueueTimer'; jobKind: TimerKind; runAt: Instant; dedupeKey: string; fence: object }
  | { kind:'cancelTimers'; dedupeKeys: string[] } | { kind:'notify'; userId: UserId; notification: NotificationSpec }
  | { kind:'upsertFeed'; item: FeedItemSpec } | { kind:'resolveFeed'; dedupeKey: string; userId: UserId }
  | { kind:'invalidateDrafts' } | { kind:'pauseAgentEnrollments'; reason:'owner_change' } | { kind:'routingCursor'; ruleId: RuleId; cursor: object }
  | { kind:'membershipAutoPause'; userId: UserId } | { kind:'addCollaborator'; userId: UserId; role:'isa'; expiresAt: Instant }
  | { kind:'rehomeHandbacks'; toUserId: UserId|null } | { kind:'route' }
  | { kind:'setInactivityDeadlines'; warnAt: Instant|null; releaseAt: Instant|null }
  | { kind:'audit'; action: AuditAction; reason?: string };
// Effects that write other users' rows (feed items for others, rehomeHandbacks, invalidateDrafts, pauseAgentEnrollments,
// addCollaborator) and 'route' are tagged 'followup' when the actor is a user: db runs them in ownership.followup as system.
export function effectPlacement(e: Effect, actor: Actor): 'inline'|'followup';
export type Decision = { ok: true; events: OwnershipEvent[]; next: OwnershipProjection; effects: Effect[] }
                     | { ok: false; code: OwnershipErrorCode; rejection: RejectionSpec; next: OwnershipProjection /* unchanged */; effects: Effect[] };
export function decide(state: OwnershipProjection | null, cmd: OwnershipCommand, ctx: DecisionContext): Decision;
export function fold(events: readonly OwnershipEvent[]): OwnershipProjection;
export function selectCandidate(rule: RuleFacts, members: Candidate[], cursor: RotationCursor): { pick: UserId|null; cursorAfter: RotationCursor;
  considered: { userId: UserId; eligible: boolean; skipReason?: SkipReason }[] };
export function matchRule(rules: RuleFacts[], inquiry: InquiryFacts): RuleFacts | null;
export function matchContacts(candidate: NormalizedPerson, existing: ExistingMatch[]): DedupOutcome;  // exact ⇒ attach, fuzzy ⇒ suggest
```
- **Rules:** R-OWN-1…26, R-AST-7 (the `invalidateDrafts` effect), R-AST-15, R-PERM-15.
- **Tests:**
  - Property tests (fast-check) over random command sequences:
    - `decide(...).next == fold(prev ++ events)`.
    - Never two owners; shape invariants always hold.
    - `seq` is gapless, and `next.seq` is always the last event's seq (ledger head).
    - A rejected decision has no events and leaves the projection unchanged.
    - Replaying the same `commandId` is a no-op.
    - A stale fence is a no-op; a breach never stales the auto-release fence (E70).
    - No decision with a user actor contains an inline `route` or cross-user effect (`effectPlacement`).
  - Examples for every error code (`LEAD_OFFER_EXPIRED`, `…SUPERSEDED`, `…NOT_YOURS`, `MEMBERSHIP_INACTIVE`, `LEAD_ALREADY_CLAIMED`, `CLAIM_LIMIT_REACHED`, `CLAIM_COOLDOWN`, `CAPACITY_REACHED`, `POND_NOT_ELIGIBLE`, `ALREADY_OWNER`, `LEAD_STATE_CHANGED`).
  - Late accept is a rejection only; the expiry and the next offer come from the system timer (E2).
  - Decline ends in `unassigned` with `routeDueAt` (E5).
  - Inactivity deadlines are computed from the settings passed in, and a later settings change never alters a stored projection (E67).
  - RR and smooth-WRR proportions over 1,000 rounds.
  - Eligibility order and skip reasons.
  - After-hours offer window (E8).
  - Merge ownership matrix (R-OWN-24).
  - Deactivation destinations.
- **Accept when:**
  - The property suite runs 10k sequences green.
  - Every `OwnershipErrorCode` has a test.
  - The `offered` event payload always contains `candidates[]` with skip reasons.

## 4. `core/assistant`
**Path:** `packages/core/src/assistant/` (`evidence.ts`, `autonomy.ts`, `guard.ts`, `playbook.ts`, `render.ts`, `search.ts`, `prompt.ts`, `claims.ts`)

```ts
export type SourceType = 'call'|'message'|'email'|'note'|'listing'|'import'|'behavior_event'|'deal'|'task'|'appointment';
export type Locator = { kind:'transcript_offset'; startMs: number; endMs: number } | { kind:'message' }
                    | { kind:'char_range'; start: number; end: number } | { kind:'field'; name: string };
export interface EvidenceRef { sourceType: SourceType; sourceId: string; locator: Locator; snippet: string }
export interface Claim { kind: ClaimKind; text: string; structured?: unknown; evidence: EvidenceRef[]; needsReview: boolean }
export function verifyQuote(source: SourceText, ref: EvidenceRef): { verified: boolean; reason?: 'NOT_FOUND'|'OUT_OF_RANGE' };
export function normalizeClaims(raw: ModelClaims, sources: SourceIndex, ctx: { contactZone: IanaZone }): Claim[]; // resolves relative dates
export function authorizeAutonomousAction(i: { category: ActionCategory; playbookVersion: { status: string; contentSha256: string } | null;
  latestApproval: { decision:'approve'|'revoke'; contentSha256: string } | null; tenantAutonomous: ReadonlySet<ActionCategory>;
  step: PlaybookStep; rendered: string; intentCheck: 'match'|'mismatch' }): { allow: true } | { allow: false; downgrade: DowngradeReason };
export function contentGuard(text: string, step: PlaybookStep, tenant: IdentityFacts): GuardResult;   // links, length, money/contract lexicon, human-claim, sign-off
export const PlaybookStepSchema: z.ZodType<PlaybookStep>;   // stepKey, channel, delay, purpose, category, intent, template, personalization, slots, maxLength, stopIf
export function validatePlaybook(steps: PlaybookStep[]): ValidationIssue[];     // marketing intents cannot be declared informational
export function contentSha256(steps: PlaybookStep[], tone: Tone): string;       // canonical JSON
export function renderStep(step: PlaybookStep, slots: SlotValues, identity: { signOff: string; brokerageName: string; firstInThread: boolean }): string;
export const SearchCriteriaSchema: z.ZodType<SearchCriteria>;
export function proposeSearch(claims: Claim[]): { criteria: SearchCriteria; criterionEvidence: Record<string, string /*claimId*/>; unchecked: string[] };
export function matchListing(c: SearchCriteria, l: ListingFacts): boolean;
export function buildPrompt(i: { purpose: AiPurpose; contact: ContactBundle /* exactly one */; identity: IdentityFacts;
  voiceSamples: string[] /* requesting agent's own last 20 sent */ }): PromptSpec;     // inbound text delimited as untrusted
```
- **Rules:** R-AST-1…18 (pure parts), R-GATE-7, R-GATE-12, R-CONSENT-5 (purpose validation).
- **Tests:**
  - `verifyQuote` with smart quotes, whitespace, case, transcript ranges (±1 segment), and a fabricated quote that must fail.
  - Relative-date resolution across midnight and time zones (E34).
  - `authorizeAutonomousAction`: every downgrade reason, hash mismatch, revoke row, the always-human categories.
  - `contentGuard`: money/contract lexicon, "this is Sarah", missing sign-off, a missing STOP hint on the first SMS, unknown links.
  - `buildPrompt` never includes a second contact's id (property test).
  - `proposeSearch` leaves needs-review criteria unchecked.
- **Accept when:**
  - The fake AiProvider's deliberately bad outputs always end up `needsReview`.
  - The guard has zero false negatives on the lexicon fixture set.

## 5. `core/priority`
**Path:** `packages/core/src/priority/` (`feed.ts`, `exceptions.ts`, `scoreboard.ts`)

```ts
export interface FeedInputs { now: Instant; userId: UserId; offers: OfferFacts[]; slas: SlaFacts[]; unansweredInbound: InboundFacts[];
  handbacks: HandbackFacts[]; drafts: DraftFacts[]; tasks: TaskFacts[]; dealDates: DealDateFacts[]; appointments: ApptFacts[];
  blockedChannels: Map<ContactId, GateSummary> }   // NOTE: no protected-proxy fields exist on any input type (R-AST-12)
export interface FeedItem { itemType: FeedItemType; band: 'pinned'|'scored'; score: number; reasons: { code: string; label: string; points?: number }[];
  dueAt: Instant|null; dedupeKey: string; primaryAction: OneTapAction; alternatives: OneTapAction[] }
export const SCORE_VERSION = 1;
export function scoreFeed(i: FeedInputs): FeedItem[];          // pinned (deadline asc) then scored; ties: deadline, score desc, createdAt, id
export interface ExceptionInputs { now: Instant; ownedWithSla: SlaFacts[]; promiseTasks: TaskFacts[]; outbound: OutboundStatusFacts[];
  appointments: ApptFacts[]; settings: { missingOutcomeHours: 2; unknownDispatchMinutes: 10 } }
export function deriveExceptions(i: ExceptionInputs): { upserts: ExceptionItemSpec[]; cleared: string[] /* dedupe keys */ };
export function speedToLeadSummary(rows: SpeedRow[]): { medianSeconds: number|null; withinSla: number; total: number };
export function momentum(dwellDays: number, norm: { medianDays: number; sample: number }): { slow: boolean };
```
- **Rules:** R-ACC-1, R-ACC-2, R-ACC-4, R-ACC-5, R-AST-12, R-AST-15, R-IMPORT-6 (imported rows excluded).
- **Tests:**
  - Deterministic ordering (shuffle property).
  - Each reason string has a fixture.
  - A blocked SMS demotes the item but never hides it, and offers call/email instead.
  - `deriveExceptions` is idempotent (running it twice gives no new upserts) and clears when the condition stops.
  - Imported and assistant messages never count as touches.
  - The denominators are always returned.
- **Accept when:** a 200-item feed scores in < 5 ms; exception derivation over 10k contacts runs in < 200 ms in core.

## 6. `core/import`
**Path:** `packages/core/src/import/` (`csv.ts`, `fub.ts`, `plan.ts`, `consent.ts`, `report.ts`)

```ts
export type Category = 'contacts'|'ownership'|'notes'|'messages'|'call_recordings'|'consent';
export function parseCsv(bytes: Uint8Array, opts: { maxRows: 50_000 }): { headers: string[]; rows: string[][] } | { error: CsvError };
export function suggestMapping(headers: string[]): ColumnMapping;
export function normalizeCsvRow(row: string[], m: ColumnMapping, tenant: { defaultCountry:'US' }): RecordOutcome<NormalizedContact>;
export function mapFub(category: Category, raw: unknown, users: UserMapping): RecordOutcome<NormalizedRecord>;
export function dryRun(category: Category, records: NormalizedRecord[], existing: ExistingIndex): StageDryRun; // counts + per-record outcome + issues
export function mapImportedConsent(raw: FubConsentFields, provenance: object): ConsentEventSpec[];   // grants capped at imported_unverified; revokes full
export function planRevert(stage: Category, imported: ImportedRow[], touched: Set<string>): { delete: string[]; compensate: ConsentEventSpec[]; manual: string[] };
export function verificationReport(source: Counts, db: Counts): { matches: boolean; diffs: CountDiff[] };
```
- **Rules:** R-IMPORT-1, R-IMPORT-4, R-IMPORT-5, R-IMPORT-7, R-IMPORT-9, R-IMPORT-10, R-IMPORT-13, R-CONSENT-3, R-OWN-25.
- **Tests:**
  - Golden FUB export fixtures for every category, including unsubscribed, DNC, tags and custom fields going to `imported_fields`.
  - CSV edge rows (E45, BOMs, quoted newlines, formula prefixes).
  - Name-only matches are never auto-merged.
  - Consent: never above `imported_unverified`; revert never voids revocations.
- **Accept when:** a dry run of 50k fixture rows takes < 10 s in core; the report counts reconcile exactly (source = imported + needs_review + rejected + duplicate).

## 7. `db/client`
**Path:** `packages/db/src/` (`migrate.ts`, `schema.ts` (hand-written Kysely interfaces), `tenantTx.ts`, `ownership.ts`, `consent.ts`, `jobs.ts`, `repos/*`), `packages/db/test/`

```ts
export function migrate(url: string, dir: string): Promise<void>;          // numbered files, one tx each, schema_migrations table, checksum
export interface DB { contacts: ContactsTable; lead_ownership_events: LeadOwnershipEventsTable; /* … all 93 tables + 4 views … */ }
export function withTenantTx<T>(actor: Actor, fn: (tx: Kysely<DB>, now: Instant) => Promise<T>, opts?: { ownershipCommand?: string }): Promise<T>;
export function withPreTenant<T>(fn: (tx: Kysely<DB>, now: Instant) => Promise<T>, opts?: { userId?: UserId }): Promise<T>; // auth.* definers only
export function applyOwnershipCommand(actor: Actor, contactId: ContactId | null, cmd: OwnershipCommand, opts: { commandId: string;
  expectedSeq?: number }): Promise<{ outcome: Decision; projection: OwnershipProjection }>;   // lock_contact → row lock → now → decide → events|rejection → projection → effects
export function applyOwnershipCommandInTx(tx: Kysely<DB>, actor: Actor, contactId: ContactId, cmd: OwnershipCommand,
  opts: { commandId: string }): Promise<Decision>;   // same steps inside an existing tx (dispatch TX1 / dial touch; merge)
export function recordConsentEvent(tx: Kysely<DB>, e: ConsentEventSpec): Promise<ConsentStateRow[]>;  // lock_address → insert → projectConsent → upsert
export const jobs: { enqueue(tx: Kysely<DB>, j: JobSpec): Promise<void>; claim(queues: Queue[], worker: string, n: number): Promise<ClaimedJob[]>;
  finish(id: bigint, worker: string, r: { ok: true } | { ok: false; error: string; retryAt?: Instant }): Promise<void>; cancel(tx: Kysely<DB>, keys: string[]): Promise<number> };
export function lockContact(tx: Kysely<DB>, id: ContactId): Promise<void>;     // app.lock_contact
```
- **Rules:** R-TEN-1…10, R-OWN-2…7, R-CONSENT-2, R-CONSENT-6, R-AUDIT-1, R-AUDIT-2, R-DATA-4, R-DATA-5.
- **Tests:**
  - Port `rls_smoke.sql` into Vitest.
  - A **generated isolation test.** Enumerate every table with `tenant_id`, seed tenant B rows through the definer and system paths, then assert that a tenant A context gets 0 rows on SELECT, 0 rows on UPDATE, and an error on INSERT. New tables are covered automatically.
  - A two-session concurrent claim race (E1), then a release by the winner: the release must succeed (rejection log, seq = head).
  - The accept/expiry race (E3).
  - A deadlock-free lock order under 50 parallel routings.
  - Idempotent command replay (accepted and rejected).
  - Decline then re-offer with real eligibility data (other agents' memberships, push subscriptions, claim stats, rotation cursor): routing happens in `ownership.followup` as system, and the round-robin cursor advances (E5).
  - Two-session race: inbound ingestion vs a TL reassignment (E65): the handback ends with the new owner.
  - Deadline race: a human send's TX1 vs `auto_release` (E66).
  - A settings change does not move stored deadlines (E67).
  - `consent_state` stale-count rejection.
  - `EXPLAIN` snapshots showing the helper calls as InitPlans and index scans on the tenant prefix.
  - Benchmark: a contacts list at 250k contacts per tenant with p95 RLS overhead < 5 ms.
- **Accept when:**
  - The isolation test covers 100 % of tenant tables.
  - The concurrency tests are stable over 100 runs.
  - The Kysely interfaces match `information_schema` (generated drift test).

## 8. `api/platform`
**Path:** `apps/api/src/{server.ts, auth/*, rbac.ts, crypto/*, audit.ts, providers/*, errors.ts, config.ts}`

```ts
export function buildServer(cfg: Config, deps: { providers: Providers; clock: Clock; ids: IdGenerator }): FastifyInstance;
// auth routes: POST /auth/signup, /auth/login, /auth/mfa/verify, /auth/logout, /auth/reauth, /auth/password/reset{,/confirm},
//              POST /auth/invites/:token/accept, POST /auth/tenant-switch, GET /auth/session
// devices:     POST/DELETE /push-subscriptions, POST /me/alert-phone{,/verify}   (needed before routing: R-OWN-11 #4)
export function hashPassword(pw: string): Promise<string>;  /* argon2id m=64MiB t=3 p=1 */  export function verifyPassword(h: string, pw: string): Promise<boolean>;
export function issueSession(userId: UserId, tenantId: TenantId | null): Promise<{ cookie: string; sessionId: string }>; // 32 random bytes, sha256 stored
export const requireActor: preHandlerHookHandler;       // resolve_session → Actor; CSRF check on non-GET; 404 on invisible
export function authorize(action: Action, resource: (req) => Promise<ResourceFacts>): preHandlerHookHandler;   // core.can
export interface Envelope { encrypt(tenantId: TenantId, aad: Aad, plaintext: Uint8Array): Promise<Uint8Array>; decrypt(...): Promise<Uint8Array>;
  hmacAddress(tenantId: TenantId, normalized: string): Promise<Uint8Array> }
export function audit(tx: Kysely<DB>, actor: Actor, e: { action: AuditAction; entity: EntityRef; changes?: RedactedDiff; reason?: string }): Promise<void>;
export interface Providers { telephony: TelephonyProvider; email: EmailProvider; ai: AiProvider; transcription: TranscriptionProvider;
  storage: ObjectStorage; mls: MlsFeed; avm: AvmProvider; dnc: DncProvider; carrier: CarrierLookup }   // + fakes in providers/fake/*
export function verifyWebhook(provider: 'telephony'|'email'|'lead', req: FastifyRequest): boolean;
```
- **Rules:** R-AUTH (ARCHITECTURE §3: argon2id, cookie, rotation, idle/absolute, MFA, re-auth, CSRF, rate limits, uniform login errors, single-use resets), R-PERM-1, R-PERM-5, R-PERM-13, R-PERM-14, R-AUDIT-3, R-AUDIT-4, R-AUDIT-5, R-DATA-1, R-DATA-2, R-TEN-7, R-TEN-9.
- **Tests:**
  - Login timing uniformity (dummy hash).
  - Lockout after 10 failures.
  - Session rotation on login and privilege change.
  - Revoke-all on password reset.
  - A CSRF negative test.
  - An Origin allowlist test.
  - Re-auth enforcement on every sensitive route.
  - Envelope: an AAD mismatch fails, and a copy across rows/tenants fails.
  - Audit redaction snapshots.
  - Log redaction (E.164, emails).
  - Fake providers behave deterministically.
- **Accept when:**
  - OWASP ASVS L2 checklist items for auth and session pass.
  - No route lacks `authorize` (a route-table test).
  - Webhook signature failures write no tenant rows.

## 9. `api/jobs-worker`
**Path:** `apps/api/src/worker/{main.ts, loop.ts, sweeper.ts, registry.ts, handlers/*}`

```ts
export interface JobHandler<P> { kind: JobKind; queue: Queue; schema: z.ZodType<P>; run(ctx: { actor: SystemActor; tx: Kysely<DB>; now: Instant;
  providers: Providers }, payload: P): Promise<void | { retryAt: Instant }> }
export function registerHandler<P>(h: JobHandler<P>): void;
export function runWorker(opts: { queues: Queue[]; concurrency: number; worker: string }): Promise<never>;   // claim_jobs → withTenantTx(system) per job
export function runSweeper(opts: { everyMs: 15_000 }): Promise<never>;    // app.due_work → enqueue timer commands with fences (dedupe)
export function runMaintenance(): Promise<void>;                           // reap_stuck_jobs, retention_sweep, drift checks, blob deletes
```
- **Rules:** R-TEN-6, R-TEN-7, R-OWN-4 (drift job), R-OWN-15, R-CONSENT-6 (consent drift), R-DATA-3, R-AUDIT-8.
- **Tests:**
  - Kill-the-worker tests: a lease expires and the job re-runs idempotently.
  - Kill the worker between dispatch TX1 and `provider.send`, and again between `provider.send` and TX2: the re-run never re-sends, and after 20 min the sweeper's `dispatch_stale` branch yields `dispatch_unknown` and then reconciliation (E7).
  - A lost `ownership.followup` after a decline is recovered by the sweeper's `route` branch.
  - A lost job is recovered by the sweeper within 15 s.
  - A dead job raises an alert.
  - A payload with PII is rejected by its Zod schema.
  - `retention_sweep` against fixtures (E49).
  - The drift job detects a manually corrupted projection made via superuser.
- **Accept when:** realtime queue pickup is p95 < 2 s at 50 jobs/s on dev hardware; sweeper lateness stays < 30 s under backlog.

## 10. `api/admin`
**Path:** `apps/api/src/admin/{members.ts, routing.ts, ponds.ts, teams.ts, settings.ts, policy.ts, routes.ts}`

```ts
// Members:   POST /invites (Owner/Admin, 🔒), DELETE /invites/:id, PATCH /members/:userId { role?, status? } (🔒, audited diff)
// Routing:   CRUD /routing-rules (position reorder in one tx), PUT /routing-rules/:id/members [{ userId, weight }]
// Ponds:     CRUD /ponds, PUT /ponds/:id/members     Teams: CRUD /teams, PUT /teams/:id/members { userId, isLead }
// Settings:  GET/PATCH /settings (lead timers, routing hours, recording access, notification detail, ai_enabled)
//            PATCH /settings/identity (brokerage legal name, team name, license no., postal address; Owner, 🔒)
// Policy:    GET /compliance-policies, POST /compliance-policies (new append-only version; looser ⇒ Owner + 🔒 + attestation),
//            POST /compliance-policies/:id/activate
//            (D1: a version holds only autonomousCategories, optOutConfirmationSender, recordingEnabled, recordingMode)
export function proposePolicyVersion(actor: UserActor, draft: PolicyDraft): Promise<{ id: PolicyVersionId; loosening: boolean }>;
```
- **Rules:** R-PERM-1, R-PERM-2, R-PERM-3, R-PERM-13, R-PERM-14, R-AUDIT-5 (membership, settings, policy, routing/pond changes), R-GATE-12 (brokerage identity), R-OWN-10 (rule shape), R-OWN-15 (timer settings apply only to new deadlines).
- **Tests:**
  - The R-PERM-2/3 triggers through the API: Admin cannot grant Owner, the last Owner cannot be removed, identity fields are Owner-only.
  - R-PERM-13 re-auth on invites, role changes, policy loosening and identity.
  - Audit diffs for every endpoint (redaction snapshot).
  - Route × role matrix rows for `member.role`, `settings.compliance` and `settings.identity`.
  - A routing-rule reorder is atomic (deferrable unique position).
- **Accept when:** a new tenant can, through the API only, invite agents, create a team, a pond and a round-robin rule, set lead timers and brokerage identity, and publish a policy version; the next inquiry is offered to an invited agent instead of going to `NO_RULE_MATCH`.

## 11. `api/leads`
**Path:** `apps/api/src/leads/{intake.ts, routes.ts, ownership.ts, ponds.ts, contacts.ts, timeline.ts, handlers.ts}`

```ts
// POST /intake/:sourceToken        (lead source API; resolve_lead_source; idempotent by external_id/fingerprint)
// POST /contacts                   (self-created, owned by creator)          GET /contacts/:id  (card | full by visibility)
// GET  /contacts/:id/timeline      (contact_timeline view, cursor pagination)
// POST /leads/:contactId/{accept,decline,claim,release,reassign,handoff,close,reopen,merge}   body: { commandId, expectedSeq?, ... }
// GET  /ponds/:id/cards            (masked cards only)                       POST /members/:userId/deactivate (preview + run)
export function ingestInquiry(actor: SystemActor, i: InquiryInput): Promise<{ contactId: ContactId; outcome: InquiryOutcome }>;
export function runOwnershipCommand(actor: Actor, contactId: ContactId, cmd: OwnershipCommand, commandId: string, expectedSeq?: number): Promise<OwnershipResult>;
export const timerHandlers: JobHandler<TimerPayload>[];    // offer_expiry, first_touch_breach, auto_release, inactivity
```
- **Rules:** R-OWN-1…26, R-PERM-4, R-PERM-6, R-PERM-7, R-PERM-12, R-AST-16 (enqueue first response at intake), R-ACC-2 (untouched_lead input), A7d attribution capture (`original_*`, `lead_inquiries.campaign_ref/ad_ref`).
- **Tests:**
  - End-to-end edge cases E1–E5, E8, E10–E13, E18–E20, E62.
  - Pond cards never serialize contact points or the full last name (response snapshot).
  - A role × route matrix.
  - An offer push notification (row + delivery rows) is created in the same transaction as the offer.
  - A first-response job is enqueued in the intake transaction.
  - Decline → `ownership.followup` → re-offer, with eligibility seeded through the module 8 device endpoints (not direct inserts).
  - `ownership.followup` handlers: route, re-home handbacks, invalidate drafts, pause agent enrollments, as system.
- **Accept when:**
  - Lead intake to a committed offer (with its notification and delivery rows) takes < 2 s p95. Delivery latency is accepted in module 14.
  - Every ownership change is visible in the timeline with its reason. (Tap-count criteria are accepted in module 17.)

## 12. `api/comms`
**Path:** `apps/api/src/comms/{dispatch.ts, dial.ts, inbound.ts, consent.ts, numbers.ts, email.ts, recordings.ts, routes.ts}`

```ts
// POST /contacts/:id/messages  { channel, body, subject?, scheduleAt?, idempotencyKey, toPointId? }  → { message, decision, result }
// POST /contacts/:id/messages/preview  { channel, body, subject?, toPointId? } → { decision } (never stored)
// POST /messages/:id/send  {}  (re-tap of the caller's own human message; D1 removed confirmDecisionId)
// POST /contacts/:id/calls  { toPointId? } → { result: dialing|gate|failed, callId, bridgeToken, decision } (dial-time check)   POST /calls/:id/outcome
// POST /contacts/:id/consent   { kind:'record'|'revoke', channel, purpose, level?, evidence }   (agent entry ≤ express)
// POST /suppressions/:id/lift  (Owner/Admin, reauth)    GET /recordings/:id/stream (scope + audit)   admin: numbers, registrations, domains
export function dispatchOutbound(messageId: MessageId): Promise<DispatchResult>;    // TX1 gate → provider.send → TX2 (only provider-send importer)
export function dialOutbound(callId: CallId): Promise<DialResult>;
export function ingestInbound(actor: SystemActor, e: InboundEvent): Promise<IngestResult>;   // one tx: message + keywords + pause + handback
export function onRecordingReady(e: RecordingReady): Promise<void>;                 // copy → encrypt → provider delete → transcription job
export function buildGateInput(tx: Kysely<DB>, m: OutboundIntent, now: Instant): Promise<GateInput>;
```
- **Rules:** R-GATE-1…12, R-CONSENT-1…12 and 16…20 (persistence side), R-AST-9 (pause/handback), R-PERM-8, R-PERM-9, R-TEN-8, R-DATA-1.
- **Tests:**
  - **Every outbound path in ARCHITECTURE §9 has a test asserting that the gate runs at send time: a denial writes the blocked-send `gate_decisions` row and never reaches the provider fake; an allowed send writes no decision row.**
  - The DB dispatch guards (0013) refuse a forged insert or `queued → dispatching` update to an opted-out, other-phone, shared or suppressed address for every role (`packages/db/test/dispatch_guard.test.ts`).
  - STOP in the inbound transaction cancels queued SMS and pauses enrollments (E21–E23).
  - Shared-address pause.
  - The `dispatch_unknown` path (E7).
  - Out-of-order status callbacks.
  - Recording announcement failure means no recording (E47).
  - Playback is audited.
  - The 10DLC suspended path (E46).
  - Agent STOP to alert SMS (E60).
  - TX1 stamps `dispatched_at`; a scheduled agent-playbook step is blocked when the playbook owner no longer owns the contact.
- **Accept when:**
  - A lint/architecture test proves that `dispatch.ts`/`dial.ts` are the only provider-send importers.
  - A human send's TX1 records the touch in the same transaction (E66).
  - Every block shows a human sentence ("Opted out of texts").

## 13. `api/assistant`
**Path:** `apps/api/src/assistant/{runs.ts, drafts.ts, callPipeline.ts, playbooks.ts, enrollments.ts, firstResponse.ts, searches.ts, handbacks.ts, routes.ts}`

```ts
// GET /assistant/inbox (proposed actions)   POST /assistant/actions/:id/{approve,reject}  { editedPayload?, commandId }  (DRAFT_STALE, invalidated)
// POST /assistant/claims/:id/review { status:'confirmed'|'corrected'|'rejected', corrected? }
// Playbooks: GET/POST /playbooks, POST /playbooks/:id/versions, POST /playbook-versions/:id/{approve,revoke} { attestation, contentSha256 }
// Enrollments: POST /contacts/:id/enrollments, POST /enrollments/:id/{pause,resume,stop}
// Saved searches: POST /saved-searches/:id/{approve,activate,pause}, GET /saved-searches/:id/preview (matches against listings)
export function runAssistant(actor: SystemActor, purpose: AiPurpose, contactId: ContactId, trigger: TriggerRef): Promise<AssistantActionId>;
export function executePlaybookStep(actor: SystemActor, enrollmentId: EnrollmentId): Promise<StepOutcome>;  // authorize → queue → dispatchOutbound
export function sendFirstResponse(actor: SystemActor, contactId: ContactId): Promise<StepOutcome>;           // new_lead_response, ≤ 60 s
export function enrichHandback(actor: SystemActor, actionId: AssistantActionId): Promise<void>;
export function matchSavedSearches(actor: SystemActor, listingId: ListingId): Promise<void>;                  // on listing insert / price change
```
- **Rules:** R-AST-1…18, R-GATE-3, R-GATE-4, R-CONSENT-5 (purpose classification), R-ACC-2 (promise tasks with evidence), A4 (saved searches, seller-update data only, post-closing template enrolled at deal close).
- **Tests:**
  - Evidence and needs-review flow end to end with the fake AI (E33, E34).
  - Autonomous send blocked when the approval was revoked between schedule and send time (DB guard).
  - Client reply mid-flight (E22, E26).
  - Playbook edit/approve/migrate (E31, E32).
  - The 60-second first response: SMS unless the number opted out or is suppressed, else email; sent at once at any hour (D1); p95 < 60 s with the fake provider, never counted as a touch.
  - Saved search: approval needed; needs-review criteria unchecked; alerts gated.
  - The money category always routes to a draft (E35).
  - `ai_enabled=false` makes no provider calls.
- **Accept when:**
  - Every assistant card shows its explanation and evidence links, with no confidence.
  - Approving a draft or handback is 1 tap.
  - The post-closing playbook auto-enrolls at deal `closed` only when approved.

## 14. `api/workspace`
**Path:** `apps/api/src/workspace/{feed.ts, tasks.ts, appointments.ts, deals.ts, listings.ts, showings.ts, search.ts, notifications.ts, routes.ts}`

```ts
// GET /feed  → { pinned: FeedItem[]; scored: FeedItem[] }  (top 50; reasons on tap)   POST /feed/:id/{done,snooze,dismiss}
// Tasks/appointments CRUD (promise tasks show evidence), POST /appointments/:id/outcome
// Deals: CRUD + stage change (history trigger) + PUT /deals/:id/financials (human only)  — attribution copied at create
// Listings: CRUD (team) + price change (history trigger); showings + feedback logging
// GET /search?q= → { contacts, listings, deals, notes, messages } (parallel, ≤ 10 each, 300 ms timeout, RLS)
// Notifications: GET /notifications, POST /notifications/read, PUT /notification-preferences   (push subscriptions: module 8)
export function refreshFeed(tx: Kysely<DB>, userId: UserId, now: Instant): Promise<void>;     // core.scoreFeed over RLS-visible inputs
export const notificationHandlers: JobHandler<DeliveryPayload>[];                              // push / SMS-to-agent (gated) / email
```
- **Rules:** R-ACC-4 (feed parts), R-PERM-4, R-PERM-10, A7d (deal attribution + commission capture), R-AST-12, R-CONSENT-19, ARCHITECTURE §12 notification guarantees.
- **Tests:**
  - Feed visibility after reassignment (stale items hidden).
  - Critical notification kinds cannot be muted (DB CHECK, API 422).
  - At-least-once delivery with duplicate suppression through unique delivery rows.
  - Lock-screen payloads hold no phone, email or body (snapshot).
  - Search phone-digit matching and RLS (pond cards not searchable by phone).
  - Deal financials hidden from TC/ISA and the system actor.
- **Accept when:** feed p95 < 150 ms for 200 items; search p95 < 300 ms at 250k contacts; lead intake to offer push delivered (fake provider) < 2 s p95; a deal created from a contact copies attribution from one API call (the tap count is accepted in module 17).

## 15. `api/accountability`
**Path:** `apps/api/src/accountability/{exceptions.ts, scoreboard.ts, routes.ts}`

```ts
// GET /team/exceptions?type=&owner= → items with owner, evidence links, age   (TL: team; agent: own)
// POST /team/exceptions/:dedupeKey/{resolve,reassign,verify,reopen} { note?, toUserId?, commandId? }
// GET /scoreboard?userId=&range=  → { speedToLead: {median, withinSla, total}, touches, appointmentsSet, appointmentsHeld, agreementsSigned }
// GET /team/momentum → per agent: open deals by stage with dwell vs team median, slow flags
export const exceptionRecompute: JobHandler<{ scope: 'tenant' | { contactId: ContactId } }>;   // on writes + every 60 s per active tenant
```
- **Rules:** R-ACC-1…5, R-OWN-13, R-OWN-18 (reassign through the engine), R-AUDIT-5.
- **Tests:**
  - Each exception type appears and clears deterministically, including the time-only conditions (promise due, appointment end + 2 h, unknown dispatch + 10 min, dispatching + 20 min) within 60 s with no write.
  - Per-occurrence keys: a second miss on the same contact in a new ownership period is a new item (E68); a breach followed by auto-release stays in the queue until resolved or verified.
  - Recompute keeps the events.
  - A `reassigned` event without a matching ledger command is rejected by the DB (F7 trigger).
  - Verify is forbidden for agents (DB + API).
  - Reassign writes a ledger command and an exception event.
  - Scoreboard denominators.
  - Momentum uses tenant norms without exposing other agents' deals.
- **Accept when:** a TL can open an item, jump to the underlying call/message at the right offset, and resolve, reassign or verify it in ≤ 2 taps; the queue refreshes within 60 s of the underlying event.

## 16. `api/imports`
**Path:** `apps/api/src/imports/{batches.ts, fub.ts, csv.ts, stages.ts, commit.ts, revert.ts, routes.ts}`

```ts
// POST /imports { source:'csv'|'fub_api'|'fub_export', file? | apiKey? }  → connection_test counts (no promises before this)
// POST /imports/:id/snapshot   POST /imports/:id/stages/:category/dry-run   GET /imports/:id/stages/:category/records?outcome=
// POST /imports/:id/records/:rid/review { decision }   POST /imports/:id/stages/:category/{approve,commit,verify}   POST /imports/:id/revert
// GET /imports/:id/report  → per category: source | imported | needs review | rejected | duplicate
export const importHandlers: JobHandler<StagePayload>[];      // snapshot, dry_run, commit (1,000/tx resumable), verify recount
```
- **Rules:** R-IMPORT-1…13, R-CONSENT-3, R-OWN-21 (import never changes owners), R-PERM-13 (re-auth).
- **Tests:**
  - A golden FUB fixture migration end to end, including consent edge cases (E39–E44).
  - The stage-order DB guard.
  - Commit only of reviewed records.
  - A resume after a crash mid-commit.
  - Revert with touched rows.
  - FUB key purge.
  - Imported history never triggers pauses, exceptions or SLAs.
- **Accept when:** a 50k-contact FUB fixture runs dry-run → commit → verify for all six stages, with exact count reconciliation and a per-record review list; the report copy never claims more than the counts show.

## 17. `web`
**Path:** `apps/web/src/{shell/*, design/*, surfaces/{feed,contact,thread,compose,approvals,pond,deals,listings,search,tasks,team,admin,imports,settings}/*}`

```ts
// shell: auth screens (login, MFA, invite accept, tenant picker), responsive layout (bottom tab bar on phone, sidebar on desktop),
//        TanStack Query client (optimistic updates keyed by commandId; retries reuse commandId), Web Push registration,
//        offline-tolerant read cache, error-code → human sentence map (never shows raw codes), a11y (WCAG 2.2 AA).
export function useCommand<C>(path: string): { run(body: C): Promise<Result>; pending: boolean };   // commandId generated once per tap
export function GateBadge(props: { decision: GateDecisionView; lead?: string }): JSX.Element;  // blocked or nothing: "Won't send: Opted out of texts"
export function useSendCheck(i: { contactId: string; channel: 'sms'|'email'; body?: string }): { decision: DecisionView | null };  // preview, never stored
export function EvidenceLink(props: { ref: EvidenceRefView }): JSX.Element;          // "at 2:14 in the call" → opens player at offset
```
**Surfaces:**
- **Phone first:**
  - Priority Feed (pinned band with live countdown, one-tap Accept/Call/Text/Approve)
  - Contact timeline
  - Thread + compose (assistant draft prefilled)
  - Post-call outcome sheet
  - Approvals inbox (drafts, handbacks, saved-search proposals)
  - Pond cards
  - Search
- **Desktop first, still usable on a phone:**
  - Team Lead exception queue + scoreboard + momentum
  - Admin (module 10 + module 12 endpoints): members and invites, routing, ponds, teams, lead timers, numbers, domains, compliance policy with honest "not reviewed by counsel" banners (since D1: what every send is checked for, what is not checked, autonomy categories, opt-out confirmation sender, recording; no contact-hours, quiet-hours or cap settings), brokerage identity
  - Opt-out state wherever a send or call button appears (contact page, compose, approval cards: "Won't text: Opted out of texts"); a blocked send says "Not sent" and why; no consent prompts or pickers, no "send anyway"/"call anyway", no defer or quiet-hours badges (D1)
  - Imports with staged review lists (the consent stage is "Opt-outs and consent history": opt-outs carry over and block; opt-ins are history)
  - Playbook editor with approval attestation
- **Rules:** A1 (benchmarks in ARCHITECTURE §1), R-PERM-6 (masked cards), R-AST-13 (no confidence anywhere), R-ACC-4 (denominators), genuineness (no fake activity indicators, no dark patterns).
- **Tests:**
  - Playwright on a phone viewport (iPhone 13) and desktop (1440 px) for every FUB-benchmark job, with tap counts asserted.
  - Lighthouse mobile performance ≥ 90 on Feed and Contact (Moto G4 / 4G profile).
  - Visual regression for light and dark themes.
  - axe-core accessibility checks.
  - A copy lint: no "AI-powered", no fake typing indicators, assistant text always ends with the sign-off.
- **Accept when:**
  - Every job in the ARCHITECTURE §1 table meets its tap target on both viewports (accept 1 tap from the feed card, text 2 taps with a draft, call 1 tap, reassign 2 taps, …).
  - The first meaningful feed render is under 1.5 s on 4G.
  - Usability sessions with 5 agents show each benchmark job at least as fast as in their FUB baseline.

---

## Phase 1 exit criteria
1. `0001_init.sql` (plus any later migrations) applies on a clean PG16; the generated isolation test and the ported smoke suite are green.
2. Every `R-*` rule in DATA_MODEL §4 that is not **Retired** is linked to at least one passing test (a CI script maps rule ids in test names to the DATA_MODEL list, lists retired ids separately, and fails on gaps).
3. Every edge case in DATA_MODEL §5 that is not **Retired** (70 listed; E29, E30 and E36 retired by D1) has an automated test.
4. Load: 250k contacts and 50 agents per tenant across 3 tenants. Feed p95 < 150 ms, search p95 < 300 ms, realtime job pickup p95 < 2 s, 60-second first response p95 < 60 s.
5. Security review: definer catalog, RLS policies, auth (ASVS L2), envelope crypto, log redaction, provider subaccount isolation.
6. Counsel review recorded for every VERIFY WITH COUNSEL default in ARCHITECTURE §19, including D1 (relying on third-party consent with no quiet hours or frequency caps). Packs show `reviewed_by_counsel_at`, or the UI says plainly that they have not been reviewed.
