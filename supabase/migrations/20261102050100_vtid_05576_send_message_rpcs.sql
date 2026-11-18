-- VTID-05576 (mt-network-r2/messaging-send-db) N1b: the only member-message writers, send_message() and send_message_as().
--
--   public.chat_send_message_core(p_sender, p_peer, p_group, p_scope, p_body, p_message_type, p_metadata, p_client_message_id)
--     The one body. SECURITY DEFINER, pinned search_path, EXECUTE for nobody (only the two wrappers call it).
--   public.send_message(p_peer, p_group, p_scope, p_body, p_message_type, p_metadata, p_client_message_id)
--     EXECUTE for authenticated. The sender is auth.uid(), never a parameter.
--   public.send_message_as(p_sender, p_peer, p_group, p_scope, p_body, p_message_type, p_metadata, p_client_message_id)
--     EXECUTE for service_role only. p_sender is trusted: the gateway verified the member (ORB voice send, intent share,
--     group send, live bridge).
-- Rules (design.md messaging-send-db; plan section 4.11):
--   * Exactly one of p_peer / p_group. p_scope is 'community' or 'network'. The body is not blank.
--   * community DM: both members belong to one non-platform tenant; tenant_id is that shared tenant (the sender's primary
--     one when several are shared).
--   * group: community only (network groups are a later, flagged lane); the sender is a member (is_chat_group_member);
--     tenant_id is the group's.
--   * network DM: both members network_visible on global_community_profiles; neither is a service/test/automation account
--     (rules 43-45: service_bot_accounts, notification_test_actors, platform_only_accounts when it exists); the recipient's
--     messaging_preference is everyone, or connections with an accepted connection_requests row in either direction (nobody
--     refuses); no unexpired user_blocklist row in either direction; at most 20 NEW network contacts per sender per 24 hours.
--     tenant_id is only the sender's context (primary non-platform tenant first).
--   * A repeated p_client_message_id of the same sender returns the stored row (idempotent retry).
-- Errors: 28000 not authenticated; 22023 bad argument; 42501 not allowed; 54000 rate limit.
-- The RPCs set the transaction-local flag vitana.chat_send_rpc = 'on' around the INSERT, which is what the scope guard from
-- 20261102050000 looks for, and clear it again.
-- Global_community_profiles / connection_requests / user_blocklist are vitana-v1 / platform tables already in the same database.
-- Nothing calls the RPCs yet (messaging-send-gateway does, later); dark.
-- Rollback: docs/validation/VTID-05576/rollback-050100-send-message-rpcs.sql.

-- impact-allow-solo-migration: adds three functions; the callers ship in a later lane.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.chat_send_message_core(
  p_sender uuid, p_peer uuid, p_group uuid, p_scope text, p_body text,
  p_message_type text, p_metadata jsonb, p_client_message_id uuid)
 RETURNS public.chat_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_row public.chat_messages;
  v_tenant uuid;
  v_pref text;
  v_excluded boolean := false;
