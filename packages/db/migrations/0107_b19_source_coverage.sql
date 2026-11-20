-- Batch 19, team-queue lane step 2 (handoff visibility; owner decisions 2026-11-19, 1 to 4): source coverage.
-- DATA_MODEL R-TEAMQ-10, R-TEAMQ-11. Security notes: docs/ARCHITECTURE.md §21.77.
--
--   Each lead source can carry a named owner, a named backup, a "high intent" mark and a "covered" switch.
--   * lead_sources.owner_user_id, backup_user_id: members of the SAME team (composite foreign keys to memberships;
--     a membership row is never deleted, so suspending or removing a named member never fails and never clears the
--     source: the row keeps naming them, the read flags it and says it is not covered, and nobody is put in their
--     place).
--   * lead_sources.high_intent (NOT NULL, default false) and covered (NOT NULL, default false), with
--     lead_sources_covered_needs_both: covered can be on only while an owner and a backup are both named.
--     coverage_changed_at: when any of the four last changed.
--   * app.lead_sources_coverage_guard (invoker trigger, search_path pinned): the four columns change only under an
--     Owner or an Admin acting as themselves (the API route is settings.routing, Owner and Admin). The system actor
--     (an integration that creates or updates a source), support and every other role never name an owner or a
--     backup and never turn coverage on. For a missing or foreign tenant context it returns: row-level security
--     refuses the row.
--   No existing record is changed: every source starts with nobody named, not high intent, not covered, so today's
--   behaviour (the tenant's auto-release setting, no backup alert) is unchanged until an Owner or Admin sets it.
--   No table, no SECURITY DEFINER function, no grant and no retention change.

ALTER TABLE lead_sources ADD COLUMN owner_user_id uuid;
ALTER TABLE lead_sources ADD COLUMN backup_user_id uuid;
ALTER TABLE lead_sources ADD COLUMN high_intent boolean NOT NULL DEFAULT false;
ALTER TABLE lead_sources ADD COLUMN covered boolean NOT NULL DEFAULT false;
ALTER TABLE lead_sources ADD COLUMN coverage_changed_at timestamptz;
ALTER TABLE lead_sources ADD CONSTRAINT lead_sources_owner_member_fk FOREIGN KEY (tenant_id, owner_user_id) REFERENCES memberships (tenant_id, user_id);
ALTER TABLE lead_sources ADD CONSTRAINT lead_sources_backup_member_fk FOREIGN KEY (tenant_id, backup_user_id) REFERENCES memberships (tenant_id, user_id);
ALTER TABLE lead_sources ADD CONSTRAINT lead_sources_covered_needs_both CHECK (NOT covered OR (owner_user_id IS NOT NULL AND backup_user_id IS NOT NULL));
COMMENT ON COLUMN lead_sources.owner_user_id IS 'b19: the member named as this source''s owner (Owner/Admin set it; never changed by a suspension or a removal).';
COMMENT ON COLUMN lead_sources.backup_user_id IS 'b19: the member named as this source''s backup: who the minute-three backup alert goes to. Never changed by a suspension or a removal.';
COMMENT ON COLUMN lead_sources.high_intent IS 'b19: the team marks this source''s leads as high intent (a label for people and reports; it changes no routing).';
COMMENT ON COLUMN lead_sources.covered IS 'b19: the coverage switch; on only while an owner and a backup are both named. The read says "covered" only while both are also active members.';

CREATE FUNCTION app.lead_sources_coverage_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE changed boolean;
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row, and a missing context
  IF TG_OP = 'INSERT' THEN
    changed := NEW.owner_user_id IS NOT NULL OR NEW.backup_user_id IS NOT NULL OR NEW.high_intent OR NEW.covered;
  ELSE
    changed := (NEW.owner_user_id, NEW.backup_user_id, NEW.high_intent, NEW.covered) IS DISTINCT FROM (OLD.owner_user_id, OLD.backup_user_id, OLD.high_intent, OLD.covered);
  END IF;
  IF changed AND NOT COALESCE(app.actor_kind() = 'user' AND app.my_role() IN ('owner', 'admin'), false) THEN
    RAISE EXCEPTION 'LEAD_SOURCE_COVERAGE_OWNER_ADMIN_ONLY: only an Owner or an Admin names a source''s owner and backup and turns coverage on or off'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_sources_coverage_guard() FROM PUBLIC;
CREATE TRIGGER lead_sources_coverage_guard BEFORE INSERT OR UPDATE OF owner_user_id, backup_user_id, high_intent, covered ON lead_sources
  FOR EACH ROW EXECUTE FUNCTION app.lead_sources_coverage_guard();

-- Self-check: nothing existing is covered or names anyone; the guard is an invoker that pins its path and sits on its trigger.
DO $$
DECLARE p record;
BEGIN
  IF EXISTS (SELECT 1 FROM lead_sources WHERE covered OR high_intent OR owner_user_id IS NOT NULL OR backup_user_id IS NOT NULL) THEN
    RAISE EXCEPTION '0107: an existing source was given coverage';
  END IF;
  SELECT prosecdef, proconfig INTO p FROM pg_proc WHERE oid = 'app.lead_sources_coverage_guard()'::regprocedure;
  IF p.prosecdef THEN RAISE EXCEPTION '0107: app.lead_sources_coverage_guard must be an invoker'; END IF;
  IF p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION '0107: app.lead_sources_coverage_guard must pin its search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.lead_sources'::regclass AND tgname = 'lead_sources_coverage_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '0107: the coverage guard trigger is missing';
  END IF;
END $$;
