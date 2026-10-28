-- VTID-05030 (Health Hub WP2 / D1): no client access to user_connections.
--
-- Found live 2026-10-10 (information_schema.role_table_grants, read-only):
--   authenticated: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--                  (incl. column SELECT/INSERT/UPDATE on access_token, refresh_token)
--   anon:          SELECT, REFERENCES, TRIGGER, TRUNCATE (incl. token columns;
--                  RLS has no anon policy, so anon saw zero rows)
--   policies:      select_own / insert_own / update_own for authenticated,
--                  ALL for service_role (20260417000000 L264-273, grant L301)
-- So a browser session could read its own OAuth tokens and forge its own
-- connection rows.
--
-- No client uses either role on this table: vitana-v1 never references
-- user_connections, and every gateway path uses the service-role client.
-- Access becomes service_role only. No column grant is re-added, so a future
-- column never needs its own GRANT to stay private.
--
-- Grants and policies only: no table, column or data change. Idempotent.
-- Applied with RUN-MIGRATION.yml only after the owner's Gate 2 approval
-- (the database is shared by staging and production).
--
-- Rollback (restores the previous client grants and policies):
--   GRANT SELECT, INSERT, UPDATE ON public.user_connections TO authenticated;
--   CREATE POLICY user_connections_insert_own ON public.user_connections
--     FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
--   CREATE POLICY user_connections_update_own ON public.user_connections
--     FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

BEGIN;

REVOKE ALL ON public.user_connections FROM anon;
REVOKE ALL ON public.user_connections FROM authenticated;

DROP POLICY IF EXISTS user_connections_insert_own ON public.user_connections;
DROP POLICY IF EXISTS user_connections_update_own ON public.user_connections;
-- user_connections_select_own stays: inert without a grant.

COMMIT;
