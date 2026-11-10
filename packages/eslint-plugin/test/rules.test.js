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
