-- VTID-05575 (mt-network-r2/matching-intent-scope-db) M1: daily_matches.scope + tenant context, backfilled per D15.
--
-- Today (vitana-v1 20251111124306:2-13) public.daily_matches has no tenant column and no scope: the nightly recompute
-- (generate-daily-matches) pools every visible profile of every community. This file adds the column the scoped recompute
-- will write, and classifies the rows that exist:
--   * scope      text NOT NULL DEFAULT 'community' CHECK (community | network)
--   * tenant_id  uuid NULL   - the community the match belongs to (set for community rows, NULL for network rows)
-- Backfill (D15): a pair that shares a real (non-platform) tenant becomes a community row of that tenant - the viewer's
-- primary tenant if it is shared, otherwise the lowest shared tenant id; a pair that shares none becomes a network row.
-- The platform tenant never counts as community context. NO unique key is added (the table has none; the
-- (tenant_id,user_id,match_date,match_type,target_id) key belongs to the platform matches_daily table, not this one).
-- The DEFAULT stays: today's writer sends neither column and keeps working until matching-discover-scope-v1 ships.
-- Rows are 24-hour matches (expires_at); the backfill only labels them.
--
-- Dark: nothing reads the columns before the write guard (20261102053100) and the scoped recompute. Expand only.
-- Safe to re-run. If daily_matches is absent (a stack without the v1 schema) the file does nothing.
-- Rollback: docs/validation/VTID-05575/rollback-053000-daily-matches-scope.sql
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (mt-network-r2 rows; the queue row is added with the platform follow-up).

-- impact-allow-solo-migration: expand only (two columns, one index, a label backfill); nothing reads them before the guard file.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $mig$
BEGIN
  IF to_regclass('public.daily_matches') IS NULL THEN
    RAISE NOTICE 'VTID-05575: public.daily_matches is absent; scope columns skipped';
    RETURN;
  END IF;

  ALTER TABLE public.daily_matches
    ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'community',
    ADD COLUMN IF NOT EXISTS tenant_id uuid;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.daily_matches'::regclass AND conname = 'daily_matches_scope_check') THEN
    ALTER TABLE public.daily_matches
      ADD CONSTRAINT daily_matches_scope_check CHECK (scope IN ('community', 'network'));
  END IF;

  CREATE INDEX IF NOT EXISTS idx_daily_matches_scope_tenant ON public.daily_matches (scope, tenant_id);

  -- D15 backfill. Only rows still unclassified (tenant_id IS NULL and scope still the column default 'community') are
  -- touched, so a re-run never overwrites a row a scoped writer has already stamped (a network row, or a community row
  -- with its tenant). Step 1 stamps the shared tenant; step 2 labels what is left (no shared tenant) as network.
  IF to_regclass('public.user_tenants') IS NOT NULL AND to_regclass('public.tenants') IS NOT NULL THEN
    UPDATE public.daily_matches dm
       SET tenant_id = s.tenant_id
      FROM (
        SELECT m.id,
               (SELECT a.tenant_id
                  FROM public.user_tenants a
                  JOIN public.user_tenants b ON b.tenant_id = a.tenant_id AND b.user_id = m.matched_user_id
                 WHERE a.user_id = m.user_id
                   AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.tenant_id = a.tenant_id AND t.is_platform)
                 ORDER BY a.is_primary DESC, a.tenant_id
                 LIMIT 1) AS tenant_id
          FROM public.daily_matches m
         WHERE m.tenant_id IS NULL AND m.scope = 'community'
      ) s
     WHERE dm.id = s.id AND s.tenant_id IS NOT NULL;

    UPDATE public.daily_matches
       SET scope = 'network'
     WHERE tenant_id IS NULL AND scope = 'community';
  END IF;
END
$mig$;

COMMIT;
