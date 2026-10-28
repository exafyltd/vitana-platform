# VTID-04896 — production deploy pins the VTNA reward sweep off

Owner decision 2026-10-05: the first gateway production release ships with the VTNA reward sweep (VTID-04878) off; enabling it needs the owner's explicit approval.

AC-1 The production deploy sets `REWARD_SWEEP_ENABLED=false` on the task definition before it is registered.
TEST: services/gateway/test/vtid-04896-prod-reward-sweep-pin.test.ts — "pins REWARD_SWEEP_ENABLED to "false" before the task definition is registered"

AC-2 That value turns off both the sweep and its in-process loop; without it a production ECS task would pay.
TEST: services/gateway/test/vtid-04896-prod-reward-sweep-pin.test.ts — "that value really turns the sweep and its loop off"

AC-3 After the roll, a read-only step reads the live task definition and fails the job (automatic rollback) unless the value is `false`, or the value an explicit `env_overrides` key set.
TEST: services/gateway/test/vtid-04896-prod-reward-sweep-pin.test.ts — "checks the live task definition after the roll, before verification and rollback", "the check is read-only"

AC-4 Staging is unchanged and the generated flag pins are current.
TEST: services/gateway/test/vtid-04896-prod-reward-sweep-pin.test.ts — "staging pins nothing"; services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts — "the generated workflow pins file is current"

AC-5 Every run step stays valid bash and under GitHub's size limit.
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
