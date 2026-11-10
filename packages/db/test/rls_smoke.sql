-- =============================================================================
-- RLS / integrity smoke test for 0001_init.sql
-- Run:  PGPASSWORD=dev psql -v ON_ERROR_STOP=1 -h localhost -U app_owner -d realty_verify \
--         -f packages/db/test/rls_smoke.sql
-- Everything runs inside ONE transaction that is rolled back, so the database is unchanged.
-- All application-level steps run as app_user (SET ROLE); two short sections RESET ROLE to
-- prove the guarantees also hold for a superuser (composite FK, append-only triggers).
-- Any failed expectation raises 'FAIL ...' and stops psql (ON_ERROR_STOP).
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
BEGIN;
SET LOCAL ROLE app_user;

-- ---------- helpers (temp functions, owned by app_user) ----------
CREATE FUNCTION pg_temp.ctx(p_tenant uuid, p_user uuid, p_actor text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.tenant_id', COALESCE(p_tenant::text, ''), true);
  PERFORM set_config('app.user_id', COALESCE(p_user::text, ''), true);
  PERFORM set_config('app.actor_kind', COALESCE(p_actor, ''), true);
  PERFORM set_config('app.principal_type', 'staff', true);
  PERFORM set_config('app.ownership_command', '', true);
END $$;
CREATE FUNCTION pg_temp.cmd(p_command uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('app.ownership_command', COALESCE(p_command::text, ''), true); END $$;
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL  %', p_label; END IF;
  RAISE NOTICE 'PASS  %', p_label;
END $$;
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_label text, p_like text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF p_like IS NULL OR SQLERRM LIKE p_like THEN
      RAISE NOTICE 'PASS  % -> %', p_label, SQLERRM;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL  %: unexpected error: %', p_label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  %: statement succeeded but must fail', p_label;
END $$;
CREATE FUNCTION pg_temp.rows_affected(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$;

-- ---------- fixed ids ----------
\set tA     '''a0000000-0000-7000-8000-000000000001'''
\set tB     '''b0000000-0000-7000-8000-000000000001'''
\set ownA   '''a0000000-0000-7000-8000-0000000000a0'''
\set agA1   '''a0000000-0000-7000-8000-0000000000a1'''
\set agA2   '''a0000000-0000-7000-8000-0000000000a2'''
\set ownB   '''b0000000-0000-7000-8000-0000000000b0'''
\set polA   '''a0000000-0000-7000-8000-00000000c001'''
\set polB   '''b0000000-0000-7000-8000-00000000c001'''
\set pondA  '''a0000000-0000-7000-8000-00000000d001'''
\set c1     '''a0000000-0000-7000-8000-00000000e001'''
\set c2     '''a0000000-0000-7000-8000-00000000e002'''
\set cB     '''b0000000-0000-7000-8000-00000000e001'''
\set PH     '''$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA'''
\set HMAC1  'digest(''+15555550101'', ''sha256'')'
\set SHA    'repeat(''ab'', 32)'

-- =============================================================================
-- 1. Signup + provisioning for two tenants, entirely as app_user
-- =============================================================================
SELECT pg_temp.ctx(NULL, :ownA, 'user');
INSERT INTO users (id, email, display_name, password_hash) VALUES (:ownA, 'owner-a@example.test', 'Olivia Owner', :PH);
SELECT app.provision_tenant(:tA, 'team-a', 'Team A', 'America/New_York', 'A Realty LLC', :ownA, :polA,
       'a0000000-0000-7000-8000-00000000f001', :pondA, '\x01', '\x02', '\x03', 'kek-dev');

SELECT pg_temp.ctx(NULL, :ownB, 'user');
INSERT INTO users (id, email, display_name, password_hash) VALUES (:ownB, 'owner-b@example.test', 'Oscar Owner', :PH);
SELECT app.provision_tenant(:tB, 'team-b', 'Team B', 'America/Chicago', 'B Brokers Inc', :ownB, :polB,
       'b0000000-0000-7000-8000-00000000f001', 'b0000000-0000-7000-8000-00000000d001', '\x01', '\x02', '\x03', 'kek-dev');

-- Owner A invites two agents; they accept pre-tenant through the definer path.
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at) VALUES
  (:tA, 'a0000000-0000-7000-8000-0000000001a1', 'agent1@example.test', 'agent', digest('invite-a1', 'sha256'), :ownA, now() + interval '1 day'),
  (:tA, 'a0000000-0000-7000-8000-0000000001a2', 'agent2@example.test', 'agent', digest('invite-a2', 'sha256'), :ownA, now() + interval '1 day');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT pg_temp.ok((SELECT o_tenant_id FROM auth.accept_invite(digest('invite-a1', 'sha256'), :agA1, 'Ava Agent', :PH, now())) = :tA,
                  'invite accepted pre-tenant via definer (agent 1)');
SELECT pg_temp.ok((SELECT o_tenant_id FROM auth.accept_invite(digest('invite-a2', 'sha256'), :agA2, 'Ben Agent', :PH, now())) = :tA,
                  'invite accepted pre-tenant via definer (agent 2)');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM auth.accept_invite(digest('invite-a1', 'sha256'), :agA1, 'x', :PH, now())),
                  'invite token is single-use');

-- =============================================================================
-- 2. Contacts through the ownership command protocol (ledger first, then projection)
-- =============================================================================
-- c1: self-created by agent 1 (owned)
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0001');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id,
       actor_kind, actor_user_id, reason_code, command_id, occurred_at)
VALUES (:tA, :c1, 1, gen_random_uuid(), 'created', NULL, 'owned', :agA1, 'user', :agA1, 'SELF_CREATED',
        'a0000000-0000-7000-8000-0000000c0001', now());
