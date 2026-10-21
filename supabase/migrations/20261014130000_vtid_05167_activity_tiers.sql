-- =============================================================================
-- VTID-05167 — Life Timeline P1: classify user_activity_log (tier / category /
-- topic / pillar), stop showing internal telemetry, schedule the archive.
-- Sparring record: docs/validation/VTID-05167/plan-sparring.md
-- (plan hash 535ddb70…2b04, CONVERGED, owner-approved 2026-10-13).
--
-- What this does
--   1. user_activity_log gets pillar, secondary_pillar, category, topic, tier,
--      hidden_from_ai, hidden_at. The archive table gets the same columns plus
--      the `source` column it never received (20260420120000 added it to the
--      main table only), and its 13-value activity_type allowlist is widened to
--      the same regex the main table uses — otherwise archiving a page.view row
--      would fail.
--   2. public.activity_catalog: one row per activity type or prefix, seeded
--      from services/gateway/src/services/timeline/timeline-catalog.json (the
--      block between the GENERATED markers is produced by
--      scripts/timeline/generate-activity-catalog-seed.mjs; a Jest parity test
--      fails if it drifts). Read-only reference data for authenticated users.
--   3. activity_catalog_lookup(type): exact match, else the longest matching
--      prefix, else NULL (the caller applies the default: silent).
--   4. BEFORE INSERT trigger classify_activity(): fills only the fields the
--      writer left NULL. The gateway may send them; frontend writers do not.
--   5. backfill_activity_tiers(batch): classifies existing rows newest first,
--      UPDATE only, never deletes; pg_cron runs it every minute until no
--      unclassified row is left, then it unschedules itself. Readers treat a
--      NULL tier as silent until then.
--   6. archive_old_activity_logs(): explicit column list; archives only
--      silent/system rows older than 180 days; spotlight/moment/digest rows
--      stay until the member deletes them. Scheduled daily. EXECUTE revoked
--      from public/anon/authenticated (it is SECURITY DEFINER).
--   7. Indexes for the timeline reader: (user_id, tier, created_at desc) and
--      (user_id, pillar, created_at desc) where pillar is not null.
--   pg_cron jobs are created only where the extension exists (Supabase); a
--   throwaway Postgres or Aurora without it skips them.
--
-- Rollback
--   SELECT cron.unschedule('activity-tiers-backfill'); SELECT cron.unschedule('activity-log-archive-daily');
--   DROP TRIGGER IF EXISTS trg_classify_activity ON public.user_activity_log;
--   DROP FUNCTION IF EXISTS public.classify_activity(), public.backfill_activity_tiers(int),
--     public.activity_catalog_lookup(text);
--   DROP TABLE IF EXISTS public.activity_catalog;
--   DROP INDEX IF EXISTS public.idx_ual_user_tier_created, public.idx_ual_user_pillar_created;
--   (columns can stay; they are nullable/defaulted and unread by older code)
-- =============================================================================

BEGIN;

-- 1. Columns ------------------------------------------------------------------
ALTER TABLE public.user_activity_log
  ADD COLUMN IF NOT EXISTS pillar           text,
  ADD COLUMN IF NOT EXISTS secondary_pillar text,
  ADD COLUMN IF NOT EXISTS category         text,
  ADD COLUMN IF NOT EXISTS topic            text,
  ADD COLUMN IF NOT EXISTS tier             text,
  ADD COLUMN IF NOT EXISTS hidden_from_ai   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at        timestamptz;

ALTER TABLE public.user_activity_log_archive
  ADD COLUMN IF NOT EXISTS source           text NOT NULL DEFAULT 'frontend',
  ADD COLUMN IF NOT EXISTS actor_vitana_id  text,
  ADD COLUMN IF NOT EXISTS pillar           text,
  ADD COLUMN IF NOT EXISTS secondary_pillar text,
  ADD COLUMN IF NOT EXISTS category         text,
  ADD COLUMN IF NOT EXISTS topic            text,
  ADD COLUMN IF NOT EXISTS tier             text,
  ADD COLUMN IF NOT EXISTS hidden_from_ai   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at        timestamptz;

ALTER TABLE public.user_activity_log DROP CONSTRAINT IF EXISTS chk_ual_tier;
ALTER TABLE public.user_activity_log ADD CONSTRAINT chk_ual_tier
  CHECK (tier IS NULL OR tier IN ('spotlight','moment','digest','silent','system'));
ALTER TABLE public.user_activity_log DROP CONSTRAINT IF EXISTS chk_ual_pillar;
ALTER TABLE public.user_activity_log ADD CONSTRAINT chk_ual_pillar
  CHECK ((pillar IS NULL OR pillar IN ('nutrition','hydration','exercise','sleep','mental'))
     AND (secondary_pillar IS NULL OR secondary_pillar IN ('nutrition','hydration','exercise','sleep','mental')));

