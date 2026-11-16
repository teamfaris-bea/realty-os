// Test-only reference: exact candidate query from 15c5bd9b, retained for output equivalence.
import { sql } from 'kysely';
import { IN_HOUSE_PROVIDER } from './avm.js';

export function legacyHomeValueSweepCandidates(limit: number) {
  return sql<{ message_id: string; contact_id: string; action_id: string | null; provider_ref: string | null; region: string | null }>`
    WITH c AS MATERIALIZED (
      SELECT m.tenant_id, m.id AS message_id, m.contact_id, m.assistant_action_id AS action_id,
             CASE WHEN r.trigger_ref->'ref'->>'valuationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (r.trigger_ref->'ref'->>'valuationId')::uuid END AS valuation_id
        FROM messages m
        JOIN playbook_step_runs r ON r.tenant_id = m.tenant_id AND r.contact_id = m.contact_id AND r.status = 'scheduled' AND r.enrollment_id IS NULL AND r.message_id = m.id
       WHERE m.tenant_id = app.tenant_id() AND m.direction = 'outbound' AND m.status IN ('queued','scheduled')
         AND r.trigger_ref->>'trigger' = 'home_value'
    )
    SELECT c.message_id, c.contact_id, c.action_id, v.provider_ref, a.region
      FROM c
      JOIN home_valuations v ON v.tenant_id = c.tenant_id AND v.id = c.valuation_id
      LEFT JOIN contact_addresses a ON a.tenant_id = v.tenant_id AND a.id = v.contact_address_id
     WHERE v.provider_ref LIKE 'inhouse:%' OR v.provider = ${IN_HOUSE_PROVIDER}
     ORDER BY c.contact_id, c.message_id LIMIT ${limit}`;
}