INSERT INTO contacts (tenant_id, id, first_name, last_name, display_name, ownership_state, owner_user_id, owned_at,
       ownership_period_seq, ownership_seq, ownership_command_id, ownership_actor_user_id, created_by_user_id)
VALUES (:tA, :c1, 'Alice', 'Buyer', 'Alice Buyer', 'owned', :agA1, now(), 1, 1,
        'a0000000-0000-7000-8000-0000000c0001', :agA1, :agA1);
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label, is_primary)
VALUES (:tA, gen_random_uuid(), :c1, 'phone', '+15555550101', :HMAC1, 'mobile', true);

-- cB: tenant B's own contact, created by its system actor (routing -> pond)
SELECT pg_temp.ctx(:tB, NULL, 'system');
SELECT pg_temp.cmd('b0000000-0000-7000-8000-0000000c0001');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, pond_id,
       actor_kind, reason_code, command_id, occurred_at)
VALUES (:tB, :cB, 1, gen_random_uuid(), 'created', NULL, 'in_pond', 'b0000000-0000-7000-8000-00000000d001',
        'system', 'NO_RULE_MATCH', 'b0000000-0000-7000-8000-0000000c0001', now());
INSERT INTO contacts (tenant_id, id, display_name, ownership_state, pond_id, ownership_seq, ownership_command_id)
VALUES (:tB, :cB, 'Bob Seller', 'in_pond', 'b0000000-0000-7000-8000-00000000d001', 1, 'b0000000-0000-7000-8000-0000000c0001');

-- =============================================================================
-- 3. Tenant isolation
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM contacts) = 1, 'owner A sees exactly its 1 contact');
SELECT pg_temp.ok((SELECT count(*) FROM contacts WHERE tenant_id = :tB) = 0, 'owner A cannot read tenant B contacts');
SELECT pg_temp.ok((SELECT count(*) FROM tenants) = 1 AND (SELECT id FROM tenants) = :tA, 'owner A sees only its own tenant row');
SELECT pg_temp.ok((SELECT count(*) FROM users) = 3, 'owner A sees only co-member users (3 of 4)');
SELECT pg_temp.ok((SELECT count(*) FROM lead_ownership_events WHERE tenant_id = :tB) = 0, 'owner A cannot read tenant B ledger');
SELECT pg_temp.ok(pg_temp.rows_affected(format('UPDATE contacts SET display_name = %L WHERE id = %L', 'hacked', :cB)) = 0,
                  'owner A UPDATE of a tenant B contact affects 0 rows');
SELECT pg_temp.ok(pg_temp.rows_affected(format('UPDATE tenant_settings SET team_name = %L WHERE tenant_id = %L', 'x', :tB)) = 0,
                  'owner A UPDATE of tenant B settings affects 0 rows');
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body) VALUES (%L, gen_random_uuid(), %L, %L, 'x')$q$, :tB, :cB, :ownA),
  'owner A cannot INSERT a row into tenant B', '%row-level security%');
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body) VALUES (%L, gen_random_uuid(), %L, %L, 'x')$q$, :tA, :cB, :ownA),
  'tenant A row cannot point at a tenant B contact (RLS)', '%row-level security%');

SELECT pg_temp.ctx(:tB, :ownB, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM contacts) = 1 AND (SELECT id FROM contacts) = :cB, 'owner B sees only tenant B contact');
SELECT pg_temp.ok((SELECT count(*) FROM contact_points) = 0, 'owner B sees no tenant A contact points');
SELECT pg_temp.ok((SELECT count(*) FROM memberships) = 1, 'owner B sees only its own memberships');

SELECT pg_temp.ctx(:tB, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM contacts) = 0 AND (SELECT count(*) FROM memberships) = 0,
                  'a tenant A user placed in a tenant B context sees nothing');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT pg_temp.ok((SELECT count(*) FROM contacts) = 0 AND (SELECT count(*) FROM tenants) = 0
                  AND (SELECT count(*) FROM memberships) = 0, 'no tenant context => zero rows (fail closed)');
SELECT set_config('app.tenant_id', '', true), set_config('app.principal_type', 'client', true);
SELECT pg_temp.ok((SELECT count(*) FROM contacts) = 0, 'empty-string GUC => zero rows');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT set_config('app.principal_type', 'client', true);
SELECT pg_temp.ok((SELECT count(*) FROM contacts) = 0, 'non-staff principal (future client portal) sees nothing by default');

-- Global uniqueness of live phone numbers across tenants.
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, acquired_at)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000a0a1', '+15555559000', 'fake', 'PN1', 'local', 'team_main', true, true, now());
SELECT pg_temp.ctx(:tB, :ownB, 'user');
SELECT pg_temp.expect_error($q$INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose,
  sms_capable, voice_capable, acquired_at) VALUES ('b0000000-0000-7000-8000-000000000001', gen_random_uuid(), '+15555559000',
  'fake', 'PN2', 'local', 'team_main', true, true, now())$q$,
  'a live number cannot belong to two tenants', '%phone_numbers_live_e164%');
SELECT pg_temp.ok((SELECT tenant_id FROM app.resolve_inbound_number('+15555559000')) = :tA,
                  'inbound number resolves to exactly one tenant (pre-tenant definer)');

-- Composite FK: even a superuser cannot create a cross-tenant reference.
RESET ROLE;
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac) VALUES (%L, gen_random_uuid(), %L, 'email', 'x@example.test', digest('x', 'sha256'))$q$,
  :tA, :cB), 'composite FK rejects a cross-tenant reference even for a superuser', '%foreign key%');
SET LOCAL ROLE app_user;

