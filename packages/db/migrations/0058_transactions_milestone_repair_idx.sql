-- Module 31 (api/transactions): an index for the milestones.reconcile repair pass (R-TXN-2, R-OWN-27).
-- Indexes only: no table, policy, grant or definer.
--
-- Every 5 minutes per tenant the repair reads confirmed, uncompleted dates whose due_at was never stored (legacy
-- Phase 1 rows, or a move whose writer did not recompute). After the first pass that set is empty, so the partial
-- index stays tiny and the pass reads no deal_dates rows. Plain columns only (FORCE RLS keeps non-leakproof
-- expressions out of index conditions). Reminders use deal_dates_reminder_idx (0018).
CREATE INDEX deal_dates_repair_idx ON deal_dates (tenant_id, id) WHERE status = 'confirmed' AND completed_at IS NULL AND due_at IS NULL;
