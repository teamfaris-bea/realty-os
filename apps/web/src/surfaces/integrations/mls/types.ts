// Response shapes of the Spark MLS admin API (lane/spark-prep contract):
//   GET  /admin/integrations/mls/spark
//   PUT  /admin/integrations/mls/spark/credential
//   POST /admin/integrations/mls/spark/validate
//
// SECRET HANDLING: the server never returns the access token. This surface goes further and never
// keeps a response object as-is: every response is copied field by field (pickOverview /
// pickConnection) into the shapes below, so even a server bug that echoed a token would not reach
// the query cache, component state or the DOM. Nothing here has a field for a token.

export type SparkProvider = 'fake' | 'spark';
export type AuthScheme = 'Bearer' | 'OAuth';
export const AUTH_SCHEMES: readonly AuthScheme[] = ['Bearer', 'OAuth'];

export type ValidateResult = 'connected' | 'invalid_credentials' | 'not_licensed_or_role_insufficient' | 'rate_limited' | 'unreachable' | 'live_calls_disabled';
export const VALIDATE_RESULTS: readonly ValidateResult[] = ['connected', 'invalid_credentials', 'not_licensed_or_role_insufficient', 'rate_limited', 'unreachable', 'live_calls_disabled'];

export interface SparkConnection {
  id: string;
  status: string;
  statusSentence: string;
  keyLabel: string | null;
  credentialSaved: boolean;
  /** UPPER_SNAKE code of the last validation, e.g. CONNECTED */
  lastResult: string | null;
  connectedAt: string | null;
}

export interface SparkOverview {
  provider: SparkProvider;
  liveCalls: boolean;
  sentence: string;
  authSchemeDefault: AuthScheme;
  connection: SparkConnection | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function pickConnection(raw: unknown): SparkConnection | null {
  if (raw === null || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const id = str(c.id);
  if (!id) return null;
  return {
    id,
    status: str(c.status) ?? '',
    statusSentence: str(c.statusSentence) ?? '',
    keyLabel: str(c.keyLabel),
    credentialSaved: c.credentialSaved === true,
    lastResult: str(c.lastResult),
    connectedAt: str(c.connectedAt),
  };
}

export function pickOverview(raw: unknown): SparkOverview {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    provider: o.provider === 'spark' ? 'spark' : 'fake',
    liveCalls: o.liveCalls === true,
    sentence: str(o.sentence) ?? '',
    authSchemeDefault: o.authSchemeDefault === 'OAuth' ? 'OAuth' : 'Bearer',
    connection: pickConnection(o.connection),
  };
}

export function pickValidate(raw: unknown): { result: ValidateResult | null; connection: SparkConnection | null } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const result = VALIDATE_RESULTS.find((r) => r === o.result) ?? null;
  return { result, connection: pickConnection(o.connection) };
}
