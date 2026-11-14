-- Batch 18 item f (PHASE2_3_PLAN product boundaries, owner 2026-11-14): an Owner-only lead-source setting, "No AI care
-- for leads from this source". Security notes: docs/ARCHITECTURE.md §21.61.
--
--   The owner named one referral source whose leads must never get AI care (its partner has no AI permission). The
--   repository never names it: the Owner turns this setting on for that source in the app.
--   * lead_sources.no_ai_care (NOT NULL, default false: every existing source keeps today's behaviour) and
--     no_ai_care_changed_at.
--   * app.lead_sources_no_ai_care_guard (invoker trigger): only an Owner, as themselves, changes the setting (either
--     way, and an insert that sets it); the API route is Owner-only too (core authz lead_source.ai_care).
--   * app.person_no_ai_care_source(tenant, contact) (SECURITY DEFINER, owned by app_definer, search_path pinned,
--     tenant_id = app.tenant_id() explicit, returns one boolean): whether any record of the person (the merge tree,
--     app.contact_person_ids, read past the caller's RLS as app.ai_isa_person_blocked does) has an original lead source
--     with no_ai_care set. The AI ISA start refusal and chain link 11 (apps/api/src/isa) and the trigger below ask it.
--   * app.ai_isa_assignments_source_guard (invoker trigger, beside 0081's ai_isa_assignments_guard): refuses a new
--     assignment, and a resume (paused_at cleared on a live assignment), for such a person: AI_ISA_SOURCE_NO_AI_CARE.
--     A pause, an end and every other update pass, so the system can still pause or end care.
--   * ai_isa_assignments.pause_reason gains 'source_no_ai_care' (core ISA_PAUSE_REASONS): the system pause written when
--     the chain finds link 11 failing.
--   No existing record is changed: the new columns default to false/NULL and the CHECK only widens. No grant to
--   app_user beyond EXECUTE on the definer; no retention change.

ALTER TABLE lead_sources ADD COLUMN no_ai_care boolean NOT NULL DEFAULT false;
ALTER TABLE lead_sources ADD COLUMN no_ai_care_changed_at timestamptz;
COMMENT ON COLUMN lead_sources.no_ai_care IS
  'b18: "No AI care for leads from this source" (Owner only; app.lead_sources_no_ai_care_guard). AI care never starts or resumes for a person whose original lead source has it.';

CREATE FUNCTION app.lead_sources_no_ai_care_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF (TG_OP = 'INSERT' AND NEW.no_ai_care) OR (TG_OP = 'UPDATE' AND NEW.no_ai_care IS DISTINCT FROM OLD.no_ai_care) THEN
    IF NOT (app.actor_kind() = 'user' AND app.my_role() = 'owner') THEN
      RAISE EXCEPTION 'LEAD_SOURCE_AI_CARE_OWNER_ONLY: only the Owner changes "No AI care for leads from this source"'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_sources_no_ai_care_guard() FROM PUBLIC;
CREATE TRIGGER lead_sources_no_ai_care_guard BEFORE INSERT OR UPDATE OF no_ai_care ON lead_sources
  FOR EACH ROW EXECUTE FUNCTION app.lead_sources_no_ai_care_guard();

CREATE FUNCTION app.person_no_ai_care_source(p_tenant uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(p_tenant = app.tenant_id(), false) AND EXISTS (
    SELECT 1 FROM public.contacts c JOIN public.lead_sources s ON s.tenant_id = c.tenant_id AND s.id = c.original_lead_source_id
     WHERE c.tenant_id = p_tenant AND c.id = ANY (app.contact_person_ids(p_tenant, p_contact)) AND s.no_ai_care)
$$;
ALTER FUNCTION app.person_no_ai_care_source(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_no_ai_care_source(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_no_ai_care_source(uuid, uuid) TO app_user;

CREATE FUNCTION app.ai_isa_assignments_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row
  IF (TG_OP = 'INSERT' AND NEW.ended_at IS NULL)
     OR (TG_OP = 'UPDATE' AND OLD.paused_at IS NOT NULL AND NEW.paused_at IS NULL AND NEW.ended_at IS NULL) THEN
    IF app.person_no_ai_care_source(NEW.tenant_id, NEW.contact_id) THEN
      RAISE EXCEPTION 'AI_ISA_SOURCE_NO_AI_CARE: the Owner set "No AI care for leads from this source" on this person''s lead source'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.ai_isa_assignments_source_guard() FROM PUBLIC;
CREATE TRIGGER ai_isa_assignments_source_guard BEFORE INSERT OR UPDATE OF paused_at ON ai_isa_assignments
  FOR EACH ROW EXECUTE FUNCTION app.ai_isa_assignments_source_guard();

ALTER TABLE ai_isa_assignments DROP CONSTRAINT ai_isa_assignments_pause_reason_check;
ALTER TABLE ai_isa_assignments ADD CONSTRAINT ai_isa_assignments_pause_reason_check CHECK (pause_reason IN ('user','human_contact','unverified_sender',
  'call','chat','synced_mail','media','pack_withdrawn','ai_off','approval_revoked','policy_updated','reinquiry','possible_listing','check_this',
  'taking_over','ending','source_no_ai_care'));

-- Self-check: every existing source is off for the setting, the definer is owned by app_definer and pins its path.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM lead_sources WHERE no_ai_care) THEN RAISE EXCEPTION '0094: an existing source was marked'; END IF;
  IF (SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = 'app.person_no_ai_care_source(uuid,uuid)'::regprocedure) <> 'app_definer' THEN
    RAISE EXCEPTION '0094: app.person_no_ai_care_source must be owned by app_definer';
  END IF;
END $$;
