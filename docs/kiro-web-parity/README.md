# Kiro Web session kit (plan `kiro-web-parity`)

A Kiro Web session gets ready with one command, run from the workspace root (the folder both repos are cloned into):

```bash
node vitana-platform/scripts/collab/kiro-web-steering.mjs   # rules: workspace-root steering (plan kiro-web-steering)
node vitana-platform/scripts/collab/kiro-web-session.mjs setup   # hooks, reviewer agent, deps, code intelligence
node vitana-platform/scripts/collab/kiro-web-session.mjs status  # what is ready; --check exits 1 if a required item is not
```

`setup` returns at once; dependencies and the RepoWise/Graphify indexes install in the background (log
`~/.cache/vitana-kiro-web/setup.log`, about 3 min on a fresh sandbox; `setup --wait` runs them in the foreground).

## What it gives a session

| Claude Code has | Kiro Web, with the kit |
|---|---|
| `.claude/settings.json` PostToolUse: `tsc --noEmit` after each gateway edit, blocks | `vitana-web-dirty` (PostToolUse) records a `services/gateway/src` edit; `vitana-web-guard` (PreToolUse on `execute_bash`) runs an incremental `tsc --noEmit` at `git commit` when a gateway edit was recorded or `services/gateway/src` differs from `HEAD`, and blocks it with the first 10 errors |
| — (preflight is a manual step in `driver.md:43`) | `vitana-web-guard` runs `scripts/collab/preflight.mjs` before every push of a `kiro/<slug>/<lane\|plan>` branch and blocks it with preflight's FAIL lines; a passed head is cached |
| RepoWise MCP + Graphify from SessionStart hooks | venv `~/.cache/vitana-codeintel/venv` (`~/.local` is read-only here) + the unchanged `scripts/codeintel/session-setup.sh`; use the CLI: `repowise search/context/risk`, `graphify query/path/explain` |
| gateway `node_modules` from SessionStart | `npm ci` in `services/gateway` and vitana-v1 when missing or the lockfile changed |
| GitHub MCP / `gh pr checks --watch` | `kiro-web-session.mjs wait --repo <owner/repo> --sha <sha>`: polls check runs every 120 s (max 1800 s) and prints each failed run's `--log-failed` tail |
| reviewer subagent | `.kiro/agents/vitana-lane-reviewer.md` copied to `<workspace>/.kiro/agents/` (byte-identical) |

The guard only adds checks. It never skips or loosens one and never passes `--no-verify`. It blocks only on a real
typecheck/preflight failure, on a pushed commit that is not the checked-out HEAD, or on `git commit && git push` in one
command (preflight would check the old commit). Its own errors never block. CI stays the gate. One narrow exception
does not block: Collab handoff failing **only** because PLAN-SPAR's `ci-plan-spar` commit and the planner both commit
on `<slug>/_plan` (`queue.mjs:595` counts it as a second session; CI shows it red and §7b handles it at merge). A lane
push before its PR exists names the title: `PR_TITLE='VTID-xxxxx (<slug>/<lane>): …' git push …`.

## What Kiro Web does — observed 2026-10-26 (evidence: `docs/validation/<VTID>/probes.md`)

- Command hooks run from `<workspace>/.kiro/hooks/*.json`, not from a repo's `.kiro/hooks/`; new files are picked up
  mid-session and also apply inside sub-agents.
- Only the **first** hook entry of a file runs; the kit writes one hook per file.
- `PreToolUse` exit 2 blocks the tool. A sub-agent sees the hook's stderr; the main session showed only `{}` on
  2026-10-26 and the full stderr on 2026-10-27, so the guard also writes every block to `~/.cache/vitana-kiro-web/last-block.txt` — when a command returns `{}`, read
  that file. `PostToolUse` output never reaches the agent. A `SessionStart` hook was not seen to fire.
- New sub-agents inherit the workspace hooks without being told (both guards blocked inside fresh sub-agents).
- An edit and a commit issued in one parallel batch race: the edit's PostToolUse can land after the commit's
  PreToolUse, so the guard also typechecks whenever `services/gateway/src` differs from `HEAD`.
- `<workspace>/.kiro/steering/*.md` (`inclusion: always`) loads on the next turn, also in sub-agents.
- `~/.local` is read-only; `~/.cache`, `/tmp` and the workspace are writable. Nothing survives a new sandbox.
- `<workspace>/.kiro/settings/mcp.json` cannot be written (platform permission rule): no MCP server registration.
- `gh api` (REST) works; GraphQL, `gh pr`/`gh issue` and `gh variable get` do not; `gh run view --log-failed` works.
- Sub-agents run concurrently.

## Still not at Claude Code parity

- **No MCP** for RepoWise/Graphify (CLI only).
- **Typecheck at commit, not after each edit** (PostToolUse output is not surfaced).
- **Main-session block reasons were sometimes hidden** (`{}`); the reason is always in `last-block.txt`.
- **No SessionStart trigger:** a fresh session runs the three commands above because its account learning or the
  workspace steering tells it to; a session that ignores both starts without hooks.
- **Fresh sandbox = fresh install** (~3 min in the background).
- **Writing pipeline steps stay sequential** (`driver.md`): sub-agents run in parallel, but Kiro Web has no workflow
  engine to run lanes in parallel worktrees with their own claims.
- **`CLAUDE_AVAILABLE` is unreadable** (403): treated as no override, as `collaboration.md` §7 says.
- **No direct Claude Code comparison** was run, so parity of speed and quality is unverified; the measured before/after
  numbers are in `docs/validation/<VTID>/parity-report.md`.
