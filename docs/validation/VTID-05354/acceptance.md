# VTID-05354 acceptance (pipeline-agent-wake-and-review/driver-wake, tasks.md W1-W5)

Every AC maps to a TEST: within 12 lines. Raw output: `outputs/red-on-base.txt`. Commands: `commands.log`.
Change types: Infrastructure/CI, Tooling/docs (governance paths, no protected gate file). Deploys nothing.

AC-1 Events: a PLAN-SPAR workflow_run (success or failure) on a same-repo `plan(<slug>)` PR, a push to
`kiro/<slug>/…` or `kiro/close/<slug>/…` whose commits carry `Collab-Verdict:`, and a manual dispatch give a slug;
everything else, forks and invalid slugs (`a;rm -rf /`, `../x`, `Upper`, `$(id)`, empty) skip. The slug regex is
byte-equal to queue.mjs and plan-driver.mjs.
TEST: node --test scripts/collab/driver-wake.test.mjs ("parseEvent …", "slug regex …")

AC-2 Decision order: no key → green no-op with the summary line; heartbeat < 45 min → skip; marker < 20 min → skip;
≥ 6 markers in the last hour → skip; else wake. Each guard is load-bearing (mutation checks in commands.log).
TEST: node --test scripts/collab/driver-wake.test.mjs ("decide: every branch", "CLI run: missing key …")

AC-3 Markers: tree = main's, fast-forward (no force), markers older than 2 h deleted; the prompt is a fixed sentence
plus the validated slug; the workflow checks out `main`, never the pushed branch, and reads no event text into the
prompt; the push trigger is limited to lane files; the advisory job never fails a lane head (continue-on-error) and skips
while the script is not on main.
TEST: node --test scripts/collab/driver-wake.test.mjs ("markers …", "wakePrompt …"); .github/workflows/DRIVER-WAKE.yml (ruby YAML parse, commands.log)

AC-4 The woken session never merges, publishes or writes a live system, and reuses driver.md; turn-on/turn-off steps
for the owner are documented.
TEST: docs/kiro/driver-wake.md ("For the woken session", "Turn it on", "Turn it off")
