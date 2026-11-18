-- VTID-05579 (mt-network-r2/network-groups-db) M3b: create_network_group() and add_group_member() (D27).
--
-- The scope guards of 20261102054000 stop every direct write of a network group or of a network member, so these functions are
-- the only way either exists. Six functions, all SECURITY DEFINER with a pinned search_path:
--   public.chat_group_create_core(p_actor, p_name, p_description)      the one body; EXECUTE to nobody
--   public.chat_group_add_member_core(p_actor, p_group, p_user)         the one body; EXECUTE to nobody
--   public.create_network_group(p_name, p_description)                  caller = auth.uid(); EXECUTE authenticated
--   public.add_group_member(p_group_id, p_user_id)                      caller = auth.uid(); EXECUTE authenticated
--   public.create_network_group_as(p_actor, p_name, p_description)      the gateway on behalf of a verified member; service_role only
--   public.add_group_member_as(p_actor, p_group_id, p_user_id)          same; service_role only
-- (The same split as send_message / send_message_as, VTID-05576: the caller of the _as pair is the gateway, which has verified
-- p_actor from the request identity.)
--
-- create: the actor must be network_visible and not a rule 43-45 account (service bot, notification test actor, platform-only
--   account: is_network_excluded_account, VTID-05582) and must have a non-platform tenant (primary first); the group is
--   scope = 'network', tenant_id = that tenant (the creator's tenant is CONTEXT only), created_by = the actor, never is_system;
--   the creator is its first member and its admin. Name: trimmed, 1..100 characters. Description cut to 500.
-- add, Network group (D27): the caller must be a member (42501 not_a_member) and the group's admin (not_group_admin, no
--   self-join: invite-only), still network_visible; the invitee must not be the caller (22023 invalid_member), not a rule 43-45
--   account (account_not_eligible), network_visible (target_not_network_visible), not blocked in either direction by an unexpired
--   user_blocklist row (blocked), and connected to the caller by an accepted connection_requests row in either direction
--   (not_connected). An existing member returns false (no-op, also when the group is full). A group with 20 members refuses the
--   21st (54000 group_full). The new member row has role member, scope network and tenant_id = the group's tenant (the creator's
--   tenant as context, not the member's own). The group row is locked FOR UPDATE, so two adds cannot both take slot 20.
-- add, any group that is not scope = 'network' (a community group, a system group): refused with 42501 not_network_group, before
--   any membership check. Review fix (reviewer verdict `changes`, PR 4850): add_group_member is callable by every authenticated
--   user, and a community branch would have let any member of any community group (is_system included) add any user of the
--   group's tenant with no admin check, no consent and no cap. That is a new client write path beyond the converged plan, which
--   covers Network rules only. Today's direct community writers are unchanged.
-- No function writes a chat message, a notification or any system row: nothing is fanned out when a group is created or joined.
-- Errors: 28000 not authenticated; 22023 bad argument; 42501 not allowed; P0002 no such group; 54000 group full.
--
-- connection_requests / global_community_profiles / user_blocklist are vitana-v1 / platform tables in the same database; their
-- names are resolved when a function runs, not when it is created. Nothing calls these functions yet (network-groups-gateway does,
-- behind mt.network_groups); dark.
-- Rollback: docs/validation/VTID-05579/rollback-054100-network-group-rpcs.sql.

