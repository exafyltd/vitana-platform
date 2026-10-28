# Plan sparring record - VTID-05075

Plan hash (sha256 of the text between the plan markers): `19fbc9abfc4601f85fdfde39e918d8125e07b3e02f555b3d9d98f831255b0db3`. Partner: plan-sparring-partner (read-only, independent, Claude Opus on Bedrock per CLAUDE.md rule 53), 2 rounds, CONVERGED (standard class). Owner approval: in session 2026-10-12, "yes" in answer to the Gate 1 message (final plan, both rounds' findings, the files, the test plan). The gate is in log mode; the session is recorded here and in the ledger row.

Round 2 (partner, summary): F1 (major, run.mjs would drop the exempted commits from the record and log), F2, F3, F4 closed; F5 acknowledged; no new blocker or major findings; verdict CONVERGED.


Change class: standard (CI gate that guards production publishing)
Repo: exafyltd/vitana-platform
Scope (files): scripts/ci/staging-verify/lib.cjs, scripts/ci/staging-verify/run.mjs (persist and log the new field), scripts/ci/staging-verify/lib.test.cjs, docs/DEPLOYMENT-PIPELINE.md (one sentence next to the rule-47 prose around line 147), docs/validation/<VTID>/*

<!-- plan:begin -->
## Problem (verified)
STAGING-VERIFY for gateway @ c6100f80 failed on 2026-10-12 with 17/17 tests passing and one reason: "Missing change suite (rule 47)" for commit `9358d991` ("chore(gateway): sync pnpm-lock.yaml with acorn 8.15.0 devDependency"). That commit changes `services/gateway/pnpm-lock.yaml` (3 lines) and two files under `docs/validation/VTID-05072/outputs/`; its subject carries no VTID, so `planRange` (`scripts/ci/staging-verify/lib.cjs:198-229`) files it under `missing` (line 210), and `decideOutcome` (line 325-328) turns any `missing` into `failed`.
It cannot be fixed by tagging: `planRange` reads each commit's own subject (`extractVtids(c.subject)`, line 209), and history cannot be rewritten. VTID-05072's two attempts (`4d090146`, `3743dff5`) added later commits, which does not change the subject of `9358d991`. Production is `c69d521d`; the unverified range to the verified commit holds five commits (four from VTID-05072, one from VTID-05074). Production cannot move without a passing verification, so every publish from main is blocked until this commit stops counting as "missing". STAGING-VERIFY runs on 97bfacc1 failed three times since 08:38 UTC for the same reason (runs 38224730860, 38228482633).

## Change
In `planRange`, treat a commit as **lockfile-only** when, after dropping every file that is not part of the service's build (`touchesService([f], service)` false), at least one file remains and ALL remaining files are `pnpm-lock.yaml` (basename match, any directory). A lockfile-only commit:
- is not added to `missing` or `legacy` and needs no VTID or change suite;
- is returned in a new array `plan.lockfileOnly` (`{sha, subject}`), still counted in `plan.relevant` and in the "What would ship" list, never hidden;
- is named in the ready/failure message under its own heading: "Lockfile-only changes (no change suite; smoke tests only): <sha subject>…".
Everything else is unchanged: a commit with a lockfile AND any other build file still needs its VTID and suite; community-app lockfiles (`package-lock.json`, `bun.lock`) are NOT exempt (deliberately: the pnpm gateway lockfile is the observed case; widening is a separate decision); a docs-only commit is already ignored (not in deploy paths).
The detection is an exported predicate `isLockfileOnlyCommit(files, service)` in lib.cjs (exported so edge cases are unit-tested directly), used by `planRange`. `run.mjs` persists `lockfile_only: plan.lockfileOnly` in the results record (next to `missing`/`invalid`, so the audit trail in results.json and the OASIS event shows every exempted commit) and logs `lockfileOnly=<n>` on its range line. DEPLOYMENT-PIPELINE.md gets one sentence beside the existing "no suite, no merge" prose (~line 147): a commit whose only build-relevant change is `pnpm-lock.yaml` is listed in the verification message as lockfile-only and needs no change suite. No change to `decideOutcome`, to what runs against staging, or to the production baseline logic.

## Why this is safe enough, and what it accepts
- A lockfile changes which dependency versions are installed, so a lockfile-only commit can alter the deployed build without a dedicated suite. It is still covered by the service smoke suite and every other change suite in the range on the exact deployed commit (that is what a verification run is), and it is listed by name in the message the owner approves at Gate 2. The owner sees every lockfile-only commit that ships.
- The exemption is mechanical and narrow (one filename, no VTID text parsing, no trailer or label a committer could add to bypass the rule).
- Rule 47's intent ("no suite, no merge") is about behaviour changes; a lockfile sync that follows a `package.json` change is the same change's dependency bookkeeping.

## Tests (node --test, scripts/ci/staging-verify/lib.test.cjs, already run in CI by STAGING-TESTS-REQUIRED.yml:33)
1. a gateway commit touching only `services/gateway/pnpm-lock.yaml` (no VTID, enforced date) is not in `missing`, is in `lockfileOnly` and in `relevant`;
2. the real shape of 9358d991 (`pnpm-lock.yaml` + two `docs/validation/**` files) is lockfile-only;
3. a commit touching the lockfile AND `services/gateway/src/x.ts` with no VTID is still `missing`;
4. a commit touching the lockfile and a file in a manifest-less VTID stays `missing`/`legacy` as before;
5. community-app: a `package-lock.json`-only commit with no VTID is still `missing`;
6. `buildReadyMessage` for a passing run lists lockfile-only commits under their own heading and still ends with the "yes promotes exactly this commit" line; a failing run with another missing commit lists both;
7. a commit touching two `pnpm-lock.yaml` files (e.g. `services/gateway/pnpm-lock.yaml` and `services/gateway/sub/pnpm-lock.yaml`) and nothing else is lockfile-only; direct tests of `isLockfileOnlyCommit` (empty file list, docs-only list, lockfile+docs, lockfile+source);
8. existing tests unchanged and green; `run.mjs` is exercised by a small test that the record carries `lockfile_only` (or, if run.mjs has no test seam, asserted by reading the serialized record shape in lib.test.cjs).

## Rollout and evidence
PR -> CI (STAGING-TESTS-REQUIRED runs lib.test.cjs) -> merge. The runner is checked out from main at run time (STAGING-VERIFY step "Checkout runner (vitana-platform main)"), so after merge the verification is re-dispatched (`workflow_dispatch`) for gateway at c6100f80; expected outcome: passed, with 9358d991 listed as lockfile-only. No service deploy is triggered by this change (scripts/ci is outside the gateway deploy paths). Rollback: revert the PR; no data or runtime state involved.

## Non-goals
No change to rule 47's text beyond one sentence in DEPLOYMENT-PIPELINE.md; no exemption for any other file type; no change to VTID-05072's own work or to production publish tooling.
<!-- plan:end -->


## Planner responses (round 1)
- F1 [major]: ACCEPTED. `run.mjs` is in scope; the record gains `lockfile_only: plan.lockfileOnly` and the range log line gains `lockfileOnly=<n>`.
- F2 [minor]: ACCEPTED. Two-lockfile test added (test 7).
- F3 [minor]: ACCEPTED. The sentence is specified and placed beside the "no suite, no merge" prose near DEPLOYMENT-PIPELINE.md:147.
- F4 [minor]: ACCEPTED. The predicate is a separate exported helper, `isLockfileOnlyCommit(files, service)`, so edge cases are tested directly; the export list at lib.cjs:407-429 gains it.
- F5 [minor]: NOTED. The heading appears in passing and failing messages (test 6).
- Q1: answered under F1. Q2: answered under F4.
