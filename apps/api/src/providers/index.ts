// The Providers bag (ARCHITECTURE §7; CONVENTIONS §3: only api/platform adds providers).
//
//   createFakeProviders()      deterministic fakes for dev and every test
//   createProviders(config)    picks real adapters where Phase 1 has one, fakes otherwise
//
// Real adapters: AI (Anthropic), web push (VAPID), telephony + line-type lookup (Twilio,
// TELEPHONY_PROVIDER=twilio), contact and account email (generic SMTP, EMAIL_PROVIDER=smtp), object
// storage (local encrypted FS, or S3-compatible with STORAGE_PROVIDER=s3; both hold ciphertext only).
// Transcription, MLS, AVM and DNC need vendor accounts/licensing and ship as interface + deterministic
// fake only. A chosen vendor without its credentials fails at start-up (config.ts) instead of silently
// using a fake.
import type { Clock } from '@realty/core/foundation';
import type { Config } from '../config.js';
import { anthropicAi } from './anthropic.js';
import { FakeAi } from './fake/ai.js';
import { FakeAvm, FakeCarrier, FakeDnc, FakeMls, FakePush, FakeTranscription } from './fake/data.js';
import { FakeAccountMailer, FakeEmail } from './fake/email.js';
import { FakeTelephony } from './fake/telephony.js';
import { SmtpAccountMailer, SmtpEmail } from './email/smtp.js';
import { S3Storage } from './s3/s3.js';
import { LocalFsStorage, MemoryStorage } from './storage.js';
import { TwilioCarrierLookup, TwilioTelephony } from './twilio/telephony.js';
import type {
  AccountMailer,
  AiProvider,
  AvmProvider,
  CarrierLookup,
  DncProvider,
  EmailProvider,
  MlsFeed,
  ObjectStorage,
  PushProvider,
  TelephonyProvider,
  TranscriptionProvider,
} from './types.js';
import { webPushProvider } from './webpush.js';
import { type FakeIntegrationAdapters, type IntegrationAdapters, createFakeIntegrations, selectIntegrations } from './integrations/index.js';
import { InProcessWebChat, type WebChatTransport } from '../channels/transport.js';
import { FakeGmail, type GmailProvider, UnconfiguredGmail } from '../mailSync/provider.js';
import { FakePublicRecords, type PublicRecordsProvider, UnconfiguredPublicRecords } from '../predict/provider.js';
import { type DocumentTextExtractor, FakeScanner, FakeTextExtractor, type MalwareScanner, UnconfiguredScanner, UnconfiguredTextExtractor } from '../documents/provider.js';

export * from './types.js';
export { FakeAi, FAKE_BAD_QUOTE, parseFakeSources } from './fake/ai.js';
export { FakeAvm, FakeCarrier, FakeDnc, FakeMls, FakePush, FakeTranscription, FAKE_MLS_LISTINGS } from './fake/data.js';
export { FakeAccountMailer, FakeEmail } from './fake/email.js';
export { FakeTelephony, type FakeFailure } from './fake/telephony.js';
export { LocalFsStorage, MemoryStorage, StorageKeyError, assertStorageKey } from './storage.js';
export { S3Storage } from './s3/s3.js';
export { SmtpAccountMailer, SmtpEmail } from './email/smtp.js';
export { TwilioCarrierLookup, TwilioTelephony, announcementTwiml, bridgeTwiml } from './twilio/telephony.js';
export type { FakeIntegrationAdapters, IntegrationAdapters } from './integrations/index.js';

export interface Providers {
  telephony: TelephonyProvider;
  email: EmailProvider;
  ai: AiProvider;
  transcription: TranscriptionProvider;
  storage: ObjectStorage;
  mls: MlsFeed;
  avm: AvmProvider;
  dnc: DncProvider;
  carrier: CarrierLookup;
  /** web push to agents' own devices (not a contact communication) */
  push: PushProvider;
  /** password reset / invite emails to users (not a contact communication, ARCHITECTURE §9) */
  accountMail: AccountMailer;
  /** Phase 2-3 adapters (module 21 api/integrations): Meta, lead feeds, MLS, AVM, calendar, publishing, showings, PDF */
  integrations: IntegrationAdapters;
  /** module 22: the web-chat transport (in-process; the visitor's poll is the delivery). Absent ⇒ chat sends fail closed. */
  webChat?: WebChatTransport;
  /** module 68 (D2): read-only Gmail (deterministic fake; production: unconfigured until a reviewed Google client exists) */
  gmail: GmailProvider;
  /** module 50: public property records, platform configuration (deterministic fake; production: unconfigured, no vendor yet, N13) */
  publicRecords: PublicRecordsProvider;
  /** module 42: the document virus scanner (deterministic fake; production: unconfigured until one is procured, N11) */
  scanner: MalwareScanner;
  /** module 42: the PDF text-layer reader for contract dates (deterministic fake; production: unconfigured, N17) */
  textExtractor: DocumentTextExtractor;
}

/** The fakes with their concrete types, so tests can inspect outboxes and inject failures. */
export interface FakeProviders extends Providers {
  telephony: FakeTelephony;
  email: FakeEmail;
  ai: FakeAi;
  transcription: FakeTranscription;
  storage: MemoryStorage;
  mls: FakeMls;
  avm: FakeAvm;
  dnc: FakeDnc;
  carrier: FakeCarrier;
  push: FakePush;
  accountMail: FakeAccountMailer;
  integrations: FakeIntegrationAdapters;
  webChat: InProcessWebChat;
  gmail: FakeGmail;
  publicRecords: FakePublicRecords;
  scanner: FakeScanner;
  textExtractor: FakeTextExtractor;
}

