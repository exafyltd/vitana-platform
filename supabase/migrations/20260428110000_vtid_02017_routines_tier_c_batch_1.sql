-- =============================================================================
-- VTID-02017 — Tier C-1 daily routines: ORB audio smoke + Cloud Run deploy/
-- frontend health. No new gateway code; both reuse existing endpoints.
--
-- Both follow the autonomy contract from feedback_routines_no_human_briefs.md:
--   green pass OR self-heal handoff via OASIS event ingest, never briefs.
-- =============================================================================

INSERT INTO routines (name, display_name, description, cron_schedule)
VALUES
  ('orb-audio-smoke',
   'ORB Audio Smoke Test',
   'Daily probe of /api/v1/orb/health to confirm Vertex AI Live API is wired up correctly (gemini_live.enabled, vertex_project_id, google_auth_ready). Same checks the EXEC-DEPLOY hard-gate runs on every deploy, but daily and independent. Emits OASIS event orb.live.smoke.regression on any failed check.',
   '0 8 * * *'),
  ('cloud-run-frontend-health',
   'Cloud Run + Frontend Health',
   'Daily curl of gateway /alive and community-app preview URL. Catches silent deploy failures and CDN propagation issues. Emits OASIS event cloud_run.health.degraded on any non-2xx response.',
   '30 8 * * *')
ON CONFLICT (name) DO NOTHING;
