-- =============================================================================
-- 0076_b11_review_backlog: batch 11 review fixes for the backlog-gaps lane (finding ownership-data/F3 and the
-- reconciliation's backlog-6 and backlog-9; DATA_MODEL R-DATA-6, E553, V10, V13; finding db-public/F1 erratum below).
-- Why schema and not code: the purge is a SECURITY DEFINER owned by app_retention (0073), the only role that may
-- delete home_valuations or rewrite another member's citations of them; app_user cannot do either.
--
-- The gap. 0073's app.purge_home_valuations() deleted only home_valuations rows. Every home-value firing copies the
-- estimate verbatim (value, range, source name, as-of date: core nurture/avm.ts homeValueText) into
--   * playbook_step_runs.trigger_ref->'evidence'[].snippet (every run, whatever its status; api nurture/avm.ts,
--     decide.ts storedRefOf), shown by GET /contacts/:id/trigger-runs as the run's fact, and
--   * evidence_refs.snippet (source_type 'home_valuation', source_available true) of each draft's claim, which the
--     evidence views label as an available source,
-- and nothing purged or redacted them, so the value outlived its row and the citation still read as available.
--
-- The change. app.purge_home_valuations() is replaced (CREATE OR REPLACE: same signature, owner, grants). Its refusal
-- (HOME_VALUE_PURGE_SYSTEM_ONLY), its database clock, its 13-month cut-off and the two "still cited" exemptions are
-- verbatim. In the same statement-level pass, for the ids it deleted and the caller's tenant only:
--   * evidence_refs SET snippet = NULL, snippet_enc = NULL, source_available = false (the recordings pattern of
--     app.retention_sweep, 0001/0018/0037/0041), so assistant/views.ts and workspace/repos/evidence.ts label the
--     citation "Source removed under retention policy" and web design/Evidence.tsx shows that line (V10);
--   * every trigger run of the tenant whose stored evidence cites a deleted id loses that element's snippet and
--     gains "sourceAvailable": false (the rest of trigger_ref, the ref with valuationId and the skip, is kept), so
--     the trigger-runs view says the source was removed.
-- A row kept because a scheduled run or a waiting draft cites it keeps every copy. Not changed here (recorded in
-- DATA_MODEL R-DATA-6 and as an owner question): a draft's own text (assistant_actions.payload body and evidence
-- line, assistant_claims.text) and a message already sent keep the sentence as written: they are the record of what
-- was proposed or sent, under the message retention rule.
-- No backfill: 0073 and this migration land in the same batch (batch 11), so 0073's body has purged no row on any
-- deployment, and erasure (app.purge_contact_internal) deletes a person's runs and drafts together with their
-- valuations.
--
-- VERIFY WITH COUNSEL (C13 retention defaults for every new data class, C6 valuation wording; V13). 0073's header
-- calls C13 "AVM vendor licence term" and C6 "retention ranges"; PHASE2_3_PLAN §6 defines C13 as the retention
-- defaults for every new data class (R-DATA-6) and C6 as the AVM wording and state rules on valuations by
-- non-appraisers. Under owner decision D9 there is no third-party AVM: the open question is whether 13 months fits
-- the team's in-house valuation built from MLS data under the MLS licence term (owner question Q7: fixed for now).
--
-- Erratum for 0071's header (finding db-public/F1; 0071 is not edited). It says each merge trigger re-checks the
-- ownership command on its own. Only app.contacts_merge_roles (0053/0059) and app.contacts_merge_work (0072) do
-- (app.ownership_command() and the merged_away event). app.contacts_merge_children (0027),
-- app.webchat_sessions_follow_merge (0046) and app.contacts_dnc_follow_merge (0018) check only the tenant and the
-- survivor. So before 0071 an Owner's bare UPDATE did copy points, tags and notes, move chat sessions and carry the
-- do-not-contact (it moved no deal role, task or appointment), and today a superuser or BYPASSRLS bare UPDATE with no
-- tenant context still does exactly that: a partial merge (platform maintenance only; no application path).
-- Its "clearing the column (the FK's ON DELETE SET NULL) is never checked" cannot happen to an engine-merged record:
-- contacts_check2 (0001) requires merged_into_contact_id while closed_reason = 'merged', and
-- app.purge_contact_internal (0037/0041) deletes a merge tree deepest first, so the SET NULL never fires on such a row.
-- Proof: packages/db/test/backlog_merge_guard.test.ts "R-OWN-24 E547 (fences)".
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4; ARCHITECTURE §21.36):
--   * app.purge_home_valuations() (SECURITY DEFINER) is replaced: owner app_retention, search_path pinned to
--     pg_catalog, public, EXECUTE revoked from PUBLIC and granted to app_user only, no argument (re-asserted and
--     self-checked). It only writes more: two UPDATEs, both filtered by tenant_id = app.tenant_id() because its owner
--     bypasses RLS, touching only citations of rows this call deleted; they only remove text and set a flag false.
--   * app_retention already holds UPDATE on evidence_refs and playbook_step_runs (0001). No new grant, table, column,
--     policy, trigger or definer; app_user still has no DELETE on home_valuations.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.purge_home_valuations(OUT valuations_deleted integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  t uuid := app.tenant_id();
  gone uuid[];
  gone_txt text[];
BEGIN
  IF t IS NULL OR app.actor_kind() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'HOME_VALUE_PURGE_SYSTEM_ONLY: only the system actor of a tenant purges its home values' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 13 months: VERIFY WITH COUNSEL (C13, C6; V13)
  WITH d AS (
    DELETE FROM public.home_valuations v
     WHERE v.tenant_id = t
       AND v.valued_at < now() - interval '13 months'
       AND NOT EXISTS (
             SELECT 1 FROM public.playbook_step_runs r
              WHERE r.tenant_id = t
                AND r.trigger_ref->'ref'->>'valuationId' = v.id::text
                AND (r.status = 'scheduled'
                     OR (r.status = 'converted_to_draft'
                         AND EXISTS (SELECT 1 FROM public.assistant_actions a
                                      WHERE a.tenant_id = t AND a.id = r.assistant_action_id
                                        AND a.status IN ('proposed','approved')))))
    RETURNING v.id)
  SELECT coalesce(array_agg(d.id), '{}') INTO gone FROM d;
  valuations_deleted := cardinality(gone);
  IF valuations_deleted = 0 THEN
    RETURN;
  END IF;
  gone_txt := gone::text[];
  -- b11 review ownership-data/F3: the deleted rows' citations keep no copy of the estimate (V10)
  UPDATE public.evidence_refs e SET snippet = NULL, snippet_enc = NULL, source_available = false
   WHERE e.tenant_id = t AND e.source_type = 'home_valuation' AND e.source_id = ANY (gone)
     AND (e.source_available OR e.snippet IS NOT NULL OR e.snippet_enc IS NOT NULL);
  UPDATE public.playbook_step_runs r
     SET trigger_ref = jsonb_set(r.trigger_ref, '{evidence}', (
           SELECT coalesce(jsonb_agg(CASE WHEN x.el->>'sourceType' = 'home_valuation' AND x.el->>'sourceId' = ANY (gone_txt)
                                          THEN (x.el - 'snippet') || jsonb_build_object('sourceAvailable', false)
                                          ELSE x.el END ORDER BY x.ord), '[]'::jsonb)
             FROM jsonb_array_elements(r.trigger_ref->'evidence') WITH ORDINALITY AS x(el, ord)))
   WHERE r.tenant_id = t AND r.enrollment_id IS NULL
     AND jsonb_typeof(r.trigger_ref->'evidence') = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.trigger_ref->'evidence') AS y(el)
                  WHERE y.el->>'sourceType' = 'home_valuation' AND y.el->>'sourceId' = ANY (gone_txt)
                    AND (y.el ? 'snippet' OR y.el->'sourceAvailable' IS DISTINCT FROM 'false'::jsonb));
