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
      { code: "import type { ClientActor } from '@realty/db';\nexport type A = ClientActor", options: [{ mode: 'staff' }] },
      { code: "import { type withPortalTx } from '@realty/db';", options: [{ mode: 'staff' }] },
      { code: "const m = { kind: 'client', body: 'x' }", options: [{ mode: 'staff' }] },
      { code: "if (actor.kind === 'client') {}", options: [{ mode: 'staff' }] },
      { code: "const c = await resolvePortalSession(token)", options: [{ mode: 'staff' }] },
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
    ],
    invalid: [
      { code: "import { withTenantTx } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await withTenantTx(actor, fn)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await db.withPreTenant(fn)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: 'await withNoContext(db, fn)', options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
      { code: "import { actorGucs as g } from '@realty/db';", options: [{ mode: 'client' }], errors: [{ messageId: 'clientUsesStaff' }] },
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
