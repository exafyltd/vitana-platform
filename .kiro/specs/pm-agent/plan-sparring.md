# Plan sparring record — Project Manager Agent (plan v2)

- Partner: plan-sparring-partner (independent, read-only). v2 rounds 1–2 by one partner instance; v1 (rounds 1–5,
  superseded) is appended below for history.
- Class: standard
- Plan hash (sha256 of the text between the plan markers): c739aa2ea65e0a8a36b3c1e0816eb94d3f99c2e3d166745d9a3f6a22e7d380ae
- Verdict: **CONVERGED** (v2 round 2; F1 blocker, F2–F5 major, F6–F10 minor — all ACCEPTED, F4 as a documented residual)
- Owner approval (Gate 1): chat 2026-10-15, "yes"
- VTIDs: VTID-05213 (P0) · VTID-05214 (P1) · VTID-05215 (P2) · VTID-05216 (P3) · VTID-05217 (P4) · VTID-05218 (P5) ·
  VTID-05219 (P6) · VTID-05220 (P7). Parent: VTID-05145.

## Plan v2 and responses (verbatim)

# Plan v2 — Vitanaland Project Manager Agent: Kiro plans, builds and reviews; the PM merges and sends Gate 2

<!-- plan:begin -->
## Goal
Owner decisions 2026-10-14 (all binding, not re-argued here):
- The owner's **only** touchpoint is Gate 2 ("Staging verified — ready for deployment to production?").
- Either agent plans. A converged sparring is approved by policy. If a plan does not converge, the planner re-plans for up to 2 more rounds and then the plan is parked on the board with no message.
- Mid-flight stops (a security or data-loss risk, or a failure that survives 3 fixes) park the lane and show it on the board, with no message.
- **Kiro credits, not Claude credits, carry the work.** Kiro plans, builds and reviews, and reviews cross accounts: one Kiro seat reviews another seat's lane. A **Project Manager (PM)** merges by rule and sends Gate 2. Claude Code is the exception handler only.
- Kiro accounts are seats (`docs/programs/areas.yaml`, VTID-05194):
  - `jtadic` (Kiro Web): backoffice.
  - `exafyltd` (Kiro Web): messenger and the frontend catch-all.
  - `hotmail` and `exafy` (Kiro IDE): run when the owner opens them.
  - All seats share one GitHub identity, `exafyltd`.
- The PM oversees every programme: multi-tenant, native apps, commerce portal, calendar, proactive assistant, desktop redesign, timeline rebuild, Aurora cutover.

This plan **supersedes plan v1 (rounds 1–5)**. Two parts of v1 are dropped:
- Headless dispatch through `kiro-runner` seat keys. Kiro Web scheduled Automations, already shipped in VTID-05194, are the primary channel. Headless dispatch is deferred.
- Claude fan-out by `create_session`. It burned Claude credits and is replaced by Kiro review.

Everything v1 kept for governance stays: the programme registry, policy approval and Gate-2 batching.

## Change class
**standard.** It adds:
- 1 migration;
- 1 gateway sub-module plus a read route;
- 2 CI workflows or steps;
- a Command Hub view;
- rule, steering and automation files.

Phases with a deploy get STAGING-VERIFY plus Gate 2. No test touches production.

## Facts this builds on (verified in the code)
- **The collaboration queue exists** (VTID-05145/05194):
  - `scripts/collab/queue.mjs` provides queue, claim, release, validate and session-id, with seat-scoped ids and a `--seat` filter.
  - The PR-GATE "Collab handoff" step is report-only until 2026-10-20.
  - `.kiro/automations/<seat>.md` is the pull loop for Kiro Web seats.
  - `docs/programs/areas.yaml` maps seats and areas.
- **Kiro Web pushes as `exafyltd` directly.** The `dev_push_kiro_branch` denied prefixes (`kiro-push-branch.ts:19-28`) apply only to `kiro-runner` sessions. (They guard the gateway push tool `dev_push_kiro_branch`; Kiro Web pushes through the Kiro GitHub app and bypasses that tool.) Today nothing stops a Kiro Web session from pushing `.github/workflows/`, `.claude/` or migrations to a branch. Only review and CI stand before `main`.
- **Sparring service:** `routes/plans-spar.ts`:
  - `POST /` (:46) and `POST /:id/rounds` (:56) use `requireServiceOrAdmin`;
  - `GET /:id` is at :66;
  - `/:id/approve` (:75) is admin-only.
  - Its Bedrock Opus partner has no fallback.
- **DB gate:** `_plan_sparring_gate_eval` requires `human_approved_by` (`migrations/20261004110000_vtid_04868_plan_sparring_gate.sql:36-44,485`).
- **Safe merge exists:** `POST /api/v1/github/safe-merge` (`routes/cicd.ts:302`, service or admin, both repos, checks gate, `GITHUB_SAFE_MERGE_TOKEN`).
- **The Gate-2 question exists in the Operator run view:** `services/operator-runs/run-view.ts:788` asks "Staging verified — ready for deployment to production?". Operator Chat is one of the two channels rule 49 allows.
- **No PM exists.** Orchestrator v2 is the ORB specialist router, and Worker Orchestrator routes autonomous work orders. Neither groups VTIDs into programmes or merges lanes (v1 facts, re-checked).

## Design

### 1. Lane schema: who plans, builds and reviews (queue.mjs, P0)
Lane front matter gains these fields:
- `executor: kiro|claude`;
- `seat` (exists);
- `reviewer_seat` (a Kiro seat ≠ `seat`, or `claude`);
- `paths:` (list of globs, required from `executing` on).

`handoff.md` gains `author_seat`. The validator checks four things:
- `reviewer_seat ≠ seat`;
- the seat exists in `areas.yaml`;
- `paths` are non-empty for executing lanes;
- a lane whose `paths` match a **governance path** has `executor: claude`.

The governance paths are:
- `.github/**`
- `.claude/**`
- `.kiro/steering/**`
- `.kiro/automations/**`
- `scripts/collab/**`
- `CLAUDE.md`
- `docs/programs/areas.yaml`

When the planner creates lanes, it sets `seat` from the area map. It sets `reviewer_seat` to the other Kiro Web seat, so jtadic ↔ exafyltd review each other's lanes. When one seat holds both, the reviewer falls back to a Kiro IDE seat and then to `claude`.

