// recordConsentEvent: ledger + projection in one transaction under the address lock.
import { createHash } from 'node:crypto';
import type { ConsentEventSpec } from '@realty/core/compliance';
import { projectConsent } from '@realty/core/compliance';
import { type Instant, DAY_MS } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsentSpecError, loadConsentEvents, recordConsentEvent, upsertConsentState } from '../src/consent.js';
import { withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, selfCreated, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
beforeAll(async () => {
  h = await createHarness(12);
  w = await createWorld(h.app, { agents: 1 });
});
afterAll(async () => {
  await h?.close();
});

const hmac = (addr: string) => createHash('sha256').update(`test-hmac:${addr}`).digest('hex');

function spec(over: Partial<ConsentEventSpec> & Pick<ConsentEventSpec, 'addressHmac'>): ConsentEventSpec {
  return {
    id: uuid(),
    addressKind: 'phone',
    addressHint: '•••-•••-0101',
    channel: 'sms',
    purpose: 'informational',
    eventType: 'grant',
    level: 'express',
    source: 'inbound_first_contact',
    occurredAt: Date.now() as Instant,
    contactId: null,
    actor: { kind: 'system' },
    disclosureId: null,
    evidenceObjectId: null,
    evidenceMessageId: null,
    evidenceCallId: null,
    evidenceCallOffsetMs: null,
    evidence: {},
    imported: false,
    importRecordId: null,
    originalProvenance: null,
    revertsEventId: null,
    expiresAt: null,
    needsReview: false,
    ...over,
  };
}

const stateRows = (addr: string) =>
  suRows<{ channel: string; purpose: string; status: string; consent_level: string; ledger_event_count: number }>(h.su,
    `SELECT channel, purpose, status, consent_level, ledger_event_count FROM consent_state WHERE address_hmac = decode($1, 'hex') ORDER BY channel, purpose`, [addr]);

describe('recordConsentEvent', () => {
  it('R-CONSENT-2 R-CONSENT-6: the event and its projection commit together; the stored rows equal core.projectConsent of the ledger', async () => {
    const a = hmac('+15555550101');
    await withTenantTx(w.system('provider'), (tx) => recordConsentEvent(tx, spec({ addressHmac: a })), { db: h.app });
    expect(await stateRows(a)).toEqual([{ channel: 'sms', purpose: 'informational', status: 'granted', consent_level: 'express', ledger_event_count: 1 }]);
    // a STOP (purpose all) revokes both purposes; the latest revoke beats the earlier grant
    const rows = await withTenantTx(w.system('provider'), (tx) =>
      recordConsentEvent(tx, spec({ addressHmac: a, eventType: 'revoke', level: 'none', purpose: 'all', source: 'inbound_keyword' })), { db: h.app });
    expect(rows.map((r) => [r.purpose, r.status]).sort()).toEqual([['informational', 'revoked'], ['marketing', 'revoked']]);
    expect(await stateRows(a)).toEqual([
      { channel: 'sms', purpose: 'informational', status: 'revoked', consent_level: 'none', ledger_event_count: 2 },
      { channel: 'sms', purpose: 'marketing', status: 'revoked', consent_level: 'none', ledger_event_count: 1 },
    ]);
    const events = await withTenantTx(w.system(), (tx) => loadConsentEvents(tx, 'sms', a), { db: h.app });
    const projected = [...projectConsent(events, Date.now() as Instant).values()].map((r) => [r.purpose, r.status, r.level, r.ledgerEventCount]).sort();
    expect(projected).toEqual([['informational', 'revoked', 'none', 2], ['marketing', 'revoked', 'none', 1]]);
  });

  it('R-CONSENT-2: an inquiry basis carries its expiry and projects to none once expired at evaluation time', async () => {
    const a = hmac('+15555550102');
    const past = (Date.now() - 2 * DAY_MS) as Instant;
    await withTenantTx(w.system('provider'), (tx) =>
      recordConsentEvent(tx, spec({ addressHmac: a, source: 'lead_provider', level: 'inquiry', purpose: 'marketing', occurredAt: (past - DAY_MS) as Instant, expiresAt: past })), { db: h.app });
    expect(await stateRows(a)).toEqual([{ channel: 'sms', purpose: 'marketing', status: 'none', consent_level: 'none', ledger_event_count: 1 }]);
  });

  it('R-CONSENT-6: a projection row whose ledger_event_count is stale is rejected by the DB guard', async () => {
    const a = hmac('+15555550103');
    await withTenantTx(w.system('provider'), (tx) => recordConsentEvent(tx, spec({ addressHmac: a })), { db: h.app });
    await expect(
      withTenantTx(w.system(), (tx) =>
        upsertConsentState(tx, [{ channel: 'sms', purpose: 'informational', addressHmac: a, status: 'granted', level: 'express', basisEventId: null, expiresAt: null, ledgerEventCount: 2 }], Date.now() as Instant), { db: h.app }),
    ).rejects.toThrow(/CONSENT_PROJECTION_STALE/);
    // and the event + projection are atomic: a failing projection write rolls the event back
    const before = await suRows<{ n: string }>(h.su, `SELECT count(*) AS n FROM consent_events WHERE address_hmac = decode($1, 'hex')`, [a]);
    await expect(
      withTenantTx(w.system('provider'), async (tx) => {
        await recordConsentEvent(tx, spec({ addressHmac: a, eventType: 'revoke', level: 'none', source: 'agent_revoke' }));
        await sql`SELECT 1/0`.execute(tx);
      }, { db: h.app }),
    ).rejects.toThrow();
    expect(await suRows(h.su, `SELECT count(*) AS n FROM consent_events WHERE address_hmac = decode($1, 'hex')`, [a])).toEqual(before);
  });

  it('R-CONSENT-6: 12 concurrent writers of one address serialize on app.lock_address; every count matches the ledger', async () => {
    const a = hmac('+15555550104');
    const writes = Array.from({ length: 12 }, (_, i) =>
      withTenantTx(w.system('provider'), (tx) =>
        recordConsentEvent(tx, spec({ addressHmac: a, ...(i % 3 === 2 ? { eventType: 'revoke', level: 'none', source: 'agent_revoke' } : {}) })), { db: h.app }),
    );
    await Promise.all(writes);
    const [row] = await stateRows(a);
    expect(row!.ledger_event_count).toBe(12);
  });

  it('R-CONSENT-1: keyed by address HMAC, never by contact: an agent sees the opt-out of a number on their contact, and it blocks every contact sharing it', async () => {
    const agent = w.agents[0]!;
    const addr = '+15555550105';
    const a = hmac(addr);
    const c1 = await selfCreated(h.app, w, agent, 'Spouse One');
    const c2 = await selfCreated(h.app, w, agent, 'Spouse Two');
    await withTenantTx(agent.actor, async (tx) => {
      for (const c of [c1, c2]) {
        await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac) VALUES (${w.tenantId}, ${uuid()}, ${c}, 'phone', ${addr}, decode(${a}, 'hex'))`.execute(tx);
      }
    }, { db: h.app });
    await withTenantTx(w.system('provider'), (tx) => recordConsentEvent(tx, spec({ addressHmac: a, eventType: 'revoke', level: 'none', purpose: 'all', source: 'inbound_keyword', contactId: c1 })), { db: h.app });
    const seen = await withTenantTx(agent.actor, async (tx) => {
      const r = await sql<{ status: string }>`SELECT status FROM consent_state WHERE address_hmac = decode(${a}, 'hex') AND channel = 'sms'`.execute(tx);
      return r.rows.map((x) => x.status);
    }, { db: h.app });
    expect(seen).toEqual(['revoked', 'revoked']);
    // no plaintext address in the ledger
    const cols = await suRows<{ column_name: string }>(h.su, `SELECT column_name FROM information_schema.columns WHERE table_name = 'consent_events' AND column_name IN ('address', 'phone', 'email')`);
    expect(cols).toEqual([]);
  });

  it('rejects a spec that violates the consent_events CHECKs before touching the database (imports never manufacture consent)', async () => {
    const a = hmac('+15555550106');
    await expect(
      withTenantTx(w.system('import'), (tx) => recordConsentEvent(tx, spec({ addressHmac: a, source: 'import_fub', imported: true, level: 'express', importRecordId: uuid(), originalProvenance: {} })), { db: h.app }),
    ).rejects.toThrow(ConsentSpecError);
  });
});
