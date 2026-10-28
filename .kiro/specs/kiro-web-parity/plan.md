---
change_class: standard
---
# plan(kiro-web-parity): Kiro Web session kit — ready tools, enforced local checks before commit/push, CI wait without manual polling
Author: Kiro, seat `exafy`, session `kiro-exafy-202610261526-5cd7` (Kiro Web). Repo: `exafyltd/vitana-platform` only.
Premises pinned to `origin/main` `b117ce6216` (contains `kiro-web-steering`, #4378/#4379). Detail: `tasks.md`; lane file: `lanes/session-kit.md`.
Sibling plan `kiro-web-steering` (VTID-05339, merged as #4379) mirrors the repos' steering to the workspace root
(`scripts/collab/kiro-web-steering.mjs`). This plan does **not** touch steering generation, `AGENTS.md` or
`docs/kiro/**`; it only reads the generator's `--check` result. No shared file except the one-line program entry.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-26 (Kiro Web): *"The goal is Claude Code parity in execution speed, quality, and autonomy—not just
configuration improvements."* … *"Do not assume that creating a configuration file makes a capability work.
Demonstrate that rules load, hooks execute, and tools connect. If Kiro Web does not support a capability, implement the
best supported fallback and clearly explain the remaining limitation."* … *"Do not weaken checks or bypass safeguards
to appear faster."* This plan delivers the parts that are not steering: dependencies and code intelligence ready in a
fresh sandbox, the Claude Code PostToolUse typecheck and the preflight enforced locally before a commit/push, and a
bounded CI wait that prints the failed log instead of manual polling.

## 2. Today (`origin/main` `b117ce6216`; repo premises are file:line, sandbox premises are probes of this session)
Repo:
1. `.claude/settings.json:53` — the Claude Code PostToolUse typecheck runs `cd /home/user/vitana-platform/services/gateway
   && npx tsc --noEmit` after each Edit/Write under `services/gateway/src`; Kiro Web never reads this file and the repos
   are not at `/home/user`.
2. `.claude/hooks/session-start-codeintel-setup.sh:19` — `[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0`: the only
   caller of `scripts/codeintel/session-setup.sh` exits outside Claude Code remote.
3. `scripts/codeintel/session-setup.sh:71-79` — `install_tool` tries `uv tool install` (`:75`) then
   `python3 -m pip install --user` (`:77`); both write under `~/.local`.
4. `.kiro/pipeline/driver.md:43` — "Preflight before every push of a `plan(` or lane branch"; nothing enforces it.
   `scripts/collab/preflight.mjs:27-28` and `:117` — the working-tree checks need `--head` = the checked-out HEAD.
5. `.kiro/pipeline/common-rules.md:62` — polling every 2-3 min inside bounded scripts; no such script exists for CI checks.
6. `scripts/collab/queue.mjs:85` — `scripts/collab/**` is a governance path; `:234` lets an `executor: kiro` lane with
   a reviewer-agent `reviewer_seat` change one that is not a protected gate file
   (`scripts/collab/protected-gate-files.json` does not list the new files).
7. `.github/workflows/PR-GATE.yml:140` — `node --test scripts/collab/*.test.mjs`, so a new collab test runs in CI.
8. `scripts/collab/kiro-web-steering.mjs:13-15` — the merged generator and its `--check` (exit 1 on any problem).
Sandbox (Kiro Web, 2026-10-26; commands and outputs go to `docs/validation/<VTID>/probes.md`):
9. `~/.local` is read-only: `uv tool install repowise` → `failed to create directory /root/.local/share/uv/tools:
   Read-only file system`. `~/.cache` is writable; a venv there installs repowise 0.59.0 + graphify 0.9.96 in 3 s, and
   with it on `PATH` `session-setup.sh --foreground` reached `state: ready` (RepoWise seeded from the CI index, 4733
   pages; Graphify built) in 118 s; `repowise search` / `context` answer in 2-4 s.
10. Writing `<workspace>/.kiro/settings/mcp.json` is denied by a platform permission rule: no MCP registration.
11. Fresh sandbox: `services/gateway/node_modules` absent; `npm ci` 13 s; full `tsc --noEmit` 78 s; warm
    `--incremental` re-run 7 s.
12. `<workspace>/.kiro/hooks/*.json` command hooks execute (the repos' own `.kiro/hooks` do not): a `PreToolUse` hook on
    `execute_bash` blocked a command with exit 2 and its stderr reached the agent; stdin is `{session_id,
    hook_event_name, cwd, tool_name, tool_input}`. `PostToolUse` on `fs_write`/`str_replace` runs but its output never
    reaches the agent. Only the **first** hook entry of a file runs. `SessionStart` was not seen to fire.
13. GitHub: REST via `gh api` works (`push: true`); GraphQL refused by the proxy; `gh variable get` → 403;
    `gh run view <id> --log-failed` works.
14. Sub-agents run concurrently; the reviewer agent works when copied to `<workspace>/.kiro/agents/`.
## 3. Change — one lane `session-kit` (vitana-platform)
**Lane file:** `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer` (`scripts/collab/**` is a governance path,
`queue.mjs:85`; an `executor: kiro` lane may change one with the reviewer agent, `queue.mjs:231-234`), `seat: exafy`,
`area: platform`, `paths`: `scripts/collab/kiro-web-session.mjs`, `scripts/collab/kiro-web-session.test.mjs`,
`docs/kiro-web-parity/**`, `docs/validation/VTID-*/**`. None is a protected gate file. Small task: one lane.

**A. `scripts/collab/kiro-web-session.mjs`** (Node ≥ 20, ESM, no dependencies, exports its functions). Workspace =
`--workspace`, else the parent of the vitana-platform checkout holding the script; repos found by `origin`.
Subcommands:
1. `setup [--wait]` — idempotent, never fails the session (exit 0, problems listed):
   a. writes the generated hooks (one hook per file, §2.12) under `<workspace>/.kiro/hooks/`, each carrying the marker
      `"generatedBy": "vitana-platform/scripts/collab/kiro-web-session.mjs"`; stale marked files are removed, unmarked
      files never touched; nothing is written inside a repository:
      - `vitana-web-guard.json` — `PreToolUse`, matcher `^execute_bash$`, runs `node <platform>/scripts/collab/kiro-web-session.mjs guard`;
      - `vitana-web-dirty.json` — `PostToolUse`, matcher `^(fs_write|str_replace)$`, runs `… mark-dirty`;
   b. copies `.kiro/agents/vitana-lane-reviewer.md` to `<workspace>/.kiro/agents/` (byte-identical, so the driver's
      review step can run it);
   c. starts, detached, logging to `~/.cache/vitana-kiro-web/setup.log`: `npm ci` in `services/gateway` (and in
      vitana-v1 when present) when `node_modules` is missing or `package-lock.json` changed since the last stamp; the
      code-intelligence venv `~/.cache/vitana-codeintel/venv` (`uv venv` + `uv pip install repowise 'graphifyy[bedrock]'`
      — the PyPI distribution is `graphifyy`, its command `graphify`, as `scripts/codeintel/session-setup.sh:95` installs
      it; pip fallback), then `scripts/codeintel/session-setup.sh --foreground <repo>` per repo with the venv on `PATH`
      (the script is reused unchanged); `--wait` runs the same in the foreground;
   d. with `DEV_MEMORY_PACK_TOKEN` set, prints the developer morning pack (`.claude/hooks/session-start-dev-memory-pack.sh`,
      reused; read-only GET, ≤ 15 s); without it says so and points to git as the task state (queue, plan files);
      `--no-install` skips it (no network);
   e. prints the `status` report.
2. `status [--json] [--check]` — readiness of: workspace steering (`kiro-web-steering.mjs --check` exit 0, §2.8), generated hooks, reviewer agent copy, gateway/v1 `node_modules`, RepoWise/Graphify state
   (`~/.cache/vitana-codeintel/<repo>.json`), `gh api user`, GraphQL (reported unsupported, not a failure), presence
   (never the value) of `DEV_MEMORY_PACK_TOKEN` / `GATEWAY_SERVICE_TOKEN`. `status` makes no gateway call.
   `--check` exits 1 when a required item is missing.
3. `mark-dirty` (PostToolUse) — reads the hook stdin; when `tool_input.path` is under `<repo>/services/gateway/src/`,
   touches `~/.cache/vitana-kiro-web/dirty/<repo>-gateway`. Always exit 0, prints nothing (output is not surfaced).
4. `guard` (PreToolUse on `execute_bash`) — reads the hook stdin, parses `tool_input.command` and `tool_input.cwd`:
   - `git … commit` in a repo whose gateway dirty marker exists → `tsc --noEmit --incremental` in `services/gateway`
     (build info under `~/.cache`); errors → exit 2 with the first 10 `error TS` lines on stderr (the Claude Code
     PostToolUse rule, moved to the first point Kiro Web can block); clean → marker cleared, exit 0.
   - `git … push` of a branch `kiro/<slug>/<lane|plan>` (forms `git push origin <sha>:refs/heads/<b>`,
     `git push origin <b>`, `git push -u origin <b>`, with or without `-C <dir>`) → `preflight.mjs --repo <dir> --base
     origin/main --head <sha or HEAD> --branch <b>` with `--title` from the open PR of that branch (`gh api`, REST)
     when one exists; failure → exit 2 with preflight's failure block on stderr. A pass is cached per
     `(repo, head sha)` so a retried push does not re-run it. When the pushed sha is not the checked-out `HEAD`, the
     guard blocks and says so (`preflight.mjs:117`). A lane push before its PR exists carries the title as
     `PR_TITLE` **in the same bash command**: the POSIX prefix `PR_TITLE='…' git push …` (single or double quotes) on
     the push itself, or `export PR_TITLE='…' &&` earlier in that command; a prefix on another segment does not count,
     and a title set in an earlier tool call is not visible (the hook process does not share the shell's
     environment). Without a PR and without `PR_TITLE` the guard blocks and names the form (preflight fails without
     `--title`). This is how the first push of a lane works: the PR can only be opened after that push. The failure shown is preflight's FAIL lines without the queue table.
   - pushes of `collab-claim/**`, `collab-driver/**`, ref deletions, and every other command → exit 0 at once.
   - an internal error (bad stdin, missing script) → exit 0 with a stderr note; the guard never blocks on its own bug.
     It adds checks only; it never skips or loosens one, and CI stays the gate.
5. `wait --repo <owner/repo> --sha <sha> [--timeout <s>] [--interval <s>]` — polls the commit's check runs via REST
   (default every 120 s, timeout 1800 s, `common-rules.md` 10); returns as soon as every run is completed: exit 0 when
   none failed, 1 with, for each failed run, its name, URL and `gh run view <id> --log-failed` (last 80 lines);
   exit 3 on timeout with what is still pending.

**B. `docs/kiro-web-parity/README.md`** — what Kiro Web supports (observed §2, with the probe evidence), how a fresh
session gets ready (one command: `node vitana-platform/scripts/collab/kiro-web-session.mjs setup`, triggered by the
account learning and, once `kiro-web-steering` is on `main`, by its workspace steering), and the remaining limits
(§6).

## 4. Tests (`scripts/collab/kiro-web-session.test.mjs`, `node:test`, temp fixture workspaces, no network)
Written first, recorded red on `origin/main` (the module does not exist there). Run by PR-GATE Collab tests
(`node --test scripts/collab/*.test.mjs`, `PR-GATE.yml:140`).
1. `setup` writes exactly the two hook files with the marker, one hook entry each, correct trigger/matcher/command;
   a stale marked file is removed; an unmarked file is untouched; nothing is written inside a repository.
2. Reviewer agent copy is byte-identical; re-running `setup` is a no-op (same bytes).
3. `mark-dirty`: gateway `src` path → marker; other path → none; malformed stdin → exit 0.
4. `guard` command parsing: every push form above yields `{repo, branch, sha}`; claim/driver refs and deletions are
   ignored; non-git commands pass; `PR_TITLE` from a single- or double-quoted prefix and from an earlier
   `export PR_TITLE=` segment, not from a prefix on another segment; no PR and no title → exit 2 naming the form.
5. `guard` decisions with an injected runner: failing preflight → exit 2 with its output on stderr; passing → exit 0
   and cached (second call does not run it); dirty + tsc errors on commit → exit 2; dirty + clean → marker cleared;
   pushed sha ≠ HEAD → exit 2; internal error → exit 0.
6. `wait` with an injected `gh`: all success → 0; one failure → 1 and the failed log lines; pending past timeout → 3.
7. `status --check --json` on a fixture: missing hooks → exit 1 naming them, never printing a token value;
   `setup --no-install` with `DEV_MEMORY_PACK_TOKEN` set makes no morning-pack call (no network in tests).

## 5. Validation on a representative task
The lane itself is the representative task (a governance-path lane through the full pipeline). Its evidence
`docs/validation/<VTID>/parity-report.md` records, for this session: baseline (before the kit) vs with the kit — time
to a ready session, preventable local failures caught before CI, CI fix-forward cycles, owner interventions, and the
pipeline wall clock (plan PR → convergence → VTID → lane PR → accept → merge) from GitHub timestamps. No direct
Claude Code run is available, so Claude Code parity is reported as unverified.

## 6. Remaining limits (not fixable in this repo; documented, not worked around)
- No MCP server registration from the session (platform permission); RepoWise/Graphify by CLI.
- `PostToolUse` output never reaches the agent, so the typecheck runs at the next `git commit` instead of after each
  edit; `SessionStart` was not observed to fire, so readiness relies on the account learning / workspace steering
  telling the session to run `setup`.
- The sandbox and `~/.cache` do not survive a new sandbox: `setup` re-installs (measured ~2.5 min to ready, in the
  background).
- GraphQL and repo variables are refused by the GitHub proxy (`CLAUDE_AVAILABLE` unreadable → no override, per §7).
- Kiro Web runs no workflow engine: lanes of one plan run in this session's sub-agents only for read-only work;
  writing steps stay sequential per `driver.md`.

## 7. Unchanged
Every rule file (`CLAUDE.md`, `.claude/**`, `.kiro/steering/**`, `.kiro/pipeline/**`, `.kiro/hooks/**`), every stop case
(Gate 2, escalated sparring verdict, migration-file approval §7d, §7 stop cases), protected gate files, preflight and
`session-setup.sh` (reused, not edited), the IDE workflow. Deploys nothing (no staging deploy watches these paths), so
no STAGING-VERIFY and no Gate 2: done when merged green.

## 8. Risks
- A guard bug could block legitimate pushes → internal errors exit 0; only a real preflight/tsc failure blocks; the
  agent can still see why (stderr) and fix it.
- The guard adds ~12 s (preflight) per new head and ~7-60 s (tsc) per commit after a gateway edit; cached per head.
- Overlap with `kiro-web-steering`: distinct files and markers; its generator removes only files carrying its marker.
<!-- plan:end -->
