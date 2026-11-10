// @realty/api root entry (BUILD_PLAN module 8). apps/web imports TYPES only from here.
export { buildServer, type Platform, type ServerDeps } from './server.js';
export { type Config, ConfigError, loadConfig, redactConfig } from './config.js';
export { AppError, ERROR_STATUS, type ErrorBody, type ErrorCode, errorBody } from './errors.js';
export { type RouteModule, routeModules } from './routes.js';
export { authorize, type RouteAuth, type RouteTableEntry } from './rbac.js';
export { audit, classifyField, maskPii, redactDiff, redactForLog, redactSnapshot, type RedactedDiff } from './audit.js';
export { hashPassword, issueSession, requireActor, verifyPassword } from './auth/index.js';
export type { SessionInfo } from './auth/common.js';
export { type Envelope, EnvelopeService, rotateTenantKey } from './crypto/envelope.js';
export { type Providers, createFakeProviders, createProviders } from './providers/index.js';
export { verifyWebhook } from './providers/webhooks.js';
