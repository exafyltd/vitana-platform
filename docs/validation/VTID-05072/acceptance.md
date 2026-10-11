# VTID-05072 — Phase 0 acceptance

One line per Phase 0 plan item (plan §Phase 0, 1–5) → the test that proves it.
No code was moved out of `app.js`; `app.js` is unmodified.

| # | Plan Phase 0 item | Proven by |
|---|---|---|
| 1 | `modules.json`: ordered `bundle` matching index.html's `<script>` load order (with `kind`), plus the 7-file `indexed_only` list | `test/command-hub/vtid-05072-bundle-manifest.test.ts` case 1 — index.html script list equals `bundle`, same files, same order, `?v=` ignored |
| 2 | `acorn` 8.15.0 (exact) added to gateway devDependencies; lockfile regenerated | `package.json` devDependencies pins `"acorn": "8.15.0"`; `package-lock.json` root dep + `node_modules/acorn` both 8.15.0; `test/command-hub/bundle.ts` `functionDeclarations()` parses with acorn (exercised by cases 2 and 5) |
| 3 | CI checks read the manifest, behaviour otherwise unchanged (golden fingerprint over all bundle files; syntax gate loops the manifest; symbol-index generator reads `modules.json`; ownership guard allowlists VTID-05072) | Golden fingerprint PASS over 8 bundle files (outputs/golden-fingerprint.log); symbol-index `--check` in sync, 15 files incl. pipeline-tree.js + kiro-console.js (outputs/symbol-index-check.log); ownership guard PASS with VTID-05072 (outputs/ownership-guard.log); case 5 pins the generator's file list ⊇ the pre-change 11 plus the two new files |
| 4 | Guard test: (a) index.html == bundle; (b) no top-level name in two bundle files; (c) extracted files are declarations-only and the check rejects const/IIFE/expression; (d) extracted/module ≤ 350 KB, app.js exempt | `vtid-05072-bundle-manifest.test.ts` cases 1, 2, 3, 4 (case 2 freezes the known `escapeHtml` duplicate and still catches any NEW duplicate; case 3 rejects inline const/IIFE/expression fixtures) |
| 5 | No string-pin test migrated in Phase 0 | No pin test changed; all 38 string-pin suites pass unchanged on an LF checkout (outputs/jest-command-hub.log, 43 suites / 636 tests) |

## Decisions taken
- **CRLF, not real failures (blocker 2).** The worktree had `core.autocrlf=true`; CRLF line
  endings broke byte-exact string-pin assertions. Per owner authorization, `core.autocrlf`
  was set to `input` for this worktree and the tree renormalized to LF (`rm -r --cached` +
  `reset --hard`). On LF, all 43 command-hub suites pass (636 tests). No test was edited.
- **The `escapeHtml` duplicate is FROZEN, not removed (blocker 1).** `escapeHtml` is declared
  top-level in BOTH `app.js` and `intelligence-panels.js`. It is NOT removed in Phase 0: no
  `app.js` edit, no served-file behaviour change, no `?v=` bump (plan §1.6). Guard case 2
  carries a one-entry known-duplicates allowlist (`escapeHtml` → exactly {app.js,
  intelligence-panels.js}); it FAILS on any other duplicate, on a different file set for
  `escapeHtml`, or if the duplicate disappears while the allowlist entry remains (so the list
  can only shrink), and an inline-string case proves it still catches a NEW duplicate.
- **The `intelligence-panels.js` copy of `escapeHtml` is a security bug, deferred to its own
  VTID.** That copy does NOT escape single or double quotes and, loading after `app.js`,
  overrides `app.js`'s correct copy page-wide. Removing it is a security fix with its own
  VTID (follow-up to VTID-05072), out of scope for this no-code-move Phase 0.
- **Local Node is v24.11.1; CI pins Node 20.x.** No Node 20 was available locally. Checks ran
  on v24; CI runs the gates on Node 20.
- **One pre-existing Windows-only `test:operator` failure.** "the runner jest targets include
  every suite that names app.js" fails on Windows because the runner emits OS-native
  backslash paths; verified pre-existing on the clean base (identical 63/64), independent of
  this change, and does not reproduce on CI's Linux.
