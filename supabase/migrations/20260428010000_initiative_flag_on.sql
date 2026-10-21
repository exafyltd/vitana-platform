-- BOOTSTRAP-PROACTIVE-INITIATIVE — flip V2 Initiative Engine flag ON.
-- Mirrors the DYK flag-flip pattern from PR #896. Idempotent — re-running
-- is a no-op.
--
-- Plan: .claude/plans/proactive-did-you-generic-sifakis.md (V2 §Rollout step 3).

UPDATE public.system_controls
SET enabled = TRUE,
    updated_at = NOW(),
    updated_by = 'BOOTSTRAP-PROACTIVE-INITIATIVE-SMOKE',
    updated_by_role = 'system',
    reason = 'V2 Proactive Initiative Engine: backend route + tool + brain block deployed (PR #1012). Enabling for voice smoke.'
WHERE key = 'vitana_proactive_initiative_enabled';

SELECT key, enabled, updated_at, reason
FROM public.system_controls
WHERE key = 'vitana_proactive_initiative_enabled';
