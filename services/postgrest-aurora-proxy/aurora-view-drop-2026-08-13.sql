-- 20 views/matviews blocking DMS DROP_AND_CREATE full-load (VTID-03619).
-- DMS full-load issues a plain DROP TABLE per table with no CASCADE; any
-- view/matview reading that table blocks it with SQLSTATE 2BP01, exactly
-- like the 245 FK constraints did. Generated from live pg_get_viewdef()
-- output, paired 1:1 with aurora-view-restore-2026-08-13.sql.

DROP VIEW IF EXISTS public."VtidLedger";
DROP VIEW IF EXISTS public.admin_system_health;
DROP VIEW IF EXISTS public.admin_tenant_analytics;
DROP VIEW IF EXISTS public.agent_personas_registry;
DROP MATERIALIZED VIEW IF EXISTS public.ai_usage_month_by_user_provider;
DROP VIEW IF EXISTS public.commandhub_board_visible;
DROP VIEW IF EXISTS public.gemini_cost_daily;
DROP VIEW IF EXISTS public.intent_compass_alignment;
DROP VIEW IF EXISTS public.intent_open_asks;
DROP VIEW IF EXISTS public.live_rooms_public;
DROP VIEW IF EXISTS public.local_heroes_weekly;
DROP VIEW IF EXISTS public.popular_podcast_shows;
DROP MATERIALIZED VIEW IF EXISTS public.product_outcome_rollup;
DROP VIEW IF EXISTS public.signup_funnel;
DROP VIEW IF EXISTS public.stripe_subscriptions;
DROP VIEW IF EXISTS public.user_diary_streak;
DROP VIEW IF EXISTS public.user_follow_counts;
DROP VIEW IF EXISTS public.user_pillar_recent_activity;
DROP VIEW IF EXISTS public.vtid_specs;
DROP VIEW IF EXISTS public.wearable_rollup_7d;