export function createFakeProviders(opts: { clock?: Clock } = {}): FakeProviders {
  const now = () => (opts.clock ? opts.clock.now() : 0);
  return {
    telephony: new FakeTelephony(),
    email: new FakeEmail(),
    ai: new FakeAi(),
    transcription: new FakeTranscription(),
    storage: new MemoryStorage(),
    mls: new FakeMls(),
    avm: new FakeAvm(),
    dnc: new FakeDnc(now),
    carrier: new FakeCarrier(),
    push: new FakePush(),
    accountMail: new FakeAccountMailer(),
    integrations: createFakeIntegrations(opts.clock ? { clock: opts.clock } : {}),
    webChat: new InProcessWebChat(),
    gmail: new FakeGmail(),
    publicRecords: new FakePublicRecords(),
    scanner: new FakeScanner(),
    textExtractor: new FakeTextExtractor(),
  };
}

export class ProviderConfigError extends Error {
  override readonly name = 'ProviderConfigError';
}

export function createProviders(config: Config, opts: { clock: Clock; fetch?: typeof fetch }): Providers {
  const fakes = createFakeProviders(opts);
  let telephony: TelephonyProvider = fakes.telephony;
  let carrier: CarrierLookup = fakes.carrier;
  if (config.providers.telephony === 'twilio') {
    const t = config.twilio;
    if (!t) throw new ProviderConfigError('TELEPHONY_PROVIDER=twilio needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    const f = opts.fetch ? { fetch: opts.fetch } : {};
    telephony = new TwilioTelephony({ accountSid: t.accountSid, authToken: t.authToken, publicBaseUrl: config.publicBaseUrl, numberCountry: t.numberCountry, ...(t.platformSender ? { platformSender: t.platformSender } : {}), ...f });
    carrier = new TwilioCarrierLookup({ accountSid: t.accountSid, authToken: t.authToken, ...f });
  }
  let email: EmailProvider = fakes.email;
  let accountMail: AccountMailer = fakes.accountMail;
  if (config.providers.email === 'smtp') {
    const m = config.smtp;
    if (!m) throw new ProviderConfigError('EMAIL_PROVIDER=smtp needs SMTP_HOST');
    const o = {
      host: m.host,
      port: m.port,
      secure: m.secure,
      vendor: m.vendor,
      dkimSelectors: m.dkimSelectors,
      ...(m.username ? { username: m.username } : {}),
      ...(m.password ? { password: m.password } : {}),
      ...(m.postmarkMessageStream ? { postmarkMessageStream: m.postmarkMessageStream } : {}),
      ...(m.sesConfigurationSet ? { sesConfigurationSet: m.sesConfigurationSet } : {}),
      ...(m.spfInclude ? { spfInclude: m.spfInclude } : {}),
    };
    email = new SmtpEmail(o);
    accountMail = new SmtpAccountMailer({ ...o, from: m.accountFrom });
  }
  let ai: AiProvider = fakes.ai;
  if (config.providers.ai === 'real') {
    if (!config.anthropicApiKey) throw new ProviderConfigError('AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
    ai = anthropicAi({ apiKey: config.anthropicApiKey, model: config.aiModel });
  }
  let push: PushProvider = fakes.push;
  if (config.providers.push === 'real') {
    if (!config.vapid) throw new ProviderConfigError('PUSH_PROVIDER=webpush needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY');
    push = webPushProvider(config.vapid);
  }
  let storage: ObjectStorage = fakes.storage;
  if (config.providers.storage === 'local') storage = new LocalFsStorage(config.storageDir);
  if (config.providers.storage === 's3') {
    const b = config.s3;
    if (!b) throw new ProviderConfigError('STORAGE_PROVIDER=s3 needs S3_BUCKET');
    storage = new S3Storage({
      bucket: b.bucket,
      region: b.region,
      accessKeyId: b.accessKeyId,
      secretAccessKey: b.secretAccessKey,
      forcePathStyle: b.forcePathStyle,
      serverSideEncryption: b.serverSideEncryption,
      ...(b.endpoint ? { endpoint: b.endpoint } : {}),
      ...(b.sessionToken ? { sessionToken: b.sessionToken } : {}),
      ...(b.prefix ? { prefix: b.prefix } : {}),
      ...(b.kmsKeyId ? { kmsKeyId: b.kmsKeyId } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }
  const integrations = selectIntegrations(config);
  // module 68: no Google OAuth client is configured in this build (fakes only, VERIFY before any real adapter)
  const gmail: GmailProvider = config.env === 'production' && !config.allowFakeProviders ? new UnconfiguredGmail() : fakes.gmail;
  // module 50: no public-records vendor is procured (N13); production looks nothing up unless fakes are allowed
  const publicRecords: PublicRecordsProvider = config.env === 'production' && !config.allowFakeProviders ? new UnconfiguredPublicRecords() : fakes.publicRecords;
  // module 42: no scanner (N11) or PDF reader (N17) is procured; production never gets the fakes, which pass every file
  const scanner: MalwareScanner = config.env === 'production' && !config.allowFakeProviders ? new UnconfiguredScanner() : fakes.scanner;
  const textExtractor: DocumentTextExtractor = config.env === 'production' && !config.allowFakeProviders ? new UnconfiguredTextExtractor() : fakes.textExtractor;
  return { ...fakes, telephony, carrier, email, accountMail, ai, push, storage, integrations, gmail, publicRecords, scanner, textExtractor };
}
