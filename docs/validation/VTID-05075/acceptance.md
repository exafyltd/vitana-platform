# VTID-05075 — STAGING-VERIFY: a lockfile-only commit needs no change suite

Owner decision 2026-10-12 ("do what you recommended", then "yes" at Gate 1 on the sparred plan). Sparring: `plan-sparring.md` (standard class, 2 rounds, CONVERGED).

Problem: STAGING-VERIFY for gateway @ c6100f80 failed with 17/17 tests passing and one reason, "Missing change suite (rule 47)" for commit 9358d991 ("chore(gateway): sync pnpm-lock.yaml with acorn 8.15.0 devDependency"): no VTID in its subject, only `services/gateway/pnpm-lock.yaml` in the build. Its subject cannot be fixed (a later tag commit does not change it), and production cannot move without a passing verification, so every publish from main was blocked.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: not applicable (CI script change; no route, no service deploy; scripts/ci is outside the gateway deploy paths).

FINAL_URL: not applicable (no deployed surface). Evidence is the STAGING-VERIFY re-run for gateway @ c6100f80 after merge, expected `staging.verify.passed` with 9358d991 under "Lockfile-only changes".

OASIS_PROOF: the verification result event (`staging.verify.passed|failed`, written by the STAGING-VERIFY workflow) now carries `lockfile_only` in its record; asserted in scripts/ci/staging-verify/lib.test.cjs ("run.mjs records and logs the lockfile-only commits").

CURL_PROOF: not applicable (no endpoint).

## Acceptance criteria

AC-1: A commit with no VTID whose only build-relevant file is `pnpm-lock.yaml` (docs and other non-build files ignored, any number of lockfiles) is not `missing` or `legacy`; it is returned in `plan.lockfileOnly` and still counted in `plan.relevant`.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-2: The real shape of 9358d991 (lockfile + two docs/validation files) is lockfile-only and the outcome is `passed`.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-3: A lockfile commit that also changes any build file, any other no-VTID build commit, a lockfile commit naming a VTID without a manifest, and community-app `package-lock.json` / `bun.lock` commits stay `missing`; the outcome stays `failed`.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-4: The ready message lists lockfile-only commits under "Lockfile-only changes (no change suite; smoke tests only)" in a passing and a failing run, keeps the "A yes promotes exactly this commit" line on a pass, and callers without the field still work.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-5: `run.mjs` persists `lockfile_only` in the results record and logs `lockfileOnly=<n>`; DEPLOYMENT-PIPELINE.md states the exception beside the "no suite, no merge" rule.
  TEST: scripts/ci/staging-verify/lib.test.cjs

## Accepted risk
A lockfile can change installed dependency versions, so a lockfile-only commit can alter the deployed build without its own suite. It is still covered by the smoke suite and every other suite on the exact deployed commit, and it is named in the message the owner approves at Gate 2. The exemption is one filename and cannot be bypassed with a label or trailer.

## Limits
Verified locally with `node --test scripts/ci/staging-verify/lib.test.cjs` (30 tests). The re-run of STAGING-VERIFY for c6100f80 happens after merge (the runner is checked out from main at run time).
