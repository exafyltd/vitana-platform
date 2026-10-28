-- Restores the 20 views/matviews dropped by aurora-view-drop-2026-08-13.sql,
-- verbatim from pg_get_viewdef() captured immediately before the drop.
-- Run once the DMS full-load has finished reloading affected tables.

CREATE VIEW public."VtidLedger" AS
 SELECT vtid,
    layer,
    module,
    status,
    title,
    summary,
    created_at,
    updated_at,
    description,
    id,
    is_test,
    metadata,
    task_family,
    task_module,
    task_type,
    assigned_to,
    tenant,
    parent_vtid,
    deleted_at,
    deleted_by,
    delete_reason,
    voided_at,
    voided_reason
   FROM vtid_ledger;

CREATE VIEW public.admin_system_health AS
 SELECT ( SELECT count(*) AS count
           FROM memberships) AS total_memberships,
    ( SELECT count(*) AS count
           FROM memberships
          WHERE memberships.status = 'active'::text) AS active_memberships,
    ( SELECT count(*) AS count
           FROM tenants) AS total_tenants,
    ( SELECT count(*) AS count
           FROM message_threads) AS total_threads,
    ( SELECT count(*) AS count
           FROM global_message_threads) AS total_global_threads,
    ( SELECT count(*) AS count
           FROM messages) AS total_messages,
    ( SELECT count(*) AS count
           FROM global_messages) AS total_global_messages;

CREATE VIEW public.admin_tenant_analytics AS
 SELECT t.tenant_id,
    t.name AS tenant_name,
    t.slug AS tenant_slug,
    count(DISTINCT m.user_id) AS total_users,
    count(DISTINCT
        CASE
            WHEN m.status = 'active'::text THEN m.user_id
            ELSE NULL::uuid
        END) AS active_users,
    count(DISTINCT
        CASE
            WHEN m.role = 'admin'::tenant_role THEN m.user_id
            ELSE NULL::uuid
        END) AS admin_count,
    count(DISTINCT
        CASE
            WHEN m.role = 'staff'::tenant_role THEN m.user_id
            ELSE NULL::uuid
        END) AS staff_count,
    count(DISTINCT
        CASE
            WHEN m.role = 'professional'::tenant_role THEN m.user_id
            ELSE NULL::uuid
        END) AS professional_count,
    count(DISTINCT
        CASE
            WHEN m.role = 'patient'::tenant_role THEN m.user_id
            ELSE NULL::uuid
        END) AS patient_count
   FROM tenants t
     LEFT JOIN memberships m ON m.tenant_id = t.tenant_id
  GROUP BY t.tenant_id, t.name, t.slug;

CREATE VIEW public.agent_personas_registry AS
 SELECT id,
    key,
    display_name,
    role,
    voice_id,
    system_prompt,
    intake_schema_ref,
    handles_kinds,
    handoff_keywords,
    greeting_templates,
    status,
    version,
    updated_at
   FROM agent_personas
  WHERE status = 'active'::text;

CREATE MATERIALIZED VIEW public.ai_usage_month_by_user_provider AS
 SELECT user_id,
    tenant_id,
    provider,
    date_trunc('month'::text, created_at) AS month_start,
    count(*) AS call_count,
    sum(request_tokens) AS total_input_tokens,
    sum(response_tokens) AS total_output_tokens,
    sum(estimated_cost_usd)::numeric(12,6) AS total_cost_usd
   FROM ai_usage_log
  WHERE created_at >= date_trunc('month'::text, now())
  GROUP BY user_id, tenant_id, provider, (date_trunc('month'::text, created_at));

CREATE VIEW public.commandhub_board_visible AS
 SELECT vtid,
    status,
    is_terminal,
    terminal_outcome,
    updated_at
   FROM oasis_tasks t
  WHERE is_terminal = false AND (status = ANY (ARRAY['allocated'::text, 'scheduled'::text, 'in_progress'::text]));

