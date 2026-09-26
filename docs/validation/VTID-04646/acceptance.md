# VTID-04646 — PUBLISH refuses a staging build STAGING-VERIFY did not pass

Testing & QA rebuild, phase P5a. Owner decision: block PUBLISH on a red or missing
staging verification, allow an exafy admin to publish anyway with a written reason.

## Acceptance criteria

AC-1: `POST /api/v1/operator/publish` (AWS path) looks up the newest `staging.verify.*`
  OASIS event for service `gateway` and the exact commit staging serves.
  TEST: services/gateway/test/services/testing/publish-gate.test.ts
AC-2: Only `staging.verify.passed` for that commit publishes without a reason. Failed,
  superseded, unknown, missing, or an unreadable lookup all refuse with 409
  `staging_not_verified` (fail closed) and a `production.publish.blocked` event.
  TEST: services/gateway/test/services/testing/publish-gate.test.ts
  TEST: services/gateway/test/vtid-04646-publish-gate-wiring.test.ts
AC-3: `override_reason` of at least 10 characters lets the publish through; the reason,
  the gate status and the verification ride on `production.publish.requested`, and a
  separate `production.publish.verification_overridden` event is emitted.
  TEST: services/gateway/test/vtid-04646-publish-gate-wiring.test.ts
AC-4: The gate runs before the bake check, the VTID allocation and the dispatch, so a
  refusal leaves nothing behind.
  TEST: services/gateway/test/vtid-04646-publish-gate-wiring.test.ts
AC-5: Both Command Hub publish buttons prompt for the reason on 409 and retry once;
  cancel keeps the refusal. `PUBLISH_REQUIRE_STAGING_VERIFY=false` is the kill switch.
  TEST: services/gateway/test/vtid-04646-publish-gate-wiring.test.ts

## Not verified here

A real publish is a production action and is not exercised. The first PUBLISH after this
deploys is the live check: it should go through on a verified commit and ask for a reason
on an unverified one.

OASIS_PROOF: `production.publish.blocked` is emitted on every refusal and `production.publish.verification_overridden` on every override, both declared in `src/types/cicd.ts`; pinned by services/gateway/test/vtid-04646-publish-gate-wiring.test.ts (event emission and type declaration) and the gate decisions by services/gateway/test/services/testing/publish-gate.test.ts (15 passed).