BEGIN
  IF p_sender IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('community', 'network') THEN
    RAISE EXCEPTION 'invalid_scope' USING ERRCODE = '22023';
  END IF;
  IF p_body IS NULL OR btrim(p_body) = '' THEN
    RAISE EXCEPTION 'empty_body' USING ERRCODE = '22023';
  END IF;
  IF (p_peer IS NULL) = (p_group IS NULL) THEN
    RAISE EXCEPTION 'peer_xor_group' USING ERRCODE = '22023';
  END IF;
  IF p_peer = p_sender THEN
    RAISE EXCEPTION 'invalid_recipient' USING ERRCODE = '22023';
  END IF;

  -- Idempotent retry: the same sender and client_message_id returns the stored row.
  IF p_client_message_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.chat_messages
     WHERE sender_id = p_sender AND client_message_id = p_client_message_id;
    IF FOUND THEN
      RETURN v_row;
    END IF;
  END IF;

  IF p_group IS NOT NULL THEN
    IF p_scope <> 'community' THEN
      RAISE EXCEPTION 'network_group_not_supported' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_chat_group_member(p_group, p_sender) THEN
      RAISE EXCEPTION 'not_a_group_member' USING ERRCODE = '42501';
    END IF;
    SELECT g.tenant_id INTO v_tenant FROM public.chat_groups g WHERE g.id = p_group;
    IF v_tenant IS NULL THEN
      RAISE EXCEPTION 'unknown_group' USING ERRCODE = '42501';
    END IF;

  ELSIF p_scope = 'community' THEN
    SELECT a.tenant_id INTO v_tenant
      FROM public.user_tenants a
      JOIN public.user_tenants b ON b.tenant_id = a.tenant_id
     WHERE a.user_id = p_sender AND b.user_id = p_peer
       AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.tenant_id = a.tenant_id AND t.is_platform)
     ORDER BY a.is_primary DESC, a.tenant_id
     LIMIT 1;
    IF v_tenant IS NULL THEN
      RAISE EXCEPTION 'no_shared_tenant' USING ERRCODE = '42501';
    END IF;

  ELSE
    -- network DM
    -- platform_only_accounts belongs to another spec and may not exist yet: read it dynamically, only when present.
    IF to_regclass('public.platform_only_accounts') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.platform_only_accounts WHERE user_id = ANY($1))'
        INTO v_excluded USING ARRAY[p_sender, p_peer];
    END IF;
    IF v_excluded
       OR EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id IN (p_sender, p_peer))
       OR EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id IN (p_sender, p_peer)) THEN
      RAISE EXCEPTION 'excluded_account' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.global_community_profiles WHERE user_id = p_sender AND network_visible) THEN
      RAISE EXCEPTION 'sender_not_network_visible' USING ERRCODE = '42501';
    END IF;
    SELECT messaging_preference INTO v_pref
      FROM public.global_community_profiles WHERE user_id = p_peer AND network_visible;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'recipient_not_network_visible' USING ERRCODE = '42501';
    END IF;
    IF v_pref = 'nobody' THEN
      RAISE EXCEPTION 'recipient_accepts_no_messages' USING ERRCODE = '42501';
    END IF;
    IF v_pref = 'connections' AND NOT EXISTS (
         SELECT 1 FROM public.connection_requests c
          WHERE c.status = 'accepted'
            AND ((c.from_user_id = p_sender AND c.to_user_id = p_peer) OR (c.from_user_id = p_peer AND c.to_user_id = p_sender))) THEN
      RAISE EXCEPTION 'not_connected' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.user_blocklist b
                WHERE b.expires_at > now()
                  AND ((b.user_id = p_peer AND b.blocked_user_id = p_sender) OR (b.user_id = p_sender AND b.blocked_user_id = p_peer))) THEN
      RAISE EXCEPTION 'blocked' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.chat_messages m
                    WHERE m.sender_id = p_sender AND m.receiver_id = p_peer AND m.scope = 'network')
       AND (SELECT count(DISTINCT m.receiver_id) FROM public.chat_messages m
             WHERE m.sender_id = p_sender AND m.scope = 'network' AND m.receiver_id IS NOT NULL
               AND m.created_at > now() - interval '24 hours') >= 20 THEN
      RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
    END IF;
    SELECT ut.tenant_id INTO v_tenant
      FROM public.user_tenants ut
     WHERE ut.user_id = p_sender
     ORDER BY EXISTS (SELECT 1 FROM public.tenants t WHERE t.tenant_id = ut.tenant_id AND t.is_platform), ut.is_primary DESC, ut.tenant_id
     LIMIT 1;
    IF v_tenant IS NULL THEN
      RAISE EXCEPTION 'sender_has_no_tenant' USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM set_config('vitana.chat_send_rpc', 'on', true);
  INSERT INTO public.chat_messages
    (tenant_id, sender_id, receiver_id, group_id, content, message_type, metadata, client_message_id, scope)
  VALUES
    (v_tenant, p_sender, p_peer, p_group, p_body, coalesce(nullif(p_message_type, ''), 'text'),
     coalesce(p_metadata, '{}'::jsonb), p_client_message_id, p_scope)
  RETURNING * INTO v_row;
  PERFORM set_config('vitana.chat_send_rpc', '', true);
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_send_message_core(uuid, uuid, uuid, text, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.send_message(
  p_peer uuid, p_group uuid, p_scope text, p_body text,
  p_message_type text DEFAULT 'text', p_metadata jsonb DEFAULT '{}'::jsonb, p_client_message_id uuid DEFAULT NULL)
 RETURNS public.chat_messages
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT * FROM public.chat_send_message_core((SELECT auth.uid()), p_peer, p_group, p_scope, p_body, p_message_type, p_metadata, p_client_message_id)
$$;
REVOKE ALL ON FUNCTION public.send_message(uuid, uuid, text, text, text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_message(uuid, uuid, text, text, text, jsonb, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.send_message_as(
  p_sender uuid, p_peer uuid, p_group uuid, p_scope text, p_body text,
  p_message_type text DEFAULT 'text', p_metadata jsonb DEFAULT '{}'::jsonb, p_client_message_id uuid DEFAULT NULL)
 RETURNS public.chat_messages
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT * FROM public.chat_send_message_core(p_sender, p_peer, p_group, p_scope, p_body, p_message_type, p_metadata, p_client_message_id)
$$;
REVOKE ALL ON FUNCTION public.send_message_as(uuid, uuid, uuid, text, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_message_as(uuid, uuid, uuid, text, text, text, jsonb, uuid) TO service_role;

COMMIT;
