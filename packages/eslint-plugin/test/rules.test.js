// Unit tests for the architecture rules (ESLint RuleTester driven by Vitest).
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import plugin from '../src/index.js';
import { findSessionGuc } from '../src/rules/no-session-guc.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2023, sourceType: 'module' },
});
const rules = plugin.rules;

describe('realty/no-provider-outbound (provider send/dial only in comms dispatch)', () => {
  tester.run('no-provider-outbound', rules['no-provider-outbound'], {
    valid: [
      'reply.send({ ok: true })',
      'socket.send(data)',
      'await dispatchOutbound(messageId)',
      'await dialOutbound(callId)',
      'const x = providers.storage.put(key, bytes)',
      'assistant.sendFirstResponse(actor, id)',
      'obj[sendSms]()',
    ],
    invalid: [
      { code: 'await providers.telephony.sendSms(msg)', errors: [{ messageId: 'outbound' }] },
      { code: 'await deps.providers.email.sendEmail(msg)', errors: [{ messageId: 'outbound' }] },
      { code: 'await tel.dialCall(req)', errors: [{ messageId: 'outbound' }] },
      { code: 'queue.map(providers.telephony.sendSms)', errors: [{ messageId: 'outbound' }] },
      { code: 'const { sendSms } = providers.telephony', errors: [{ messageId: 'outbound' }] },
      { code: "providers.telephony['sendSms'](m)", errors: [{ messageId: 'outbound' }] },
      { code: 'telephony.send(m)', errors: [{ messageId: 'outbound' }] },
      { code: 'ctx.providers.email.send(m)', errors: [{ messageId: 'outbound' }] },
      { code: 'telephony.dial(m)', errors: [{ messageId: 'outbound' }] },
      // R-GATE-15 (module 22): the web-chat transport's reserved name, only in comms/dispatch.ts
      { code: 'await deps.providers.webChat.deliverChannelMessage(m)', errors: [{ messageId: 'outbound' }] },
      { code: 'const { deliverChannelMessage } = transport', errors: [{ messageId: 'outbound' }] },
      { code: "transport['deliverChannelMessage'](m)", errors: [{ messageId: 'outbound' }] },
    ],
  });
});

describe('realty/no-system-actor', () => {
  tester.run('no-system-actor', rules['no-system-actor'], {
    valid: [
      "const a = { kind: 'user', userId, tenantId, role, sessionId }",
      "if (actor.kind === 'system') {}",
      "const msg = { kind: 'system', body: 'x' }",
      "type A = { kind: 'system'; tenantId: string }",
    ],
    invalid: [
      { code: "const a = { kind: 'system', tenantId: t, via: 'timer' }", errors: [{ messageId: 'system' }] },
      { code: "const a = { kind: 'system' as const, tenantId: t }", errors: [{ messageId: 'system' }] },
      { code: "const a = { ...base, kind: 'system' }", errors: [{ messageId: 'system' }] },
      { code: "const a = { kind: `system`, via: 'worker' } satisfies Actor", errors: [{ messageId: 'system' }] },
      { code: "withTenantTx({ 'kind': 'system', 'tenantId': t }, fn)", errors: [{ messageId: 'system' }] },
    ],
  });
});

describe('realty/no-session-guc (pool hygiene)', () => {
  tester.run('no-session-guc', rules['no-session-guc'], {
    valid: [
      "q(\"SELECT set_config('app.tenant_id', $1, true)\")",
      "q('SET LOCAL app.tenant_id = $1')",
      'sql`SELECT set_config(\'app.user_id\', ${u}, true), set_config(\'app.actor_kind\', ${k}, true)`',
      "q('SET statement_timeout = 300')",
      "q(\"SELECT set_config('search_path', 'public', false)\")",
      "q('RESET app.tenant_id')",
    ],
    invalid: [
      { code: "q('SET app.tenant_id = $1')", errors: [{ messageId: 'guc' }] },
      { code: "q('set session app.user_id to x')", errors: [{ messageId: 'guc' }] },
      { code: "q(\"SELECT set_config('app.tenant_id', $1, false)\")", errors: [{ messageId: 'guc' }] },
      { code: "q(\"SELECT set_config('app.tenant_id', $1, $2)\")", errors: [{ messageId: 'guc' }] },
      { code: 'sql`SELECT set_config(\'app.tenant_id\', ${t}, false)`', errors: [{ messageId: 'guc' }] },
      { code: 'sql`SELECT set_config(\'app.tenant_id\', ${t}, ${isLocal})`', errors: [{ messageId: 'guc' }] },
      { code: "q(\"SELECT set_config('app.tenant_id', coalesce($1, ''))\")", errors: [{ messageId: 'guc' }] },
    ],
  });

  it('findSessionGuc handles nested parentheses in the value argument', () => {
    expect(findSessionGuc("SELECT set_config('app.tenant_id', coalesce(nullif($1, ''), ''), true)")).toBeNull();
    expect(findSessionGuc("SELECT set_config('app.tenant_id', coalesce(nullif($1, ''), ''), false)")).not.toBeNull();
  });
});

