-- VTID-05573 (mt-network-r2/legacy-messages-migration-db) step 2 of 4: the migration functions. No row moves in this file.
--
--   public.mt_legacy_common_tenant(uuid[])   the one D15 rule: the non-platform tenant ALL the given people are members of
--                                            (their shared primary if several, else the lowest id); NULL when there is none.
--   public.mt_legacy_context_tenant(uuid)    a person's context tenant for a Network row: primary non-platform tenant, else NULL.
--   public.mt_legacy_messages_migrate()      reads ONLY the bak_* snapshots (so the frozen source cannot change under it),
--                                            classifies every legacy message and thread, and inserts the placeable ones into
--                                            chat_messages / chat_groups / chat_group_members. Returns the reconcile figures.
--                                            Idempotent: every row keeps its legacy id (ON CONFLICT DO NOTHING).
--   public.mt_legacy_messages_assert_ready() the drop guard. RAISES when a snapshot table is missing while a live legacy table
--                                            exists, when a live row (six tables) is absent from or differs from its snapshot (stale
--                                            snapshot), when anything is unplaced, or when a classified row is missing from the
--                                            target. It re-runs the migration (a no-op). The drop file calls it first.
--
-- The D15 mapping (docs/MULTI-TENANT-PLAN.md section 4.11 "One migration rule"):
--   * a DM (legacy messages with a recipient, or a two-person direct thread): the two people share a non-platform tenant ->
--     scope community, tenant_id = that tenant; otherwise scope network, tenant_id = the sender's context tenant (health
--     pattern: context only), falling back to the legacy row's own tenant_id when the sender has no tenant AND that tenant is
--     not the platform tenant (else the row is unplaced and the drop guard refuses).
--   * a group thread: all members share a non-platform tenant -> a community chat_groups row of that tenant; otherwise a
--     network group: chat_groups.tenant_id = the creator's context tenant, metadata.legacy_scope = 'network' (chat_groups has
--     no scope column until network-groups-db, which backfills from this flag; docs/MULTI-TENANT-PLAN.md D27 keeps these
--     legacy cross-tenant threads readable by their participants only). Group messages carry the group's scope.
--   * rules 43-45: a service bot / notification test actor / platform-only account (public.is_network_excluded_account,
--     VTID-05582) is never migrated as sender, recipient or group member; their rows stay in bak_* only and are counted as
--     skipped_excluded. A group with no active non-excluded member is group_skipped only when such an account is a participant
--     or sender of it; otherwise it (and its messages) is unplaced. The platform tenant is never written on member content.
--   * a legacy thread id becomes the chat_groups id, a legacy message id becomes the chat_messages id; metadata keeps
--     legacy_source, legacy_id and (when present) legacy_content_data and legacy_parent_message_id. network rows are written
--     with the transaction-local flag vitana.chat_send_rpc = 'on' that the VTID-05576 scope guard requires.
-- Needs: chat_messages.scope (20261102050000) and is_network_excluded_account (20261102051000).
-- Rollback: docs/validation/VTID-05573/rollback-052100-functions.sql.

