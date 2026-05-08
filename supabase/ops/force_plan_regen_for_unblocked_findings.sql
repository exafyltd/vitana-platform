-- Delete stale plan_versions for the 4 currently-unblocked findings so
-- lazyPlanTick regenerates them with the new (post-2026-05-08-12:00 deploy)
-- scanner-aware planner prompt. The OLD plans were generated when the
-- prompt explicitly forbade package.json + migrations, so they correctly
-- excluded the canonical fix from Files-to-modify and locked the autopilot
-- into test-only PRs that fail CI 100%.
--
-- Safe: this deletes ONLY plan_versions, not findings or executions.
-- New plans will appear within ~30-60s via lazyPlanTick.

\set ON_ERROR_STOP on

\echo '=== BEFORE: latest plan version per finding ==='
SELECT finding_id, max(version) AS latest_version, count(*) AS total_versions
FROM dev_autopilot_plan_versions
WHERE finding_id IN (
  'ed4f62b2-32a4-487c-b5cb-de091dd3b269',  -- CVE: package.json (npm-audit)
  '6196ae39-2195-4eaf-9ebb-d4ba51c4ddbe',  -- Add missing tests for admin-embeddings-backfill
  '104102f7-9c24-4f63-acb3-fa8fea16ed1c',  -- Missing auth middleware ai-assistants
  '18acec92-9188-4aff-bfae-8f3b96b353cb'   -- Add missing tests admin-autopilot
)
GROUP BY finding_id;

DELETE FROM dev_autopilot_plan_versions
WHERE finding_id IN (
  'ed4f62b2-32a4-487c-b5cb-de091dd3b269',
  '6196ae39-2195-4eaf-9ebb-d4ba51c4ddbe',
  '104102f7-9c24-4f63-acb3-fa8fea16ed1c',
  '18acec92-9188-4aff-bfae-8f3b96b353cb'
);

\echo ''
\echo '=== AFTER (should be 0 rows for these findings) ==='
SELECT finding_id, count(*)
FROM dev_autopilot_plan_versions
WHERE finding_id IN (
  'ed4f62b2-32a4-487c-b5cb-de091dd3b269',
  '6196ae39-2195-4eaf-9ebb-d4ba51c4ddbe',
  '104102f7-9c24-4f63-acb3-fa8fea16ed1c',
  '18acec92-9188-4aff-bfae-8f3b96b353cb'
)
GROUP BY finding_id;
