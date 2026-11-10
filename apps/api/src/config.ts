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
  webhookSecrets: z.object({ telephony: z.string().min(16), email: z.string().min(16), lead: z.string().min(16) }),
  providers: z.object({
    ai: providerKind,
    telephony: providerKind,
    email: providerKind,
    storage: z.enum(['fake', 'local']).default('local'),
    push: providerKind,
  }),
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

/** Builds the Config from an environment map (default: process.env). Throws ConfigError. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const kekRaw = base64Key('KEK_BASE64').safeParse(env.KEK_BASE64 ?? '');
  const secretRaw = base64Key('SESSION_SECRET_BASE64').safeParse(env.SESSION_SECRET_BASE64 ?? '');
  if (!kekRaw.success) throw new ConfigError(kekRaw.error.issues[0]?.message ?? 'KEK_BASE64 invalid');
  if (!secretRaw.success) throw new ConfigError(secretRaw.error.issues[0]?.message ?? 'SESSION_SECRET_BASE64 invalid');
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const origins = (env.WEB_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const port = env.API_PORT ?? '3001';
  const secret = secretRaw.data;
  const wh = (key: string, label: string): string => {
    const v = env[key];
    if (v) return v;
    if (nodeEnv === 'production') throw new ConfigError(`${key} is required in production`);
    return devDerived(secret, label);
  };
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
    cookieSecure: env.SESSION_COOKIE_SECURE === undefined ? nodeEnv === 'production' : bool.parse(env.SESSION_COOKIE_SECURE),
    trustProxy: bool.parse(env.TRUST_PROXY),
    kek: kekRaw.data,
    kekRef: env.KEK_REF ?? 'local-kek:v1',
    sessionSecret: secret,
    webhookSecrets: {
      telephony: wh('TELEPHONY_WEBHOOK_SECRET', 'telephony'),
      email: wh('EMAIL_WEBHOOK_SECRET', 'email'),
      lead: wh('LEAD_WEBHOOK_SECRET', 'lead'),
    },
    providers: {
      ai: env.AI_PROVIDER === 'anthropic' || env.AI_PROVIDER === 'real' ? 'real' : 'fake',
      telephony: env.TELEPHONY_PROVIDER === 'real' ? 'real' : 'fake',
      email: env.EMAIL_PROVIDER === 'real' ? 'real' : 'fake',
      storage: env.STORAGE_PROVIDER === 'fake' ? 'fake' : 'local',
      push: env.PUSH_PROVIDER === 'webpush' || env.PUSH_PROVIDER === 'real' ? 'real' : 'fake',
    },
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    aiModel: env.AI_MODEL || undefined,
    storageDir: env.STORAGE_DIR || undefined,
    vapid,
    globalRateLimitPerMinute: env.GLOBAL_RATE_LIMIT_PER_MINUTE || undefined,
    logLevel: env.LOG_LEVEL || undefined,
  });
  if (!parsed.success) {
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
  };
}
