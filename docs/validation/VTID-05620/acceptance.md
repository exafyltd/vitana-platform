# VTID-05620 acceptance: Command Hub PUBLISH is not gated on STAGING-VERIFY

Owner decision 2026-11-08.

## Evidence
- `services/gateway/test/vtid-04646-publish-gate-wiring.test.ts` and `services/gateway/test/services/testing/publish-gate.test.ts`: 25 of 25 pass (run locally).
- `tsc --noEmit` for services/gateway: clean (run locally with an 8 GB heap).
- The publish route no longer returns `409 staging_not_verified`; a publish without a passing run writes `production.publish.gate_skipped` (checked by the wiring test).

## Not yet observed
- A real PUBLISH from the Command Hub after the gateway deploy.