### 2. Lane-scope CI check: the merge-time enforcement Kiro Web lacks (P0, blocking from day one)
A new PR-GATE step, **"Lane scope"** (`queue.mjs scope-check`), runs for every PR whose commits carry `Collab-Lane`, and for every PR whose head branch starts with `kiro/`.

It reads the lane file from the PR's own repo when `.kiro/specs/<slug>/` is there. Otherwise it fetches the lane file from vitana-platform `main` through `gh api`, using the same `PLATFORM_DISPATCH_TOKEN` path vitana-v1 already uses for `queue.mjs` (R1 F2). It applies only to lanes that declare `paths`; legacy lanes without `paths` are reported, not blocked, and the PM never merges them (R1 F7).

It fails when:
- a changed file matches none of the lane's `paths`;
- a governance path is changed by a lane with `executor: kiro`;
- a `kiro/` branch carries no `Collab-Lane` trailer;
- the lane file on the PR branch was edited by a session whose seat ≠ the lane's `seat`. The exception is a review entry carrying a `Collab-Review` trailer from the `reviewer_seat`.

The step counts toward the PR-GATE verdict at once, not after a report-only period, because the PM merges on it. "Collab handoff" becomes blocking on 2026-10-20 as already scheduled, not earlier (R1 F7).

### 3. Sparring without Claude and without credentials in Kiro: `PLAN-SPAR.yml` (P1)
Kiro Web has no gateway token and must not get one. Sparring therefore runs **in CI**:
1. A PR titled `plan(<slug>): …` changes `.kiro/specs/<slug>/plan.md`. The plan is the text between `<!-- plan:begin -->` and `<!-- plan:end -->`. Responses go to `sparring/responses-<n>.md`.
2. The workflow calls the gateway sparring API with the service token, which is a repo secret.
3. It commits the partner's findings as `.kiro/specs/<slug>/sparring/round-<n>.md` to the PR branch. The trailer is `Collab-Session: ci-plan-spar`; this literal is added to `SESSION_RE`.
4. It posts one PR comment with the link.
   The workflow commits with `GITHUB_TOKEN`. GitHub does not start workflows from `GITHUB_TOKEN` pushes, so its own commit cannot re-trigger it. As a second guard, the first step exits when the head commit's `Collab-Session` is `ci-plan-spar`. A `concurrency` group per PR keeps rounds strictly one at a time (R1 F1).
5. The planner seat's next automation run answers every finding in `responses-<n>.md`, updates the plan and pushes. That push triggers the next round.

There are at most 3 rounds, plus 2 re-plan rounds, per sparring session. The limit is enforced by the service.

The workflow only runs on PRs from the same repository and never on `pull_request_target` from forks. The token never reaches a step that runs repository code: the API call is in a dedicated step using only `curl` plus `jq` over the plan file.

Claude keeps its local `plan-sparring-partner` for plans it authors, and records them through the same API. That makes one session table for all plans.

### 4. Policy approval replaces Gate 1 (P1, migration + service)
`plan_sparring_sessions` gains `policy_approved_at` and `policy_approval_rule` (first value `converged-auto-v1`). Only the sparring service sets them, and only when:
- the verdict is `converged`;
- the stored final-plan hash equals the hash of the plan on the PR head;
- every finding has an answer.

`escalated` is never auto-approved. Four touch points change together:
1. the columns;
2. `_plan_sparring_gate_eval`, which accepts human **or** policy approval;
3. `plan_sparring_append_round`, which freezes on either;
4. `approveSparringSession`, which treats a policy-approved session as approved.

The reconciler (`plan-sparring/reconciler.ts`) gains the check `policy_approval_on_non_converged` → P1.

**Ordering (R1 F3):** the allocation step is behind the repo variable `PLAN_SPAR_ALLOCATE`, default off. It is set to `true` only after the P1 migration is applied and `_plan_sparring_gate_eval` is confirmed to accept policy approval in the gate's current mode. Until then a converged plan stops at `sparred` with `next_actor: claude`.

After policy approval, `PLAN-SPAR.yml` allocates one VTID per lane: `POST /api/v1/vtid/allocate` with the sparring id, service token. It writes the VTIDs into `handoff.md` and the lanes, sets plan `approved`, and sets lanes `ready` with `next_actor: kiro`. The allocation is done by CI, not by Kiro. Kiro still never allocates.

A non-converged plan after round 5 is set `parked` (`parked_from: sparred`) by the same workflow.

### 5. Programme registry (P2, Kiro)
`docs/programs/<id>/program.md` holds front matter with these fields:
- `id`, `title`, `status`, `priority`;
- `repos`, `specs`, `docs`;
- `exit_criteria`, `next_review`.

All 8 programmes are backfilled with links only. `queue.mjs --program` and a `program` column are added. The validator checks that every spec belongs to exactly one programme.

### 6. Project Manager: gateway sub-module `services/gateway/src/services/project-manager/` (P3, P4, Kiro)
The PM is a **deterministic** loop: rules in code, no LLM decides. It is a 10-minute in-process `setInterval` behind two switches:
- `PM_AGENT_ENABLED` (default off);
- `PM_MODE=off|dry_run|live` (default `dry_run`).

It is enabled on **exactly one** gateway, staging first. Each tick takes a Postgres lease first: a single `pm_lease` row is claimed with `UPDATE … WHERE expires_at < now() RETURNING`, valid for 9 minutes. A task that does not get the lease skips the tick, so several ECS tasks never act twice. Merges also go through safe-merge, which refuses an already-merged PR (R1 F8). It writes only to GitHub (merge, lane-file commits) and to its own tables, never to member data.

1. **Observe:** registry, queue state of both repos (a shared reader ported from queue.mjs), claim refs, PRs with CI, Lane scope and Claude Approvals, STAGING-VERIFY results, and ledger rows.
2. **Decide** (pure, table-tested):
   - **Merge** a lane PR when all of these hold:
     - the lane is `verified`;
     - the last review entry has a `Collab-Review` trailer from `reviewer_seat`, on the PR's **current head sha**, with verdict `approve`;
     - all required checks are green on that head, including Lane scope and Collab handoff;
     - every check that branch protection requires on that head is green. If a check run named "Claude Approvals" from the Claude Approvals GitHub App exists on the head, it must be `success`. Today neither repo's workflows define it; it is an App check, not a workflow step (R1 F5);
     - there is no merge conflict;
     - `depends_on` lanes are `done`;
     - the PR title carries the lane's VTID;
     - the lane declares `paths`.
   - **Reassign:** move a lane `ready` for more than 24 h whose seat ran no automation in that time to the next seat for the same area. If none, set `next_actor: claude`. The same applies to a review waiting more than 24 h: move it to another seat or `claude`.
   - **Park:**
     - a lane whose PR failed CI on 3 consecutive pushes;
     - a lane flagged `risk:` by its reviewer;
     - a claim older than 48 h with no branch activity, which is released.
   - **Gate-2 batch:** this applies to VTIDs merged and passing STAGING-VERIFY without a Gate 2. Send when every deploying lane of a plan is verified on staging, or 4 h after the first, whichever is first.
