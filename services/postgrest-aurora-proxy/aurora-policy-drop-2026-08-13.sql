-- 6 RLS policies forming genuine cross-table dependency cycles that block
-- DMS's plain DROP TABLE (DROP_AND_CREATE prep mode) on their target tables,
-- surfaced after the 245 FK drops and 20 view drops (VTID-03619, same day).
--
-- Two distinct cases, both confirmed live via pg_depend/pg_policies:
--   1. global_community_events <-> event_co_creators: each table's own
--      policies reference the OTHER table in a subquery, so whichever one
--      DMS tries to drop first fails while the other still exists -- a
--      genuine cycle no amount of retrying resolves on its own.
--   2. memberships <- user_intents: user_intents' read policies subquery
--      memberships for tenant/active-membership checks, blocking
--      memberships' drop as long as user_intents (already recreated by
--      DMS) still carries the old policy referencing it.
--
-- Reversible via aurora-policy-restore-2026-08-13.sql, captured verbatim
-- from pg_policies before the drop.

DROP POLICY IF EXISTS "user_intents_public_read" ON public.user_intents;
DROP POLICY IF EXISTS "user_intents_tenant_read" ON public.user_intents;
DROP POLICY IF EXISTS "Community users can delete events they created or co-create" ON public.global_community_events;
DROP POLICY IF EXISTS "Community users can update events they created or co-create" ON public.global_community_events;
DROP POLICY IF EXISTS "Event creators can add co-creators" ON public.event_co_creators;
DROP POLICY IF EXISTS "Event creators can remove co-creators" ON public.event_co_creators;