CREATE VIEW public.gemini_cost_daily AS
 SELECT date_trunc('day'::text, created_at)::date AS day,
    feature,
    model,
    count(*) AS calls,
    sum(prompt_tokens) AS prompt_tokens,
    sum(completion_tokens) AS completion_tokens,
    sum(total_tokens) AS total_tokens,
    avg(latency_ms)::integer AS avg_latency_ms,
    count(*) FILTER (WHERE status = 'error'::text) AS errors,
    count(*) FILTER (WHERE status = 'fallback'::text) AS fallbacks
   FROM gemini_call_log
  GROUP BY (date_trunc('day'::text, created_at)::date), feature, model
  ORDER BY (date_trunc('day'::text, created_at)::date) DESC, (count(*)) DESC;

CREATE VIEW public.intent_compass_alignment AS
 SELECT ui.intent_id,
    ui.requester_user_id,
    ui.requester_vitana_id,
    ui.intent_kind,
    lc.category AS active_compass_category,
    lc.primary_goal AS active_compass_goal,
    COALESCE(icb.boost_weight, 0::numeric) AS compass_boost_weight,
    icb.boost_weight IS NOT NULL AS is_compass_aligned
   FROM user_intents ui
     LEFT JOIN life_compass lc ON lc.user_id = ui.requester_user_id AND lc.is_active = true
     LEFT JOIN intent_compass_boost icb ON icb.compass_category = lc.category AND icb.intent_kind = ui.intent_kind;

CREATE VIEW public.intent_open_asks AS
 SELECT intent_id,
    requester_user_id,
    requester_vitana_id,
    tenant_id,
    intent_kind,
    category,
    title,
    scope,
    kind_payload,
    match_count,
    created_at,
    expires_at
   FROM user_intents ui
  WHERE status = 'open'::text AND visibility = 'public'::text AND match_count = 0 AND (expires_at IS NULL OR expires_at > now());

CREATE VIEW public.live_rooms_public AS
 SELECT id,
    tenant_id,
    title,
    topic_keys,
    host_user_id,
    starts_at,
    ends_at,
    status,
    created_at,
    updated_at,
    access_level,
    jsonb_build_object('price', metadata -> 'price'::text, 'stream_type', metadata -> 'stream_type'::text, 'enable_replay', metadata -> 'enable_replay'::text, 'cover_image_url', metadata -> 'cover_image_url'::text) AS metadata
   FROM live_rooms;

CREATE VIEW public.local_heroes_weekly AS
 SELECT COALESCE(p.city, 'Unknown'::text) AS city,
    ur.vitana_id,
    ur.user_id,
    p.display_name,
    p.avatar_url,
    ur.completed_count,
    ur.avg_rating,
    ur.ratings_count,
    ur.last_active_at,
    rank() OVER (PARTITION BY (COALESCE(p.city, 'Unknown'::text)) ORDER BY ur.completed_count DESC, ur.avg_rating DESC NULLS LAST, ur.last_active_at DESC NULLS LAST) AS city_rank
   FROM user_reputation ur
     JOIN profiles p USING (user_id)
  WHERE ur.last_active_at > (now() - '14 days'::interval) OR ur.completed_count > 0;

CREATE VIEW public.popular_podcast_shows AS
 SELECT pm.series_name AS show_name,
    pm.host_name,
    count(DISTINCT pm.media_id) AS episode_count,
    max(mu.created_at) AS latest_episode_date,
    mu.category,
    count(DISTINCT pss.user_id) AS subscriber_count
   FROM podcast_metadata pm
     JOIN media_uploads mu ON pm.media_id = mu.id
     LEFT JOIN podcast_show_subscriptions pss ON pm.series_name = pss.show_name AND pm.host_name = pss.host_name
  WHERE mu.status = 'approved'::text AND mu.media_type = 'podcast'::text AND pm.series_name IS NOT NULL
  GROUP BY pm.series_name, pm.host_name, mu.category
  ORDER BY (count(DISTINCT pss.user_id)) DESC, (count(DISTINCT pm.media_id)) DESC
 LIMIT 10;