-- =============================================================================
-- 4. Ownership: ledger-enforced, pond masking, claim, decline-reoffer, cooldown
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.expect_error(format(
  $q$UPDATE contacts SET ownership_state = 'in_pond', owner_user_id = NULL, owned_at = NULL, pond_id = %L WHERE id = %L$q$, :pondA, :c1),
  'ownership change without a command/ledger event is rejected', '%OWNERSHIP_UNAUDITED%');
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0002');
SELECT pg_temp.expect_error(format(
  $q$UPDATE contacts SET ownership_state = 'in_pond', owner_user_id = NULL, owned_at = NULL, ownership_period_seq = NULL,
     pond_id = %L, ownership_seq = 2, ownership_command_id = 'a0000000-0000-7000-8000-0000000c0002', ownership_actor_user_id = %L WHERE id = %L$q$, :pondA, :agA1, :c1),
  'projection update without its ledger row is rejected', '%no matching ledger event%');
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, actor_kind, actor_user_id,
     reason_code, command_id, occurred_at) VALUES (%L, %L, 5, gen_random_uuid(), 'released', 'owned', 'in_pond', 'user', %L,
     'NOT_A_FIT', 'a0000000-0000-7000-8000-0000000c0002', now())$q$, :tA, :c1, :agA1),
  'ledger seq must be gapless', '%OWNERSHIP_SEQ_GAP%');
-- proper release by agent 1
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, prev_owner_user_id, pond_id,
       actor_kind, actor_user_id, reason_code, command_id, occurred_at)
VALUES (:tA, :c1, 2, gen_random_uuid(), 'released', 'owned', 'in_pond', :agA1, :pondA, 'user', :agA1, 'NOT_A_FIT',
        'a0000000-0000-7000-8000-0000000c0002', now());
UPDATE contacts SET ownership_state = 'in_pond', owner_user_id = NULL, owned_at = NULL, ownership_period_seq = NULL,
       pond_id = :pondA, ownership_seq = 2, ownership_command_id = 'a0000000-0000-7000-8000-0000000c0002', ownership_actor_user_id = :agA1
 WHERE tenant_id = :tA AND id = :c1 AND ownership_seq = 1;
SELECT pg_temp.ok(true, 'release with ledger event + projection update succeeds');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM contacts WHERE id = :c1) = 1, 'pond card visible to an eligible agent');
SELECT pg_temp.ok((SELECT count(*) FROM contact_points WHERE contact_id = :c1) = 0, 'pond card hides phones/emails until claimed');
SELECT pg_temp.ok((SELECT count(*) FROM lead_ownership_events WHERE contact_id = :c1) = 0, 'pond card hides lead history until claimed');
-- agent 2 claims
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0003');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id,
       deadline_at, actor_kind, actor_user_id, reason_code, command_id, occurred_at)
VALUES (:tA, :c1, 3, gen_random_uuid(), 'claimed', 'in_pond', 'owned', :agA2, now() + interval '15 minutes', 'user', :agA2,
        'POND_CLAIM', 'a0000000-0000-7000-8000-0000000c0003', now());
SELECT pg_temp.ok(pg_temp.rows_affected(format(
  $q$UPDATE contacts SET ownership_state = 'owned', owner_user_id = %L, pond_id = NULL, owned_at = now(),
     first_touch_due_at = now() + interval '15 minutes', release_due_at = now() + interval '30 minutes',
     ownership_period_seq = 3, ownership_seq = 3,
     ownership_command_id = 'a0000000-0000-7000-8000-0000000c0003', ownership_actor_user_id = %L
     WHERE tenant_id = %L AND id = %L AND ownership_seq = 2$q$, :agA2, :agA2, :tA, :c1)) = 1, 'claim wins the version predicate');
SELECT pg_temp.ok(pg_temp.rows_affected(format(
  $q$UPDATE contacts SET display_name = display_name WHERE tenant_id = %L AND id = %L AND ownership_seq = 2$q$, :tA, :c1)) = 0,
  'a second claimer with the stale seq updates 0 rows (LEAD_ALREADY_CLAIMED)');
SELECT pg_temp.cmd(NULL);
SELECT pg_temp.ok((SELECT count(*) FROM contact_points WHERE contact_id = :c1) = 1, 'after claim, details are visible to the new owner');
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM contacts WHERE id = :c1) = 0, 'previous owner loses visibility immediately');
SELECT pg_temp.ok((SELECT in_cooldown FROM app.claim_stats(:agA1, :c1, date_trunc('day', now()), now() - interval '72 hours')),
                  'releasing agent is in claim cooldown for that lead');

-- F3: the losing claimer's rejection goes to the rejection log, NOT the gapless ledger, even though the
-- loser can no longer see the contact; the projection seq therefore stays equal to the ledger head.
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0004');
INSERT INTO ownership_command_rejections (tenant_id, id, contact_id, command_id, command_kind, code, observed_seq,
       actor_kind, actor_user_id, occurred_at)
VALUES (:tA, gen_random_uuid(), :c1, 'a0000000-0000-7000-8000-0000000c0004', 'claim', 'LEAD_ALREADY_CLAIMED', 3,
        'user', :agA1, now());
SELECT pg_temp.ok((SELECT count(*) FROM ownership_command_rejections WHERE contact_id = :c1) = 1,
                  'losing claimer records its rejection without seeing the contact (rejection log, not ledger)');
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO ownership_command_rejections (tenant_id, id, contact_id, command_id, command_kind, code, actor_kind,
     actor_user_id, occurred_at) VALUES (%L, gen_random_uuid(), %L, 'a0000000-0000-7000-8000-0000000c0004', 'claim',
     'LEAD_ALREADY_CLAIMED', 'user', %L, now())$q$, :tA, :c1, :agA2),
  'a rejection cannot be forged in another user''s name', '%row-level security%');
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0005');
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO ownership_command_rejections (tenant_id, id, contact_id, command_id, command_kind, code, actor_kind,
     actor_user_id, occurred_at) VALUES (%L, gen_random_uuid(), %L, 'a0000000-0000-7000-8000-0000000c0099', 'claim',
     'LEAD_ALREADY_CLAIMED', 'user', %L, now())$q$, :tA, :c1, :agA1),
  'a rejection is written only inside the ownership command named by the GUC', '%row-level security%');
