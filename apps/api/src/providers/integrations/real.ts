// Real Phase 2-3 adapters: they REFUSE TO START without their configuration (R-INT-1), and every vendor
// call they cannot make honestly yet throws `ProviderError('not_configured', …)` instead of pretending.
//
// Nothing vendor-specific is implemented yet: every service needs a partner account or a vendor contract
// the owner has not obtained (PHASE2_3_PLAN §7): a Meta app for Page/Instagram publishing (D2: no
// messaging), a Google app (Calendar, Business Profile), a Microsoft app (Calendar), Zillow and
// realtor.com partner feeds, an MLS licence, the showing service, an AVM licence, a PDF renderer choice.
// Until then `createRealIntegrations` is not wired by createProviders; production uses
// `createUnconfiguredIntegrations` (honest "not set up on this platform yet") unless an explicit staging
// demo allows the fakes.
import { ProviderError } from '../types.js';
import type {
  AvmProvider,
  CalendarProvider,
  DocumentRenderer,
  IntegrationAdapters,
  LeadFeedProvider,
  MlsFeed,
  OAuthConnector,
  OAuthProviderName,
  ShowingServiceProvider,
  SocialPublisher,
} from './types.js';

export class IntegrationConfigError extends Error {
  override readonly name = 'IntegrationConfigError';
}

const notYet = (what: string) => new ProviderError('not_configured', `VERIFY_${what}`);

