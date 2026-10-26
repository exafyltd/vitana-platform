# VTID-05337 acceptance — pipeline-speed/restart-watchdog
Source: `.kiro/specs/pipeline-speed/tasks.md`, lane `restart-watchdog` (W1–W4 and **Acceptance**). Deploys nothing
(a Kiro command hook, a node script and docs), so there is no staging suite; the proofs are the node tests below.
Outputs: `outputs/workflow-watchdog.test.txt` (12/12), `outputs/collab-all.test.txt` (113/113); red on base:
`red-on-base.txt` (9 fail / 3 pass, the 3 being regression guards).

AC-1 Only this workspace's paused runs and running runs with a heartbeat older than 10 minutes are reported;
completed, failed, aborted, fresh and other-workspace runs are not.
TEST: scripts/collab/workflow-watchdog.test.mjs "SessionStart: only this workspace's paused and stale-running runs are reported"
TEST: scripts/collab/workflow-watchdog.test.mjs "workspace match is case-insensitive with normalised separators on win32"

AC-2 A user pause is listed as "paused by user — not resumed"; own runs and other sessions' runs get different
instructions; `UserPromptSubmit` reports only the session's own runs.
TEST: scripts/collab/workflow-watchdog.test.mjs "restart pause vs user pause: user pauses are listed, never resumed"
TEST: scripts/collab/workflow-watchdog.test.mjs "own run vs other session's run get different instructions"
TEST: scripts/collab/workflow-watchdog.test.mjs "UserPromptSubmit reports only the session's own runs"

AC-3 Without a readable engine sessions folder the `run.json` ids are listed as a fallback; with engine state present
the fallback adds nothing; malformed files are skipped.
TEST: scripts/collab/workflow-watchdog.test.mjs "missing sessions dir: falls back to run ids from .agents/tasks/pipeline-*/run.json, exit 0"
TEST: scripts/collab/workflow-watchdog.test.mjs "run.json is only a fallback: with engine state present it adds nothing"
TEST: scripts/collab/workflow-watchdog.test.mjs "malformed JSON is skipped, the rest is still reported"

AC-4 The script never writes, always exits 0 and prints nothing when there is nothing to report.
TEST: scripts/collab/workflow-watchdog.test.mjs "nothing found → empty stdout, exit 0; bad stdin → exit 0"
TEST: scripts/collab/workflow-watchdog.test.mjs "read-only: no file is written in home or workspace"

AC-5 The hook file is `v1` with SessionStart and UserPromptSubmit command hooks running the watchdog, and
`.kiro/hooks/vitana-pipeline-start.json` is unchanged.
TEST: scripts/collab/workflow-watchdog.test.mjs "hook file: v1, SessionStart + UserPromptSubmit command hooks running the watchdog"
TEST: scripts/collab/workflow-watchdog.test.mjs "vitana-pipeline-start.json hooks[0] is unchanged"

AC-6 The collab suite and the steering guard stay green; every engine claim in `.kiro/pipeline/restart-watchdog.md`
is backed by the engine evidence in `commands.log`.
TEST: node --test scripts/collab/*.test.mjs (113/113, outputs/collab-all.test.txt)
TEST: node scripts/ci/kiro-steering/guard.cjs . (exit 0, commands.log)