SELECT pg_temp.cmd(NULL);
SELECT pg_temp.expect_error($q$UPDATE ownership_command_rejections SET code = 'X'$q$,
  'rejection log is append-only', '%permission denied%');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM ownership_command_rejections) = 0, 'an agent cannot read other agents'' rejections');
DO $$
BEGIN
  BEGIN
    PERFORM set_config('app.ownership_command', 'a0000000-0000-7000-8000-0000000c0006', true);
    INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id,
           actor_kind, actor_user_id, reason_code, command_id, occurred_at)
    VALUES ('a0000000-0000-7000-8000-000000000001', 'a0000000-0000-7000-8000-00000000e001', 4, gen_random_uuid(),
            'first_touch_recorded', 'owned', 'owned', 'a0000000-0000-7000-8000-0000000000a2', 'user',
            'a0000000-0000-7000-8000-0000000000a2', 'SMS', 'a0000000-0000-7000-8000-0000000c0006', now()),
           ('a0000000-0000-7000-8000-000000000001', 'a0000000-0000-7000-8000-00000000e001', 5, gen_random_uuid(),
            'inactivity_warned', 'owned', 'owned', 'a0000000-0000-7000-8000-0000000000a2', 'user',
            'a0000000-0000-7000-8000-0000000000a2', 'WARNED', 'a0000000-0000-7000-8000-0000000c0006', now());
    UPDATE contacts SET first_touch_at = now(), ownership_seq = 4,
           ownership_command_id = 'a0000000-0000-7000-8000-0000000c0006',
           ownership_actor_user_id = 'a0000000-0000-7000-8000-0000000000a2'
     WHERE tenant_id = 'a0000000-0000-7000-8000-000000000001' AND id = 'a0000000-0000-7000-8000-00000000e001';
    RAISE EXCEPTION 'FAIL  projection behind the ledger head was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'OWNERSHIP_SEQ_HEAD%' THEN RAISE NOTICE 'PASS  projection seq must equal the ledger head -> %', SQLERRM;
    ELSE RAISE; END IF;
  END;
  PERFORM set_config('app.ownership_command', '', true);
END $$;

-- F6: inactivity deadlines are stored instants; changing the tenant setting never moves them.
UPDATE contacts SET inactivity_warn_at = now() + interval '17 days', inactivity_release_at = now() + interval '20 days'
 WHERE tenant_id = :tA AND id = :c1;
SELECT pg_temp.ctx(:tA, :ownA, 'user');
UPDATE tenant_settings SET inactivity_release_days = 7 WHERE tenant_id = :tA;
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM app.due_work(now(), 100) WHERE work_kind = 'inactivity' AND ref_id = :c1),
                  'lowering inactivity_release_days does not make existing leads overdue (stored deadline)');
UPDATE contacts SET inactivity_warn_at = now() - interval '1 minute' WHERE tenant_id = :tA AND id = :c1;
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM app.due_work(now(), 100) WHERE work_kind = 'inactivity' AND ref_id = :c1),
                  'the sweeper fires on the stored inactivity instant');

-- c2: system routes an offer to agent 1; agent 1 declines and the lead is re-offered to agent 2
-- inside agent 1's own command (the row leaves agent 1's visibility mid-transaction).
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0010');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, actor_kind, reason_code, command_id, occurred_at)
VALUES (:tA, :c2, 1, gen_random_uuid(), 'created', NULL, 'unassigned', 'system', 'INQUIRY', 'a0000000-0000-7000-8000-0000000c0010', now());
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, offer_id, offered_to_user_id,
       deadline_at, actor_kind, reason_code, command_id, occurred_at)
VALUES (:tA, :c2, 2, gen_random_uuid(), 'offered', 'unassigned', 'offered', 'a0000000-0000-7000-8000-0000000f0f01', :agA1,
        now() + interval '5 minutes', 'system', 'ROUND_ROBIN', 'a0000000-0000-7000-8000-0000000c0010', now());
INSERT INTO contacts (tenant_id, id, display_name, ownership_state, offer_id, offered_to_user_id, offer_expires_at, offer_round,
       ownership_seq, ownership_command_id)
VALUES (:tA, :c2, 'Carla New-Lead', 'offered', 'a0000000-0000-7000-8000-0000000f0f01', :agA1, now() + interval '5 minutes', 1,
        2, 'a0000000-0000-7000-8000-0000000c0010');
INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
VALUES (:tA, gen_random_uuid(), :c2, 'email', 'carla@example.test', digest('carla@example.test', 'sha256'));
SELECT pg_temp.ctx(:tA, :agA1, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM contacts WHERE id = :c2) = 1 AND (SELECT count(*) FROM contact_points WHERE contact_id = :c2) = 0,
                  'offer card visible to offeree; contact points hidden until accepted');
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0011');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, offer_id,
       actor_kind, actor_user_id, reason_code, command_id, occurred_at)
VALUES (:tA, :c2, 3, gen_random_uuid(), 'offer_declined', 'offered', 'unassigned', 'a0000000-0000-7000-8000-0000000f0f01',
        'user', :agA1, 'DECLINED', 'a0000000-0000-7000-8000-0000000c0011', now());
UPDATE contacts SET ownership_state = 'unassigned', offer_id = NULL, offered_to_user_id = NULL, offer_expires_at = NULL,
       route_due_at = now(), ownership_seq = 3,
       ownership_command_id = 'a0000000-0000-7000-8000-0000000c0011', ownership_actor_user_id = :agA1
 WHERE tenant_id = :tA AND id = :c2 AND ownership_seq = 2;
