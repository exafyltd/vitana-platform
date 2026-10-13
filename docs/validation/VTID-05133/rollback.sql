-- VTID-05133 rollback (by hand, owner's go only). Removes the grant table and its
-- functions. Before running: switch COMMUNITY_MCP_ENABLED off (or deploy the code
-- revert) — with the table gone, every Community call fails closed (503) and
-- Commerce treats every client as "no row" (today's behaviour).
BEGIN;
DROP FUNCTION IF EXISTS public.ai_connection_grant_revoke(uuid);
DROP FUNCTION IF EXISTS public.ai_connection_grant_update(uuid, text[]);
DROP FUNCTION IF EXISTS public.ai_connection_grant_from_authorization(text, text[]);
DROP FUNCTION IF EXISTS public.ai_connection_authorization_info(text);
DROP FUNCTION IF EXISTS public._ai_connection_redirect_host(text);
DROP FUNCTION IF EXISTS public._ai_connection_categories(text[]);
DROP TABLE IF EXISTS public.ai_connection_grants;
COMMIT;
