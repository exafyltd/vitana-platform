# Scope-addition sparring: VTID-05063 step A (one round)

Worktree: `.worktrees/vtid-05063-ledger-read-auth`. Method: reading only (no shell, no git, no test run). No gateway call was made.

**Verdict: ESCALATED** (0 blockers, 1 major, 4 minors). The major is mechanical (docs-only JSON pins), does not widen the approved blast radius, and has a one-pass fix. Per the autonomy rule an escalated verdict is not self-approved; the planner applies the fix and the owner-facing record notes it.

## Blast radius: not widened

The approved envelope is Tier 1 read gate, log mode, no step B, no production change. Reviewed against it:

- The guard edit only lets a branch or PR title containing `VTID-05063` touch the Command Hub path. It does not alter the check order or the DEV-COMHU / VTID-04052 carve-outs.
- The `index.html` bump changes two cache-bust query strings. No server behaviour changes.
- The impact-rule edit adds one name to an allow-list used by a CI lint. No runtime effect.
- `vtid-auto-close.cjs:146` is a warning string only.
- The boot-line test change is test-only.
- No production workflow, smoke file, flag pin or `gatewayApiCall` default is touched. No token value appears in any of the files I read (`scope.json`, the guard comment, the plan-sparring approval text, the warning string).

## Major

**M1. Older `staging-tests.json` suites pin the OLD `index.html` cache-bust string and will fail after the bump.** (confirmed)
`index.html:7` and `:17` now say `20261110-vtid-05063`. At least 13 suites under `docs/validation/` still assert `expect_body_contains: "app.js?v=20261109-vtid-05006"` against `/command-hub/` (and SPA-fallback paths): VTID-05006, 05004, 05003, 04999, 04984, 04975, 04887 (two probes), 04886, 04885, 04876, 04869, 04836, 04779. The grep output was truncated, so the exhaustive list needs a re-grep after the fix. `scripts/ci/staging-verify/lib.cjs` `planRange` runs the suite of every VTID between production and the verified commit, and `planFullRun` (the VTID-04949 nightly) runs every suite ever merged. A stale pin therefore turns STAGING-VERIFY red for in-range VTIDs and the nightly red for the rest. Gate 2 ("Staging verified, ready for deployment to production?") is the one point where the owner expects a green result.
Precedent: VTID-05003, 05004 and 05006 each bumped the same marker and declared `docs/validation/*/staging-tests.json` in their `scope.json` for exactly this reason. This is a missed item in the first review, not a wrong fix in the bump.
Fix: replace `20261109-vtid-05006` with `20261110-vtid-05063` in every `expect_body_contains` that targets an HTML path (`/command-hub/`, `/command-hub/overview/live-metrics/`, `/command-hub/voice/test-bench/`). The `path: /command-hub/app.js?v=...` and `styles.css?v=...` probes do not need a change (the query string is ignored by the static handler and those tests only check the body of the file). Then re-grep `docs/validation/**/staging-tests.json` for `20261109-vtid-05006` inside `expect_body_contains` and confirm zero HTML-path hits. Add `docs/validation/*/staging-tests.json` to `scope.json` paths. Docs-only, no runtime effect.

## Minor

**m1. `docs/validation/VTID-05063/scope.json` is the wrong schema.** (confirmed)
`scope.json:1` uses a `files` array and has no `kind`. `scripts/ci/pr-gate/lib.mjs` `validateScope` requires `kind` (fix|feature|refactor|infra|docs) and a non-empty `paths` array, and `evaluateScope` reads `scopes[v].paths`. As written, `gate.mjs scope` prints "invalid scope.json" (kind and paths errors) and the sparring/weakening checks skip it. PR-GATE is report-only (`config.json` `enforce: false`), so nothing blocks, but the m1 fix from the first review does not achieve its purpose. The VTID-05006 file has the same defect (precedent is broken, not a model). Working examples: VTID-05003, 05027, 05060 (`"kind": "feature"`, `"paths": [...]`).
Fix: rename `files` to `paths`, add `"kind": "feature"` (not `fix`: that triggers the red-green check), and add `docs/validation/*/staging-tests.json` (from M1). `docs/validation/VTID-05063/**` is already auto-allowed. The JSON itself parses.
Path existence: every non-glob path in the file exists in the worktree (`middleware/ledger-read-auth.ts`, `debug.html`, `index.html`, `command-hub-ownership-guard.js`, `vtid-auto-close.cjs`, `vtid-auto-close.test.cjs`, `docs/CHANGELOG.md`, `.claude/rules/infrastructure.md`; the four `vtid-05063-*.test.ts` files match the `vtid-05063-*.test.ts` glob). I could not enumerate the changed set without git, so completeness against the real diff is unverified.

