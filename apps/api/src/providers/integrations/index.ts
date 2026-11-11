// Phase 2-3 adapter bag (`Providers.integrations`; PHASE2_3_PLAN §5.4 #21, R-INT-1).
//
//   dev / test                     deterministic fakes
//   production                     honest "not set up on this platform yet" (no partner apps exist)
//   production + allowFakeProviders  fakes, for an explicit staging demo only (config.ts rule)
import type { Config } from '../../config.js';
import { createFakeIntegrations } from './fakes.js';
import { createUnconfiguredIntegrations } from './real.js';
import type { IntegrationAdapters } from './types.js';

export * from './types.js';
export * from './fakes.js';
export * from './spark.js';
export { IntegrationConfigError, PartnerLeadFeed, PlatformOAuth, createRealIntegrations, createUnconfiguredIntegrations } from './real.js';

export function selectIntegrations(config: Pick<Config, 'env' | 'allowFakeProviders'>): IntegrationAdapters {
  if (config.env === 'production' && !config.allowFakeProviders) return createUnconfiguredIntegrations();
  return createFakeIntegrations();
}