END $$;
ALTER FUNCTION app.purge_home_valuations() OWNER TO app_retention;
REVOKE ALL ON FUNCTION app.purge_home_valuations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_home_valuations() TO app_user;

-- Self-check: the definer's shape (owner, pinned path, no PUBLIC execute, app_user execute, no argument, one
-- function), that it still refuses non-system callers and now redacts both kinds of citation, and that app_user still
-- has no DELETE on home_valuations.
DO $$
DECLARE
  bad text := '';
  src text;
BEGIN
  IF NOT (SELECT p.prosecdef AND r.rolname = 'app_retention' AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
            FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
           WHERE p.oid = 'app.purge_home_valuations()'::regprocedure) THEN
    bad := bad || ' purge_shape';
  END IF;
  IF has_function_privilege('public', 'app.purge_home_valuations()', 'EXECUTE') THEN bad := bad || ' public_execute'; END IF;
  IF NOT has_function_privilege('app_user', 'app.purge_home_valuations()', 'EXECUTE') THEN bad := bad || ' app_user_execute'; END IF;
  IF has_table_privilege('app_user', 'public.home_valuations', 'DELETE') THEN bad := bad || ' app_user_delete'; END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.proname = 'purge_home_valuations' AND p.pronamespace = 'app'::regnamespace) <> 1
     OR (SELECT p.pronargs FROM pg_proc p WHERE p.oid = 'app.purge_home_valuations()'::regprocedure) <> 0 THEN
    bad := bad || ' takes_an_instant';
  END IF;
  SELECT p.prosrc INTO src FROM pg_proc p WHERE p.oid = 'app.purge_home_valuations()'::regprocedure;
  IF src NOT LIKE '%HOME_VALUE_PURGE_SYSTEM_ONLY%' OR src NOT LIKE '%interval ''13 months''%' THEN bad := bad || ' purge_rule'; END IF;
  IF src NOT LIKE '%UPDATE public.evidence_refs e SET snippet = NULL, snippet_enc = NULL, source_available = false%' THEN bad := bad || ' evidence_redaction'; END IF;
  IF src NOT LIKE '%UPDATE public.playbook_step_runs r%' OR src NOT LIKE '%''sourceAvailable'', false%' THEN bad := bad || ' run_redaction'; END IF;
  IF NOT has_table_privilege('app_retention', 'public.evidence_refs', 'UPDATE') OR NOT has_table_privilege('app_retention', 'public.playbook_step_runs', 'UPDATE') THEN
    bad := bad || ' retention_update';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'b11_review_backlog self-check failed:%', bad; END IF;
END $$;
