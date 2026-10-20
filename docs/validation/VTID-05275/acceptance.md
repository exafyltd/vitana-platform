# Acceptance: VTID-05275 (kiro-autonomy-fallback/reviewer-agent: reviewer agent + pipeline recipe)
Kiro configuration, runbooks and a CI guard only. No gateway runtime code, no migration, no deploy. Each AC is the
lane's acceptance in `.kiro/specs/kiro-autonomy-fallback/tasks.md` (group `reviewer-agent`) mapped to a verification.

AC-1: the guard tests and the guard itself are green, red on base is recorded, and the guard stays green in a repo
without `scripts/collab/queue.mjs` (vitana-v1 shape).
TEST: node --test scripts/ci/kiro-steering/guard.test.cjs  # => tests 31, pass 31 (base: pass 8, fail 23; red-on-base.txt)
TEST: node scripts/ci/kiro-steering/guard.cjs .  # => kiro-steering: OK (base tree: exit 1, agent/workflow/hook missing)

AC-2: the agent runs on claude-sonnet-5.5 with no write, web or MCP tool, a read-only shell allow-list, a
model_unavailable self-check, the plan 4.2 verdict and 4.1 entry output, and protected files blocking for agent-only
acceptance.
TEST: node --test scripts/ci/kiro-steering/guard.test.cjs  # => the 12 "agents:" tests pass on this head and fail on base

AC-3: the workflow recipe passes the Kiro workflow schema (validation only, no launch), takes only the owner task,
pins every review step to vitana-lane-reviewer / claude-sonnet-5.5, caps parallel lanes at 6 and serializes merges
with the merge lock.
TEST: node --test scripts/ci/kiro-steering/guard.test.cjs  # => the 9 "workflow:" tests pass
TEST: zod transcription of the installed Kiro IDE workflow schema against the recipe  # => valid, 28 steps (commands.log)

AC-4: the SessionStart hook loads the pipeline steering entry point and resumes stale drivers.
TEST: node --test scripts/ci/kiro-steering/guard.test.cjs  # => the "hook:" test passes

AC-5: the pipeline runbooks contain no slug-specific text and no instruction to ask the owner outside Gate 2 or an
escalated sparring verdict.
TEST: node --test scripts/ci/kiro-steering/guard.test.cjs  # => the "runbooks:" test passes; guard.cjs . checks the shipped files

AC-6: deploys nothing; the diff stays inside the lane's paths; OASIS impact none.
TEST: node scripts/collab/queue.mjs scope-check --base origin/main --head HEAD  # => every change is inside its paths

See commands.log, red-on-base.txt and outputs/ for captured results.
