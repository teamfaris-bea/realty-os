// The Providers bag (ARCHITECTURE §7; CONVENTIONS §3: only api/platform adds providers).
//
//   createFakeProviders()      deterministic fakes for dev and every test
//   createProviders(config)    picks real adapters where Phase 1 has one, fakes otherwise
//
// Real adapters available in Phase 1: AI (Anthropic), web push (VAPID), local encrypted object
// storage. Telephony (Twilio-shaped), contact email, transcription, MLS, AVM, DNC and carrier
// lookup need vendor accounts/licensing and ship as interface + deterministic fake only; asking for
// a real one fails fast at start-up instead of silently using a fake.
import type { Clock } from '@realty/core/foundation';
import type { Config } from '../config.js';
import { anthropicAi } from './anthropic.js';
import { FakeAi } from './fake/ai.js';
import { FakeAvm, FakeCarrier, FakeDnc, FakeMls, FakePush, FakeTranscription } from './fake/data.js';
import { FakeAccountMailer, FakeEmail } from './fake/email.js';
import { FakeTelephony } from './fake/telephony.js';
import { LocalFsStorage, MemoryStorage } from './storage.js';
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

export * from './types.js';
export { FakeAi, FAKE_BAD_QUOTE, parseFakeSources } from './fake/ai.js';
export { FakeAvm, FakeCarrier, FakeDnc, FakeMls, FakePush, FakeTranscription, FAKE_MLS_LISTINGS } from './fake/data.js';
export { FakeAccountMailer, FakeEmail } from './fake/email.js';
export { FakeTelephony, type FakeFailure } from './fake/telephony.js';
export { LocalFsStorage, MemoryStorage, StorageKeyError, assertStorageKey } from './storage.js';

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
  };
}

export class ProviderConfigError extends Error {
  override readonly name = 'ProviderConfigError';
}

export function createProviders(config: Config, opts: { clock: Clock }): Providers {
  const fakes = createFakeProviders(opts);
  if (config.providers.telephony === 'real') {
    throw new ProviderConfigError('TELEPHONY_PROVIDER=real: no telephony vendor adapter in Phase 1 (interface + fake only)');
  }
  if (config.providers.email === 'real') {
    throw new ProviderConfigError('EMAIL_PROVIDER=real: no email vendor adapter in Phase 1 (interface + fake only; open question Q8)');
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
  const storage: ObjectStorage = config.providers.storage === 'local' ? new LocalFsStorage(config.storageDir) : fakes.storage;
  return { ...fakes, ai, push, storage };
}
