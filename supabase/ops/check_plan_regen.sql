\set ON_ERROR_STOP on

\echo '=== Plan version state for the 4 unblocked findings ==='
SELECT finding_id,
       max(version) AS latest_version,
       count(*) AS total_versions,
       max(created_at) AS latest_created
FROM dev_autopilot_plan_versions
WHERE finding_id IN (
  'ed4f62b2-32a4-487c-b5cb-de091dd3b269',
  '6196ae39-2195-4eaf-9ebb-d4ba51c4ddbe',
  '104102f7-9c24-4f63-acb3-fa8fea16ed1c',
  '18acec92-9188-4aff-bfae-8f3b96b353cb'
)
GROUP BY finding_id;
