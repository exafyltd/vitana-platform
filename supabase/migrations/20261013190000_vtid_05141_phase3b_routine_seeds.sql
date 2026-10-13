-- VTID-05141: Loop Engineering Phase 3b — catalog rows for the two new
-- gateway-runner routines (loop L5 Guard). routine_runs.routine_name has a
-- foreign key on routines(name), so a routine needs its catalog row before its
-- first run. voice-lab-triage already has its row.
--
-- Additive and idempotent: existing rows are left untouched.

BEGIN;

INSERT INTO public.routines (name, display_name, description, cron_schedule)
VALUES
  (
    'llm-spend-budget',
    'LLM Spend Budget',
    'Daily (23:50 UTC) comparison of the UTC day''s llm.call.completed spend with the budgets in orchestrator/budgets.ts (platform, per agent, per run). Alert only, never blocks a call. Spec: routines/llm-spend-budget.md.',
    '50 23 * * *'
  ),
  (
    'llm-fallback-watch',
    'LLM Google Fallback Watch',
    'Daily (07:15 UTC): any llm.call.completed in 24 h that landed on Google (isGoogleLlmCall) is an incident, emitted with status error and routed to self-healing. Spec: routines/llm-fallback-watch.md.',
    '15 7 * * *'
  )
ON CONFLICT (name) DO NOTHING;

COMMIT;
