# Acceptance — VTID-05413 (guard-required-only-preflight / lane `guard-required-only`)

Change types: Tooling/docs.

Nothing deploys: developer tooling only, so staging-tests.json holds only the read-only `/alive` check.

AC-1: `preflight.mjs --required-only` exits 0 when only report-only checks fail (they are still printed) and `requiredOk` is true in `--json`.
TEST: scripts/collab/preflight.test.mjs "--required-only: a report-only-only failure exits 0 and is still printed; requiredOk tells the two apart" (outputs/green.txt)

AC-2: A required failure still exits 1 with `requiredOk` false.
TEST: scripts/collab/preflight.test.mjs "--required-only: a required failure still exits 1, with requiredOk false" (outputs/green.txt)

AC-3: A mixed required + report-only failure exits 1, `requiredOk` false, report-only failures still printed.
TEST: scripts/collab/preflight.test.mjs "--required-only: a required and a report-only failure together still exit 1, requiredOk false, report-only still printed" (outputs/green.txt)

AC-4: The push guard asks preflight for required-only status; a report-only failure is printed, does not block and is not cached.
TEST: scripts/collab/kiro-web-session.test.mjs "guard asks preflight for required-only status: a report-only failure is printed, not blocking, and not cached" (outputs/green.txt)

AC-5: The guard still blocks when preflight exits non-zero (a required failure).
TEST: scripts/collab/kiro-web-session.test.mjs "guard still blocks when preflight exits non-zero (a required failure under --required-only)" (outputs/green.txt)

AC-6: The new tests are red on base and the whole collab suite is green with the change.
TEST: outputs/red-on-base.txt (4 fail) vs outputs/green.txt (42/42) and node --test scripts/collab/*.test.mjs (outputs/collab-suite.txt, 0 fail)
