-- =============================================================================
-- VTID-02018 — Tier C-2 daily routines: knowledge-docs-freshness, push-pipeline,
-- migration-backlog, dyk-tour-progress, spec-memory-quarantine.
-- Seeds catalog only — remote agents are created separately via /schedule.
--
-- All five follow the autonomy contract: green pass OR self-heal handoff via
-- OASIS event ingest, never briefs.
--
-- Each routine reads pre-aggregated metrics from a new audit endpoint under
-- /api/v1/routines/audits/* (X-Routine-Token gated; service role stays on
-- the gateway, no DB credentials in the sandbox).
-- =============================================================================

INSERT INTO routines (name, display_name, description, cron_schedule)
VALUES
  ('knowledge-docs-freshness',
   'Knowledge Docs Freshness',
   'Daily sweep of knowledge_docs for entries older than 180 days. Emits OASIS event docs.staleness.detected when stale-doc count exceeds threshold so the existing docs-curation flow picks them up.',
   '0 9 * * *'),
  ('push-pipeline-probe',
   'Push Notification Pipeline Probe',
   'Daily probe of the push notification stack: external Appilix API reachability + user_device_tokens counts (web vs mobile). Emits OASIS event push.pipeline.degraded on any breach.',
   '30 9 * * *'),
  ('migration-backlog',
   'Migration Backlog Audit',
   'Compares the supabase/migrations/*.sql files in the cloned repo against schema_migrations applied in Supabase. Lists migrations that exist on disk but were never applied. Emits OASIS event migrations.backlog.detected when the gap exceeds 5 unapplied migrations.',
   '0 10 * * *'),
  ('dyk-tour-progress',
   'Did You Know Tour Progress',
   'Daily snapshot of dyk_user_active_days distribution. Tracks user progress through the 30-day tour. Emits OASIS event dyk.tour.coverage_drop when no users have advanced past day 14 — signals the tour is stuck.',
   '30 10 * * *'),
  ('spec-memory-quarantine',
   'Spec Memory Gate Quarantine Sweep',
   'Reads voice_healing_shadow_log for outcome=quarantined entries. Surfaces aged or growing quarantine. Emits OASIS event voice_healing.quarantine.degraded when count grows >50%/week or oldest entry exceeds 14 days.',
   '0 11 * * *')
ON CONFLICT (name) DO NOTHING;
