-- D7 local-heroes weekly leaderboard (VTID-DANCE-D7)
-- City-scoped weekly leaderboard fed by user_reputation. Surfaces top
-- contributors per city for organic discovery + cold-start social proof.

CREATE OR REPLACE VIEW public.local_heroes_weekly AS
SELECT
  COALESCE(p.city, 'Unknown') AS city,
  ur.vitana_id,
  ur.user_id,
  p.display_name,
  p.avatar_url,
  ur.completed_count,
  ur.avg_rating,
  ur.ratings_count,
  ur.last_active_at,
  rank() OVER (
    PARTITION BY COALESCE(p.city, 'Unknown')
    ORDER BY ur.completed_count DESC,
             ur.avg_rating DESC NULLS LAST,
             ur.last_active_at DESC NULLS LAST
  ) AS city_rank
FROM public.user_reputation ur
JOIN public.profiles p USING (user_id)
WHERE ur.last_active_at > now() - interval '14 days'
   OR ur.completed_count > 0;

COMMENT ON VIEW public.local_heroes_weekly IS
  'D7: per-city ranking of active community members by completed_count + avg_rating + recency. Read by Command Hub tile + community feed.';
