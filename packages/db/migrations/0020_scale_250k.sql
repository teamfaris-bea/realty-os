-- 0016 (lane scale-250k): cheaper row-level visibility checks and two missing lookup indexes, measured
-- at 250k contacts (docs/PERFORMANCE.md). No new table, no new function, no SECURITY DEFINER, no change to
-- WHO can see WHAT: every policy and helper below returns exactly what it returned before (proved row by
-- row in apps/api/src/load/rls_equivalence.test.ts).
--
-- Why it matters. Child tables (messages, calls, notes, contact_points, recordings, ...) check every row
-- with app.contact_detail_visible(tenant_id, contact_id). Postgres never inlines that SQL function (its
-- body has an EXISTS sublink), so each row runs it separately, and inside it the contacts SELECT policy is
-- re-evaluated with its InitPlans. InitPlans run lazily, in the order the OR branches are written, so the
-- ORDER of the branches decides how many SECURITY DEFINER helpers (each with its own search_path) run per
-- row. Measured as an agent on their own contacts: 0.65 ms per row before, 0.14 ms after.

-- 1. contact_detail_visible: test the row's own column before calling app.sees_all_detail() (a definer
--    that calls two more definers). OR is commutative and every operand is a side-effect-free STABLE
--    expression, so the result is identical; most rows (owned contacts) now never call the helper.
CREATE OR REPLACE FUNCTION app.contact_detail_visible(p_tenant uuid, p_contact uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.tenant_id = p_tenant AND c.id = p_contact
       AND (c.ownership_state NOT IN ('in_pond','offered')
            OR app.sees_all_detail()
            OR c.id = ANY (app.my_collab_contact_ids())
            OR c.id = ANY (app.my_deal_contact_ids())))
$$;

-- 2. contacts_select: lead with "my own, not deleted, and I am a member". That disjunct is the first
--    alternative of the third branch below repeated in front (X OR A OR B OR (C AND D AND (X' OR ...))
--    with X = C AND X' AND D), so the policy admits exactly the same rows; for the caller's own book the
--    is_tenant_wide() definer chain no longer runs per row inside contact_detail_visible.
ALTER POLICY contacts_select ON contacts USING (
  (deleted_at IS NULL AND owner_user_id = (SELECT app.user_id()) AND (SELECT app.my_role()) IS NOT NULL)
  OR (SELECT app.is_tenant_wide())
  -- the actor of the current ownership command keeps sight of the row it just moved away
  OR (ownership_actor_user_id = (SELECT app.user_id()) AND ownership_command_id = (SELECT app.ownership_command()))
  OR (deleted_at IS NULL AND (SELECT app.my_role()) IS NOT NULL AND (
         owner_user_id = (SELECT app.user_id())
      OR offered_to_user_id = (SELECT app.user_id())
      OR id = ANY ((SELECT app.my_collab_contact_ids())::uuid[])
      OR (ownership_state = 'in_pond' AND pond_id = ANY ((SELECT app.my_pond_ids())::uuid[]))
      OR owner_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR offered_to_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[])
      OR (ownership_state = 'in_pond' AND (SELECT app.my_role()) = 'team_lead')
      OR id = ANY ((SELECT app.my_deal_contact_ids())::uuid[]))));

-- 3. The dispatch guards (0013/0014) look every recipient up by (tenant, kind, address) INCLUDING removed
--    points (an opt-out on a removed number still blocks). The only (tenant, kind, address) index is
--    partial (removed_at IS NULL), so the guard fell back to the trigram GIN index: 0.39 ms per send in the
--    guard, 0.14 ms with this index.
CREATE INDEX contact_points_kind_address_all_idx ON contact_points (tenant_id, kind, address);

-- 4. Opt-out checks by address across purposes (the feed's channel hints, the gate inputs) probe
--    consent_state by (tenant, channel, address_hmac); the primary key has purpose between channel and
--    address_hmac, so each probe walked the whole channel range.
CREATE INDEX consent_state_address_idx ON consent_state (tenant_id, address_hmac);

-- 5. The scoreboard's activity counts (app.scoreboard_activity, 0012) per agent and range: partial
--    indexes whose predicates match the function's filters exactly, so each count is an index-only scan
--    instead of a heap visit per call or text (the existing messages_human_touch_idx lacks NOT imported).
CREATE INDEX calls_human_outbound_idx ON calls (tenant_id, agent_user_id, started_at)
  WHERE direction = 'outbound' AND initiator = 'human' AND NOT imported;
CREATE INDEX messages_human_sent_idx ON messages (tenant_id, initiated_by_user_id, dispatched_at)
  WHERE direction = 'outbound' AND initiator = 'human' AND NOT imported AND dispatched_at IS NOT NULL;