SELECT pg_temp.ok(true, 'decline by the offeree succeeds and leaves the lead awaiting system routing (actor keeps sight during its command)');
-- F1: why routing never runs under a user actor: the agent's RLS hides other candidates' routing inputs.
SELECT pg_temp.ok((SELECT count(*) FROM app.claim_stats(:agA2, :c2, date_trunc('day', now()), now() - interval '72 hours')) = 0,
                  'an agent cannot read another agent''s claim stats (routing input)');
SELECT pg_temp.ok(pg_temp.rows_affected('SELECT 1 FROM memberships FOR SHARE') = 1,
                  'an agent can lock only its own membership row (routing input)');
SELECT pg_temp.cmd(NULL);
SELECT pg_temp.ok((SELECT count(*) FROM contacts WHERE id = :c2) = 0, 'after the command, the decliner no longer sees the lead');
SELECT pg_temp.ok((SELECT count(*) FROM lead_ownership_events WHERE contact_id = :c2) = 0, 'decliner cannot read the lead history');
-- ownership.followup: the system actor routes with complete eligibility data
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0012');
SELECT pg_temp.ok(pg_temp.rows_affected('SELECT 1 FROM memberships FOR SHARE') = 3
                  AND (SELECT count(*) FROM app.claim_stats(:agA2, :c2, date_trunc('day', now()), now() - interval '72 hours')) = 1,
                  'the system actor sees and locks every candidate''s routing inputs');
SELECT pg_temp.ok((SELECT count(*) FROM app.due_work(now() + interval '1 minute', 100) WHERE work_kind = 'route' AND ref_id = :c2) = 1,
                  'a declined lead whose follow-up job is lost is found by the sweeper (route_due_at)');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, offer_id, offered_to_user_id,
       deadline_at, actor_kind, reason_code, command_id, occurred_at)
VALUES (:tA, :c2, 4, gen_random_uuid(), 'offered', 'unassigned', 'offered', 'a0000000-0000-7000-8000-0000000f0f02', :agA2,
        now() + interval '5 minutes', 'system', 'ROUND_ROBIN_AFTER_DECLINE', 'a0000000-0000-7000-8000-0000000c0012', now());
SELECT pg_temp.ok(pg_temp.rows_affected(format(
  $q$UPDATE contacts SET ownership_state = 'offered', offer_id = 'a0000000-0000-7000-8000-0000000f0f02', offered_to_user_id = %L,
     offer_round = 2, offer_expires_at = now() + interval '5 minutes', route_due_at = NULL, ownership_seq = 4,
     ownership_command_id = 'a0000000-0000-7000-8000-0000000c0012', ownership_actor_user_id = NULL
     WHERE tenant_id = %L AND id = %L AND ownership_seq = 3$q$, :agA2, :tA, :c2)) = 1,
  'system routing re-offers the declined lead');
SELECT pg_temp.cmd(NULL);
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.ok((SELECT string_agg(type, ',' ORDER BY seq) FROM lead_ownership_events WHERE contact_id = :c2)
                  = 'created,offered,offer_declined,offered', 'ledger holds the gapless, ordered history');

-- =============================================================================
-- 5. Comms dispatch guard (opt-out block), assistant autonomy, evidence, consent ledger
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO conversations (tenant_id, id, contact_id) VALUES (:tA, 'a0000000-0000-7000-8000-00000000cc01', :c1);
-- 0013 (core-compliance/2.0.0): no per-send gate decision is required; gate_decisions logs blocked sends only.
INSERT INTO gate_decisions (tenant_id, id, contact_id, address_hmac, channel, purpose, initiator, action_category, phase, outcome,
       reason_codes, explanation, actor_user_id, policy_version_id, core_rules_version, inputs, inputs_sha256, evaluated_at)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ab01', :c1, :HMAC1, 'sms', 'informational', 'human', 'none', 'send', 'deny',
        '{CONSENT_REVOKED}', 'Opted out of texts', :agA2, :polA, '2.0.0', '{}', :SHA, now());
SELECT pg_temp.ok(true, 'a blocked send is logged in gate_decisions');
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO gate_decisions (tenant_id, id, contact_id, address_hmac, channel, purpose, initiator, action_category, phase, outcome,
     reason_codes, explanation, actor_user_id, policy_version_id, core_rules_version, inputs, inputs_sha256, evaluated_at)
     VALUES (%L, gen_random_uuid(), %L, digest('+15555550101', 'sha256'), 'sms', 'informational', 'human', 'none', 'send', 'allow', '{}',
     'OK to text', %L, %L, '2.0.0', '{}', repeat('ab', 32), now())$q$, :tA, :c1, :agA2, :polA),
  'gate_decisions holds blocked sends only (no allow rows)', '%gate_decisions_blocked_send_only%');
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address,
     body, status, initiator, initiated_by_user_id, purpose, occurred_at) VALUES (%L, gen_random_uuid(),
     'a0000000-0000-7000-8000-00000000cc01', %L, 'sms', 'outbound', 'a0000000-0000-7000-8000-00000000a0a1', '+15555559000',
     '+15555550101', 'Hi Alice', 'dispatching', 'human', %L, 'informational', now())$q$, :tA, :c1, :agA2),
  'dispatching requires dispatched_at (the stuck-dispatch sweeper keys on it)', '%check constraint%');
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address,
     body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at) VALUES (%L, gen_random_uuid(),
     'a0000000-0000-7000-8000-00000000cc01', %L, 'sms', 'outbound', 'a0000000-0000-7000-8000-00000000a0a1', '+15555559000',
     '+15555550199', 'Hi stranger', 'dispatching', 'human', %L, 'informational', now(), now())$q$, :tA, :c1, :agA2),
  'a send to an address that is not one of the contact''s points cannot dispatch (its opt-out could not be checked)',
  '%RECIPIENT_NOT_A_CONTACT_POINT%');
