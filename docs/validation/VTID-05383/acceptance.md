# VTID-05383 acceptance (quality-checks-followup/steering-quality-checks, tasks.md T1-T5)

Change types: Tooling/docs. Surfaces, Locales, Accessibility: n/a (no UI). Contract: n/a, the generated format is
unchanged apart from one more `#[[file:]]` line. Staging proof: n/a, deploys nothing; proven by the test, a
fresh-workspace generation and the fresh-session probe. Red-on-base: `red-on-base.txt` (1 new test fails, 7 pass).

AC-1 `DRIVER_LINKS` ends with `.kiro/pipeline/quality-checks.md` and keeps driver, common-rules, planning; the file
exists in this repo.
TEST: node --test scripts/collab/kiro-web-steering.test.mjs

AC-2 Generating into an empty workspace writes the driver file with 4 links and `--check` passes; a link that does not
resolve still fails `--check` (existing tests unchanged).
TEST: node scripts/collab/kiro-web-steering.mjs --workspace <tmp> && node scripts/collab/kiro-web-steering.mjs --workspace <tmp> --check (outputs/fresh-workspace-generate.txt)

AC-3 A fresh session receives the content: probe with the change answers the Acceptance-template and Database
questions; the negative control (pre-change file) answers NOT IN CONTEXT.
TEST: outputs/fresh-session-probe.txt

AC-4 No change to kiro-web-session.mjs, preflight.mjs, AGENTS.md, driver.md (plan kiro-web-reliability); only the
lane's paths change.
TEST: node scripts/collab/preflight.mjs (Lane scope)