-- impact-allow-solo-migration: four service-role-only functions; nothing calls them until the next two files in this lane.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.mt_legacy_common_tenant(p_users uuid[])
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
  WITH u AS (SELECT DISTINCT x FROM unnest(p_users) x WHERE x IS NOT NULL)
  SELECT ut.tenant_id
    FROM public.user_tenants ut
    JOIN u ON u.x = ut.user_id
   WHERE NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.tenant_id = ut.tenant_id AND t.is_platform)
   GROUP BY ut.tenant_id
  HAVING (SELECT count(*) FROM u) > 0 AND count(DISTINCT ut.user_id) = (SELECT count(*) FROM u)
   ORDER BY bool_or(ut.is_primary) DESC, ut.tenant_id
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.mt_legacy_context_tenant(p_user uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT ut.tenant_id
    FROM public.user_tenants ut
   WHERE ut.user_id = p_user
     AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.tenant_id = ut.tenant_id AND t.is_platform)
   ORDER BY ut.is_primary DESC, ut.tenant_id
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.mt_legacy_messages_migrate()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  IF to_regclass('public.bak_messages') IS NULL OR to_regclass('public.bak_message_threads') IS NULL
     OR to_regclass('public.bak_global_messages') IS NULL OR to_regclass('public.bak_global_message_threads') IS NULL
     OR to_regclass('public.bak_thread_participants') IS NULL OR to_regclass('public.bak_global_thread_participants') IS NULL THEN
    RETURN jsonb_build_object('skipped', 'no legacy snapshot tables on this database');
  END IF;

  DROP TABLE IF EXISTS _lm_msg, _lm_thr, _lm_mem, _lm_excl;

  -- Source rows (the snapshots), both legacy messengers in one shape.
  CREATE TEMP TABLE _lm_msg AS
    SELECT 'messages'::text AS src, m.id, m.thread_id, m.sender_id, m.recipient_id, m.body, m.message_type, m.content_data,
           m.parent_message_id, m.created_at, m.read_at, m.delivered_at, m.tenant_id AS legacy_tenant
      FROM public.bak_messages m
    UNION ALL
    SELECT 'global_messages', g.id, g.thread_id, g.sender_id, NULL::uuid, g.body, g.message_type, g.content_data,
           g.parent_message_id, g.created_at, g.read_at, g.delivered_at, NULL::uuid
      FROM public.bak_global_messages g;
  ALTER TABLE _lm_msg ADD COLUMN tkind text, ADD COLUMN tpeople uuid[], ADD COLUMN toutcome text, ADD COLUMN gtenant uuid,
    ADD COLUMN gscope text, ADD COLUMN mode text, ADD COLUMN rcv uuid, ADD COLUMN grp uuid, ADD COLUMN s_excl boolean,
    ADD COLUMN r_excl boolean, ADD COLUMN outcome text, ADD COLUMN tenant uuid, ADD COLUMN scope text;
  -- The legacy row's own tenant is a fallback only; the platform tenant is never a fallback (it is never written on member content).
  UPDATE _lm_msg SET legacy_tenant = NULL WHERE legacy_tenant IN (SELECT t.tenant_id FROM public.tenants t WHERE t.is_platform);

  CREATE TEMP TABLE _lm_thr AS
    SELECT 'messages'::text AS src, t.id, t.type, t.name, t.created_by, t.created_at, t.metadata, t.tenant_id AS legacy_tenant
      FROM public.bak_message_threads t
    UNION ALL
    SELECT 'global_messages', t.id, t.type, t.name, t.created_by, t.created_at, t.metadata, NULL::uuid
      FROM public.bak_global_message_threads t;
  ALTER TABLE _lm_thr ADD COLUMN people uuid[], ADD COLUMN members uuid[], ADD COLUMN kind text, ADD COLUMN gtenant uuid,
    ADD COLUMN gscope text, ADD COLUMN outcome text, ADD COLUMN excl_involved boolean;
  UPDATE _lm_thr SET legacy_tenant = NULL WHERE legacy_tenant IN (SELECT t.tenant_id FROM public.tenants t WHERE t.is_platform);

  CREATE TEMP TABLE _lm_mem AS
    SELECT 'messages'::text AS src, p.thread_id, p.user_id, p.role, p.joined_at, p.last_read_at
      FROM public.bak_thread_participants p WHERE p.is_active
    UNION ALL
    SELECT 'global_messages', p.thread_id, p.user_id, p.role, p.joined_at, p.last_read_at
      FROM public.bak_global_thread_participants p WHERE p.is_active;

  -- Rules 43-45: who may never be migrated.
  CREATE TEMP TABLE _lm_excl AS
    SELECT u.user_id, public.is_network_excluded_account(u.user_id) AS excl
      FROM (SELECT sender_id AS user_id FROM _lm_msg UNION SELECT recipient_id FROM _lm_msg
            UNION SELECT user_id FROM _lm_mem UNION SELECT created_by FROM _lm_thr) u
     WHERE u.user_id IS NOT NULL;

  -- Threads: who is in them, what kind, which tenant and scope.
  UPDATE _lm_thr t SET people = (
    SELECT array_agg(DISTINCT x ORDER BY x) FROM (
      SELECT m.user_id AS x FROM _lm_mem m WHERE m.src = t.src AND m.thread_id = t.id
      UNION SELECT g.sender_id FROM _lm_msg g WHERE g.src = t.src AND g.thread_id = t.id AND g.sender_id IS NOT NULL) q);
  UPDATE _lm_thr t SET members = coalesce((
    SELECT array_agg(m.user_id ORDER BY m.user_id) FROM _lm_mem m JOIN _lm_excl e ON e.user_id = m.user_id
     WHERE m.src = t.src AND m.thread_id = t.id AND NOT e.excl), '{}'::uuid[]);
  -- A rule 43-45 account actually involved in the thread (an active participant or a sender).
  UPDATE _lm_thr t SET excl_involved = EXISTS (SELECT 1 FROM _lm_excl e WHERE e.excl AND e.user_id = ANY (t.people));
  UPDATE _lm_thr SET kind = CASE
      WHEN people IS NULL OR cardinality(people) = 0 THEN 'empty'
      WHEN type = 'direct' AND cardinality(people) = 2 THEN 'dm'
      WHEN type = 'direct' THEN 'unplaced'
      ELSE 'group' END;
  UPDATE _lm_thr SET gtenant = public.mt_legacy_common_tenant(members) WHERE kind = 'group' AND cardinality(members) > 0;
  UPDATE _lm_thr SET gscope = 'community' WHERE kind = 'group' AND gtenant IS NOT NULL;
  UPDATE _lm_thr SET gscope = 'network',
      gtenant = coalesce(public.mt_legacy_context_tenant(created_by), legacy_tenant, public.mt_legacy_context_tenant(members[1]))
   WHERE kind = 'group' AND gtenant IS NULL AND cardinality(members) > 0;
  UPDATE _lm_thr SET outcome = CASE kind
      WHEN 'empty' THEN 'empty'
      WHEN 'dm' THEN 'dm'
      WHEN 'unplaced' THEN 'unplaced'
      ELSE CASE WHEN cardinality(members) = 0 THEN CASE WHEN excl_involved THEN 'group_skipped' ELSE 'unplaced' END
                WHEN gtenant IS NULL THEN 'unplaced' ELSE 'group_migrated' END END;

  -- Messages: DM or group message, the people, the tenant and scope, the outcome.
  UPDATE _lm_msg m SET tkind = t.kind, tpeople = t.people, toutcome = t.outcome, gtenant = t.gtenant, gscope = t.gscope
    FROM _lm_thr t WHERE t.src = m.src AND t.id = m.thread_id;
  UPDATE _lm_msg SET mode = CASE WHEN thread_id IS NULL THEN 'dm' WHEN tkind = 'dm' THEN 'dm' WHEN tkind = 'group' THEN 'group' ELSE 'orphan' END;
  UPDATE _lm_msg m SET rcv = CASE WHEN m.thread_id IS NULL THEN m.recipient_id
      ELSE (SELECT x FROM unnest(m.tpeople) x WHERE x IS DISTINCT FROM m.sender_id ORDER BY x LIMIT 1) END
   WHERE m.mode = 'dm';
  UPDATE _lm_msg m SET grp = m.thread_id WHERE m.mode = 'group';
  UPDATE _lm_msg m SET
      s_excl = coalesce((SELECT e.excl FROM _lm_excl e WHERE e.user_id = m.sender_id), false),
      r_excl = coalesce((SELECT e.excl FROM _lm_excl e WHERE e.user_id = m.rcv), false);
  UPDATE _lm_msg SET outcome = CASE
      WHEN mode = 'orphan' THEN 'unplaced'
      WHEN sender_id IS NULL THEN 'unplaced'
      WHEN mode = 'dm' AND (rcv IS NULL OR rcv = sender_id) THEN 'unplaced'
      WHEN s_excl OR r_excl THEN 'skipped_excluded'
      WHEN mode = 'group' AND toutcome IS DISTINCT FROM 'group_migrated' THEN 'unplaced'
      ELSE 'migrate' END;
  UPDATE _lm_msg SET
      tenant = CASE WHEN mode = 'group' THEN gtenant
                    ELSE coalesce(public.mt_legacy_common_tenant(ARRAY[sender_id, rcv]), public.mt_legacy_context_tenant(sender_id), legacy_tenant) END,
      scope  = CASE WHEN mode = 'group' THEN gscope
                    WHEN public.mt_legacy_common_tenant(ARRAY[sender_id, rcv]) IS NOT NULL THEN 'community' ELSE 'network' END
   WHERE outcome = 'migrate';
  UPDATE _lm_msg SET outcome = 'unplaced' WHERE outcome = 'migrate' AND (tenant IS NULL OR scope IS NULL);

  -- Move the placeable rows. Groups first, then members, then messages.
  INSERT INTO public.chat_groups (id, tenant_id, name, description, created_by, is_system, metadata, created_at)
    SELECT t.id, t.gtenant, coalesce(nullif(t.name, ''), 'Group'), NULL, t.created_by, false,
           (CASE WHEN jsonb_typeof(t.metadata) = 'object' THEN t.metadata ELSE '{}'::jsonb END)
             || jsonb_build_object('legacy_source', CASE t.src WHEN 'messages' THEN 'message_threads' ELSE 'global_message_threads' END,
                                   'legacy_id', t.id, 'legacy_scope', t.gscope),
           t.created_at
      FROM _lm_thr t WHERE t.outcome = 'group_migrated'
    ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role, joined_at, last_read_at)
    SELECT m.thread_id, m.user_id, t.gtenant, CASE m.role WHEN 'admin' THEN 'admin' ELSE 'member' END, m.joined_at, m.last_read_at
      FROM _lm_mem m
      JOIN _lm_thr t ON t.src = m.src AND t.id = m.thread_id
      JOIN _lm_excl e ON e.user_id = m.user_id AND NOT e.excl
     WHERE t.outcome = 'group_migrated'
    ON CONFLICT (group_id, user_id) DO NOTHING;

  PERFORM set_config('vitana.chat_send_rpc', 'on', true);
  INSERT INTO public.chat_messages (id, tenant_id, sender_id, receiver_id, group_id, content, read_at, delivered_at, created_at,
                                    message_type, metadata, scope)
    SELECT m.id, m.tenant, m.sender_id, CASE WHEN m.mode = 'dm' THEN m.rcv END, m.grp, m.body, m.read_at, m.delivered_at,
           coalesce(m.created_at, now()), coalesce(m.message_type, 'text'),
           jsonb_build_object('legacy_source', m.src, 'legacy_id', m.id)
             || CASE WHEN m.content_data IS NOT NULL THEN jsonb_build_object('legacy_content_data', m.content_data) ELSE '{}'::jsonb END
             || CASE WHEN m.parent_message_id IS NOT NULL THEN jsonb_build_object('legacy_parent_message_id', m.parent_message_id) ELSE '{}'::jsonb END,
           m.scope
      FROM _lm_msg m WHERE m.outcome = 'migrate'
    ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('vitana.chat_send_rpc', '', true);

  v_result := jsonb_build_object(
    'messages', (SELECT jsonb_build_object('total', count(*), 'migrated', count(*) FILTER (WHERE outcome = 'migrate'),
        'skipped_excluded', count(*) FILTER (WHERE outcome = 'skipped_excluded'), 'unplaced', count(*) FILTER (WHERE outcome = 'unplaced'))
      FROM _lm_msg WHERE src = 'messages'),
    'global_messages', (SELECT jsonb_build_object('total', count(*), 'migrated', count(*) FILTER (WHERE outcome = 'migrate'),
        'skipped_excluded', count(*) FILTER (WHERE outcome = 'skipped_excluded'), 'unplaced', count(*) FILTER (WHERE outcome = 'unplaced'))
      FROM _lm_msg WHERE src = 'global_messages'),
    'threads', (SELECT jsonb_build_object('dm', count(*) FILTER (WHERE outcome = 'dm'),
        'group_migrated', count(*) FILTER (WHERE outcome = 'group_migrated'), 'group_skipped', count(*) FILTER (WHERE outcome = 'group_skipped'),
        'empty', count(*) FILTER (WHERE outcome = 'empty'), 'unplaced', count(*) FILTER (WHERE outcome = 'unplaced'))
      FROM _lm_thr),
    'landed', jsonb_build_object(
      'messages', (SELECT count(*) FROM _lm_msg m JOIN public.chat_messages c ON c.id = m.id AND c.metadata ->> 'legacy_source' = m.src
                    WHERE m.src = 'messages' AND m.outcome = 'migrate'),
      'global_messages', (SELECT count(*) FROM _lm_msg m JOIN public.chat_messages c ON c.id = m.id AND c.metadata ->> 'legacy_source' = m.src
                    WHERE m.src = 'global_messages' AND m.outcome = 'migrate'),
      'groups', (SELECT count(*) FROM _lm_thr t JOIN public.chat_groups g ON g.id = t.id AND g.metadata ->> 'legacy_source' IS NOT NULL
                  WHERE t.outcome = 'group_migrated')));

  DROP TABLE IF EXISTS _lm_msg, _lm_thr, _lm_mem, _lm_excl;
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.mt_legacy_messages_assert_ready()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v jsonb;
  v_table text;
  v_n bigint;
  v_all text[] := ARRAY['messages', 'message_threads', 'global_message_threads', 'global_messages',
                        'thread_participants', 'global_thread_participants'];
  v_legacy text[] := ARRAY['messages', 'message_threads', 'global_message_threads', 'global_messages'];
  v_live_legacy boolean;
