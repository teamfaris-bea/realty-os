// Provider interfaces (ARCHITECTURE §7). Adapters never receive tenant context implicitly: every call
// takes explicit ids and the decrypted credentials the caller loaded (as the system actor) from
// provider_credentials.
//
// R-GATE-2: the outbound methods are named exactly `TelephonyProvider.sendSms`,
// `TelephonyProvider.dialCall` and `EmailProvider.sendEmail`. The lint rule
// `realty/no-provider-outbound` allows them only in apps/api/src/comms/dispatch.ts, dial.ts and
// apps/api/src/providers/**, so every contact communication passes canContact at send time.
//
// Account-security messages to USERS (not contacts) are separate capabilities, outside the contact
// consent rules (ARCHITECTURE §9, last paragraph) but rate-limited and audited by their callers:
//   - AccountMailer.deliverAccountEmail (password reset, invite links)
//   - TelephonyProvider.deliverVerificationCode (alert-phone verification code, E54)
//   - PushProvider.deliverPush (web push to agents' own devices)

// ---- telephony (Twilio-shaped; one subaccount per tenant) -------------------------------------

export interface TelephonyAccount {
  /** per-tenant subaccount id (provider_credentials.external_account_ref) */
  accountRef: string;
  /** decrypted subaccount secret (provider_credentials.secret_enc) */
  secret: string;
}

export type ProviderMessageStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed' | 'unknown';

export interface SmsRequest {
  account: TelephonyAccount;
  from: string; // E.164 of a tenant number
  to: string; // E.164
  body: string;
  /** messages.id: the provider deduplicates on it, so a retried submit never double-sends */
  idempotencyKey: string;
  statusCallbackUrl?: string;
}

export interface CallRequest {
  account: TelephonyAccount;
  from: string; // tenant number shown to the client
  agentPhone: string; // the agent leg is dialled first (bridge)
  to: string; // client
  idempotencyKey: string; // calls.id
  record: boolean;
  /** announcement played to the client before recording starts (R-CONSENT-16) */
  recordingAnnouncement?: string;
  statusCallbackUrl?: string;
}

export interface TelephonyProvider {
  createSubaccount(tenantId: string, friendlyName: string): Promise<{ accountRef: string; secret: string }>;
  sendSms(r: SmsRequest): Promise<{ providerRef: string; status: ProviderMessageStatus }>;
  dialCall(r: CallRequest): Promise<{ providerRef: string }>;
  /** reconciliation of dispatch_unknown (R-GATE-8): look a submit up by its idempotency key */
  lookupMessage(account: TelephonyAccount, idempotencyKey: string): Promise<{ providerRef: string; status: ProviderMessageStatus } | null>;
  purchaseNumber(account: TelephonyAccount, opts: { areaCode?: string }): Promise<{ e164: string; providerRef: string }>;
  releaseNumber(account: TelephonyAccount, providerRef: string): Promise<void>;
  /** 10DLC / toll-free registration status (R-CONSENT-17) */
  senderRegistrationStatus(account: TelephonyAccount, registrationRef: string): Promise<'pending' | 'approved' | 'rejected' | 'suspended'>;
  fetchRecording(account: TelephonyAccount, recordingRef: string): Promise<{ bytes: Uint8Array; contentType: string; durationMs: number }>;
  /** Account-security SMS to a USER's own phone (alert-phone verification, E54). Not a contact message. */
  deliverVerificationCode(r: { to: string; code: string }): Promise<{ providerRef: string }>;
}

// ---- email ------------------------------------------------------------------------------------

export interface EmailRequest {
  from: { address: string; name: string };
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  idempotencyKey: string; // messages.id
}

export interface DomainVerification {
  domain: string;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  records: { type: 'TXT' | 'CNAME'; name: string; value: string }[];
}

export interface EmailProvider {
  sendEmail(r: EmailRequest): Promise<{ providerRef: string; status: ProviderMessageStatus }>;
  lookupMessage(idempotencyKey: string): Promise<{ providerRef: string; status: ProviderMessageStatus } | null>;
  verifyDomain(domain: string): Promise<DomainVerification>;
}

export interface AccountMailer {
  /** Password reset and invite links to a user's account email. Not a contact communication. */
  deliverAccountEmail(r: { to: string; kind: 'password_reset' | 'invite'; link: string; expiresInMinutes: number }): Promise<void>;
}

// ---- AI ---------------------------------------------------------------------------------------

export interface AiRequest {
  /** core.assistant PromptSpec fields */
  templateKey: string;
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface AiResponse {
  text: string;
  model: string;
  stopReason: 'end_turn' | 'max_tokens' | 'refusal' | 'other';
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  complete(r: AiRequest): Promise<AiResponse>;
}

// ---- transcription ----------------------------------------------------------------------------

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
}

export interface TranscriptionProvider {
  transcribe(r: { audio: Uint8Array; contentType: string; durationMs?: number; languageHint?: string }): Promise<{ segments: TranscriptSegment[]; language: string }>;
}

// ---- object storage ---------------------------------------------------------------------------

/** Holds CIPHERTEXT only (crypto/objects.ts encrypts with the per-object DEK first). */
export interface ObjectStorage {
  put(key: string, bytes: Uint8Array, opts: { contentType: string }): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

// ---- MLS, AVM, DNC, carrier -------------------------------------------------------------------

export interface MlsListing {
  mlsId: string;
  status: 'active' | 'pending' | 'sold' | 'withdrawn';
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  listPriceCents: number;
  beds: number;
  bathsX10: number;
  sqft: number | null;
  propertyType: 'single_family' | 'condo' | 'townhouse' | 'multi_family' | 'land';
  updatedAt: string; // ISO with Z
}

export interface MlsFeed {
  /** changed listings since a cursor (fake only in Phase 1: a real feed needs MLS/IDX licensing) */
  changes(since: string | null, limit: number): Promise<{ listings: MlsListing[]; cursor: string | null }>;
}

export interface AvmProvider {
  /** Phase 2 feature (monthly home-value updates): the Phase 1 fake always answers "not available". */
  estimate(address: { line1: string; city: string; region: string; postalCode: string }): Promise<{ available: false } | { available: true; valueCents: number; asOf: string }>;
}

export interface DncResult {
  phone: string; // E.164
  registry: 'us_national' | `us_state:${string}`;
  listed: boolean;
  checkedAt: string;
  validUntil: string;
}

export interface DncProvider {
  scrub(phones: readonly string[]): Promise<DncResult[]>;
}

export type LineType = 'mobile' | 'landline' | 'voip' | 'unknown';

export interface CarrierLookup {
  lookup(e164: string): Promise<{ lineType: LineType; carrier: string | null }>;
}

// ---- web push (to agents' own devices) --------------------------------------------------------

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushProvider {
  /** 'gone' means the subscription expired (410/404): the caller revokes it. */
  deliverPush(target: PushTarget, payload: { title: string; body: string; url?: string; tag?: string }): Promise<{ status: 'sent' | 'gone' | 'failed' }>;
  readonly vapidPublicKey: string | null;
}

// ---- errors -----------------------------------------------------------------------------------

/** A provider call failed. `timeout` after a submit means "unknown": reconcile, never blind-resend. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    readonly kind: 'timeout' | 'rejected' | 'unavailable' | 'not_configured',
    readonly providerCode?: string,
  ) {
    super(`provider ${kind}${providerCode ? `: ${providerCode}` : ''}`);
  }
}
