# VTID-05343 acceptance (owner-autonomy/platform-rules, tasks.md P1-P5)

Every AC below is checked by the reviewer agent against the PR diff. Each maps to a TEST: within 12 lines.
Red-on-base output: `red-on-base.txt` (copy in `outputs/`). Command log with pass/fail counts: `commands.log`.

AC-1 `.kiro/steering/vitana-owner-autonomy.md` is always-included. It carries the owner's 2026-10-27 instruction for
every kind of work, with STAGING-VERIFY as the default end point for commit work, and one stop table whose twelve rows
each cite the existing rule and say whether it can stop work before STAGING-VERIFY. No rule is loosened.
TEST: node scripts/ci/kiro-steering/guard.cjs .

AC-2 `checkOwnerAutonomy` fails on a missing file, a non-always inclusion, each of the fifteen dropped anchors, and a
`vitana-pipeline.md` without the pointer. Fixtures without `vitana-pipeline.md` stay green, and `check()` runs it.
TEST: node --test scripts/ci/kiro-steering/guard.test.cjs

AC-3 `vitana-pipeline.md` names migration approval (§7d) and protected gate files (§3a), points to the rule file, and
extends the no-ask rule to non-commit work. The generator mirrors the new file into a Kiro Web workspace.
TEST: node --test scripts/collab/*.test.mjs

AC-4 `docs/kiro/kiro-web-bootstrap.md` records the audit and what persists. The Configuration Sync file carries the
short standing instruction and stop list, and says to re-upload after a change.
TEST: node scripts/ci/kiro-steering/guard.cjs .
