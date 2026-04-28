-- Dance specialized market — Phase D1.4 (VTID-DANCE-D1)
-- Cross-tenant reputation keyed by vitana_id (the canonical spine from
-- Part 1). Lets a teacher's earned ratings move with them across tenants.

CREATE TABLE IF NOT EXISTS public.user_reputation (
  vitana_id           text PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  completed_count     int NOT NULL DEFAULT 0,
  avg_rating          numeric(3,2),
  ratings_count       int NOT NULL DEFAULT 0,
  response_time_p50_s int,
  last_active_at      timestamptz,
  trust_tier          text NOT NULL DEFAULT 'unverified'
                       CHECK (trust_tier IN ('unverified','community_verified','pro_verified','id_verified')),
  id_verified_at      timestamptz,
  id_verified_by      text,    -- 'manual_admin' | 'persona' | 'onfido'
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_reputation_user_idx ON public.user_reputation (user_id);
CREATE INDEX IF NOT EXISTS user_reputation_tier_active_idx ON public.user_reputation (trust_tier, last_active_at DESC);

COMMENT ON TABLE public.user_reputation IS
  'Reputation aggregate keyed by vitana_id (cross-tenant portable). Recomputed daily by compute_user_reputation_daily(). trust_tier is orthogonal to subscription tier (free user can be id_verified).';

-- Per-rating ledger. One row per completed interaction that was rated.
CREATE TABLE IF NOT EXISTS public.user_ratings (
  rating_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rater_vitana_id    text NOT NULL,
  ratee_vitana_id    text NOT NULL,
  match_id           uuid REFERENCES public.intent_matches(match_id) ON DELETE SET NULL,
  event_ref          jsonb,        -- { kind: 'live_room', id: '<uuid>' } when not a peer match
  stars              int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rater_vitana_id, ratee_vitana_id, match_id)
);

CREATE INDEX IF NOT EXISTS user_ratings_ratee_idx ON public.user_ratings (ratee_vitana_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_ratings_rater_idx ON public.user_ratings (rater_vitana_id, created_at DESC);

COMMENT ON TABLE public.user_ratings IS
  'Append-only rating ledger. One row per rated interaction. Aggregated into user_reputation by daily cron.';
