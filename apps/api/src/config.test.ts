// Production configuration fails fast, names every missing setting at once, and never echoes a value.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactConfig } from './config.js';
import { createProviders } from './providers/index.js';

const clock = { now: () => 1_794_300_000_000 as never };
const SID = 'AC' + 'a'.repeat(32);

const base = (o: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: 'postgres://app_user:pw@db/realty',
  KEK_BASE64: randomBytes(32).toString('base64'),
  SESSION_SECRET_BASE64: randomBytes(32).toString('base64'),
  ...o,
});

/** A complete production environment with every real adapter selected. */
const prodEnv = (o: Record<string, string | undefined> = {}) =>
  base({
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://api.example.test',
    WEB_ORIGIN: 'https://app.example.test',
    LEAD_WEBHOOK_SECRET: 'l'.repeat(32),
    TELEPHONY_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: SID,
    TWILIO_AUTH_TOKEN: 'twilio-master-token-secret',
    TWILIO_PLATFORM_SENDER: '+18435550199',
    EMAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    SMTP_USERNAME: 'user',
    SMTP_PASSWORD: 'smtp-password-secret',
    ACCOUNT_EMAIL_FROM: 'no-reply@example.test',
    EMAIL_INBOUND_FORMATS: 'postmark',
    EMAIL_WEBHOOK_BASIC_USER: 'postmark',
    EMAIL_WEBHOOK_BASIC_PASSWORD: 'basic-password-secret-123',
    STORAGE_PROVIDER: 's3',
    S3_BUCKET: 'realty-objects',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    S3_SECRET_ACCESS_KEY: 's3-secret-access-key',
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    PUSH_PROVIDER: 'webpush',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    VAPID_SUBJECT: 'mailto:ops@example.test',
    ...o,
  });

describe('production configuration', () => {
  it('a complete production environment loads with every real adapter, and createProviders builds them', () => {
    const c = loadConfig(prodEnv());
    expect(c.providers).toEqual({ ai: 'real', telephony: 'twilio', email: 'smtp', storage: 's3', push: 'real' });
    expect(c.smtp).toMatchObject({ host: 'smtp.example.test', port: 587, secure: 'starttls' });
    expect(c.s3).toMatchObject({ bucket: 'realty-objects', forcePathStyle: false, serverSideEncryption: null });
    const p = createProviders(c, { clock });
    expect([p.telephony.constructor.name, p.carrier.constructor.name, p.email.constructor.name, p.accountMail.constructor.name, p.storage.constructor.name]).toEqual([
      'TwilioTelephony',
      'TwilioCarrierLookup',
      'SmtpEmail',
      'SmtpAccountMailer',
      'S3Storage',
    ]);
  });

  it('reports every missing secret at once, by name only (no values in the message)', () => {
    let msg = '';
    try {
      loadConfig(prodEnv({ TWILIO_AUTH_TOKEN: undefined, SMTP_PASSWORD: '', S3_SECRET_ACCESS_KEY: undefined, EMAIL_WEBHOOK_BASIC_PASSWORD: undefined, LEAD_WEBHOOK_SECRET: undefined, VAPID_SUBJECT: undefined }));
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      msg = (e as Error).message;
    }
    for (const k of ['TWILIO_AUTH_TOKEN', 'SMTP_PASSWORD', 'S3_SECRET_ACCESS_KEY', 'EMAIL_WEBHOOK_BASIC_PASSWORD', 'LEAD_WEBHOOK_SECRET', 'VAPID_SUBJECT']) expect(msg).toContain(k);
    for (const secret of ['twilio-master-token-secret', 'smtp-password-secret', 's3-secret-access-key', 'sk-ant-secret']) expect(msg).not.toContain(secret);
  });

  it('refuses fakes, plain-http URLs, plaintext SMTP and a relative local storage dir in production', () => {
    expect(() => loadConfig(prodEnv({ TELEPHONY_PROVIDER: 'fake' }))).toThrow(/TELEPHONY_PROVIDER must be twilio in production/);
    expect(() => loadConfig(prodEnv({ EMAIL_PROVIDER: undefined }))).toThrow(/EMAIL_PROVIDER must be smtp in production/);
    expect(() => loadConfig(prodEnv({ AI_PROVIDER: 'fake' }))).toThrow(/AI_PROVIDER must be anthropic/);
    expect(() => loadConfig(prodEnv({ PUBLIC_BASE_URL: 'http://api.example.test' }))).toThrow(/PUBLIC_BASE_URL must be https/);
    expect(() => loadConfig(prodEnv({ WEB_ORIGIN: undefined }))).toThrow(/missing WEB_ORIGIN/);
    expect(() => loadConfig(prodEnv({ SMTP_SECURE: 'none' }))).toThrow(/SMTP_SECURE must be tls or starttls/);
    expect(() => loadConfig(prodEnv({ STORAGE_PROVIDER: 'local', STORAGE_DIR: '.storage' }))).toThrow(/STORAGE_DIR must be an absolute path/);
    expect(loadConfig(prodEnv({ STORAGE_PROVIDER: 'local', STORAGE_DIR: '/data/objects' })).providers.storage).toBe('local');
    // the explicit escape hatch for a staging demo
    expect(loadConfig(prodEnv({ ALLOW_FAKE_PROVIDERS: 'true', TELEPHONY_PROVIDER: 'fake', TELEPHONY_WEBHOOK_SECRET: 't'.repeat(32) })).providers.telephony).toBe('fake');
  });

  it('the generic email webhook secret is required only when no vendor format is enabled; SendGrid needs its event key', () => {
    expect(() => loadConfig(prodEnv({ EMAIL_INBOUND_FORMATS: '' }))).toThrow(/missing EMAIL_WEBHOOK_SECRET/);
    expect(() => loadConfig(prodEnv({ EMAIL_INBOUND_FORMATS: 'postmark,sendgrid' }))).toThrow(/missing SENDGRID_EVENT_PUBLIC_KEY/);
    expect(() => loadConfig(prodEnv({ EMAIL_INBOUND_FORMATS: 'mailchimp' }))).toThrow(/EMAIL_INBOUND_FORMATS must be one of postmark, sendgrid/);
    expect(loadConfig(prodEnv({ EMAIL_INBOUND_FORMATS: 'sendgrid', SENDGRID_EVENT_PUBLIC_KEY: 'MFkw' })).emailInbound.formats).toEqual(['sendgrid']);
  });

  it('a chosen vendor without credentials fails outside production too; development defaults stay fake', () => {
    expect(() => loadConfig(base({ STORAGE_PROVIDER: 's3' }))).toThrow(/missing S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
    expect(() => loadConfig(base({ EMAIL_PROVIDER: 'smtp' }))).toThrow(/missing SMTP_HOST, ACCOUNT_EMAIL_FROM/);
    expect(() => loadConfig(base({ TELEPHONY_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'nope', TWILIO_AUTH_TOKEN: 'x'.repeat(32) }))).toThrow(/TWILIO_ACCOUNT_SID must look like/);
    const dev = loadConfig(base());
    expect(dev.providers).toEqual({ ai: 'fake', telephony: 'fake', email: 'fake', storage: 'local', push: 'fake' });
    expect(dev.shutdownDrainMs).toBe(5000);
  });

  it('redactConfig of a full production config carries no secret', () => {
    const s = JSON.stringify(redactConfig(loadConfig(prodEnv())));
    for (const secret of ['twilio-master-token-secret', 'smtp-password-secret', 's3-secret-access-key', 'basic-password-secret-123', 'sk-ant-secret', 'AKIDEXAMPLE']) expect(s).not.toContain(secret);
  });
});
