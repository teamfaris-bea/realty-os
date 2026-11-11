// Website chat widgets (module 22): Owner/Admin create a widget for a lead source, see it, rotate its key and set the
// websites it may run on. A widget is an integration_connections row of the keyed kind `web_chat_widget` (no external
// account; status machine `keyed_enabled`). Disconnecting is the integrations page's existing route
// (POST /admin/integrations/connections/:id/disconnect): from then on the widget answers CHANNEL_NOT_CONNECTED and no
// reply goes out through it (R-INBOX-7); history, identities and opt-outs stay.
//
// The widget key is public (it sits in the website's embed code) but unguessable; only its hash is stored, so the key
// is shown once, at creation or rotation. Writes run as the system actor after the person's role was re-read under it
// (the lead-email pattern), and are audited.
import type { Instant, SystemActor, UserActor } from '@realty/core/foundation';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import type { IdGenerator } from '@realty/core/foundation';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import * as repo from './repos/webchat.js';
import { newWidgetKey, normalizeOrigin, widgetKeyHash } from './webchat.js';

export interface WidgetDeps {
  db: Database;
  ids: IdGenerator;
}

export interface WidgetView {
  id: string;
  displayName: string;
  status: string;
  leadSourceId: string | null;
  allowedOrigins: string[];
  connectedAt: string | null;
  /** an honest sentence: what the widget does now */
  sentence: string;
}

const MANAGERS = ['owner', 'admin'];
export const MAX_ORIGINS = 10;

function view(w: NonNullable<Awaited<ReturnType<typeof repo.widgetRow>>>): WidgetView {
  const live = w.status === 'connected' || w.status === 'degraded';
  return {
    id: w.id,
    displayName: w.display_name,
    status: w.status,
    leadSourceId: w.lead_source_id,
    allowedOrigins: w.allowed_origins,
    connectedAt: w.connected_at ? w.connected_at.toISOString() : null,
    sentence: live
      ? w.allowed_origins.length > 0
        ? `Live on ${w.allowed_origins.length === 1 ? w.allowed_origins[0] : `${w.allowed_origins.length} websites`}. New chats become leads.`
        : 'Live on any website that has the embed code. New chats become leads.'
      : 'Not connected: the chat window says it is unavailable and nothing is sent through it.',
  };
}

export function cleanOrigins(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const o of raw) {
    const n = normalizeOrigin(o.trim());
    if (!n || n !== o.trim().toLowerCase().replace(/\/$/, '')) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/allowedOrigins', code: 'origin' }] });
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > MAX_ORIGINS) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/allowedOrigins', code: 'too_many' }] });
  return out;
}

function asManager<T>(deps: WidgetDeps, actor: UserActor, fn: (tx: Tx, sys: SystemActor, now: Instant) => Promise<T>): Promise<T> {
  const sys = systemActor(actor.tenantId, 'provider');
  return withTenantTx(
    sys,
    async (tx, now) => {
      const role = await repo.activeRole(tx, actor.userId);
      if (!role || !MANAGERS.includes(role)) throw new AppError('NOT_FOUND');
      return fn(tx, sys, now);
    },
    { db: deps.db, retries: 2 },
  );
}

export async function listWidgets(deps: WidgetDeps, actor: UserActor): Promise<WidgetView[]> {
  return asManager(deps, actor, async (tx) => (await repo.listWidgets(tx)).map(view));
}

export async function createWidget(deps: WidgetDeps, actor: UserActor, i: { displayName: string; leadSourceId: string; allowedOrigins: readonly string[] }): Promise<{ widget: WidgetView; widgetKey: string }> {
  const origins = cleanOrigins(i.allowedOrigins);
  const key = newWidgetKey();
  return asManager(deps, actor, async (tx, sys) => {
    const source = await repo.leadSourceOf(tx, i.leadSourceId);
    if (!source || !source.active) throw new AppError('NOT_FOUND');
    const id = deps.ids.next<'IntegrationConnectionId'>();
    await repo.insertWidget(tx, { id, displayName: i.displayName.trim().slice(0, 120), leadSourceId: source.id, origins, keyHash: widgetKeyHash(key), userId: actor.userId });
    await audit(tx, sys, {
      action: 'webchat.widget_created',
      entity: { type: 'integration_connection', id },
      changes: redactSnapshot({ kind: 'web_chat_widget', status: 'connected', lead_source_id: source.id, origin_count: origins.length, by_user_id: actor.userId }),
      reason: 'CREATED',
    });
    return { widget: view((await repo.widgetRow(tx, id))!), widgetKey: key };
  });
}

export async function rotateWidgetKey(deps: WidgetDeps, actor: UserActor, id: string): Promise<{ widget: WidgetView; widgetKey: string }> {
  const key = newWidgetKey();
  return asManager(deps, actor, async (tx, sys) => {
    if (!(await repo.widgetRow(tx, id))) throw new AppError('NOT_FOUND');
    if (!(await repo.setWidgetKey(tx, id, widgetKeyHash(key)))) throw new AppError('CHANNEL_NOT_CONNECTED');
    await audit(tx, sys, { action: 'webchat.widget_key_rotated', entity: { type: 'integration_connection', id }, changes: redactSnapshot({ by_user_id: actor.userId }), reason: 'ROTATED' });
    return { widget: view((await repo.widgetRow(tx, id))!), widgetKey: key };
  });
}

export async function setWidgetOrigins(deps: WidgetDeps, actor: UserActor, id: string, raw: readonly string[]): Promise<WidgetView> {
  const origins = cleanOrigins(raw);
  return asManager(deps, actor, async (tx, sys) => {
    const before = await repo.widgetRow(tx, id);
    if (!before) throw new AppError('NOT_FOUND');
    if (!(await repo.setWidgetOrigins(tx, id, origins))) throw new AppError('CHANNEL_NOT_CONNECTED');
    await audit(tx, sys, {
      action: 'webchat.widget_origins_changed',
      entity: { type: 'integration_connection', id },
      changes: redactDiff({ origin_count: before.allowed_origins.length }, { origin_count: origins.length, by_user_id: actor.userId }),
      reason: 'ORIGINS_CHANGED',
    });
    return view((await repo.widgetRow(tx, id))!);
  });
}
