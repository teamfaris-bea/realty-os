-- =============================================================================
-- api/stage-automation (PARITY_PLAN module 67): one decision per stage-entry event (R-PAR-16, E172).
--
-- The file number is a placeholder: the orchestrator renumbers at merge. Nothing in code or tests names it.
--
-- Why a table: a stage entry either starts a playbook or is skipped with a reason, and that decision must
-- be made exactly once per contact_stage_events row (the reconcile job may run twice, the request path and
-- the backup scan may race, a skip must not turn into a late start an hour later when the facts change).
-- contact_stage_events is append-only, so the decision cannot live on the event row; jobs.dedupe_key only
-- holds while a job is live. One row per event, PK (tenant_id, stage_event_id), is the idempotency key and
-- the evidence of what the person who changed the stage was told ("Started Buyer plan" / the skip reason).
--
-- What it is not: it never sends, never enrolls by itself (the enrollment is the existing
-- playbook_enrollments insert, guarded by app.playbook_enrollments_guard: approved versions only, and the
-- enrollment_one_live unique index: one live enrollment per contact), and it holds no message content.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * new table stage_automation_decisions: ENABLE + FORCE RLS, the RESTRICTIVE staff-only tenant_isolation
--     policy, the support_read_only_{ins,upd,del} policies and the support_read_only statement trigger, as
--     every parity table (0021 §11, §13). Composite (tenant_id, …) keys and FKs.
--   * read: exactly when the contact's detail is visible (a pond or offer card never shows it), like the
--     stage history it decides about.
--   * write: INSERT only, and only by the system actor (the reconcile runs as the system actor under the
--     contact lock); no UPDATE or DELETE grant to app_user, so a decision is final. Rows cascade with the
--     contact (erasure / purge) and with the stage event.
--   * no SECURITY DEFINER function, no grant to app_definer beyond SELECT.
--   * one partial index on contact_stage_events (tenant_id, occurred_at) for user-made stage changes: the
--     backup scan's access path (R-PAR-29 scale: never a tenant-wide sequential scan every minute).
-- =============================================================================

CREATE TABLE stage_automation_decisions (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  stage_event_id uuid NOT NULL,
  contact_id     uuid NOT NULL,
  to_stage       text NOT NULL CHECK (to_stage IN ('new','attempting','connected','nurture','active','under_contract','closed','lost')),
  outcome        text NOT NULL CHECK (outcome IN ('started','skipped')),
  -- the closed set of skip reasons (apps/api/src/stageAutomation/decide.ts SKIP_REASONS)
  reason         text CHECK (reason IN ('not_a_person_change','person_removed','stage_changed_again','not_visible',
                                        'plan_not_approved','already_in_a_plan','cannot_be_reached')),
  playbook_id    uuid,
  enrollment_id  uuid,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stage_event_id),
  FOREIGN KEY (tenant_id, stage_event_id) REFERENCES contact_stage_events (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id)     REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, playbook_id)    REFERENCES playbooks (tenant_id, id),
  FOREIGN KEY (tenant_id, enrollment_id)  REFERENCES playbook_enrollments (tenant_id, id) ON DELETE CASCADE,
  CHECK ((outcome = 'started') = (enrollment_id IS NOT NULL)),
  CHECK ((outcome = 'skipped') = (reason IS NOT NULL)),
  CHECK (outcome <> 'started' OR playbook_id IS NOT NULL)
);
CREATE INDEX stage_automation_decisions_contact_idx ON stage_automation_decisions (tenant_id, contact_id, decided_at DESC);

-- the backup scan reads the recent user-made stage changes of one tenant
CREATE INDEX contact_stage_events_user_recent_idx ON contact_stage_events (tenant_id, occurred_at) WHERE actor_kind = 'user';

-- Layer 1 (as 0021 §11)
ALTER TABLE stage_automation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_automation_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stage_automation_decisions AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON stage_automation_decisions AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON stage_automation_decisions AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON stage_automation_decisions AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');

-- Layer 2: read with the contact's detail; the system actor alone records a decision
CREATE POLICY stage_automation_decisions_select ON stage_automation_decisions FOR SELECT
  USING (app.contact_detail_visible(tenant_id, contact_id));
CREATE POLICY stage_automation_decisions_insert ON stage_automation_decisions FOR INSERT
  WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()));

GRANT SELECT, INSERT ON stage_automation_decisions TO app_user;
GRANT SELECT ON stage_automation_decisions TO app_definer;
GRANT SELECT, DELETE ON stage_automation_decisions TO app_retention;

-- R-PERM-11: support actors are read-only on every table, including through definers (0016, 0021 §13)
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON stage_automation_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
