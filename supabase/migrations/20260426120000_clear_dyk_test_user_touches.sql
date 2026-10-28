-- BOOTSTRAP-DYK-SMOKE — clear today's proactive touches for the e2e test user
-- so we can re-verify the DYK card renders end-to-end. One-off; safe to re-run.
DELETE FROM public.user_proactive_touches
WHERE user_id = 'a27552a3-0257-4305-8ed0-351a80fd3701'
  AND sent_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC');
