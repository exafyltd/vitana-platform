# Plan sparring record — VTID-05072 (Phase 0) / VTID-05073 (Phase 1)

- Sparring id: `plan_sparring_sessions` `00ff7572-aa5b-49e2-9bf3-142339e0c348`
- Plan hash (sha256 of the text between the plan markers): `502eb294fd67c1ebd1de9596d9751c1a53b61bc1e76e63c521052920ebd8dec5`
- Change class: standard · producer: claude-code · partner: plan-sparring-partner (independent, read-only) · 3 rounds · verdict **CONVERGED**
- **Owner approval:** 2026-10-11, Claude Code session https://claude.ai/code/session_019XRHThojRVzYPDzoLtuby6 — "yes, write the plan and instructions for KIRO IDE to execute the plan"
- VTIDs allocated against this record: VTID-05072 (Phase 0), VTID-05073 (Phase 1, starts after VTID-05072 is in production)
- Executor: Kiro IDE

# Plan — Split the Command Hub `app.js` into modules, one area at a time

<!-- plan:begin -->
## Change class
standard for this master plan and its Phase 0 + Phase 1 (pilot). Each later area extraction is its own VTID with its own light-class plan that cites this one.

## Problem (verified 2026-10-11 on main c69d521d)
- `services/gateway/src/frontend/command-hub/app.js` is 2,517,554 bytes / 53,760 lines with 867 top-level function declarations and one global `const state` (app.js:4051). It is a classic script (no bundler; `npm run build` copies the folder to dist, package.json `copy-frontend`).
- It is over GitHub code search's file limit and over repowise's 2,048 KB page limit (`.claude/CLAUDE.md`: "Not indexed: …app.js (2,377 KB, over the 2,048 KB limit)"), so every AI tool (Kiro IDE, the Operator's Kiro, Claude Code) guesses line numbers or shell-greps it. That caused the 2026-10-11 Operator incident (a shell grep needing an approval that timed out) and Kiro's stale-line plans.
- Every Command Hub change edits the same file and the same `?v=` string, so parallel changes collide (three on 2026-10-11: VTID-05063, VTID-05071, the SVG work).
- Precedent that the pattern works: `kiro-console.js` (VTID-05067) and `pipeline-tree.js` (VTID-05069) are separate external files loaded before `app.js` and called through `window.<Name>`.

## Constraints that shape the design
- CSP: external same-origin scripts only, no inline JS, no CDN (CLAUDE.md ALWAYS 36/37) — new files are plain `<script src="/command-hub/<file>.js?v=…">`.
- Classic scripts share one global scope: a top-level `function` declared in a file loaded before `app.js` is callable from `app.js` and vice versa at call time; top-level `const/let` in `app.js` (`state`, …) are visible to other classic scripts at call time (global lexical environment). Code that RUNS at load time must not reference something from a later file.
- Classic-script scope is one-directional at LOAD time: a file loaded before `app.js` cannot touch `app.js`'s `const`/`let` (e.g. `state`, app.js:4051) while it loads (temporal dead zone); inside function bodies the reference resolves at CALL time and works. Hence: extracted files contain only function declarations.
- CI gates that read `app.js` today: COMMAND-HUB-GUARDRAILS.yml — ownership guard (`scripts/ci/command-hub-ownership-guard.js`, VTID allowlist), golden fingerprint (`scripts/ci/command-hub-golden-fingerprint.js:63`, markers searched in `dist/.../app.js` only), bundle syntax gate (`node --check` on app.js, workflow lines 98/109); 38 jest files `readFileSync` `app.js` (string pins); the symbol index generator (`services/gateway/scripts/generate-command-hub-symbol-index.mjs:48-60`) has a hard-coded `SOURCE_FILES` list that today omits `pipeline-tree.js` and `kiro-console.js`.
- No JS parser is a direct dependency (acorn 8.15.0 is only transitive via eslint/espree).

## Phase 0 — enablers (no code moves) — VTID A
1. `services/gateway/src/frontend/command-hub/modules.json`: EVERY script `index.html` loads, in load order, each with `kind`: `extracted` (cut out of app.js by this plan; function declarations only), `module` (self-contained IIFE such as `pipeline-tree.js`, `kiro-console.js`), `app` (`app.js`) `module` also covers `orb-widget.js` (self-contained IIFE loaded before app.js), and `post_app` (loaded after app.js: `voice-self-healing.js`, `voice-supervisor.js`, `intelligence-panels.js`, `command-hub-staging.js`). A separate `indexed_only` list keeps the files the symbol index covers today but `index.html` does not load (`orb-voice-bench.js` — loaded by its own `orb-voice-bench.html` —, `intent-engine.js`, `intelligence-cockpit-nav.js`, `intent-moderation.js`, `voice-budget.js`, `navigation-config.js`, `watcher.js`); they are not part of the bundle and no guard applies to them. Single source of truth for the bundle and the index.
2. Add `acorn` (pinned 8.15.0, the version already resolved) to the gateway `devDependencies`. Test helper `test/command-hub/bundle.ts`: `readCommandHubBundle()` = the manifest files concatenated in load order; `functionDeclarations()` = top-level function name → file via acorn.
3. CI checks updated to read the manifest instead of `app.js` alone, behaviour otherwise unchanged:
   - golden fingerprint: markers must appear in the built bundle (any manifest file in `dist/`);
   - bundle syntax gate: `node --check` every manifest file;
   - symbol index generator: its hard-coded `SOURCE_FILES` is replaced by a read of `modules.json` — every bundle file plus `indexed_only` — so it keeps all 11 files it indexes today and adds `pipeline-tree.js` and `kiro-console.js`; a test pins that no file indexed today drops out; the scanner itself is unchanged;
   - ownership guard: rule unchanged; each phase's VTID is added to its allowlist in that phase's PR.
4. New guard test: (a) `index.html` loads exactly the manifest files, in manifest order; (b) no top-level function name is declared in two manifest files (a duplicate silently overrides); (c) every `extracted` file's program body consists ONLY of function declarations (acorn: no statement, `const`/`let`/`var`, IIFE or expression runs at load time) — the load-order/TDZ safety net; (d) every `extracted`/`module` file is ≤ 350 KB (GitHub code-search limit); `app.js` is the shrinking exception.
5. No string-pin test is migrated in Phase 0. Each extraction finds the pins it breaks by (i) grepping the 38 pin files for every moved function's name and body strings and (ii) running the full command-hub suite; only those pins switch to `readCommandHubBundle()`.

## Phase 1 — pilot: the Operator Console — VTID B (after A is in production)
1. Selection rule (deterministic script in the PR, acorn call graph over the whole bundle): seeds = every top-level function whose name starts with `renderOperator`; then repeat until stable: add a top-level function when EVERY identifier reference to it anywhere in the bundle sits inside a function already in the set. Shared helpers (referenced from outside the set, e.g. `escapeHtml`) stay in `app.js`. Conservative exclusion: a function whose name also appears inside any string literal in the bundle (possible dynamic lookup) stays in `app.js`. The list is committed as `docs/validation/<VTID>/moved-functions.json`.
2. Mechanical move only: those declarations are cut from `app.js` and pasted unchanged, in their original order, into `operator-console.js` (manifest entry before `app.js`). No renames, no logic edits, no new wrapper. Top-level statements stay in `app.js`.
3. Proof of "nothing changed": a CI test parses each moved function at the base commit and in `operator-console.js` with acorn and compares the ASTs with positions and comments stripped — identical (whitespace-insensitive); the set of top-level function names across the bundle is identical before/after; the duplicate and declarations-only guards pass.
4. `?v=` bump for `app.js` and the new file; ownership-guard entry; symbol index regenerated; string pins that pointed at moved code switched to `readCommandHubBundle()`.
5. Verification: full command-hub jest, `test:operator`/`test:roles`/`test:support`, golden fingerprint, staging screenshots of the Operator Console (Chat, Live Ticker, History) desktop + mobile, read-only STAGING-VERIFY suite that the page loads `operator-console.js` at the new version and the served file contains `function renderOperatorChat`.
6. Freeze for the pilot only: while it is open no other Command Hub PR merges; it is opened, verified and merged the same day. From Phase 2 on, other Command Hub PRs may merge in parallel when they touch none of that phase's moved functions (checked against `moved-functions.json`); the extraction PR rebases last.

## Phase 2..N — one area per VTID (each its own light plan citing this one)
Areas grouped by screen, not by function count (estimate 8–12 phases: task board / VTID ledger views, voice screens, docs/manuals, admin screens, autopilot, intelligence, settings, …), ordered by change frequency (git log on app.js, measured in each phase's plan). Same rules as Phase 1 (selection script, mechanical move, AST-identical proof). Target: `app.js` keeps only bootstrap, `state`, router and shared helpers, and falls under 350 KB.

## Out of scope
Rewriting or refactoring any moved code; introducing a bundler/ES modules; deleting the unserved `app.js.backup*` files (separate cleanup); changing any UI.

## Risks and mitigations
- Load-order bug (a moved function used at load time before its file loads) → moved files load before `app.js`, and only function declarations move, never top-level statements.
- A test pin silently passing for the wrong reason → pins move to the bundle helper only where the PR's moved-functions list says the code moved.
- Merge conflicts with in-flight Command Hub PRs → freeze + same-day merge; the plan for each phase lists open Command Hub PRs at start.

## Tests
Phase 0: guard tests (load order, duplicates, size), golden/syntax/symbol-index on the manifest, all existing command-hub jest green unchanged. Phase 1: AST-identity test, function-set equality, full suites, staging screenshots + read-only STAGING-VERIFY.
<!-- plan:end -->

## Planner responses — round 1
- F1 major — ACCEPTED: 38 files (corrected). Pin discovery stated: grep the 38 pin files for each moved function's name and body strings, plus the full command-hub suite; only those pins move.
- F2 major — ACCEPTED: `acorn` 8.15.0 added as a direct devDependency in Phase 0 (no reliance on the transitive copy).
- F3 major — ACCEPTED: the generator's hard-coded `SOURCE_FILES` is replaced by a read of `modules.json`, which adds `pipeline-tree.js` and `kiro-console.js`; scanner unchanged.
- F4 major — ACCEPTED: new CI guard 4(c): an `extracted` file's program body must be function declarations only (acorn), so nothing runs at load time and no TDZ access to `state` is possible. A call from app.js top level to a moved function behaves exactly as before (the function now exists earlier, and its body resolves `state` at call time as before).
- F5 minor — ACCEPTED: 8–12 phases grouped by screen; the same-day freeze applies to the pilot only; later phases allow parallel Command Hub PRs that touch none of the phase's moved functions.
- F6 minor — ACCEPTED: `modules.json` lists every script `index.html` loads, in order, with a `kind` (extracted / module / app / standalone); guards apply per kind.
- F7 minor — ACCEPTED: each phase's VTID goes on the ownership-guard allowlist in that phase's PR.
- Q1: the manifest records the full order including the scripts after app.js. Moved code always goes into a file loaded BEFORE app.js, so every later script (standalone or app.js) can call it at load time or call time.
- Q2: defined in Phase 1.1 as a fixpoint over identifier references (a function joins only when all its references are inside the set), with string-literal names excluded conservatively.
- Q3: acorn ASTs compared with positions and comments stripped (whitespace-insensitive).

## Planner responses — round 2
- F8 major — ACCEPTED: `modules.json` gains an `indexed_only` list with the 6 files the generator indexes today that `index.html` does not load; the generator reads bundle + `indexed_only`, keeping all 11 current files and adding `pipeline-tree.js` and `kiro-console.js`; a test pins that no currently indexed file drops out. Whether those 6 are dead code is out of scope (no deletion in this plan).
- F9 minor — ACCEPTED: `orb-widget.js` is `module`; scripts after app.js are `post_app`.
- Q1: not determined here; they stay indexed unchanged (conservative), and a dead-code review is a separate VTID if wanted.

## Planner responses — round 3
- F8 enumeration note (minor) — ACCEPTED: `indexed_only` lists 7 files, not 6; `orb-voice-bench.js` (loaded by `orb-voice-bench.html`, verified in `index.html` and the generator's `SOURCE_FILES`) added to the plan's list.

## Sparring verdict
Round 1: 4 major + 3 minor, all accepted. Round 2: 1 major + 1 minor, accepted. Round 3: all F1–F9 closed, one enumeration minor accepted. Verdict: CONVERGED (3 rounds, standard class).

## Partner findings (verbatim)

### Partner — round 1 (verbatim)

Now I have enough to produce my findings.

## Verified premises

- **"app.js is 53,760 lines with 867 top-level function declarations and one global `const state` (app.js:4051)"** --> TRUE -- `const state` is at line 4051; `grep -c` of `^(async )?function` returns exactly 867. File size was not line-counted but proportionally consistent. (`/home/user/vitana-platform/services/gateway/src/frontend/command-hub/app.js:4051`)

- **"CI golden fingerprint searches `dist/.../app.js` only"** --> TRUE -- `command-hub-golden-fingerprint.js` hardcodes `dist/frontend/command-hub/app.js` at line 63, never reads any other file. (`/home/user/vitana-platform/scripts/ci/command-hub-golden-fingerprint.js:63`)

- **"bundle syntax gate does `node --check` on app.js [only]"** --> TRUE -- The inline script in `COMMAND-HUB-GUARDRAILS.yml` checks `dist/.../app.js` (line 98) and `src/.../app.js` (line 109), no other files. (`/home/user/vitana-platform/.github/workflows/COMMAND-HUB-GUARDRAILS.yml:98,109`)

- **"the symbol index generator lists files by name"** --> TRUE -- `generate-command-hub-symbol-index.mjs` has a hardcoded `SOURCE_FILES` array (lines 48-60) listing 11 files. However, it does NOT include `pipeline-tree.js` or `kiro-console.js`, which the plan calls existing precedent. (`/home/user/vitana-platform/services/gateway/scripts/generate-command-hub-symbol-index.mjs:48-60`)

- **"`pipeline-tree.js` and `kiro-console.js` are separate external files loaded before `app.js`"** --> TRUE -- index.html lines 21-23 load both before app.js at line 24. (`/home/user/vitana-platform/services/gateway/src/frontend/command-hub/index.html:21-24`)

- **"top-level `const/let` in `app.js` are visible to other classic scripts at call time (global lexical environment)"** --> PARTIAL -- This is technically correct per ECMAScript spec (classic scripts share a global lexical environment). `command-hub-staging.js` (loaded AFTER `app.js`) does reference `state.publishFlow` and `state.liveRevision` successfully. However, this only works in one direction: later scripts can see earlier scripts' `const`/`let`, NOT the reverse. The plan correctly identifies this directionality for function declarations but the wording in the Constraints section ("top-level `const/let` in `app.js` are visible to other classic scripts at call time") could mislead: a new file loaded BEFORE `app.js` cannot reference `const state` at load time. This is addressed by the mitigation ("only function declarations move, never top-level statements") but the premise wording is imprecise.

- **"47 jest files read `app.js` text directly (string pins)"** --> FALSE -- There are 38 test files that `readFileSync` app.js, not 47. 42 test files mention `app.js` in text (including comments and string references), but 38 actually read its content. (`/home/user/vitana-platform/services/gateway/test/command-hub/` -- grep for readFileSync patterns yields 38 files)

- **"a JS parser already in devDependencies, or acorn if present"** --> PARTIAL -- `acorn` 8.15.0 is in the resolved `node_modules` (via `package-lock.json` line 4446, a transitive dependency of eslint's `espree`), but it is NOT a direct dependency in `package.json`. `@babel/parser` is similarly transitive only. Neither `acorn` nor any JS parser is in `devDependencies` or `dependencies` directly. Using a transitive dependency is fragile -- a semver bump to eslint could drop or change the acorn version without warning.

## Findings

F1 [major] The plan claims "47 jest files read app.js text directly" but the actual count is 38. While the number is wrong in a direction that does not change the plan's strategy, an inaccurate premise about the exact test surface means the migration cost estimate and the Phase 0 "no string-pin test is migrated" claim cannot be trusted at face value. 38 is still a large surface to eventually migrate.

Evidence: grep for `readFileSync.*app\.js` patterns across `/home/user/vitana-platform/services/gateway/test/command-hub/` returns 38 unique files, not 47.

Suggestion: Correct the count to 38. More importantly, enumerate which of those 38 tests look for strings that exist ONLY in `renderOperator*` functions (the Phase 1 pilot target), so the Phase 1 PR knows exactly which pins must move. The plan says "each extraction migrates only the pins its moved code breaks" but does not explain HOW the PR author discovers which pins break -- the answer is "run the full test suite and see what fails," which should be stated explicitly.

F2 [major] No JS parser is a direct dependency -- the plan relies on a parser that does not exist as a declared dependency.

The plan says "via a JS parser already in devDependencies, or acorn if present; verified in the PR" for `functionDeclarations()` in Phase 0. `acorn` is only a transitive dependency (pulled in by `espree` via `eslint`). There is no parser in the project's own `dependencies` or `devDependencies`. Using a transitive dependency is fragile: a minor eslint version bump could change or remove acorn without a changelog entry in this project. Additionally, the plan's "verified in the PR" hedge is insufficient for a plan review -- the parser choice determines whether Phase 0 is feasible at all.

Evidence: `/home/user/vitana-platform/services/gateway/package.json` has no acorn/espree/esprima/babel-parser in its own dependency declarations. `package-lock.json:4446` shows acorn 8.15.0 as a transitive dep of eslint.

Suggestion: Explicitly add `acorn` (or `@babel/parser`) to `devDependencies` in Phase 0, and state that in the plan. Do not rely on transitive resolution. This is a one-line `package.json` addition but it must be planned, not discovered during implementation.

F3 [major] The symbol index generator's SOURCE_FILES list already excludes `pipeline-tree.js` and `kiro-console.js` -- but these are the plan's own cited precedents.

The plan says "the symbol index generator lists files by name" as a CI check to update. But `generate-command-hub-symbol-index.mjs` already excludes the two files the plan cites as precedent (`pipeline-tree.js`, `kiro-console.js`). If the new `operator-console.js` is not added to this list, its functions become invisible to the symbol index -- defeating one of the plan's stated goals (making the file navigable by AI tools). The plan's Phase 0 says "symbol index generator: indexes every manifest file" but does not account for the fact that today's generator has a HARDCODED list that does not read any manifest. The actual migration from the hardcoded list to a manifest-driven approach is not trivial: the generator uses a regex-based scanner (not an AST parser), and the plan's manifest-based approach introduces a dependency between two different scanning mechanisms.

Evidence: `/home/user/vitana-platform/services/gateway/scripts/generate-command-hub-symbol-index.mjs:48-60` -- hardcoded SOURCE_FILES array.

Suggestion: State explicitly in Phase 0 that the symbol index generator's hardcoded `SOURCE_FILES` array must be replaced with a read from `modules.json`, and that `pipeline-tree.js` and `kiro-console.js` must be added to the manifest (and thus to the index) retroactively. This is part of Phase 0's scope, not implicit.

F4 [major] `const`/`let` declared in `app.js` are NOT accessible from a file loaded before it -- the plan's load-order mitigation is necessary but the plan does not analyze which `renderOperator*` functions reference top-level `const` bindings like `state`, `MeState`, `TARGET_ROLES`, `VALID_VIEW_ROLES`, etc.

The plan says "moved files load before `app.js`" and "only function declarations move, never top-level statements." Function declarations are hoisted, so calling them from `app.js` at runtime is safe. BUT: if a moved function's BODY references `const state` (declared at app.js:4051), that reference resolves at call time, not at parse time -- so it DOES work as long as `state` has been initialized before the function is called. However, if `operator-console.js` loads before `app.js` and any top-level code in `operator-console.js` (an IIFE, a `const` initializer, anything that runs at parse time) references `state`, it will throw a `ReferenceError` because `const` declarations in the temporal dead zone of a later script are not yet initialized. The plan says "no top-level statements move" -- but it never verifies that the `renderOperator*` functions contain no top-level side effects or initializers. This is the plan's single most dangerous assumption.

Evidence: `command-hub-staging.js` (loaded AFTER app.js) references `state.publishFlow` successfully. But the plan puts new files BEFORE app.js, and `app.js:4051` declares `const state`. If any moved function is called at load time from the new file (not just declared), it would fail.

Suggestion: Add an explicit Phase 1 verification step: "Confirm that `operator-console.js` contains ONLY function declarations and no top-level statements, `const`, `let`, `var`, IIFEs, or any code that executes at load time." This should be a CI guard, not just a plan assumption. Also confirm that no `renderOperator*` function is called from a top-level statement in app.js that executes before `const state` is initialized (before line 4051).

F5 [minor] The plan says "app.js keeps only bootstrap, `state`, router and shared helpers, and falls under 350 KB" as the Phase N end state. At 867 functions, even if each extraction takes ~50 functions, that is 17 phases. With the same-day-merge freeze constraint, this means 17 separate days of frozen Command Hub development. The plan should address the total timeline and the opportunity cost of the freeze.

Evidence: 867 top-level functions, plan targets 350 KB (~14% of current size), implying ~86% of functions must move.

Suggestion: Either relax the same-day freeze (allow parallel Command Hub PRs as long as they touch different function sets, enforced by the duplicate-name guard) or commit to a rough phase count and timeline.

F6 [minor] Several scripts loaded AFTER `app.js` (like `command-hub-staging.js`, `voice-supervisor.js`, `intelligence-panels.js`) are NOT in the plan's initial manifest (which lists only `pipeline-tree.js`, `kiro-console.js`, `app.js`). These post-app.js scripts are also not in the symbol index generator's SOURCE_FILES. The plan's `modules.json` should either include ALL script files loaded in index.html or explicitly scope why it excludes some.

Evidence: `index.html` loads 8 script files; the plan's manifest starts with 3.

Suggestion: Define whether `modules.json` is "the bundle" (all scripts) or "the app.js decomposition target" (pre-app.js scripts only). If it is the bundle, include everything from day one. If it is not, rename it to avoid confusion with the CI checks that should cover ALL scripts.

F7 [minor] The plan says the ownership guard is "unchanged rule, manifest files are already under the protected path." This is correct -- any file under `services/gateway/src/frontend/command-hub/` triggers the guard. But the guard checks the PR title/branch for `DEV-COMHU-*` or an allowlisted VTID. The plan does not mention that the Phase 0 and Phase 1 VTIDs must be added to the allowlist in `command-hub-ownership-guard.js`.

Evidence: `/home/user/vitana-platform/scripts/ci/command-hub-ownership-guard.js` -- the file has a growing allowlist of VTIDs (lines 16-58).

Suggestion: Note in the plan that each phase's VTID must be added to the ownership guard allowlist, or the PR will be blocked by CI.

## Questions for the planner

1. How do you plan to handle the 4 scripts loaded AFTER `app.js` in `index.html` (`voice-self-healing.js`, `voice-supervisor.js`, `intelligence-panels.js`, `command-hub-staging.js`)? At least `command-hub-staging.js` references `state` from `app.js`. If in a future phase you move code that `command-hub-staging.js` calls, the load order constraint reverses (the callee must load before the caller, but the caller loads after `app.js`). Does the manifest capture load order for post-app.js scripts too?

2. The `renderOperator*` selection rule (Phase 1) says "every top-level function whose name starts with `renderOperator`, plus its exclusive callees." How deep does "exclusive callee" go? If `renderOperatorChat` calls `escapeHtml`, and `escapeHtml` is also called by `renderTaskBoard`, it is not exclusive. But if `renderOperatorChat` calls `renderOperatorChatMessage` which calls `escapeHtml`, is `renderOperatorChatMessage` included (yes, exclusive) while `escapeHtml` stays (yes, shared)? The plan should define "exclusive" precisely, or the script will need to, and that is the hard part of the implementation.

3. The plan says the AST-identical proof compares "the AST of the old body (from the base commit) with the new one." Is this comparing the raw text of each function body (string equality), or a parsed AST (ignoring whitespace/comments)? If AST, you need the parser from F2. If string, it is simpler but can false-alarm on whitespace changes from the cut-paste.

## Verdict

NOT CONVERGED -- 4 major findings open (F1 count inaccuracy, F2 missing parser dependency, F3 symbol index generator gap, F4 load-order safety for const bindings). None is a blocker individually, but F2 and F4 together mean the Phase 0 deliverable ("test helper with `functionDeclarations()` via a JS parser") and Phase 1's safety proof are not fully specified. The plan needs one more pass to pin the parser choice, define the manifest scope relative to index.html's full script list, and add an explicit TDZ-safety guard for moved code.

---

### Partner — round 2 (verbatim)

`orb-widget.js` is an IIFE wrapping everything under `(function (window) { ... })`. It is self-contained. The plan categorizes it as `standalone` alongside the after-app.js scripts, but it loads BEFORE app.js (index.html line 19). Its `kind` should be `module` (like `pipeline-tree.js` and `kiro-console.js`), not `standalone`. This is a minor classification error.

Now I have all the information for my round 2 review.

## Verified premises

- **"acorn 8.15.0 is the version already resolved"** --> TRUE -- `/home/user/vitana-platform/services/gateway/package-lock.json:4447`
- **"38 jest files readFileSync app.js"** --> TRUE (corrected from round 1's 47)
- **"SOURCE_FILES is hard-coded and omits pipeline-tree.js and kiro-console.js"** --> TRUE -- `/home/user/vitana-platform/services/gateway/scripts/generate-command-hub-symbol-index.mjs:48-60`
- **"modules.json lists EVERY script index.html loads"** --> needs care -- index.html loads 8 scripts, but the symbol index generator currently indexes 11 files, 6 of which are NOT in index.html

## Round 1 disposition

- F1 (38 not 47) --> **closed** -- corrected to 38 in the revised plan (line 17). Pin discovery method explicitly stated (line 29).
- F2 (no direct parser dependency) --> **closed** -- `acorn` 8.15.0 added as direct devDependency in Phase 0 (line 22).
- F3 (symbol index generator gap) --> **acknowledged** -- plan now says SOURCE_FILES replaced by modules.json read (line 26), adds `pipeline-tree.js` and `kiro-console.js`. See new finding F8 below for a remaining gap.
- F4 (TDZ safety for const bindings) --> **closed** -- new guard 4(c) (line 28) enforces that extracted files contain only function declarations via acorn, and the plan adds explicit TDZ reasoning (line 16). This is a well-specified mechanical check.
- F5 (phase count / freeze cost) --> **closed** -- 8-12 phases stated (line 40), same-day freeze limited to the pilot only, later phases allow parallel PRs (line 37).
- F6 (manifest scope vs index.html) --> **closed** -- manifest now covers every index.html script with `kind` annotations (line 21).
- F7 (ownership guard allowlist) --> **closed** -- each phase's VTID goes on the allowlist in that phase's PR (line 27).

## Findings

F8 [major] The symbol index generator currently indexes 6 files that are NOT loaded by `index.html`: `intent-engine.js`, `intelligence-cockpit-nav.js`, `intent-moderation.js`, `voice-budget.js`, `navigation-config.js`, `watcher.js`. The plan says `modules.json` lists "EVERY script `index.html` loads" and the generator will read from `modules.json`. If modules.json only lists index.html scripts, those 6 files silently drop out of the symbol index. They exist in the directory and are currently indexed -- losing them would reduce AI tool navigability for those files.

Evidence: `/home/user/vitana-platform/services/gateway/scripts/generate-command-hub-symbol-index.mjs:48-60` lists 11 files. `/home/user/vitana-platform/services/gateway/src/frontend/command-hub/index.html` loads only 8 scripts. The 6 non-overlapping files (`intent-engine.js`, `intelligence-cockpit-nav.js`, `intent-moderation.js`, `voice-budget.js`, `navigation-config.js`, `watcher.js`) are in the generator but not in index.html.

Suggestion: Either (a) add a `kind: 'utility'` (or similar) to modules.json for files that exist in the directory and should be indexed but are not loaded by index.html, or (b) keep the generator's file list as the union of modules.json plus a separate `index_extras` list, or (c) acknowledge that dropping them from the index is intentional (they may be dead code not loaded anywhere). The plan must state which.

F9 [minor] The plan classifies `orb-widget.js` as `standalone` and describes standalone as "loaded after app.js." But `orb-widget.js` loads BEFORE `app.js` (index.html line 19), not after. It is a self-contained IIFE (line 17: `(function (window) {`), identical in pattern to `pipeline-tree.js` and `kiro-console.js` which the plan calls `module`. The misclassification does not break any guard, but makes the manifest's `kind` taxonomy inaccurate.

Evidence: `/home/user/vitana-platform/services/gateway/src/frontend/command-hub/index.html:19` (orb-widget.js loaded before app.js at line 24); `/home/user/vitana-platform/services/gateway/src/frontend/command-hub/orb-widget.js:17` (`(function (window) {` -- IIFE).

Suggestion: Classify `orb-widget.js` as `module` (self-contained IIFE loaded before app.js, like `pipeline-tree.js` and `kiro-console.js`), not `standalone`. Or redefine `standalone` to mean "self-contained regardless of load position" and rename the after-app.js kind to something like `post_app`.

## Questions for the planner

1. Are the 6 files in the symbol index generator that are not loaded by index.html (`intent-engine.js`, `intelligence-cockpit-nav.js`, `intent-moderation.js`, `voice-budget.js`, `navigation-config.js`, `watcher.js`) dead code, loaded elsewhere, or loaded dynamically? If they are still useful, modules.json needs to account for them or the generator needs a secondary source.

## Verdict

NOT CONVERGED -- one major finding open (F8, symbol index generator would lose 6 files when switching to modules.json). F9 is minor and does not block. One more pass addressing the generator's non-index.html files should close this out.

---

### Partner — round 3 (verbatim)

Confirmed. `orb-voice-bench.js` is loaded by its own HTML page, not by `index.html`. So the correct count of generator files not in index.html is 7, not 6 as the plan states. This is a minor inaccuracy -- the plan says "6 files" in both F8 response (line 67) and in the manifest description (line 21). The actual list should include `orb-voice-bench.js`.

This is minor enough (off by one file, same mechanism handles it) that it does not warrant reopening as a major. All findings are addressed.

## Round 1 findings — final disposition

- F1 (count 47 vs 38) --> **closed** (round 1)
- F2 (no direct parser dep) --> **closed** (round 1)
- F3 (symbol index generator gap) --> **closed** (round 1, refined by F8)
- F4 (TDZ safety) --> **closed** (round 1)
- F5 (phase count / freeze) --> **closed** (round 1)
- F6 (manifest scope) --> **closed** (round 1)
- F7 (ownership guard allowlist) --> **closed** (round 1)

## Round 2 findings — disposition

- F8 (generator loses 6 non-index.html files) --> **closed** -- the `indexed_only` list in `modules.json` preserves them, the generator reads bundle + `indexed_only`, and a test pins that no currently indexed file drops out (line 26). One count correction: there are 7 non-index.html files in the generator, not 6 (`orb-voice-bench.js` is also not in index.html -- it is loaded by its own `orb-voice-bench.html`). This does not change the mechanism, only the enumeration. State the correct list of 7 in the implementation.
- F9 (orb-widget.js misclassified) --> **closed** -- `orb-widget.js` is now `module`; after-app.js scripts are `post_app` (line 21).

## Findings

No new blocker or major findings. The plan is well-specified and all prior concerns have been addressed with concrete, verifiable mechanisms (acorn as direct dep, declarations-only guard, indexed_only list, kind taxonomy fix, freeze scoping).

One minor note for implementation: the `indexed_only` count is 7 files, not 6 -- `orb-voice-bench.js` (loaded by `orb-voice-bench.html`, not `index.html`) is also in the generator's current SOURCE_FILES but missing from the plan's enumeration in line 21. Not a design issue, just an enumeration fix for the implementation.

## Questions for the planner

None.

## Verdict

CONVERGED