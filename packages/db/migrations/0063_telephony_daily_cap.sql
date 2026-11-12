-- Lane telephony-safeguards S1 (R-TWL-2): a per-tenant daily cap on outbound texts and calls through the real
-- telephony adapter. Placeholder number (the orchestrator renumbers at merge).
--
-- 1. tenant_settings.telephony_daily_cap: how many outbound texts and calls a tenant may hand the telephony
--    provider per tenant-local day. Conservative owner default 200 (owner question, one setting changes it).
-- 2. telephony_daily_usage: one counter row per tenant per tenant-local day. dispatch.ts / dial.ts claim one unit
--    INSIDE the send-time transaction (TX1, under the per-contact lock) with a single
--    INSERT .. ON CONFLICT DO UPDATE .. WHERE sends < cap: the conflicting row is locked and the WHERE re-checked on
--    its latest version, so two concurrent sends at cap-1 cannot both pass (E380). A TX1 that rolls back gives its
--    unit back with it. The opt-out-exempt STOP confirmation and HELP reply are never counted (E381).
--    Rows only ever count up: a trigger refuses a lower count or a moved key, so nobody (a person's own
--    transaction included) can reopen a day's budget. No SECURITY DEFINER function is added.

ALTER TABLE tenant_settings ADD COLUMN telephony_daily_cap integer NOT NULL DEFAULT 200
  CHECK (telephony_daily_cap BETWEEN 1 AND 100000);

CREATE TABLE telephony_daily_usage (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  day        date NOT NULL,
  sends      integer NOT NULL CHECK (sends BETWEEN 1 AND 100000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);
ALTER TABLE telephony_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_daily_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON telephony_daily_usage AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON telephony_daily_usage AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON telephony_daily_usage AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON telephony_daily_usage AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
-- any member's own send claims a unit in its own TX1 (a human send runs as that human, R-TEN-3); the system's too
CREATE POLICY telephony_daily_usage_select ON telephony_daily_usage FOR SELECT USING ((SELECT app.is_member()));
CREATE POLICY telephony_daily_usage_insert ON telephony_daily_usage FOR INSERT WITH CHECK ((SELECT app.is_member()));
CREATE POLICY telephony_daily_usage_update ON telephony_daily_usage FOR UPDATE USING ((SELECT app.is_member())) WITH CHECK ((SELECT app.is_member()));
GRANT SELECT, INSERT, UPDATE ON telephony_daily_usage TO app_user;
GRANT SELECT ON telephony_daily_usage TO app_definer;

CREATE FUNCTION app.telephony_daily_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.day IS DISTINCT FROM OLD.day OR NEW.sends < OLD.sends THEN
    RAISE EXCEPTION 'TELEPHONY_USAGE_COUNTS_UP: a day''s send count only grows' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER telephony_daily_usage_guard BEFORE UPDATE ON telephony_daily_usage
  FOR EACH ROW EXECUTE FUNCTION app.telephony_daily_usage_guard();
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON telephony_daily_usage
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
