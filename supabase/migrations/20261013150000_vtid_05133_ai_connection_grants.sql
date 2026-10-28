-- =============================================================================
-- VTID-05133 — "Connect your AI": what each connected AI assistant may use
-- -----------------------------------------------------------------------------
-- A member connects ChatGPT or Claude to Maxina through Supabase Auth's OAuth
-- 2.1 server. Supabase tokens are not bound to one resource: a token minted for
-- the Commerce connector is accepted by any /mcp/* endpoint. So what a client
-- may do is recorded here, per (member, OAuth client), and every MCP tool
-- checks it (plan: docs/validation/VTID-05133/plan-sparring.md).
--
--   ai_connection_grants   one row per member per assistant connection.
--                          categories: profile | matches | people | activities | commerce
--                          revoked_at: the member disconnected it in Maxina.
--
-- Rules the gateway applies (services/ai-connection-grants.ts):
--   /mcp/community*  — needs an active row with the tool's category.
--   /mcp, /mcp/chatgpt (Commerce) — a client WITH a row needs 'commerce' and
--                      no revoked_at; a client with NO row (every connection
--                      made before this migration) is unchanged.
--
-- Writes only through the three SECURITY DEFINER functions below, as the
-- signed-in member (auth.uid()); members read their own rows; the gateway
-- reads with service_role.
--
--   ai_connection_authorization_info(authorization_id)
--       What the consent screen shows: client name, redirect host and which
--       Vitana product the assistant asked for (from the pending
--       authorization's `resource`). Pending authorizations only.
--   ai_connection_grant_from_authorization(authorization_id, categories)
--       Called by the consent screen BEFORE it approves the authorization
--       with Supabase. Resolves the client from the pending authorization
--       (never from a client-supplied id) and upserts the member's row,
--       clearing revoked_at (a fresh approval).
--   ai_connection_grant_update(client_id, categories)
--       Settings toggles; active rows only (a disconnected row stays
--       disconnected until the member approves the assistant again).
--   ai_connection_grant_revoke(client_id)
--       Settings "Disconnect": revoked_at = now(), categories emptied. The
--       tools refuse at once. Supabase's own grant/refresh token is left to
--       Supabase Auth (no supported API to revoke it from here).
--
-- Additive and idempotent. Rollback: docs/validation/VTID-05133/rollback.sql.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_connection_grants (
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id      uuid        NOT NULL,
  client_name    text,
  redirect_host  text,
  resource       text,
  categories     text[]      NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  PRIMARY KEY (user_id, client_id),
  CONSTRAINT ai_connection_grants_categories_known CHECK (
    categories <@ ARRAY['profile', 'matches', 'people', 'activities', 'commerce']::text[]
  )
);

COMMENT ON TABLE public.ai_connection_grants IS
  'VTID-05133: what each AI assistant a member connected (Supabase OAuth client) may use through the Maxina MCP tools. Written only via ai_connection_grant_* functions as the member.';

ALTER TABLE public.ai_connection_grants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_connection_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_connection_grants TO authenticated;
GRANT SELECT ON public.ai_connection_grants TO service_role;

DROP POLICY IF EXISTS ai_connection_grants_owner_select ON public.ai_connection_grants;
CREATE POLICY ai_connection_grants_owner_select ON public.ai_connection_grants
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS ai_connection_grants_service_select ON public.ai_connection_grants;
CREATE POLICY ai_connection_grants_service_select ON public.ai_connection_grants
  FOR SELECT TO service_role
  USING (true);

-- Normalise a requested category list: known values only, no duplicates, sorted.
CREATE OR REPLACE FUNCTION public._ai_connection_categories(p_categories text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(array_agg(DISTINCT c ORDER BY c), '{}'::text[])
  FROM unnest(COALESCE(p_categories, '{}'::text[])) AS c
  WHERE c IN ('profile', 'matches', 'people', 'activities', 'commerce');
$$;

-- The host of the first redirect URI Supabase stored for the client.
CREATE OR REPLACE FUNCTION public._ai_connection_redirect_host(p_redirect_uris text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT lower(substring(p_redirect_uris FROM '^[\s\["'']*[a-zA-Z][a-zA-Z0-9+.-]*://([^/:"''\s,\]]+)'));
$$;

CREATE OR REPLACE FUNCTION public.ai_connection_authorization_info(p_authorization_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_row record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN' USING ERRCODE = '42501';
  END IF;
  SELECT a.client_id, a.resource, c.client_name, c.redirect_uris
    INTO v_row
    FROM auth.oauth_authorizations a
    JOIN auth.oauth_clients c ON c.id = a.client_id AND c.deleted_at IS NULL
   WHERE a.authorization_id = p_authorization_id
     AND a.status::text = 'pending'
     AND (a.user_id IS NULL OR a.user_id = auth.uid())
     AND (a.expires_at IS NULL OR a.expires_at > now());
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'client_id', v_row.client_id,
    'client_name', v_row.client_name,
    'redirect_host', public._ai_connection_redirect_host(v_row.redirect_uris),
    'resource', v_row.resource,
    'product', CASE
      WHEN v_row.resource ~ '/mcp/community(/|$)' THEN 'community'
      WHEN v_row.resource ~ '/mcp(/chatgpt)?/?$' THEN 'commerce'
      ELSE 'unknown'
    END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_connection_grant_from_authorization(p_authorization_id text, p_categories text[])
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row record;
  v_categories text[] := public._ai_connection_categories(p_categories);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN' USING ERRCODE = '42501';
  END IF;
  SELECT a.client_id, a.resource, c.client_name, c.redirect_uris
    INTO v_row
    FROM auth.oauth_authorizations a
    JOIN auth.oauth_clients c ON c.id = a.client_id AND c.deleted_at IS NULL
   WHERE a.authorization_id = p_authorization_id
     AND a.status::text = 'pending'
     AND (a.user_id IS NULL OR a.user_id = v_uid)
     AND (a.expires_at IS NULL OR a.expires_at > now());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUTHORIZATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.ai_connection_grants AS g
    (user_id, client_id, client_name, redirect_host, resource, categories, created_at, updated_at, revoked_at)
  VALUES
    (v_uid, v_row.client_id, left(v_row.client_name, 200), public._ai_connection_redirect_host(v_row.redirect_uris),
     left(v_row.resource, 500), v_categories, now(), now(), NULL)
  ON CONFLICT (user_id, client_id) DO UPDATE
    SET client_name = EXCLUDED.client_name,
        redirect_host = EXCLUDED.redirect_host,
        resource = EXCLUDED.resource,
        categories = EXCLUDED.categories,
        updated_at = now(),
        revoked_at = NULL;

  RETURN jsonb_build_object('client_id', v_row.client_id, 'categories', to_jsonb(v_categories));
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_connection_grant_update(p_client_id uuid, p_categories text[])
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_categories text[] := public._ai_connection_categories(p_categories);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.ai_connection_grants
     SET categories = v_categories, updated_at = now()
   WHERE user_id = v_uid AND client_id = p_client_id AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object('client_id', p_client_id, 'categories', to_jsonb(v_categories));
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_connection_grant_revoke(p_client_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_SIGNED_IN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.ai_connection_grants
     SET categories = '{}', revoked_at = COALESCE(revoked_at, now()), updated_at = now()
   WHERE user_id = v_uid AND client_id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object('client_id', p_client_id, 'revoked', true);
END;
$$;

REVOKE ALL ON FUNCTION public._ai_connection_categories(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._ai_connection_redirect_host(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_connection_authorization_info(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_connection_grant_from_authorization(text, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_connection_grant_update(uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_connection_grant_revoke(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_connection_authorization_info(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_connection_grant_from_authorization(text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_connection_grant_update(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_connection_grant_revoke(uuid) TO authenticated;

-- Self-check: effects, not migration rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ai_connection_grants' AND relrowsecurity) THEN
    RAISE EXCEPTION 'VTID-05133 self-check: ai_connection_grants missing or RLS off';
  END IF;
  IF has_function_privilege('anon', 'public.ai_connection_grant_from_authorization(text, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05133 self-check: anon can execute ai_connection_grant_from_authorization';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_connection_grants', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_connection_grants', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ai_connection_grants', 'DELETE') THEN
    RAISE EXCEPTION 'VTID-05133 self-check: authenticated has a direct write privilege on ai_connection_grants';
  END IF;
END $$;

COMMIT;
