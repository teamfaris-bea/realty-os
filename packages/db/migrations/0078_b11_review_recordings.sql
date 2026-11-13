-- =============================================================================
-- 0078_b11_review_recordings: batch 11 review fix for call recordings and transcripts (finding ownership-data/F2;
-- R-OWN-24, R-PERM-8, R-PERM-9). The same class as ownership-data/F1 (documents, 0075). Why schema and not code: the
-- gap is in three policies. (0077 is the CMA reports fix of the same finding class.)
--
-- A merge re-points the merged-away record's messages and calls to the survivor (db/ownership/merge.ts
-- mergeCommunication), but no merge path (TS, 0027, 0053, 0059, 0071, 0072) touches recordings.contact_id or
-- transcripts.contact_id, so a moved call's recording and transcript keep the merged-away record's id. Contacts RLS
-- hides that record (closed, no owner) from everyone who is not tenant-wide, so before this migration:
--   * recordings_select / transcripts_select (0001), app.contact_detail_visible(merged-away record), were false, and
--   * recording_scope (0001, RESTRICTIVE, R-PERM-8) looked the merged-away record up for its 'own' and 'team' branches
--     (no owner: false) and compared it with the caller's deal contacts for 'deal' (the merge moved the deal roles and
--     the deal's primary person to the survivor, 0053/0059: false),
-- and the moved call's recording and transcript vanished for the survivor's agent, Team Lead and the TC on the person's
-- deal; only the Owner and Admins kept them (POST /recordings/:id/stream-token and GET /recordings/:id/transcript 404).
-- Proof: apps/api/src/comms/b11review.recordings.test.ts (fails without this migration).
--
-- The change: a recording or transcript is also visible to whoever sees the ROOT SURVIVOR of its record in detail (the
-- record the merge chain ends at, app.contact_merge_root, 0075), and the recording scope is applied to that root as well
-- as to the record itself. Every branch is the 0001 condition OR the same condition on the root, so every row admitted
-- before is admitted now; a row of a record that was never merged is decided exactly as before (its root is itself).
-- Visibility itself is still decided under the caller's RLS: contact_detail_visible and the contacts lookup in
-- recording_scope run as the caller; the definer helper only answers where a merge chain goes.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * no new function. app.contact_merge_root(uuid, uuid) (0075: SECURITY DEFINER, owner app_definer, STABLE, pinned
--     search_path, follows merged_into_contact_id inside the caller's own tenant only; EXECUTE app_user only) is reused;
--     it is re-asserted below.
--   * recordings_select (0001) is replaced: + OR app.contact_detail_visible(tenant_id, root).
--   * transcripts_select (0001) is replaced the same way (transcripts.contact_id is the recording's record).
--   * recording_scope (0001) stays RESTRICTIVE (ALTER POLICY cannot change that; asserted below) with the same four
--     scopes from app.recording_scope() and the same tenant settings: 'all' verbatim; 'team' and 'own' look up the
--     record OR its root (c.id IN (contact_id, root)) with the 0001 owner conditions verbatim; 'deal' adds
--     root = ANY(app.my_deal_contact_ids()). agent_user_id branches verbatim.
--   * unchanged: transcript_scope (RESTRICTIVE: a transcript needs its recording visible, so it inherits all of the
--     above), recordings_write / transcripts_write (system only), tenant_isolation and support_read_only_* on both
--     tables, objects_select (a recording's object is readable through a visible recording), recording_stream_tokens
--     (own tokens; INSERT needs the recording visible).
--   A larger set of readers only for recordings of a person the reader already sees in detail and whose recording scope
--   covers that person: the survivor's agent, the Team Lead of the survivor's agent (team_lead_recording_access), the
--   TC on the survivor's deal (tc_recording_access). The agent who was on the call but no longer sees the person (a
--   merge into another agent's record) still gets nothing, as with the call itself. A peer agent gets nothing; another
--   tenant's id resolves to itself and tenant_isolation applies.
-- No table, column, trigger, function or grant changes.
-- =============================================================================

-- recordings_select (0001): the record's detail, or its root survivor's.
ALTER POLICY recordings_select ON recordings USING (
  app.contact_detail_visible(tenant_id, contact_id)
  OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)));

-- transcripts_select (0001): the same, on the transcript's own record id.
ALTER POLICY transcripts_select ON transcripts USING (
  app.contact_detail_visible(tenant_id, contact_id)
  OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)));