CREATE MATERIALIZED VIEW public.product_outcome_rollup AS
 SELECT product_id,
    condition_key,
    effect_category,
    count(*) AS total_reports,
    count(*) FILTER (WHERE self_reported_effect = 'better'::text) AS better_count,
    count(*) FILTER (WHERE self_reported_effect = 'no_change'::text) AS no_change_count,
    count(*) FILTER (WHERE self_reported_effect = 'worse'::text) AS worse_count,
    count(*) FILTER (WHERE self_reported_effect = 'side_effect'::text) AS side_effect_count,
    round(avg(effect_magnitude) FILTER (WHERE effect_magnitude IS NOT NULL), 2) AS avg_magnitude,
    count(*) FILTER (WHERE self_reported_effect = 'better'::text)::numeric / NULLIF(count(*), 0)::numeric AS better_rate,
    max(reported_at) AS latest_report_at
   FROM product_outcomes
  WHERE reported_at > (now() - '365 days'::interval)
  GROUP BY product_id, condition_key, effect_category;

CREATE VIEW public.signup_funnel AS
 SELECT sa.id AS attempt_id,
    sa.tenant_id,
    sa.email,
    sa.status AS attempt_status,
    sa.started_at,
    sa.completed_at,
    sa.metadata,
    au.id AS auth_user_id,
    au.created_at AS auth_created_at,
    au.email_confirmed_at,
    au.last_sign_in_at,
    ap.user_id AS app_user_id,
    ap.display_name,
    ap.created_at AS profile_created_at,
    ut.active_role,
    ut.is_primary,
    ut.created_at AS membership_created_at,
        CASE
            WHEN ut.user_id IS NOT NULL THEN 'onboarded'::text
            WHEN ap.user_id IS NOT NULL THEN 'profile_created'::text
            WHEN au.email_confirmed_at IS NOT NULL THEN 'verified'::text
            WHEN au.id IS NOT NULL THEN 'email_sent'::text
            ELSE sa.status
        END AS funnel_stage
   FROM signup_attempts sa
     LEFT JOIN auth.users au ON au.email::text = sa.email
     LEFT JOIN app_users ap ON ap.user_id = au.id
     LEFT JOIN user_tenants ut ON ut.user_id = au.id AND ut.tenant_id = sa.tenant_id;

CREATE VIEW public.stripe_subscriptions AS
 SELECT stripe_subscription_id AS id,
    tenant_id,
    status,
    last_payment_error,
    user_id,
    plan_key,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    trial_end,
    stripe_customer_id,
    metadata,
    created_at,
    updated_at
   FROM user_subscriptions
  WHERE stripe_subscription_id IS NOT NULL;

CREATE VIEW public.user_diary_streak AS
 WITH entry_days AS (
         SELECT diary_entries.user_id,
            (diary_entries.created_at AT TIME ZONE 'UTC'::text)::date AS entry_day
           FROM diary_entries
          GROUP BY diary_entries.user_id, ((diary_entries.created_at AT TIME ZONE 'UTC'::text)::date)
        ), ranked AS (
         SELECT entry_days.user_id,
            entry_days.entry_day,
            entry_days.entry_day - row_number() OVER (PARTITION BY entry_days.user_id ORDER BY entry_days.entry_day)::integer AS streak_group
           FROM entry_days
        ), streaks AS (
         SELECT ranked.user_id,
            ranked.streak_group,
            count(*) AS streak_days,
            max(ranked.entry_day) AS last_day
           FROM ranked
          GROUP BY ranked.user_id, ranked.streak_group
        )
 SELECT user_id,
    streak_days::integer AS current_streak_days,
    last_day
   FROM streaks
  WHERE last_day >= (CURRENT_DATE - '1 day'::interval)::date
  ORDER BY user_id;

