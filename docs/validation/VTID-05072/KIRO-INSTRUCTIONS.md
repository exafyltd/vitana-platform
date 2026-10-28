# Kiro IDE — execute the app.js split plan (VTID-05072 → VTID-05073)

The plan is sparred and the owner approved it on 2026-10-11. **Do not re-plan, re-spar or allocate anything.** The VTIDs already exist:

| VTID | Phase | Start |
|---|---|---|
| **VTID-05072** | Phase 0 — manifest, acorn, guards (no code moves) | now |
| **VTID-05073** | Phase 1 — Operator Console pilot extraction | only after VTID-05072 is **in production** |

Sparring id `00ff7572-aa5b-49e2-9bf3-142339e0c348`, plan hash `502eb294fd67c1ebd1de9596d9751c1a53b61bc1e76e63c521052920ebd8dec5`.
The plan text is in `docs/validation/VTID-05072/plan-sparring.md` on branch `claude/amazing-ride-wipu1l`. It is the contract; if these instructions and the plan disagree, the plan wins.

## 0. Before you start (every time)

1. `git fetch origin main && git checkout -b kiro/vtid-05072-appjs-manifest origin/main`. Never start from an old branch.
2. Take the plan record from git, never from chat (chat mangles backticks): `git fetch origin claude/amazing-ride-wipu1l && git checkout origin/claude/amazing-ride-wipu1l -- docs/validation/VTID-05072/plan-sparring.md docs/validation/VTID-05072/KIRO-INSTRUCTIONS.md`. Whole-file `sha256sum` must be `3b4a4f3da1623db73b3e0403edb4816f43eadab16da4576c45e1edb143b7b20d`; plan-body hash: `python3 -c "import hashlib;s=open('docs/validation/VTID-05072/plan-sparring.md').read();print(hashlib.sha256(s.split('<!-- plan:begin -->')[1].split('<!-- plan:end -->')[0].encode()).hexdigest())"` must print `502eb294…dec5`. If either differs, stop. Never edit the plan to make it fit.
3. Ledger: set VTID-05072 to `in_progress` with `spec_status='approved'`, and set a real title. Use the gateway `PATCH` (service token) if you can reach it. If you use the Supabase MCP instead, run **one** `UPDATE ... WHERE vtid='VTID-05072'` with `set local statement_timeout='20s'`. These updates have been timing out at 60 s. If it times out, note it in the PR body and carry on. Do not retry in a loop and do not touch any other row.
4. `app.js` is **not** in repowise (over its size limit), so never grep it in a shell loop. Use `services/gateway/specs/command-hub-symbol-index.json` for function → line, then `Read` with offset/limit.

## 1. Phase 0 — VTID-05072 (no code moves out of app.js)

Work in `services/gateway/` unless the path says otherwise.

### 1.1 `src/frontend/command-hub/modules.json` (new)
- `bundle`: an ordered array with **exactly** the `<script src="/command-hub/…">` entries of `index.html`, in that order. Today that is:
  - `orb-widget.js` (`module`)
  - `pipeline-tree.js` (`module`)
  - `kiro-console.js` (`module`)
  - `app.js` (`app`)
  - `voice-self-healing.js`, `voice-supervisor.js`, `intelligence-panels.js`, `command-hub-staging.js` (all `post_app`)

  Shape: `{ "file": "…", "kind": "module|app|post_app|extracted" }`. There are no `extracted` entries in Phase 0. Re-check the list against `index.html` on your fresh main and don't trust this list blindly.
- `indexed_only`: the **7** files the symbol index covers today that `index.html` does not load: `orb-voice-bench.js`, `watcher.js`, `intent-engine.js`, `intelligence-cockpit-nav.js`, `intent-moderation.js`, `voice-budget.js`, `navigation-config.js`.

### 1.2 acorn
- Add `"acorn": "8.15.0"` (exact, no caret) to the gateway `devDependencies`.
- Regenerate the lockfile with `npm install` in `services/gateway`. Never hand-edit the lockfile.

