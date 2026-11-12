-- Module 48 (api/voice): an index for the voice.reconcile pass (R-VOICE-7, R-VOICE-21). Index only: no table, policy,
-- grant or definer.
--
-- Every 5 minutes per tenant the pass reads AI-handled calls that have no handback yet. Nearly every AI call gets its
-- handback within seconds of its end, so the partial index stays tiny. Plain columns only (FORCE RLS keeps
-- non-leakproof expressions out of index conditions), as 0058.
CREATE INDEX calls_voice_handback_missing ON calls (tenant_id, started_at) WHERE handled_by = 'assistant' AND handback_action_id IS NULL;
