// module 46: what every portal screen shares: the client API, the one live region, and the team slug.
import { createContext, useContext } from 'react';
import type { PortalApi } from './api.js';
import type { SaveDeps } from './download.js';

export interface PortalCtx {
  api: PortalApi;
  team: string | null;
  announce(msg: string): void;
  /**
   * b17: the live region drops `msg` if it holds it, or is about to (nothing is said: a removal is not read). For a
   * failure sentence that is no longer true once the screen recovered, so a screen reader reading the page later does
   * not meet it.
   */
  forget(msg: string): void;
  save?: SaveDeps;
}

export const PortalContext = createContext<PortalCtx | null>(null);

export function usePortal(): PortalCtx {
  const c = useContext(PortalContext);
  if (!c) throw new Error('usePortal outside the portal App');
  return c;
}
