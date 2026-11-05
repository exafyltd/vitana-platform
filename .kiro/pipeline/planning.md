# Planning: owner task → merged, policy-approved plan with VTIDs

Binding: `common-rules.md`. RUN = `<vitana-platform>/.agents/tasks/pipeline-<run id>/`.

## 1. Setup (one step, idempotent)
1. Create RUN and its folders (`lanes/`, `reviews/`, `timings/`). Write the owner task verbatim to `RUN/task.md`
   (never paraphrase it; every later step verifies against it).
2. Session ids: `node <vitana-platform>/scripts/collab/queue.mjs session-id --agent kiro --seat <seat>` once per seat
   the run uses (default seat: the account running the session, from `docs/programs/areas.yaml`); keep them in
   `RUN/run.json` `seats`. Never reuse a Claude Code `session_…` id.
3. `git -C <repo> fetch --prune origin` for both repos; run the queue
   (`node <vitana-platform>/scripts/collab/queue.mjs --repo <vitana-platform> --repo <vitana-v1>`) and save it to RUN.
   If an open plan already covers the task (same intent, not `done`), resume that plan instead of writing a new one:
   record its slug in `run.json` and continue at the first step it has not finished.
4. Read `CLAUDE_AVAILABLE` (`gh variable get CLAUDE_AVAILABLE --repo exafyltd/vitana-platform`; only the literal
   `false` = unavailable) and the 4 h rule of collaboration.md §7; record the mode in `run.json`. The pipeline is the
   same either way; Claude-only jobs go to the exceptions seat when Claude is unavailable.
5. Slug: lowercase-dashes, short, unique under `.kiro/specs/` on `origin/main` and among open `plan(` PRs.

## 2. Investigate (parallel, read-only)
One investigator per concern (area, repo, risky subsystem), at most 6, each writing `RUN/investigate/<topic>.md`
with `file:line` evidence from `origin/main`: what exists, what must change, exact paths, tests that cover it, how a
new test fails on base, hot files, risks. Query RepoWise / Graphify where available (CLAUDE.md "Mandatory Codebase
Intelligence Workflow"); if an index is missing or stale, say so and use targeted reads. A small task (1 lane, at
most 3 files) gets one investigator.

## 3. Spec (`.kiro/specs/<slug>/`, collaboration.md §2)
- `plan.md`: front matter `change_class:` (`standard` unless a smaller class clearly applies), the plan between
  `<!-- plan:begin -->` and `<!-- plan:end -->`: goal (quote the owner), today with `file:line`, interfaces between
  lanes, lanes (ids, files, tests that fail on base), parallel / shared files / hot files, tests and commands,
  measurement, risks, unchanged.
- `tasks.md`: one group per lane marked `<!-- lane: <lane-id> -->` with checkboxes and **Acceptance** bullets (what
  the reviewer agent checks), written with the Acceptance template of `quality-checks.md`: the first bullet is
  `Change types: <list>` (UI, Backend, Database, Integration, Infrastructure/CI, Tooling/docs), then the template
  fields and the items of those change-type sections.
- `handoff.md`: `state: drafted`, `author: kiro`, `author_seat`, `executor: kiro`, `next_actor: kiro`.
- `lanes/<lane-id>.md`: `state: ready`, `next_actor: kiro`, `executor`, `seat`, `reviewer: agent:vitana-lane-reviewer
  (claude-sonnet-5.5)`, `paths`, `depends_on` (real file/API dependencies only), `repos`; a log entry "created".
  `reviewer_seat: agent:vitana-lane-reviewer` is required on every `executor: kiro` lane whose `paths` include a
  governance path (`.github/**`, `.kiro/steering/**`, `scripts/collab/**` …, `queue.mjs` `GOVERNANCE_PATHS`); set it
  on every kiro lane, it costs nothing elsewhere. No two lanes edit the same file; a lane on a governance path
  follows the rule collaboration.md §3a states on `main` today.
- Add the slug to the right `docs/programs/<id>/program.md` (or `standalone`) when `queue.mjs validate` requires it.
- Commit, then run preflight before pushing: `node <vitana-platform>/scripts/collab/preflight.mjs --repo <spec WT>
  --base origin/main --head HEAD --branch kiro/<slug>/plan --title "plan(<slug>): <summary>"` (it runs `queue.mjs
  validate`, Lane scope, the PR-GATE checks, Kiro steering and the Collab tests in one pass and prints every
  failure); fix every error and re-run until it passes.

## 4. Plan PR
Branch `kiro/<slug>/plan`, commit with `Collab-Session` + `Collab-Lane: <slug>/_plan`, run preflight (§3) on that
commit and fix every error, then push (protocol), PR title
`plan(<slug>): <summary>`, body: summary, lanes, owner quote, session id. Save `{number,url,head}` in `RUN/run.json`.

## 5. Spar loop (one iteration per step run)
PLAN-SPAR (`.github/workflows/PLAN-SPAR.yml`) spars the PR through the gateway; Kiro holds no credential and never
calls the sparring partner itself.
1. Wait (poll 2-3 min, bounded) for the newest PLAN-SPAR run on the PR head; read `sparring/state.json` and the
   newest `round-<n>.md` from the PR branch.
2. New round without `responses-<n>.md` → answer every finding (accepted → change `plan.md` / `tasks.md` / lane
   files; rejected → reason with `file:line`; deferred → where tracked) in `sparring/responses-<n>.md`, commit, run
   preflight (§3) and fix every error, then push. Never edit `round-*.md`, `state.json` or `verdict.md`.
3. Converged → policy approval `converged-auto-v1`; CI writes the lane VTIDs into the lane files and `handoff.md`
   (`state: approved`). Lanes still without a VTID → wait for the next PLAN-SPAR run (it retries allocation); never
   allocate by hand.
4. Escalated (not converged after the re-plan session) → the one allowed owner stop: one message with the findings
   still disputed and a recommended answer.
5. A PLAN-SPAR run that failed for infrastructure (runner lost, partner `model_unavailable` on every tier) → `gh run
   rerun <id> --failed` once per head; otherwise follow the run's own error.
Write `RUN/spar-state.json` `{"done":bool,"verdict","session","vtids","round"}`; `done: true` when converged with
VTIDs on every lane, or escalated.

## 6. Merge the plan PR
A converged, policy-approved, spec-only `plan(` PR (every file under `.kiro/specs/<slug>/` plus the program entry)
merges under the §7b rule as soon as its checks are green: the PM merges it when it acts first; otherwise the step
merges it with the method recent merged PRs use (squash). Record the merge in `merges.md`. Then initialise
`RUN/lanes/<lane-id>/state.json` for every lane from `origin/main` (`status: pending`, `done: false`, `vtid`, `seat`,
`paths`, `depends_on`, `repos`, `branch: kiro/<slug>/<lane-id>`) and `RUN/slots.json` (lanes in dependency order:
slots 1-6 get the first six, the rest wait in `queue`; empty slots are `null`).