describe('realty/no-relative-outside-package', () => {
  const file = new URL('../../core/src/compliance/gate.ts', import.meta.url).pathname;
  tester.run('no-relative-outside-package', rules['no-relative-outside-package'], {
    valid: [
      { code: "import { x } from '../foundation/index.js'", filename: file },
      { code: "import { x } from './policy.js'", filename: file },
      { code: "import { x } from '@realty/db'", filename: file },
    ],
    invalid: [
      { code: "import { x } from '../../../db/src/index.js'", filename: file, errors: [{ messageId: 'outside' }] },
      { code: "export * from '../../../api/src/index.js'", filename: file, errors: [{ messageId: 'outside' }] },
      { code: "const m = await import('../../../db/src/x.js')", filename: file, errors: [{ messageId: 'outside' }] },
    ],
  });
});

describe('realty/portal-tx-separation (R-TEN-14, module 43)', () => {
  tester.run('portal-tx-separation (staff mode)', rules['portal-tx-separation'], {
    valid: [
      { code: "import { withTenantTx } from '@realty/db';\nawait withTenantTx(actor, fn)", options: [{ mode: 'staff' }] },
      // staff code (the session resolver, apps/api/src/auth/sessions.ts) keeps the session-then-act helper
      { code: "import { withPreTenantThenTenant } from '@realty/db';\nawait withPreTenantThenTenant(pre, actorOf, fn)", options: [{ mode: 'staff' }] },
      { code: "import type { ClientActor } from '@realty/db';\nexport type A = ClientActor", options: [{ mode: 'staff' }] },
      { code: "import { type withPortalTx } from '@realty/db';", options: [{ mode: 'staff' }] },
      { code: "const m = { kind: 'client', body: 'x' }", options: [{ mode: 'staff' }] },
      { code: "if (actor.kind === 'client') {}", options: [{ mode: 'staff' }] },
      { code: "const c = await resolvePortalSession(token)", options: [{ mode: 'staff' }] },
      // the client-mode allowlist is client-only: the worker keeps the queue, the follow-up job and the pool
      {
        code: "import { claimJobs, dueWork, finishJob, getDatabase, jobs, reapJobs, runOwnershipFollowup } from '@realty/db';\nawait dueWork(now, 10);\nawait runOwnershipFollowup(actor, payload)",
        options: [{ mode: 'staff' }],
      },
      { code: "import * as db from '@realty/db';\nexport * from '@realty/db/testing';\nconst m = await import('@realty/db/migrate')", options: [{ mode: 'staff' }] },
      // the barrel (packages/db/src/index.ts) re-exports withPortalTx for portal client code
      { code: "export { withPortalTx, type ClientActor } from './portalTx.js';", options: [{ mode: 'staff' }] },
    ],
    invalid: [
      { code: "import { withPortalTx } from '@realty/db';", options: [{ mode: 'staff' }], errors: [{ messageId: 'staffUsesClient' }] },
      { code: 'await withPortalTx(client, fn)', options: [{ mode: 'staff' }], errors: [{ messageId: 'staffUsesClient' }] },
      { code: 'await db.withPortalTx(client, fn)', options: [{ mode: 'staff' }], errors: [{ messageId: 'staffUsesClient' }] },
      { code: "await db['withPortalTx'](client, fn)", options: [{ mode: 'staff' }], errors: [{ messageId: 'staffUsesClient' }] },
      { code: 'run(withPortalTx)', options: [{ mode: 'staff' }], errors: [{ messageId: 'staffUsesClient' }] },
      { code: "const c = { kind: 'client', tenantId: t, portalAccountId: a }", options: [{ mode: 'staff' }], errors: [{ messageId: 'clientActor' }] },
      { code: "const c = { ...session, kind: 'client' as const }", options: [{ mode: 'staff' }], errors: [{ messageId: 'clientActor' }] },
    ],
  });
  tester.run('portal-tx-separation (client mode)', rules['portal-tx-separation'], {
    valid: [
      { code: "import { withPortalTx } from '@realty/db';\nawait withPortalTx(client, fn)", options: [{ mode: 'client' }] },
      { code: "import type { Tx } from '@realty/db';\nexport type T = Tx", options: [{ mode: 'client' }] },
      { code: "await requestPortalLogin(slug, address)", options: [{ mode: 'client' }] },
      // the allowlist: the value exports of packages/db/src/portalTx.ts, under any local name
      {
        code:
          'import {\n  withPortalTx, requestPortalLogin, consumePortalLogin, resolvePortalSession, endPortalSession, issuePortalDocumentStream,\n' +
          "  redeemPortalDocumentStream, recordPortalAudit, newPortalToken, portalAddressHash, PortalNotClearedError,\n} from '@realty/db';",
        options: [{ mode: 'client' }],
      },
      { code: "import { withPortalTx as asClient, type ClientActor } from '@realty/db';\nexport { resolvePortalSession } from '@realty/db';", options: [{ mode: 'client' }] },
      // type-only imports and re-exports take no value
      { code: "import type { ClaimedJob, Database, DueWork } from '@realty/db';\nexport type T = ClaimedJob | Database | DueWork", options: [{ mode: 'client' }] },
      { code: "import { type Database, type Tx, withPortalTx } from '@realty/db';", options: [{ mode: 'client' }] },
      { code: "import type * as Db from '@realty/db';\nexport type { Tx } from '@realty/db';\nexport { type Database } from '@realty/db';\nexport type * from '@realty/db';", options: [{ mode: 'client' }] },
      { code: "type M = typeof import('@realty/db');", options: [{ mode: 'client' }] },
      // other packages, including one whose name starts the same
      { code: "import { parseId } from '@realty/core/foundation';\nimport { sql } from 'kysely';\nimport { x } from '@realty/db-fixtures';", options: [{ mode: 'client' }] },
    ],
    invalid: [
      { code: "import { withTenantTx } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await withTenantTx(actor, fn)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await db.withPreTenant(fn)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await withNoContext(db, fn)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "import { actorGucs as g } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      // the session-then-act helper is withPreTenant (actorOf => null) or withTenantTx (a staff actor) in one transaction
      { code: "import { withPreTenantThenTenant } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "import { withPreTenantThenTenant as resolveThenAct } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await withPreTenantThenTenant(pre, actorOf, fn)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await withPreTenantThenTenant(async () => 1, () => null, fn)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await db.withPreTenantThenTenant(pre, actorOf, fn)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "await db['withPreTenantThenTenant'](pre, actorOf, fn)", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'run(withPreTenantThenTenant)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      // the ownership engine's own-transaction entry points open withTenantTx for a staff actor
      { code: "import { applyOwnershipCommand } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await applyOwnershipCommandThen(actor, id, cmd, opts, readBack)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      // ... and the follow-up job's entry point opens withTenantTx for the system actor (tenant-wide)
      { code: "import { runOwnershipFollowup } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "await runOwnershipFollowup({ kind: 'system', tenantId }, payload)", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      // the job queue's calls each open withNoContext (cross-tenant definers)
      { code: "import { claimJobs } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "await claimJobs(['default'], worker, 10)", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "import { finishJob } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await finishJob(id, worker, { ok: true })', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "import { reapJobs } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await reapJobs()', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "import { dueWork as overdue } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await dueWork(now, 10)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await deps.dueWork(now, 10)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      // the pool itself: a statement on it carries no context
      { code: "import { getDatabase } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "await getDatabase().kysely.selectFrom('contacts').selectAll().execute()", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "import { createDatabase } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'const db = createDatabase({ connectionString })', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "import { withPortalTx, getDatabase } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      // a banned name re-exported (under any name, from any module) is still that helper
      { code: "export { getDatabase } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "export { withTenantTx as staffTx } from '../staff/tx.js';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      // the allowlist: any other value from @realty/db (or a subpath) is not a portal client helper
      { code: "import { jobs } from '@realty/db';\nawait jobs.claim(['default'], worker, 10)", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      { code: "import { enqueueJob } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      { code: "import { setOwnershipCommand } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      { code: "import { applyOwnershipCommandInTx as apply } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      { code: "import { recordConsentEvent } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      { code: "import { insertAuditRow } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      { code: "import { withPortalTx, jobs, type Tx } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      { code: "import db from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      { code: "import { createTestDb } from '@realty/db/testing';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      // the list names the barrel's re-exports of portalTx.ts, not a same-named value from another entry point
      { code: "import { withPortalTx } from '@realty/db/testing';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      { code: "export { jobs as queue } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbImport' }] },
      // ... and the package cannot be taken whole, where no name check can see what is used
      { code: "import * as db from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbWhole' }] },
      { code: "export * from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbWhole' }] },
      { code: "export * as db from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbWhole' }] },
      { code: "const db = await import('@realty/db');", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbWhole' }] },
      { code: 'const m = await import(`@realty/db/migrate`);', options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbWhole' }] },
      { code: "import db = require('@realty/db');", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbWhole' }] },
      { code: "const db = require('@realty/db');", options: [{ mode: 'client' }], errors: [{ messageId: 'clientDbWhole' }] },
    ],
  });
});

describe('realty/no-prediction-import (R-PRED-4: predictions only become feed cards)', () => {
  const coreFile = new URL('../../core/src/priority/feed.ts', import.meta.url).pathname;
  tester.run('no-prediction-import', rules['no-prediction-import'], {
    valid: [
      { code: "import { x } from '@realty/core/fairhousing'", filename: coreFile },
      { code: "import { x } from '../foundation/index.js'", filename: coreFile },
      { code: "import { x } from '@realty/core/predictions-ui'", filename: coreFile },
      { code: "import { x } from './predict.js'", filename: coreFile },
    ],
    invalid: [
      { code: "import { score } from '@realty/core/predict'", filename: coreFile, errors: [{ messageId: 'forbidden' }] },
      { code: "import type { Band } from '@realty/core/predict'", filename: coreFile, errors: [{ messageId: 'forbidden' }] },
      { code: "import { x } from '@realty/core/coaching'", filename: coreFile, errors: [{ messageId: 'forbidden' }] },
      { code: "export * from '@realty/core/predict'", filename: coreFile, errors: [{ messageId: 'forbidden' }] },
      { code: "const m = await import('@realty/core/predict')", filename: coreFile, errors: [{ messageId: 'forbidden' }] },
      { code: "import { score } from '../predict/index.js'", filename: coreFile, errors: [{ messageId: 'forbidden' }] },
      { code: "import { s } from '../coaching/score.js'", filename: coreFile, errors: [{ messageId: 'forbidden' }] },
      { code: "type B = import('@realty/core/predict').Band", filename: coreFile, errors: [{ messageId: 'forbidden' }] },
    ],
  });
});

describe('realty/no-sql-raw (smart-list SQL is parameterised only, R-PAR-29)', () => {
  tester.run('no-sql-raw', rules['no-sql-raw'], {
    valid: [
      'sql`SELECT 1 WHERE c.stage = ANY (${stages}::text[])`',
      'sql.join(parts, sql` AND `)',
      'sql.val(x)',
      'other.raw(x)',
      'const { join } = sql',
    ],
    invalid: [
      { code: 'sql.raw(input)', errors: [{ messageId: 'banned' }] },
      { code: 'sql`x ${sql.raw(col)}`', errors: [{ messageId: 'banned' }] },
      { code: 'sql.lit(v)', errors: [{ messageId: 'banned' }] },
      { code: 'sql.ref(column)', errors: [{ messageId: 'banned' }] },
      { code: 'sql.id(name)', errors: [{ messageId: 'banned' }] },
      { code: 'sql.table(t)', errors: [{ messageId: 'banned' }] },
      { code: "sql['raw'](x)", errors: [{ messageId: 'banned' }] },
      { code: 'sql[k](x)', errors: [{ messageId: 'banned' }] },
      { code: 'const { raw } = sql', errors: [{ messageId: 'banned' }] },
      { code: 'f(sql.raw)', errors: [{ messageId: 'banned' }] },
    ],
  });
});

describe('realty/isolated-bundle (PHASE2_3_PLAN §5.3, module 37: the chat widget imports no staff-app code)', () => {
  const widgetFile = new URL('../../../apps/web/src/widget/widget.ts', import.meta.url).pathname;
  const nested = new URL('../../../apps/web/src/widget/parts/x.ts', import.meta.url).pathname;
  const opts = [{ dir: 'widget' }];
  tester.run('isolated-bundle', rules['isolated-bundle'], {
    valid: [
      { code: "import { copy } from './copy.js'", filename: widgetFile, options: opts },
      { code: "import type { ChatApi } from './api.js'", filename: widgetFile, options: opts },
      { code: "import { x } from '../copy.js'", filename: nested, options: opts },
      { code: "import src from './api.ts?raw'", filename: widgetFile, options: opts },
      { code: "import { x } from 'tiny'", filename: widgetFile, options: [{ dir: 'widget', allow: ['tiny'] }] },
      // a file outside the bundle is not this rule's business
      { code: "import React from 'react'", filename: new URL('../../../apps/web/src/shell/App.tsx', import.meta.url).pathname, options: opts },
    ],
    invalid: [
      { code: "import { Button } from '../design/index.js'", filename: widgetFile, options: opts, errors: [{ messageId: 'outside' }] },
      { code: "import { useApi } from '../shell/index.js'", filename: widgetFile, options: opts, errors: [{ messageId: 'outside' }] },
      { code: "import { ComposeBox } from '../surfaces/compose/ComposeBox.js'", filename: widgetFile, options: opts, errors: [{ messageId: 'outside' }] },
      { code: "import type { MessageView } from '../surfaces/feed/lib/types.js'", filename: widgetFile, options: opts, errors: [{ messageId: 'outside' }] },
      { code: "import React from 'react'", filename: widgetFile, options: opts, errors: [{ messageId: 'pkg' }] },
      { code: "import { x } from '@realty/core'", filename: widgetFile, options: opts, errors: [{ messageId: 'pkg' }] },
      { code: "export * from '../reasons/index.js'", filename: widgetFile, options: opts, errors: [{ messageId: 'outside' }] },
      { code: "const m = await import('../shell/api.js')", filename: widgetFile, options: opts, errors: [{ messageId: 'outside' }] },
      { code: "type T = import('../shell/types.js').X", filename: widgetFile, options: opts, errors: [{ messageId: 'outside' }] },
      { code: "import { x } from '../widget-extra/x.js'", filename: widgetFile, options: opts, errors: [{ messageId: 'outside' }] },
    ],
  });
});

describe('realty/mail-sync-boundary (R-GMAIL-14, module 68)', () => {
  const inMailSync = new URL('../../../apps/api/src/mailSync/sync.ts', import.meta.url).pathname;
  const inAssistant = new URL('../../../apps/api/src/assistant/drafts.ts', import.meta.url).pathname;
  const inLeads = new URL('../../../apps/api/src/leads/intake.ts', import.meta.url).pathname;
  tester.run('mail-sync-boundary', rules['mail-sync-boundary'], {
    valid: [
      { code: 'const q = sql`SELECT * FROM lead_email_messages`', filename: inLeads, options: [{ mode: 'outside' }] },
      { code: 'const q = "SELECT * FROM messages"', filename: inLeads, options: [{ mode: 'outside' }] },
      { code: 'export async function ingestSyncedMailInTx() { await sql`SELECT * FROM mail_messages`; }', filename: inLeads, options: [{ mode: 'outside', allowInFunctions: ['ingestSyncedMailInTx'] }] },
      { code: "import { audit } from '../audit.js'", filename: inAssistant, options: [{ mode: 'no-import' }] },
      { code: "import { audit } from '../audit.js'; const q = 'SELECT 1 FROM mail_messages'", filename: inMailSync, options: [{ mode: 'inside' }] },
      { code: "import { ingestSyncedMailInTx } from '../comms/inbound.js'", filename: inMailSync, options: [{ mode: 'inside' }] },
    ],
    invalid: [
      { code: 'const q = sql`SELECT body FROM mail_messages WHERE id = ${id}`', filename: inLeads, options: [{ mode: 'outside' }], errors: [{ messageId: 'table' }] },
      { code: "const q = 'select refresh_enc from user_mail_links'", filename: inLeads, options: [{ mode: 'outside' }], errors: [{ messageId: 'table' }] },
      { code: 'function other() { return sql`DELETE FROM mail_messages`; }', filename: inLeads, options: [{ mode: 'outside', allowInFunctions: ['ingestSyncedMailInTx'] }], errors: [{ messageId: 'table' }] },
      { code: "import { syncTenant } from '../mailSync/sync.js'", filename: inAssistant, options: [{ mode: 'no-import' }], errors: [{ messageId: 'importMailSync' }] },
      { code: "const m = await import('../mailSync/service.js')", filename: inAssistant, options: [{ mode: 'no-import' }], errors: [{ messageId: 'importMailSync' }] },
      { code: "import { anthropicAi } from '../providers/anthropic.js'", filename: inMailSync, options: [{ mode: 'inside' }], errors: [{ messageId: 'importModel' }] },
      { code: "import Anthropic from '@anthropic-ai/sdk'", filename: inMailSync, options: [{ mode: 'inside' }], errors: [{ messageId: 'importModel' }] },
      { code: "import { draft } from '../assistant/drafts.js'", filename: inMailSync, options: [{ mode: 'inside' }], errors: [{ messageId: 'importModel' }] },
      { code: "import { dispatchOutbound } from '../comms/dispatch.js'", filename: inMailSync, options: [{ mode: 'inside' }], errors: [{ messageId: 'send' }, { messageId: 'send' }] },
    ],
  });
});
