// Process configuration (BUILD_PLAN module 8). Parsed once from the environment with Zod; nothing
// else in apps/api reads process.env. Secrets are decoded here and never logged (see `redactConfig`).
//
// SHARED REGISTRATION FILE (CONVENTIONS §2): api/platform owns it. A module that needs a new setting
// adds one field to `ConfigSchema` + one line in `loadConfig` and the matching `.env.example` key.
import { createHmac } from 'node:crypto';
import { z } from 'zod';

const base64Key = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .transform((s, ctx) => {
      const b = Buffer.from(s, 'base64');
      if (b.length !== 32) {
        ctx.addIssue({ code: 'custom', message: `${name} must be 32 bytes of base64` });
        return z.NEVER;
      }
      return new Uint8Array(b);
    });

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const providerKind = z.enum(['fake', 'real']).default('fake');
/** an SNS topic ARN (aws, aws-cn, aws-us-gov partitions) */
const SNS_TOPIC_ARN = /^arn:aws(-cn|-us-gov)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/;

const TwilioSchema = z.object({
  accountSid: z.string().regex(/^AC[0-9a-f]{32}$/, 'TWILIO_ACCOUNT_SID must look like AC + 32 hex'),
  authToken: z.string().min(16),
  platformSender: z.string().optional(),
  numberCountry: z.string().regex(/^[A-Z]{2}$/).default('US'),
});

const SmtpSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.enum(['tls', 'starttls', 'none']),
  username: z.string().optional(),
  password: z.string().optional(),
  vendor: z.enum(['generic', 'postmark', 'sendgrid', 'ses', 'mailgun']).default('generic'),
  postmarkMessageStream: z.string().optional(),
  sesConfigurationSet: z.string().optional(),
  dkimSelectors: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).default([]),
  spfInclude: z.string().optional(),
  /** sender of account emails (password reset, invites) */
  accountFrom: z.object({ address: z.email(), name: z.string().min(1) }),
});