ALTER TABLE public.user_activity_log_archive DROP CONSTRAINT IF EXISTS chk_activity_type;
ALTER TABLE public.user_activity_log_archive ADD CONSTRAINT chk_activity_type
  CHECK (activity_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$');

COMMENT ON COLUMN public.user_activity_log.tier IS
  'VTID-05167: spotlight | moment | digest | silent | system (timeline-catalog.json). NULL = not yet classified, read as silent.';
COMMENT ON COLUMN public.user_activity_log.hidden_from_ai IS
  'VTID-05167: the member hid this entry from Vitana; context readers must skip it.';

-- 2. Catalog ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activity_catalog (
  activity_type    text PRIMARY KEY,
  match            text NOT NULL CHECK (match IN ('exact','prefix')),
  tier             text NOT NULL CHECK (tier IN ('spotlight','moment','digest','silent','system')),
  category         text NOT NULL,
  topic            text NOT NULL,
  pillar           text CHECK (pillar IS NULL OR pillar IN ('nutrition','hydration','exercise','sleep','mental')),
  secondary_pillar text CHECK (secondary_pillar IS NULL OR secondary_pillar IN ('nutrition','hydration','exercise','sleep','mental')),
  icon             text NOT NULL,
  sensitivity      text NOT NULL DEFAULT 'standard' CHECK (sensitivity IN ('standard','special_category')),
  summary_key      text NOT NULL,
  params           text[] NOT NULL DEFAULT '{}',
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.activity_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS activity_catalog_read ON public.activity_catalog;
CREATE POLICY activity_catalog_read ON public.activity_catalog FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.activity_catalog FROM anon, authenticated;
GRANT SELECT ON public.activity_catalog TO authenticated;

COMMENT ON TABLE public.activity_catalog IS
  'VTID-05167: timeline catalog (reference data). Source of truth: services/gateway/src/services/timeline/timeline-catalog.json. Change the JSON and ship a migration with the regenerated seed.';

-- BEGIN GENERATED activity_catalog seed (scripts/timeline/generate-activity-catalog-seed.mjs)
INSERT INTO public.activity_catalog
  (activity_type, match, tier, category, topic, pillar, secondary_pillar, icon, sensitivity, summary_key, params)
VALUES
  ('index.movement.recorded', 'exact', 'spotlight', 'index', 'index_changed', NULL, NULL, 'Gauge', 'standard', 'timeline.summary.index_movement_recorded', ARRAY['delta_total', 'score_total', 'top_pillar', 'top_pillar_delta', 'trigger']::text[]),
  ('index.tier.reached', 'exact', 'spotlight', 'index', 'tier_reached', NULL, NULL, 'Award', 'standard', 'timeline.summary.index_tier_reached', ARRAY['tier', 'score_total']::text[]),
  ('index.balance.changed', 'exact', 'spotlight', 'index', 'balance_changed', NULL, NULL, 'Scale', 'standard', 'timeline.summary.index_balance_changed', ARRAY['balance_factor', 'weakest_pillar']::text[]),
  ('index.pillar.streak', 'exact', 'spotlight', 'index', 'pillar_streak', NULL, NULL, 'Flame', 'standard', 'timeline.summary.index_pillar_streak', ARRAY['pillar', 'streak_days']::text[]),
  ('index.pillar.slipping', 'exact', 'spotlight', 'index', 'pillar_slipping', NULL, NULL, 'TrendingDown', 'standard', 'timeline.summary.index_pillar_slipping', ARRAY['pillar']::text[]),
  ('index.pillar.recovered', 'exact', 'spotlight', 'index', 'pillar_recovered', NULL, NULL, 'TrendingUp', 'standard', 'timeline.summary.index_pillar_recovered', ARRAY['pillar']::text[]),
  ('index.baseline.completed', 'exact', 'spotlight', 'index', 'baseline_completed', NULL, NULL, 'ClipboardCheck', 'standard', 'timeline.summary.index_baseline_completed', ARRAY['score_total']::text[]),
  ('index.plan.created', 'exact', 'spotlight', 'index', 'plan_created', NULL, NULL, 'ListChecks', 'standard', 'timeline.summary.index_plan_created', ARRAY['pillar']::text[]),
  ('index.insight.noticed', 'exact', 'spotlight', 'index', 'vitana_noticed', NULL, NULL, 'Sparkles', 'standard', 'timeline.summary.index_insight_noticed', ARRAY['insight_kind', 'pillar']::text[]),
  ('health.log.meal', 'exact', 'moment', 'nutrition', 'meal_logged', 'nutrition', NULL, 'Apple', 'standard', 'timeline.summary.health_log_meal', ARRAY['via']::text[]),
  ('health.log.water', 'exact', 'moment', 'hydration', 'water_logged', 'hydration', NULL, 'Droplets', 'standard', 'timeline.summary.health_log_water', ARRAY['via', 'amount_ml']::text[]),
  ('health.log.exercise', 'exact', 'moment', 'exercise', 'workout_logged', 'exercise', NULL, 'Dumbbell', 'standard', 'timeline.summary.health_log_exercise', ARRAY['via', 'minutes', 'activity']::text[]),
  ('health.log.sleep', 'exact', 'moment', 'sleep', 'sleep_logged', 'sleep', NULL, 'Moon', 'standard', 'timeline.summary.health_log_sleep', ARRAY['via', 'hours']::text[]),
  ('health.log.meditation', 'exact', 'moment', 'mental', 'meditation_logged', 'mental', NULL, 'Brain', 'standard', 'timeline.summary.health_log_meditation', ARRAY['via', 'minutes']::text[]),
  ('health.log.mood', 'exact', 'moment', 'mental', 'mood_checkin', 'mental', NULL, 'Smile', 'special_category', 'timeline.summary.health_log_mood', ARRAY['via']::text[]),
  ('health.log.stress', 'exact', 'moment', 'mental', 'stress_logged', 'mental', NULL, 'Activity', 'special_category', 'timeline.summary.health_log_stress', ARRAY['via']::text[]),
  ('health.wearable_features.bridged', 'exact', 'moment', 'cross_pillar', 'wearable_sync', NULL, NULL, 'Watch', 'standard', 'timeline.summary.health_wearable_features_bridged', ARRAY['providers', 'days']::text[]),
  ('health.wearable_features.bridge_failed', 'exact', 'system', 'system', 'telemetry', NULL, NULL, 'Cog', 'standard', 'timeline.summary.health_wearable_features_bridge_failed', '{}'::text[]),
  ('health.daily.recomputed', 'exact', 'system', 'system', 'telemetry', NULL, NULL, 'Cog', 'standard', 'timeline.summary.health_daily_recomputed', '{}'::text[]),
  ('health.biomarker.upload_pdf', 'exact', 'moment', 'cross_pillar', 'lab_result_uploaded', NULL, NULL, 'FlaskConical', 'special_category', 'timeline.summary.health_biomarker_upload_pdf', '{}'::text[]),
  ('health.biomarker.upload_manual', 'exact', 'moment', 'cross_pillar', 'lab_result_uploaded', NULL, NULL, 'FlaskConical', 'special_category', 'timeline.summary.health_biomarker_upload_manual', '{}'::text[]),
  ('health.biomarker.upload_device', 'exact', 'moment', 'cross_pillar', 'lab_result_uploaded', NULL, NULL, 'FlaskConical', 'special_category', 'timeline.summary.health_biomarker_upload_device', '{}'::text[]),
  ('health.biomarker.connect_device', 'exact', 'moment', 'cross_pillar', 'device_connected', NULL, NULL, 'Watch', 'standard', 'timeline.summary.health_biomarker_connect_device', '{}'::text[]),
  ('health.biomarker.order_test', 'exact', 'moment', 'cross_pillar', 'lab_test_ordered', NULL, NULL, 'FlaskConical', 'special_category', 'timeline.summary.health_biomarker_order_test', '{}'::text[]),
  ('health.biomarker.share', 'exact', 'digest', 'cross_pillar', 'lab_result_shared', NULL, NULL, 'Share2', 'special_category', 'timeline.summary.health_biomarker_share', '{}'::text[]),
  ('health.biomarker.view', 'exact', 'silent', 'app_usage', 'screen_visited', NULL, NULL, 'Eye', 'special_category', 'timeline.summary.health_biomarker_view', '{}'::text[]),
  ('health.biomarker.download', 'exact', 'silent', 'app_usage', 'screen_visited', NULL, NULL, 'Eye', 'special_category', 'timeline.summary.health_biomarker_download', '{}'::text[]),
  ('health.lab_report.upload', 'exact', 'moment', 'cross_pillar', 'lab_result_uploaded', NULL, NULL, 'FlaskConical', 'special_category', 'timeline.summary.health_lab_report_upload', '{}'::text[]),
  ('health.lab_report.export', 'exact', 'silent', 'app_usage', 'export', NULL, NULL, 'Download', 'special_category', 'timeline.summary.health_lab_report_export', '{}'::text[]),
  ('health.omics.upload', 'exact', 'moment', 'cross_pillar', 'lab_result_uploaded', NULL, NULL, 'Dna', 'special_category', 'timeline.summary.health_omics_upload', '{}'::text[]),
  ('health.omics.connect_api', 'exact', 'moment', 'cross_pillar', 'device_connected', NULL, NULL, 'Dna', 'standard', 'timeline.summary.health_omics_connect_api', '{}'::text[]),
  ('health.omics.view', 'exact', 'silent', 'app_usage', 'screen_visited', NULL, NULL, 'Eye', 'special_category', 'timeline.summary.health_omics_view', '{}'::text[]),
  ('health.supplement.add', 'exact', 'moment', 'nutrition', 'supplement_logged', 'nutrition', NULL, 'Pill', 'special_category', 'timeline.summary.health_supplement_add', '{}'::text[]),
  ('health.supplement.update', 'exact', 'digest', 'nutrition', 'supplement_logged', 'nutrition', NULL, 'Pill', 'special_category', 'timeline.summary.health_supplement_update', '{}'::text[]),
  ('health.supplement.delete', 'exact', 'silent', 'nutrition', 'supplement_logged', 'nutrition', NULL, 'Pill', 'special_category', 'timeline.summary.health_supplement_delete', '{}'::text[]),
  ('health.', 'prefix', 'silent', 'cross_pillar', 'health_other', NULL, NULL, 'HeartPulse', 'special_category', 'timeline.summary.generic_cross_pillar', '{}'::text[]),
  ('diary.create', 'exact', 'moment', 'diary', 'diary_entry', NULL, 'mental', 'BookOpen', 'standard', 'timeline.summary.diary_create', ARRAY['entry_type']::text[]),
  ('diary.', 'prefix', 'silent', 'diary', 'diary_other', NULL, NULL, 'BookOpen', 'standard', 'timeline.summary.generic_diary', '{}'::text[]),
  ('memory.create', 'exact', 'moment', 'vitana', 'vitana_remembered', NULL, NULL, 'Sparkles', 'standard', 'timeline.summary.memory_create', '{}'::text[]),
  ('memory.promote', 'exact', 'moment', 'diary', 'saved_to_knowledge', NULL, NULL, 'BookmarkPlus', 'standard', 'timeline.summary.memory_promote', '{}'::text[]),
  ('memory.update', 'exact', 'digest', 'vitana', 'vitana_remembered', NULL, NULL, 'Sparkles', 'standard', 'timeline.summary.memory_update', '{}'::text[]),
  ('memory.delete', 'exact', 'silent', 'vitana', 'forget', NULL, NULL, 'Trash2', 'standard', 'timeline.summary.memory_delete', '{}'::text[]),
  ('memory.forget', 'exact', 'moment', 'vitana', 'forget', NULL, NULL, 'Eraser', 'standard', 'timeline.summary.memory_forget', '{}'::text[]),
  ('memory.identity.', 'prefix', 'system', 'system', 'telemetry', NULL, NULL, 'Cog', 'standard', 'timeline.summary.generic_system', '{}'::text[]),
  ('memory.', 'prefix', 'silent', 'vitana', 'memory_other', NULL, NULL, 'Sparkles', 'standard', 'timeline.summary.generic_vitana', '{}'::text[]),
  ('life_compass.set', 'exact', 'moment', 'goals', 'life_compass_set', NULL, NULL, 'Compass', 'standard', 'timeline.summary.life_compass_set', ARRAY['goal']::text[]),
  ('goal.create', 'exact', 'moment', 'goals', 'goal_created', NULL, NULL, 'Target', 'standard', 'timeline.summary.goal_create', '{}'::text[]),
  ('goal.subgoal.complete', 'exact', 'moment', 'goals', 'subgoal_done', NULL, NULL, 'CheckCircle2', 'standard', 'timeline.summary.goal_subgoal_complete', '{}'::text[]),
  ('goal.milestone', 'exact', 'moment', 'goals', 'milestone', NULL, NULL, 'Trophy', 'standard', 'timeline.summary.goal_milestone', '{}'::text[]),
  ('journey.step.complete', 'exact', 'moment', 'journey', 'journey_step', NULL, NULL, 'Route', 'standard', 'timeline.summary.journey_step_complete', '{}'::text[]),
  ('journey.session.listened', 'exact', 'moment', 'cross_pillar', 'journey_session', NULL, NULL, 'Headphones', 'standard', 'timeline.summary.journey_session_listened', ARRAY['topic']::text[]),
  ('journey.audiobook.finish', 'exact', 'moment', 'journey', 'audiobook_finished', NULL, NULL, 'Headphones', 'standard', 'timeline.summary.journey_audiobook_finish', '{}'::text[]),
  ('journey.', 'prefix', 'digest', 'journey', 'journey_other', NULL, NULL, 'Route', 'standard', 'timeline.summary.generic_journey', '{}'::text[]),
  ('orb.session.summary', 'exact', 'moment', 'vitana', 'conversation', NULL, NULL, 'MessageCircle', 'standard', 'timeline.summary.orb_session_summary', ARRAY['summary']::text[]),
  ('orb.session.start', 'exact', 'silent', 'vitana', 'assistant_turn', NULL, NULL, 'MessageCircle', 'standard', 'timeline.summary.orb_session_start', '{}'::text[]),
  ('orb.session.stop', 'exact', 'silent', 'vitana', 'assistant_turn', NULL, NULL, 'MessageCircle', 'standard', 'timeline.summary.orb_session_stop', '{}'::text[]),
  ('orb.turn.', 'prefix', 'silent', 'vitana', 'assistant_turn', NULL, NULL, 'MessageCircle', 'standard', 'timeline.summary.generic_vitana', '{}'::text[]),
  ('orb.', 'prefix', 'system', 'system', 'telemetry', NULL, NULL, 'Cog', 'standard', 'timeline.summary.generic_system', '{}'::text[]),
  ('vtid.', 'prefix', 'system', 'system', 'telemetry', NULL, NULL, 'Cog', 'standard', 'timeline.summary.generic_system', '{}'::text[]),
  ('chat.message', 'exact', 'silent', 'vitana', 'assistant_turn', NULL, NULL, 'MessageCircle', 'standard', 'timeline.summary.chat_message', '{}'::text[]),
  ('autopilot.action.execute', 'exact', 'moment', 'vitana', 'recommendation_accepted', NULL, NULL, 'ThumbsUp', 'standard', 'timeline.summary.autopilot_action_execute', '{}'::text[]),
  ('autopilot.action.dismiss', 'exact', 'digest', 'vitana', 'recommendation_dismissed', NULL, NULL, 'X', 'standard', 'timeline.summary.autopilot_action_dismiss', '{}'::text[]),
  ('autopilot.action.snooze', 'exact', 'digest', 'vitana', 'recommendation_dismissed', NULL, NULL, 'Clock', 'standard', 'timeline.summary.autopilot_action_snooze', '{}'::text[]),
  ('autopilot.', 'prefix', 'silent', 'vitana', 'recommendation_other', NULL, NULL, 'Sparkles', 'standard', 'timeline.summary.generic_vitana', '{}'::text[]),
  ('recommendation.interaction.', 'prefix', 'digest', 'vitana', 'recommendation_other', NULL, NULL, 'Sparkles', 'standard', 'timeline.summary.generic_vitana', '{}'::text[]),
  ('recommendation.', 'prefix', 'silent', 'vitana', 'recommendation_other', NULL, NULL, 'Sparkles', 'standard', 'timeline.summary.generic_vitana', '{}'::text[]),
  ('reminder.create', 'exact', 'moment', 'vitana', 'reminder_created', NULL, NULL, 'Bell', 'standard', 'timeline.summary.reminder_create', '{}'::text[]),
  ('task.create', 'exact', 'moment', 'goals', 'task_created', NULL, NULL, 'ListPlus', 'standard', 'timeline.summary.task_create', '{}'::text[]),
  ('task.complete', 'exact', 'moment', 'goals', 'task_done', NULL, NULL, 'CheckCircle2', 'standard', 'timeline.summary.task_complete', '{}'::text[]),
  ('task.approve', 'exact', 'digest', 'goals', 'task_other', NULL, NULL, 'Check', 'standard', 'timeline.summary.task_approve', '{}'::text[]),
  ('task.reject', 'exact', 'digest', 'goals', 'task_other', NULL, NULL, 'X', 'standard', 'timeline.summary.task_reject', '{}'::text[]),
  ('task.', 'prefix', 'silent', 'goals', 'task_other', NULL, NULL, 'ListChecks', 'standard', 'timeline.summary.generic_goals', '{}'::text[]),
  ('calendar.create', 'exact', 'moment', 'events', 'calendar_added', NULL, NULL, 'CalendarPlus', 'standard', 'timeline.summary.calendar_create', '{}'::text[]),
  ('calendar.respond', 'exact', 'moment', 'events', 'event_rsvp', NULL, NULL, 'CalendarCheck', 'standard', 'timeline.summary.calendar_respond', '{}'::text[]),
  ('calendar.update', 'exact', 'digest', 'events', 'calendar_other', NULL, NULL, 'Calendar', 'standard', 'timeline.summary.calendar_update', '{}'::text[]),
  ('calendar.', 'prefix', 'silent', 'events', 'calendar_other', NULL, NULL, 'Calendar', 'standard', 'timeline.summary.generic_events', '{}'::text[]),
  ('community.event.join', 'exact', 'moment', 'events', 'event_rsvp', NULL, 'mental', 'CalendarCheck', 'standard', 'timeline.summary.community_event_join', '{}'::text[]),
  ('community.event.attend', 'exact', 'moment', 'events', 'event_attended', NULL, 'mental', 'PartyPopper', 'standard', 'timeline.summary.community_event_attend', '{}'::text[]),
  ('community.event.create', 'exact', 'moment', 'events', 'event_created', NULL, 'mental', 'CalendarPlus', 'standard', 'timeline.summary.community_event_create', '{}'::text[]),
  ('community.event.leave', 'exact', 'digest', 'events', 'event_left', NULL, NULL, 'CalendarX', 'standard', 'timeline.summary.community_event_leave', '{}'::text[]),
  ('community.event.share', 'exact', 'digest', 'events', 'event_shared', NULL, NULL, 'Share2', 'standard', 'timeline.summary.community_event_share', '{}'::text[]),
  ('community.event.', 'prefix', 'silent', 'app_usage', 'screen_visited', NULL, NULL, 'Eye', 'standard', 'timeline.summary.generic_app_usage', '{}'::text[]),
  ('community.group.create', 'exact', 'moment', 'community', 'group_created', NULL, 'mental', 'Users', 'standard', 'timeline.summary.community_group_create', '{}'::text[]),
  ('community.group.join', 'exact', 'moment', 'community', 'group_joined', NULL, 'mental', 'UserPlus', 'standard', 'timeline.summary.community_group_join', '{}'::text[]),
  ('community.group.leave', 'exact', 'moment', 'community', 'group_left', NULL, NULL, 'UserMinus', 'standard', 'timeline.summary.community_group_leave', '{}'::text[]),
  ('community.group.update', 'exact', 'digest', 'community', 'group_other', NULL, NULL, 'Users', 'standard', 'timeline.summary.community_group_update', '{}'::text[]),
  ('community.group.invite', 'exact', 'digest', 'community', 'group_other', NULL, NULL, 'Send', 'standard', 'timeline.summary.community_group_invite', '{}'::text[]),
  ('community.group.', 'prefix', 'silent', 'app_usage', 'screen_visited', NULL, NULL, 'Eye', 'standard', 'timeline.summary.generic_app_usage', '{}'::text[]),
  ('community.live.create', 'exact', 'moment', 'live_media', 'live_hosted', NULL, 'mental', 'Radio', 'standard', 'timeline.summary.community_live_create', '{}'::text[]),
  ('community.live.start', 'exact', 'moment', 'live_media', 'live_hosted', NULL, 'mental', 'Radio', 'standard', 'timeline.summary.community_live_start', '{}'::text[]),
  ('community.live.join', 'exact', 'moment', 'live_media', 'live_joined', NULL, 'mental', 'Radio', 'standard', 'timeline.summary.community_live_join', '{}'::text[]),
  ('community.live.cohost_accept', 'exact', 'digest', 'live_media', 'live_other', NULL, NULL, 'Radio', 'standard', 'timeline.summary.community_live_cohost_accept', '{}'::text[]),
  ('community.live.poll_vote', 'exact', 'digest', 'live_media', 'live_other', NULL, NULL, 'BarChart3', 'standard', 'timeline.summary.community_live_poll_vote', '{}'::text[]),
  ('community.live.remind', 'exact', 'digest', 'live_media', 'live_other', NULL, NULL, 'Bell', 'standard', 'timeline.summary.community_live_remind', '{}'::text[]),
  ('community.live.', 'prefix', 'silent', 'live_media', 'live_other', NULL, NULL, 'Radio', 'standard', 'timeline.summary.generic_live_media', '{}'::text[]),
  ('community.follow', 'exact', 'moment', 'community', 'connection', NULL, 'mental', 'UserPlus', 'standard', 'timeline.summary.community_follow', '{}'::text[]),
  ('community.unfollow', 'exact', 'silent', 'community', 'connection', NULL, NULL, 'UserMinus', 'standard', 'timeline.summary.community_unfollow', '{}'::text[]),
  ('community.conversation.start', 'exact', 'moment', 'community', 'chat_started', NULL, 'mental', 'MessagesSquare', 'standard', 'timeline.summary.community_conversation_start', '{}'::text[]),
  ('community.group_chat.create', 'exact', 'moment', 'community', 'chat_started', NULL, 'mental', 'MessagesSquare', 'standard', 'timeline.summary.community_group_chat_create', '{}'::text[]),
  ('community.group_chat.join', 'exact', 'moment', 'community', 'chat_started', NULL, 'mental', 'MessagesSquare', 'standard', 'timeline.summary.community_group_chat_join', '{}'::text[]),
  ('community.message.send', 'exact', 'digest', 'community', 'message_sent', NULL, 'mental', 'Send', 'standard', 'timeline.summary.community_message_send', '{}'::text[]),
  ('community.post.create', 'exact', 'moment', 'community', 'post_published', NULL, 'mental', 'PenSquare', 'standard', 'timeline.summary.community_post_create', '{}'::text[]),
  ('community.comment.create', 'exact', 'digest', 'community', 'comment_written', NULL, 'mental', 'MessageSquare', 'standard', 'timeline.summary.community_comment_create', '{}'::text[]),
  ('community.reaction.add', 'exact', 'digest', 'community', 'reaction_given', NULL, NULL, 'Heart', 'standard', 'timeline.summary.community_reaction_add', '{}'::text[]),
  ('community.search', 'exact', 'silent', 'app_usage', 'search', NULL, NULL, 'Search', 'standard', 'timeline.summary.community_search', '{}'::text[]),
  ('community.', 'prefix', 'silent', 'app_usage', 'screen_visited', NULL, NULL, 'Eye', 'standard', 'timeline.summary.generic_app_usage', '{}'::text[]),
  ('discover.match', 'exact', 'moment', 'community', 'connection', NULL, 'mental', 'HeartHandshake', 'standard', 'timeline.summary.discover_match', '{}'::text[]),
  ('discover.like', 'exact', 'digest', 'shop', 'item_saved', NULL, NULL, 'Heart', 'standard', 'timeline.summary.discover_like', '{}'::text[]),
  ('discover.service.bookmark', 'exact', 'digest', 'shop', 'item_saved', NULL, NULL, 'Bookmark', 'standard', 'timeline.summary.discover_service_bookmark', '{}'::text[]),
  ('discover.service.share', 'exact', 'digest', 'shop', 'item_shared', NULL, NULL, 'Share2', 'standard', 'timeline.summary.discover_service_share', '{}'::text[]),
  ('discover.provider.contact', 'exact', 'moment', 'shop', 'provider_contacted', NULL, NULL, 'Phone', 'standard', 'timeline.summary.discover_provider_contact', '{}'::text[]),
  ('discover.order.placed', 'exact', 'moment', 'shop', 'order_placed', NULL, NULL, 'ShoppingBag', 'standard', 'timeline.summary.discover_order_placed', '{}'::text[]),
  ('discover.booking.created', 'exact', 'moment', 'shop', 'service_booked', NULL, NULL, 'CalendarCheck', 'standard', 'timeline.summary.discover_booking_created', '{}'::text[]),
  ('discover.', 'prefix', 'silent', 'app_usage', 'screen_visited', NULL, NULL, 'Eye', 'standard', 'timeline.summary.generic_app_usage', '{}'::text[]),
  ('media.music.play', 'exact', 'digest', 'live_media', 'music_played', NULL, NULL, 'Music', 'standard', 'timeline.summary.media_music_play', '{}'::text[]),
  ('media.', 'prefix', 'digest', 'live_media', 'media_other', NULL, NULL, 'PlayCircle', 'standard', 'timeline.summary.generic_live_media', '{}'::text[]),
  ('wallet.transfer', 'exact', 'moment', 'wallet', 'payment', NULL, NULL, 'Wallet', 'standard', 'timeline.summary.wallet_transfer', '{}'::text[]),
  ('wallet.exchange', 'exact', 'moment', 'wallet', 'payment', NULL, NULL, 'ArrowLeftRight', 'standard', 'timeline.summary.wallet_exchange', '{}'::text[]),
  ('wallet.reward.earned', 'exact', 'moment', 'wallet', 'reward_earned', NULL, NULL, 'Coins', 'standard', 'timeline.summary.wallet_reward_earned', '{}'::text[]),
  ('wallet.reward.redeemed', 'exact', 'moment', 'wallet', 'reward_redeemed', NULL, NULL, 'Gift', 'standard', 'timeline.summary.wallet_reward_redeemed', '{}'::text[]),
  ('wallet.', 'prefix', 'silent', 'wallet', 'wallet_other', NULL, NULL, 'Wallet', 'standard', 'timeline.summary.generic_wallet', '{}'::text[]),
  ('auth.signup', 'exact', 'moment', 'account', 'joined', NULL, NULL, 'PartyPopper', 'standard', 'timeline.summary.auth_signup', '{}'::text[]),
  ('auth.new_device', 'exact', 'moment', 'account', 'new_device', NULL, NULL, 'ShieldAlert', 'standard', 'timeline.summary.auth_new_device', '{}'::text[]),
  ('auth.', 'prefix', 'silent', 'app_usage', 'app_session', NULL, NULL, 'LogIn', 'standard', 'timeline.summary.generic_app_usage', '{}'::text[]),
  ('profile.update', 'exact', 'moment', 'community', 'profile_updated', NULL, NULL, 'UserCog', 'standard', 'timeline.summary.profile_update', '{}'::text[]),
  ('settings.language.change', 'exact', 'moment', 'account', 'language_changed', NULL, NULL, 'Languages', 'standard', 'timeline.summary.settings_language_change', '{}'::text[]),
  ('settings.consent.change', 'exact', 'moment', 'account', 'consent_changed', NULL, NULL, 'ShieldCheck', 'standard', 'timeline.summary.settings_consent_change', '{}'::text[]),
  ('settings.export.request', 'exact', 'moment', 'account', 'data_export', NULL, NULL, 'Download', 'standard', 'timeline.summary.settings_export_request', '{}'::text[]),
  ('settings.', 'prefix', 'digest', 'account', 'settings_other', NULL, NULL, 'Settings', 'standard', 'timeline.summary.generic_account', '{}'::text[]),
  ('page.view', 'exact', 'silent', 'app_usage', 'screen_visited', NULL, NULL, 'Eye', 'standard', 'timeline.summary.page_view', '{}'::text[]),
  ('screen.dwell', 'exact', 'silent', 'app_usage', 'time_on_screen', NULL, NULL, 'Timer', 'standard', 'timeline.summary.screen_dwell', '{}'::text[]),
  ('notification.open', 'exact', 'digest', 'app_usage', 'notification_opened', NULL, NULL, 'BellRing', 'standard', 'timeline.summary.notification_open', '{}'::text[])
ON CONFLICT (activity_type) DO UPDATE SET
  match = EXCLUDED.match, tier = EXCLUDED.tier, category = EXCLUDED.category, topic = EXCLUDED.topic,
  pillar = EXCLUDED.pillar, secondary_pillar = EXCLUDED.secondary_pillar, icon = EXCLUDED.icon,
  sensitivity = EXCLUDED.sensitivity, summary_key = EXCLUDED.summary_key, params = EXCLUDED.params,
  updated_at = now();
DELETE FROM public.activity_catalog WHERE activity_type NOT IN ('index.movement.recorded', 'index.tier.reached', 'index.balance.changed', 'index.pillar.streak', 'index.pillar.slipping', 'index.pillar.recovered', 'index.baseline.completed', 'index.plan.created', 'index.insight.noticed', 'health.log.meal', 'health.log.water', 'health.log.exercise', 'health.log.sleep', 'health.log.meditation', 'health.log.mood', 'health.log.stress', 'health.wearable_features.bridged', 'health.wearable_features.bridge_failed', 'health.daily.recomputed', 'health.biomarker.upload_pdf', 'health.biomarker.upload_manual', 'health.biomarker.upload_device', 'health.biomarker.connect_device', 'health.biomarker.order_test', 'health.biomarker.share', 'health.biomarker.view', 'health.biomarker.download', 'health.lab_report.upload', 'health.lab_report.export', 'health.omics.upload', 'health.omics.connect_api', 'health.omics.view', 'health.supplement.add', 'health.supplement.update', 'health.supplement.delete', 'health.', 'diary.create', 'diary.', 'memory.create', 'memory.promote', 'memory.update', 'memory.delete', 'memory.forget', 'memory.identity.', 'memory.', 'life_compass.set', 'goal.create', 'goal.subgoal.complete', 'goal.milestone', 'journey.step.complete', 'journey.session.listened', 'journey.audiobook.finish', 'journey.', 'orb.session.summary', 'orb.session.start', 'orb.session.stop', 'orb.turn.', 'orb.', 'vtid.', 'chat.message', 'autopilot.action.execute', 'autopilot.action.dismiss', 'autopilot.action.snooze', 'autopilot.', 'recommendation.interaction.', 'recommendation.', 'reminder.create', 'task.create', 'task.complete', 'task.approve', 'task.reject', 'task.', 'calendar.create', 'calendar.respond', 'calendar.update', 'calendar.', 'community.event.join', 'community.event.attend', 'community.event.create', 'community.event.leave', 'community.event.share', 'community.event.', 'community.group.create', 'community.group.join', 'community.group.leave', 'community.group.update', 'community.group.invite', 'community.group.', 'community.live.create', 'community.live.start', 'community.live.join', 'community.live.cohost_accept', 'community.live.poll_vote', 'community.live.remind', 'community.live.', 'community.follow', 'community.unfollow', 'community.conversation.start', 'community.group_chat.create', 'community.group_chat.join', 'community.message.send', 'community.post.create', 'community.comment.create', 'community.reaction.add', 'community.search', 'community.', 'discover.match', 'discover.like', 'discover.service.bookmark', 'discover.service.share', 'discover.provider.contact', 'discover.order.placed', 'discover.booking.created', 'discover.', 'media.music.play', 'media.', 'wallet.transfer', 'wallet.exchange', 'wallet.reward.earned', 'wallet.reward.redeemed', 'wallet.', 'auth.signup', 'auth.new_device', 'auth.', 'profile.update', 'settings.language.change', 'settings.consent.change', 'settings.export.request', 'settings.', 'page.view', 'screen.dwell', 'notification.open');
-- END GENERATED activity_catalog seed

-- 3. Lookup -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activity_catalog_lookup(p_activity_type text)
RETURNS public.activity_catalog
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT c.*
    FROM public.activity_catalog c
   WHERE (c.match = 'exact'  AND c.activity_type = lower(p_activity_type))
      OR (c.match = 'prefix' AND left(lower(p_activity_type), length(c.activity_type)) = c.activity_type)
   ORDER BY (c.match = 'exact') DESC, length(c.activity_type) DESC
   LIMIT 1
$$;

-- 4. Classify on insert (fills only NULL fields) --------------------------------
CREATE OR REPLACE FUNCTION public.classify_activity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  c public.activity_catalog;
BEGIN
  IF NEW.tier IS NOT NULL AND NEW.category IS NOT NULL AND NEW.topic IS NOT NULL THEN
    RETURN NEW;
  END IF;
  c := public.activity_catalog_lookup(NEW.activity_type);
  IF c.activity_type IS NULL THEN
    NEW.tier     := COALESCE(NEW.tier, 'silent');
    NEW.category := COALESCE(NEW.category, 'app_usage');
    NEW.topic    := COALESCE(NEW.topic, 'unknown');
    RETURN NEW;
  END IF;
  NEW.tier             := COALESCE(NEW.tier, c.tier);
  NEW.category         := COALESCE(NEW.category, c.category);
  NEW.topic            := COALESCE(NEW.topic, c.topic);
  NEW.pillar           := COALESCE(NEW.pillar, c.pillar);
  NEW.secondary_pillar := COALESCE(NEW.secondary_pillar, c.secondary_pillar);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_classify_activity ON public.user_activity_log;
CREATE TRIGGER trg_classify_activity
  BEFORE INSERT ON public.user_activity_log
  FOR EACH ROW EXECUTE FUNCTION public.classify_activity();

-- 5. Backfill (pg_cron, newest first, self-unscheduling) ----------------------
CREATE OR REPLACE FUNCTION public.backfill_activity_tiers(p_batch int DEFAULT 5000)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_done int;
BEGIN
  WITH batch AS (
    SELECT id, activity_type
      FROM public.user_activity_log
     WHERE tier IS NULL
     ORDER BY created_at DESC
     LIMIT GREATEST(p_batch, 1)
     FOR UPDATE SKIP LOCKED
  ), cls AS (
    SELECT b.id, (public.activity_catalog_lookup(b.activity_type)).*
      FROM batch b
  )
  UPDATE public.user_activity_log u
     SET tier             = COALESCE(cls.tier, 'silent'),
         category         = COALESCE(u.category, cls.category, 'app_usage'),
         topic            = COALESCE(u.topic, cls.topic, 'unknown'),
         pillar           = COALESCE(u.pillar, cls.pillar),
         secondary_pillar = COALESCE(u.secondary_pillar, cls.secondary_pillar)
    FROM cls
   WHERE u.id = cls.id;
  GET DIAGNOSTICS v_done = ROW_COUNT;

  IF v_done = 0 AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'activity-tiers-backfill';
  END IF;
  RETURN v_done;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_activity_tiers(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backfill_activity_tiers(int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_activity_tiers(int) TO service_role;

-- 6. Archive: explicit columns, silent/system only ----------------------------
CREATE OR REPLACE FUNCTION public.archive_old_activity_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH moved AS (
    DELETE FROM public.user_activity_log
     WHERE created_at < now() - interval '180 days'
       AND tier IN ('silent','system')
    RETURNING id, user_id, activity_type, activity_data, context_data, session_id, dedupe_key,
              created_at, ingested_at, source, actor_vitana_id, pillar, secondary_pillar,
              category, topic, tier, hidden_from_ai, hidden_at
  )
  INSERT INTO public.user_activity_log_archive
    (id, user_id, activity_type, activity_data, context_data, session_id, dedupe_key,
     created_at, ingested_at, source, actor_vitana_id, pillar, secondary_pillar,
     category, topic, tier, hidden_from_ai, hidden_at)
  SELECT id, user_id, activity_type, activity_data, context_data, session_id, dedupe_key,
         created_at, ingested_at, source, actor_vitana_id, pillar, secondary_pillar,
         category, topic, tier, hidden_from_ai, hidden_at
    FROM moved
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_old_activity_logs() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.archive_old_activity_logs() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_old_activity_logs() TO service_role;

-- 7. Indexes ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ual_user_tier_created
  ON public.user_activity_log (user_id, tier, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ual_user_pillar_created
  ON public.user_activity_log (user_id, pillar, created_at DESC) WHERE pillar IS NOT NULL;

-- 8. Schedules (only where pg_cron exists) ------------------------------------
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('activity-tiers-backfill', '* * * * *',
                          'SELECT public.backfill_activity_tiers(5000)');
    PERFORM cron.schedule('activity-log-archive-daily', '35 3 * * *',
                          'SELECT public.archive_old_activity_logs()');
  END IF;
END
$cron$;

COMMIT;
