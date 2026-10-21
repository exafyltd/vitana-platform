# VTID-05076 — STAGING-VERIFY judges each merged change by its first-parent commit

Owner approval 2026-10-12 ("yes" at Gate 1 on the sparred plan). Sparring: `plan-sparring.md` (light class, 2 rounds, CONVERGED).

Problem: `commitsBetween()` listed every commit in the production→verified range, including the branch commits of a PR merged with a merge commit. VTID-05072's PRs #4037–#4039 were merged that way, so a branch commit without a VTID (9358d991) reached rule 47. VTID-05075 exempted pnpm-lock.yaml-only commits; any other untagged branch commit of a merge-committed PR would still block every publish from main.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: not applicable (CI script change; no route, no service deploy; scripts/ci is outside the gateway deploy paths).

FINAL_URL: not applicable (no deployed surface). Evidence is the next STAGING-VERIFY run on main, which lists one entry per landed change.

OASIS_PROOF: not applicable; the verification record keeps its shape and its `shipping` entries gain `branch_commits`.

CURL_PROOF: not applicable (no endpoint).

## Acceptance criteria

AC-1: Squash history: every commit is listed with its own files, exactly as before.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-2: A PR merged with a merge commit is one entry (the merge commit, files = everything it brought into main, `branchCommits` = its branch commits); its untagged branch commit is not listed; rule 47 passes with the merge subject's VTID suite; the ready message shows "(N branch commits)".
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-3: A direct push without a VTID still fails rule 47.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-4: A merge commit whose subject has no VTID fails rule 47.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-5: `commitsBetween` lives in lib.cjs (exported, injectable git runner); run.mjs uses it; DEPLOYMENT-PIPELINE.md says how the range is read.
  TEST: scripts/ci/staging-verify/lib.test.cjs

## Decisions taken
- VTID-05075's lockfile-only exemption (merged by another session the same day) is left unchanged; it is outside this plan. With this change 9358d991 is no longer in the range at all.

## Limits
Verified locally with `node --test scripts/ci/staging-verify/lib.test.cjs` (34 tests, temp git repos with real `--no-ff` merges) and a dry run of the new range on real main (c69d521d..bb8b0064: 5 entries, missing=0).
