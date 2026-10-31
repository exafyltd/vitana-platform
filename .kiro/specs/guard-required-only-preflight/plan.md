---
change_class: light
---
# plan(guard-required-only-preflight): the Kiro Web push guard blocks only on failures CI requires
<!-- plan:begin -->
## Problem
`scripts/collab/kiro-web-session.mjs` `guard` (PreToolUse on `execute_bash`) runs `scripts/collab/preflight.mjs`
before a push of a `kiro/<slug>/<lane>` branch and blocks whenever preflight exits non-zero (`checkPush`, the
`p.status === 0` branch, then `return block(... "CI would fail the same way")`). The only exemption is
`onlyPlanSparSessionFalsePositive`. The file header says the guard "Blocks only on a real failure" and "CI stays the gate".

`preflight.mjs` labels every check `required` or `report-only in CI` (Collab handoff on vitana-v1 and the PR-GATE
Verdict checks while `config.enforce` is not true), but `main()` returns 1 on any failing check
(`return report.ok ? 0 : 1`). So the guard blocks on failures CI does not block on.

Observed: vitana-v1 PR #1520 (lane `new-member-welcome/say-hello-composer`). vitana-v1's mandatory I18N-PROPAGATE
workflow commits into any PR that edits `src/i18n/de/**` as github-actions[bot] without Collab trailers (commits
`b27354288`, `1465834a9`). `queue.mjs validate` then reports "a lane PR needs Collab-Session and Collab-Lane trailers on
every commit". On vitana-v1 that step is report-only in CI and Lane scope (required) passes, yet the guard blocks
every further push. Every v1 lane PR that edits German strings hits this. Earlier a report-only PR-GATE check blocked
a push the same way.

## Change — one lane `guard-required-only` (vitana-platform, local guard alignment only)
1. `preflight.mjs`: export `isRequired(check)` (label starts with `required`); the report gains `requiredOk` (no
   failing required check). New flag `--required-only`: exit status follows `requiredOk`; output is unchanged, so every
   failure, including report-only ones, is still printed. Without the flag the exit status stays "any failure → 1", so
   every other caller (runbooks, `lane-code.md`, `planning.md`, `driver.md`) is unaffected. `--json` consumers get the
   extra `requiredOk` field.
2. `kiro-web-session.mjs` `checkPush`: pass `--required-only`. Exit 0 with a `FAIL` line in the output means only
   report-only checks failed: the guard allows the push and shows them (`ok` message, "report-only in CI and failed (not
   blocking)"), and does not write the passed-head cache so they are shown again on the next push. Exit non-zero blocks
   as today; the PLAN-SPAR exemption, the commit+push block, the pushed-commit != HEAD block and the missing-title block
   are untouched.
3. Not changed: `queue.mjs` and every file in `protected-gate-files.json`; no CI check is weakened or relabelled;
   `ciLabel` and the label logic stay the single source of what is required.
- Tests (red on base): `preflight.test.mjs` — report-only-only failure (`scope` fixture) exits 1 by default but 0 with
  `--required-only` and is still printed, `requiredOk` true; a required failure (`trailer` fixture) exits 1 with
  `requiredOk` false; a mixed failure (`{ trailer: true, scope: true }`) exits 1 by default and with `--required-only`,
  `requiredOk` false, and the report-only `PR-GATE scope` failure is still printed. `kiro-web-session.test.mjs` — preflight is invoked with `--required-only`; exit 0 with a
  report-only `FAIL` is allowed, printed and not cached; exit 1 still blocks; the existing PLAN-SPAR exemption test stays green.
- Commands: `node --test scripts/collab/preflight.test.mjs scripts/collab/kiro-web-session.test.mjs`, then
  `node --test scripts/collab/*.test.mjs`, `node scripts/collab/queue.mjs validate`.
## Unchanged
Preflight's checks and labels, CI workflows, queue.mjs, the default preflight exit status, the hard blocks of the guard.
## Risks
A report-only check that CI later makes required (`config.enforce=true`) flips its label to `required` through
`ciLabel`, and the guard then blocks on it with no further change.
<!-- plan:end -->
