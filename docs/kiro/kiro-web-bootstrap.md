# Kiro Web: loading the Vitana rules in every sandbox (plans `kiro-web-steering`, `owner-autonomy`)

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
| AGENTS.md is loaded from the workspace root and from subdirectories, on every surface | documented and **observed** (2026-10-27: both repos' `AGENTS.md` were injected as workspace rules) | [Steering](https://kiro.dev/docs/steering) |
| Kiro Web runs no hooks | documented. **Observed otherwise** for command hooks in `<workspace>/.kiro/hooks/` (VTID-05340, `kiro-web-session.mjs`): a PreToolUse exit 2 blocks the tool. The repos' own `.kiro/hooks/` and SessionStart were not seen to fire. | [Hooks](https://kiro.dev/docs/hooks), [Hook types](https://kiro.dev/docs/hooks/types) |
| `~/.kiro/steering` is not read on Kiro Web; user-level steering reaches cloud sessions through Configuration Sync | documented | [Cloud configuration](https://kiro.dev/docs/web/cloud-configuration), [Steering](https://kiro.dev/docs/steering) |
| Kiro Web's default mode is collaborative. **Autonomous** is a toggle you can switch on before the first message or later in the session, and it moves a task to *Needs attention* when it needs input. "Vibe" is not a documented mode name. | documented | [Using the agent](https://kiro.dev/docs/web/using-the-agent), [Autonomous mode](https://kiro.dev/docs/web/autonomous-mode) |
| A repo-level setup script that Kiro Web runs automatically | not documented | — |
| Account learnings are injected into every new session of the account, in any sandbox | **observed** (the learning saved on 2026-10-26 was present at the start of the 2026-10-27 session) | — |

The Vitana pipeline does not need Autonomous mode. Once loaded, the rules forbid routine approval questions in either
mode. Autonomous mode only changes how the session reports progress.

## The setup
`scripts/collab/kiro-web-steering.mjs` mirrors every `.kiro/steering/*.md` of both repos into
`<workspace>/.kiro/steering/<repo>--<name>.md`. It prefixes each `#[[file:]]` link and `fileMatchPattern` glob with
the repo folder, so the links resolve from the workspace root. A vitana-v1 file identical to the platform file and
without links is written once. It also adds `vitana-platform--kiro-web-driver.md` (always included), which inlines
`.kiro/pipeline/driver.md`, `common-rules.md`, `planning.md` and `quality-checks.md` (the per-change-type quality checks, linked last so a truncation cuts it rather than the runbook), so the Kiro Web runbook is in context rather than only
named. It writes nothing inside a repo and only replaces or removes files carrying its marker. `--check` writes
nothing. It exits 1 when a generated file is missing or out of date, a link does not resolve, or a linked file has
nested links. Every run prints the byte total of the always-included set with links inlined (about 123 KB today). A
known Vitana checkout without `.kiro/steering/` is skipped with a note.

How it starts in a new sandbox (the generated files live outside the repos, so each sandbox builds them):
1. **One-time owner step (persists across sandboxes):** in Kiro, *Agent Config → Cloud Config*, upload
   [`cloud-config/vitana-kiro-web-bootstrap.md`](cloud-config/vitana-kiro-web-bootstrap.md) as a user-level steering
   file. Re-upload it when it changes (it changed with plan `owner-autonomy`). Every later Kiro Web session of that
   account then runs the setup first and carries the standing instruction. Kiro cannot do this upload itself.
2. **In-repo trigger:** `AGENTS.md` (documented to load from subdirectories) says the same thing.
3. **Fallback, if neither is loaded:** make this the first line of the task:
   `Run node vitana-platform/scripts/collab/kiro-web-steering.mjs, then follow the loaded Vitana rules.`

## Autonomy: one rule for every task (plan `owner-autonomy`)
The owner's standing instruction (2026-10-27) is `.kiro/steering/vitana-owner-autonomy.md`. It is always included and
byte-identical in both repos, so the generator above puts it in every Kiro Web session. Kiro IDE loads it directly.
It says: carry every task through to its authorized outcome; STAGING-VERIFY is the default end point for development
work; other work runs to its finished, evidenced answer; never end a reply with an offer of a routine next step. It
holds **the one complete stop table**, where each row cites the existing rule and says whether it can stop work before
STAGING-VERIFY. `scripts/ci/kiro-steering/guard.cjs` (both repos) fails CI when the file is missing, is not always
included, or drops any stop row's anchor.

What was found (audit 2026-10-27) and how it is handled:
| Finding | Handling |
|---|---|
| The only stop list a Kiro session loaded (`vitana-pipeline.md`) left out migration approval (§7d) and protected gate files (§3a) | Both are in the table, and `vitana-pipeline.md` names them and points to it |
| No "do not ask" rule for work without a commit (investigation, questions, reviews, ops checks) | The rule file covers every kind of work |
| Broad sentences: v1 CLAUDE.md "When in any doubt, stop and ask first"; NEVER 34 "Never enable autonomy without explicit approval"; DEPLOYMENT-PIPELINE.md "PR reviewed + approved" | Each is quoted and kept in force for its own topic (live writes; product autonomy; reviewer-agent accept). Nothing is loosened |
| Stops that sit in path-scoped files: Commerce friction (v1 CLAUDE.md), design-contract change (v1 `design.md`) | Rows in the table |
| vitana-v1 `collaboration.md` still said "no other model is substituted" (a session waits on an unavailable reviewer model) | Synced to the platform file (the three-model chain) |
| vitana-v1 CLAUDE.md lacks the "Policy approval replaces Gate 1" paragraph | Unchanged (protected gate file). The table's Gate 1 row says CI-sparred plans never go to the owner, which matches platform CLAUDE.md and both `collaboration.md` files |

What persists in a new sandbox:
- the rule file and the stop table (both repos, loaded through the generator);
- the account learning with the same instruction (injected without any setup);
- the Configuration Sync file, once uploaded (see below).

## Checking a session loaded the rules
- `node vitana-platform/scripts/collab/kiro-web-steering.mjs --check` ends with `kiro-web-steering: ok`.
- The session's first reply states its session id (`kiro-<seat>-…`) and lane, as `vitana-load-project-rules.md`
  requires. A session that does not do this has not loaded the rules.
- If Kiro reports a truncated steering reference, read that file in full before relying on it.
- If Kiro Web starts loading the repos' own steering as documented, the rules load twice under different paths. The
  generated copies are equivalent, so behaviour does not change.

## Unchanged
Every owner stop. The complete list, with the rule behind each one, is the table in
`.kiro/steering/vitana-owner-autonomy.md`.