-- dispatched 30 minutes ago and never finished (worker died between TX1 and TX2)
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address,
       body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ee01', 'a0000000-0000-7000-8000-00000000cc01', :c1, 'sms', 'outbound',
        'a0000000-0000-7000-8000-00000000a0a1', '+15555559000', '+15555550101', 'Hi Alice, it''s Ben.', 'dispatching', 'human',
        :agA2, 'informational', now() - interval '30 minutes', now());
SELECT pg_temp.ok(true, 'a human send to a contact who has not opted out dispatches with no gate decision row');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM app.due_work(now(), 100) WHERE work_kind = 'dispatch_stale'
                           AND ref_id = 'a0000000-0000-7000-8000-00000000ee01'),
                  'a message stuck in dispatching past the max lease is surfaced for reconciliation');

SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, playbook_version_id, status,
     owner_user_id, explanation, payload) VALUES (%L, gen_random_uuid(), %L, 'autonomous_message', 'money', 'within_playbook',
     gen_random_uuid(), 'proposed', %L, 'Mentions price', '{}')$q$, :tA, :c1, :agA2),
  'money can never be an autonomous assistant action', '%check constraint%');
INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000aa001', :c1, 'call_summary', 'internal', 'internal', 'proposed', :agA2,
        'Summary of the 2:10 PM call', '{}');
DO $$
BEGIN
  BEGIN
    INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, needs_review)
    VALUES ('a0000000-0000-7000-8000-000000000001', gen_random_uuid(), 'a0000000-0000-7000-8000-0000000aa001', 0,
            'commitment', 'Callback due Thursday at 4 PM', false);
    SET CONSTRAINTS claim_evidence_required IMMEDIATE;
    RAISE EXCEPTION 'FAIL  claim without evidence was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'CLAIM_WITHOUT_EVIDENCE%' THEN RAISE NOTICE 'PASS  asserted claim without verified evidence is rejected -> %', SQLERRM;
    ELSE RAISE; END IF;
  END;
END $$;
INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, needs_review)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000ac001', 'a0000000-0000-7000-8000-0000000aa001', 1, 'commitment',
        'Callback due Thursday at 4 PM', false);
INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet, verbatim_verified)
VALUES (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-0000000ac001', 'message', gen_random_uuid(),
        '{"kind":"message"}', 'call me Thursday around four', true);
SET CONSTRAINTS claim_evidence_required IMMEDIATE;
SELECT pg_temp.ok(true, 'claim with verbatim-verified evidence is accepted');
SET CONSTRAINTS claim_evidence_required DEFERRED;

SELECT pg_temp.expect_error(format(
  $q$INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
     source, occurred_at, actor_kind, imported, import_record_id, original_provenance) VALUES (%L, gen_random_uuid(), 'phone', %L,
     '•••-0101', 'sms', 'marketing', 'grant', 'express_written', 'import_fub', now(), 'system', true, gen_random_uuid(), '{}')$q$, :tA, :HMAC1),
  'imports can never create express-written consent', '%check constraint%');
INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level,
       source, occurred_at, actor_kind, evidence_message_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ce01', 'phone', :HMAC1, '•••-0101', 'sms', 'all', 'revoke', 'none',
        'inbound_keyword', now(), 'system', gen_random_uuid());
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO consent_state (tenant_id, channel, purpose, address_hmac, status, consent_level, basis_event_id, ledger_event_count)
     VALUES (%L, 'sms', 'informational', %L, 'revoked', 'none', 'a0000000-0000-7000-8000-00000000ce01', 2)$q$, :tA, :HMAC1),
  'consent projection must match the ledger', '%CONSENT_PROJECTION_STALE%');
INSERT INTO consent_state (tenant_id, channel, purpose, address_hmac, status, consent_level, basis_event_id, ledger_event_count)
VALUES (:tA, 'sms', 'informational', :HMAC1, 'revoked', 'none', 'a0000000-0000-7000-8000-00000000ce01', 1);
SELECT pg_temp.ok(true, 'consent projection consistent with the ledger is accepted');
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(format(
  $q$INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address,
     body, status, initiator, initiated_by_user_id, purpose, dispatched_at, occurred_at) VALUES (%L, gen_random_uuid(),
     'a0000000-0000-7000-8000-00000000cc01', %L, 'sms', 'outbound', 'a0000000-0000-7000-8000-00000000a0a1', '+15555559000',
     '+15555550101', 'Still there?', 'sent', 'human', %L, 'informational', now(), now())$q$, :tA, :c1, :agA2),
  'a send to an opted-out address cannot be dispatched, whoever writes it (no override)', '%RECIPIENT_OPTED_OUT%');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.expect_error(format($q$UPDATE consent_events SET consent_level = 'express' WHERE id = %L$q$, 'a0000000-0000-7000-8000-00000000ce01'),
  'consent ledger is append-only', '%permission denied%');

