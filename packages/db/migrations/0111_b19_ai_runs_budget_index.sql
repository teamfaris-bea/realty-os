-- Batch 19, review F5: the AI assistant's daily model-call budgets are counted through an index
-- (docs/AI_ISA.md §3.7; DATA_MODEL E906).
--
--   Before every provider call an AI assistant turn reserves the call (apps/api isa/spend.ts): under the team's
--   model-budget advisory lock it counts today's ai_runs rows of purpose 'ai_isa_turn' (the team-local day) and inserts
--   one. Every turn of the team that needs the model waits on that lock for this count. ai_runs had only its primary key
--   (tenant_id, id), so the count read every ai_runs row of the tenant, of every purpose and every day (drafts, call
--   summaries, 30 days and more of history): the lock was held longer as the ledger grew, under the 30 s statement
--   timeout.
--
--   * ai_runs_purpose_created_idx (tenant_id, purpose, created_at): the count reads today's 'ai_isa_turn' rows of the
--     tenant only (at most the team's daily limit plus the day's holds, about a thousand index entries).
--
--   No new table, column, policy, grant or definer. ai_runs keeps its row-level security and its policies; an index
--   changes no visibility. EXISTING DATA: nothing is rewritten; the index is built over the existing rows in this
--   migration's transaction (ai_runs is written a few times per AI call; the build holds a lock that blocks those
--   writes while it runs).

CREATE INDEX ai_runs_purpose_created_idx ON ai_runs (tenant_id, purpose, created_at);

-- Self-check: the table still has row-level security and the index is the one the count is written for.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.ai_runs'::regclass AND c.relrowsecurity) THEN
    RAISE EXCEPTION '0111: ai_runs must keep row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'ai_runs' AND indexname = 'ai_runs_purpose_created_idx'
                   AND indexdef LIKE '%(tenant_id, purpose, created_at)%') THEN
    RAISE EXCEPTION '0111: ai_runs_purpose_created_idx (tenant_id, purpose, created_at) is missing';
  END IF;
END $$;
