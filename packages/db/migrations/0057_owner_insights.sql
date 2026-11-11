-- 0057 (PHASE2_3_PLAN M33, module 33 api/insights): the owner view's row source and two read indexes.
--
-- No new table, no policy change, no SECURITY DEFINER function (so no new security-review definer).
--
-- v_owner_source_dollars (security_invoker, security_barrier): one row per CLOSED deal with its immutable
-- lead_source_id (A7d), its closing instant and its commission (deal_financials, LEFT JOIN). It is the only
-- place the owner view reads commission from; core/insights sourceDollars sums it (one computing path).
--
-- Money visibility (R-OWNER-1, R-PERM-10): security_invoker means every base table is read under the
-- CALLER's RLS. deal_financials' policy admits only a user actor (Owner/Admin, the deal owner, their TL), so
--   - the system actor (any via) sees every closed deal but a NULL commission and NULL status for all of
--     them: it never reads an amount through this view;
--   - an agent or TL sees only their own / their team's deals;
--   - the API serves the view only to a human Owner/Admin (action owner_view.view, no system, no support).
-- security_barrier keeps a caller's WHERE from being pushed below the join (no leak through a function
-- in a predicate).
CREATE VIEW v_owner_source_dollars WITH (security_invoker = true, security_barrier = true) AS
  SELECT d.tenant_id, d.id AS deal_id, d.name AS deal_name, d.owner_user_id, d.lead_source_id, d.closed_at,
         f.gross_commission_cents, f.commission_status
    FROM deals d
    LEFT JOIN deal_financials f ON f.tenant_id = d.tenant_id AND f.deal_id = d.id
   WHERE d.stage = 'closed' AND d.closed_at IS NOT NULL;

GRANT SELECT ON v_owner_source_dollars TO app_user;

-- Closed deals by closing instant (the period filter of the view).
CREATE INDEX deals_closed_at_idx ON deals (tenant_id, closed_at) WHERE stage = 'closed';
-- The forecast reads the trailing 365 days of stage entries per tenant (R-OWNER-3).
CREATE INDEX deal_stage_history_changed_idx ON deal_stage_history (tenant_id, changed_at);

-- Goals CRUD (module 33): a goal is genuinely removed. The existing goals_write policy (FOR ALL: tenant-wide, or a
-- Team Lead for the members of a team they lead) already decides which rows a DELETE reaches; agents delete none.
GRANT DELETE ON agent_goals TO app_user;
