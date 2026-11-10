// web/shell public interface for surfaces (apps/web/src/surfaces/*). Design components come from
// '../design/index.js'; page registration goes through registry.ts.
export { App, buildRoutes, createQueryClient, defaultPageTable } from './App.js';
export { ApiClient, ApiError, isRetryable, type HttpMethod } from './api.js';
export { type SessionInfo, type TenantSummary, sessionGate } from './authApi.js';
export { useApi, useSession, SESSION_KEY } from './context.js';
export { GENERIC_ERROR_MESSAGE, errorMessages, messageFor } from './errorMessages.js';
export { ROLE_LABEL, usePageTitle } from './Layout.js';
export { MAX_PHONE_TABS, buildPageTable, navFor, pagesFor, tapsTo, validateRegistry, type NavModel, type PageTable } from './pages.js';
export { useRequestReauth, useWithReauth } from './reauth.js';
export { newCommandId, useCommand, type Command, type CommandOptions, type CommandResult } from './useCommand.js';
export type { NavSection, PageDef, PageNav, SurfaceModule } from './types.js';
