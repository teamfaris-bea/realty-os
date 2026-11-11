// The metrics listener: GET /metrics on its own port, never on the public API port, and behind a
// shared-secret bearer token whenever it is reachable beyond loopback (observability/config.ts).
// Nothing else is served; every other path is 404 and any other method 405. No details on failure.
import { timingSafeEqual } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { Registry } from './prometheus.js';

export interface MetricsListenerOptions {
  port: number;
  host: string;
  token: string | null;
  registry: Registry;
}

function tokenOk(header: string | undefined, token: string | null): boolean {
  if (token === null) return true;
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createMetricsServer(o: Omit<MetricsListenerOptions, 'port' | 'host'>): Server {
  return createServer((req, res) => {
    const send = (status: number, body: string, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics') return send(404, 'not found\n');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed\n');
    if (!tokenOk(req.headers.authorization, o.token)) {
      res.setHeader('www-authenticate', 'Bearer');
      return send(401, 'unauthorized\n');
    }
    o.registry
      .render()
      .then((text) => send(200, req.method === 'HEAD' ? '' : text, 'text/plain; version=0.0.4; charset=utf-8'))
      .catch(() => send(500, 'metrics unavailable\n'));
  });
}

export async function startMetricsListener(o: MetricsListenerOptions): Promise<Server> {
  const server = createMetricsServer(o);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => resolve());
  });
  return server;
}