**m2. PR body needs `VALIDATION_PROFILE: gateway_backend`.** (confirmed)
VALIDATOR-CHECK triggers on `services/gateway/src/**`, `test/**` and `docs/validation/**`. It exits 11 with no `VALIDATION_PROFILE` in the PR body, and profile `command_hub_frontend` would reject the route files (and demand dist changes). Use `gateway_backend`; `scripts/` and `.github/` are outside its remit and not judged. Put the profile line, the markers it demands, and the scope-addition list (guard, index.html, impact rule, staging-tests repin) in the PR text. No code change.

**m3. Approval wording in `docs/validation/VTID-05063/plan-sparring.md` is unverifiable from the record.** (possible)
The line cites an owner reply "yes" in the Kiro chat session. The verbatim owner messages available to this workflow are "2" and "execute this ..."; I cannot match "yes" to them. Cite the plan hash and the owner instruction by its text, and extend the "Scope addition ... sparred in one round" paragraph with this verdict and the M1 follow-up so the record is true when read.

**m4. `debug.html` edit is inert and widens the Command Hub footprint.** (confirmed, carried from the first review)
`/debug.html` is denylisted at `middleware/command-hub-backup-denylist.ts`. Reverting that edit would drop one file from the guard trigger and from `scope.json`. Optional.

## Checked and correct (no action)

- `command-hub-ownership-guard.js:1045`: the pattern is still one regex literal on one line, starting `/VTID-05063|VTID-05006|...` and ending `.../i;`. No new `/` or unescaped character was introduced. The history comment (1043-1045) follows the file's format. Existing tests that parse the line still hold: `command-hub-ownership-guard.test.ts` (`DEV-COMHU-\d+` still on the line, allowlist still evaluated before the carve-out), `vtid-04779-voice-section-rebuild.test.ts` (membership via `(.*)\/i;`), `vtid-04671-recommendation-card.test.ts` (`[^/]+` capture then `split('|')` contains 04671/04670), and the `[^\n]*VTID-04xxx` tests.
- `index.html:7,17`: `styles.css?v=` and `app.js?v=` are equal (`20261110-vtid-05063`). Every service-gateway test that touches the marker compares with `>=` / `>` against an older literal, requires equality of the two tags, or matches `2026\d{4}-vtid-\d{5}`; `20261110-vtid-05063` > `20261109-vtid-05006` lexically, and the 05003 test only forbids `20261109-vtid-05003`. No gateway test, workflow or script pins the old literal (only the docs/validation suites in M1 do).
- `new-route-without-auth-middleware.mjs:74-77`: the entry sits in the same array and style as `requireLedgerWriteAuth`.
- `vtid-auto-close.cjs:146`: warning text only. `test/vtid-05063-ledger-read-auth.test.ts:315` anchors on `const server = app.listen(PORT`, which exists once at `index.ts:1664` (the redirector listener at `index.ts:53` has no `const server`).
- COMMAND-HUB-GUARDRAILS jobs: ownership guard is satisfied by B1; the golden fingerprint and syntax gate build from source and are unaffected by these edits. PR-GATE `sparring` needs verdict, "owner approval" and "plan hash" text, all present in the record.

## Not verified

Anything needing execution (jest, tsc, node --check). Whether any of the M1 VTIDs fall inside the production..staging range today (that needs git and the production stamp); the nightly full run covers them regardless. Completeness of `scope.json` against the true changed-file list. Whether the prior-PR scope.json defects are enforced anywhere (config says no).
