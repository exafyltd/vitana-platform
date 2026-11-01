---
paths:
  - .kiro/specs/**
---

# Kiro ↔ Claude Code collaboration protocol (VTID-05145; Claude optional, VTID-05278)

Owner decision 2026-10-13: Claude Code and Kiro IDE work as one team across hundreds of sessions, dozens of them in
parallel, **without the owner relaying anything between them**. Either agent writes plans; the other executes; the
other verifies. **Claude Code is optional (§7):** when it is unavailable Kiro runs every step, from the `plan(` PR to
Gate 2 (owner decision 2026-10-20, plan `kiro-autonomy-fallback`). This file is identical in `exafyltd/vitana-platform`
and `exafyltd/vitana-v1`; the Kiro twin is `.kiro/steering/vitana-collaboration.md`. Sparring records:
`docs/validation/VTID-05145/plan-sparring.md`, `docs/validation/VTID-05278/plan-sparring.md`.
Each mechanism named here (PM merge, fallback routing, reviewer agent, driver, caps, timings) takes effect when the lane
that builds it is on `main`; until then the previous mechanism stays in force, so nothing is looser in between.

## 1. Git is the only channel
A plan, a status change, a review or a result that is not pushed to `origin` does not exist. No chat relay, no
local-only notes, no copy-paste. A session that cannot push says so in its lane log and parks the item.

## 2. Where a plan lives
`.kiro/specs/<slug>/` in the repo where most code changes (plans that span both repos: `vitana-platform`):

| File | Written by | Content |
|---|---|---|
| `requirements.md`, `design.md`, `tasks.md` | the author | Kiro's spec format. Each task group in `tasks.md` carries `<!-- lane: <lane-id> -->`. |
| `plan.md` | the planner | the plan between `<!-- plan:begin -->` / `<!-- plan:end -->` (what PLAN-SPAR spars) |
| `sparring/` | PLAN-SPAR (`round-<n>.md`, `state.json`, `verdict.md`); the planner (`responses-<n>.md`) | the CI sparring record |
| `handoff.md` | only the holder of the `_plan` claim (coordinator — the plan driver, §8), or PLAN-SPAR | plan-level front matter + append-only log |
| `lanes/<lane-id>.md` | only the session holding that lane's claim (a reviewer may append a log entry) | lane front matter + append-only log |

`handoff.md` front matter:
```yaml
---
slug: <slug>                 # = folder name
author: claude | kiro
executor: claude | kiro
next_actor: claude | kiro | owner
state: drafted | sparred | approved | executing | in-review | verified | done | parked
parked_from: <state>         # only when parked
vtids: [VTID-xxxxx, ...]     # required from approved on
sparring_record: <path>      # required from sparred on
updated: 2026-10-13T10:00Z   # ISO; newest wins across branches
---
```
`lanes/<lane-id>.md` front matter:
```yaml
---
lane: <lane-id>              # = file name, lowercase-dashes
state: ready | executing | in-review | verified | done | parked
parked_from: <state>         # only when parked
next_actor: claude | kiro | owner
vtid: VTID-xxxxx             # required from executing on
depends_on: [<lane-id>, ...] # lanes that must be done first (real file/API dependencies only)
executor: kiro | claude      # who builds it (VTID-05213)
seat: <seat>                 # the Kiro account that builds it (docs/programs/areas.yaml)
reviewer_seat: <seat>|claude|agent:vitana-lane-reviewer  # legacy, optional; never the lane's own seat
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5) # informational; acceptance comes from the reviewer agent (§7)
repos: [exafyltd/vitana-platform, ...]                   # informational
paths:                       # the only files the lane may change (Lane scope); required from executing on
  - src/pages/messages/**
claimed_by: <session id>     # the session working it
branch: <branch>
pr: <url>
updated: 2026-10-13T10:00Z
---
```
Shared files between lanes are declared in `plan.md`, not in a front-matter key (§8a).

Log entries: `### <ISO time> · <session id> · <state change>` then what was done, PR/commit links, what the next
actor must do, open questions.

Plan transitions: `drafted→sparred→approved→executing→in-review→verified→done`, `in-review→executing`,
`sparred→drafted`. Lane transitions: `ready→executing→in-review→verified→done`, `in-review→executing`. Any
non-terminal state → `parked` (set `parked_from`), and `parked` returns only to `parked_from`. `done` is terminal.
A new plan starts at `drafted`, a new lane at `ready`.

## 3. Session identity — never mix sessions up
- Every session has one id and states it in its first reply (or its first lane-log entry when nobody is watching),
  together with the lane it holds (or "no lane"):
  - Claude Code cloud session: its `session_…` id.
  - Kiro: `node <vitana-platform>/scripts/collab/queue.mjs session-id --agent kiro --seat <seat>` →
    `kiro-<seat>-YYYYMMDDHHMM-xxxx`, generated once at session start.
  - Reviewer agent: `agent-vitana-lane-reviewer-YYYYMMDDHHMM-xxxx` (`queue.mjs session-id --agent
    agent:vitana-lane-reviewer`); on a lane with a legacy seat `reviewer_seat`, `kiro-<reviewer_seat>-…`.
- Every commit of lane work carries the trailers
  `Collab-Session: <id>` and `Collab-Lane: <slug>/<lane-id>` (`<slug>/_plan` for coordinator commits).
  Identity of a Kiro commit: `kiro-agent[bot]` only, no `Co-Authored-By: Claude` trailer.
- **Review entry** (the reviewer agent's verdict, committed by the calling session): one commit that appends one
  entry to `.kiro/specs/<slug>/lanes/<lane-id>.md`, front matter unchanged, trailers:
  ```
  Collab-Session: <reviewer session>
  Collab-Review: <slug>/<lane-id>
  Collab-Verdict: accept | changes
  Collab-Reviewer: agent:vitana-lane-reviewer (<model>)
  Collab-Reviewed-Head: <40-hex PR head the agent reviewed>
  ```
  `<model>` is the chain model the agent ran on: `claude-sonnet-5.5`, `claude-opus-5.5` or `claude-sonnet-4.5`
  (`REVIEWER_AGENT_MODELS`, PM `governance.ts`). `Collab-Review` stays the lane key (scope-check depends on it); the verdict is `Collab-Verdict`. Body:
  `### <ISO time> · <session> · review`, then `review: accept|changes`, `head: <sha>`,
  `reviewer: agent:vitana-lane-reviewer (<model>)`, PR link, findings summary, next actor. The reviewer
  session is never a session in the lane's executing log. An entry counts for the **current head** when
  `Collab-Reviewed-Head` equals the PR head, or every commit after it only appends review entries to this lane file
  (front matter unchanged) or is a `pm-agent` lane-state commit.
- Branch per lane: `<kiro|claude>/<slug>/<lane-id>` (a cloud session whose branch name is assigned by the harness
  keeps it; the trailers then carry the match). PR title: `VTID-xxxxx (<slug>/<lane-id>): …`; PR body names the
  session id. **Match a PR to its lane only by these keys — never by recency or "the last thing Kiro did".**
- One VTID per lane (or per lane group the plan declares).

## 3a. Seats, areas and Kiro Web automations (VTID-05145 A1)
Owner decisions 2026-10-14: Kiro accounts are the development capacity (separate credits); each Kiro Web account
specialises in one area. All Kiro accounts share one GitHub identity (`exafyltd`), so GitHub labels or `/kiro`
comments cannot address one account — each account **pulls** its own work instead.
- **Seat** = one Kiro account, 1-12 lowercase letters (`jtadic`, `exafyltd`, `hotmail`, `exafy`), listed with its
  account and area in `vitana-platform/docs/programs/areas.yaml`. A seat's session ids are
  `kiro-<seat>-YYYYMMDDHHMM-xxxx` (`queue.mjs session-id --agent kiro --seat <seat>`). The **exceptions seat** is
  `exafyltd` (§7).
- **Lane assignment:** whoever creates a Kiro lane (the `_plan` claim holder) sets `seat:` and `area:` in the lane file
  from the area map (most specific area wins; `frontend` is the catch-all). A lane without `seat:` can be taken by any
  Kiro session, as before.
- **Kiro Web automations:** each Kiro Web account has one scheduled automation whose task is only "Read
  `.kiro/automations/<seat>.md` in vitana-platform and follow it exactly." It is a fallback wake-up (§8): it starts or
  resumes the driver of an approved plan whose heartbeat is stale, else takes one item of its own seat, and stops at
  once when there is none. Change what an account does by editing its file, never in Kiro.
- `queue.mjs --seat <seat>` lists one seat's lanes; the queue table shows each lane's seat.
- **Lane fields (VTID-05213):** `executor: kiro|claude` (who builds it), `reviewer_seat` (legacy, optional) and
  `paths` (globs of the only files the lane may change; required once it is `executing`). The PR-GATE check
  **Lane scope** fails a lane PR that changes anything else.
- **Governance paths** (`.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`,
  `CLAUDE.md`, `docs/programs/areas.yaml`): a Kiro lane may change one when the reviewer agent accepts on the current
  head and every check is green — **except the protected gate files**, which never merge on a reviewer-agent accept
  alone: they need the owner's instruction naming the plan plus a reviewer-agent accept on the current head (Claude
  Code is retired). The list lives in
  `scripts/collab/protected-gate-files.json` (globs, `queue.mjs` glob semantics):
  `CLAUDE.md`, `scripts/collab/plan-spar.mjs`, `scripts/collab/queue.mjs`, `scripts/collab/protected-gate-files.json`,
  `services/gateway/src/services/plan-sparring/**`, `services/gateway/src/services/project-manager/governance.ts`,
  `.github/workflows/PLAN-SPAR.yml`, `.github/workflows/PR-GATE.yml`, `.github/workflows/AWS-PROD-*.yml`,
  `.kiro/agents/vitana-lane-reviewer.md`, `supabase/migrations/*vtid_ledger*.sql`, `supabase/migrations/*plan_sparring*.sql`.
  Until that rule is on `main` (scope-check), Lane scope still refuses a governance path from a lane that is not
  `executor: claude`.

## 4. Session start
1. `git fetch --prune origin` in both checkouts.
2. Run the queue:
   `node <vitana-platform>/scripts/collab/queue.mjs --repo <vitana-platform> --repo <vitana-v1>`
   (one row per lane: state, next actor, claim holder, blocked, VTID, branch/PR, last log line;
   `--mine <session id>` shows what you hold).
3. Unless the owner gave you a different task: resume the driver of an approved plan whose heartbeat is stale (§8),
   else pick a lane whose `next_actor` is you, not `blocked`, not claimed, oldest `updated` first. An owner task that
   results in a commit runs the whole pipeline (`.kiro/steering/vitana-pipeline.md`).

## 5. Claim before you touch anything
`node <vitana-platform>/scripts/collab/queue.mjs claim <slug>/<lane-id> --session <id> --repo <repo>`
pushes `refs/heads/collab-claim/<slug>/<lane-id>` without force. Git refuses it when another session holds the
lane → the script names the holder → **pick another lane, never work it in parallel**. Plan-level steps
(`approved→executing`, `executing→…→done`, Gate 2) need the `_plan` claim — except what PLAN-SPAR does inside a plan
PR (§7). VTIDs are allocated only by CI PLAN-SPAR, never in a `_plan` step.
- A session without a claim never edits `handoff.md` or a lane file.
- An owner instruction about a lane another session holds → tell the owner which session holds it and leave it.
- A claim older than 24 h with no new commit on the lane's branch may be broken:
  `release <slug>/<lane-id> --session <id> --stale`, and say so in the lane log.

## 6. Session end
Append your log entry, set `next_actor` / `state` (and `claimed_by`, `branch`, `pr`) in **your lane file** (the
coordinator: in `handoff.md`), commit with the trailers, push the branch / open or update the PR, then
`release <slug>/<lane-id> --session <id>` when you hand the lane to someone else.

## 7. Roles — Kiro runs the pipeline end to end; Claude Code is optional
Owner decisions 2026-10-14 (Project Manager plan v2, VTID-05218) and 2026-10-20 (`kiro-autonomy-fallback`, "no more
approvals, you run it end to end"). Kiro accounts carry the work because each has its own credits.

**The pipeline:** `plan(<slug>)` PR → CI PLAN-SPAR (partner chain unchanged: Bedrock Opus 4.6 → Sonnet 4.6 → DeepSeek)
→ policy approval (`converged-auto-v1`) → **CI allocates a fresh VTID per lane** (never Kiro by hand) → Kiro builds
the lanes in parallel (§8a) → the reviewer agent `vitana-lane-reviewer` (Kiro custom agent, model chain
`claude-sonnet-5.5` → `claude-opus-5.5` → `claude-sonnet-4.5`, read-only) returns `accept` or `changes` → `verified` → merge to `main` under §7b → staging auto-deploy →
STAGING-VERIFY → Gate 2 *"Staging verified — ready for deployment to production?"*. Production only by the owner's
PUBLISH. **No per-PR owner approvals**: no question about git, push, PR, merge, re-runs, sparring rounds or VTIDs.

- **Planning — either agent.** The owner gives an initiative to Claude Code or to a Kiro session; that agent is the
  planner. It pushes the spec as PR `plan(<slug>): …` with `plan.md` (the plan between `<!-- plan:begin -->` and
  `<!-- plan:end -->`), `handoff.md` (`state: drafted`, `author_seat` for Kiro) and its lanes (`ready`, each with
  `executor`, `seat`, `paths`, `depends_on`).
- **Sparring — CI.** `PLAN-SPAR.yml` spars every `plan(` PR through the gateway (Kiro holds no credential); the planner
  answers each round in `sparring/responses-<n>.md` and pushes. A converged plan is **approved by policy**
  (`converged-auto-v1`) — that replaces the owner's Gate 1 for it — and its lanes get their VTIDs from CI. Not
  converged after the re-plan session → `parked`, on the board, no message. Claude Code may still spar its own plans
  with its local partner; the owner then answers Gate 1 as before.
- **Building — the lane's seat** (Kiro). `executor: claude` lanes go to Claude Code when it is available, else to the
  exceptions seat.
- **Accepting — the reviewer agent** `agent:vitana-lane-reviewer (<model>)`, `<model>` from its chain. Per lane, independently and in
  parallel: the builder claims → implements → PR → `in-review` → the reviewer agent checks the diff against the lane's
  `tasks.md` acceptance, the lane `paths`, CI on the current head, red→green proof, no test weakening, no
  production/live writes → the calling session commits the review entry (§3). `changes` sends the lane back to
  `executing`. A chain model unavailable → another chain model reviews at once (owner 2026-10-21: never wait on an
  unavailable model; the Kiro IDE recipe races one review step pinned per chain model in a `joinPolicy: "any"`
  parallel, the Kiro Web driver tries them in order); a model outside the chain fails loudly (`model_unavailable`),
  each model reviews a head at most once, and when all three fail the review stops loudly (recipe: the slot fails
  with the engine's record; driver: a logged blocker, the lane is parked). A builder never accepts its own lane; `reviewer_seat` is legacy.
- **Merging and Gate 2 — the Project Manager** (`services/gateway/src/services/project-manager/`) by the PM merge
  rule (§7b); while the PM is not `live`, the plan driver (Kiro) applies the same rule. Gate 2 goes to the Command Hub
  Operator Chat with the evidence: STAGING-VERIFY link, test counts, verified commit, every commit between production
  and it, migrations, decisions taken and the plan's `timings.json` (§8b).
- **The owner is asked only:** Gate 2 (and Gate 1 for a plan Claude Code sparred locally), an escalated sparring
  verdict, and the stop cases — a security or data-loss risk, a failure surviving 3 fix-forward attempts, anything
  touching production. Each stop is one message: what happened, evidence, what was tried, the recommended answer, what
  waits on it (the five-part stop message). A migration needs the owner's approval of the file(s); Kiro then applies
  it itself (§7d).
- **Production after Gate 2:** the owner's PUBLISH in the Command Hub, or — on the owner's explicit command in the
  conversation — a publish run by the Kiro (or Claude Code) session itself, either the full staging build or only one
  session's changes (§7c). Without that command Kiro never deploys to production.
- **Claude Code — when available:** exceptions (`executor: claude` lanes, parked plans it can fix, partner outages) and
  the owner/Claude review of protected gate files (§3a).
- **Claude unavailable mode.** Claude Code is unavailable when (a) the GitHub repository variable `CLAUDE_AVAILABLE`
  on `exafyltd/vitana-platform` is the literal `false` (reason `flag_false`; `true`, unset or unreadable = no
  override), or (b) the 4 h rule: the oldest open item with `next_actor: claude` (lane or `handoff.md`, not `done`)
  has `updated` older than 4 h and no commit with a `Collab-Session: session_…` trailer newer than that item exists on
  `main` or an open PR head of either repo (reason `no_action_4h`; `true` does not override it). It is a level, not an
  edge: when Claude acts again the next evaluation flips back; reassigned work stays. The PM computes it each tick;
  drivers and automations use `gh variable get CLAUDE_AVAILABLE` plus the same 4 h rule over the queue. While
  unavailable, every job that goes to Claude today goes to the **exceptions seat `exafyltd`**: end-of-rotation
  reassigns, parks, stale claims, `executor: claude` items, re-plan of parked plans, STAGING-VERIFY fix-forward (max
  3, then park). Only protected gate files (§3a) still wait for owner/Claude review.
- Every existing rule is unchanged: sparring before a VTID, the `vtid_ledger` gate, never test against production,
  staging tests read-only, production only by PUBLISH.

## 7a. What the executor and the reviewer never do
Applies to Kiro (as builder, reviewer, planner or plan driver), and to Claude Code whenever it executes a lane. They
never:
- allocate a VTID by hand (CI PLAN-SPAR does), take a `_plan` claim of a plan they did not author (except taking over
  a driver whose heartbeat is stale, §8), or edit another lane's file;
- approve or accept their own lane — acceptance is the reviewer agent's, never the builder's;
- deploy to production (PUBLISH, `scripts/deploy/publish-to-prod.sh`, any `AWS-PROD-DEPLOY-*`) except the
  owner-commanded publish (§7c), or dispatch a workflow outside §7d (staging, verification and re-runs; owner-approved
  migrations);
- merge a PR except under §7b;
- write to a live system from session tools, even though their credentials allow it: no Supabase writes
  (`execute_sql` with INSERT/UPDATE/DELETE/DDL, `apply_migration`, `deploy_edge_function`, branch/project/secret
  tools) and no mutating AWS call (ECS, ELB, ECR, IAM or Secrets Manager writes). A merge under §7b is not a
  session-tool write; staging deploys only through its workflow.

Reading for diagnosis is fine. A database change is a migration file in the lane's PR. Blocked → fix forward; after 3
attempts park with the five-part stop message (§7); `next_actor: claude` only when Claude is available.

**Lane administration — the one reviewed exception to "edit another lane's file" (kiro-lane-admin).** An authorized
`executor: kiro` lane carrying `lane_admin: true` with `reviewer_seat: agent:vitana-lane-reviewer`, whose `paths`
cover the target lane file, may reassign that TARGET lane's `seat` and narrow its `paths` — a reviewed, auditable
reassignment that preserves seat ownership (the admin lane builds from its own seat, the target's new seat owns its
future PRs), scope (the admin lane's `paths` bound what it touches) and independent review (the reviewer agent
accepts; the builder never does). The admin lane is recognised only from a trusted source (merge-base, a qualifying
`plan(` PR, or the other repo's main), never self-granted in its own PR head, and it can never widen its own `paths`
or any of its own permission fields.

## 7b. PM merge rule
The Project Manager merges a lane PR — and **the plan driver (Kiro) applies the same rule while the PM is not
`live`** — when ALL of these hold:
- the lane is `verified` and the review entry (§3) is `Collab-Verdict: accept` from
  `agent:vitana-lane-reviewer (<model>)` (`<model>` in its chain) on the PR's current head;
- every required check is green, incl. **Lane scope** and **Collab handoff**;
- the PR is up to date with latest `main` and its checks were re-run on that head (serialized landing, §8a); no
  conflict;
- every `depends_on` lane is `done`;
- the PR targets `main` and its deploy path is **staging only** (`AWS-STAGE-DEPLOY-*` and preview workflows);
- no protected gate file (§3a) is changed without the owner's instruction naming the plan plus a reviewer-agent
  accept on the current head (Claude Code is retired; a reviewer-agent accept alone never unlocks it).

The merge is recorded in the lane log with `merge: <sha>` and `authority: §7b PM rule` (or the owner instruction it
relies on). Production is never part of a merge: it stays the owner's PUBLISH at Gate 2. `gh pr merge --admin` only
for a failing *governance-artifact* check that is a known false positive for the change (e.g. a lane-less governance
PR, Lane scope red solely on the old executor/governance/reviewer rule, or "lane file not found" because the spec is
not on `main` yet), linked in the log; a real red test or build is never overridden. An owner instruction naming a PR
or a set of PRs (the 2026-10-18 per-PR exception) is still valid authority for that named set.

## 7c. Owner-commanded publish (owner decision 2026-10-22)
The Command Hub PUBLISH stays the default way to production. In addition, **a Kiro session publishes to production
when the owner explicitly commands it in that conversation** ("publish", "publish this session's changes", "publish
session `<id>`", a "yes" to Gate 2 asked in that session). A question, "later", silence or an inference is not a
command. Never in an unattended run (seat automation, workflow step, automation-started driver), and never for a
reviewer agent. Two scopes:
- **Full publish** — the same promotion as the Command Hub button: the build staging serves, pinned to the commit that
  passed STAGING-VERIFY (gateway: `AWS-PROD-DEPLOY-GATEWAY.yml`, `deploy_mode=promote-staging`,
  `expected_commit=<verified sha>`; frontend: `AWS-PROD-DEPLOY-FRONTEND.yml`, `commit_sha=<verified sha>`; another
  service: its `AWS-PROD-DEPLOY-*` pinned the same way). The command covers the commit list between production and the
  verified commit, which Kiro shows before dispatching.
- **Session-scoped publish** — only the changes one session made (this session, or the session id the owner names):
  its PRs and merge commits, found by the `Collab-Session` trailer or the session id in the PR body, and only the
  services they touch. Done by CLAUDE.md IF–THEN 26: pin that session's last merge commit per service, never an
  unpinned default. A pinned commit ships every ancestor, so first diff it against the commit production build-info
  reports live; when the range holds a commit that is neither that session's nor approved by the owner, **stop and tell
  the owner exactly what else would ship** — nothing is cherry-picked onto production. When the workflow cannot pin
  that commit (e.g. gateway staging no longer serves it), stop and say so.

Both scopes: STAGING-VERIFY passed on the exact commit shipped; a migration in the range is named to the owner first and
the publish never applies one; never `publish-to-prod.sh` or `EXEC-DEPLOY.yml`; `reason` names the VTID(s), the scope,
the session id and the STAGING-VERIFY run. After dispatch, watch the run and do only the read-only production deploy
check (build-info equals the shipped commit, `/alive`; no test suite against production) and report the result. A
failed run or a rollback is reported with the five-part stop message and not re-dispatched without a new command.
Record it in the lane log or `handoff.md` (a lane-less change: the PR) with `publish: <run url>`, the commit, the
scope and `authority: owner instruction <ISO time>`.

## 7d. Kiro dispatches workflows (owner decision 2026-10-23)
Owner instruction 2026-10-23: *"let Kiro execute"* — a Kiro session runs the workflows its work needs itself and never
hands the owner a `gh workflow run` command to type. Kiro Web carries a general GitHub token (`GH_TOKEN`) for this.
- **Without asking** (any Kiro session, incl. the plan driver): dispatch or re-run staging, verification and CI
  workflows — `AWS-STAGE-*`, `STAGING-VERIFY*`, preview workflows, PR-GATE, PLAN-SPAR and any test/lint/CI workflow
  that deploys nothing; re-runs of a failed run at any attempt (fix-forward still stops after 3, §7). Read repo
  variables (`MIGRATION_TARGET`, `MIGRATION_FREEZE`, `CLAUDE_AVAILABLE`) as needed.
- **Migrations — on the owner's approval.** `RUN-MIGRATION.yml` and every vitana-v1 `apply-*.yml` write the
  production database (staging shares it), so Kiro dispatches one only when the owner, in the conversation, has
  approved the migration file(s) and the target database (`supabase` or `aurora`). An approval naming only the files
  is completed by Kiro: it reads `MIGRATION_TARGET` (unset = `supabase`), states the resolved database in its reply and
  dispatches with `target` passed explicitly, never `default`. Not while `MIGRATION_FREEZE` is `true`; files in
  timestamp order (and any queue the plan names); `allow_non_transactional` only when the owner named it. Kiro watches
  each run, does the read-only post-check, and records `migration: <run url> <file> target:<db> authority: owner
  instruction <ISO time>` in the lane log or `handoff.md`. A failed run stops the remaining files and is reported with
  the five-part stop message; it is not re-dispatched without a new owner instruction. A policy approval
  (`converged-auto-v1`) never authorises a migration.
- **Never under §7d:** any production deploy workflow (`AWS-PROD-*`, `AUTO-DEPLOY.yml`, vitana-v1 `DEPLOY.yml`,
  `supabase-functions-deploy.yml`, `DEPLOY-CLOUDFLARE-WORKERS.yml`, `EXEC-DEPLOY.yml`) — production stays §7c / PUBLISH
  after Gate 2; repo settings, secrets or branch protection; direct live writes from session tools (§7a).

## 8. Waking each agent — the continuous plan driver
- **One plan driver per approved plan.** One Kiro run holds the plan's `_plan` claim and drives it non-stop, 24/7
  including weekends, from the `plan(` PR to Gate 2: answers sparring rounds, builds or dispatches lanes, collects the
  reviewer agent's verdicts, merges under §7b, watches the staging deploy and STAGING-VERIFY, fixes forward, sends
  Gate 2. Many plans run in parallel, each with its own driver.
- **Heartbeat:** ref `refs/heads/collab-driver/<slug>` — a commit whose tree equals `origin/main^{tree}` (no workflow
  triggers), parent the previous tip (fast-forward only, never forced), trailers `Collab-Session: <driver session>`,
  `Collab-Driver: <slug>`. Interval ≤ 15 min. **Alive** = committer date < 45 min old. A second driver refuses a
  foreign tip younger than 45 min; an older one it takes over. A missing ref = no driver. Without a live driver the PM
  reassigns a stale lane after 2 h and breaks a stale claim after 4 h (24 h / 48 h while a driver is alive).
- **Kiro IDE:** launch `.kiro/workflows/vitana-pipeline.workflow.json` with the owner task. **Kiro Web** (no workflow
  engine): follow `.kiro/pipeline/driver.md` in one continuous session.
- **Seat automations** (`.kiro/automations/<seat>.md`, weekdays hourly) are fallback wake-ups only: they start or
  resume the driver of an approved plan whose heartbeat is stale, else take the next item of their seat.
- **Claude:** the Routine whose prompt is `vitana-platform/scripts/collab/routine-prompt.md` runs only when Claude is
  available (§7) and works only the exceptions there.
- Kiro runs when the owner starts it — in Kiro IDE on the owner's machine, or as a **Kiro Web** cloud session
  (app.kiro.dev) on `vitana-platform` — or when an automation wakes it; the steering files make it run §4. Kiro Web
  clones `exafyltd/vitana-v1` next to it (the Kiro GitHub app covers both repos) so `queue.mjs --repo … --repo …` works
  as in the IDE. If the session cannot get the second checkout, it runs `queue.mjs --repo <available repo>` only, works
  lanes in that repo, and leaves cross-repo lanes alone.

## 8a. Parallel execution
1. Lanes run in parallel by default; the plan declares the real `depends_on` (file/API dependencies only) and the
   shared files. No two lanes edit the same file.
2. Caps: PLAN-SPAR at most **2** sessions in flight repo-wide (the Bedrock quota is shared with production; 6 at once
   all failed `deadline_exceeded`); build lanes at most **6** per plan.
3. Serialized landing: before merge a lane is brought up to date with latest `main` and its required checks re-run on
   that head; one merge per repo at a time (merge-queue semantics), so two individually green lanes cannot break
   `main` together.
4. Hot files are sequenced, never parallel: migrations (timestamp order), `DATABASE_SCHEMA.md`, `src/App.tsx`,
   `screens.json` / `exclusions.json`, the parity ledger (`apps/mobile/parity/ledger.json`), i18n shards of the same
   namespace, `CLAUDE.md`.
5. One staging deploy at a time; a STAGING-VERIFY failure is attributed per lane through each lane's
   `docs/validation/<VTID>/staging-tests.json`.
6. A small task (1 lane, ≤ 3 files) runs as a single agent, no fan-out.
7. Interfaces between lanes are defined in the plan, not by the agents.

## 8b. Measurement
Every plan writes `docs/validation/<plan VTID>/timings.json` (plan VTID = the VTID bound to the sparring session) and
Gate 2 quotes it. Every field is `null` when its source is missing (never 0); `sources_unavailable` names them.
```json
{ "schema": "vitana.plan-timings/v1", "plan_slug": "", "vtid": "", "vtids": [], "generated_at": "", "generated_by": "",
  "plan_pr_opened_at": null, "converged_at": null, "policy_approved_at": null, "vtids_allocated_at": null,
  "plan_merged_at": null, "gate2_sent_at": null,
  "convergence_ms": null, "vtid_ms": null, "plan_merge_ms": null,
  "lanes": [{ "lane": "", "vtid": "", "claimed_at": null, "pr_opened_at": null, "accepted_at": null, "merged_at": null,
              "staging_verified_at": null, "build_ms": null, "review_ms": null, "merge_ms": null,
              "review_rounds": 0, "ci_fix_attempts": 0 }],
  "staging_verify_ms": null, "approved_to_verified_ms": null,
  "merge_conflict_count": 0, "staging_verify_failure_count": 0, "sources_unavailable": [] }
```
`convergence_ms` = plan PR opened → converged; `vtid_ms` = policy approval → last lane VTID; `build_ms` = claim → PR
opened; `review_ms` = PR opened → accept; `merge_ms` = accept → merged; `staging_verify_ms` = last merge → last
`staging.verify.passed`; `approved_to_verified_ms` = policy approval → last `staging.verify.passed`.

## 9. CI
PR-GATE **Collab handoff** (`queue.mjs validate`, and the `scripts/collab/*.test.mjs` suites once it runs as its own
job) checks every changed `handoff.md` / lane file, every state change, and the session/lane trailers, and prints the
queue in the job summary. The separate check **Lane scope** (`queue.mjs scope-check`, VTID-05213) is red on its own
when a lane PR leaves its `paths`. **PLAN-SPAR** (VTID-05214) spars `plan(` PRs; its commits carry
`Collab-Session: ci-plan-spar`, may move a plan from `drafted` to `sparred`, `approved` or `parked`, and allocate the
lanes' VTIDs (including lanes still missing one on a later run of a converged, policy-approved plan).
