-- 0007 (BUILD_PLAN module 12, api/comms): single-use recording playback tokens (R-PERM-9).
--
-- No SECURITY DEFINER function, no change to an existing table or policy.
--
-- "Playback streams through the API with a 60 s single-use token" (ARCHITECTURE §7, R-PERM-9). A
-- single-use token needs state, so each issued token is one row here: only the SHA-256 of the token is
-- stored, it is bound to one recording and one user, it lives at most 60 seconds, and redeeming it
-- stamps used_at exactly once (UPDATE ... WHERE used_at IS NULL AND expires_at > now()).
--
-- RLS: Layer 1 like every tenant table. Layer 2: a user sees, issues and redeems only their OWN tokens,
-- and may issue one only for a recording they can see (the recordings SELECT policy, including the
-- RESTRICTIVE recording-scope policy of R-PERM-8, applies inside the EXISTS). The system actor never
-- needs tokens.
CREATE TABLE recording_stream_tokens (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  token_hash   bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  recording_id uuid NOT NULL,
  user_id      uuid NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('play','download')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  PRIMARY KEY (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, recording_id) REFERENCES recordings (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)      REFERENCES memberships (tenant_id, user_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '60 seconds'),
  CHECK (used_at IS NULL OR used_at >= created_at)
);
CREATE INDEX recording_stream_tokens_recording_idx ON recording_stream_tokens (tenant_id, recording_id);

ALTER TABLE recording_stream_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_stream_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recording_stream_tokens AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON recording_stream_tokens AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON recording_stream_tokens AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON recording_stream_tokens AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');

CREATE POLICY own_tokens_select ON recording_stream_tokens FOR SELECT USING (
  (SELECT app.actor_kind()) = 'user' AND user_id = (SELECT app.user_id()));
CREATE POLICY own_tokens_insert ON recording_stream_tokens FOR INSERT WITH CHECK (
  (SELECT app.actor_kind()) = 'user' AND user_id = (SELECT app.user_id()) AND (SELECT app.is_member())
  AND EXISTS (SELECT 1 FROM recordings r WHERE r.tenant_id = recording_stream_tokens.tenant_id
                AND r.id = recording_stream_tokens.recording_id));
CREATE POLICY own_tokens_redeem ON recording_stream_tokens FOR UPDATE
  USING ((SELECT app.actor_kind()) = 'user' AND user_id = (SELECT app.user_id()))
  WITH CHECK ((SELECT app.actor_kind()) = 'user' AND user_id = (SELECT app.user_id()));

GRANT SELECT, INSERT, UPDATE ON recording_stream_tokens TO app_user;
GRANT SELECT ON recording_stream_tokens TO app_definer;
GRANT SELECT, UPDATE, DELETE ON recording_stream_tokens TO app_retention;