-- =============================================================================
-- 6. Deals: commission is human-only
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA2, 'user');
INSERT INTO deals (tenant_id, id, name, side, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000de01', 'Alice purchase', 'buy', now(), :c1, :agA2, :agA2);
INSERT INTO deal_financials (tenant_id, deal_id, gross_commission_cents, updated_by_user_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000de01', 1250000, :agA2);
SELECT pg_temp.ok((SELECT count(*) FROM deal_stage_history WHERE deal_id = 'a0000000-0000-7000-8000-00000000de01') = 1,
                  'deal stage history is written by trigger');
SELECT pg_temp.ctx(:tA, NULL, 'system');
SELECT pg_temp.ok((SELECT count(*) FROM deal_financials) = 0, 'system/assistant actor cannot read commission fields');
SELECT pg_temp.ok(pg_temp.rows_affected($q$UPDATE deal_financials SET gross_commission_cents = 1$q$) = 0,
                  'system/assistant actor cannot write commission fields');

-- =============================================================================
-- 7. Jobs: cross-tenant claim only through the definer; app_user cannot read the queue
-- =============================================================================
SELECT pg_temp.ctx(:tA, :ownA, 'user');
INSERT INTO jobs (tenant_id, queue, kind, payload, run_at, dedupe_key) VALUES (:tA, 'realtime', 'ownership.offer_expiry', '{}', now(), 'offer:1');
SELECT pg_temp.expect_error($q$INSERT INTO jobs (tenant_id, queue, kind, payload, run_at) VALUES
  ('b0000000-0000-7000-8000-000000000001', 'realtime', 'ownership.offer_expiry', '{}', now())$q$,
  'tenant A cannot enqueue a job for tenant B', '%row-level security%');
SELECT pg_temp.ctx(:tB, :ownB, 'user');
INSERT INTO jobs (tenant_id, queue, kind, payload, run_at) VALUES (:tB, 'realtime', 'ownership.offer_expiry', '{}', now());
SELECT pg_temp.expect_error('SELECT count(*) FROM jobs', 'app_user cannot read the job table directly', '%permission denied%');
SELECT pg_temp.ctx(NULL, NULL, NULL);
SELECT pg_temp.ok((SELECT count(DISTINCT tenant_id) FROM app.claim_jobs(ARRAY['realtime'], 'worker-1', 10, interval '1 minute')) = 2,
                  'claim_jobs (definer) claims across tenants and returns ids + tenant only');

-- give c2 children of every purge-sensitive kind (append-only ones included)
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO conversations (tenant_id, id, contact_id) VALUES (:tA, 'a0000000-0000-7000-8000-00000000cc02', :c2);
INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status,
       initiator, occurred_at)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ee02', 'a0000000-0000-7000-8000-00000000cc02', :c2, 'email', 'inbound',
        'carla@example.test', 'r+token@in.example.test', 'Is the Elm St house still available?', 'received', 'client', now());
INSERT INTO message_status_events (tenant_id, id, message_id, provider_status, mapped_status, provider_event_ref, occurred_at)
VALUES (:tA, gen_random_uuid(), 'a0000000-0000-7000-8000-00000000ee02', 'delivered', 'delivered', 'evt-1', now());
INSERT INTO behavior_events (tenant_id, id, contact_id, event_type, reliability, source, occurred_at, dedupe_key)
VALUES (:tA, gen_random_uuid(), :c2, 'email_opened', 'signal', 'email', now(), 'open-1');
SELECT pg_temp.expect_error(format($q$INSERT INTO behavior_events (tenant_id, id, contact_id, event_type, reliability, source,
  occurred_at, dedupe_key) VALUES (%L, gen_random_uuid(), %L, 'email_opened', 'fact', 'email', now(), 'open-2')$q$, :tA, :c2),
  'email opens can only be recorded as signals (Apple MPP)', '%check constraint%');
INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload)
VALUES (:tA, 'a0000000-0000-7000-8000-0000000aa002', :c2, 'message_draft', 'novel_message', 'requires_approval', 'proposed',
        :agA2, 'Carla asked about Elm St', '{}');
INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, assistant_action_id,
       reasons, dedupe_key)
VALUES (:tA, gen_random_uuid(), :agA2, 'assistant_draft', 'scored', :c2, 'assistant_action', 'a0000000-0000-7000-8000-0000000aa002',
        'a0000000-0000-7000-8000-0000000aa002', '[{"code":"INBOUND_UNANSWERED","label":"Carla asked a question 2 min ago"}]', 'draft:aa002');

-- =============================================================================
-- 8. Erasure: contact on a deal is protected; erasing keeps ledgers, removes PII
-- =============================================================================
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(format($q$SELECT app.erase_contact(%L, gen_random_uuid(), 'request')$q$, :c2),
  'agents cannot erase contacts', '%ERASE_FORBIDDEN%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(format($q$SELECT app.erase_contact(%L, gen_random_uuid(), 'request')$q$, :c1),
  'a contact on a deal cannot be erased', '%CONTACT_ON_DEAL%');
SELECT app.erase_contact(:c2, 'a0000000-0000-7000-8000-00000000ad01', 'privacy request');
SELECT pg_temp.ok((SELECT count(*) FROM contacts WHERE id = :c2) = 0 AND (SELECT count(*) FROM contact_points WHERE contact_id = :c2) = 0,
                  'erasure removes the contact and its PII children');
SELECT pg_temp.ok((SELECT count(*) FROM lead_ownership_events WHERE contact_id = :c2) = 4, 'erasure keeps the PII-free ownership ledger');
SELECT pg_temp.ok((SELECT count(*) FROM audit_log WHERE action = 'contact.erase') = 1, 'erasure is audited');

-- =============================================================================
-- 8b. Exception actions must be backed by real ownership commands; staged deactivation ends in 'removed'
-- =============================================================================
SELECT pg_temp.ctx(:tA, NULL, 'system');
INSERT INTO exception_items (tenant_id, id, item_type, subject_type, subject_id, contact_id, owner_user_id, detected_at,
       evidence, dedupe_key, computed_at)
VALUES (:tA, gen_random_uuid(), 'untouched_lead', 'contact', :c1, :c1, :agA2, now(),
        '[{"source_type":"ownership_event","seq":3}]', 'untouched:a0000000-0000-7000-8000-00000000e001:3', now());
