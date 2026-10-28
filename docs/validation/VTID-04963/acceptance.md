# VTID-04963 — acceptance (phase 1)

AC-1 In production (VITANA_ENV unset or production) the reminders loop runs when REMINDERS_INPROCESS_DISPATCH_ENABLED is exactly "true".
TEST: services/gateway/test/vtid-04963-reminders-guided-journey-gate.test.ts ("production with the flag → on")

AC-2 On staging the reminders loop runs only when REMINDERS_STAGING_DISPATCH_OVERRIDE is exactly "true".
TEST: services/gateway/test/vtid-04963-reminders-guided-journey-gate.test.ts ("staging with the flag but no override → off", "staging with the flag and the override → on")

AC-3 The guided-journey audiobook daily reminder follows the same gate and keeps its own AUDIOBOOK_REMINDERS_DISABLED kill switch.
TEST: services/gateway/test/vtid-04963-reminders-guided-journey-gate.test.ts (describe "isAudiobookReminderLoopEnabled"), services/gateway/test/vtid-04763-audiobook-daily.test.ts

AC-4 AWS-PROD-DEPLOY-GATEWAY.yml pins REMINDERS_INPROCESS_DISPATCH_ENABLED=true and never the staging override; staging pins the override "true" (phase 1).
TEST: services/gateway/test/vtid-04963-reminders-guided-journey-gate.test.ts (describe "deploy workflows (phase 1)"), services/gateway/test/vtid-04320-reminders-dispatch.test.ts

AC-5 Every run: step in the staging workflow stays under GitHub's 20,000-character limit.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

OASIS_IMPACT: no new OASIS topics; reminder.* events now also carry env=production once published.
