# Common rules (binding for every pipeline step)

1. **Repos.** `<vitana-platform>` = the checkout of `exafyltd/vitana-platform` (find it among the workspace folders by
   `git -C <folder> remote get-url origin`); `<vitana-v1>` = the checkout of `exafyltd/vitana-v1`. Touch no other
   repository. Never switch the branch of the main checkouts; every lane works in its own worktree.
2. **Project rules.** `.claude/rules/collaboration.md` (spec layout §2, session identity and trailers §3, session start
   §4, claims §5, roles §7/§7a, merges §7b, driver §8, parallel execution §8a, measurement §8b), `CLAUDE.md` Part 1
   and `.kiro/steering/*.md`. Read only the sections a step needs. Where these runbooks and those files differ, the
   repo rule file wins and the difference is logged in `decisions.md`.
3. **RUN folder** (shared state, never committed): `<vitana-platform>/.agents/tasks/pipeline-<run id>/`, run id = the
   Kiro IDE workflow id (`wf_…`, every workflow step is told it) or the Kiro Web driver session id. Files:
   `run.json` (task, slug, plan PR, plan VTID, seats/session ids), `spar-state.json`, `slots.json`,
   `lanes/<lane-id>/state.json`, `reviews/`, `timings/`, `merge.lock`, `merges.md`, `blockers.md`, `decisions.md`.
   Create it with `New-Item -ItemType Directory -Force`. Never stage it (`.agents/` is local state): stage specific
   files only. Append each blocker hit or worked around to `blockers.md` and each judgement call to `decisions.md`
   (one timestamped line, append-only). Timing events: one JSON line
   `{"event":"…","lane":"<id>|null","at":"<ISO-8601 UTC>","ref":"<sha|url>"}` in `timings/<step id>.jsonl`
   (only that step writes it); prefer GitHub timestamps over the local clock.
4. **Merge authority = the §7b PM merge rule.** The Project Manager merges; while it is not `live`, the land step
   applies the same rule: review entry `Collab-Verdict: accept` from `agent:vitana-lane-reviewer (<chain model>)` on
   the PR's current head, every required check green on that head incl. Lane scope and Collab handoff, PR up to date
   with latest `main` and re-checked on that head, no conflict, every `depends_on` lane done, target `main` with a
   staging-only deploy path. A change to a protected gate file (`scripts/collab/protected-gate-files.json`) never
   merges on the agent's accept alone: it needs the owner's instruction naming the plan plus a reviewer-agent accept
   on the current head (Claude Code is retired); log each such file in `decisions.md`. `gh pr merge --admin` only when the one red check is a
   governance-artifact false positive for this change (Lane scope failing solely on the executor / governance-path /
   reviewer rule, or because the spec is not on `main` yet), with the run log linked in `merges.md`. A real red test,
   build, typecheck or STAGING-VERIFY is never overridden. Record every merge (lane log + `merges.md`: authority,
   reason, merge SHA).
5. **Autonomy.** The owner is asked exactly one question per plan: Gate 2. The only other stops are an escalated
   sparring verdict and the §7 stop cases (security or data-loss risk, the same failure surviving 3 fix attempts →
   park with the five-part stop message, anything that would reach production). Git, push, PR, merge, re-runs,
   sparring rounds and VTIDs never need the owner. Blocked → work around inside these rules, log, continue. In a
   workflow step, never `send_message` severity `warning` or `error` for a normal outcome; signal `success` when the
   step's work is done, whatever the verdict. If the only way to satisfy a review finding changes behaviour beyond the
   converged plan, do not make it: log finding, needed change, user-visible effect and a behaviour-preserving
   alternative in `blockers.md` as deferred, and continue.
6. **Never:** allocate a VTID by hand (only CI PLAN-SPAR allocates); deploy to production; run or dispatch PUBLISH,
   `scripts/deploy/publish-to-prod.sh` or any `AWS-PROD-DEPLOY-*` — the only exception is a publish the owner
   explicitly commands in an interactive conversation (`collaboration.md` §7c: full, or one session's changes only;
   never in a workflow step or automation run, never `publish-to-prod.sh`); write to Supabase or any live system from session
   tools (a DB change is a migration file in the lane PR); test against production; skip, disable or loosen a test;
   accept your own lane. Staging tests are read-only.
7. **Gateway calls** (`gateway.vitanaland.com`, `preview-aws-gateway.vitanaland.com`): always
   `Authorization: Bearer $env:GATEWAY_SERVICE_TOKEN`; check presence only (`[bool]$env:GATEWAY_SERVICE_TOKEN`); never
   print, log or commit it; unset → no gateway call, use CI / `gh` evidence; never search `.env` files or secret
   stores for a substitute.
