VTID: VTID-05072
VALIDATION_PROFILE: gateway_backend
SCOPE_ALLOWLIST: services/gateway/src/frontend/command-hub/modules.json, services/gateway/package.json, services/gateway/package-lock.json, services/gateway/test/command-hub/bundle.ts, services/gateway/test/command-hub/vtid-05072-bundle-manifest.test.ts, services/gateway/scripts/generate-command-hub-symbol-index.mjs, services/gateway/specs/command-hub-symbol-index.json, scripts/ci/command-hub-golden-fingerprint.js, scripts/ci/command-hub-ownership-guard.js, .github/workflows/COMMAND-HUB-GUARDRAILS.yml, docs/validation/VTID-05072/
ACCEPTANCE: docs/validation/VTID-05072/acceptance.md
OASIS_IMPACT: no
MERGE_PAYLOAD_PREVIEW: Phase 0 enablers only — adds the command-hub bundle manifest + acorn + manifest-driven CI guards; no code moved out of app.js, no served file or ?v= changed.
DEPENDENCY_CHANGE: added acorn 8.15.0 (exact) as a gateway devDependency — the JS parser used by the Phase 0 bundle guard tests (test/command-hub/bundle.ts functionDeclarations). Both package-lock.json and pnpm-lock.yaml regenerated.

## What this is

Phase 0 of the pre-approved, pre-sparred Command Hub `app.js` split (plan hash
`502eb294…dec5`). Enablers only — **no function is moved and `app.js` is not touched.**

- `src/frontend/command-hub/modules.json` — single source of truth for the bundle
  (ordered to match `index.html`'s `<script>` load order, each with a `kind`) plus the
  7-file `indexed_only` list.
- `acorn` `8.15.0` (exact) added to the gateway `devDependencies`; lockfile regenerated.
- `test/command-hub/bundle.ts` — `readManifest()` / `readCommandHubBundle()` /
  `functionDeclarations()` (acorn, `sourceType: 'script'`).
- CI guards now read the manifest, behaviour otherwise unchanged:
  - golden fingerprint searches the concatenation of every manifest bundle file in `dist/`;
  - the GUARDRAILS syntax gate `node --check`s every manifest bundle file;
  - the symbol-index generator reads `modules.json` (bundle + indexed_only) instead of a
    hard-coded list — the regenerated index now also covers `pipeline-tree.js` and
    `kiro-console.js` and keeps all 11 previously indexed files;
  - the ownership guard allowlists `VTID-05072` (no other change).
- `test/command-hub/vtid-05072-bundle-manifest.test.ts` — 5 guard cases (index.html == bundle;
  no top-level name in two bundle files; extracted = declarations-only, proven to reject
  const/IIFE/expression; extracted/module ≤ 350 KB with app.js exempt; generator file list ⊇
  the pre-change 11 + the two new files).

## Testing

LF checkout (see Decisions). From `services/gateway`: `tsc --noEmit` PASS; `jest test/command-hub`
PASS (43 suites / 636 tests); `test:roles` PASS (105); `test:support` PASS (87);
symbol-index `--check` in sync (1106 fns / 15 files). From root: golden fingerprint PASS over
8 bundle files; ownership guard PASS. `test:operator` 63/64 — the one failure is a pre-existing
Windows-only path-separator artifact (verified identical on the clean base; passes on CI Linux).
Full logs: `docs/validation/VTID-05072/outputs/`. Verification note:
`docs/validation/VTID-05072/verification.md`.

## Decisions taken

- **CRLF, not real failures.** The worktree had `core.autocrlf=true`; CRLF broke byte-exact
  string pins. With owner authorization, `core.autocrlf` was set to `input` and the tree
  renormalized to LF — all 43 command-hub suites then pass. No test was edited.
- **The `escapeHtml` duplicate is FROZEN, not removed.** `escapeHtml` is declared top-level in
  both `app.js` and `intelligence-panels.js`. It is not removed here (no app.js edit, no
  served-file change, no `?v=` bump). Guard case 2 carries a one-entry known-duplicates
  allowlist (`escapeHtml` → exactly {app.js, intelligence-panels.js}); it fails on any other
  duplicate, a different file set, or the duplicate disappearing while the entry remains, and
  proves via an inline fixture that it still catches a NEW duplicate.
- **The `intelligence-panels.js` copy of `escapeHtml` omits quote-escaping and overrides
  `app.js`'s copy page-wide** — a security bug whose fix is deferred to its own VTID.
- **Ledger update skipped.** No gateway endpoint performs a plain status/spec_status/title
  update on the VTID ledger, and no Supabase MCP tool is available in this environment, so the
  best-effort ledger write was skipped (no loop, no other row touched).
- Local Node is v24.11.1; CI pins Node 20.x.

## Handoff

- **Where it stopped:** Phase 0 implemented, committed (`7e3c6bd`), branch pushed. Draft PR open.
- **Open:** CI must go green on the head commit (the one `test:operator` failure is Windows-only
  and does not occur on CI Linux). Ledger not updated (see Decisions). The `escapeHtml`
  security fix is a separate follow-up VTID.
- **Next:** When CI is green, mark ready → merge → watch STAGING-VERIFY, then STOP at Gate 2
  ("Staging verified — ready for deployment to production?"). No production deploy is dispatched
  from here.