### 1.3 `test/command-hub/bundle.ts` (new helper)
- `readManifest()`.
- `readCommandHubBundle()`: the bundle files' contents joined in manifest order.
- `functionDeclarations()`: a `Map` from each top-level `FunctionDeclaration` name to its file(s), built by parsing each file with `acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' })`.

### 1.4 Switch the CI checks to the manifest. Behaviour stays the same otherwise.
- `scripts/ci/command-hub-golden-fingerprint.js` (around line 63): it searches markers in `dist/.../app.js` only. It must search the concatenation of every manifest bundle file in `dist/`. Every marker that passes today must still pass.
- `.github/workflows/COMMAND-HUB-GUARDRAILS.yml` syntax gate (around lines 98/109): run `node --check` on every manifest bundle file (loop over `modules.json`), not only `app.js`.
- `services/gateway/scripts/generate-command-hub-symbol-index.mjs`: replace the hard-coded `SOURCE_FILES` (lines 48–60) with bundle files + `indexed_only` read from `modules.json`. The scanner logic stays unchanged. Regenerate `specs/command-hub-symbol-index.json` by running it from `services/gateway`. The output must now also contain `pipeline-tree.js` and `kiro-console.js`.
- Ownership guard (`scripts/ci/command-hub-ownership-guard.js`): add `VTID-05072` to `ALLOWED_VTID_PATTERN`. Make no other change.

### 1.5 New guard test `test/command-hub/vtid-05072-bundle-manifest.test.ts`
1. The `index.html` `<script src="/command-hub/*.js">` list equals `bundle` (same files, same order). Ignore `?v=`.
2. No top-level function name is declared in two bundle files.
3. Every `extracted` file's `Program.body` is only `FunctionDeclaration`s. The test must also prove this check rejects a fixture that has a `const`, an IIFE, or an expression statement. Use inline strings, not real files.
4. Every `extracted` and `module` file is ≤ 350 KB. `app.js` is exempt.
5. The generator's file list ⊇ the 11 files indexed before this change (hard-code that list in the test), plus `pipeline-tree.js` and `kiro-console.js`.

### 1.6 What NOT to do in Phase 0
- Do not move any function and do not edit `app.js`.
- Do not change any existing string-pin test. All 38 must pass **unchanged**.
- `?v=` stays the same because no served JS changes. `modules.json` is not served.
- Do not delete `app.js.backup*`.

### 1.7 Local checks before push (all must be green)
From `services/gateway`:
- `npx tsc --noEmit`
- `npx jest test/command-hub`
- `npm run test:operator`
- `npm run test:roles`
- `npm run test:support`
- `node scripts/generate-command-hub-symbol-index.mjs --check`

From the repo root:
- `node scripts/ci/command-hub-golden-fingerprint.js`, after `npm run build` in the gateway
- the ownership guard

Paste the counts into `docs/validation/VTID-05072/outputs/`.

### 1.8 Evidence and PR
- `docs/validation/VTID-05072/`:
  - `plan-sparring.md` (copied, unchanged);
  - `acceptance.md`, with one line per plan item 1–5 of Phase 0 → the test that proves it;
  - `outputs/`, the local check logs;
  - `staging-tests.json`.
- `staging-tests.json`, read-only only:
  - a GET of `/command-hub/` returns 200 and every `script src` in it returns 200 with a JS content type;
  - that check is enough because Phase 0 changes no served file.
- PR title: `VTID-05072: Command Hub app.js split — Phase 0 (manifest + guards)`.
- The PR body must have these exact lines (validate-pr checks them):
  - `VTID: VTID-05072`
  - `VALIDATION_PROFILE: …`
  - `SCOPE_ALLOWLIST: …`
  - `ACCEPTANCE: …`
  - `OASIS_IMPACT: no` (exactly `yes` or `no`, nothing after it)
  - `MERGE_PAYLOAD_PREVIEW: …`
