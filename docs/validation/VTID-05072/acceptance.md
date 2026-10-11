# VTID-05072 — Phase 0 acceptance

One acceptance criterion per Phase 0 plan item (plan §Phase 0, 1–5), each mapped to the test
that proves it. No code was moved out of `app.js`; `app.js` is unmodified.

AC-1 modules.json lists exactly index.html's `<script src="/command-hub/*.js">` entries in load order, each with a kind, plus the 7-file indexed_only list.
TEST: npx jest test/command-hub/vtid-05072-bundle-manifest.test.ts -t "case 1" (index.html script list equals the manifest bundle, same files + order, ?v= ignored)

AC-2 acorn 8.15.0 (exact) is a gateway devDependency and the bundle helper parses with it; no top-level function name is declared in two bundle files (the known escapeHtml duplicate is frozen behind an allowlist).
TEST: npx jest test/command-hub/vtid-05072-bundle-manifest.test.ts -t "case 2" (functionDeclarations() via acorn; no UNEXPECTED duplicate; still catches a NEW duplicate)

AC-3 CI checks read the manifest instead of app.js alone, behaviour otherwise unchanged (golden fingerprint over all bundle files; syntax gate loops the manifest; symbol-index generator reads modules.json and now covers pipeline-tree.js + kiro-console.js; ownership guard allowlists VTID-05072).
TEST: node scripts/ci/command-hub-golden-fingerprint.js (outputs/golden-fingerprint.log) AND node scripts/generate-command-hub-symbol-index.mjs --check (outputs/symbol-index-check.log) AND npx jest test/command-hub/vtid-05072-bundle-manifest.test.ts -t "case 5"

AC-4 Guard test enforces: extracted files are declarations-only (and the check rejects a const, an IIFE and an expression statement), and every extracted/module file is <= 350 KB with app.js exempt.
TEST: npx jest test/command-hub/vtid-05072-bundle-manifest.test.ts -t "case 3" AND -t "case 4"

AC-5 No string-pin test is migrated in Phase 0; all 38 string-pin suites pass unchanged.
TEST: npx jest test/command-hub (outputs/jest-command-hub.log — 43 suites / 636 tests, no pin test edited)

## Decisions taken
- **CRLF, not real failures (blocker 2).** The worktree had `core.autocrlf=true`; CRLF line
  endings broke byte-exact string-pin assertions. Per owner authorization, `core.autocrlf`
  was set to `input` for this worktree and the tree renormalized to LF (`rm -r --cached` +
  `reset --hard`). On LF, all 43 command-hub suites pass (636 tests). No test was edited.
- **The `escapeHtml` duplicate is FROZEN, not removed (blocker 1).** `escapeHtml` is declared
  top-level in BOTH app.js and intelligence-panels.js. It is NOT removed in Phase 0: no
  app.js edit, no served-file behaviour change, no ?v= bump (plan §1.6). Guard case 2 carries
  a one-entry known-duplicates allowlist (escapeHtml → exactly {app.js,
  intelligence-panels.js}); it FAILS on any other duplicate, on a different file set for
  escapeHtml, or if the duplicate disappears while the allowlist entry remains (so the list
  can only shrink), and an inline-string case proves it still catches a NEW duplicate.
- **The `intelligence-panels.js` copy of `escapeHtml` is a security bug, deferred to its own
  VTID.** That copy does NOT escape single or double quotes and, loading after app.js,
  overrides app.js's correct copy page-wide. Removing it is a security fix with its own VTID
  (follow-up to VTID-05072), out of scope for this no-code-move Phase 0.
- **Local Node is v24.11.1; CI pins Node 20.x.** No Node 20 was available locally; checks ran
  on v24. CI runs the gates on Node 20.
- **Ledger update skipped.** No gateway endpoint performs a plain status/spec_status/title
  update on the VTID ledger, and no Supabase MCP tool is available in this environment, so the
  best-effort ledger write was skipped (no loop, no other row touched).
- **One pre-existing Windows-only `test:operator` failure.** "the runner jest targets include
  every suite that names app.js" fails on Windows because the runner emits OS-native backslash
  paths; verified pre-existing on the clean base (identical 63/1), independent of this change,
  and does not reproduce on CI's Linux.