/** OAuth 2.0 + PKCE connector skeleton for a platform app (Meta publishing, Google, Microsoft). */
export class PlatformOAuth implements OAuthConnector {
  readonly configured = true;
  constructor(
    readonly provider: OAuthProviderName,
    private readonly cfg: { clientId: string; clientSecret: string; authorizeEndpoint: string },
  ) {
    if (!cfg.clientId || !cfg.clientSecret) throw new IntegrationConfigError(`${provider} OAuth needs a client id and secret`);
    const u = new URL(cfg.authorizeEndpoint);
    if (u.protocol !== 'https:') throw new IntegrationConfigError(`${provider} OAuth authorize endpoint must be https`);
  }
  authorizeUrl(i: { state: string; codeChallenge: string; redirectUri: string; scopes: readonly string[] }): string {
    const u = new URL(this.cfg.authorizeEndpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('state', i.state);
    u.searchParams.set('code_challenge', i.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('redirect_uri', i.redirectUri);
    u.searchParams.set('scope', i.scopes.join(' '));
    return u.toString();
  }
  async exchangeCode(): Promise<never> {
    throw notYet(`${this.provider.toUpperCase()}_TOKEN_ENDPOINT`);
  }
  async listManagedAccounts(): Promise<never> {
    throw notYet(`${this.provider.toUpperCase()}_ACCOUNTS_API`);
  }
  async revoke(): Promise<void> {
    throw notYet(`${this.provider.toUpperCase()}_REVOKE_API`);
  }
  async refresh(): Promise<never> {
    throw notYet(`${this.provider.toUpperCase()}_TOKEN_ENDPOINT`);
  }
}

/** A partner lead feed we have no agreement for: honest `needs_partner_access`, never polls. */
export class PartnerLeadFeed implements LeadFeedProvider {
  readonly access = 'needs_partner_access' as const;
  constructor(readonly source: 'zillow' | 'realtor') {}
  async poll(): Promise<never> {
    throw new ProviderError('not_configured', 'NEEDS_PARTNER_ACCESS');
  }
}

export class UnlicensedMls implements MlsFeed {
  readonly access = 'needs_partner_access' as const;
  async changes(): Promise<never> {
    throw new ProviderError('not_configured', 'NEEDS_MLS_LICENSE');
  }
  async media(): Promise<never> {
    throw new ProviderError('not_configured', 'NEEDS_MLS_LICENSE');
  }
  describeLicense(): never {
    throw new ProviderError('not_configured', 'NEEDS_MLS_LICENSE');
  }
}

export class PartnerShowingService implements ShowingServiceProvider {
  readonly access = 'needs_partner_access' as const;
  async changes(): Promise<never> {
    throw new ProviderError('not_configured', 'NEEDS_PARTNER_ACCESS');
  }
}

const unavailable = {
  avm: { estimate: async () => ({ available: false as const }) } satisfies AvmProvider,
  calendar: (): CalendarProvider => ({
    pushEvent: async () => {
      throw new ProviderError('not_configured', 'CALENDAR_NOT_CONFIGURED');
    },
    freeBusy: async () => {
      throw new ProviderError('not_configured', 'CALENDAR_NOT_CONFIGURED');
    },
  }),
  social: { publishPost: async () => ({ kind: 'rejected' as const, code: 'NOT_CONFIGURED' }) } satisfies SocialPublisher,
  renderer: {
    renderPdf: async () => {
      throw new ProviderError('not_configured', 'RENDERER_NOT_CONFIGURED');
    },
  } satisfies DocumentRenderer,
};

class UnconfiguredOAuth implements OAuthConnector {
  readonly configured = false;
  constructor(readonly provider: OAuthProviderName) {}
  authorizeUrl(): never {
    throw new ProviderError('not_configured', 'OAUTH_APP_NOT_CONFIGURED');
  }
  async exchangeCode(): Promise<never> {
    throw new ProviderError('not_configured', 'OAUTH_APP_NOT_CONFIGURED');
  }
  async listManagedAccounts(): Promise<never> {
    throw new ProviderError('not_configured', 'OAUTH_APP_NOT_CONFIGURED');
  }
  async revoke(): Promise<void> {
    throw new ProviderError('not_configured', 'OAUTH_APP_NOT_CONFIGURED');
  }
  async refresh(): Promise<never> {
    throw new ProviderError('not_configured', 'OAUTH_APP_NOT_CONFIGURED');
  }
}

/**
 * Production without partner apps: every service reports, honestly, that it is not set up on this
 * platform (OAuth `configured: false`, partner feeds `needs_partner_access`); nothing pretends to work.
 */
export function createUnconfiguredIntegrations(): IntegrationAdapters {
  return {
    mode: 'unconfigured',
    oauth: { meta: new UnconfiguredOAuth('meta'), google: new UnconfiguredOAuth('google'), microsoft: new UnconfiguredOAuth('microsoft') },
    leadFeeds: { zillow: new PartnerLeadFeed('zillow'), realtor: new PartnerLeadFeed('realtor') },
    mlsFeed: new UnlicensedMls(),
    avm: unavailable.avm,
    calendar: { google: unavailable.calendar(), microsoft: unavailable.calendar() },
    social: unavailable.social,
    showing: new PartnerShowingService(),
    renderer: unavailable.renderer,
  };
}

/**
 * The real bag, for when partner apps exist. Refuses to start without its configuration (R-INT-1):
 * META_APP_ID / META_APP_SECRET / META_OAUTH_AUTHORIZE_URL, GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
 * GOOGLE_OAUTH_AUTHORIZE_URL, MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_OAUTH_AUTHORIZE_URL. Not wired by createProviders yet (no partner access; VERIFY every endpoint).
 */
export function createRealIntegrations(env: NodeJS.ProcessEnv): IntegrationAdapters {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new IntegrationConfigError(`${k} is required for the real integration adapters`);
    return v;
  };
  const base = createUnconfiguredIntegrations();
  return {
    ...base,
    mode: 'real',
    oauth: {
      meta: new PlatformOAuth('meta', { clientId: need('META_APP_ID'), clientSecret: need('META_APP_SECRET'), authorizeEndpoint: need('META_OAUTH_AUTHORIZE_URL') }),
      google: new PlatformOAuth('google', { clientId: need('GOOGLE_CLIENT_ID'), clientSecret: need('GOOGLE_CLIENT_SECRET'), authorizeEndpoint: need('GOOGLE_OAUTH_AUTHORIZE_URL') }),
      microsoft: new PlatformOAuth('microsoft', { clientId: need('MICROSOFT_CLIENT_ID'), clientSecret: need('MICROSOFT_CLIENT_SECRET'), authorizeEndpoint: need('MICROSOFT_OAUTH_AUTHORIZE_URL') }),
    },
  };
}