3. **Act** (`live` only):
   - merge through the existing `safe-merge` service function, in-process;
   - make lane-file commits with the trailers `Collab-Session: pm-agent` and `Collab-Lane`, through the gateway GitHub token. `pm-agent` is added to `SESSION_RE` as a literal (R1 F6);
   - post the Gate-2 message to the Operator Chat (the existing `run-view` question format) with the evidence and **every commit between production and the verified commit**;
   - set lane and plan `done` after merge.

   **Never:** deploy, dispatch a workflow, allocate VTIDs, edit code, or merge a PR that touches a governance path unless its reviewer is `claude`.
4. **Report:** OASIS events `pm.*` and table `pm_digests` (P1 migration, RLS exafy_admin). The owner gets **one** message per release (Gate 2) and nothing else.

### 7. Kiro automations gain review and planner duties (P5, Claude: governance paths)
`.kiro/automations/<seat>.md` gets an order of work per run, at most one item:
- (a) answer sparring findings on plans with `author_seat: <me>`;
- (b) review one lane with `reviewer_seat: <me>`, `state: in-review`. The review covers:
  - the PR against `tasks.md` acceptance;
  - CI;
  - the read-only staging-test file presence.

  The reviewer writes a review entry with `Collab-Review`, and verdict `approve` → `verified`, or `changes` → `executing`;
- (c) implement one lane with `seat: <me>`.

The same text goes into the Kiro steering for the IDE seats.

### 8. Claude Code as exception handler only (P5)
The Routine stays 3×/day, bound to this coordinator session. It handles only:
- lanes with `next_actor: claude`, meaning governance-path lanes, reassignment fall-through, and parked items needing a fix it can make;
- PRs touching governance paths;
- the reconciler P1.

No `create_session` fan-out. `routine-prompt.md` is rewritten accordingly.

### 9. Credentials for Kiro: read-only or none
- Kiro Web environments carry **no** Supabase, AWS or gateway secrets: only the Kiro GitHub app.
- Kiro IDE seats follow §7a, which already exists.
- A read-only database role for diagnosis is **deferred** to its own plan. It needs RLS and PII review.

### 10. Rule changes (P5, Claude)
In both repos:
- Collaboration §7 roles: Kiro plans, builds and reviews; the PM merges and sends Gate 2; Claude handles exceptions.
- §7a: the executor never merges. The PM merges.
- §8 waking.
- CLAUDE.md:
  - the Autonomy Contract: Gate 1 → policy approval;
  - stop cases → park + board.
- Rules 51–55 text: approval may be human or `converged-auto-v1`.
- The plan-sparring skill.
- The Kiro steering.

### 11. Command Hub board (P6, Kiro)
A read-only view of programmes → specs → lanes showing:
- seat and reviewer seat;
- state, PR, CI, age;
- park reasons;
- the PM mode, plus a mode switch for exafy_admin;
- digests and the Gate-2 batches waiting.

## Phases (one lane = one VTID)
- **P0 (claude: governance paths)**
  - lane schema fields;
  - validator;
  - `scope-check` with tests;
  - PR-GATE "Lane scope" (blocking) and "Collab handoff" → blocking, in both repos;
  - `SESSION_RE` literals `pm-agent` and `ci-plan-spar`.
- **P1 (claude: workflow + gate migration)**
  - `PLAN-SPAR.yml`;
  - policy-approval migration (4 touch points) plus the `pm_digests` and `pm_lease` tables;
  - service change and reconciler check;
  - CI VTID allocation;
  - `DATABASE_SCHEMA.md`.
- **P2 (kiro, exafyltd → review jtadic)**
  - programme registry;
  - `--program`.
- **P3 (kiro, jtadic → review exafyltd):** PM observe + decide in `dry_run`, with OASIS `pm.decision` only and table tests for every rule.
- **P4 (kiro, jtadic → review exafyltd):** PM act — merge, reassign, park, Gate-2 batch — with integration tests (fake GitHub + in-memory DB).
- **P5 (claude: governance paths)**
  - automation files;
  - steering;
  - rules;
  - CLAUDE.md in both repos;
  - routine prompt.
- **P6 (kiro, exafyltd → review jtadic):** Command Hub board + digest.
- **P7 (claude: deploy workflow env)**
  - staging flags: `dry_run` 3 days, then `live`;
  - production gateway keeps `PM_AGENT_ENABLED=false`.

Dependencies:
- P0 → everything.
- P1 → P3.
- P2 → P3 → P4 → P7.
- P5 after P1.
- P6 after P3.

Until P0, P1 and P5 are merged, this plan's own lanes run under today's rules: Claude reviews and merges.

## Files in scope
**vitana-platform**
- `scripts/collab/queue.mjs` + tests
- `.github/workflows/PR-GATE.yml`
- `.github/workflows/PLAN-SPAR.yml` (new)
- `supabase/migrations/<ts>_plan_sparring_policy_approval_and_pm_digests.sql`
- `services/gateway/src/services/plan-sparring/**`
- `services/gateway/src/routes/plans-spar.ts`
- `services/gateway/src/services/project-manager/**` (new)
- `services/gateway/src/routes/project-manager.ts` (new, read + mode switch)
- `services/gateway/src/index.ts` (one interval block)
- `services/gateway/src/routes/cicd.ts` (export the safe-merge function for in-process use, no behaviour change)
- Command Hub board files
- `docs/programs/**`
- `.kiro/automations/**`
- `.kiro/steering/**`
- `.claude/rules/collaboration.md`
- `.claude/skills/plan-sparring/**`
- `CLAUDE.md`
- `scripts/collab/routine-prompt.md`
- `DATABASE_SCHEMA.md`
- staging deploy workflow env
- `.kiro/specs/pm-agent/**`

**vitana-v1**
- `.github/workflows/PR-GATE.yml` (Lane scope step)
- `.claude/rules/collaboration.md` + Kiro twin
- `CLAUDE.md`

