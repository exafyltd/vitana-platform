# VTID-05072 Phase 0 — blocker (RESOLVED by owner decision — historical record)

> RESOLVED. The owner decided both blockers (see acceptance.md "Decisions taken"):
> blocker 2 was CRLF (fixed by `core.autocrlf=input` + LF renormalization — all suites green);
> blocker 1 is handled by FREEZING the escapeHtml duplicate behind a known-duplicates
> allowlist in guard case 2 (deferring its security fix to a separate VTID). This file is
> kept as the original escalation record only.

Date: 2026-10-11 run. Branch `kiro/vtid-05072-appjs-manifest`, base origin/main c69d521d.

## What is implemented (all per plan Phase 0, no code moved out of app.js)
- `services/gateway/src/frontend/command-hub/modules.json` — bundle (8 files, verified against index.html, correct order + kinds) + indexed_only (7 files).
- `acorn` `8.15.0` (exact) added to gateway devDependencies; lockfile regenerated via `npm install` (root dep + node_modules/acorn both 8.15.0).
- `test/command-hub/bundle.ts` — readManifest / readCommandHubBundle / functionDeclarations (acorn, sourceType 'script') + helpers.
- Golden fingerprint (`scripts/ci/command-hub-golden-fingerprint.js`) — now searches the concatenation of every manifest bundle file in dist/.
- GUARDRAILS syntax gate — `node --check` loops over every manifest bundle file (dist + src).
- Symbol index generator — SOURCE_FILES replaced by manifest bundle + indexed_only; regenerated index now covers 15 files incl. pipeline-tree.js and kiro-console.js; all 11 pre-change files retained.
- Ownership guard — VTID-05072 added to ALLOWED_VTID_PATTERN (no other change).
- `test/command-hub/vtid-05072-bundle-manifest.test.ts` — 5 cases per plan 1.5.

## Verification state
- `npx tsc --noEmit`: PASS (exit 0).
- `npx jest test/command-hub/vtid-05072-bundle-manifest.test.ts`: 12 passed, 1 failed.
  - The ONLY failure is case 2 (no top-level function name in two bundle files).

## Blocker 1 — plan case-2 invariant is already violated on main
`escapeHtml` is declared as a TOP-LEVEL `function` in TWO bundle files:
- `app.js:15652` — `function escapeHtml(str)`
- `intelligence-panels.js:736` — `function escapeHtml(text)` (post_app, loaded after app.js; file is NOT an IIFE — it has top-level `const IntelligenceState` and top-level functions)

The plan's required test (1.5 case 2 / plan 4b) asserts no top-level function name appears in two bundle files. It cannot pass on the current bundle. The only fixes change a served file (remove/rename one `escapeHtml`), which:
- edits `app.js` — forbidden by plan 1.6 ("do not edit app.js" in Phase 0), and/or
- changes served output of `intelligence-panels.js` (behaviour change; would need `?v=` bump).

Both are outside Phase 0's "no code moves / no behaviour change" scope and trip the behaviour-change guard. The test is correct; the baseline is dirty.

## Blocker 2 — pre-existing red string-pin suites on main
8 command-hub suites (7 tests) FAIL on the clean base commit c69d521d, independent of this change (verified by stashing all VTID-05072 changes and re-running — identical 105 passed / 7 failed):
- vtid-05064-operator-turn-thread, vtid-04876-overview-cockpit, vtid-04779-voice-section-rebuild,
  escape-html, t10-r4-modal-focus-management, t10-r2-aria-labels-and-input-labels,
  vtid-04642-testing-qa-screens, vtid-04643-run-tests-tab.

The instructions assume all 38 string-pins are green ("must pass UNCHANGED"); they are not on main. Phase 0 moves no code, so it neither caused nor is scoped to fix these; fixing them would require editing app.js (forbidden).

## Options for the owner
1. Allow a one-time, behaviour-preserving removal of the DUPLICATE top-level `escapeHtml` in intelligence-panels.js (identical escaping to app.js's), as part of this PR, with a `?v=` bump for intelligence-panels.js — then case 2 passes. (This is a served-file behaviour-adjacent change; needs explicit approval.)
2. Narrow the plan's case-2 invariant to flag duplicates as a known-exception list seeded with `escapeHtml` (documents the pre-existing debt without editing served code) — a plan deviation; needs approval.
3. Treat Blockers 1 and 2 as pre-existing main debt to be fixed in a separate VTID, and have the owner accept case 2 as a documented known failure for Phase 0.

No files edited to resolve either blocker pending the owner's choice. Nothing committed.
