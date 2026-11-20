-- Batch 19, policy review F9: playbook_versions.narrows_previous is written once, at approval, and frozen
-- (R-ISA-39; docs/AI_ISA.md §3.2; DATA_MODEL E1012). Security notes: docs/ARCHITECTURE.md §21.81.
--
--   0080 added playbook_versions.narrows_previous (kind ai_isa only): true when an approved version of the team AI
--   policy allows no more than the version it supersedes. The consent chain's link 4 (apps/api isa/repo.ts versionState,
--   EFFECTIVE_POLICY_SQL) and the send guard (0080, 0081, 0083) read it: care bound to an older version continues, under
--   the successor's content, with no re-confirmation, exactly when every successor is a narrowing.
--   app.playbook_versions_guard (0001) freezes steps, tone, content_sha256, playbook_id and version_no once a version
--   leaves draft. It does not name narrows_previous. So one UPDATE of that column, by SQL in an Owner, an Admin or a
--   system context (pv_update admits them), flipped a WIDER successor to "narrows": the chain then served the wider
--   content to care that had agreed only to the older one. No application path did it; nothing in the database refused it.
--
--   * app.playbook_versions_narrows_guard(), a BEFORE INSERT OR UPDATE row trigger on playbook_versions (an INVOKER
--     with a pinned search_path; EXECUTE revoked from PUBLIC):
--       - INSERT: narrows_previous must be NULL (a version is born a draft, and a draft narrows nothing);
--       - UPDATE that changes narrows_previous: allowed only when the same UPDATE takes the row from 'draft' to
--         'approved' (0001's guard then demands the matching approval row) AND the row's playbook is of kind 'ai_isa';
--         anything else raises PLAYBOOK_NARROWS_FROZEN, or PLAYBOOK_NARROWS_NOT_POLICY for another kind of playbook;
--       - an UPDATE that leaves the column as it is passes untouched (superseding, revoking, saving a draft).
--     The kind is read from playbooks under the caller's row-level security. Whoever can update the version can read
--     its playbook (pv_update and the playbooks policies name the same rows); a playbook the caller cannot read is
--     treated as not a policy, so the guard fails closed.
--   What this does NOT decide: whether true is the RIGHT value at approval. That is core narrowsPrevious, computed by
--   apps/api isa/policy.ts under the policy lock; the database cannot compare two policy contents. This guard makes the
--   value the approving transaction wrote the value forever.
--
--   No definer is added or changed; no table, column, policy, grant or retention change. EXISTING DATA: no row is
--   rewritten. A version approved before this migration keeps the value it has (NULL, false or true) and can no longer
--   be given another.

CREATE FUNCTION app.playbook_versions_narrows_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.narrows_previous IS NOT NULL THEN
      RAISE EXCEPTION 'PLAYBOOK_NARROWS_FROZEN: narrows_previous is written only by the update that approves a draft'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.narrows_previous IS NOT DISTINCT FROM OLD.narrows_previous THEN RETURN NEW; END IF;
  IF NOT (OLD.status = 'draft' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'PLAYBOOK_NARROWS_FROZEN: narrows_previous is written only by the update that approves a draft, and never changes afterwards'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.kind INTO k FROM public.playbooks p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.playbook_id;
  IF k IS DISTINCT FROM 'ai_isa' THEN
    RAISE EXCEPTION 'PLAYBOOK_NARROWS_NOT_POLICY: only a version of the team AI policy has narrows_previous'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.playbook_versions_narrows_guard() FROM PUBLIC;

CREATE TRIGGER playbook_versions_narrows_guard BEFORE INSERT OR UPDATE ON playbook_versions
  FOR EACH ROW EXECUTE FUNCTION app.playbook_versions_narrows_guard();

-- Self-check: an invoker that pins its path, on its trigger, for both events and every row; 0001's guard still there.
DO $$
DECLARE g record;
BEGIN
  SELECT prosecdef AS definer, proconfig AS config INTO g FROM pg_proc WHERE oid = 'app.playbook_versions_narrows_guard()'::regprocedure;
  IF g.definer THEN RAISE EXCEPTION '0112: app.playbook_versions_narrows_guard must be an invoker'; END IF;
  IF NOT ('search_path=pg_catalog, public' = ANY (g.config)) THEN RAISE EXCEPTION '0112: app.playbook_versions_narrows_guard must pin its search_path'; END IF;
  IF has_function_privilege('public', 'app.playbook_versions_narrows_guard()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '0112: app.playbook_versions_narrows_guard must not be executable by PUBLIC';
  END IF;
  -- tgtype: 1 row, 2 before, 4 insert, 16 update (7 + 16 = 23: BEFORE INSERT OR UPDATE, FOR EACH ROW); 'O': fires in origin mode
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.playbook_versions'::regclass AND t.tgname = 'playbook_versions_narrows_guard'
                    AND t.tgfoid = 'app.playbook_versions_narrows_guard()'::regprocedure AND NOT t.tgisinternal AND t.tgtype = 23 AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION '0112: the playbook_versions_narrows_guard trigger must be BEFORE INSERT OR UPDATE FOR EACH ROW and enabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.playbook_versions'::regclass AND t.tgname = 'playbook_versions_guard'
                    AND t.tgfoid = 'app.playbook_versions_guard()'::regprocedure AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '0112: the playbook_versions_guard trigger (0001) must still be on playbook_versions';
  END IF;
END $$;
