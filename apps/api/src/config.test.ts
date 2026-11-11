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
    KEK_REF: 'prod-kek:v1',
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

  it('production requires KEK_REF (deploy rehearsal: it silently defaulted to local-kek:v1, the name stamped on every wrapped tenant key)', () => {
    for (const v of [undefined, '', '  ']) expect(() => loadConfig(prodEnv({ KEK_REF: v }))).toThrow(/missing KEK_REF/);
    expect(loadConfig(prodEnv()).kekRef).toBe('prod-kek:v1');
    // development keeps its default
    expect(loadConfig(base()).kekRef).toBe('local-kek:v1');
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

describe('FUB configuration (FUB_BASE_URL / FUB_ALLOWED_HOSTS, SECURITY §2.9)', () => {
  it('defaults to the fake and to api.followupboss.com; valid overrides load (hosts trimmed, deduplicated)', () => {
    expect(loadConfig(base()).fub).toEqual({ provider: 'fake', baseUrl: 'https://api.followupboss.com/v1', allowedHosts: ['api.followupboss.com'] });
    const c = loadConfig(base({ FUB_PROVIDER: 'real', FUB_BASE_URL: 'https://fub.example.com/v1/', FUB_ALLOWED_HOSTS: ' api.followupboss.com, fub.example.com,fub.example.com ', FUB_SYSTEM_NAME: 'RealtyOS', FUB_SYSTEM_KEY: 'fub-system-key-secret' }));
    expect(c.fub).toEqual({ provider: 'real', baseUrl: 'https://fub.example.com/v1', allowedHosts: ['api.followupboss.com', 'fub.example.com'], system: { name: 'RealtyOS', key: 'fub-system-key-secret' } });
    expect(JSON.stringify(redactConfig(c))).not.toContain('fub-system-key-secret');
    expect(() => loadConfig(base({ FUB_PROVIDER: 'live' }))).toThrow(/FUB_PROVIDER must be one of fake, real/);
  });

  it('refuses an allow-list entry that is not a lowercase public host name (scheme, port, path, wildcard, IP, internal), naming the key only', () => {
    for (const bad of ['https://api.followupboss.com', 'api.followupboss.com:443', 'api.followupboss.com/v1', '*.followupboss.com', 'API.FollowUpBoss.com', '10.0.0.1', 'localhost', 'fub.internal', 'user@fub.example.com']) {
      let msg = '';
      try {
        loadConfig(base({ FUB_ALLOWED_HOSTS: `api.followupboss.com,${bad}` }));
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        msg = (e as Error).message;
      }
      expect(msg, bad).toMatch(/FUB_ALLOWED_HOSTS must list lowercase public host names/);
      expect(msg, bad).not.toContain(bad);
    }
  });

  it('refuses a base URL whose host is not allowed, or that is not https on the default port without credentials, naming the key only', () => {
    const cases: Record<string, RegExp> = {
      'https://fub.example.com/v1': /FUB_BASE_URL host must be listed in FUB_ALLOWED_HOSTS/,
      'https://169.254.169.254/latest': /FUB_BASE_URL must be https/,
      'http://api.followupboss.com/v1': /FUB_BASE_URL must be https/,
      'https://api.followupboss.com:8443/v1': /FUB_BASE_URL must be https/,
      'https://user:pw-secret@api.followupboss.com/v1': /FUB_BASE_URL must be https/,
      'https://api.followupboss.com/v1?x=1': /FUB_BASE_URL must be https/,
      'not a url': /FUB_BASE_URL must be https/,
    };
    for (const [url, re] of Object.entries(cases)) {
      let msg = '';
      try {
        loadConfig(base({ FUB_BASE_URL: url }));
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        msg = (e as Error).message;
      }
      expect(msg, url).toMatch(re);
      expect(msg, url).not.toContain(url);
      expect(msg).not.toContain('pw-secret');
    }
    expect(loadConfig(base({ FUB_BASE_URL: 'https://fub.example.com/v1', FUB_ALLOWED_HOSTS: 'fub.example.com' })).fub.baseUrl).toBe('https://fub.example.com/v1');
  });

  it('FUB_SYSTEM_NAME and FUB_SYSTEM_KEY go together', () => {
    expect(() => loadConfig(base({ FUB_SYSTEM_NAME: 'RealtyOS' }))).toThrow(/missing FUB_SYSTEM_KEY/);
    expect(() => loadConfig(base({ FUB_SYSTEM_KEY: 'k' }))).toThrow(/missing FUB_SYSTEM_NAME/);
  });
});

describe('Amazon SES and Mailgun event formats (EMAIL_INBOUND_FORMATS=ses,mailgun)', () => {
  const ARN = 'arn:aws:sns:us-east-1:123456789012:ses-events';
  it('ses needs SES_SNS_TOPIC_ARNS (valid ARNs), mailgun needs MAILGUN_WEBHOOK_SIGNING_KEY; neither needs the Basic credentials', () => {
    const noBasic = { EMAIL_WEBHOOK_BASIC_USER: undefined, EMAIL_WEBHOOK_BASIC_PASSWORD: undefined };
    expect(() => loadConfig(prodEnv({ ...noBasic, EMAIL_INBOUND_FORMATS: 'ses,mailgun' }))).toThrow(/missing SES_SNS_TOPIC_ARNS, MAILGUN_WEBHOOK_SIGNING_KEY/);
    expect(() => loadConfig(base({ EMAIL_INBOUND_FORMATS: 'ses', SES_SNS_TOPIC_ARNS: ' , ' }))).toThrow(/missing SES_SNS_TOPIC_ARNS/);
    let msg = '';
    try {
      loadConfig(base({ EMAIL_INBOUND_FORMATS: 'ses', SES_SNS_TOPIC_ARNS: `${ARN},https://secret-looking.example/topic` }));
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/SES_SNS_TOPIC_ARNS must list SNS topic ARNs/);
    expect(msg).not.toContain('secret-looking');
    const c = loadConfig(prodEnv({ ...noBasic, EMAIL_INBOUND_FORMATS: 'ses,mailgun', SES_SNS_TOPIC_ARNS: `${ARN}, arn:aws-cn:sns:cn-north-1:123456789012:b`, MAILGUN_WEBHOOK_SIGNING_KEY: 'mailgun-signing-key-secret' }));
    expect(c.emailInbound).toEqual({ formats: ['ses', 'mailgun'], sesSnsTopicArns: [ARN, 'arn:aws-cn:sns:cn-north-1:123456789012:b'], mailgunWebhookSigningKey: 'mailgun-signing-key-secret' });
    expect(JSON.stringify(redactConfig(c))).not.toContain('mailgun-signing-key-secret');
    // postmark/sendgrid alongside still need the Basic credentials
    expect(() => loadConfig(prodEnv({ ...noBasic, EMAIL_INBOUND_FORMATS: 'postmark,ses', SES_SNS_TOPIC_ARNS: ARN }))).toThrow(/missing EMAIL_WEBHOOK_BASIC_USER, EMAIL_WEBHOOK_BASIC_PASSWORD/);
  });

  it('production: an SES or Mailgun relay without its event format (or a generic-format bridge) is refused, so bounces, complaints and unsubscribes always arrive', () => {
    expect(() => loadConfig(prodEnv({ SMTP_VENDOR: 'ses' }))).toThrow(/SMTP_VENDOR=ses needs ses in EMAIL_INBOUND_FORMATS/);
    expect(() => loadConfig(prodEnv({ SMTP_VENDOR: 'mailgun' }))).toThrow(/SMTP_VENDOR=mailgun needs mailgun in EMAIL_INBOUND_FORMATS/);
    expect(loadConfig(prodEnv({ SMTP_VENDOR: 'ses', EMAIL_INBOUND_FORMATS: 'ses', SES_SNS_TOPIC_ARNS: ARN })).smtp?.vendor).toBe('ses');
    expect(loadConfig(prodEnv({ SMTP_VENDOR: 'mailgun', EMAIL_WEBHOOK_SECRET: 'e'.repeat(32) })).smtp?.vendor).toBe('mailgun');
    // development is not blocked (fakes and local relays)
    expect(loadConfig(base({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'localhost', ACCOUNT_EMAIL_FROM: 'a@b.test', SMTP_VENDOR: 'ses' })).smtp?.vendor).toBe('ses');
  });
});

describe('TRUST_PROXY: the proxies whose X-Forwarded-For the API believes (finding chat-xff-ratelimit-bypass)', () => {
  it('names the proxies that connect to the API (addresses, CIDRs, loopback / linklocal / uniquelocal); empty or false trusts none', () => {
    expect(loadConfig(prodEnv({ TRUST_PROXY: 'uniquelocal' })).trustProxy).toBe('uniquelocal');
    expect(loadConfig(prodEnv({ TRUST_PROXY: ' 10.0.0.0/8 , 172.18.0.4,fd00::/8, loopback ' })).trustProxy).toBe('10.0.0.0/8,172.18.0.4,fd00::/8,loopback');
    for (const v of [undefined, '', 'false', '0']) expect(loadConfig(prodEnv({ TRUST_PROXY: v })).trustProxy).toBe(false);
  });

  it('refuses true (Fastify then trusts every hop, so the left-most X-Forwarded-For entry, which the client writes, becomes the rate-limit IP), a /0 range, and anything that is not an address, naming the key only', () => {
    for (const v of ['true', '1']) expect(() => loadConfig(prodEnv({ TRUST_PROXY: v }))).toThrow(/TRUST_PROXY=true would trust every hop/);
    for (const v of ['0.0.0.0/0', '::/0', '10.0.0.0/33', 'proxy.internal', '10.0.0.0/8,not-an-ip', '10.0.0.0/', '300.1.1.1']) {
      let msg = '';
      try {
        loadConfig(prodEnv({ TRUST_PROXY: v }));
      } catch (e) {
        expect(e, v).toBeInstanceOf(ConfigError);
        msg = (e as Error).message;
      }
      expect(msg, v).toMatch(/TRUST_PROXY must list/);
      if (v.includes('internal') || v.includes('not-an-ip')) expect(msg, v).not.toContain(v);
    }
  });
});