SELECT pg_temp.ctx(:tA, :agA2, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO exception_events (tenant_id, id, exception_dedupe_key, action, actor_user_id,
  actor_role, ownership_command_id, occurred_at) VALUES (%L, gen_random_uuid(), 'untouched:a0000000-0000-7000-8000-00000000e001:3',
  'reassigned', %L, 'agent', gen_random_uuid(), now())$q$, :tA, :agA2),
  'an agent cannot mark its own miss reassigned with a made-up command', '%EXCEPTION_REASSIGN_UNPROVEN%');
SELECT pg_temp.ctx(:tA, :ownA, 'user');
SELECT pg_temp.expect_error(format($q$INSERT INTO exception_events (tenant_id, id, exception_dedupe_key, action, actor_user_id,
  actor_role, ownership_command_id, occurred_at) VALUES (%L, gen_random_uuid(), 'untouched:a0000000-0000-7000-8000-00000000e001:3',
  'reassigned', %L, 'owner', gen_random_uuid(), now())$q$, :tA, :ownA),
  'even an Owner cannot record a reassignment that did not happen', '%EXCEPTION_REASSIGN_UNPROVEN%');
-- Owner reassigns c1 A2 -> A1. The next seq is projection seq + 1 although a rejection was logged (F3).
SELECT pg_temp.cmd('a0000000-0000-7000-8000-0000000c0020');
INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id,
       prev_owner_user_id, actor_kind, actor_user_id, reason_code, command_id, occurred_at)
VALUES (:tA, :c1, 4, gen_random_uuid(), 'reassigned', 'owned', 'owned', :agA1, :agA2, 'user', :ownA, 'EXCEPTION_QUEUE',
        'a0000000-0000-7000-8000-0000000c0020', now());
SELECT pg_temp.ok(pg_temp.rows_affected(format(
  $q$UPDATE contacts SET owner_user_id = %L, owned_at = now(), first_touch_due_at = NULL, release_due_at = NULL,
     inactivity_warn_at = NULL, inactivity_release_at = NULL, ownership_period_seq = 4, ownership_seq = 4,
     ownership_command_id = 'a0000000-0000-7000-8000-0000000c0020', ownership_actor_user_id = %L
     WHERE tenant_id = %L AND id = %L AND ownership_seq = 3$q$, :agA1, :ownA, :tA, :c1)) = 1,
  'after a rejected claim, the next command (projection seq + 1) succeeds');
INSERT INTO exception_events (tenant_id, id, exception_dedupe_key, action, actor_user_id, actor_role, ownership_command_id, occurred_at)
VALUES (:tA, gen_random_uuid(), 'untouched:a0000000-0000-7000-8000-00000000e001:3', 'reassigned', :ownA, 'owner',
        'a0000000-0000-7000-8000-0000000c0020', now());
SELECT pg_temp.ok(true, 'a reassignment backed by the actor''s own ledger command is recorded');
SELECT pg_temp.cmd(NULL);
-- R-OWN-22 (F8): the staged deactivation's terminal state is 'removed' (with removed_at)
UPDATE memberships SET status = 'deactivating', accepting_leads = false WHERE tenant_id = :tA AND user_id = :agA2;
SELECT pg_temp.ok(pg_temp.rows_affected(format(
  $q$UPDATE memberships SET status = 'removed', removed_at = now() WHERE tenant_id = %L AND user_id = %L AND status = 'deactivating'$q$,
  :tA, :agA2)) = 1, 'staged deactivation ends in removed (with removed_at)');

-- =============================================================================
-- 9. audit_log is append-only (grants AND triggers) and tenant-scoped
-- =============================================================================
INSERT INTO audit_log (tenant_id, id, occurred_at, actor_kind, actor_via, actor_user_id, actor_role, action, entity_type, entity_id)
VALUES (:tA, 'a0000000-0000-7000-8000-00000000ad02', now(), 'user', 'api', :ownA, 'owner', 'recording.play', 'recording', gen_random_uuid());
SELECT pg_temp.expect_error($q$INSERT INTO audit_log (tenant_id, id, occurred_at, actor_kind, action, entity_type)
  VALUES ('a0000000-0000-7000-8000-000000000001', gen_random_uuid(), now(), 'system', 'consent.revoked', 'consent')$q$,
  'a user context cannot forge a system audit row', '%row-level security%');
SELECT pg_temp.expect_error($q$UPDATE audit_log SET reason = 'tampered'$q$, 'app_user cannot UPDATE audit_log', '%permission denied%');
SELECT pg_temp.expect_error($q$DELETE FROM audit_log$q$, 'app_user cannot DELETE audit_log', '%permission denied%');
SELECT pg_temp.ctx(:tB, :ownB, 'user');
SELECT pg_temp.ok((SELECT count(*) FROM audit_log) = 0, 'tenant B cannot read tenant A audit rows');
RESET ROLE;
SELECT pg_temp.expect_error($q$UPDATE audit_log SET reason = 'tampered'$q$, 'even a superuser UPDATE of audit_log is rejected by trigger', 'APPEND_ONLY%');
SELECT pg_temp.expect_error($q$DELETE FROM audit_log$q$, 'even a superuser DELETE of audit_log is rejected by trigger', 'APPEND_ONLY%');
SELECT pg_temp.expect_error($q$TRUNCATE audit_log$q$, 'TRUNCATE of audit_log is rejected by trigger', '%APPEND_ONLY%');
SELECT pg_temp.expect_error($q$DELETE FROM lead_ownership_events$q$, 'ownership ledger rejects DELETE by trigger', 'APPEND_ONLY%');
SET LOCAL ROLE app_user;

SELECT pg_temp.ok(true, 'ALL RLS SMOKE CHECKS PASSED');
ROLLBACK;
