-- =============================================================================
-- BOOTSTRAP-HISTORY-AWARE-TIMELINE: Widen user_activity_log + profiler plumbing
-- Date: 2026-04-20
--
-- Task 1 (timeline fix):
--   - The existing CHECK constraint on user_activity_log.activity_type only
--     allows 16 values, but the frontend hooks (useCommunityLogger,
--     useHealthLogger, useActivityLogger, etc.) write 60+ types. All writes
--     outside the 16 fail silently, so the timeline is missing most activity.
--   - Replace the enum allowlist with a permissive regex so new types onboard
--     without future migrations.
--   - Add a `source` column so we can distinguish frontend writes from backend
--     projections (Task 1 Phase 2).
--   - Add a composite index (user_id, activity_type, created_at DESC) for the
--     UserContextProfiler's grouped-by-prefix queries.
--
-- Task 2 (profiler plumbing):
--   - Add a tiny `user_profiler_version` counter table. The tail-projector
--     bumps this on every user activity insert; the profiler cache keys on
--     (user_id, version) so it can invalidate cheaply without TTL-only eviction.
--
-- Rollback:
--   ALTER TABLE public.user_activity_log DROP CONSTRAINT chk_activity_type;
--   ALTER TABLE public.user_activity_log ADD CONSTRAINT chk_activity_type
--     CHECK (activity_type IN (
--       'chat.message',
--       'memory.create', 'memory.update', 'memory.delete', 'memory.promote',
--       'wallet.transfer', 'wallet.exchange',
--       'discover.view', 'discover.like', 'discover.match',
--       'calendar.create', 'calendar.update', 'calendar.respond'
--     ));
--   ALTER TABLE public.user_activity_log DROP COLUMN IF EXISTS source;
--   DROP INDEX IF EXISTS public.idx_ual_user_type_created;
--   DROP TABLE IF EXISTS public.user_profiler_version;
-- =============================================================================

BEGIN;

-- 1. Widen the activity_type CHECK constraint ----------------------------------
ALTER TABLE public.user_activity_log
  DROP CONSTRAINT IF EXISTS chk_activity_type;

ALTER TABLE public.user_activity_log
  ADD CONSTRAINT chk_activity_type
  CHECK (activity_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$');

-- 2. Add provenance column -----------------------------------------------------
ALTER TABLE public.user_activity_log
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'frontend';

COMMENT ON COLUMN public.user_activity_log.source IS
  'Provenance: frontend | projector:oasis_events | projector:diary | projector:reco | projector:orb';

-- 3. Profiler-friendly composite index -----------------------------------------
CREATE INDEX IF NOT EXISTS idx_ual_user_type_created
  ON public.user_activity_log (user_id, activity_type, created_at DESC);

-- 4. Profiler cache version counter --------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_profiler_version (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_profiler_version ENABLE ROW LEVEL SECURITY;

-- Self-read policy; writes happen from service-role key in gateway
CREATE POLICY "user_profiler_version_self_read"
  ON public.user_profiler_version FOR SELECT
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.user_profiler_version IS
  'BOOTSTRAP-HISTORY-AWARE-TIMELINE: bumped by timeline-projector on user activity writes; read by UserContextProfiler to invalidate in-proc cache.';

-- 5. Increment RPC (service-role caller bumps, frontend reads) -----------------
CREATE OR REPLACE FUNCTION public.bump_user_profiler_version(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_version bigint;
BEGIN
  INSERT INTO public.user_profiler_version (user_id, version, updated_at)
  VALUES (p_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE
    SET version = public.user_profiler_version.version + 1,
        updated_at = now()
  RETURNING version INTO v_version;
  RETURN v_version;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bump_user_profiler_version(uuid) TO service_role;

COMMIT;
