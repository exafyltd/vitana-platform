---
change_class: standard
---
# plan(sv-05308-coverage): add the missing VTID-05308 staging suite so gateway STAGING-VERIFY passes
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610281440-d785` (Kiro Web). Repo: `exafyltd/vitana-platform`.
Premises pinned to `origin/main` `ad6b081d96`.
<!-- plan:begin -->
## 1. Goal
Owner task 2026-10-28: finish the staging-verification assessment and complete authorized staging work. Gateway
STAGING-VERIFY failed on the deployed commit for a governance reason, not a behaviour failure. This plan adds the one
missing artifact so verification can pass, within the staging scope.

## 2. Today (evidence)
- Gateway STAGING-VERIFY run 40696019445 (2026-10-28T13:23Z) on the deployed gateway commit `1f0a8cf669d7` **failed**.
  The smoke suite passed 13/13 and every change suite that ran passed (VTID-05310, 05324, 05270, 05335, 05267, 05309,
  05311, 05312, 05268). The failure is: `Missing change suite (rule 47 — no suite, no merge): 3d3b4e6f1747 VTID-05308`.
- `3d3b4e6f` (#4423, `fix: VTID-05308 fix staging-test + loop-catalog regressions from merged lanes`) is in the
  production→staging range (`a2d069ea0385` → `1f0a8cf669d7`). It changed three files only:
  `docs/validation/VTID-05082/staging-tests.json`, `services/gateway/specs/loop-catalog-v1.json`,
  `services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts` (`git show 3d3b4e6f --stat`).
- `docs/validation/VTID-05308/` exists on `origin/main` (acceptance.md, commands.log, contract.md, outputs/) but has
  **no `staging-tests.json`** (`git ls-tree origin/main -- docs/validation/VTID-05308`).
- `scripts/ci/staging-verify/run.mjs:203` (`loadManifest`) loads `docs/validation/<VTID>/staging-tests.json`, and the
  verify flow fails when a VTID in the range has none: `planRange` puts it in `missing`, and `lib.cjs:508`
  (`decideOutcome`) returns `'failed'` when `plan.missing.length > 0`. (`run.mjs:501` is the separate pre-merge
  `checkPr` path.) `docs/validation/commit-coverage.json` is only for commits **without** a VTID in their
  subject (`_doc`), so it does not apply: #4423's subject carries `VTID-05308`.
- #4423's own changes are all CI-proven and deploy nothing of their own (a test file, a loop-catalog JSON entry, an
  edited staging-tests.json). The correct suite is read-only: a rejected-write probe plus an `existing` ref that
  re-runs the gateway jest suites #4423 fixed.

## 3. Change — one lane `suite` (vitana-platform)
Add `docs/validation/VTID-05308/staging-tests.json` with the top-level fields `"vtid": "VTID-05308"`,
`"service": "gateway"` and `"tests": [...]` (the shape `validateManifest` requires, `lib.cjs:211-214`; it rejects a
manifest whose `vtid` differs or is absent):
- one `http` rejected-probe check against an existing authenticated gateway route (GET/HEAD or a rejected POST,
  `expect_status: 401`, nothing written) — the mandatory read-only staging probe;
- one `existing` ref: `cwd: services/gateway`, `npx jest test/loop-catalog.test.ts
  test/vtid-04868-plan-sparring-session-layer.test.ts` — the two suites #4423 fixed — with a `reason` that these are
  CI-proven source checks (a loop-ownership catalog check and a CLAUDE.md rule-text check), never a staging write.
It validates against `scripts/ci/staging-verify/run.mjs` / `lib.cjs` (`kind`, `service`, `target`, `rejected_probe`,
`expect_status`, `ref`, `cwd`, `reason`). The lane is `docs/validation/**` only — not a governance path — so
`executor: kiro` with the reviewer agent.

## 4. Tests
- `python3 -m json.tool docs/validation/VTID-05308/staging-tests.json` parses.
- `node scripts/ci/staging-verify/run.mjs --validate-only` (or the manifest loader it exports) accepts it; if no such
  flag exists, a `node -e` that requires the loader and asserts no `__parseError` and the required keys.
- The two referenced jest suites pass locally in `services/gateway` (they are green on `main` since #4423): recorded
  in `docs/validation/VTID-05308/commands.log` (appended; the file already exists).
- Red→green: before this change, `loadManifest(repoRoot, 'VTID-05308')` returns `null`; after, it returns the parsed
  suite. A one-line `node -e` test records both.

## 5. After merge (staging scope)
Once merged to `main`, dispatch `AWS-STAGE-DEPLOY-GATEWAY.yml` for the new `main` HEAD (§7d). STAGING-VERIFY then runs
automatically on the deployed commit; VTID-05308 is no longer missing, so the gateway run passes if every suite passes.
This is the task's STAGING-VERIFY endpoint. (The intermittent `public.ecr.aws` 429 can still fail a given deploy
attempt; re-run the deploy under §7d until it builds. The durable 429 fix is the separate `ci-ecr-public-auth` lane,
VTID-05328, which needs an IAM change and is out of this plan's scope.)

## 6. Unchanged
No code, no workflow, no governance path, no protected gate file. #4423 and its three files stay as merged. Deploys
nothing of its own (a `docs/validation/**` change); its endpoint is the gateway STAGING-VERIFY pass above.

## 7. Risks
- A referenced jest suite could be flaky on the staging runner. Both are pure source/text checks with no network, so
  they do not depend on staging state. If one is red on `main` independently, that is a separate fix, raised not
  routed around.
<!-- plan:end -->