-- recording_scope (0001, RESTRICTIVE, R-PERM-8): the same scopes; each contact condition also holds on the root survivor.
ALTER POLICY recording_scope ON recordings USING (
  CASE (SELECT app.recording_scope())
    WHEN 'all'  THEN true
    WHEN 'team' THEN agent_user_id = (SELECT app.user_id()) OR EXISTS (
                       SELECT 1 FROM contacts c WHERE c.tenant_id = recordings.tenant_id
                          AND c.id IN (recordings.contact_id, app.contact_merge_root(recordings.tenant_id, recordings.contact_id))
                          AND (c.owner_user_id = (SELECT app.user_id())
                               OR c.owner_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])))
    WHEN 'deal' THEN agent_user_id = (SELECT app.user_id())
                     OR contact_id = ANY ((SELECT app.my_deal_contact_ids())::uuid[])
                     OR app.contact_merge_root(tenant_id, contact_id) = ANY ((SELECT app.my_deal_contact_ids())::uuid[])
    ELSE agent_user_id = (SELECT app.user_id()) OR EXISTS (
           SELECT 1 FROM contacts c WHERE c.tenant_id = recordings.tenant_id
              AND c.id IN (recordings.contact_id, app.contact_merge_root(recordings.tenant_id, recordings.contact_id))
              AND c.owner_user_id = (SELECT app.user_id()))
  END);

-- Self-check: the policy sets are unchanged, the three replaced policies follow the root, the scope gates are still
-- RESTRICTIVE SELECT, and the helper is still a definer owned by app_definer that only app_user may execute.
DO $$
DECLARE bad text := '';
  r record;
  fn constant text := 'app.contact_merge_root(uuid,uuid)';
BEGIN
  IF (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'recordings')
     IS DISTINCT FROM ARRAY['recording_scope','recordings_select','recordings_write','support_read_only_del','support_read_only_ins',
                            'support_read_only_upd','tenant_isolation'] THEN
    bad := bad || ' recordings policy set';
  END IF;
  IF (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'transcripts')
     IS DISTINCT FROM ARRAY['support_read_only_del','support_read_only_ins','support_read_only_upd','tenant_isolation',
                            'transcript_scope','transcripts_select','transcripts_write'] THEN
    bad := bad || ' transcripts policy set';
  END IF;
  FOR r IN SELECT tablename, policyname, permissive, cmd, qual FROM pg_policies
            WHERE schemaname = 'public' AND (tablename, policyname) IN (('recordings','recordings_select'), ('transcripts','transcripts_select'),
                                                                        ('recordings','recording_scope'), ('transcripts','transcript_scope')) LOOP
    IF r.cmd <> 'SELECT'
       OR (r.permissive = 'RESTRICTIVE') <> (r.policyname IN ('recording_scope','transcript_scope'))
       OR (r.policyname <> 'transcript_scope' AND r.qual NOT LIKE '%contact_merge_root(%')
       OR (r.policyname IN ('recordings_select','transcripts_select') AND r.qual NOT LIKE '%contact_detail_visible(tenant_id, contact_id)%')
       OR (r.policyname = 'recording_scope' AND r.qual NOT LIKE '%recording_scope()%') THEN
      bad := bad || ' ' || r.tablename || '.' || r.policyname;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = fn::regprocedure AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'app_definer'
                    AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'))
     OR has_function_privilege('public', fn, 'EXECUTE') OR NOT has_function_privilege('app_user', fn, 'EXECUTE') THEN
    bad := bad || ' ' || fn;
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION '0078 self-check failed:%', bad; END IF;
END $$;
