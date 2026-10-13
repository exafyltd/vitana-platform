# VTID-05127 — phone verification: switching it on is one owner step

Plan: `plan-sparring.md` (sparred, converged in 2 rounds, owner-approved 2026-10-13). Runbook: `SWITCH-ON.md`.

## What changed
- `scripts/aws/setup-phone-verify-sms.sh` (new): HMAC secret, `sms-voice:SendTextMessage` on `vitana-ecs-task-role` (this account and region only), optional monthly SMS spend limit and sender ID for DE/AT/CH, `status` (sandbox tier, limits, sender IDs, secret, policy, the ARN to copy). Dry run by default; refuses any other account.
- Staging deploy: step "Resolve phone verification config" — secret present → wired + `PHONE_VERIFY_ENABLED=true`; absent → `false`, deploy never fails.
- Production deploy: step "Build task-definition (phone verification)" → `scripts/ci/phone-verify-wiring.sh` with repository variables `PHONE_VERIFY_HMAC_SECRET_PROD_ARN` and `PHONE_VERIFY_PROD_ENABLED`; exact anchored ARN check; "on" without the ARN fails the deploy; runs before step 2/2, so `env_overrides` can still switch it off.
- No application code, no migration. Nothing is switched on: after merge both environments stay off until the owner acts.

## Decisions taken
- Staging uses the existing Kiro convention (secret present = on); production keeps an explicit variable because the secret has to exist before the sandbox exit.
- Spend limit and sender ID are optional flags of the script, not defaults, because both are account-wide/registrations the owner should choose.
- No What's New entry here; it follows the real switch-on (owner rule: no cards behind a flag).

## Acceptance criteria

AC-1 Production wiring: ARN + 'true' → secret ref + true; ARN + other → secret ref + false; no ARN + 'true' → deploy fails; neither → false, stale secret ref removed; only exact 'true' counts.
TEST: services/gateway/test/vtid-05127-phone-verify-switch-wiring.test.ts — "VTID-05127 wiring decision"

AC-2 Only the production phone-verify-hmac secret ARN of this account is accepted.
TEST: services/gateway/test/vtid-05127-phone-verify-switch-wiring.test.ts — "rejects an ARN with …", "pins the exact anchored ARN pattern"

AC-3 The production step runs after the checkout and before step 2/2, and step 2/2 never strips the phone settings.
TEST: services/gateway/test/vtid-05127-phone-verify-switch-wiring.test.ts — "VTID-05127 production wiring step"

AC-4 Staging never fails on an absent secret; present → secret ref + true; merged by name in the roll step.
TEST: services/gateway/test/vtid-05127-phone-verify-switch-wiring.test.ts — "VTID-05127 staging wiring step"

AC-5 The setup script grants only SendTextMessage on this account and region, never prints the secret, and its dry run without credentials changes nothing.
TEST: services/gateway/test/vtid-05127-phone-verify-switch-wiring.test.ts — "VTID-05127 setup script"
