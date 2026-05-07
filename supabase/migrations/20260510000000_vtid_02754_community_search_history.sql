-- VTID-02754 — Voice Tool Expansion P1b: Community Member Search history.
--
-- Backs the find_community_member voice tool. Each call writes one row so
-- the frontend "How we searched" card on PublicProfilePage can fetch the
-- structured match_recipe by search_id without re-running the ranker.
--
-- Lifecycle:
--   1. POST /api/v1/community/find-member writes a row.
--   2. GET  /api/v1/community/find-member/recipe/:search_id reads it
--      (RLS: only the searcher can read their own searches).
--   3. pg_cron prunes rows older than 30 days, mirroring the
--      oasis_events_info_retention pattern.

CREATE TABLE IF NOT EXISTS public.community_search_history (
  search_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  viewer_vitana_id   text,
  tenant_id          uuid NOT NULL,
  query              text NOT NULL,
  query_hash         text NOT NULL,
  tier               smallint NOT NULL CHECK (tier BETWEEN 1 AND 4),
  lane               text NOT NULL,
  winner_user_id     uuid,
  winner_vitana_id   text,
  recipe_json        jsonb NOT NULL,
  excluded_vitana_ids text[] NOT NULL DEFAULT '{}'::text[],
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.community_search_history IS
  'VTID-02754 — one row per find_community_member tool call. Frontend reads recipe_json by search_id to render the "How we searched" card on the redirected profile page. 30-day TTL.';

CREATE INDEX IF NOT EXISTS community_search_history_viewer_idx
  ON public.community_search_history (viewer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS community_search_history_created_at_idx
  ON public.community_search_history (created_at);

ALTER TABLE public.community_search_history ENABLE ROW LEVEL SECURITY;

-- The searcher can read their own searches; service role bypasses RLS for writes.
DROP POLICY IF EXISTS community_search_history_self_read ON public.community_search_history;
CREATE POLICY community_search_history_self_read
  ON public.community_search_history
  FOR SELECT
  USING (auth.uid() = viewer_user_id);

-- Daily TTL cleanup: drop rows older than 30 days. Mirrors
-- oasis-events-info-retention pattern. No-op if pg_cron isn't available
-- (the gateway will still function; rows just won't auto-prune).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'community-search-history-retention',
      '15 4 * * *',
      $$DELETE FROM public.community_search_history WHERE created_at < now() - interval '30 days'$$
    );
  END IF;
END $$;
