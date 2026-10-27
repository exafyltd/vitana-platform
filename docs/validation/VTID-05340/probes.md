# VTID-05340 — Kiro Web capability probes (session `kiro-exafy-202610261526-5cd7`, 2026-10-26)

Each line: what was run, what came back. Probe hooks/files were removed afterwards.

| # | Probe | Result |
|---|---|---|
| P1 | `which repowise graphify` in a fresh sandbox | not found |
| P2 | `uv tool install repowise` | `failed to create directory /root/.local/share/uv/tools: Read-only file system (os error 30)` |
| P3 | `touch` in `/root`, `/root/.local/bin`, `/usr/local/bin` / `/root/.cache`, `/tmp`, `/projects/sandbox` | read-only / writable |
| P4 | `uv venv ~/.cache/vitana-codeintel/venv && uv pip install repowise 'graphifyy[bedrock]'` | rc 0 in 3 s; repowise 0.59.0, graphify 0.9.96 (distribution `graphifyy`) |
| P5 | PATH=venv `scripts/codeintel/session-setup.sh --foreground vitana-platform` | `ready in 118s (repowise=true, 4733 pages; graphify=true)`, RepoWise seeded from the CI index |
| P6 | `repowise search "preflight governance checks"`, `repowise context scripts/collab/preflight.mjs` | answers in 4 s / 2 s |
| P7 | write `<workspace>/.kiro/settings/mcp.json` | `Blocked by a permission rule (deny fs_write …)` |
| P8 | `ls services/gateway/node_modules`; `npm ci` | missing; 850 packages in 13 s |
| P9 | `tsc --noEmit` (gateway) full / `--incremental` warm | 78 s / 7 s, 0 errors |
| P10 | `preflight.mjs` on `main` | all 8 checks pass, 12 s |
| P11 | `<workspace>/.kiro/hooks/x.json` PostToolUse `execute_bash`, created mid-session | fired on the next commands (log lines 15:28:00Z ff.), also for a sub-agent's commands |
| P12 | PreToolUse `execute_bash`, exit 2 on `BLOCKME` | tool not executed; stdin `{session_id, hook_event_name, cwd, tool_name, tool_input:{command, cwd, …}}`. on 2026-10-26 the main session showed blocked calls as `{}` without the hook's stderr; on 2026-10-27 (P25) it showed the full stderr; sub-agents always did |
| P13 | PostToolUse on `fs_write`/`str_replace`, stdout + stderr, exit 0 and exit 2 | hook ran (log written); nothing shown to the agent |
| P14 | one file with 3 hook entries / 2 files with 1 entry each | only the first entry ran / both ran |
| P15 | SessionStart command hook + new sub-agent session | did not fire |
| P16 | `<workspace>/.kiro/steering/zz-canary.md` (`inclusion: always`) | a new sub-agent quoted the canary word; the main session received it as an injected rule on the next turn |
| P17 | repo-level `vitana-platform/.kiro/hooks/*.json`, `.claude/settings.json` hooks | never ran (not read in Kiro Web) |
| P18 | `gh api user`, `…/pulls`, `…/check-runs` / `gh api graphql` / `gh variable get CLAUDE_AVAILABLE` / `gh api …/jobs/<id>/logs` / `gh run view <id> --log-failed` | ok / `GraphQL pass-through is not supported` / HTTP 403 / HTTP 404 / ok |
| P19 | two sub-agents each `sleep 25` | `B start 15:28:09.40, A start 15:28:10.10, B end 15:28:34.41, A end 15:28:35.11` — concurrent |
| P20 | `.kiro/agents/vitana-lane-reviewer.md` copied to `<workspace>/.kiro/agents/`, prompt naming no model | `{"error":"model_unavailable",…}` as its definition requires |

## Live guard demonstrations (throwaway worktree, branch never pushed)
- Seeded `const VTID_C2: number = 'VTID-01081';` in `services/gateway/src/routes/health.ts`, `git commit` → blocked:
  `src/routes/health.ts(26,7): error TS2322: Type 'string' is not assignable to type 'number'.` Fixed → commit passed.
- Illegal lane change (`pipeline-speed/lanes/preflight.md` `done` → `ready`), `git push nowhere-remote kiro/kiro-web-parity/demo`
  → blocked before git ran: `"done" is terminal (changed to "ready")`, missing `Collab-Lane`, PR-GATE scope.
- Real catch on this plan: the re-plan push of `kiro/kiro-web-parity/plan` was blocked once by Collab handoff
  (`ci-plan-spar` counted as a second `_plan` session); diagnosed as the known governance-artifact false positive (CI
  showed the same red on #4378), now passed narrowly by `onlyPlanSparSessionFalsePositive` with a test.

## Sub-agent runs (2026-10-27, fresh `general-task-execution` sub-agents, not told about the hooks)
`.agents/subagent-race.log`:
```
A start  08:48:37.725   B start 08:48:43.490   B end 08:49:45.969   A end 08:50:53.785   (A and B overlapped 62 s)
A2 start / end: sequential rerun, see below
```
| # | Test | Result |
|---|---|---|
| P21 | B: illegal lane transition `done → ready`, `PR_TITLE=… git push nowhere kiro/kiro-web-parity/demo-b` | **blocked** by the inherited guard, preflight FAIL lines shown verbatim to the sub-agent (`"done" is terminal`, missing `Collab-Lane`) |
| P22 | B: after `git reset --hard origin/main`, same push | still blocked, correctly: `Lane scope — not a lane PR` (a `kiro/<slug>/<x>` branch with no lane commits). The demo design could not pass; the pass-after-fix is shown on the real lane (P25) |
| P23 | A: `str_replace` seeding TS2322 and `git commit` issued **in the same parallel batch** | not blocked: the edit's PostToolUse marker landed after the commit's PreToolUse. Marker was created and later cleared (dirty dir mtime 08:50:50), so both hooks did run in the sub-agent. Fixed: the guard now also triggers on `git diff --name-only HEAD -- services/gateway/src` (test added) |
| P24 | A2 (sequential, after the fix): seeded TS2322, `git commit` | **blocked**: `src/routes/health.ts(26,7): error TS2322 …`, HEAD unchanged; fixed to `string`, commit `068a742fdf` passed |
| P25 | main session, real lane: lane file `executing → done` (illegal) committed, push | blocked with the full preflight message (`illegal transition "ready" → "done"`, the base lane state on `main`); fixed to `executing → in-review`, push passed |
- P26 (main, real lane): push with the lane file `ready → in-review` in one PR → blocked (illegal transition); state kept `executing` as the sibling lane did (#4379/#4381) → push passed.
