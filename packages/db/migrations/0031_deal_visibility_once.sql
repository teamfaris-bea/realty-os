-- 0031 (written as 0025 in lane perf-misses, miss #4): the contact-detail check on the contact page and timeline tables is
-- planned as part of the reading statement, so its InitPlans (above all app.my_deal_contact_ids(), about
-- 5,800 ids and 9.5 ms for a TC on about 2,900 deals at 250k) run ONCE per statement instead of once per
-- child row. No SECURITY DEFINER, no LEAKPROOF, no change to WHO can see WHAT (proved row by row, through
-- RLS as app_user, for every role and the system actor in apps/api/src/load/deal_visibility_equivalence.test.ts).
--
-- Why it was slow. The child-table policies called app.contact_detail_visible(tenant_id, contact_id), an
-- invoker SQL function whose body is SELECT EXISTS (...). Postgres never inlines a scalar SQL function with
-- a sublink, so every child row executes the body separately, and every execution re-runs the InitPlans of
-- the contacts SELECT policy that applies inside it. For a TC every policy branch before the deal branch is
-- false, so each message / call / note / ledger row rebuilt the TC's deal-contact array. Measured at 250k
-- (EXPLAIN ANALYZE, the API's timeline SQL as the TC, a 25-item timeline): the messages scan took 230.6 ms
-- for 21 rows (about 11 ms per row) and the whole statement 563 ms; after this migration 12.4 ms and 59 ms.
--
-- The change. app.contact_detail_row(p_tenant, p_contact) has EXACTLY the body of contact_detail_visible
-- (0020's version) as a set-returning SQL function: it returns the contact's id when the caller sees the
-- contact AND its detail, and no row otherwise. A set-returning SQL function that is not SECURITY DEFINER,
-- has no SET clause and is a single SELECT IS inlined by the planner when it appears in FROM, including
-- inside a policy's EXISTS sublink. The body then becomes an ordinary subquery of the reading statement:
-- the contacts RLS policy is still applied to it (RLS is added when the inlined body is rewritten, the
-- function runs as the caller), and the parameter-free helpers, both those of the contacts policy and the
-- (SELECT app.sees_all_detail()) / collab / deal arrays written below, become InitPlans of that statement.
--
-- Why visibility is unchanged.
--  * EXISTS (SELECT 1 FROM app.contact_detail_row(t, c)) is true iff the function returns a row, iff some
--    contacts row visible to the caller has tenant_id = t, id = c and passes the detail test; that is
--    word for word the EXISTS of contact_detail_visible(t, c).
--  * The detail test itself is unchanged except that each parameter-free STABLE helper call f() is
--    written (SELECT f()): a scalar subquery of a STABLE, argument-free function returns the same value
--    as the call within one statement.
--  * Only the USING clauses named below change; every WITH CHECK keeps contact_detail_visible (single
--    written rows). app.contact_detail_visible itself, contacts_select and every other policy and caller
--    (API select lists, 0018 tables, tasks, recordings, ...) are untouched.
-- Self-checks at the end: the new function is inlined (no Function Scan), and every policy listed now
-- uses it.

CREATE FUNCTION app.contact_detail_row(p_tenant uuid, p_contact uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE ROWS 1 AS $$
  SELECT c.id FROM public.contacts c
   WHERE c.tenant_id = p_tenant AND c.id = p_contact
     AND (c.ownership_state NOT IN ('in_pond','offered')
          OR (SELECT app.sees_all_detail())
          OR c.id = ANY ((SELECT app.my_collab_contact_ids())::uuid[])
          OR c.id = ANY ((SELECT app.my_deal_contact_ids())::uuid[]))
$$;
COMMENT ON FUNCTION app.contact_detail_row(uuid, uuid) IS
  'Inlinable twin of app.contact_detail_visible for policies: EXISTS (SELECT 1 FROM app.contact_detail_row(t, c)) = app.contact_detail_visible(t, c). Must stay invoker, without SET clauses (or it stops being inlined).';
REVOKE ALL ON FUNCTION app.contact_detail_row(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contact_detail_row(uuid, uuid) TO app_user;

-- Layer 2 (c) contact children (0001's DO loop): USING only; WITH CHECK stays contact_detail_visible.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contact_points','contact_addresses','contact_attributes','lead_inquiries',
     'conversations','behavior_events','saved_searches','playbook_enrollments','home_valuations','listing_contacts'] LOOP
    EXECUTE format('ALTER POLICY contact_detail ON public.%1$I '
                   'USING (EXISTS (SELECT 1 FROM app.contact_detail_row(%1$I.tenant_id, %1$I.contact_id)))', t);
  END LOOP;
END $$;

-- The timeline's tables (contact_timeline view: messages, calls, notes, ledger, appointments, behavior).
ALTER POLICY messages_select ON messages USING (
  EXISTS (SELECT 1 FROM app.contact_detail_row(messages.tenant_id, messages.contact_id)));
ALTER POLICY calls_select ON calls USING (
  EXISTS (SELECT 1 FROM app.contact_detail_row(calls.tenant_id, calls.contact_id)));
ALTER POLICY notes_select ON notes USING (
  (contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.contact_detail_row(notes.tenant_id, notes.contact_id)))
  OR (contact_id IS NULL AND deal_id IS NOT NULL AND app.deal_visible(tenant_id, deal_id)));
ALTER POLICY appointments_all ON appointments USING (
  (SELECT app.is_tenant_wide()) OR user_id = (SELECT app.user_id())
  OR (contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.contact_detail_row(appointments.tenant_id, appointments.contact_id)))
  OR (deal_id IS NOT NULL AND app.deal_visible(tenant_id, deal_id)));
-- 0016's ledger policy: only the ELSE branch (everybody but a Team Lead) used contact_detail_visible.
ALTER POLICY loe_select ON lead_ownership_events USING (
  (SELECT app.is_tenant_wide())
  OR CASE WHEN (SELECT app.my_role()) = 'team_lead' THEN
         owner_user_id      = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR prev_owner_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR offered_to_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR actor_user_id      = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR contact_id = ANY ((SELECT app.my_collab_contact_ids())::uuid[])
      OR contact_id = ANY ((SELECT app.my_deal_contact_ids())::uuid[])
      OR app.contact_owned_by_my_team(tenant_id, contact_id)
     ELSE EXISTS (SELECT 1 FROM app.contact_detail_row(lead_ownership_events.tenant_id, lead_ownership_events.contact_id)) END);

-- Self-checks.
-- 1. Inlined: the plan of a policy-shaped EXISTS shows the contacts scan, never a Function Scan on the helper.
DO $$
DECLARE r record; txt text := '';
BEGIN
  FOR r IN EXECUTE 'EXPLAIN (COSTS OFF) SELECT 1 FROM public.messages m '
                   'WHERE EXISTS (SELECT 1 FROM app.contact_detail_row(m.tenant_id, m.contact_id))' LOOP
    txt := txt || r."QUERY PLAN" || E'\n';
  END LOOP;
  IF txt LIKE '%Function Scan%' OR txt NOT LIKE '%contacts%' THEN
    RAISE EXCEPTION '0031 self-check: app.contact_detail_row is not inlined:%', E'\n' || txt;
  END IF;
END $$;

-- 2. Every listed policy now reads through the helper; FOR ALL policies keep contact_detail_visible in WITH CHECK.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(format('%s.%s', tablename, policyname), ', ') INTO missing
    FROM (VALUES ('contact_points','contact_detail'), ('contact_addresses','contact_detail'), ('contact_attributes','contact_detail'),
                 ('lead_inquiries','contact_detail'), ('conversations','contact_detail'), ('behavior_events','contact_detail'),
                 ('saved_searches','contact_detail'), ('playbook_enrollments','contact_detail'), ('home_valuations','contact_detail'),
                 ('listing_contacts','contact_detail'), ('messages','messages_select'), ('calls','calls_select'),
                 ('notes','notes_select'), ('appointments','appointments_all'), ('lead_ownership_events','loe_select')) v(tablename, policyname)
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v.tablename
                        AND p.policyname = v.policyname AND p.qual LIKE '%app.contact_detail_row(%'
                        AND p.qual NOT LIKE '%contact_detail_visible%'
                        AND (p.cmd <> 'ALL' OR p.with_check LIKE '%contact_detail_visible%'));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0031 self-check: policies not rewritten as expected: %', missing;
  END IF;
END $$;