## Test plan
- **Unit (node:test, git fixtures):**
  - lane schema validator;
  - `scope-check`: every fail rule plus a pass case;
  - session-id regex with `pm-agent` and `ci-plan-spar`;
  - `scope-check` cross-repo fetch for a vitana-v1 PR whose lane lives in vitana-platform (fixture with a fake `gh`).
- **Jest:**
  - policy approval: converged + hash match → approved; escalated, hash mismatch or unanswered → not;
  - gate eval accepts policy;
  - append_round freezes;
  - reconciler flags policy-on-non-converged;
  - PM decide table tests (each merge precondition individually false → no merge; reassign; park; batch timing);
  - PM act with fake GitHub (merges only via safe-merge; never calls deploy, allocate or a workflow dispatch; never merges a governance-path PR without a `claude` review).
- **CI dry run of `PLAN-SPAR.yml`** on a test plan PR with a docs-only plan and **zero lanes**, with `PLAN_SPAR_ALLOCATE` off, so no VTID is allocated (R1 F9). It writes rounds to the branch. This is a real gateway call; it writes a sparring session row, which is governance data, not member data, and that is the API's normal use.
- **Staging (read-only STAGING-VERIFY):**
  - `GET /api/v1/project-manager/status` returns mode and the decision list;
  - the board renders.
- **Live switch-on on staging** with one docs-only test lane end to end (Kiro seat implements → other seat reviews → PM merges). The merge lands on `main` (docs only, no deploy).
- The operator, support and roles regression suites stay green.

## Risks
- **Shared GitHub identity:** seat attribution rests on trailers, which a session could forge. This is mitigated three ways:
  - Lane scope ties edits to the lane's `paths`;
  - every merge needs green CI and Claude Approvals;
  - production needs Gate 2.

  This is an accepted residual. Kiro seats are all the owner's own accounts. **The reviewer-seat check is advisory, not proof (R1 F4).** A trailer is self-asserted, so the PM additionally requires the review commit's session id to differ from every session id in the lane's executing log entries. This catches an executor reviewing itself by mistake, not deliberate forgery.
- **PM lease lost mid-merge:** safe-merge refuses an already-merged PR (`pr_not_open`, `cicd.ts:344`). The extracted function returns a typed result, and the PM treats "already merged" as a no-op success, not a failure (R2 F10).
- **PM merges without a human:** this is within the Autonomy Contract after Gate 1. Policy approval replaces Gate 1 by owner decision. The kill switch is `PM_MODE=off`.
<!-- plan:end -->

---
## Planner responses — v2 round 1
- F1 blocker (self-trigger loop) — **ACCEPTED**: the workflow commits with `GITHUB_TOKEN` (GitHub does not start workflows from those pushes), plus a first-step guard on `Collab-Session: ci-plan-spar` and a per-PR `concurrency` group (§3). Q1 answered.
- F2 major (vitana-v1 Lane scope has no lane file) — **ACCEPTED**: same-repo lane file first, otherwise `gh api` fetch from vitana-platform `main` with the existing `PLATFORM_DISPATCH_TOKEN`; a test fixture is added (§2, test plan). Q2 answered.
- F3 major (allocation before migration) — **ACCEPTED**: allocation behind `PLAN_SPAR_ALLOCATE` (default off), switched on only after the migration is applied and the gate accepts policy approval in its current mode (§4).
- F4 major (review seat unverifiable) — **ACCEPTED as a documented residual**: the check is called advisory; added a session-id ≠ executor-sessions rule; the protections are Lane scope, required checks and Gate 2 (Risks).
- F5 major ("Claude Approvals" not in CI) — **ACCEPTED**: it is a GitHub App check run, not a workflow. The precondition is now "every check branch protection requires is green; if a Claude Approvals App check run exists on the head, it must be success" (§6). Q3 answered.
- F6 minor — **ACCEPTED**: `pm-agent`.
- F7 minor — **ACCEPTED**: Collab handoff stays on its 2026-10-20 date; Lane scope blocks only lanes that declare `paths`; legacy lanes are report-only and never PM-merged.
- F8 minor (duplicate tasks) — **ACCEPTED**: `pm_lease` row per tick (§6). Q4 answered.
- F9 minor — **ACCEPTED**: the test plan PR has zero lanes and allocation is off.

## Planner responses — v2 round 2
- F10 minor — **ACCEPTED**: typed safe-merge result; already-merged is a no-op success (Risks).
- Partner verdict: **CONVERGED** (round 2).


---

## History — plan v1 (superseded by v2, kept verbatim)

# Plan — Vitanaland Project Manager Agent + one-Claude → many-Kiro dispatch

<!-- plan:begin -->
## Goal
Owner ask (2026-10-14): ongoing Claude Code work is handed to Kiro to pick up and finish **without the owner
copy-pasting**, with humans in the loop only where unavoidable. One Claude account works with **many Kiro accounts**.
A **Project Manager (PM) Agent** oversees every Vitanaland programme — today: multi-tenant architecture, native mobile
apps, commerce portal, calendar, proactive Vitana assistant, desktop redesign, timeline rebuild, Aurora cutover — and
supervises many developer agents (Claude sessions + Kiro sessions). **Executor: Kiro for code lanes, Claude Code for
lanes that touch paths Kiro may not push** (R1 F1/F7: `kiro-push-branch.ts:19-28` denies `.claude/`,
`supabase/migrations/`, `docs/validation/`). Every lane declares its `executor` and `paths`; Claude reviews every Kiro
lane PR and adds the `docs/validation/<VTID>/` evidence on the same branch.

## Change class
**standard** — new gateway service + routes, 2 migrations, Command Hub view, scheduled job, CI/rules files. Each
phase deploys to staging and gets STAGING-VERIFY + Gate 2. Nothing runs against production until Gate 2.

## Facts this builds on (verified in the code)
- **The existing "Orchestrator" is not a PM.** Orchestrator v2 (`services/gateway/src/services/orchestrator/`,
  `docs/ORCHESTRATOR-REDESIGN-PLAN.md:1-21`) is the in-gateway `delegate_to_agent` router for ORB specialists
  (support, commerce, deep-dive) and the Operator; ledger `agent_runs` (`migrations/20260923120000_vtid_04319…`).
  Worker Orchestrator (`routes/worker-orchestrator.ts`) routes autonomous work orders; neither groups VTIDs into
  programmes or assigns work to developer agents. No PM/supervisor exists anywhere (searched both repos).
