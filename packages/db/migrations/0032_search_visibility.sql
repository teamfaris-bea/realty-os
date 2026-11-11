-- 0032 (written as 0026 in lane perf-misses, lane item 2): a search index for message and note text that RLS lets a query use.
--
-- The miss. GET /search runs `search_tsv @@ to_tsquery(...)` on messages and notes. `@@` (ts_match_vq) is not
-- LEAKPROOF, so under RLS Postgres must run the row's visibility check (app.contact_detail_visible: 0.13 ms
-- on a visible row, about 1.5 ms on a hidden one) BEFORE the text match, on every message of the tenant
-- (about 2M at 250k contacts). The GIN index is never used for a caller, and both branches always ran into
-- their 300 ms statement timeout and came back `incomplete` (docs/PERFORMANCE.md §7 item 2).
--
-- The design. One row per (message, lexeme) and per (note, lexeme), where the lexemes are EXACTLY the
-- lexemes of the parent row's own `search_tsv` (tsvector_to_array(search_tsv)), with the parent's sort key:
--
--   message_search_tokens (tenant_id, token, occurred_at, message_id)   ordered like the messages branch
--   note_search_tokens    (tenant_id, token, created_at,  note_id)      ordered like the notes branch
--
-- `token` is "C"-collated text, so a prefix probe is `starts_with(token, $lexeme)` plus the matching btree
-- range (`>=` / `<`). starts_with, text_ge and text_lt are LEAKPROOF in stock Postgres, so the planner may
-- run them before the row-security quals and through an index: RLS then runs only on the token rows that
-- match. Two access paths, chosen by the planner per query:
--   * the primary key (tenant_id, token, occurred_at, message_id): a range probe for rare prefixes;
--   * (tenant_id, occurred_at DESC, message_id DESC) INCLUDE (token): a newest-first walk that tests the
--     prefix on the index entry (leakproof, before RLS) and stops after the first 10 visible messages,
--     for prefixes that match thousands of rows.
-- The API (apps/api/src/workspace/search.ts) then joins the parent table under its own RLS and re-checks
-- the ORIGINAL `search_tsv @@ to_tsquery(...)` on each candidate, so the answer is the old query's answer.
--
-- Why visibility is unchanged (and nothing new is revealed).
--   * Each token table's SELECT policy is "the parent row is visible to the caller": EXISTS over the parent
--     table, evaluated under the caller's own RLS (the message_media / message_media_skipped pattern).
--     A caller sees a token row exactly when they see its message (note); no visibility logic is copied,
--     so a later change to the parent's policy applies here automatically.
--   * A token row holds nothing the caller cannot already read from the visible parent row: its tenant,
--     id, timestamp and a lexeme of its `search_tsv` (app_user may SELECT messages / notes, search_tsv
--     included). Orphan rows (none are expected) would be invisible: their EXISTS is false.
--   * The usual layer-1 policies (tenant_isolation RESTRICTIVE, support_read_only_*) and the
--     support_read_only statement trigger, like every tenant table.
--   * app_user may only SELECT the token tables; it cannot write, delete or forge rows. Rows are written
--     only by the trigger functions below: SECURITY DEFINER (app_definer, pinned search_path), RETURNS
--     trigger (not callable directly), and they copy columns of the row being written by the caller's own
--     statement (who passed the parent's RLS and guards already). No function returns rows, ids or counts.
--   * No operator or function is marked LEAKPROOF, no policy or helper of an existing table changes, and
--     the branch timeout is unchanged.
--
-- Maintenance. AFTER INSERT and AFTER DELETE statement triggers with transition tables (one set-based
-- statement per bulk insert, import revert or purge; cascaded deletes from contacts fire them too), and a
-- row trigger AFTER UPDATE OF the columns `search_tsv` and the sort key derive from (drafts are re-worded,
-- notes edited). An update that does not change the lexemes or the sort key is skipped by the WHEN clause.
--
-- Cost (measured on a copy of the 250k load database, shared machine): 2.08M messages give 13.07M token rows,
-- 2.68 GB with both indexes (heap 963 MB, primary key 854 MB, walk index 858 MB; messages itself is 1.66 GB);
-- 155k notes give 1.07M rows, 221 MB. The messages backfill took 32 s (insert 10.9 s, primary key 12.1 s,
-- walk index 9.0 s). The backfill is one INSERT ... SELECT per table, then the indexes are built (faster
-- than maintaining them row by row). Bulk inserts pay the trigger: 200k messages in one statement took
-- 45.2 s instead of 15.8 s. Writers to messages and notes are blocked for the duration of this migration
-- (SHARE lock) so no row is missed between the backfill and the triggers.

LOCK TABLE messages, notes IN SHARE MODE;

-- The backfill reads every tenant's rows, as the owner role (superuser or BYPASSRLS per docs/DEPLOY.md §3,
-- as the 250k seed assumes too). Fail loudly rather than build an empty index under FORCE RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '0032 must run as a superuser or BYPASSRLS owner (the token backfill reads every tenant)';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. Tables and backfill
-- -----------------------------------------------------------------------------
CREATE TABLE message_search_tokens (
  tenant_id   uuid NOT NULL,
  token       text COLLATE "C" NOT NULL,
  occurred_at timestamptz NOT NULL,
  message_id  uuid NOT NULL
);
CREATE TABLE note_search_tokens (
  tenant_id  uuid NOT NULL,
  token      text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  note_id    uuid NOT NULL
);

