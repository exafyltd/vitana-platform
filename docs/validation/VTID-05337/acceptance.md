# VTID-05337 acceptance (pipeline-speed/restart-watchdog, tasks.md W1-W4)

Every AC below is checked by the reviewer agent against the PR diff. Each maps to a TEST: within 12 lines.
Red-on-base output: `outputs/red-on-base.txt`. Full command log and engine evidence: `commands.log`.
Note: the win32 separator case (`ok 5 ... # SKIP`) is skipped on the Linux CI runner by design; it asserts win32
path normalisation and runs on win32 only.

AC-1 `scripts/collab/workflow-watchdog.mjs` scans the engine session dirs (home overridable for tests), keeps runs
whose `workspacePath` equals `cwd`, reports `paused` and stale `running` runs with the right own-vs-other-session
wording, lists a user pause as "paused by user — not resumed", filters to the session's own runs on
`UserPromptSubmit`, falls back to `run.json` run ids when the sessions dir is missing, and is silent when nothing
is found.
TEST: node --test scripts/collab/workflow-watchdog.test.mjs
TEST: node --test scripts/collab/*.test.mjs

AC-2 The script is read-only, never calls the network, always exits 0, writes no file, and prints nothing when
there is nothing to report; malformed JSON is skipped and the rest still reported.
TEST: node --test scripts/collab/workflow-watchdog.test.mjs

AC-3 `.kiro/hooks/vitana-workflow-watchdog.json` is `version: "v1"` with two command hooks (`SessionStart`,
`UserPromptSubmit`) running the exact watchdog command, and `.kiro/hooks/vitana-pipeline-start.json` `hooks[0]` is
unchanged; the steering guard stays green over the repo.
TEST: node --test scripts/collab/workflow-watchdog.test.mjs
TEST: node scripts/ci/kiro-steering/guard.cjs .
