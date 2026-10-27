# Kiro Web: loading the Vitana rules in every sandbox (plan `kiro-web-steering`)

The rules are unchanged. This page covers how they reach a Kiro Web session.

## Problem
A Kiro Web session clones both repos under one workspace root (observed: `/projects/sandbox/vitana-platform`,
`/projects/sandbox/vitana-v1`). In the session that found this (2026-10-26, `kiro-exafyltd-202610261510-099d`), none
of the repos' `.kiro/steering/*.md` was loaded. The session fell back to the default collaborative behaviour and asked
the owner for approvals the rules forbid asking.

## What is documented, observed and assumed
| Behaviour | Status | Source |
|---|---|---|
| Workspace steering lives in `<project root>/.kiro/steering/`; `#[[file:…]]` resolves relative to the workspace root | documented | [Steering](https://kiro.dev/docs/steering) |
| Kiro Web looks for `.kiro/steering/` at the root of each cloned repository | documented, **not observed**: the repos' steering was not loaded in the session above | [Steering, Web tab](https://kiro.dev/docs/steering), [Configuration](https://kiro.dev/docs/configuration) |
| A file in `<workspace root>/.kiro/steering/` is loaded from the next turn, with each `#[[file:]]` inlined in full | **observed** in the session above | — |
| Kiro cuts a long inlined link and says so ("Truncated steering reference … read the file"). In the session above that was the last always-included link, `vitana-platform/.claude/CLAUDE.md` (a generated RepoWise index); the rule files came through whole. The cap's size is not documented. | **observed** | — |
| `.kiro/` folders nested below the workspace root are discovered | not documented | — |
| A linked file's own `#[[file:]]` links are resolved (recursive) | not documented; `--check` reports any, and none of the linked files has one today | — |
| AGENTS.md is loaded from the workspace root and from subdirectories, on every surface | documented, not yet observed on Kiro Web | [Steering](https://kiro.dev/docs/steering) |
| Kiro Web runs no hooks (`.kiro/hooks/*.json`, incl. SessionStart, never fire there) | documented | [Hooks](https://kiro.dev/docs/hooks), [Hook types](https://kiro.dev/docs/hooks/types) |
| `~/.kiro/steering` is not read on Kiro Web; user-level steering reaches cloud sessions through Configuration Sync | documented | [Cloud configuration](https://kiro.dev/docs/web/cloud-configuration), [Steering](https://kiro.dev/docs/steering) |
| Kiro Web's default mode is collaborative. **Autonomous** is a toggle you can switch on before the first message or later in the session, and it moves a task to *Needs attention* when it needs input. "Vibe" is not a documented mode name. | documented | [Using the agent](https://kiro.dev/docs/web/using-the-agent), [Autonomous mode](https://kiro.dev/docs/web/autonomous-mode) |
| A repo-level setup script that Kiro Web runs automatically | not documented | — |

The Vitana pipeline does not need Autonomous mode. Once loaded, the rules forbid routine approval questions in either
mode. Autonomous mode only changes how the session reports progress.

## The setup
`scripts/collab/kiro-web-steering.mjs` mirrors every `.kiro/steering/*.md` of both repos into
`<workspace>/.kiro/steering/<repo>--<name>.md`. It prefixes each `#[[file:]]` link and `fileMatchPattern` glob with
the repo folder, so the links resolve from the workspace root. A vitana-v1 file identical to the platform file and
without links is written once. It also adds `vitana-platform--kiro-web-driver.md` (always included), which inlines
`.kiro/pipeline/driver.md`, `common-rules.md` and `planning.md`, so the Kiro Web runbook is in context rather than only
named. It writes nothing inside a repo and only replaces or removes files carrying its marker. `--check` writes
nothing. It exits 1 when a generated file is missing or out of date, a link does not resolve, or a linked file has
nested links. Every run prints the byte total of the always-included set with links inlined (about 123 KB today). A
known Vitana checkout without `.kiro/steering/` is skipped with a note.

How it starts in a new sandbox (the generated files live outside the repos, so each sandbox builds them):
1. **One-time owner step (persists across sandboxes):** in Kiro, *Agent Config → Cloud Config*, upload
   [`cloud-config/vitana-kiro-web-bootstrap.md`](cloud-config/vitana-kiro-web-bootstrap.md) as a user-level steering
   file. Every later Kiro Web session of that account runs the generator first. Kiro cannot do this upload itself.
2. **In-repo trigger:** `AGENTS.md` (documented to load from subdirectories) says the same thing.
3. **Fallback, if neither is loaded:** make this the first line of the task:
   `Run node vitana-platform/scripts/collab/kiro-web-steering.mjs, then follow the loaded Vitana rules.`

## Checking a session loaded the rules
- `node vitana-platform/scripts/collab/kiro-web-steering.mjs --check` ends with `kiro-web-steering: ok`.
- The session's first reply states its session id (`kiro-<seat>-…`) and lane, as `vitana-load-project-rules.md`
  requires. A session that does not do this has not loaded the rules.
- If Kiro reports a truncated steering reference, read that file in full before relying on it.
- If Kiro Web starts loading the repos' own steering as documented, the rules load twice under different paths. The
  generated copies are equivalent, so behaviour does not change.

## Unchanged
Every rule file and every owner stop: Gate 2, an escalated sparring verdict, the owner's approval of a migration file
(`.claude/rules/collaboration.md` §7d), and the §7 stop cases (security or data-loss risk, the same failure after 3
fix-forward attempts, anything touching production).