INSERT INTO message_search_tokens (tenant_id, token, occurred_at, message_id)
SELECT m.tenant_id, l.token, m.occurred_at, m.id
  FROM messages m CROSS JOIN LATERAL unnest(tsvector_to_array(m.search_tsv)) AS l(token);
INSERT INTO note_search_tokens (tenant_id, token, created_at, note_id)
SELECT n.tenant_id, l.token, n.created_at, n.id
  FROM notes n CROSS JOIN LATERAL unnest(tsvector_to_array(n.search_tsv)) AS l(token);

-- the probe path (and the exact key the maintenance triggers delete by)
ALTER TABLE message_search_tokens ADD PRIMARY KEY (tenant_id, token, occurred_at, message_id);
ALTER TABLE note_search_tokens    ADD PRIMARY KEY (tenant_id, token, created_at, note_id);
-- the newest-first walk
CREATE INDEX message_search_tokens_recent_idx ON message_search_tokens (tenant_id, occurred_at DESC, message_id DESC) INCLUDE (token);
CREATE INDEX note_search_tokens_recent_idx    ON note_search_tokens (tenant_id, created_at DESC, note_id DESC) INCLUDE (token);

-- -----------------------------------------------------------------------------
-- 2. Row-level security: the parent's visibility, nothing else
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_search_tokens','note_search_tokens'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write()', t);
  END LOOP;
END $$;

