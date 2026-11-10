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
    formats: z.array(z.enum(['postmark', 'sendgrid'])),
    /** HTTP Basic credentials embedded in the vendor webhook URL (Postmark; SendGrid Inbound Parse) */
    basicAuth: z.object({ username: z.string().min(1), password: z.string().min(16) }).optional(),
    /** SendGrid Event Webhook ECDSA public key (base64 DER, from the SendGrid console) */
    sendgridEventPublicKey: z.string().optional(),
  }),
  /** api: how long /ready reports 503 before the server stops accepting (load balancer drain) */
  shutdownDrainMs: z.coerce.number().int().min(0).max(120_000).default(5_000),
  /** api and worker: hard deadline for a graceful stop before the process exits anyway */
  shutdownTimeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  anthropicApiKey: z.string().optional(),
  aiModel: z.string().default('claude-opus-5-5'),
  storageDir: z.string().default('.storage'),
  vapid: z.object({ publicKey: z.string(), privateKey: z.string(), subject: z.string() }).optional(),
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
  const formats = list(env.EMAIL_INBOUND_FORMATS).map((f) => pick('EMAIL_INBOUND_FORMATS', f, ['postmark', 'sendgrid'] as const, 'postmark'));

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
    formats.length > 0 ? { username: need('EMAIL_WEBHOOK_BASIC_USER') ?? '', password: need('EMAIL_WEBHOOK_BASIC_PASSWORD') ?? '' } : undefined;
  const sendgridEventPublicKey = formats.includes('sendgrid') ? need('SENDGRID_EVENT_PUBLIC_KEY') : undefined;

  if (prod) {
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
    emailInbound: { formats, ...(basicAuth ? { basicAuth } : {}), ...(sendgridEventPublicKey ? { sendgridEventPublicKey } : {}) },
    shutdownDrainMs: env.SHUTDOWN_DRAIN_MS || undefined,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    aiModel: env.AI_MODEL || undefined,
    storageDir: env.STORAGE_DIR || undefined,
    vapid,
    globalRateLimitPerMinute: env.GLOBAL_RATE_LIMIT_PER_MINUTE || undefined,
    logLevel: env.LOG_LEVEL || undefined,
  });
  if (!parsed.success) {
    // the path names the setting; the message never echoes a value
    const i = parsed.error.issues[0];
    throw new ConfigError(`invalid configuration: ${i?.path.join('.') ?? ''} ${i?.message ?? ''}`.trim());
  }
  if (parsed.data.env === 'production' && !parsed.data.cookieSecure) throw new ConfigError('SESSION_COOKIE_SECURE must be true in production');
  return parsed.data;
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
    smtpVendor: c.smtp?.vendor,
    s3Bucket: c.s3?.bucket,
    s3Endpoint: c.s3?.endpoint,
  };
}
