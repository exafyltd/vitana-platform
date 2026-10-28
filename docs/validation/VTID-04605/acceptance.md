# VTID-04605 — orchestrator specialists switched on in production (go-live bundle)

Owner-approved go-live bundle (2026-09-26): VTID-04602 (6 s voice ack), VTID-04603 (one specialist job per question burst),
VTID-04604 (voice calendar writes need an ask + confirmation, never a past date) and this VTID (prod flags).

AC-1: AWS-PROD-DEPLOY-GATEWAY.yml pins ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED, ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED and ORCHESTRATOR_DELEGATION_PERSIST_ENABLED to "true" (strip-then-add, same values as staging); rollback is "false".
TEST: services/gateway/test/vtid-04474-staging-orchestrator-flags.test.ts

AC-2: No workflow run: step exceeds 20,000 characters (the block lives in step 2/2).
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-3: The generated conversation-flag pins record staging AND prod "true" for the three flags (run leases stay unpinned).
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts

AC-4: Nothing changes on production until the owner presses PUBLISH / dispatches the prod workflow (workflow_dispatch only).
TEST: services/gateway/test/vtid-04474-staging-orchestrator-flags.test.ts
