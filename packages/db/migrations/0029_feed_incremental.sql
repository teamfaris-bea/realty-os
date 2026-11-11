-- lane perf-misses: the incremental Priority Feed (docs/PERFORMANCE.md "Priority Feed", apps/api/src/workspace/feed.ts).
--
-- GET /feed used to recompute every card of the caller's whole book on every request (p95 2.0 s for an agent
-- with 18,660 contacts at 250k). Cards are now MATERIALIZED in priority_feed_items and GET reads the top 50
-- by index. This migration adds what that needs:
--
--   priority_feed_items.sort_at  the card's own instant (core FeedItem.createdAt), the third key of the feed
--                                order after (band, due_at, score); for rows other modules write it defaults to
--                                created_at (to the millisecond, as the Phase 1 read compared it);
--   priority_feed_items.card     for cards the scorer materialized: the reasons as a wording TEMPLATE (relative
--                                times are rendered when read) and the one-tap actions; NULL for other modules'
--                                rows (their actions come from their key family, as before);
--   feed_dirty                   append-only "re-score this group for this user" marks, written by the triggers
--                                below on every write that can change a feed; a group is a contact
--                                ('c:<id>'), a task or appointment without a contact ('t:<id>', 'a:<id>') or a
--                                deal date ('d:<id>'); '!full' asks for a whole-book recompute;
--   feed_groups                  per user and group, the next instant at which time alone can change the group
--                                (check_at) and how many of its materialized cards are open and visible to the
--                                member (n_open, for GET's total), written only by the materializer acting as
--                                that user.
--
-- Visibility does not change. No policy of an existing table changes, no SECURITY DEFINER function is added,
-- and nothing is marked LEAKPROOF. The materializer reads every input under the member's own RLS context
-- (it runs as the member, like GET /feed did) and writes only that member's rows. The new tables hold no
-- PII: user ids, group keys (ids) and instants. feed_dirty marks can be INSERTed by any member or the system
-- (a write by one person can change another person's feed), but only the system and the mark's own user can
-- read or delete them; feed_groups is the member's own state (the system reads it to find due work).
-- The triggers are SECURITY INVOKER: a contact-owner lookup runs under the writer's RLS, so it can never
-- learn more than the writer may see (a mark the writer cannot derive is repaired by the hourly reconcile).
--
-- The marks have no unique key on purpose: an INSERT never waits on another transaction's mark (no lock
-- interaction with the write path, no deadlock); the reader deletes all of a user's marks at once.

-- -----------------------------------------------------------------------------
-- 1. Stored card order and template
-- -----------------------------------------------------------------------------
ALTER TABLE priority_feed_items
  ADD COLUMN sort_at timestamptz,
  ADD COLUMN card    jsonb CHECK (card IS NULL OR (jsonb_typeof(card) = 'object' AND jsonb_typeof(card->'reasons') = 'array'
                                                   AND jsonb_typeof(card->'primaryAction') = 'object' AND jsonb_typeof(card->'alternatives') = 'array'));
UPDATE priority_feed_items SET sort_at = date_trunc('milliseconds', created_at);
ALTER TABLE priority_feed_items ALTER COLUMN sort_at SET NOT NULL;

CREATE FUNCTION app.feed_item_sort_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sort_at IS NULL THEN NEW.sort_at := date_trunc('milliseconds', NEW.created_at); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER feed_item_sort_default BEFORE INSERT ON priority_feed_items FOR EACH ROW EXECUTE FUNCTION app.feed_item_sort_default();

-- the feed order (core compareFeedItems) of each band as an index, so GET reads the top 50 and stops
CREATE INDEX feed_items_pinned_order_idx ON priority_feed_items
  (tenant_id, user_id, due_at ASC NULLS LAST, score DESC, sort_at, dedupe_key COLLATE "C") WHERE state = 'open' AND band = 'pinned';
CREATE INDEX feed_items_scored_order_idx ON priority_feed_items
  (tenant_id, user_id, score DESC, due_at ASC NULLS LAST, sort_at, dedupe_key COLLATE "C") WHERE state = 'open' AND band = 'scored';

-- a member's cards of one contact (the materializer re-scores and counts by contact)
CREATE INDEX feed_items_user_contact_idx ON priority_feed_items (tenant_id, user_id, contact_id) WHERE state IN ('open','snoozed');

-- open cards other modules wrote (no materialized card): counted live by GET
CREATE INDEX feed_items_unscored_idx ON priority_feed_items (tenant_id, user_id) WHERE state = 'open' AND card IS NULL;

-- snoozes that ran out, per user (the materializer reopens their cards)
CREATE INDEX feed_items_snoozed_idx ON priority_feed_items (tenant_id, user_id, snoozed_until) WHERE state = 'snoozed';

-- -----------------------------------------------------------------------------
-- 2. Marks and group state
-- -----------------------------------------------------------------------------
CREATE TABLE feed_dirty (
  tenant_id  uuid NOT NULL,
  id         bigint GENERATED ALWAYS AS IDENTITY,
  user_id    uuid NOT NULL,
  group_key  text NOT NULL CHECK (group_key ~ '^([ctad]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|!full)$'),
  marked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX feed_dirty_user_idx ON feed_dirty (tenant_id, user_id);

CREATE TABLE feed_groups (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  group_key  text NOT NULL CHECK (group_key ~ '^([ctad]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|~reconcile)$'),
  check_at   timestamptz,
  -- the group's open materialized cards the member could see when it was last scored (GET's `total`)
  n_open     integer NOT NULL DEFAULT 0 CHECK (n_open >= 0),
  PRIMARY KEY (tenant_id, user_id, group_key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX feed_groups_due_idx ON feed_groups (tenant_id, check_at) WHERE check_at IS NOT NULL;
CREATE INDEX feed_groups_user_due_idx ON feed_groups (tenant_id, user_id, check_at) WHERE check_at IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['feed_dirty','feed_groups'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
  END LOOP;
END $$;

-- marks: written by any member's or the system's writes; read and consumed by their own user or the system
CREATE POLICY feed_dirty_insert ON feed_dirty FOR INSERT WITH CHECK ((SELECT app.is_member()));
CREATE POLICY feed_dirty_select ON feed_dirty FOR SELECT USING (user_id = (SELECT app.user_id()) OR (SELECT app.actor_kind()) = 'system');
CREATE POLICY feed_dirty_delete ON feed_dirty FOR DELETE USING (user_id = (SELECT app.user_id()) OR (SELECT app.actor_kind()) = 'system');
-- group state: the member's own (the materializer acts as the member); the system reads it to find due work
CREATE POLICY feed_groups_own ON feed_groups FOR ALL USING (user_id = (SELECT app.user_id()) AND (SELECT app.is_member()))
  WITH CHECK (user_id = (SELECT app.user_id()) AND (SELECT app.is_member()));
CREATE POLICY feed_groups_system_read ON feed_groups FOR SELECT USING ((SELECT app.actor_kind()) = 'system');

GRANT SELECT, INSERT, DELETE ON feed_dirty TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON feed_groups TO app_user;
-- definer functions and the retention role write source rows too; their writes mark like anyone's
GRANT INSERT ON feed_dirty TO app_definer, app_retention;
GRANT SELECT ON feed_dirty, feed_groups TO app_definer;
GRANT SELECT, DELETE ON feed_dirty, feed_groups TO app_retention;

-- -----------------------------------------------------------------------------
-- 3. Marking triggers (statement level, transition tables: one INSERT per statement, also for bulk loads).
--    Who is marked mirrors whose feed the row can reach (apps/api/src/workspace/repos/feedInputs.ts):
--    contact inputs belong to the contact's owner (and the offeree); tasks to their assignee; appointments
--    to their user; assistant actions to their owner; deal dates to the deal's owner and members.
-- -----------------------------------------------------------------------------

-- contacts: the old and the new owner and offeree of every inserted or updated row
CREATE FUNCTION app.feed_mark_contacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT n.tenant_id, u.user_id, 'c:' || n.id
      FROM new_rows n CROSS JOIN LATERAL (VALUES (n.owner_user_id), (n.offered_to_user_id)) u(user_id)
     WHERE u.user_id IS NOT NULL;
  ELSE
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT n.tenant_id, u.user_id, 'c:' || n.id
      FROM new_rows n JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
     CROSS JOIN LATERAL (VALUES (o.owner_user_id), (o.offered_to_user_id), (n.owner_user_id), (n.offered_to_user_id)) u(user_id)
     WHERE u.user_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER feed_mark_ins AFTER INSERT ON contacts REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_contacts();
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON contacts REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_contacts();

-- rows of a contact that reach its owner's feed: messages, calls, ownership events (re-inquiries), saved
-- searches, contact points (channel hints). The owner is looked up under the writer's RLS.
CREATE FUNCTION app.feed_mark_contact_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT c.tenant_id, c.owner_user_id, 'c:' || c.id
      FROM (SELECT DISTINCT tenant_id, contact_id FROM new_rows WHERE contact_id IS NOT NULL) n
      JOIN public.contacts c ON c.tenant_id = n.tenant_id AND c.id = n.contact_id
     WHERE c.owner_user_id IS NOT NULL;
  ELSE
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT c.tenant_id, c.owner_user_id, 'c:' || c.id
      FROM (SELECT tenant_id, contact_id FROM new_rows UNION SELECT tenant_id, contact_id FROM old_rows) n
      JOIN public.contacts c ON c.tenant_id = n.tenant_id AND c.id = n.contact_id
     WHERE c.owner_user_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages','calls','saved_searches','contact_points'] LOOP
    EXECUTE format('CREATE TRIGGER feed_mark_ins AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_contact_rows()', t);
    EXECUTE format('CREATE TRIGGER feed_mark_upd AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_contact_rows()', t);
  END LOOP;
END $$;
-- the ownership ledger is append-only: inserts only
CREATE TRIGGER feed_mark_ins AFTER INSERT ON lead_ownership_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_contact_rows();

-- tasks: the old and new assignee; the task's contact group, or its own group without a contact
CREATE FUNCTION app.feed_mark_tasks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, assignee_user_id, CASE WHEN contact_id IS NULL THEN 't:' || id ELSE 'c:' || contact_id END
      FROM new_rows WHERE assignee_user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, assignee_user_id, CASE WHEN contact_id IS NULL THEN 't:' || id ELSE 'c:' || contact_id END
      FROM (SELECT tenant_id, id, assignee_user_id, contact_id FROM new_rows UNION SELECT tenant_id, id, assignee_user_id, contact_id FROM old_rows) x
     WHERE assignee_user_id IS NOT NULL;
  ELSE
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, assignee_user_id, CASE WHEN contact_id IS NULL THEN 't:' || id ELSE 'c:' || contact_id END
      FROM old_rows WHERE assignee_user_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER feed_mark_ins AFTER INSERT ON tasks REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_tasks();
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON tasks REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_tasks();
CREATE TRIGGER feed_mark_del AFTER DELETE ON tasks REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_tasks();

-- appointments: the old and new user; the contact group, or the appointment's own group
CREATE FUNCTION app.feed_mark_appointments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, user_id, CASE WHEN contact_id IS NULL THEN 'a:' || id ELSE 'c:' || contact_id END FROM new_rows WHERE user_id IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, user_id, CASE WHEN contact_id IS NULL THEN 'a:' || id ELSE 'c:' || contact_id END
      FROM (SELECT tenant_id, id, user_id, contact_id FROM new_rows UNION SELECT tenant_id, id, user_id, contact_id FROM old_rows) x WHERE user_id IS NOT NULL;
  ELSE
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, user_id, CASE WHEN contact_id IS NULL THEN 'a:' || id ELSE 'c:' || contact_id END FROM old_rows WHERE user_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER feed_mark_ins AFTER INSERT ON appointments REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_appointments();
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON appointments REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_appointments();
CREATE TRIGGER feed_mark_del AFTER DELETE ON appointments REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_appointments();

-- assistant actions (handbacks, drafts): the old and new owner, on the action's contact
CREATE FUNCTION app.feed_mark_actions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, owner_user_id, 'c:' || contact_id FROM new_rows WHERE owner_user_id IS NOT NULL AND contact_id IS NOT NULL;
  ELSE
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT tenant_id, owner_user_id, 'c:' || contact_id
      FROM (SELECT tenant_id, owner_user_id, contact_id FROM new_rows UNION SELECT tenant_id, owner_user_id, contact_id FROM old_rows) x
     WHERE owner_user_id IS NOT NULL AND contact_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER feed_mark_ins AFTER INSERT ON assistant_actions REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_actions();
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON assistant_actions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_actions();

-- claims (a draft's "check this", a promise's evidence, a proposed search's unchecked criteria)
CREATE FUNCTION app.feed_mark_claims() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO feed_dirty (tenant_id, user_id, group_key)
  SELECT DISTINCT x.tenant_id, x.user_id, x.g FROM (
    SELECT a.tenant_id, a.owner_user_id AS user_id, 'c:' || a.contact_id AS g
      FROM new_rows n JOIN public.assistant_actions a ON a.tenant_id = n.tenant_id AND a.id = n.action_id
     WHERE a.owner_user_id IS NOT NULL AND a.contact_id IS NOT NULL
    UNION ALL
    SELECT t.tenant_id, t.assignee_user_id, CASE WHEN t.contact_id IS NULL THEN 't:' || t.id ELSE 'c:' || t.contact_id END
      FROM new_rows n JOIN public.tasks t ON t.tenant_id = n.tenant_id AND t.source_claim_id = n.id
     WHERE t.assignee_user_id IS NOT NULL
    UNION ALL
    SELECT c.tenant_id, c.owner_user_id, 'c:' || c.id
      FROM new_rows n JOIN public.saved_searches s ON s.tenant_id = n.tenant_id AND s.proposed_by_action_id = n.action_id
      JOIN public.contacts c ON c.tenant_id = s.tenant_id AND c.id = s.contact_id
     WHERE c.owner_user_id IS NOT NULL) x;
  RETURN NULL;
END $$;
CREATE TRIGGER feed_mark_ins AFTER INSERT ON assistant_claims REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_claims();
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON assistant_claims REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_claims();
CREATE INDEX tasks_source_claim_idx ON tasks (tenant_id, source_claim_id) WHERE source_claim_id IS NOT NULL;
CREATE INDEX saved_searches_action_idx ON saved_searches (tenant_id, proposed_by_action_id) WHERE proposed_by_action_id IS NOT NULL;

-- deal dates: the deal's owner and members, for each date of the changed deal / date / membership
CREATE FUNCTION app.feed_mark_deal_dates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'deal_dates' THEN
    IF TG_OP = 'DELETE' THEN
      INSERT INTO feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT d.tenant_id, u.user_id, 'd:' || o.id FROM old_rows o JOIN public.deals d ON d.tenant_id = o.tenant_id AND d.id = o.deal_id
       CROSS JOIN LATERAL (SELECT d.owner_user_id UNION SELECT dm.user_id FROM public.deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id) u(user_id)
       WHERE u.user_id IS NOT NULL;
    ELSE
      INSERT INTO feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT d.tenant_id, u.user_id, 'd:' || n.id FROM new_rows n JOIN public.deals d ON d.tenant_id = n.tenant_id AND d.id = n.deal_id
       CROSS JOIN LATERAL (SELECT d.owner_user_id UNION SELECT dm.user_id FROM public.deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id) u(user_id)
       WHERE u.user_id IS NOT NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'deals' THEN
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT DISTINCT dd.tenant_id, u.user_id, 'd:' || dd.id
      FROM (SELECT tenant_id, id, owner_user_id FROM new_rows UNION SELECT tenant_id, id, owner_user_id FROM old_rows) d
      JOIN public.deal_dates dd ON dd.tenant_id = d.tenant_id AND dd.deal_id = d.id
     CROSS JOIN LATERAL (SELECT d.owner_user_id UNION SELECT dm.user_id FROM public.deal_members dm WHERE dm.tenant_id = d.tenant_id AND dm.deal_id = d.id) u(user_id)
     WHERE u.user_id IS NOT NULL;
  ELSE -- deal_members: the member joining or leaving (the deal's dates, and its contacts: deal visibility)
    IF TG_OP = 'DELETE' THEN
      INSERT INTO feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT x.tenant_id, x.user_id, x.g FROM (
        SELECT dd.tenant_id, o.user_id, 'd:' || dd.id AS g FROM old_rows o JOIN public.deal_dates dd ON dd.tenant_id = o.tenant_id AND dd.deal_id = o.deal_id
        UNION ALL SELECT dc.tenant_id, o.user_id, 'c:' || dc.contact_id FROM old_rows o JOIN public.deal_contacts dc ON dc.tenant_id = o.tenant_id AND dc.deal_id = o.deal_id
        UNION ALL SELECT d.tenant_id, o.user_id, 'c:' || d.primary_contact_id FROM old_rows o JOIN public.deals d ON d.tenant_id = o.tenant_id AND d.id = o.deal_id
         WHERE d.primary_contact_id IS NOT NULL) x
       WHERE EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = x.tenant_id AND m.user_id = x.user_id);
    ELSE
      INSERT INTO feed_dirty (tenant_id, user_id, group_key)
      SELECT DISTINCT x.tenant_id, x.user_id, x.g FROM (
        SELECT dd.tenant_id, n.user_id, 'd:' || dd.id AS g FROM new_rows n JOIN public.deal_dates dd ON dd.tenant_id = n.tenant_id AND dd.deal_id = n.deal_id
        UNION ALL SELECT dc.tenant_id, n.user_id, 'c:' || dc.contact_id FROM new_rows n JOIN public.deal_contacts dc ON dc.tenant_id = n.tenant_id AND dc.deal_id = n.deal_id
        UNION ALL SELECT d.tenant_id, n.user_id, 'c:' || d.primary_contact_id FROM new_rows n JOIN public.deals d ON d.tenant_id = n.tenant_id AND d.id = n.deal_id
         WHERE d.primary_contact_id IS NOT NULL) x;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE INDEX deal_dates_deal_idx ON deal_dates (tenant_id, deal_id);
CREATE TRIGGER feed_mark_ins AFTER INSERT ON deal_dates REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_deal_dates();
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON deal_dates REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_deal_dates();
CREATE TRIGGER feed_mark_del AFTER DELETE ON deal_dates REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_deal_dates();
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON deals REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_deal_dates();
CREATE TRIGGER feed_mark_ins AFTER INSERT ON deal_members REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_deal_dates();
CREATE TRIGGER feed_mark_del AFTER DELETE ON deal_members REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_deal_dates();

-- opt-outs and suppressions (channel hints): every owner of a contact with that address
CREATE FUNCTION app.feed_mark_address() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO feed_dirty (tenant_id, user_id, group_key)
  SELECT DISTINCT c.tenant_id, c.owner_user_id, 'c:' || c.id
    FROM (SELECT DISTINCT tenant_id, address_hmac FROM new_rows) n
    JOIN public.contact_points p ON p.tenant_id = n.tenant_id AND p.address_hmac = n.address_hmac
    JOIN public.contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
   WHERE c.owner_user_id IS NOT NULL;
  RETURN NULL;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppressions','consent_state'] LOOP
    EXECUTE format('CREATE TRIGGER feed_mark_ins AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_address()', t);
    EXECUTE format('CREATE TRIGGER feed_mark_upd AFTER UPDATE ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_address()', t);
  END LOOP;
END $$;

-- visibility changes of one member: a role or status change, a team move, a collaboration: whole book
CREATE FUNCTION app.feed_mark_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'tenant_settings' THEN
    -- the zone of every contract date and appointment window
    INSERT INTO feed_dirty (tenant_id, user_id, group_key)
    SELECT m.tenant_id, m.user_id, '!full' FROM public.memberships m JOIN (SELECT DISTINCT tenant_id FROM new_rows) n ON n.tenant_id = m.tenant_id;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO feed_dirty (tenant_id, user_id, group_key) SELECT DISTINCT o.tenant_id, o.user_id, '!full' FROM old_rows o
     WHERE EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = o.tenant_id AND m.user_id = o.user_id);
  ELSE
    INSERT INTO feed_dirty (tenant_id, user_id, group_key) SELECT DISTINCT n.tenant_id, n.user_id, '!full' FROM new_rows n;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON memberships REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_member();
CREATE TRIGGER feed_mark_ins AFTER INSERT ON team_members REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_member();
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON team_members REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_member();
CREATE TRIGGER feed_mark_del AFTER DELETE ON team_members REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_member();
CREATE TRIGGER feed_mark_ins AFTER INSERT ON contact_collaborators REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_member();
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON contact_collaborators REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_member();
CREATE TRIGGER feed_mark_upd AFTER UPDATE ON tenant_settings REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.feed_mark_member();

-- -----------------------------------------------------------------------------
-- 4. R-PERM-11: support actors are read-only on the new tables too (as 0021 §13; idempotent)
-- -----------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
              AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'support_read_only')
            ORDER BY c.relname LOOP
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write()', r.relname);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 5. Self-check: RLS forced on the new tables; no definer added by this migration
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname IN ('feed_dirty','feed_groups') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)) THEN
    RAISE EXCEPTION 'feed_incremental: RLS not forced on a new table';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'app' AND p.proname LIKE 'feed\_%' AND p.prosecdef) THEN
    RAISE EXCEPTION 'feed_incremental: a feed function is SECURITY DEFINER';
  END IF;
END $$;
