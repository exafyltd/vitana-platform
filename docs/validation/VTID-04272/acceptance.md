# VTID-04272 — Fix npm audit CVE findings in services/gateway (unblock the Dev Autopilot pipeline)

## Report

The user asked for the Dev Autopilot self-healing/self-improving loop's
outstanding findings to be processed to zero, one plan → verify → execute
pass per finding, so the pipeline can then run its scan → plan → approve →
execute → merge → deploy → verify cycle continuously.

Checked the real backlog first (`autopilot_recommendations`, live query):
18 rows, not the Command Hub's "30 NEW FINDINGS" stat (a different
aggregate). Of those, exactly **one** is `auto_exec_eligible:true` —
`9e1bdb97-d4ec-449d-a00b-5ec70428cada`, "CVE: package.json"
(`npm-audit-scanner-v1`). Per this file's own CHANGE LOG (VTID-04237/
VTID-04243/VTID-04246 rows), that finding has already burned 5+ failed
agent-executor attempts, each exhausting the 120-turn cap at ≈5.5M input
tokens, because the agent's tool surface (`run_check` = tsc/jest/git only)
has **no package-manager tool** — it can read `package-lock.json` but can
never run `npm install`/`npm audit fix`. It also left a stranded, unmerged
PR (#3543) that the executor's own duplicate-PR guard now refuses to
re-open a PR against, blocking every further automated retry.

Rather than let the broken automated retry loop burn more tokens on a
finding it structurally cannot solve, this VTID does the fix directly: run
`npm audit fix` for real, verify build + full test suite, and land the
change so the finding can be marked resolved and the pipeline's one
blocking row is cleared. This is the prerequisite step for the user's
broader ask — the remaining ~16 non-auto-exec-eligible findings, and
confirming the loop keeps cycling, are the next steps after this merges.

## Acceptance Criteria

AC-1 — `npm audit fix` (non-force, in `services/gateway`) resolves all 4
CRITICAL CVEs and reduces total findings from 41 (2 low / 14 moderate / 21
high / 4 critical) to 16 (9 moderate / 7 high), touching only
`package-lock.json` — `package.json` is unchanged, and every bump stays
within its existing declared semver range (no `--force`, no major-version
jump introduced by this pass). The remaining 16 vulnerabilities all require
a major-version bump (`firebase-admin`→14.4.0, `@anthropic-ai/sdk`→0.127.0,
`sharp`→0.35.4) and are deliberately deferred as a separate, riskier
follow-up — not attempted here.
TEST: see `commands.log` (real `npm audit --json` before/after counts,
reproducible with `cd services/gateway && npm audit --omit=dev` — dev-only
findings are also included in the 41/16 counts above since the CVE finding
itself scans the whole `package.json`).

AC-2 — The `npm audit fix` bump (specifically `sanitize-html`'s own
transitive `htmlparser2` moving from `^10.1.0` to `^12.0.0`, an ESM-only
package nested at
`node_modules/sanitize-html/node_modules/htmlparser2/`) does not break the
Jest suite. `jest.config.js`'s `transformIgnorePatterns` now allow-lists a
package at ANY nesting depth under `node_modules/`, not only directly
under the first `node_modules/` segment.
TEST: services/gateway/test/vtid-04272-jest-transform-ignore-nested-node-modules.test.ts

AC-3 — The full gateway Jest suite passes with zero failures with both the
`package-lock.json` change and the `jest.config.js` fix applied together
(the regression this VTID both introduces via the audit fix and repairs in
the same commit never reaches `main` in a broken state).
TEST: services/gateway/test/vtid-04272-jest-transform-ignore-nested-node-modules.test.ts
(full-suite run recorded in `commands.log` — 1059/1060 suites, 1 pre-existing
skip, 17,288/17,323 tests passing, 0 failures)

AC-4 — `tsc --noEmit` is clean after both changes.
TEST: recorded in `commands.log` (`npx tsc --noEmit`, exit 0, no output)

## Route evidence

No route is added, removed, or mounted by this change — it is a dependency
lockfile bump plus a Jest test-tooling config fix, with one new regression
test under `services/gateway/test/`. The Route Mount Evidence Gate does
not apply.

## Not yet independently confirmed live

The `dev_autopilot_executions`/`autopilot_recommendations` rows for finding
`9e1bdb97` and its duplicate `7a93bca4` (VTID-04261) are not yet marked
resolved from this session — that update, and closing stranded PR #3543,
follow once this PR is merged and deployed, per this repo's own convention
of not hand-writing production DB state from a session ahead of the code
actually shipping. The remaining ~16 non-auto-exec-eligible findings in the
backlog, and re-confirming the Dev Autopilot scan → plan → approve →
execute cycle keeps running with this row cleared, are the direct next
steps.
