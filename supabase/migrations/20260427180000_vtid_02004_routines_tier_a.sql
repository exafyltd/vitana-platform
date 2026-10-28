-- =============================================================================
-- VTID-02004 — Tier A daily routines: voice-lab triage, draft-PR babysitter,
-- agents heartbeat. Seeds catalog only — the remote agents are created
-- separately via /schedule (RemoteTrigger) once this row exists.
--
-- All three follow the autonomy contract from
-- feedback_routines_no_human_briefs.md:
--   green pass OR self-heal handoff via OASIS event ingest, never briefs.
-- =============================================================================

INSERT INTO routines (name, display_name, description, cron_schedule)
VALUES
  ('voice-lab-triage',
   'Voice Lab Daily Triage',
   'Reads the last 24h of ORB Live sessions, clusters error patterns vs the 7-day baseline, and emits an OASIS event (topic voice.live.regression.daily_triage) when a regression is detected so the existing voice self-healing loop picks it up. Green when no regression, yellow when self-healing has been notified.',
   '30 4 * * *'),
  ('draft-pr-babysitter',
   'Draft PR Babysitter',
   'Sweeps open draft PRs across exafyltd/vitana-platform and exafyltd/vitana-v1. Auto-rebases anything behind main, posts a one-line CI status comment, labels PRs that have been draft >5 days. Green when every draft PR is healthy, yellow when the routine took action.',
   '0 5 * * *'),
  ('agents-heartbeat',
   'Agents Registry Heartbeat',
   'Calls /api/v1/agents/registry, flags any of the registered agents whose derived status is degraded or down, and emits an OASIS event (topic agents.registry.degraded) so self-healing can investigate. Green when all agents are healthy, yellow when self-healing has been notified.',
   '30 5 * * *')
ON CONFLICT (name) DO NOTHING;