8. **Git.** No force-push, no rebase of pushed branches (update by merging `origin/main` or `gh pr update-branch`), no
   `git config` changes, no `--no-verify`, stage specific files only, always `git -C <absolute path>`. Identity only via
   env vars in the step's script: `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME` = `kiro-agent[bot]`, `GIT_AUTHOR_EMAIL` /
   `GIT_COMMITTER_EMAIL` = `245459735+kiro-agent[bot]@users.noreply.github.com`. **No `Co-Authored-By: Claude …`
   trailer** on any commit (the Claude model inside Kiro is not a Claude Code action; "zero Claude actions" is proven
   from git). Trailers per collaboration.md §3: `Collab-Session` + `Collab-Lane: <slug>/<lane-id>` (`<slug>/_plan` for
   plan commits); review entries use the §4.1 trailers of `lane-review.md`. Push protocol: assert the SHA matches
   `^[0-9a-f]{40}$` and `git cat-file -t <sha>` = `commit`; `git push origin <sha>:refs/heads/<branch>`; verify with
   `git ls-remote origin refs/heads/<branch>`. Parallel lanes share one object store: on a ref-lock or push race fetch
   and retry up to 3 times.
9. **PowerShell 5.1** (Kiro IDE on Windows): no `??`, no `&&`. Put multi-command git/gh sequences in a `.ps1` in RUN
   named after the step id, run it with `powershell -NoProfile -ExecutionPolicy Bypass -File <script>`, write results
   to a file and read it back. `gh … --json` output to a file, then `ConvertFrom-Json`. `Get-Content` without
   `-Encoding utf8` mangles UTF-8; use `[IO.File]::ReadAllText`. On Linux (Kiro Web) the same commands run in bash.
10. **Polling:** every 2-3 min inside bounded scripts; act as soon as the awaited event lands; no long sleeps. Arm a
    driver heartbeat while a plan is being driven (collaboration.md §8; `node scripts/collab/plan-driver.mjs heartbeat
    --slug <slug> --session <id>` once that script is on `main`).
11. **Parallel execution (collaboration.md §8a).** Lanes run in parallel by default; at most 6 build lanes per plan;
    at most 2 PLAN-SPAR sessions in flight repo-wide; one merge at a time (`merge.lock`), each lane brought up to date
    with latest `main` and green on that head first; hot files (migrations in timestamp order, `DATABASE_SCHEMA.md`,
    `src/App.tsx`, `screens.json` / `exclusions.json`, the parity ledger, i18n shards of one namespace, `CLAUDE.md`)
    are sequenced, never parallel; one staging deploy at a time; a small task (1 lane, at most 3 files) is one lane,
    no fan-out; interfaces between lanes are defined in the plan, not by the agents.
12. **Measurement (collaboration.md §8b).** Every plan writes `docs/validation/<plan VTID>/timings.json` (schema
    `vitana.plan-timings/v1`: convergence, VTID, per-lane build / review / merge, staging verify, approved → verified,
    merge-conflict count, STAGING-VERIFY failure count; `null` where a source is missing, never 0) and Gate 2 quotes it.
13. **Step order (enforced, plan `step-order-gate`).** Independent steps may run in parallel. A dependent step never
    runs in parallel with the step it depends on: it waits for that step's result and exit code. Four orders are checked
    by `node <vitana-platform>/scripts/collab/land-guard.mjs`: (a) `evidence --repo <dir> --vtid <VTID>` before a lane
    code commit (acceptance.md, commands.log, scope.json staged or committed); (b) a review counts only for the PR's
    current head or a head whose later commits only append lane-file entries or are `pm-agent` lane-state commits
    (`review`); (c) every check's latest attempt is finished and green, and the PR is up to date, before a merge
    (`checks`); (d) claims and the driver heartbeat are released only after the closing records are on `origin/main`
    (`release`, `release-heartbeat`). A lane merge goes through `land-guard.mjs merge` (it runs (b), (c), the
    up-to-date and protected-gate-file checks, and only then merges). A release goes through `land-guard.mjs release`,
    never a raw `queue.mjs release`. Two merges stay outside `merge`, after `land-guard.mjs checks` shows the only red is
    the logged false positive (run URL in `merges.md`): a spec-only `plan(` PR, and the `--admin` governance-artifact
    case of rule 4. Breaking another session's stale claim stays `queue.mjs release --stale` (§5, §8).
