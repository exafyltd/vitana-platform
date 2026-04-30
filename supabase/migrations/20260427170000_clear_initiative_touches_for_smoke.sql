-- BOOTSTRAP-INITIATIVE-FIRST-UTTERANCE — clear today's voice_opener_initiative
-- touches for the e2e test user so the V2 voice smoke can be re-run after
-- the brain-block hotfix in PR #1016. Idempotent.
--
-- The first smoke (before #1016) consumed the per-surface daily slot but
-- the LLM dropped the offer phrasing — so the user heard "go ahead"
-- instead of the proper opener. Clearing the touch lets the same user
-- re-trigger today.

DELETE FROM public.user_proactive_touches
WHERE user_id = 'a27552a3-0257-4305-8ed0-351a80fd3701'
  AND surface IN ('voice_opener_initiative', 'voice_opener_tour', 'did_you_know_card', 'priority_card')
  AND sent_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC');
