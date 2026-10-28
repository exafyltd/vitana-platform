# VTID-04009 — Agent executor: tsc runs out of V8 heap on the executor task (found by Test Run #4)

Context: Test Run #4 (VTID-04008, execution `47a4d6eb`, staging, 2026-09-17 19:28Z) was the first real run of the agentic executor (VTID-04006) on the `vitana-autopilot-executor` ECS task (revision 9, 2 vCPU / 4 GB). The model did the task correctly — read both named files, searched for `renderCiEvidence(`, found and edited the unlisted caller (`dev-autopilot-watcher.ts`), extended the test, ran the paired jest suites green — but every `run_check tsc` died after ~2 min with a V8 `allocation failure` at ~2 GB (`Scavenge 2039.3 (2082.2) -> 2038.7 (2082.7) MB`), three times in a row, leaving `core.*` dumps in the clone. The post-hoc runner (`runTsc` in `agent-validate.ts`) shares that exact path, so each fix round would fail identically until the round cap. Node's default old-space on that task is ~2 GB regardless of the 4 GB container limit; the gateway project needs more.

Measured locally (this repo, `node --max-old-space-size=3072 node_modules/.bin/tsc --noEmit -p tsconfig.json`, peak RSS polled from `/proc`): exit 0, 47 s, peak RSS 2497 MB. So 3072 MB fits a 4 GB task with headroom for the agent process; no task-definition resize is needed.

AC-1 — `runTsc` spawns tsc with `NODE_OPTIONS` carrying `--max-old-space-size=<N>`, appended after any inherited `NODE_OPTIONS` so the cap wins; the args and `CI=true` are unchanged. Both the model's `run_check tsc` and the post-hoc runner go through `runTsc`, so one change covers both.
TEST: services/gateway/test/autopilot-agent-scope-validate.test.ts

AC-2 — The heap defaults to 3072 MB and is env-tunable via `AGENT_CHECK_HEAP_MB`; a missing, non-numeric, or non-positive value falls back to the default rather than producing a broken flag.
TEST: services/gateway/test/autopilot-agent-scope-validate.test.ts

AC-3 — jest, node_check and git checks are unchanged (no `NODE_OPTIONS` injected — jest forks workers and a per-worker heap cap would multiply memory).
TEST: services/gateway/test/autopilot-agent-scope-validate.test.ts

AC-4 — `.env.example` documents `AGENT_CHECK_HEAP_MB` next to the other `AGENT_*` executor settings (impact-scan `new-env-var-requires-workflow-binding`).
TEST: services/gateway/test/autopilot-agent-scope-validate.test.ts

Not verified here: a real executor run with the new image. That is the re-run of Test Run #4 after `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` rebuilds the image from this commit.
