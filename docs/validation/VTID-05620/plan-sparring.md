# Plan sparring record: Command Hub PUBLISH is not gated on STAGING-VERIFY (VTID-05620)

Plan hash (sha256 of the text between the plan markers): 3dcfbd8ca387b375318554d1c3d84c885be83c5c1a833196dcfda64b5cf6c340

Sparring partner: independent plan-sparring-partner agent, read-only, two rounds.
Round 1: NOT CONVERGED (F1 dead overridden branch, F2 CLAUDE.md rules 46-50 contradict the code, plus minors). Round 2: CONVERGED; F2 acknowledged as a tracked follow-up for owner approval; F7 test header nit fixed.
Owner decision (2026-11-08): remove the gate for PUBLISH.

## Final plan

<!-- plan:begin -->
## Problem
Command Hub PUBLISH (POST /api/v1/operator/publish, AWS flow publishAwsFlow) refuses with 409 staging_not_verified unless the
latest STAGING-VERIFY run for the staging commit passed (VTID-04646). The owner wants PUBLISH to go straight to production
without a verification check or a written override reason, as a deliberate simplification.

## Change
1. In publishAwsFlow, replace the gate block (operator.ts ~2202-2225) with:
   - `verified = await evaluatePublishGate({ commit: stagingCommit, service: 'gateway' })` (the record is still read),
   - `gate = { ...verified, allowed: true }`,
   - if `!verified.allowed`, emit `production.publish.gate_skipped` (OASIS, warning) with the verification record and reason,
   - the flow continues unchanged: bake check, VTID allocation, workflow dispatch.
2. (Removed from plan: OVERRIDE_REASON_MIN is not imported in operator.ts; no import to drop.)
3. Declare `production.publish.gate_skipped` in types/cicd.ts. The dead `production.publish.verification_overridden` branch (overridden status is unreachable without an override reason) and its override_reason payload fields are removed.
4. Update test/vtid-04646-publish-gate-wiring.test.ts: the refusal/override assertions become assertions of the new contract
   (no 409 refusal, the skipped-gate event). This is a deliberate contract change, stated here, not a loosened assertion.
5. evaluatePublishGate itself (services/testing/publish-gate.ts) is not changed; its own tests stay as they are.

## Not changed
- CLAUDE.md rules 46-50 (both repos) still describe STAGING-VERIFY as blocking PUBLISH. This change does not amend them. The amendment is a tracked follow-up that the owner must approve, because it changes a standing rule. Until then the rules and the code disagree, and the gate_skipped events are the audit trail.
- `PUBLISH_REQUIRE_STAGING_VERIFY` now only controls whether gate_skipped fires. It no longer blocks anything.
- The voice caller dev_publish_to_prod (services/orb-tools/deployment-release-tools.ts) also benefits from the change: it gets an ungated publish too. Intended.
- The Command Hub prompt code (command-hub-staging.js postPublish) stays in place. With no 409 it is never reached.
- The frontend publish leg and the bake check are unchanged.

## Test plan
- Round 2 change: the dead overridden branch is removed; the test is renamed to describe the retired prompt.
- services/gateway: `npx jest test/vtid-04646-publish-gate-wiring.test.ts test/services/testing/publish-gate.test.ts` (25 pass, run).
- `tsc --noEmit` for services/gateway (clean, run with an 8 GB heap).
- Not verified: a real PUBLISH on staging or production.

## Risk
Production publishes no longer wait for a passing STAGING-VERIFY. This is the owner's explicit decision (2026-11-08). The
evidence event keeps every ungated publish findable.
<!-- plan:end -->