CREATE VIEW public.user_follow_counts AS
 SELECT p.user_id,
    COALESCE(followers.count, 0::bigint) AS followers_count,
    COALESCE(following.count, 0::bigint) AS following_count
   FROM profiles p
     LEFT JOIN ( SELECT user_follows.following_id AS user_id,
            count(*) AS count
           FROM user_follows
          GROUP BY user_follows.following_id) followers ON followers.user_id = p.user_id
     LEFT JOIN ( SELECT user_follows.follower_id AS user_id,
            count(*) AS count
           FROM user_follows
          GROUP BY user_follows.follower_id) following ON following.user_id = p.user_id;

CREATE VIEW public.user_pillar_recent_activity AS
 WITH pillar_tags_lookup(pillar, tags) AS (
         VALUES ('nutrition'::text,ARRAY['nutrition'::text, 'meal'::text, 'food-log'::text]), ('hydration'::text,ARRAY['hydration'::text, 'water'::text]), ('exercise'::text,ARRAY['movement'::text, 'workout'::text, 'walk'::text, 'steps'::text, 'exercise'::text]), ('sleep'::text,ARRAY['sleep'::text, 'rest'::text, 'recovery'::text]), ('mental'::text,ARRAY['mindfulness'::text, 'mental'::text, 'stress'::text, 'meditation'::text, 'learning'::text, 'journal'::text, 'social'::text, 'community'::text, 'meetup'::text, 'invite'::text, 'group'::text, 'chat'::text, 'leadership'::text, 'connection'::text, 'match'::text])
        ), classified AS (
         SELECT ce.user_id,
            pt.pillar,
            ce.completion_status,
            ce.completed_at,
            ce.source_ref_type,
            ce.metadata
           FROM calendar_events ce
             CROSS JOIN pillar_tags_lookup pt
          WHERE ce.wellness_tags && pt.tags
        )
 SELECT user_id,
    pillar,
    max(completed_at) AS last_completed_at,
    count(*) FILTER (WHERE completion_status = 'completed'::text AND completed_at >= (now() - '24:00:00'::interval)) AS completions_24h,
    count(*) FILTER (WHERE completion_status = 'completed'::text AND completed_at >= (now() - '7 days'::interval)) AS completions_7d,
    count(*) FILTER (WHERE completed_at >= (now() - '24:00:00'::interval) AND (source_ref_type = 'pillar_template'::text OR (metadata ->> 'plan_source'::text) = 'template'::text)) AS plan_events_24h
   FROM classified c
  GROUP BY user_id, pillar;

CREATE VIEW public.vtid_specs AS
 SELECT id,
    vtid,
    version,
    title,
    spec_markdown,
    spec_hash,
    status,
    created_by,
    created_at
   FROM oasis_specs;

CREATE VIEW public.wearable_rollup_7d AS
 SELECT user_id,
    round(avg(sleep_minutes) FILTER (WHERE sleep_minutes IS NOT NULL), 0) AS sleep_avg_minutes,
    round(avg(sleep_deep_minutes) FILTER (WHERE sleep_deep_minutes IS NOT NULL), 0) AS sleep_deep_avg_minutes,
    round(avg(
        CASE
            WHEN sleep_minutes > 0 THEN sleep_deep_minutes::numeric / NULLIF(sleep_minutes, 0)::numeric * 100::numeric
            ELSE NULL::numeric
        END), 2) AS sleep_deep_pct,
    round(avg(hrv_avg_ms) FILTER (WHERE hrv_avg_ms IS NOT NULL), 2) AS hrv_avg_ms,
    round(avg(resting_hr) FILTER (WHERE resting_hr IS NOT NULL), 0) AS resting_hr,
    round(avg(active_minutes) FILTER (WHERE active_minutes IS NOT NULL), 0) AS activity_minutes,
    sum(workout_count) AS workout_count,
    max(metric_date) AS latest_date,
    count(DISTINCT metric_date) AS days_with_data
   FROM wearable_daily_metrics
  WHERE metric_date >= (CURRENT_DATE - '7 days'::interval)
  GROUP BY user_id;
