---
slug: staging-verify-runner-fix
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-10-22T12:20Z
spar_refs:
  - exafyltd/vitana-v1: main
sparring_record: .kiro/specs/staging-verify-runner-fix/sparring/verdict.md
vtids: [VTID-05333, VTID-05334]
---
# Handoff — STAGING-VERIFY: runner image, native suite commands, bundle profile
Owner, 2026-10-22 (Kiro Web): "ok, let's fix the verification first". This unblocks Gate 2 for VTID-05330 (vitana-v1
`3d144939`). Plan block: `plan.md`. Lanes: `lanes/runner.md` (vitana-platform), `lanes/manifests.md` (vitana-v1,
depends on `runner`).

## Log
### 2026-10-22T11:00Z · kiro-exafyltd-202610220818-5273 · created → drafted
Holder of the `staging-verify-runner-fix/_plan` claim. Read the failed run 39757004449, `STAGING-VERIFY.yml`,
`scripts/ci/staging-verify/{run.mjs,lib.cjs}`, the VTID-05298/05296 manifests and NATIVE-CI on main. Decision taken:
lane `runner` gets `seat: exafyltd` although `scripts/**` maps to `platform` (seat `exafy`), because the owner asked
this session to run the fix end to end and the lane is mixed (`.github/**` is not in any specific area). No VTID
allocated, no live system touched.
Next: PLAN-SPAR spars the `plan(staging-verify-runner-fix)` PR; this session answers each round.

### 2026-10-22T11:14Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 2 lane(s) got a VTID and are handed to Kiro.

### 2026-10-22T11:15Z · kiro-exafyltd-202610220818-5273 · approved (builder notes)
Converged round 2 (policy `converged-auto-v1`); VTID-05334 `runner`, VTID-05333 `manifests`. Builder notes from the
minor round-2 findings: R2-F1 — the deploy trigger `paths` block is `AWS-STAGE-DEPLOY-FRONTEND.yml` lines 36-54, with
no `docs/**`. R2-F2 — `workflow.test.cjs` is run by no CI job; the `runner` lane runs it locally and records the output
in its PR; adding it to `STAGING-TESTS-REQUIRED.yml` is outside this plan's lane paths (follow-up).

### 2026-10-22T12:20Z · kiro-exafyltd-202610220818-5273 · approved (both lanes merged; verification pending)
Owner instruction 2026-10-22: "yes, merge #4311 and #1491" (§7b owner-named set; reviewer agent not available in this
session, no model substituted).
- `runner` merge: vitana-platform `264979207baff35ae97b2249d76c715e76276321` (#4311).
- `manifests` merge: vitana-v1 `3b446e6fc9ab04d15970c43e2cc2612066974f73` (#1491), after M3 held (platform main exports
  `existingEnv`, both manifests validate). Its pr-gate first failed at `Initialize containers` (public.ecr.aws
  "Data limit exceeded" on the postgres service image), then passed on a fresh run.
Correction to plan §"How the fix is verified": a STAGING-VERIFY `workflow_dispatch` on a docs-only head cannot pass —
`confirmLive` (`run.mjs:146-171`) requires the staging stamp to equal the commit or descend from it, and staging still
serves `13bd83a0c`. The valid trigger is a staging deploy of vitana-v1 `main` (`AWS-STAGE-DEPLOY-FRONTEND.yml`,
push or `workflow_dispatch`), which dispatches STAGING-VERIFY for the deployed commit itself. Agents do not dispatch
it (§7a), so it comes from the next app merge or from the owner.
Next: STAGING-VERIFY community-app on the first staging deploy at or after `3b446e6f`; then Gate 2.