-- impact-allow-solo-migration: six new functions only; the callers ship in the gateway and v1 lanes.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.chat_group_create_core(p_actor uuid, p_name text, p_description text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_name text := btrim(p_name);
  v_tenant uuid;
  v_id uuid;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_name IS NULL OR v_name = '' OR length(v_name) > 100 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = '22023';
  END IF;
  IF public.is_network_excluded_account(p_actor) THEN
    RAISE EXCEPTION 'account_not_eligible' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.global_community_profiles WHERE user_id = p_actor AND network_visible) THEN
    RAISE EXCEPTION 'actor_not_network_visible' USING ERRCODE = '42501';
  END IF;
  SELECT ut.tenant_id INTO v_tenant
    FROM public.user_tenants ut
   WHERE ut.user_id = p_actor
     AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.tenant_id = ut.tenant_id AND t.is_platform)
   ORDER BY ut.is_primary DESC, ut.tenant_id
   LIMIT 1;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no_context_tenant' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('vitana.chat_group_rpc', 'on', true);
  INSERT INTO public.chat_groups (tenant_id, name, description, created_by, is_system, metadata, scope)
  VALUES (v_tenant, v_name, left(p_description, 500), p_actor, false, '{}'::jsonb, 'network')
  RETURNING id INTO v_id;
  INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role, scope)
  VALUES (v_id, p_actor, v_tenant, 'admin', 'network');
  PERFORM set_config('vitana.chat_group_rpc', '', true);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_group_create_core(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.chat_group_add_member_core(p_actor uuid, p_group uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_g record;
  v_role text;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_group IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_user = p_actor THEN
    RAISE EXCEPTION 'invalid_member' USING ERRCODE = '22023';
  END IF;

  SELECT g.id, g.tenant_id, g.scope INTO v_g FROM public.chat_groups g WHERE g.id = p_group FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_g.scope IS DISTINCT FROM 'network' THEN
    -- Review fix: no client write path into a community (or system) group; today's direct community writers are unchanged.
    RAISE EXCEPTION 'not_network_group' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_role FROM public.chat_group_members m WHERE m.group_id = p_group AND m.user_id = p_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_a_member' USING ERRCODE = '42501';
  END IF;

  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'not_group_admin' USING ERRCODE = '42501';
  END IF;
  IF public.is_network_excluded_account(p_actor)
     OR NOT EXISTS (SELECT 1 FROM public.global_community_profiles WHERE user_id = p_actor AND network_visible) THEN
    RAISE EXCEPTION 'actor_not_network_visible' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chat_group_members m WHERE m.group_id = p_group AND m.user_id = p_user) THEN
    RETURN false;
  END IF;
  IF public.is_network_excluded_account(p_user) THEN
    RAISE EXCEPTION 'account_not_eligible' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.global_community_profiles WHERE user_id = p_user AND network_visible) THEN
    RAISE EXCEPTION 'target_not_network_visible' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_blocklist b
              WHERE b.expires_at > now()
                AND ((b.user_id = p_user AND b.blocked_user_id = p_actor) OR (b.user_id = p_actor AND b.blocked_user_id = p_user))) THEN
    RAISE EXCEPTION 'blocked' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.connection_requests c
                  WHERE c.status = 'accepted'
                    AND ((c.from_user_id = p_actor AND c.to_user_id = p_user) OR (c.from_user_id = p_user AND c.to_user_id = p_actor))) THEN
    RAISE EXCEPTION 'not_connected' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM public.chat_group_members m WHERE m.group_id = p_group) >= 20 THEN
    RAISE EXCEPTION 'group_full' USING ERRCODE = '54000';
  END IF;
  PERFORM set_config('vitana.chat_group_rpc', 'on', true);
  INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role, scope)
  VALUES (p_group, p_user, v_g.tenant_id, 'member', 'network');
  PERFORM set_config('vitana.chat_group_rpc', '', true);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_group_add_member_core(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_network_group(p_name text, p_description text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT public.chat_group_create_core((SELECT auth.uid()), p_name, p_description)
$$;
REVOKE ALL ON FUNCTION public.create_network_group(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_network_group(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.add_group_member(p_group_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT public.chat_group_add_member_core((SELECT auth.uid()), p_group_id, p_user_id)
$$;
REVOKE ALL ON FUNCTION public.add_group_member(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_group_member(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_network_group_as(p_actor uuid, p_name text, p_description text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT public.chat_group_create_core(p_actor, p_name, p_description)
$$;
REVOKE ALL ON FUNCTION public.create_network_group_as(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_network_group_as(uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.add_group_member_as(p_actor uuid, p_group_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT public.chat_group_add_member_core(p_actor, p_group_id, p_user_id)
$$;
REVOKE ALL ON FUNCTION public.add_group_member_as(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_group_member_as(uuid, uuid, uuid) TO service_role;

COMMIT;
