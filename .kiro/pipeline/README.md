# Vitana pipeline runbooks (VTID-05275)

The single source of truth for how a Kiro session turns an owner task into a verified staging build:
plan → CI sparring (PLAN-SPAR) → CI VTIDs → parallel lanes → reviewer agent → serialized merge → staging deploy →
STAGING-VERIFY → Gate 2 *"Staging verified — ready for deployment to production?"*. Both runtimes follow these
files; the rules they apply are `.claude/rules/collaboration.md` (§7, §7a, §7b, §8, §8a, §8b) and `CLAUDE.md` Part 1.

| File | Used by | What it covers |
|---|---|---|
| `common-rules.md` | every step | merge authority, autonomy, never-list, git identity and push protocol, PowerShell notes, caps |
| `planning.md` | setup, investigate, spec, plan PR, spar loop, plan merge | from the owner task to a merged, policy-approved `plan(` PR with VTIDs |
| `lane-code.md` | lane coder step | the lane state machine, claim, worktree, red → green, verify, PR |
| `lane-review.md` | lane review step | how the caller runs `vitana-lane-reviewer` (model fallback chain) and records its verdict |
| `lane-land.md` | lane land step | review entry commit, merge lock, up to date with `main`, merge, rerun allowlist, slot hand-over |
| `driver.md` | Kiro Web | the same pipeline as one continuous session (lane `exceptions-seat`) |

Runtimes:
- **Kiro IDE:** launch `.kiro/workflows/vitana-pipeline.workflow.json` with the owner task as its only input. Its
  steps read these files; review steps run the workspace agent `.kiro/agents/vitana-lane-reviewer.md`, one step pinned
  per chain model `claude-sonnet-5.5` / `claude-opus-5.5` / `claude-sonnet-4.5`, racing in a `joinPolicy: "any"`
  parallel so an unavailable model never blocks the slot (`lane-review.md` "Model chain"). The SessionStart hook `.kiro/hooks/vitana-pipeline-start.json` loads the steering entry point.
  The command hooks `.kiro/hooks/vitana-workflow-watchdog.json` (SessionStart + UserPromptSubmit) report workflow runs
  paused by an agent restart or running with a stale heartbeat, and how to resume them (`restart-watchdog.md`).
- **Kiro Web:** follow `.kiro/pipeline/driver.md` in one continuous session (no workflow engine there).

The owner is asked only Gate 2 and an escalated sparring verdict (plus the §7 stop cases). Everything in between
runs without questions. VTIDs come only from CI PLAN-SPAR. Production only via the owner's PUBLISH, or a publish Kiro runs on
the owner's explicit command in the conversation (full, or one session's changes only; `collaboration.md` §7c).