BEGIN
  -- 1. Snapshots. A live legacy table without every snapshot is never "nothing to do": refuse. Only when none of the four
  --    legacy tables exists any more (already dropped, or a stack without the vitana-v1 schema) is a missing snapshot a skip.
  SELECT bool_or(to_regclass('public.' || t) IS NOT NULL) INTO v_live_legacy FROM unnest(v_legacy) t;
  FOREACH v_table IN ARRAY v_all LOOP
    IF to_regclass('public.bak_' || v_table) IS NULL AND v_live_legacy THEN
      RAISE EXCEPTION 'VTID-05573: snapshot bak_% is missing while a live legacy table exists, refusing to drop', v_table USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- 2. Every live row (legacy tables and the two participant tables) must be in its snapshot unchanged. A snapshot left over
  --    from an earlier apply (rollback-052000, writes, 052000 again) fails here instead of losing rows at the drop.
  FOREACH v_table IN ARRAY v_all LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL AND to_regclass('public.bak_' || v_table) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I l WHERE NOT EXISTS (SELECT 1 FROM public.%I b WHERE b.id = l.id AND to_jsonb(b) = to_jsonb(l))',
                     v_table, 'bak_' || v_table) INTO v_n;
      IF v_n > 0 THEN
        RAISE EXCEPTION 'VTID-05573: % live row(s) of % are absent from bak_% or differ from it (stale snapshot), refusing to drop',
          v_n, v_table, v_table USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END LOOP;

  v := public.mt_legacy_messages_migrate();
  IF v ? 'skipped' THEN
    RETURN v;
  END IF;
  IF (v -> 'messages' ->> 'unplaced')::int <> 0 OR (v -> 'global_messages' ->> 'unplaced')::int <> 0 OR (v -> 'threads' ->> 'unplaced')::int <> 0 THEN
    RAISE EXCEPTION 'VTID-05573: legacy rows could not be placed, refusing to drop: %', v USING ERRCODE = 'P0001';
  END IF;
  IF (v -> 'landed' ->> 'messages') <> (v -> 'messages' ->> 'migrated')
     OR (v -> 'landed' ->> 'global_messages') <> (v -> 'global_messages' ->> 'migrated')
     OR (v -> 'landed' ->> 'groups') <> (v -> 'threads' ->> 'group_migrated') THEN
    RAISE EXCEPTION 'VTID-05573: migrated rows are missing from the target, refusing to drop: %', v USING ERRCODE = 'P0001';
  END IF;
  RETURN v;
END
$fn$;

REVOKE ALL ON FUNCTION public.mt_legacy_common_tenant(uuid[]), public.mt_legacy_context_tenant(uuid),
  public.mt_legacy_messages_migrate(), public.mt_legacy_messages_assert_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_legacy_common_tenant(uuid[]), public.mt_legacy_context_tenant(uuid),
  public.mt_legacy_messages_migrate(), public.mt_legacy_messages_assert_ready() TO service_role;

COMMIT;
