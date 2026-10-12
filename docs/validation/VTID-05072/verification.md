# VTID-05072 Phase 0 — verification note (for the reviewer)

Read this instead of re-running the suites. Branch `kiro/vtid-05072-appjs-manifest`,
base origin/main c69d521d. Environment: Windows, Node v24.11.1 (CI pins Node 20.x).
`core.autocrlf=input` (owner-authorized) and the worktree renormalized to LF before testing.

## Exactly what was run (STEP 5 / plan §1.7)
From `services/gateway`:
- `npx tsc --noEmit` → PASS, exit 0 (outputs/tsc.log)
- `npx jest test/command-hub` → PASS, 43 suites / 636 tests (outputs/jest-command-hub.log)
- `npx jest test/command-hub/vtid-05072-bundle-manifest.test.ts` → PASS, 16 tests (outputs/jest-vtid05072-only.log)
- `npm run test:operator` → 63 passed, 1 failed* (outputs/test-operator.log)
- `npm run test:roles` → PASS, 105 tests (outputs/test-roles.log)
- `npm run test:support` → PASS, 4 suites / 87 tests (outputs/test-support.log)
- `node scripts/generate-command-hub-symbol-index.mjs --check` → PASS, in sync, 1106 functions / 15 files (outputs/symbol-index-check.log)

From repo root (after `tsc` + a Windows robocopy of src/frontend/command-hub → dist/frontend/command-hub,
because `npm run build` uses POSIX `rm`/`mkdir -p`/`cp -r` that do not run under Windows cmd):
- `node scripts/ci/command-hub-golden-fingerprint.js` → PASS, 8 bundle files, all 6 markers (outputs/golden-fingerprint.log)
- `node scripts/ci/command-hub-ownership-guard.js` → PASS, VTID-05072 allowlisted (outputs/ownership-guard.log)

\* The one `test:operator` failure ("the runner jest targets include every suite that names
app.js") is a pre-existing Windows-only path-separator artifact (runner emits
`test\command-hub\...` where the assertion expects `test/command-hub/...`). Verified
pre-existing by stashing ALL VTID-05072 changes and re-running on the clean base: identical
63 passed / 1 failed, same backslash string. Independent of this change; passes on CI (Linux).

## Pass/fail counts
- command-hub jest: 43 suites, 636 tests, 0 failures (LF checkout).
- All 38 pre-existing string-pin suites pass UNCHANGED (no pin test was edited).

## Explicit statements
- **app.js was NOT modified.** `git status` shows no change to
  `services/gateway/src/frontend/command-hub/app.js` (nor index.html, styles.css, or any
  served `?v=`). Confirmed by stashing all changes and diffing against the clean base.
- **All 38 string-pin tests pass UNCHANGED** on an LF checkout; none was migrated (plan §1.5
  item 5 — no pin migration in Phase 0).
- **New symbol-index file list** (specs/command-hub-symbol-index.json) now covers 15 files and
  INCLUDES both `pipeline-tree.js` and `kiro-console.js`, while retaining every one of the 11
  files indexed before this change: app.js, orb-widget.js, command-hub-staging.js,
  intelligence-panels.js, orb-voice-bench.js, watcher.js, intent-engine.js,
  intelligence-cockpit-nav.js, intent-moderation.js, voice-budget.js, navigation-config.js.
- **escapeHtml duplicate is frozen, not removed** (see acceptance.md "Decisions taken"):
  guard case 2 allowlists exactly `escapeHtml` → {app.js, intelligence-panels.js}, fails on any
  other duplicate / a changed file set / the duplicate disappearing while the entry remains,
  and proves it still catches a NEW duplicate via an inline-string fixture. The
  intelligence-panels.js copy's missing quote-escaping is a security bug deferred to its own VTID.

## Ledger
See the PR body "Decisions taken" / Handoff: ledger update outcome recorded there.

PR URL: https://github.com/exafyltd/vitana-platform/pull/4037 (draft)

## Production closeout

- **STAGING-VERIFY passed:** run [38236989335](https://github.com/exafyltd/vitana-platform/actions/runs/38236989335), gateway @ `c6100f80`, 17/17 tests green, change suites VTID-05072 and VTID-05074. The pnpm-lock commit `9358d991` was handled by the VTID-05075 lockfile exemption (first-parent commit judgment).
- **Production published** at commit `c6100f80`. Commits `a294dad5`, `3743dff5`, and `97bfacc1` are all ancestors of what production serves now (`475e7e43`).
- **Gate 2:** not required — production was published by the owner while the STAGING-VERIFY fix (VTID-05075) was being merged; the staging suite was green at publish time.
- **Outcome:** success. VTID-05072 (Phase 0 — manifest + guards, no code moves) is complete and in production.
- **Ledger:** terminalized with `outcome=success`.
