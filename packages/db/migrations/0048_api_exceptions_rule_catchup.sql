-- =============================================================================
-- 0048 (api/accountability): an index for re-reading untouched_lead items an earlier rule stored.
-- Batch 6 interaction review, group ownership, review of the F2 fix (R6). Index only: no table, column, policy, grant
-- or definer. Nothing in code or tests names this file by number (the orchestrator renumbers at merge).
--
-- Why. A stored untouched_lead item the current rules make no item is withdrawn when a recompute reads it (0047). The
-- tenant scan (every 60 s per tenant) reads open rows and the periods whose deadline fell in the last 30 days, so an
-- item an earlier rule already cleared as "fixed late" for an older period was never read again, and stayed in the live
-- queue as fixed late. The scan now also reads the untouched_lead rows of an earlier rule version that are not
-- withdrawn (apps/api/src/accountability/repos/exceptions.ts untouchedRowsOfEarlierRules). Any re-read rewrites a row
-- at the current rule version, so after one pass the set is (almost) empty; this index keeps the probe from reading
-- every item of the tenant each minute. The query's literals (item_type, withdrawn_at) match the predicate; the
-- comparisons are leakproof (texteq, int2lt), so under FORCE RLS the planner can use it.
-- =============================================================================

CREATE INDEX exception_items_untouched_rule_idx ON exception_items (tenant_id, rule_version)
  WHERE item_type = 'untouched_lead' AND withdrawn_at IS NULL;
