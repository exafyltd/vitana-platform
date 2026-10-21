-- =============================================================================
-- user_pillar_recent_activity — SQL view for G7 feedback dampening
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (G7)
-- Date: 2026-04-24
--
-- Why: the ranker must be able to ask "did this user just act on pillar X?"
-- and "did the voice ORB just plan a pillar X event?" in one cheap query.
-- Without it, the Autopilot can recommend a movement action 30 minutes after
-- the user completed one, or the Autopilot can double-book a sleep slot the
-- voice just scheduled.
--
-- View shape (per user × pillar, 5 rows per user):
--   (user_id, pillar, last_completed_at, completions_24h, completions_7d, plan_events_24h)
--
-- The pillar column reflects the canonical 5-pillar set. Pillar classification
-- is done by matching calendar_events.wellness_tags against the canonical
-- PILLAR_TAGS.<pillar> array (G1). When an event matches multiple pillars
-- (e.g. onboarding_maxina = ['onboarding','social']), it counts toward each
-- matched pillar — conservative overcount, but dampening-on-overcount is
-- exactly the behavior we want (don't recommend anything the user may have
-- already addressed today).
--
-- plan_events_24h counts events created by create_index_improvement_plan
-- (voice tool) — distinguished by source_ref_type = 'pillar_template' OR
-- metadata.plan_source = 'template'. Those are "voice just promised this"
-- events and the Autopilot should not double-book.
--
-- Idempotent: CREATE OR REPLACE VIEW.
-- =============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.user_pillar_recent_activity AS
WITH pillar_tags_lookup(pillar, tags) AS (
  VALUES
    ('nutrition', ARRAY['nutrition','meal','food-log']),
    ('hydration', ARRAY['hydration','water']),
    ('exercise',  ARRAY['movement','workout','walk','steps','exercise']),
    ('sleep',     ARRAY['sleep','rest','recovery']),
    ('mental',    ARRAY['mindfulness','mental','stress','meditation','learning','journal',
                        'social','community','meetup','invite','group','chat',
                        'leadership','connection','match'])
),
classified AS (
  SELECT
    ce.user_id,
    pt.pillar,
    ce.completion_status,
    ce.completed_at,
    ce.source_ref_type,
    ce.metadata
  FROM public.calendar_events ce
  CROSS JOIN pillar_tags_lookup pt
  WHERE ce.wellness_tags && pt.tags
)
SELECT
  c.user_id,
  c.pillar,
  MAX(c.completed_at)                                           AS last_completed_at,
  COUNT(*) FILTER (
    WHERE c.completion_status = 'completed'
      AND c.completed_at >= (NOW() - INTERVAL '24 hours')
  )                                                             AS completions_24h,
  COUNT(*) FILTER (
    WHERE c.completion_status = 'completed'
      AND c.completed_at >= (NOW() - INTERVAL '7 days')
  )                                                             AS completions_7d,
  COUNT(*) FILTER (
    WHERE c.completed_at >= (NOW() - INTERVAL '24 hours')
      AND (
        c.source_ref_type = 'pillar_template'
        OR (c.metadata ->> 'plan_source') = 'template'
      )
  )                                                             AS plan_events_24h
FROM classified c
GROUP BY c.user_id, c.pillar;

COMMENT ON VIEW public.user_pillar_recent_activity IS
  'G7: per-user-per-pillar recent activity aggregates. Drives ranker completion + voice-plan dampening + streak reinforcement. Pillar classification via PILLAR_TAGS — community tags land on Mental (G1).';

-- RLS: view inherits from calendar_events. No explicit grant needed since
-- views route the SELECT predicate through the base table's policies; the
-- gateway uses service role for ranker reads, so RLS doesn't block.
GRANT SELECT ON public.user_pillar_recent_activity TO authenticated, anon;

COMMIT;
