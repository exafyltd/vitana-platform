-- VTID-04968 — which AI assistant holds a delegated token.
--
-- The gateway approves an OAuth client for the Commerce MCP by the hosts of the
-- redirect URIs it registered (Supabase registers clients dynamically, so the
-- client_id changes per connection). This returns just that, read from Supabase
-- Auth's own client table. Depends on auth.oauth_clients (client_name,
-- redirect_uris, deleted_at): re-verify after a Supabase Auth upgrade. If the
-- columns change the function errors and the gateway refuses the client (fail
-- closed). Read-only; callable by the gateway's service role only.
CREATE OR REPLACE FUNCTION public.mcp_oauth_client_info(p_client_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = auth, public
AS $$
    SELECT jsonb_build_object(
        'client_name', c.client_name,
        'client_uri', c.client_uri,
        'redirect_uris', c.redirect_uris
    )
    FROM auth.oauth_clients c
    WHERE c.id = p_client_id AND c.deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.mcp_oauth_client_info(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_oauth_client_info(UUID) TO service_role;