-- whoever sees the message (the messages SELECT policy, under the caller's RLS) sees its tokens
CREATE POLICY message_search_tokens_select ON message_search_tokens FOR SELECT USING (EXISTS (
  SELECT 1 FROM messages m WHERE m.tenant_id = message_search_tokens.tenant_id AND m.id = message_search_tokens.message_id));
-- whoever sees the note (the notes SELECT policy, under the caller's RLS) sees its tokens
CREATE POLICY note_search_tokens_select ON note_search_tokens FOR SELECT USING (EXISTS (
  SELECT 1 FROM notes n WHERE n.tenant_id = note_search_tokens.tenant_id AND n.id = note_search_tokens.note_id));

GRANT SELECT ON message_search_tokens, note_search_tokens TO app_user;
GRANT SELECT, INSERT, DELETE ON message_search_tokens, note_search_tokens TO app_definer;

-- -----------------------------------------------------------------------------
-- 3. Maintenance triggers (definers: app_user cannot write the token tables)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.message_search_tokens_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.message_search_tokens (tenant_id, token, occurred_at, message_id)
  SELECT n.tenant_id, l.token, n.occurred_at, n.id
    FROM new_rows n CROSS JOIN LATERAL unnest(tsvector_to_array(n.search_tsv)) AS l(token)
   ORDER BY 1, 2, 3, 4;   -- in key order: a bulk insert (an import, the load seed) touches fewer random index pages
  RETURN NULL;
END $$;

CREATE FUNCTION app.message_search_tokens_delete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.message_search_tokens t
   USING old_rows o CROSS JOIN LATERAL unnest(tsvector_to_array(o.search_tsv)) AS l(token)
   WHERE t.tenant_id = o.tenant_id AND t.token = (l.token COLLATE "C") AND t.occurred_at = o.occurred_at AND t.message_id = o.id;
  RETURN NULL;
END $$;

CREATE FUNCTION app.message_search_tokens_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.message_search_tokens t
   WHERE t.tenant_id = OLD.tenant_id AND t.token = ANY (tsvector_to_array(OLD.search_tsv)::text[] COLLATE "C")
     AND t.occurred_at = OLD.occurred_at AND t.message_id = OLD.id;
  INSERT INTO public.message_search_tokens (tenant_id, token, occurred_at, message_id)
  SELECT NEW.tenant_id, l.token, NEW.occurred_at, NEW.id FROM unnest(tsvector_to_array(NEW.search_tsv)) AS l(token);
  RETURN NULL;
END $$;

CREATE FUNCTION app.note_search_tokens_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.note_search_tokens (tenant_id, token, created_at, note_id)
  SELECT n.tenant_id, l.token, n.created_at, n.id
    FROM new_rows n CROSS JOIN LATERAL unnest(tsvector_to_array(n.search_tsv)) AS l(token)
   ORDER BY 1, 2, 3, 4;   -- in key order: a bulk insert (an import, the load seed) touches fewer random index pages
  RETURN NULL;
END $$;

CREATE FUNCTION app.note_search_tokens_delete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.note_search_tokens t
   USING old_rows o CROSS JOIN LATERAL unnest(tsvector_to_array(o.search_tsv)) AS l(token)
   WHERE t.tenant_id = o.tenant_id AND t.token = (l.token COLLATE "C") AND t.created_at = o.created_at AND t.note_id = o.id;
  RETURN NULL;
END $$;

CREATE FUNCTION app.note_search_tokens_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.note_search_tokens t
   WHERE t.tenant_id = OLD.tenant_id AND t.token = ANY (tsvector_to_array(OLD.search_tsv)::text[] COLLATE "C")
     AND t.created_at = OLD.created_at AND t.note_id = OLD.id;
  INSERT INTO public.note_search_tokens (tenant_id, token, created_at, note_id)
  SELECT NEW.tenant_id, l.token, NEW.created_at, NEW.id FROM unnest(tsvector_to_array(NEW.search_tsv)) AS l(token);
  RETURN NULL;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['app.message_search_tokens_insert()','app.message_search_tokens_delete()','app.message_search_tokens_update()',
                           'app.note_search_tokens_insert()','app.note_search_tokens_delete()','app.note_search_tokens_update()'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;

CREATE TRIGGER message_search_tokens_ins AFTER INSERT ON messages
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.message_search_tokens_insert();
CREATE TRIGGER message_search_tokens_del AFTER DELETE ON messages
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.message_search_tokens_delete();
CREATE TRIGGER message_search_tokens_upd AFTER UPDATE OF tenant_id, id, subject, body, occurred_at ON messages
  FOR EACH ROW WHEN (OLD.search_tsv IS DISTINCT FROM NEW.search_tsv OR OLD.occurred_at IS DISTINCT FROM NEW.occurred_at
                     OR OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION app.message_search_tokens_update();

CREATE TRIGGER note_search_tokens_ins AFTER INSERT ON notes
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.note_search_tokens_insert();
CREATE TRIGGER note_search_tokens_del AFTER DELETE ON notes
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.note_search_tokens_delete();
CREATE TRIGGER note_search_tokens_upd AFTER UPDATE OF tenant_id, id, body, created_at ON notes
  FOR EACH ROW WHEN (OLD.search_tsv IS DISTINCT FROM NEW.search_tsv OR OLD.created_at IS DISTINCT FROM NEW.created_at
                     OR OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION app.note_search_tokens_update();

-- -----------------------------------------------------------------------------
-- 4. Self-checks
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  -- the backfill is complete: exactly the parents' lexemes
  IF (SELECT count(*) FROM message_search_tokens) <> (SELECT coalesce(sum(length(search_tsv)), 0) FROM messages)
     OR (SELECT count(*) FROM note_search_tokens) <> (SELECT coalesce(sum(length(search_tsv)), 0) FROM notes) THEN
    RAISE EXCEPTION '0032 SELF-CHECK FAILED: token backfill incomplete';
  END IF;
  -- the probe operators are still leakproof (otherwise the index could not serve a caller under RLS)
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('starts_with','text_ge','text_lt') AND pronamespace = 'pg_catalog'::regnamespace
               AND NOT proleakproof) THEN
    RAISE EXCEPTION '0032 SELF-CHECK FAILED: starts_with / text_ge / text_lt are not leakproof';
  END IF;
  -- app_user reads only
  IF has_table_privilege('app_user', 'public.message_search_tokens', 'INSERT') OR has_table_privilege('app_user', 'public.message_search_tokens', 'DELETE')
     OR has_table_privilege('app_user', 'public.message_search_tokens', 'UPDATE')
     OR has_table_privilege('app_user', 'public.note_search_tokens', 'INSERT') OR has_table_privilege('app_user', 'public.note_search_tokens', 'DELETE')
     OR has_table_privilege('app_user', 'public.note_search_tokens', 'UPDATE') THEN
    RAISE EXCEPTION '0032 SELF-CHECK FAILED: app_user may write a token table';
  END IF;
END $$;
