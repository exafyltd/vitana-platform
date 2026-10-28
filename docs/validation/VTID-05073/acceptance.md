# VTID-05073 — Phase 1 acceptance: Operator Console pilot extraction

Sparred plan `502eb294…dec5` (CONVERGED, owner-approved 2026-10-11). This is a
mechanical move: 90 top-level function declarations cut from `app.js` and pasted
unchanged, in original order, into `operator-console.js` (loaded before `app.js`).
No renames, no logic edits, no wrappers; top-level statements stay in `app.js`.

## Numbers
- Moved functions: **90** (16 `renderOperator*` seeds + 74 exclusive callees pulled in by the fixpoint).
- `app.js`: 2,518,123 → 2,321,139 bytes (−196,984 bytes).
- `operator-console.js`: 197,320 bytes (192.7 KB; under the 350 KB guard).
- Top-level function set across the bundle: unchanged (proved by test).

## Acceptance criteria

AC-1 Selection is deterministic: an acorn-based script seeds `renderOperator*`, takes the exclusive-callee fixpoint with string-literal exclusion, stays app.js-only, and emits the 90-function list byte-identically on re-run.
TEST: node scripts/dev/select-extraction.mjs (re-run byte-identical) AND npx jest test/command-hub/vtid-05073-operator-console-extraction.test.ts -t "case b"

AC-2 The 90 functions are moved unchanged (AST-identical, original order) into `operator-console.js`, which is registered in `modules.json` and `index.html` with its `<script>` tag before app.js; both files pass `node --check`.
TEST: npx jest test/command-hub/vtid-05073-operator-console-extraction.test.ts -t "case a" AND -t "case c"

AC-3 The top-level function set across the whole bundle is unchanged by the move (each moved function is gone from app.js and present exactly once in operator-console.js; no function is declared in two bundle files).
TEST: npx jest test/command-hub/vtid-05073-operator-console-extraction.test.ts -t "case b" AND npx jest test/command-hub/vtid-05072-bundle-manifest.test.ts -t "case 2"

AC-4 Cache-bust and guards are consistent: `index.html` carries `?v=20261116-vtid-05073` for app.js/operator-console.js/styles.css, the ownership guard allowlists VTID-05073, and the symbol index regenerates in sync.
TEST: node scripts/generate-command-hub-symbol-index.mjs --check (outputs/symbol-index-check.log) AND npx jest test/command-hub/vtid-05072-bundle-manifest.test.ts -t "case 4"

AC-5 All command-hub string-pin suites pass with assertion text unchanged after the coupled reads are re-pointed through the shared bundle helper.
TEST: npx jest test/command-hub (outputs/jest-command-hub.log — 44 suites / 821 tests, no assertion text edited)

## Plan item → proving check

| Plan item (KIRO-INSTRUCTIONS §2 / plan.md) | Proof |
|---|---|
| 1. Ledger → `in_progress` | Attempted via gateway with the service token. The gateway exposes no status-PATCH endpoint for the ledger (404); per the gateway-auth rule I did not fall back to an unauthenticated or Supabase-direct write. Noted in the PR body (best-effort, non-blocking). |
| 2. Selection script (acorn, seeds `renderOperator*`, fixpoint, string-literal exclusion, app.js-only) | `scripts/dev/select-extraction.mjs`; output `docs/validation/VTID-05073/moved-functions.json` (90 fns, each with original app.js line). Deterministic (re-run byte-identical). |
| 3. Mechanical move → `operator-console.js`; manifest entry `extracted` before app.js; `<script>` tag before app.js | `vtid-05073-operator-console-extraction` AST-identity test (case a) + function-set invariance (case b) + gone-from-app/once-in-operator (case c); `node --check` on both files. `modules.json` + `index.html` updated. |
| 4. `?v=` bump; ownership-guard allowlist; symbol-index regen | `index.html` app.js + operator-console.js + styles.css at `?v=20261116-vtid-05073`; `command-hub-ownership-guard.js` `ALLOWED_VTID_PATTERN` includes `VTID-05073` (guard run PASSED); `node generate-command-hub-symbol-index.mjs --check` in sync (1036 fns / 16 files). |
| 5. Proof test (AST-identity per fn, set invariance, Phase 0 guards, mutation rejection) | `test/command-hub/vtid-05073-operator-console-extraction.test.ts` (185 assertions green), with the base-commit fixture `test/command-hub/fixtures/vtid-05073-app.base.js`. |
| 6. String-pin migration (only coupled reads switch to the bundle; no assertion text changed) | Full `jest test/command-hub` green (44 suites / 821 tests). Coupled files re-pointed: see "Pin migration" below. |
| 7. Local checks all green; logs in `outputs/` | `tsc --noEmit` ✓; `jest test/command-hub` 821/821 ✓; `test:roles` 105/105 ✓; `test:support` 87/87 ✓; symbol-index `--check` ✓; build (tsc + manual dist copy on Windows) + golden fingerprint PASSED ✓; ownership guard PASSED ✓. `test:operator` 63/64 — the one failure is a Windows-only path-separator artifact (see below), not the extraction. |
| 8. Evidence + acceptance.md | this file + `moved-functions.json` + `plan-sparring.md` + `outputs/`. |

