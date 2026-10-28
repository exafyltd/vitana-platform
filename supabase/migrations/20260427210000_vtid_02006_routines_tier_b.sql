-- =============================================================================
-- VTID-02006 — Tier B daily routines: Supabase IO audit, Autopilot rec
-- quality, OASIS event anomaly, Vitana Index health. Seeds catalog only —
-- remote agents are created separately via /schedule (RemoteTrigger).
--
-- All four follow the autonomy contract from feedback_routines_no_human_briefs.md:
--   green pass OR self-heal handoff via OASIS event ingest, never briefs.
-- =============================================================================

INSERT INTO routines (name, display_name, description, cron_schedule)
VALUES
  ('supabase-io-audit',
   'Supabase IO Pressure Audit',
   'Daily probe of unused indexes, slow queries, and disk pressure. Replays the lessons from the April 2026 disk-IO crisis: drops 12 unused indexes + retention cleanup. Emits OASIS event database.io_pressure.daily_audit when pressure indicators exceed playbook thresholds.',
   '0 6 * * *'),
  ('autopilot-rec-quality',
   'Autopilot Recommendation Quality',
   'Samples yesterday''s autopilot recommendations across all users, checks pillar-tag accuracy, accept/dismiss/snooze rates, and detects drift vs the prior 7-day baseline. Emits OASIS event autopilot.recommendations.quality_drift when drift exceeds thresholds.',
   '30 6 * * *'),
  ('oasis-event-anomaly',
   'OASIS Event Anomaly Detection',
   'Diffs today''s topic distribution vs the prior 7-day baseline. Surfaces novel topics (≥3 occurrences not seen before) and ≥3σ spikes on existing topics — these often precede outages. Emits OASIS event oasis.event_anomaly.daily on any anomaly.',
   '0 7 * * *'),
  ('vitana-index-health',
   'Vitana Index Computation Health',
   'Daily count of users with fresh vitana_index_scores rows, pillar-score nullity rate, and Phase E migration readiness probe. Emits OASIS event vitana_index.computation.degraded when computation fails for ≥10% of active users.',
   '30 7 * * *')
ON CONFLICT (name) DO NOTHING;
