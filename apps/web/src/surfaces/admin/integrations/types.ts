// Response shape of GET /admin/integrations (apps/api/src/integrations/routes.ts IntegrationsResponse), copied
// field by field (pickIntegrations) so the page only ever holds what it renders.
//
// Owner decision D2: the out-of-scope kinds (Messenger and Instagram direct messages, Meta Lead Ads, Meta ads)
// are never offered here. The page filters them by kind, whatever the server sends, and shows a row of those
// kinds made before D2 only so it can be disconnected. platform:meta is never shown as a review to clear.

export const OUT_OF_SCOPE_KINDS: readonly string[] = ['messenger_page', 'instagram_account', 'meta_lead_ads', 'ads_meta'];
/** D2: packs that are never cleared (platform:meta gates only the DM guard, which no product path uses). */
export const NEVER_CLEARED_PACKS: readonly string[] = ['platform:meta'];

export type AdapterMode = 'fake' | 'unconfigured' | 'real';

export interface Capability {
  name: string;
  available: boolean;
  reason: string | null;
}

export interface Connection {
  id: string;
  kind: string;
  displayName: string;
  status: string;
  statusSentence: string;
  capabilities: Capability[];
  connectedAt: string | null;
  disconnectedAt: string | null;
}

export interface Service {
  kind: string;
  name: string;
  connect: string;
  sentence: string;
  connections: Connection[];
}

export interface PlatformPack {
  key: string;
  version: string;
  reviewed: boolean;
  sentence: string;
}

export interface PerUser {
  key: string;
  name: string;
  sentence: string;
}

export interface Integrations {
  adapterMode: AdapterMode;
  services: Service[];
  platformPacks: PlatformPack[];
  perUser: PerUser[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function pickConnection(raw: unknown): Connection {
  const c = obj(raw);
  return {
    id: str(c.id),
    kind: str(c.kind),
    displayName: str(c.displayName),
    status: str(c.status),
    statusSentence: str(c.statusSentence),
    capabilities: arr(c.capabilities).map((x) => {
      const k = obj(x);
      return { name: str(k.name), available: k.available === true, reason: strOrNull(k.reason) };
    }),
    connectedAt: strOrNull(c.connectedAt),
    disconnectedAt: strOrNull(c.disconnectedAt),
  };
}

export function pickIntegrations(raw: unknown): Integrations {
  const o = obj(raw);
  const mode = o.adapterMode === 'real' || o.adapterMode === 'unconfigured' ? o.adapterMode : 'fake';
  return {
    adapterMode: mode,
    services: arr(o.services).map((x) => {
      const s = obj(x);
      return { kind: str(s.kind), name: str(s.name), connect: str(s.connect), sentence: str(s.sentence), connections: arr(s.connections).map(pickConnection) };
    }),
    platformPacks: arr(o.platformPacks).map((x) => {
      const p = obj(x);
      return { key: str(p.key), version: str(p.version), reviewed: p.reviewed === true, sentence: str(p.sentence) };
    }),
    perUser: arr(o.perUser).map((x) => {
      const p = obj(x);
      return { key: str(p.key), name: str(p.name), sentence: str(p.sentence) };
    }),
  };
}

/** D2: in scope = not an out-of-scope kind AND not marked out of scope by the server. */
export const offered = (s: Pick<Service, 'kind' | 'connect'>): boolean => !OUT_OF_SCOPE_KINDS.includes(s.kind) && s.connect !== 'out_of_scope';

/** A connection that still exists in a live-ish state (anything but disconnected). */
export const stillThere = (c: Pick<Connection, 'status'>): boolean => c.status !== 'disconnected';