const S3Schema = z.object({
  bucket: z.string().min(3),
  region: z.string().min(1),
  endpoint: z.url().optional(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().optional(),
  forcePathStyle: z.boolean(),
  prefix: z.string().regex(/^[A-Za-z0-9_\-/]*$/).optional(),
  serverSideEncryption: z.enum(['AES256', 'aws:kms']).nullable(),
  kmsKeyId: z.string().optional(),
});

export const ConfigSchema = z.object({
  env: z.enum(['development', 'test', 'production']).default('development'),
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
  /**
   * Connections in the API process's app_user pool (DB_POOL_MAX; docs/DEPLOY.md). Default 10: the pg
   * default the API always ran with, and the best of 10/20/30/45 for 45+ simultaneous taps against a
   * 4-core database (docs/PERFORMANCE.md, accept/claim): a larger pool only moves the queue into Postgres.
   */
  databasePoolMax: z.coerce.number().int().min(2).max(200).default(10),
  apiPort: z.coerce.number().int().min(1).max(65535).default(3001),
  apiHost: z.string().default('127.0.0.1'),
  /** CSRF Origin allowlist and CORS origins (WEB_ORIGIN, comma-separated). */
  webOrigins: z.array(z.url()).min(1),
  /** Public base URL of the API (webhook signature URLs, links in account emails). */
  publicBaseUrl: z.url(),
  /** Secure cookie: `__Host-sid` with Secure; false only for plain-http local dev (`sid`). */
  cookieSecure: z.boolean(),
  /** Trust X-Forwarded-For from the edge proxy (production behind a load balancer only). */
  trustProxy: z.boolean(),
  /** 32-byte key-encryption key (dev); production replaces it with a KMS-backed KEK. */
  kek: z.instanceof(Uint8Array),
  kekRef: z.string().min(1),
  /** 32-byte server secret: CSRF token HMAC, rate-limit key HMAC, verification challenges. */
  sessionSecret: z.instanceof(Uint8Array),
  /** production may run fakes only when this is set explicitly (a staging demo); never for real teams */
  allowFakeProviders: z.boolean().default(false),
  webhookSecrets: z.object({ telephony: z.string().min(16), email: z.string().min(16), lead: z.string().min(16) }),
  providers: z.object({
    ai: providerKind,
    telephony: z.enum(['fake', 'twilio']).default('fake'),
    email: z.enum(['fake', 'smtp']).default('fake'),
    storage: z.enum(['fake', 'local', 's3']).default('local'),
    push: providerKind,
  }),
  twilio: TwilioSchema.optional(),
  smtp: SmtpSchema.optional(),
  s3: S3Schema.optional(),
  /** which inbound-email webhook formats are accepted besides the generic signed one */
  emailInbound: z.object({
    formats: z.array(z.enum(['postmark', 'sendgrid', 'ses', 'mailgun'])),
    /** HTTP Basic credentials embedded in the vendor webhook URL (Postmark; SendGrid Inbound Parse) */
    basicAuth: z.object({ username: z.string().min(1), password: z.string().min(16) }).optional(),
    /** SendGrid Event Webhook ECDSA public key (base64 DER, from the SendGrid console) */
    sendgridEventPublicKey: z.string().optional(),
    /** 'ses': the SNS topics whose (AWS-signed) notifications are accepted (SES_SNS_TOPIC_ARNS) */
    sesSnsTopicArns: z.array(z.string().regex(SNS_TOPIC_ARN)).optional(),
    /** 'mailgun': the HTTP webhook signing key (MAILGUN_WEBHOOK_SIGNING_KEY, from the Mailgun console) */
    mailgunWebhookSigningKey: z.string().min(1).optional(),
  }),
  /** api: how long /ready reports 503 before the server stops accepting (load balancer drain) */
  shutdownDrainMs: z.coerce.number().int().min(0).max(120_000).default(5_000),
  /** api and worker: hard deadline for a graceful stop before the process exits anyway */
  shutdownTimeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  anthropicApiKey: z.string().optional(),
  aiModel: z.string().default('claude-opus-5-5'),
  storageDir: z.string().default('.storage'),
  vapid: z.object({ publicKey: z.string(), privateKey: z.string(), subject: z.string() }).optional(),
  /** Follow Up Boss import adapter (SECURITY §2.9): server config only, never tenant input; checked in `fubSettings` */
  fub: z.object({
    provider: providerKind,
    baseUrl: z.url({ protocol: /^https$/ }),
    allowedHosts: z.array(z.string()).min(1),
    /** FUB registered-system headers (X-System / X-System-Key), when the account requires them */
    system: z.object({ name: z.string().min(1), key: z.string().min(1) }).optional(),
    /** owner decision B7: the endpoints FUB tasks and appointments are counted at (VERIFY; default tasks, appointments) */
    countOnlyPaths: z.object({ tasks: z.string().optional(), appointments: z.string().optional() }).optional(),
  }),
  /**
   * Read-only MLS feed (Spark RESO Web API; docs/DEPLOY.md "Spark MLS (read-only)"). Nonsecret settings only:
   * the access token is never configuration, it lives in provider_credentials (provider 'mls') of the tenant.
   */
  /**
   * Lead-email intake (module 22 slice; docs/DEPLOY.md "Lead email intake"). inboundDomain: the domain whose MX the
   * email provider receives for (addresses leads+<key>@<inboundDomain>); null = not set up, nothing can be enabled.
   * Dev/test default to a reserved `.invalid` domain (never a real one). authservId: the receiving provider's own
   * Authentication-Results authserv-id; only that header (the topmost one) is believed for the Postmark format.
   */
  leadEmail: z.object({
    inboundDomain: z.string().regex(/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/).nullable(),
    authservId: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/).nullable(),
  }),
  mls: z.object({
    provider: z.enum(['fake', 'spark']),
    /** kill switch: false (the default everywhere) means the Spark adapter makes no network call at all */
    liveCalls: z.boolean(),
    spark: z.object({
      baseUrl: z.url({ protocol: /^https$/ }),
      allowedHosts: z.array(z.string()).min(1),
      /** VERIFY with Spark: its docs show both "Bearer" and "OAuth" as the Authorization scheme */
      authScheme: z.enum(['Bearer', 'OAuth']),
    }),
  }),
  /** General per-session/IP request budget (in-memory, per process). Auth routes add DB-backed limits. */
  globalRateLimitPerMinute: z.coerce.number().int().min(10).default(600),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Derives a stable dev-only webhook secret from the session secret (so dev needs no extra keys). */
function devDerived(secret: Uint8Array, label: string): string {
  return createHmac('sha256', secret).update(`dev-webhook-secret:${label}`).digest('hex');
}

const list = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function pick<T extends string>(name: string, v: string | undefined, allowed: readonly T[], dflt: T): T {
  const x = (v ?? '').trim();
  if (x === '') return dflt;
  if ((allowed as readonly string[]).includes(x)) return x as T;
  throw new ConfigError(`${name} must be one of ${allowed.join(', ')}`);
}

/** FUB's own API (the defaults of FUB_BASE_URL / FUB_ALLOWED_HOSTS; imports/fub.ts DEFAULT_FUB_* match). */
const FUB_DEFAULT_BASE_URL = 'https://api.followupboss.com/v1';
const FUB_DEFAULT_HOSTS = ['api.followupboss.com'];
/** a lowercase dotted DNS name: no scheme, port, path, credentials or wildcard */
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** the same internal-name rule as push endpoints (auth/devices.ts INTERNAL_SUFFIX) */
const INTERNAL_HOST = /(^|\.)(localhost|local|internal|intranet|corp|lan|home|home\.arpa)$/;
const isPublicDnsName = (h: string) => DNS_NAME.test(h) && !/\.[0-9]+$/.test(h) && !INTERNAL_HOST.test(h);
/** One plain path segment below FUB_BASE_URL: the same rule as imports/fub.ts FUB_PATH_SEGMENT (config does not import the adapter). */
const FUB_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * FUB_PROVIDER, FUB_BASE_URL, FUB_ALLOWED_HOSTS, FUB_SYSTEM_NAME/KEY, FUB_TASKS_PATH, FUB_APPOINTMENTS_PATH (SSRF guard, SECURITY §2.9), checked at
 * startup: every allow-list entry is a lowercase public host name; the base URL is https on the default port,
 * without credentials, query or fragment, and its host is on the list. Problems are pushed by key, never value.
 * The adapter re-checks the same rule when it is built (imports/fub.ts checkFubBaseUrl).
 */
function fubSettings(env: NodeJS.ProcessEnv, missing: string[], invalid: string[]) {
  const provider = pick('FUB_PROVIDER', env.FUB_PROVIDER, ['fake', 'real'] as const, 'fake');
  const hosts = [...new Set(list(env.FUB_ALLOWED_HOSTS))];
  if (hosts.some((h) => !isPublicDnsName(h))) invalid.push('FUB_ALLOWED_HOSTS must list lowercase public host names only (no scheme, port, path or wildcard)');
  const allowedHosts = hosts.length > 0 ? hosts : [...FUB_DEFAULT_HOSTS];
  const raw = (env.FUB_BASE_URL ?? '').trim() || FUB_DEFAULT_BASE_URL;
  let u: URL | null;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }
  let baseUrl = FUB_DEFAULT_BASE_URL;
  if (!u || u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || /[?#]/.test(raw) || !isPublicDnsName(u.hostname)) {
    invalid.push('FUB_BASE_URL must be https on the default port, without credentials, query or fragment, naming a public host');
  } else if (!allowedHosts.includes(u.hostname)) invalid.push('FUB_BASE_URL host must be listed in FUB_ALLOWED_HOSTS');
  else baseUrl = u.href.replace(/\/+$/, '');
  const name = env.FUB_SYSTEM_NAME?.trim();
  const key = env.FUB_SYSTEM_KEY?.trim();
  if (name && !key) missing.push('FUB_SYSTEM_KEY');
  if (key && !name) missing.push('FUB_SYSTEM_NAME');
  // owner decision B7 (E233): where FUB tasks and appointments are COUNTED (never read). VERIFY the names against a
  // real account; each is one plain path segment below FUB_BASE_URL, so it can never leave the checked host
  const countOnlyPaths: { tasks?: string; appointments?: string } = {};
  for (const [k, field] of [['FUB_TASKS_PATH', 'tasks'], ['FUB_APPOINTMENTS_PATH', 'appointments']] as const) {
    const v = (env[k] ?? '').trim();
    if (v === '') continue;
    if (!FUB_PATH_SEGMENT.test(v)) invalid.push(`${k} must be one plain path segment (letters, digits, - and _)`);
    else countOnlyPaths[field] = v;
  }
  return { provider, baseUrl, allowedHosts, ...(name && key ? { system: { name, key } } : {}), ...(Object.keys(countOnlyPaths).length > 0 ? { countOnlyPaths } : {}) };
}

/** Spark's RESO Web API (the defaults of SPARK_API_BASE_URL / SPARK_ALLOWED_HOSTS; mls/spark/http.ts matches). */
const SPARK_DEFAULT_BASE_URL = 'https://sparkapi.com';
const SPARK_DEFAULT_HOSTS = ['sparkapi.com'];

/**
 * MLS_PROVIDER, MLS_LIVE_CALLS, SPARK_API_BASE_URL, SPARK_ALLOWED_HOSTS, SPARK_AUTH_SCHEME (SSRF guard, SECURITY
 * "Spark MLS (read-only)"). With MLS_PROVIDER=spark the base URL must be https on the default port, without
 * credentials, path, query or fragment, naming a public host on the allow-list (refused in every environment,
 * production included). MLS_LIVE_CALLS defaults to false everywhere. No setting here is ever a credential.
 */
function mlsSettings(env: NodeJS.ProcessEnv, invalid: string[]) {
  const provider = pick('MLS_PROVIDER', env.MLS_PROVIDER, ['fake', 'spark'] as const, 'fake');
  const live = (env.MLS_LIVE_CALLS ?? '').trim().toLowerCase();
  if (live !== '' && live !== 'true' && live !== 'false') invalid.push('MLS_LIVE_CALLS must be true or false');
  const liveCalls = live === 'true';
  const authScheme = pick('SPARK_AUTH_SCHEME', env.SPARK_AUTH_SCHEME, ['Bearer', 'OAuth'] as const, 'Bearer');
  const hosts = [...new Set(list(env.SPARK_ALLOWED_HOSTS))];
  if (hosts.some((h) => !isPublicDnsName(h))) invalid.push('SPARK_ALLOWED_HOSTS must list lowercase public host names only (no scheme, port, path or wildcard)');
  const allowedHosts = hosts.length > 0 ? hosts : [...SPARK_DEFAULT_HOSTS];
  const raw = (env.SPARK_API_BASE_URL ?? '').trim() || SPARK_DEFAULT_BASE_URL;
  let u: URL | null;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }
  let baseUrl = SPARK_DEFAULT_BASE_URL;
  const ok = u !== null && u.protocol === 'https:' && u.port === '' && u.username === '' && u.password === '' && !/[?#]/.test(raw) && (u.pathname === '/' || u.pathname === '') && isPublicDnsName(u.hostname);
  if (!ok) {
    if (provider === 'spark') invalid.push('SPARK_API_BASE_URL must be https on the default port, without credentials, path, query or fragment, naming a public host');
  } else if (!allowedHosts.includes(u!.hostname)) {
    if (provider === 'spark') invalid.push('SPARK_API_BASE_URL host must be listed in SPARK_ALLOWED_HOSTS');
  } else baseUrl = u!.origin;
  return { provider, liveCalls, spark: { baseUrl, allowedHosts, authScheme } };
}

/**
 * Builds the Config from an environment map (default: process.env). Throws ConfigError, whose message names
 * the offending variables and never their values. Choosing a real vendor adapter without its credentials
 * fails in every environment; production additionally refuses fakes, plain-http URLs and dev-derived secrets
 * (all problems are reported at once, so a deploy fails with the full list).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const kekRaw = base64Key('KEK_BASE64').safeParse(env.KEK_BASE64 ?? '');
  const secretRaw = base64Key('SESSION_SECRET_BASE64').safeParse(env.SESSION_SECRET_BASE64 ?? '');
  if (!kekRaw.success) throw new ConfigError(kekRaw.error.issues[0]?.message ?? 'KEK_BASE64 invalid');
  if (!secretRaw.success) throw new ConfigError(secretRaw.error.issues[0]?.message ?? 'SESSION_SECRET_BASE64 invalid');
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const prod = nodeEnv === 'production';
  const origins = list(env.WEB_ORIGIN ?? 'http://localhost:5173');
  const port = env.API_PORT ?? '3001';
  const secret = secretRaw.data;
  const missing: string[] = [];
  const invalid: string[] = [];
  const need = (key: string): string | undefined => {
    const v = env[key];
    if (v === undefined || v.trim() === '') {
      missing.push(key);
      return undefined;
    }
    return v.trim();
  };

  const providers = {
    ai: env.AI_PROVIDER === 'anthropic' || env.AI_PROVIDER === 'real' ? ('real' as const) : ('fake' as const),
    telephony: pick('TELEPHONY_PROVIDER', env.TELEPHONY_PROVIDER, ['fake', 'twilio'] as const, 'fake'),
    email: pick('EMAIL_PROVIDER', env.EMAIL_PROVIDER, ['fake', 'smtp'] as const, 'fake'),
    storage: pick('STORAGE_PROVIDER', env.STORAGE_PROVIDER, ['fake', 'local', 's3'] as const, 'local'),
    push: env.PUSH_PROVIDER === 'webpush' || env.PUSH_PROVIDER === 'real' ? ('real' as const) : ('fake' as const),
  };
  const allowFakeProviders = bool.parse(env.ALLOW_FAKE_PROVIDERS || undefined);
  const formats = list(env.EMAIL_INBOUND_FORMATS).map((f) => pick('EMAIL_INBOUND_FORMATS', f, ['postmark', 'sendgrid', 'ses', 'mailgun'] as const, 'postmark'));

  const wh = (key: string, label: string, requiredInProd: boolean): string => {
    const v = env[key];
    if (v) return v;
    if (prod && requiredInProd) missing.push(key);
    return devDerived(secret, label);
  };
  const webhookSecrets = {
    // with Twilio the guard verifies each subaccount's own signature; this secret only signs the fake's callbacks
    telephony: wh('TELEPHONY_WEBHOOK_SECRET', 'telephony', providers.telephony === 'fake'),
    // the generic signed inbound/events format is the only way in when no vendor format is enabled
    email: wh('EMAIL_WEBHOOK_SECRET', 'email', formats.length === 0),
    lead: wh('LEAD_WEBHOOK_SECRET', 'lead', true),
  };

  const twilio =
    providers.telephony === 'twilio'
      ? { accountSid: need('TWILIO_ACCOUNT_SID'), authToken: need('TWILIO_AUTH_TOKEN'), platformSender: prod ? need('TWILIO_PLATFORM_SENDER') : env.TWILIO_PLATFORM_SENDER || undefined, numberCountry: env.TWILIO_NUMBER_COUNTRY || undefined }
      : undefined;
  const smtpSecure = pick('SMTP_SECURE', env.SMTP_SECURE, ['tls', 'starttls', 'none'] as const, 'starttls');
  if (providers.email === 'smtp' && prod && smtpSecure === 'none') invalid.push('SMTP_SECURE must be tls or starttls in production');
  const smtp =
    providers.email === 'smtp'
      ? {
          host: need('SMTP_HOST'),
          port: env.SMTP_PORT || (smtpSecure === 'tls' ? '465' : '587'),
          secure: smtpSecure,
          username: prod ? need('SMTP_USERNAME') : env.SMTP_USERNAME || undefined,
          password: prod ? need('SMTP_PASSWORD') : env.SMTP_PASSWORD || undefined,
          vendor: env.SMTP_VENDOR || undefined,
          postmarkMessageStream: env.SMTP_POSTMARK_MESSAGE_STREAM || undefined,
          sesConfigurationSet: env.SMTP_SES_CONFIGURATION_SET || undefined,
          dkimSelectors: list(env.EMAIL_DKIM_SELECTORS),
          spfInclude: env.EMAIL_SPF_INCLUDE || undefined,
          accountFrom: { address: need('ACCOUNT_EMAIL_FROM') ?? '', name: env.ACCOUNT_EMAIL_FROM_NAME || 'Realty OS' },
        }
      : undefined;
  const sse = pick('S3_SSE', env.S3_SSE, ['none', 'AES256', 'aws:kms'] as const, 'none');
  const s3 =
    providers.storage === 's3'
      ? {
          bucket: need('S3_BUCKET'),
          region: need('S3_REGION'),
          endpoint: env.S3_ENDPOINT || undefined,
          accessKeyId: need('S3_ACCESS_KEY_ID'),
          secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
          sessionToken: env.S3_SESSION_TOKEN || undefined,
          forcePathStyle: bool.parse(env.S3_FORCE_PATH_STYLE || undefined),
          prefix: env.S3_PREFIX || undefined,
          serverSideEncryption: sse === 'none' ? null : sse,
          kmsKeyId: env.S3_KMS_KEY_ID || undefined,
        }
      : undefined;
  const basicAuth =
    formats.includes('postmark') || formats.includes('sendgrid') ? { username: need('EMAIL_WEBHOOK_BASIC_USER') ?? '', password: need('EMAIL_WEBHOOK_BASIC_PASSWORD') ?? '' } : undefined;
  const sendgridEventPublicKey = formats.includes('sendgrid') ? need('SENDGRID_EVENT_PUBLIC_KEY') : undefined;
  const sesSnsTopicArns = formats.includes('ses') ? list(env.SES_SNS_TOPIC_ARNS) : undefined;
  if (sesSnsTopicArns?.length === 0) missing.push('SES_SNS_TOPIC_ARNS');
  if (sesSnsTopicArns?.some((a) => !SNS_TOPIC_ARN.test(a))) invalid.push('SES_SNS_TOPIC_ARNS must list SNS topic ARNs (arn:aws:sns:<region>:<account id>:<topic>)');
  const mailgunWebhookSigningKey = formats.includes('mailgun') ? need('MAILGUN_WEBHOOK_SIGNING_KEY') : undefined;
  // bounces, complaints and unsubscribes must reach the app: an SES or Mailgun relay needs its event format
  // (or the generic signed format through a bridge, which needs its own EMAIL_WEBHOOK_SECRET)
  const relay = smtp?.vendor;
  if (prod && (relay === 'ses' || relay === 'mailgun') && !formats.includes(relay) && !env.EMAIL_WEBHOOK_SECRET) {
    invalid.push(`SMTP_VENDOR=${relay} needs ${relay} in EMAIL_INBOUND_FORMATS (or EMAIL_WEBHOOK_SECRET for a bridge to the generic format) in production`);
  }
  const fub = fubSettings(env, missing, invalid);
  const mls = mlsSettings(env, invalid);

  if (prod) {
    // the name stamped on every key the KEK wraps (tenant_keys.kek_ref); rotation (DEPLOY §9) needs a real one
    if (!(env.KEK_REF ?? '').trim()) missing.push('KEK_REF');
    if (!env.PUBLIC_BASE_URL) missing.push('PUBLIC_BASE_URL');
    else if (!/^https:\/\//.test(env.PUBLIC_BASE_URL)) invalid.push('PUBLIC_BASE_URL must be https');
    if (!env.WEB_ORIGIN) missing.push('WEB_ORIGIN');
    else if (origins.some((o) => !o.startsWith('https://'))) invalid.push('WEB_ORIGIN must list https origins only');
    if (!allowFakeProviders) {
      if (providers.telephony === 'fake') invalid.push('TELEPHONY_PROVIDER must be twilio in production');
      if (providers.email === 'fake') invalid.push('EMAIL_PROVIDER must be smtp in production');
      if (providers.storage === 'fake') invalid.push('STORAGE_PROVIDER must be s3 or local in production');
      if (providers.ai === 'fake') invalid.push('AI_PROVIDER must be anthropic in production');
      if (providers.push === 'fake') invalid.push('PUSH_PROVIDER must be webpush in production');
    }
    if (providers.storage === 'local' && !(env.STORAGE_DIR ?? '').startsWith('/')) invalid.push('STORAGE_DIR must be an absolute path on a persistent, backed-up volume when STORAGE_PROVIDER=local');
  }
  if (providers.ai === 'real' && !env.ANTHROPIC_API_KEY && prod) missing.push('ANTHROPIC_API_KEY');
  if (providers.push === 'real' && prod) {
    if (!env.VAPID_PUBLIC_KEY) missing.push('VAPID_PUBLIC_KEY');
    if (!env.VAPID_PRIVATE_KEY) missing.push('VAPID_PRIVATE_KEY');
    if (!env.VAPID_SUBJECT) missing.push('VAPID_SUBJECT');
  }
  if (missing.length || invalid.length) {
    const parts = [...(missing.length ? [`missing ${[...new Set(missing)].join(', ')}`] : []), ...invalid];
    throw new ConfigError(`${prod ? 'production ' : ''}configuration is incomplete: ${parts.join('; ')}`);
  }

  const vapid =
    env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? 'mailto:ops@example.invalid' }
      : undefined;
  const parsed = ConfigSchema.safeParse({
    env: nodeEnv,
    databaseUrl: env.DATABASE_URL ?? '',
    apiPort: port,
    apiHost: env.API_HOST,
    webOrigins: origins,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    cookieSecure: env.SESSION_COOKIE_SECURE === undefined ? prod : bool.parse(env.SESSION_COOKIE_SECURE),
    trustProxy: bool.parse(env.TRUST_PROXY),
    kek: kekRaw.data,
    kekRef: env.KEK_REF ?? 'local-kek:v1',
    sessionSecret: secret,
    allowFakeProviders,
    webhookSecrets,
    providers,
    twilio,
    smtp,
    s3,
    emailInbound: { formats, ...(basicAuth ? { basicAuth } : {}), ...(sendgridEventPublicKey ? { sendgridEventPublicKey } : {}), ...(sesSnsTopicArns ? { sesSnsTopicArns } : {}), ...(mailgunWebhookSigningKey ? { mailgunWebhookSigningKey } : {}) },
    shutdownDrainMs: env.SHUTDOWN_DRAIN_MS || undefined,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    aiModel: env.AI_MODEL || undefined,
    storageDir: env.STORAGE_DIR || undefined,
    vapid,
    fub,
    leadEmail: {
      inboundDomain: (env.LEAD_EMAIL_INBOUND_DOMAIN || (prod ? '' : 'leads.realty-os.invalid')).toLowerCase() || null,
      authservId: env.LEAD_EMAIL_AUTHSERV_ID || null,
    },
    mls,
    globalRateLimitPerMinute: env.GLOBAL_RATE_LIMIT_PER_MINUTE || undefined,
    databasePoolMax: env.DB_POOL_MAX || undefined,
    logLevel: env.LOG_LEVEL || undefined,
  });
  if (!parsed.success) {
    // the path names the setting; the message never echoes a value
    const i = parsed.error.issues[0];
    throw new ConfigError(`invalid configuration: ${i?.path.join('.') ?? ''} ${i?.message ?? ''}`.trim());
  }
  if (parsed.data.env === 'production' && !parsed.data.cookieSecure) throw new ConfigError('SESSION_COOKIE_SECURE must be true in production');
  if (parsed.data.env === 'production') assertProductionSecrets(parsed.data);
  return parsed.data;
}

/** Production secret hygiene (security-hardening lane). Messages name keys, never values. */
function assertProductionSecrets(c: Config): void {
  if (Buffer.from(c.kek).equals(Buffer.from(c.sessionSecret))) throw new ConfigError('KEK_BASE64 and SESSION_SECRET_BASE64 must be different keys');
  const wh = Object.values(c.webhookSecrets);
  if (new Set(wh).size !== wh.length) throw new ConfigError('each *_WEBHOOK_SECRET must be different');
}

/** A log-safe view of the config (no keys, secrets or credentials). */
export function redactConfig(c: Config): Record<string, unknown> {
  return {
    env: c.env,
    apiPort: c.apiPort,
    webOrigins: c.webOrigins,
    publicBaseUrl: c.publicBaseUrl,
    cookieSecure: c.cookieSecure,
    trustProxy: c.trustProxy,
    kekRef: c.kekRef,
    providers: c.providers,
    aiModel: c.aiModel,
    emailInboundFormats: c.emailInbound.formats,
    leadEmailInboundDomain: c.leadEmail.inboundDomain,
    smtpVendor: c.smtp?.vendor,
    s3Bucket: c.s3?.bucket,
    s3Endpoint: c.s3?.endpoint,
    mls: { provider: c.mls.provider, liveCalls: c.mls.liveCalls, sparkBaseUrl: c.mls.spark.baseUrl, sparkAuthScheme: c.mls.spark.authScheme },
  };
}