- **Kiro already runs server-side, headless.** `services/kiro-runner` spawns `kiro-cli acp` per session over a
  gateway WebSocket (`services/gateway/src/services/kiro/remote-backend.ts:1-18`, `kiro-turn.ts:1-42`); runs are
  persisted (`kiro_runs`, `kiro_run_events`, VTID-05065); caps `KIRO_MAX_SESSIONS_PER_USER`=3,
  `KIRO_MAX_SESSIONS_GLOBAL`=10, idle 45 min (`kiro-turn.ts:223-228`); every session gets worktrees of both repos
  (`kiro-runner/src/repo-mirrors.ts:1-12`); Kiro has **no push credential** — edits leave through the gateway MCP tool
  `dev_push_kiro_branch` (same file :7-8); MCP write tools need confirmations (`routes/operator-kiro-mcp.ts`,
  migration `…vtid_05006_kiro_mcp_confirmations.sql`).
- **Kiro keys are one per Vitana admin user** (`kiro-runner/src/key-store.ts:1-7`, Secrets Manager `<prefix>/<user_id>`,
  only the runner's role may read). There is no notion of several Kiro accounts per owner.
- **The collaboration queue exists** (VTID-05145): `.kiro/specs/<slug>/handoff.md` + `lanes/<lane>.md`, atomic claim
  refs `collab-claim/<slug>/<lane>`, `scripts/collab/queue.mjs` (queue/claim/release/validate), PR-GATE "Collab
  handoff" step, Claude wake-up Routine. Session-id regex accepts `session_…` and `kiro-YYYYMMDDHHMM-xxxx` only.
  In use by `desktop-spotlight` (vitana-v1) and `life-timeline` (vitana-platform).
- **VTIDs have `parent_vtid`** (`migrations/20251217000000_vtid_ledger_and_allocator.sql:34`) but no programme
  grouping; programmes exist only as docs (`docs/programs/health-hub/`, vitana-v1 `docs/programs/native-app/`,
  `docs/MULTI-TENANT-PLAN.md`, `docs/AURORA-CUTOVER-*`, `docs/plans/…`).
- Status inputs already exist: dev-memory resume pack (`routes/dev-memory.ts:88`, VTID-05060) and morning pack
  (`:72`); `roadmap-analyzer.ts` (VTID-01185) finds stalled VTIDs.

## Design

### 1. Programme registry (git, both repos readable) — "what are we building"
`vitana-platform/docs/programs/<program-id>/program.md` (existing convention, `docs/programs/health-hub/`; R1 F6) (front matter + body), one per programme:
`id, title, owner (human), status (active|paused|done), priority (1-5), repos, specs: [<repo>:<.kiro/specs/slug>],
docs: [paths], vtids: [...], kpis/exit criteria, next_review`. Backfill the 8 named programmes from their existing
docs (links only — no plan text is copied or rewritten). A programme groups specs; a spec groups lanes; a lane is one
VTID (or declared lane group). `queue.mjs` gains `--program` filter and a `program` column (spec → programme via the
registry). Validation in the same PR-GATE "Collab handoff" step (registry front matter + every spec belongs to exactly
one programme).

### 2. Developer pool — one Claude, many Kiro accounts
New table `dev_agent_seats` (migration, RLS: exafy_admin only): `seat_id` (e.g. `k1`, `k2`, `claudemain`),
`seat_user_id` (a synthetic UUID per seat — the identity PM runs carry in `kiro_runs.user_id NOT NULL` and in the
existing `kiroBranchPrefix(userId)` rule; R2 F11),
`kind` (kiro|claude), `key_ref` (Secrets Manager name for Kiro; none for Claude), `max_concurrent`, `enabled`,
`affinity` (programme ids, optional), `daily_session_budget`, `last_error`, timestamps.
- Kiro key store gains **seat keys** through a separate `SeatKeyStore` (today's `KeyStore` only accepts user-id
  UUIDs, `key-store.ts:20,65`; R1 F9): `<prefix>/seat/<seat_id>` (runner-only resource policy, same as today);
  `PUT/DELETE /api/v1/operator/kiro/seats/:seat_id/key` (exafy_admin). The owner pastes each Kiro account's key once;
  never shown again.
- Seat ids are `[a-z0-9]{1,12}` without dashes (e.g. `k1`, `k2`). Session ids become seat-scoped:
  `kiro-<seat>-YYYYMMDDHHMM-xxxx`; `SESSION_RE` becomes
  `^(session_[A-Za-z0-9]+|kiro-(?:[a-z0-9]{1,12}-)?\d{12}-[0-9a-f]{4})$` — the old form stays valid and cannot be
  confused with the new one because a seat id never is 12 digits (validator rejects all-digit seat ids) (R1 F4). So every commit/claim/PR names the exact Kiro account and session — no mixing.
  Consumers that need the seat read the optional group; a `kiro-` id without it is a legacy / human-opened Kiro IDE
  session (R2 F14). Branch↔lane match: the existing `<kiro|claude>/<slug>/<lane>` form or, for PM runs,
  `kiro/<seat8>/<slug>-<lane>` (queue validator learns this form).
- Per-seat caps replace the per-user cap for PM-dispatched runs (global cap still applies).

### 3. Project Manager Agent — gateway sub-module `services/gateway/src/services/project-manager/` (no new ECS service; R1 F3)
A **deterministic control loop** (not an LLM deciding on its own), run every 10 min by an in-process `setInterval` in
`index.ts`, same pattern as `AUTOPILOT_HEARTBEAT_ENABLED` (`index.ts:1836-1842`; R1 F8),
behind `PM_AGENT_ENABLED` (off by default) and `PM_DISPATCH_MODE=off|dry_run|live` (default `dry_run`):
1. **Observe**: read registry + queue state from GitHub (both repos, main + recent branches, claim refs — same logic as
   queue.mjs, shared module), ledger rows of each lane's VTID, open PRs + CI + review state, STAGING-VERIFY results,
   `kiro_runs`.
2. **Decide** (pure function, unit-tested): for each lane `next_actor: kiro`, `executor: kiro`, `ready`/`executing`, not blocked, not
   claimed, and whose declared `paths` contain no Kiro-denied prefix (else the lane is reported as mis-assigned and
   handed to `claude`) → pick a free enabled Kiro seat (affinity first, then least-loaded, respecting caps/budget). For lanes
   `next_actor: claude` → nothing to dispatch (Claude's Routine picks them up); PM only reports them.
   Detect: stale claims (>24 h, no branch activity), red CI on lane PRs, lanes stuck >48 h, dependency deadlocks.
3. **Act** (live mode only):
   - **Claim on the seat's behalf** through the gateway's GitHub token (`collab-claim/<slug>/<lane>`, Collab-Session =
     the new seat session id, plus trailer `Collab-Dispatcher: pm`) — Kiro itself still has no push credential.
   - **Claim lifecycle (R1 F5):** the PM creates the claim, records claim ref + sha on the run row, and is the only
     party that releases it: on run success (after the lane file shows the hand-off), on failure, on timeout. On every
     tick the PM reconciles: a `Collab-Dispatcher: pm` claim whose run row is terminal or missing for > 15 min is
     released and logged (gateway restarts leave no orphan for more than one tick + 15 min). PM claims therefore never
     wait for the 24 h human-session stale rule.
   - **Start a headless Kiro run** on that seat — `kiro_runs` gains `origin` (`thread|pm`), `seat_id`, `lane_key`,
     `claim_sha` (new migration, Claude-executed lane; R1 F2), seat key with a fixed lane prompt:
     "You are session <id> on lane <slug>/<lane> (VTID). Follow `.claude/rules/collaboration.md`; read the spec and the
     lane log; implement the lane's tasks; run the local checks; push only via `dev_push_kiro_branch` to
     `kiro/<seat8>/<slug>-<lane>` (the existing prefix rule `kiro/<first8 of user id>/`, `kiro-push-branch.ts:41-51`,
     with the seat's synthetic user id — no change to `validatePush`; R2 F11) with the trailers; open/update the PR; update the lane file; stop." MCP write confirmations
     for PM runs are pre-approved **only** for `dev_push_kiro_branch` to exactly that lane branch, plus PR open/update
     for that branch; every other write tool is denied when unattended (a PM-run `deps.confirm` in
     `callKiroMcpWrite`, `kiro-mcp-writes.ts:145-154`).
   - **Lane path allowlist (R2 F12):** enforced at the push point by a `deps.push` wrapper around `pushKiroBranch` for
     PM runs: every file in the push must match one of the lane's declared `paths` globs (and still pass the existing
     denied-prefix `validatePush`), else the push is refused with a named error and logged as `pm.push_refused`.
   - **Threat model (R1 F10):** the worst a runaway PM run can do is push code within its lane's paths to its own
     branch and open a PR. Nothing reaches `main` without PR-GATE, CI, a Claude review and a Claude merge; nothing
     reaches production without STAGING-VERIFY + owner Gate 2. Runaway cost is bounded by: run timeout 2 h, per-run
     turn cap (`PM_RUN_MAX_TURNS`, default 40 prompts/tool rounds), per-seat daily run budget, and 2 consecutive
     failed runs → seat auto-disabled + escalation (R1 Q3).
   - **Supervise**: run timeout (default 2 h) → release claim, log entry, retry once on another seat, then escalate.
   - **Never**: merge, deploy, allocate VTIDs, write production data, touch main. Merge stays with the reviewing Claude
     session after green CI + review; deploys stay behind STAGING-VERIFY + Gate 2.
4. **Report**: emit OASIS events `pm.*` (dispatched, stalled, parked, done); write a daily **programme digest**
   (DB table `pm_digests` + Command Hub view, never committed). The owner is messaged only for Gate 2 (§7).

### 4. Handover from a running Claude session (the "forward to Kiro" step)
New skill `.claude/skills/handover-to-kiro/` (both repos) + `queue.mjs handover` subcommand: from the current branch/PR
and session context it writes (or updates) the lane file(s) — what is done, what is open, exact next tasks, PR link —
sets `next_actor: kiro`, `state: ready|executing`, releases the Claude claim, pushes. The PM dispatches it on its next
tick. For work with no spec yet, the skill creates a minimal spec (requirements/design/tasks from the session's plan +
sparring record) under the right programme. The owner's only action: say "hand this to Kiro" in the Claude session.

### 5. Command Hub — Programmes board
Read-only view in the Command Hub (existing app): programmes → specs → lanes with state, seat/session, PR, CI, age,
blocked reason; seat pool with load and key status; PM mode switch (exafy_admin) and digest. No new sidebar item in the
community app (sidebar rule) — Command Hub only.

### 6. Safety and governance (unchanged rules, enforced)
Sparring before any VTID; Gate 1 per plan; Gate 2 per deploy; PM never allocates VTIDs (lanes carry VTIDs allocated at
Gate 1); no tests against production; Kiro runs use the existing tool-trust model; per-seat + global caps and a daily
session budget; kill switches `PM_AGENT_ENABLED=false` and `PM_DISPATCH_MODE=off`; every PM action is an OASIS event.
PM LLM use (digest summarisation only) is Claude on Bedrock, never Google, no fallback.

## Phases (one lane + one VTID each; reviewer of a Kiro lane = Claude, which also adds `docs/validation/<VTID>/`)
- **P0 schema (executor claude)**: migrations `dev_agent_seats`, `pm_digests`, `kiro_runs` + `origin/seat_id/lane_key/
  claim_sha`, `DATABASE_SCHEMA.md`; lane-file schema gains `executor` and `paths` (queue.mjs + validator + tests).
- **P1 programme registry (executor kiro)**: `docs/programs/*/program.md` for the 8 programmes, queue.mjs `--program`,
  registry validation + tests.
- **P2 seat pool (executor kiro)**: `SeatKeyStore` + seat key routes, seat-scoped session ids (queue.mjs + runner +
  gateway), tests.
- **P3 PM observe+decide (executor kiro)**: gateway sub-module (shared queue reader, decision function), `setInterval`
  job in `dry_run` (logs + OASIS `pm.decision` only), unit tests incl. every decision rule.
- **P4 PM act**: claim-on-behalf, headless lane run on a seat, supervision/timeout/retry, scoped pre-approval of push
  + PR tools; integration tests with a fake runner + fake GitHub; staging run with one test spec.
- **P5 handover skill (executor claude — `.claude/` is Kiro-denied)**: `handover-to-kiro` skill + `queue.mjs handover`,
  rules update + Kiro twin, tests on git fixtures.
- **P6 Command Hub board + daily digest (executor kiro)**.
- **P7 switch-on (executor claude; staging flags in the deploy workflow)**: `dry_run` one week on staging → owner Gate 2 → `live` on staging with 1 seat → then more seats.
Dependencies: P0 → P1, P2, P3; P1 → P3; P2 → P4; P3 → P4 → P7; P5 and P6 parallel after P1.

## Files in scope
vitana-platform: `docs/programs/**` (new), `scripts/collab/queue.mjs` (+tests), `services/gateway/src/services/project-manager/**`
(new), `services/gateway/src/routes/project-manager.ts` (new, read + mode switch), `services/gateway/src/routes/operator.ts`
(seat key routes), `services/gateway/src/services/kiro/**` (seat key + origin='pm' runs), `services/kiro-runner/src/key-store.ts`
(seat keys), `supabase/migrations/<ts>_dev_agent_seats.sql`, `<ts>_pm_digests.sql`, `DATABASE_SCHEMA.md`, Command Hub
frontend files for the board, `.claude/skills/handover-to-kiro/**`, `.claude/rules/collaboration.md` (+ Kiro twin), `services/gateway/src/index.ts`
(one setInterval block), `services/gateway/src/services/kiro/kiro-push-branch.ts` (lane-scoped path allowlist for PM runs),
`.kiro/specs/pm-agent/**` (this plan as Kiro spec), gateway env in staging deploy workflow (flags only, default off).
vitana-v1: `.claude/skills/handover-to-kiro/**`, `.claude/rules/collaboration.md` (+ Kiro twin) mirror.

## Test plan
- Unit: registry validation; seat session-id regex; decision function table tests (every rule: affinity, caps, budget,
  blocked, stale claim, retry, escalate, claude lanes untouched); handover subcommand on git fixtures.
- Integration (Jest, in-memory DB + fake GitHub + fake runner): dry_run produces decisions only; live claims, starts a
  run, times out, releases, retries on another seat, escalates; PM never calls merge/deploy/allocate.
- Staging (read-only STAGING-VERIFY): `/api/v1/project-manager/status` and board render; dry_run decisions present.
- Live dispatch is verified on staging against a dedicated test spec in vitana-platform whose lane only edits a docs
  file on its own branch (no product code, no production data).
- Operator and support pipeline regression suites stay green (rules 42c/42e).

### 7. Owner decisions 2026-10-14 — the owner checks only staging (round 4)
Owner: *"I give a request to either Claude or Kiro to make a plan … Me as human want only to check the staging
verification, nothing else. All other should run by loop engineering and automation."* Answers to the two follow-up
questions: (1) **auto-approve converged plans**; non-converged → re-plan up to 2 more sparring rounds, then park on the
board, no message; (2) **mid-flight security/data-loss risk or a failure surviving 3 fixes → park the lane + board, no
message**. The full loop:

1. **Intake — either agent plans.** The owner gives an initiative (one sentence or more) to Claude Code, a Kiro IDE
   session, or the Command Hub Operator. That agent is the planner: it writes the Kiro spec (requirements, design,
   tasks, lanes with `executor` + `paths`) under the right programme (new programme file if none fits) and pushes it as
   `drafted`.
2. **Sparring for both agents through the gateway.** Claude may keep using its local `plan-sparring-partner`; Kiro (IDE
   or PM-run) uses the existing gateway sparring API `POST /api/v1/plans/spar` + `/:id/rounds`
   (`routes/plans-spar.ts:46,56`, service-or-admin auth, Bedrock Opus partner, no fallback) through a new Kiro MCP tool
   `dev_plan_spar` (R4 F17): served by the existing gateway MCP endpoint (`routes/operator-kiro-mcp.ts`) under the
   run's user context (seat user id for PM runs), calling the sparring **service** in-process — no HTTP hop, no new
   token. Operations: create a session for the run's own plan, append a round, read it; **no approve operation**
   (approval is the gateway policy step only). Per run: at most one sparring session and 5 rounds (3 + 2 re-plan).
   PM runs pre-approve `dev_plan_spar` within those limits; Kiro IDE threads keep the normal confirmation. Every planner's record lands in the same DB session table.
3. **Policy auto-approval replaces the owner's Gate 1.** Today the DB gate requires `human_approved_by NOT NULL`
   (`migrations/20261004110000_vtid_04868_plan_sparring_gate.sql:36-44`) and `/:id/approve` is admin-only
   (`plans-spar.ts:75`). New (Claude lane, migration + route): the sparring session may instead carry
   `policy_approved_at` + `policy_approval_rule` (a versioned rule id, first value `converged-auto-v1`; a changed rule
   gets a new id, R4 F18), set only by the gateway when the verdict is `converged` and the stored final plan hash
   matches; `escalated` is never auto-approved. All four touch points change together in P0b (R4 F16):
   (1) `plan_sparring_sessions` gains the two columns; (2) `_plan_sparring_gate_eval` (migration `…vtid_04868…:485`)
   accepts `human_approved_by IS NOT NULL OR policy_approved_at IS NOT NULL`; (3) `plan_sparring_append_round` (`:405`)
   freezes on either approval; (4) `approveSparringSession` (`plan-sparring-service.ts:423-427`) treats a
   policy-approved session as already approved. The reconciler (`plan-sparring/reconciler.ts:49`) gains detection
   `policy_approval_on_non_converged` as a fourth check with its own query (R4 F19).
4. **Not converged** → the planner re-plans with the same partner up to 2 more rounds; still not converged → plan state
   `parked` (`parked_from: sparred`), shown on the board with the open findings. No message.
5. **VTIDs + lanes** are allocated by the planner right after policy approval (allocation references the sparring id,
   as the hook and DB gate require). The PM then dispatches lanes: Kiro lanes to free Kiro seats (P4), Claude lanes to
   Claude.
6. **Claude fan-out (R4 F15).** The gateway cannot start Claude sessions. The Claude coordinator session (the one the
   wake-up Routine `trig_01JoXEfruAd4o47kaRdbcJs3` is bound to — a persistent session with both repos and connectors,
   not a fresh session per fire) has the `claude-code-remote` tools `create_session`, `get_session`, `list_sessions`,
   `send_message`, `archive_session` (verified: they are in that session's tool list today). Per wake-up it:
   (a) counts its live child sessions by tag `collab-lane` (`list_sessions`); (b) for each ready Claude lane, while
   fewer than `CLAUDE_MAX_PARALLEL` (default 3, a constant in `routine-prompt.md`) are live, starts a child with
   `create_session` (source = the lane's repo, tags `collab-lane`, `<slug>/<lane>`, prompt = the lane prompt incl.
   "`add_repo` the other repo if needed"); the **child claims the lane itself** (it has git push), so the existing
   atomic claim is the coordination — two coordinators can never start two children on one lane; (c) for every child
   whose `get_session.status_bucket` is `failed`, or idle > 2 h with no new commit on its lane branch, releases its
   claim with `--stale`-equivalent logic (claim older than 2 h for `collab-lane` children, recorded in the lane log)
   and archives the child; (d) archives children whose lane is handed off. Cadence: the Routine moves from 3×/day to
   **hourly on weekdays 06–20 Berlin** (the platform minimum is hourly); the PM's 10-min tick serves Kiro lanes only.
   `routine-prompt.md` is rewritten accordingly (P5b).
7. **Review + merge without the owner.** Kiro lane PR → reviewed by Claude; Claude lane PR → reviewed by Kiro (PM
   dispatches a review-only run) or, if no Kiro seat is free within 2 h, by a second Claude session. Green CI + review
   approval → the reviewer merges. (Merging was already inside the Autonomy Contract after Gate 1.)
8. **Mid-flight stops** (security/data-loss risk, a failure that survives 3 fixes, sparring escalation, invalid seat
   key) → the lane or plan goes `parked` with the reason; other lanes continue; the board shows it. No message.
9. **The only human touchpoint: Gate 2.** After STAGING-VERIFY passes on the merge commit, the owner gets one message
   per release: "Staging verified — ready for deployment to production?" with the evidence and the commit list. "Yes"
   → production deploy pinned to the verified commit. Nothing reaches production without it. Batching (R4 F20): the PM
   tracks VTIDs that passed STAGING-VERIFY but have no Gate 2 yet (`pm_digests`); a plan's Gate 2 is sent when all of
   its deploying lanes are merged and verified on staging, or 4 h after the first verified lane, whichever is first;
   the message lists every VTID and commit in the batch.
10. **Rule change.** CLAUDE.md (both repos), the Autonomy Contract, the Plan Sparring Gate rules 51–55, the
   plan-sparring skill, `.claude/rules/collaboration.md` and the Kiro steering are updated in the same (Claude) lane:
   Gate 1 becomes the policy approval above; the owner keeps Gate 2 only; stop cases become park + board. One-time
   setup the owner still does: paste each Kiro account's key once (seat registry); Kiro keys can't be created by an
   agent.

New/changed lanes: **P0b (claude)** policy approval migration + route + reconciler alert + rule/skill/steering
updates; **P2b (kiro)** `dev_plan_spar` MCP tool; **P4b (kiro)** review-only PM runs; **P5b (claude)** Claude fan-out
in the Routine prompt (`scripts/collab/routine-prompt.md`) + Gate-2 batching in the board/digest. P0b runs first: until
it is merged, this plan's own lanes still use today's rules.
<!-- plan:end -->

---
## Planner responses — round 1
- F1 blocker (Kiro cannot push `.claude/`, migrations, `docs/validation/`) — **ACCEPTED**: executor per lane; P0 (schema), P5 (`.claude/` skill + rules) and P7 (workflow flags) are Claude lanes; denied prefixes are NOT widened. The PM never dispatches a lane whose declared paths hit a denied prefix.
- F2 blocker (`kiro_runs.origin` does not exist) — **ACCEPTED**: P0 migration adds `origin`, `seat_id`, `lane_key`, `claim_sha`.
- F3 major (service vs gateway sub-module) — **ACCEPTED**: gateway sub-module only, no new ECS service.
- F4 major (session-id regex) — **ACCEPTED**: concrete regex + seat-id rule given in §2.
- F5 major (claim lifecycle for PM runs) — **ACCEPTED**: PM owns create/release; `Collab-Dispatcher: pm`; reconcile each tick, 15 min orphan window.
- F6 major (programs/ at root) — **ACCEPTED**: `docs/programs/<id>/program.md`.
- F7 major (`docs/validation/` evidence) — **ACCEPTED**: the reviewing Claude session adds it on the lane branch before merge.
- F8 minor (scheduler) — **ACCEPTED**: `setInterval` in `index.ts` behind the flag.
- F9 minor (KeyStore UUID-only) — **ACCEPTED**: separate `SeatKeyStore`.
- F10 minor (threat model) — **ACCEPTED**: §3 threat model + lane-scoped push allowlist.
- Q1: restructured (executor per lane), not widened. Q2: owner wants Kiro to build; a hybrid where Claude does the governance/schema lanes keeps that intent within the safety rules. Q3: per-run turn cap, 2 h timeout, per-seat daily budget, auto-disable after 2 failed runs. Q4: new migration (Claude lane P0).

## Planner responses — round 2
- F11 major (branch prefix) — **ACCEPTED** option (a): synthetic `seat_user_id` per seat; branch `kiro/<seat8>/<slug>-<lane>`; `validatePush` unchanged; queue validator learns the PM branch form.
- F12 major (lane path enforcement point) — **ACCEPTED**: `deps.push` wrapper for PM runs, plus PM-run `deps.confirm` for the tool allowlist.
- F13 minor — **ACCEPTED** (`docs/programs/**`).
- F14 minor — **ACCEPTED** (seat parsing note).

## Round 4 — owner-directed change (§7: owner checks only staging)
Owner decisions 2026-10-14 (chat + two answered questions): either agent plans; converged sparring is auto-approved;
non-converged → 2 more rounds then park; mid-flight stops → park + board; the owner's only touchpoint is Gate 2.
The decisions are not re-argued; review only how the plan implements them.

## Planner responses — round 4
- F15 major (Claude fan-out unspecified) — **ACCEPTED**: §7.6 specifies the coordinator session, the verified `claude-code-remote` tools, parallel cap and its enforcement (`list_sessions` by tag), child-owned atomic claims, failure/idle handling, archive, hourly cadence. Q1: verified — `create_session`/`send_message`/`get_session`/`list_sessions`/`archive_session` are in the coordinator session's tool list (the same session the Routine is bound to); the old `routine-prompt.md` text (fresh session per fire) is superseded and rewritten in P5b.
- F16 major (four touch points) — **ACCEPTED**: all four listed in §7.3.
- F17 major (`dev_plan_spar` trust/auth) — **ACCEPTED**: in-process via the MCP endpoint's user context, no approve op, per-run caps, PM pre-approval within caps. Q2: answered — no HTTP, no new token.
- F18 minor — **ACCEPTED** (`converged-auto-v1`).
- F19 minor — **ACCEPTED** (named detection + query).
- F20 minor — **ACCEPTED** (batching rule).

