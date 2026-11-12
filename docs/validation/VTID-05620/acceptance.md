# VTID-05620 acceptance: Command Hub PUBLISH is not gated on STAGING-VERIFY

Owner decision 2026-11-08.

AC-1 The publish route no longer refuses with 409 staging_not_verified.
TEST: services/gateway/test/vtid-04646-publish-gate-wiring.test.ts ("does not refuse the publish on STAGING-VERIFY")

AC-2 A publish without a passing STAGING-VERIFY run is recorded as production.publish.gate_skipped.
TEST: services/gateway/test/vtid-04646-publish-gate-wiring.test.ts ("records a publish without a passing STAGING-VERIFY as its own evidence event")

AC-3 The gate is still evaluated on the staging commit before bake, allocation and dispatch.
TEST: services/gateway/test/vtid-04646-publish-gate-wiring.test.ts ("evaluates the gate on the staging commit before bake, allocation and dispatch")

AC-4 The gateway typechecks with the change.
TEST: docs/validation/VTID-05620/outputs/tsc-gateway.txt (npx tsc --noEmit, exit 0)

## Evidence
- Jest: docs/validation/VTID-05620/outputs/jest-publish-gate.txt (25 of 25 pass).
- Typecheck: docs/validation/VTID-05620/outputs/tsc-gateway.txt (no errors).

## Not yet observed
- A real PUBLISH from the Command Hub after the gateway deploy.