- Add the Handoff section ("Where it stopped / Open / Next") if you stop before merge.
- Open the PR as a draft. Mark it ready when CI is green, then merge.
- After merge, watch the staging deploy and STAGING-VERIFY for the merge commit. On a failure, fix forward. Never skip, disable or loosen a test.
- When STAGING-VERIFY passes, **stop and send the owner Gate 2**: "Staging verified — ready for deployment to production?" Include:
  - the STAGING-VERIFY run link;
  - the test counts;
  - the verified commit;
  - every commit between production and it;
  - migrations: none;
  - a "Decisions taken" list.
- Production only after the owner's "yes". Use `AWS-PROD-DEPLOY-GATEWAY.yml` with `deploy_mode=promote-staging` and `expected_commit=<verified commit>`. If that commit range contains anything the owner hasn't approved, say so before dispatching.

## 2. Phase 1 — VTID-05073 (only after VTID-05072 is live in production)

1. Start from fresh `origin/main` on branch `kiro/vtid-05073-operator-console`.
2. Copy `plan-sparring.md` to `docs/validation/VTID-05073/`.
3. Ledger: set VTID-05073 to `in_progress`.
4. Write a selection script at `scripts/dev/select-extraction.mjs` that uses acorn over the whole bundle:
   - seeds = top-level functions whose name starts with `renderOperator`;
   - fixpoint: add a top-level function when **every** identifier reference to it in the bundle sits inside a function already in the set;
   - drop any function whose name also appears inside a string literal anywhere in the bundle.

   Commit its output as `docs/validation/VTID-05073/moved-functions.json`, with name and original line for each function.
5. Before cutting, list the open Command Hub PRs in the PR body and announce the freeze. **This PR is opened, verified and merged the same day; no other Command Hub PR merges while it is open.**
6. Move the code mechanically:
   - cut exactly those declarations from `app.js` and paste them unchanged, in original order, into `src/frontend/command-hub/operator-console.js`;
   - add it to `modules.json` as `extracted`, before `app.js`, and add its `<script>` tag to `index.html` in the same position;
   - no renames, no edits, no wrapper, and top-level statements stay in `app.js`.
7. Bump `?v=` for `app.js` and `operator-console.js` to `?v=<date>-vtid-05073`. Add VTID-05073 to the ownership guard. Regenerate the symbol index.
8. Proof test `test/command-hub/vtid-05073-operator-console-extraction.test.ts`:
   - for each moved function, the acorn AST from the base commit's `app.js` (keep a copy as a fixture) is deep-equal to the one in `operator-console.js`, with `start`/`end`/`loc`/`range`/comments stripped;
   - the set of top-level function names across the bundle is unchanged;
   - the Phase 0 guards pass, including declarations-only and size ≤ 350 KB.
9. Fix the string pins:
   - search the 38 pin test files for every moved name and body string;
   - only those reads switch from `app.js` to `readCommandHubBundle()`;
   - change no assertion text.
10. Verification:
    - the local checks from 1.7;
    - staging screenshots of the Operator Console (Chat, Live Ticker, History) at 1400×900 and 390×844, saved in `docs/validation/VTID-05073/screenshots/`, read-only;
    - `staging-tests.json`: the page serves `operator-console.js?v=<new>` and the served file contains `function renderOperatorChat`.
11. Same PR, merge, STAGING-VERIFY and Gate 2 flow as Phase 0.

## 3. Stop and ask the owner only if
- (a) something outside this plan is needed;
- (b) a production write that is not the Gate 2 deploy;
- (c) a security or data-loss risk;
- (d) the same failure survives 3 fix-forward attempts.

Everything else (branch names, test design, re-running your own CI) you decide yourself.

When you report back, include:
- PR links;
- the CI status on the head commit;
- the STAGING-VERIFY link;
- for Phase 1, the `moved-functions.json` count and the new `app.js` size.

Claude Code will review each PR before Gate 2.
