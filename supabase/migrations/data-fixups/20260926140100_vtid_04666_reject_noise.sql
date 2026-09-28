-- VTID-04666 — reject the open developer recommendations the new P1 rules
-- would never create (docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md §2, §4 P1).
--
-- One-shot data fix, applied by a human-dispatched RUN-MIGRATION run AFTER
-- 20260926140000_vtid_04666_recommendation_noise.sql and the gateway code of
-- the same VTID are live (otherwise the next analyzer run recreates them).
--
-- Scope, deliberately narrow:
--   * system-wide rows only (user_id IS NULL) — no member row is touched;
--   * open rows only (status new / snoozed);
--   * source_type roadmap / health / oasis only, each with the exact title
--     shape its analyzer writes, so a hand-made row is never caught.
--
-- What is rejected:
--   roadmap  "Unblock VTID-…" cards whose VTID is terminal, finished,
--            abandoned (voided / deleted / rejected / cancelled), an
--            unapproved `allocated` shell, not spec-approved, or untouched for
--            more than 365 days (roadmap-analyzer.ts isStalledVtidCandidate).
--   health   "Configure environment variable" cards for ANTHROPIC_API_KEY
--            (deliberately unset, Bedrock-only rule VTID-03563) and
--            GITHUB_TOKEN (the gateway uses GITHUB_SAFE_MERGE_TOKEN).
--   oasis    "Fix recurring error" cards whose topic is a noise topic
--            (oasis-noise-topics.ts isRecommendationNoiseTopic): autopilot /
--            self-heal / CI / ledger / on-ramp / deploy bookkeeping and
--            telemetry (voice.latency.*, assistant.turn, telemetry.*).
--
-- Reason: autopilot_recommendations has no rejection-reason column, and the
-- only JSONB column (provenance) belongs to the ranker's decision trail, so
-- the reason is recorded here and in docs/validation/VTID-04666/. Rows are
-- identifiable afterwards by status='rejected' + this run's updated_at.
-- updated_at = now() also starts the 30-day rejected-fingerprint block.
--
-- Idempotent: a second run matches nothing (rows are no longer new/snoozed).

-- ---------------------------------------------------------------------------
-- roadmap: stalled-VTID cards for VTIDs that are not stalled work
-- ---------------------------------------------------------------------------
UPDATE public.autopilot_recommendations ar
   SET status = 'rejected',
       updated_at = now()
 WHERE ar.user_id IS NULL
   AND ar.status IN ('new', 'snoozed')
   AND ar.source_type = 'roadmap'
   AND ar.title LIKE 'Unblock VTID-%'
   AND EXISTS (
     SELECT 1
       FROM public.vtid_ledger vl
      WHERE vl.vtid = ar.source_ref
        AND (
              vl.is_terminal IS TRUE
           OR lower(coalesce(vl.status, '')) IN
                ('completed', 'archived', 'voided', 'deleted', 'rejected', 'cancelled', 'allocated')
           OR lower(coalesce(vl.spec_status, '')) <> 'approved'
           OR vl.updated_at < now() - interval '365 days'
        )
   );

-- ---------------------------------------------------------------------------
-- health: env vars that are intentionally absent or satisfied by an alias
-- ---------------------------------------------------------------------------
UPDATE public.autopilot_recommendations ar
   SET status = 'rejected',
       updated_at = now()
 WHERE ar.user_id IS NULL
   AND ar.status IN ('new', 'snoozed')
   AND ar.source_type = 'health'
   AND ar.title LIKE 'Configure environment variable:%'
   AND ar.source_ref IN ('ANTHROPIC_API_KEY', 'GITHUB_TOKEN');

-- ---------------------------------------------------------------------------
-- oasis: "recurring error" cards built from bookkeeping / telemetry topics.
-- source_ref is "<service>:<topic>" for error_pattern cards.
-- ---------------------------------------------------------------------------
UPDATE public.autopilot_recommendations ar
   SET status = 'rejected',
       updated_at = now()
 WHERE ar.user_id IS NULL
   AND ar.status IN ('new', 'snoozed')
   AND ar.source_type = 'oasis'
   AND ar.title LIKE 'Fix recurring error:%'
   AND position(':' IN coalesce(ar.source_ref, '')) > 0
   AND (
        substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) LIKE 'dev\_autopilot.%'
     OR substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) LIKE 'self\_healing.%'
     OR substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) LIKE 'cicd.%'
     OR substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) LIKE 'vtid.lifecycle.%'
     OR substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) LIKE 'operator.execution\_onramp.%'
     OR substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) LIKE 'deploy.%'
     OR substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) LIKE 'staging.deploy.%'
     OR substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) LIKE 'prod.deploy.%'
     OR substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) LIKE 'voice.latency.%'
     OR substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) LIKE 'telemetry.%'
     OR substring(ar.source_ref FROM position(':' IN ar.source_ref) + 1) = 'assistant.turn'
   );