## Pin migration (step 6) — coupled reads re-pointed, assertion text unchanged

- Added one shared helper to `test/command-hub/bundle.ts`: `extractedOperatorBlock(startSig, endSig, provided[], alsoInclude[])`. The old eval-based pins sliced a contiguous `app.js` region (`operatorThreadEngine … renderOperatorLiveTranscript`) and `new Function(BLOCK + 'return {…}')`'d it. The extraction split that region: the **function declarations** moved to `operator-console.js`, the interleaved top-level **module `var`s** (e.g. `_kiroKeyRequested`, `KIRO_STOPPED_EARLY_STATUSES`) and a sibling helper (`resetKiroKeyState`) stayed in `app.js`. The helper rebuilds the original executable slice: extracted functions + the referenced app.js bindings not already supplied as eval params. Behaviour identical; no assertion changed.
- Boundary re-point: `vtid-04869` / `vtid-04876` `overviewRegion()` end marker `fetchOperatorTaskQueue` (moved) → `stopOperatorEventStreamRefresh` (the next staying function) — same staying-code slice.
- Bundle-sourced reads (moved code): `vtid-04437` (dismiss/delete/archive thread + the eval BLOCK), `vtid-04975`/`vtid-04984`/`vtid-04999`/`vtid-05003`/`vtid-05064` (the Kiro eval block + moved call-site source checks), `vtid-05067` (engine switch / model picker / Kiro host / composer image wiring), `vtid-05069` (two PipelineTree hooks; count taken from `operator-console.js`), `vtid-05071` (thread-row waiting badge), `t10-r2` (composer attachment chip), `t10-r3` ("View task details:" row), `t10-r4` (`renderOperatorOverlay` only), `vtid-04887` (Dashboard/Runbook pipeline-summary fetch count).
- Reads left on `app.js` (code that did NOT move): e.g. `switchOperatorThread`, `initOperatorChatSession`, `doLogout`, `attachModalA11y`, `renderTaskDrawer`, `st.engine === 'kiro'`, the `m.meta` / `msg.kiroMeta` restores.
- Exact-version pins updated to the new `?v=` literal only (required by the existing coupling/exact-version pins once the bump is applied; the orchestrator approved the literal-string update, mechanical consequence of the required bump): `vtid-05067`, `vtid-05069`, `vtid-05071` (app.js + styles.css version strings). The monotonic `>=` pins (`vtid-04869`…`vtid-05064`, max `20261110-vtid-05064`) and the styles.css↔app.js coupling pins pass unchanged because `20261116-vtid-05073` ≥ every pinned date and app.js/styles.css now share the string.

## Decisions taken

- **escapeHtml duplicate — frozen (inherited from VTID-05072).** Two copies exist: `app.js` has the secure version (escapes single and double quotes); `intelligence-panels.js` has the insecure version (does NOT escape quotes). `intelligence-panels.js` loads **after** `app.js`, so its copy replaces app.js's across the whole page. Removing the insecure copy fixes a real security bug and therefore gets its own VTID. This extraction does **not** touch `intelligence-panels.js`, `app.js`'s escapeHtml, or the `?v=` of either beyond the pilot bump. The Phase 0 duplicate guard still allowlists exactly `{app.js, intelligence-panels.js}` and can only shrink.
- **Cache-bust version.** The step prompt's literal `?v=20261012-vtid-05073` predated the repo's current `app.js` version (`20261115-vtid-05077`) and would have regressed the cache-bust string and broken the monotonic / coupling / exact-version pins. The version is **`20261116-vtid-05073`** for `app.js`, `operator-console.js` and `styles.css` (styles.css tracks app.js per the coupling pins) — the string is required by the existing monotonic/coupling/exact-version pins (it must be ≥ the current `20261115-vtid-05077`), not a free choice. The orchestrator approved updating the version-string literal in the three exact-version pins to this required value; no other assertion text changed.
- **Pin boundary re-pointing (step 6).** The eval-based Kiro pins were re-sourced through a single `bundle.ts` helper rather than per-test ad-hoc reconstruction, so the original contiguous-slice behaviour is reproduced exactly and the change stays mechanical.

## Known environment-only failure

`test:operator` (`vtid-04465-operator-pipeline-regression`) → 1 failure in
"the runner jest targets include every suite that names app.js". The runner's
`selectAssetReferencingTests` builds target paths with `path.relative`, which on
**Windows** emits `test\command-hub\cache-bust-pin.test.ts` (backslashes) while
the assertion expects the POSIX `test/command-hub/cache-bust-pin.test.ts`. Both
expected suites are present; only the separator differs. This is a Windows-only
artifact in the runner's own code, unrelated to the Operator Console extraction
(the suites named in the assertion are untouched). CI (Linux) is the final judge.
