---
change_class: standard
---
# plan(operating-workflow): one durable operating workflow for every Kiro session and repository
<!-- plan:begin -->
## 1. Goal (owner, 2026-10-28, Kiro Web session kiro-jtadic-202610281148-d6d3)
> "Consolidate our existing improvement work into one durable operating workflow for all Kiro sessions and
> repositories. The goal is that an authorized task progresses through implementation, independent review, required
> checks, merge, staging deployment, and STAGING-VERIFY without repeated intervention from me. Preserve explicit
> production, migration, and other established decision gates."

Six asks: (1) one authoritative policy, contradictions removed, protected-file changes prepared through the required
review; (2) review independence fixed centrally: the builder may request a review, the reviewer must be independent,
a supported fallback exists, acceptance is bound to the current commit and invalidated by relevant code changes;
(3) durable progress: task state, pending checks, blockers and next action recorded; resume after CI and review by
supported events or scheduled workers; safe recovery without duplicate actions; platform limits documented;
(4) no recurring CI congestion: PM loop, concurrency, registry and CI fixes coordinated, deployments cannot restore the
broken PM, excessive activity detected, no-op writes and redundant runs prevented; (5) a proportional path for
low-risk changes that keeps impact-appropriate checks, with any reduction of an existing requirement routed through
review; (6) existing improvement work inventoried, owned, de-duplicated and finished before new plans. Validation on
real tasks with interruption and recovery, measuring completion time, queue time, retries, regressions and owner
interventions.

Nothing in this plan loosens a stop. Production (PUBLISH, `AWS-PROD-*`), migration apply (§7d), protected gate files
(§3a), live writes, security/data-loss, 3-failure parking, escalated sparring, other repositories, Commerce friction,
design-contract changes, the VTID allocator and product autonomy stay exactly as `vitana-owner-autonomy.md` lists them.

## 2. Today (read-only evidence, `origin/main` 34baeb8fe3, 2026-10-28 ~11:50Z)
### 2.1 Contradictions in the rule set (each side cited; newest owner decision wins in §4)
| # | Topic | Side A | Side B (newer) |
|---|---|---|---|
| C1 | Production path | collaboration.md:175, :223, :257 "production only by PUBLISH"; common-rules rule 6 opens "Never … deploy to production"; DEPLOYMENT-PIPELINE.md:233-237 names only Operator Chat and Claude Code | collaboration.md §7c (2026-10-22) owner-commanded Kiro publish |
| C2 | Gate 2 channel | CLAUDE.md rule 49 "two channels only … the Claude Code session"; v1 CLAUDE.md:168; DEPLOYMENT-PIPELINE.md:11-13, :341-342 | collaboration.md §7 (PM to Operator Chat), driver.md step 8 (interactive Kiro driver) |
| C3 | Post-merge watch | CLAUDE.md:61-64, v1 CLAUDE.md:86-88, SKILL.md:70 `send_later`, 2 h cap, "never sleep-polls" | driver.md step 10, common-rules rule 10 (poll 2-3 min, 24/7 driver); Kiro Web has no `send_later` |
| C4 | Who signs acceptance | automations exafyltd.md:43-44, :132-141 (+ exafy, jtadic) seat `review: approve` without agent trailers; routine-prompt.md:28-30; governance.ts:159-170 legacy seat approve | collaboration.md §7 / lane-review.md:5-6 reviewer agent only (2026-10-20/21) |
| C5 | `reviewer_seat` | collaboration.md:57 "legacy, optional" | planning.md:39-41 "required on every executor: kiro lane"; governance.ts:13 |
| C6 | Protected-file unlock | collaboration.md:131-132, §7b, CLAUDE.md:82-83, owner-autonomy stop 3: "Claude review **or owner instruction**" | governance.ts `governanceMergeAllowed` (~:186-190) unlocks only a legacy Claude review; v1 CLAUDE.md:108 "owner review on the current head" |
| C7 | `executor: claude` lanes while Claude is unavailable | collaboration.md:187-188, :219-221 → exceptions seat | exceptions seat is an automation; exafyltd.md:56, driver.md:88-89 "an automation run never builds them"; queue.mjs:679-686 lets only Claude Code change lane `seat`/`paths`. Result: no actor can build such a lane (observed today: pm-reassign-idempotent/reassign-noop, seat `exafy`, paths missing `types.ts` accepted in its round 2; Lane scope fails a jtadic build on `seat` and `paths`) |
| C8 | Unattended end point | driver.md:88-89, automations W.3 "carries lanes up to verified, never merges" | owner-autonomy.md:6-12 (2026-10-27) default end point STAGING-VERIFY for every session "including seat automations" |
| C9 | Workflow dispatch | automations step 1 "never dispatches a workflow", re-run allowlist attempt 1 only; driver.md step 3 cites a "§7a re-run allowlist" that §7a no longer has; lane-land.md:44-45 | collaboration.md §7d (2026-10-23) any Kiro session dispatches staging/verification/CI and re-runs at any attempt |
| C10 | Stale-claim timers | collaboration.md §5 24 h; routine-prompt.md:23 48 h | collaboration.md §8 2 h/4 h without a driver |
| C11 | Owner stop list | collaboration.md:202-206, README.md:26, hooks/vitana-pipeline-start.json, common-rules rule 5 ("exactly one question"), driver.md:9-11, CLAUDE.md contract (a)-(d) | owner-autonomy.md:37-53 13-row table (2026-10-27) |
| C12 | "Stop and ask when in doubt" | v1 CLAUDE.md:30, CLAUDE.md IF-THEN 9, NEVER 34 (read literally) | owner-autonomy.md:56-65 reading (live writes only; product autonomy only) lives only in a steering file |
| C13 | Gate 1 / policy approval | v1 CLAUDE.md:46-57, :187; SKILL.md:11 owner Gate 1 only | CLAUDE.md:34-38 (2026-10-14) policy approval `converged-auto-v1` |
| C14 | Reviewer chain order | driver step 4 "in order" | lane-review.md:24-27 race `joinPolicy: any`; lane-code.md:70, planning.md:38 hardcode sonnet-5.5 as reviewer; all-fail end state differs (lane-land.md:26 parks, lane-review.md:28-33 does not) |
| C15 | Automation schedule | collaboration.md:323 "weekdays hourly"; routine-prompt.md:7 `7,12,17 * * 1-5` | automations "hourly every day (`0 * * * *`)" |
| C16 | Source-of-truth claims | CLAUDE.md:76 (§7-§7b), v1 CLAUDE.md:102 (§3a/§7-§7b), kiro-notes:14 (§7-§7d), pipeline/README.md:3, standing-rules, DEPLOYMENT-PIPELINE.md:3 "stricter wins" | — nine files each claim authority over overlapping parts |
| C17 | Load scope | `collaboration.md` is path-scoped (`.kiro/specs/**`) for Claude Code and fileMatch for Kiro, so §7-§8b is not loaded unless a spec is touched; `kiro-web-steering.mjs` DRIVER_LINKS inlines driver/common-rules/planning only, not lane-review/lane-land | — |

### 2.2 Review independence (code)
- The builder's pipeline session mints `agent-vitana-lane-reviewer-…` (`queue.mjs` `sessionId`, ~:907-913) and commits
  the entry; Lane scope checks only `agentOf(session) === reviewer_seat` (`queue.mjs:705-713`); it never compares the
  review session with the PR's builder sessions, never checks verdict/head/`Collab-Reviewer`, and allows a review
  commit to change other files.
- `land-guard.mjs` `review`/`merge` take `--reviewed-head` from the caller (:178-205) and never read the entry.
- PM: `observe-live.ts:425-431` builds the executing log from lane-log headers only; `decide.ts:181-183` compares only
  against those. No requester is recorded anywhere. The agent file says the *caller* must not be in the executing log
  (`vitana-lane-reviewer.md:43-44`) while collaboration.md:89/:192 say the calling session commits the entry.
- Head rule differs: `land-guard.reviewCurrent` (:41-56) tolerates any lane-file-only commit (no trailer needed) and
  `pm-agent` handoff edits; `observe-live.reviewOnlySince` (:221-236) tolerates only review-trailer commits on exactly
  the lane file. Both invalidate on every merge of `main` (no test covers merges or `files.length===0`).
- Fallback after all three chain models fail: driver parks; Kiro IDE recipe leaves `done:false`; no retry; the
  independent-model fallback is lane `pipeline-agent-wake-and-review/reviewer-fallback` (ready, `executor: claude`).

### 2.3 Durable progress
- State is git only: lane files, `handoff.md`, claims `refs/heads/collab-claim/*`, heartbeat `refs/heads/collab-driver/*`
  (`plan-driver.mjs` ~:70-95). Pending checks, blockers, decisions and the next action are not recorded: `next`
  recomputes them; blockers/decisions live in the uncommitted RUN folder and die with a Kiro Web sandbox; the
  fix-forward count is inferred from log headings (`fixForwardCount`), so a crash between push and log under-counts.
- Wake-ups: a live driver polls; else hourly seat automations (one item per run); Kiro IDE SessionStart hook. No
  event-driven wake on `main`; `DRIVER-WAKE.yml` is open in #4448 and needs a `KIRO_API_KEY` secret (owner setup).
- 24 `collab-driver/*` refs exist; at 11:50Z only `step-order-gate` was alive (< 45 min).

### 2.4 CI congestion
- PM writer: `writers.ts:42-62` always bumps `updated:` and appends a log entry; `:91-117` always PUTs (one commit per
  tick, 2 min). Commits on bookkeeping PRs: #4333 8,118; #4290 5,221; #4267 3,794; #4244 2,545; #4249 1,069;
  #4370 868. `decide.ts:244-260` stale-ready changes `seat`; on a `pm-agent` bookkeeping PR the Lane scope PERM rule
  (`queue.mjs:678-684`: a change of `executor`/`seat`/`reviewer_seat`/`paths` is refused unless every session is a
  Claude `session_…`, and `pm-agent` commits are excluded from that set) rejects it before the `seat == reviewer_seat`
  check at `queue.mjs:227` is reached, so the PR never merges and the decision repeats every tick (sparring R1-F3).
- Deploy restores it: `AWS-STAGE-DEPLOY-GATEWAY.yml:1225-1226` upserts `PM_AGENT_ENABLED="true"`, `PM_MODE="live"`.
  Staging today: task def `vitana-gateway:967`, `PM_AGENT_ENABLED=false`, `PM_MODE=live`, `CLAUDE_AVAILABLE=false`
  (read-only `aws ecs describe-task-definition`). Last staging gateway deploy 2026-10-28T08:37 failed, so the next
  successful one turns the unfixed PM back on. Any gateway merge (#4421, #4424, #4445 are green) triggers it.
- The fix is planned but stuck: `pm-reassign-idempotent/reassign-noop` (VTID-05363, C7 deadlock).
- Current load: 1,000 runs in 1 h 44 min (~575/h, 10:04-11:49Z), 0 on `pm-agent/*`. Top emitters
  PHASE-2B-NAMING-ENFORCEMENT 131, Dev Autopilot Impact Scan 131, ENFORCE-FRONTEND-CANONICAL-SOURCE 107 (no superseded-run
  cancel), unit 106, Phase 2B Doc Gate 106, PR-GATE 105. 63 `action_required`, 117 failures. No alert for run volume,
  queue time, identical commits or rate-limit headroom exists (`ALERT-*.yml` cover product signals only).

## 3. Existing improvement work — inventory, owner, disposition (ask 6)
Owner = the session in the newest lane-log/commit trailer. "Owner keeps" = this plan does not touch its files and
lists it as a prerequisite where it depends on it. Inventory taken 2026-10-28 ~11:55Z.
| Plan / PR | State | Owner (session) | Overlap with this plan | Disposition |
|---|---|---|---|---|
| pm-reassign-idempotent / reassign-noop (VTID-05363) | ready, deadlocked (C7) | kiro-exafyltd-202610220833-d231 (claim 24 h stale, driver heartbeat stale) | ask 4 | **Superseded by lane `pm-noop`** (same converged spec + its round-2 notes, seat jtadic, `types.ts` in paths). On `pm-noop` merge its lane is parked `superseded` by the driver of this plan. |
| pm-ci-load / pm-app-token #4421 (VTID-05352) | accepted, green | kiro-exafyltd-202610271503-9458 | ask 4 | Owner keeps; **must merge after `pm-noop`** (its plan §3 item 6; it deploys gateway). |
| pipeline-agent-wake-and-review #4448 driver-wake (VTID-05354), #4445 review-fallback-trailer (VTID-05356), lanes reviewer-fallback (VTID-05357), plan-pr-merge (VTID-05355), v1-collab-sync (VTID-05358) | executing / ready | kiro-exafyltd-202610271503-9458 | asks 2, 3 | Owner keeps. This plan relies on DRIVER-WAKE (ask 3) and on `reviewer-fallback` (ask 2) and does not edit their files. #4445 deploys gateway → after `pm-noop`. |
| pipeline-lane-state-efficiency #4416 chain-transitions (VTID-05351) | in-review, `changes` on an older head, protected (`queue.mjs`) | kiro-exafyltd-202610271503-9458 | ask 4 (closing-record PR churn) | Owner keeps; protected-file stop. `review-independence` edits `queue.mjs` after it (hot-file sequencing, §6). |
| plan-spar-stuck-session #4424 (VTID-05350) | executing, green, protected | kiro-exafyltd-202610280842-889c | — | Owner keeps; deploys gateway → after `pm-noop`. |
| collab-multi-builder-handoff #4377 (VTID-05331) | executing, green, `queue.mjs` | exafyltd seat | C7 (seat rules) | Owner keeps; `review-independence` edits `queue.mjs` after it. |
| collab-owner-publish #4369 (platform), vitana-v1 #1494 | lane-less, green | unknown (no trailer) | C1 | **Absorbed** into `policy-text` (§7c wording is the same); the two PRs are closed with a link when `policy-text` merges, unless they merge first, in which case `policy-text` rebases onto them. |
| quality-checks (VTID-05346/47/48) #4407, #4408, v1 #1503, closing #4457 | in-review / executing | kiro-jtadic-202610271220-68a5 (live) | `.kiro/pipeline/{planning,lane-code,lane-review,lane-land}.md` (#4407) | Owner keeps; `policy-text` edits those files only after #4407 merges. |
| quality-checks-followup #4454 (plan, sparring round 1) lanes merge-policy-text, steering-quality-checks, reviewer-requester-rule | drafted | kiro-jtadic-202610271220-68a5 (live) | asks 1, 2 | Owner keeps. `reviewer-requester-rule` (agent text: the builder may request) is the agent-file half of ask 2; `review-independence` is the code half and never edits `.kiro/agents/vitana-lane-reviewer.md`. `merge-policy-text` edits collaboration.md §7b wording: `policy-text` edits §7 lists only and merges after it if it lands first (hot file). |
| ci-push-to-result #4409 (plan, round 1 unanswered, driver heartbeat 22 h old) | drafted | kiro-jtadic-202610271219-d5d7 | ask 4 (concurrency on ENFORCE-FRONTEND-CANONICAL-SOURCE, PHASE-2B-NAMING-ENFORCEMENT) | **Concurrency part absorbed** into `ci-activity-guard`; the owner (or a driver takeover) drops it from `platform-gate-install` in its round-1 answer. |
| kiro-web-reliability #4392 (VTID-05360/61, converged on its PR) | approved, plan PR open | kiro-exafy-202610271051-d636 | ask 3 (`kiro-web-session.mjs`, `preflight.mjs`) | Owner keeps; this plan does not edit `preflight.mjs` or `kiro-web-session.mjs`. |
| collab-handoff-check-fix (VTID-05364/65) program-registry, validator-fix | ready | kiro-hotmail-202610281000-73d4 | ask 4 (registry, validator spawns) | Owner keeps; prerequisite for green Collab handoff on big PRs. |
| ci-github-modernization (VTID-05301..08) #4290 | 6 lanes parked/ready | kiro-202610211348-9f71 et al. | ask 4 (`ci-health`) | Owner keeps; `ci-activity-guard` is the alerting part `ci-health` lacks and names it in its doc. |
| reviewer-agent-reliability #4243, plan-spar-retry-invalid #4215, retire-claude-code #4210 (VTID-05259), kiro-autonomy-fallback (8 lanes parked), reviewer-model-fallback, sparring-floor-retry, kaf-fallback-env | stale (5-8 days), parked or outdated | various, no live session | asks 1, 2 | Not built by this plan. `policy-text` records them as superseded-or-stale in `docs/collab/operating-policy-inventory.md` so a later session parks them with one closing record each; nothing is deleted. |
| PM bookkeeping PRs #4333, #4290, #4267, #4263, #4249, #4244, #4341, #4356, #4370, #4328 | open, thousands of loop commits | pm-agent | ask 4 | Left open and unmerged (their loop entries must never reach `main`); closed by the driver of this plan after `pm-noop` is verified on staging, each with a comment. Closing a PR is reversible. |

## 4. The consolidated policy (ask 1)
One file is the authority for *who may do what, when to stop, and the end point*; every other file keeps only its
mechanics and points to it. Precedence, highest first: (1) the owner's explicit instruction in the conversation, for
what it names; (2) `.claude/rules/operating-policy.md` (identical in both repos; Kiro twin
`.kiro/steering/vitana-operating-policy.md` links it, `inclusion: always`); (3) the mechanics files
(`collaboration.md` §2-§9, CLAUDE.md Part 1 rules, `DEPLOYMENT-PIPELINE.md`); (4) runbooks (`.kiro/pipeline/*`,
automations, hooks, `routine-prompt.md`). A lower file that disagrees with a higher one is a bug fixed by a PR, and
CI (`policy-consistency.test.mjs`) fails on the known contradiction phrases of §2.1. `operating-policy.md` has no
`paths:` front matter, so Claude Code always loads it; it stays under 9 KB so the Kiro always-included budget does
not grow beyond today's size (it replaces `vitana-owner-autonomy.md`, 7.6 KB, which becomes a one-line pointer).

Content of `operating-policy.md` (text written in lane `policy-text`):
1. **Outcome.** Commit tasks run to STAGING-VERIFY passed on the merge commit (deploy-nothing: merged green with
   closing records); other tasks to the evidenced answer, read-only; an owner-named end point replaces the default.
   The same for interactive sessions, seat automations, automation-started drivers and Claude Code (resolves C8).
2. **Routine steps are never asked** (the current owner-autonomy list, unchanged).
3. **The stop table** (the current 13 rows, unchanged wording; resolves C11) and the five-part stop message.
4. **Readings** of the broad sentences (v1 "when in doubt", NEVER 34, IF-THEN 9, "PR reviewed + approved"),
   moved here from owner-autonomy (C12).
5. **Actors** (resolves C4, C5, C7, C14): planner (any agent), builder (the lane's seat), **review requester (the
   builder or driver)**, **reviewer (the reviewer agent only, independent per §5)**, merger (PM, else any driver,
   interactive or automation-started, under §7b), Gate 2 sender (the session that merged — any agent — and the PM to
   Operator Chat; resolves C2), publisher (owner PUBLISH, or a Kiro/Claude session on the owner's explicit command,
   §7c; never unattended; resolves C1). `reviewer_seat` is legacy; a seat `review: approve` is not an acceptance.
   An `executor: claude` lane while Claude is unavailable is built by an **interactive** session of the lane's seat or
   of the exceptions seat; an automation never builds it; its protected files still wait for the §3a review.
6. **Unattended runs** (automation-started drivers, DRIVER-WAKE sessions): may build non-governance lanes, request
   reviews, merge under §7b when no protected or governance file is in the PR, dispatch staging/verification/CI and
   re-runs (§7d, resolves C9), and watch STAGING-VERIFY; never publish, never apply a migration, never merge a
   governance or protected-file PR. This is a **governance change** (today they stop at `verified`): it is listed in
   the PR body of `policy-text` as a decision this plan's sparring reviews; it adds no new write path (the merge is the
   same §7b mechanical rule an interactive driver applies).
7. **Waiting** (resolves C3): no agent sleep-polls beyond a bounded wait (`kiro-web-session.mjs wait`, ≤ 30 min);
   before ending, the session writes the durable driver record (§6) so DRIVER-WAKE, a seat automation or any later
   session resumes. `send_later` is a Claude Code convenience, not a requirement.
8. **Timers** (resolves C10, C15): stale claim 24 h (§5); PM reassignment 2 h / claim break 4 h without a live driver;
   automations hourly every day.
9. **Proportional path** (ask 5, §8 below).
10. **Precedence** and the single-source rule above (resolves C16, C17).

The authority itself is reviewed like a protected file from its first version (R1-F1): `policy-text` and
`policy-text-v1` merge only with the §3a review (a merge precondition of this plan, applied by its driver and stated
in their acceptance, until the list update makes it mechanical) — a Claude review on the current head
or an owner instruction naming `operating-workflow` — and `review-independence` then puts both files on the
protected list. One owner instruction naming this plan covers every protected lane of it.

Protected parts (`CLAUDE.md` in both repos): the Autonomy Contract, the collaboration paragraph, rule 49 and the
`send_later` paragraph become pointers to `operating-policy.md`, keeping every absolute (no production testing,
production-safety, IF-THEN 26 scoping) verbatim. Lane `policy-claude-md`; it never merges on an agent accept
(stop 3); the owner (or a Claude review) is asked once, naming this plan, with the diff.

## 5. Review independence, fixed centrally (ask 2)
One pure module `scripts/collab/review-rule.mjs` decides whether a review entry counts; `queue.mjs` scope-check and
`land-guard.mjs` import it, the PM mirrors it in `governance.ts` (+ `observe-live.ts`) with a parity test, the way
`PROTECTED_GATE_GLOBS` is mirrored today. The lane adds to `protected-gate-files.json` (and to both compiled-in
copies, with the parity test): `scripts/collab/review-rule.mjs`, `scripts/collab/land-guard.mjs` (its merge-time
caller, R1-F2), `.claude/rules/operating-policy.md` and `.kiro/steering/vitana-operating-policy.md` (the authority,
R1-F1). vitana-v1's PR-GATE fetches `queue.mjs` and the list from vitana-platform `main`
(`vitana-v1/.github/workflows/PR-GATE.yml:81-91`), so the same relative globs protect the v1 copies.
- **Requester.** A review entry carries `Collab-Review-Requested-By: <session>`; the requester may be the builder or the
  driver. The entry's `Collab-Session` (the reviewer) must be an `agent-vitana-lane-reviewer-…` id, must differ from
  the requester, and must not appear as `Collab-Session` on any `Collab-Lane: <slug>/<lane>` commit of the PR nor in
  the lane's executing log. `Collab-Reviewer` must be the agent with a chain model; `Collab-Verdict` `accept|changes`.
- **Provenance.** The review commit changes only the lane file plus the verbatim reviewer output
  `docs/validation/<VTID>/reviews/<head7>-<model>.md`, and carries `Collab-Review-Digest: sha256:<hex>` of that file;
  scope-check recomputes the digest and checks that the file's verdict JSON (`head_sha`, `verdict`, `model`) equals the
  trailers. **Limitation, documented in the policy:** an in-session sub-agent's output cannot be proven
  cryptographically to come from the agent (Kiro Web exposes no signed agent identity); the record makes a forged
  entry visible and auditable, and the rule makes the builder unable to review under its own id. A CI-run reviewer
  with its own GitHub identity is the only stronger form and is out of scope (§11).
- **Current head and invalidation.** One rule in `review-rule.mjs`, used by land-guard and mirrored by the PM: the
  entry counts for the PR head when `Collab-Reviewed-Head` is the head, or every later commit is (a) a review-only
  commit on the lane file, (b) a `pm-agent` lane-state commit (lane file or `handoff.md`), or (c) a merge commit whose
  first parent is the previous head and whose second parent is on `origin/main`, **and** the PR's own change is
  unchanged: `git diff <merge-base> <commit>` restricted to the lane's `paths` minus lane files has the same
  `git patch-id --stable` as at the reviewed head. Anything else, including a conflict resolution inside the lane's
  paths or an empty file list, invalidates the accept. `land-guard.mjs review|merge` reads the newest review entry
  from the PR's commits itself; `--reviewed-head` becomes an assertion that must match it.
- **Fallback.** Chain models in order per head (each once); all three failed → the driver records
  `Collab-Blocker: review_unavailable` (§6) and the durable record schedules **one** retry cycle after ≥ 30 min (any
  later wake resumes it); a second all-fail cycle parks the lane with the five-part message. The independent-model
  fallback (`reviewer-fallback`, other plan) plugs in as a fourth step when it lands. Never a builder accept.
- The reviewer agent file text (the caller may be the builder; independence keyed on the reviewer session) is
  `quality-checks-followup/reviewer-requester-rule`; this plan does not edit `.kiro/agents/vitana-lane-reviewer.md`.

## 6. Durable progress and safe resume (ask 3)
- **Driver record in the heartbeat commit** (no tree change, so no workflow triggers): trailers `Collab-Next:
  <action> <lane>`, `Collab-Pending: <check|review|deploy|verify> <ref>` (repeatable), `Collab-Blocker: <code> <ref>`
  (repeatable), `Collab-Intent: <id> <action> <lane> <head>` and `Collab-Done: <id>`. `plan-driver.mjs heartbeat`
  takes `--next/--pending/--blocker/--intent/--done`; `plan-driver.mjs status --slug` prints the last record;
  `plan-driver.mjs resume --slug` lists open intents with their observed effect.
- **Idempotency.** Every side-effecting action (push, open PR, review entry, merge, dispatch, closing record) is
  written as an intent before it runs and marked done after; on resume an open intent is reconciled from GitHub
  first (branch at the expected sha → push done; PR for the branch exists → open done; PR merged → merge done; run for
  the sha exists → dispatch done; review entry for the head exists → review done) and is never repeated blindly.
  `planNext` skips a lane with an open, unreconciled intent. Fix-forward attempts are counted from `fix_forward`
  intents (written before the push), not from log headings.
- **Blockers survive the sandbox**: `Collab-Blocker` replaces the RUN folder `blockers.md` as the record (the RUN
  folder stays a cache).
- **Wake-ups**: DRIVER-WAKE (#4448, other plan) for PLAN-SPAR results and review pushes; this plan asks its owner to
  add `workflow_run` completion of PR-GATE / unit / STAGING-VERIFY on `kiro/**` heads (comment on #4448) — not edited
  here. Floor: hourly seat automations (item W) using the same `resume`.
- **Platform limitations (documented in `docs/kiro/unattended-continuation.md`)**: Kiro Web has no `send_later` and
  no background continuation after a session ends; an automation run is time-boxed and hourly at most; Kiro Web runs
  only the first hook per file and never shows PostToolUse output; DRIVER-WAKE is a no-op until the owner adds the
  `KIRO_API_KEY` repository secret (an owner setup step, not a session action); between wakes nothing advances
  except CI and the PM. Expected worst-case idle after a CI result: ≤ 60 min with automations only, minutes with
  DRIVER-WAKE.

## 7. CI congestion (ask 4)
- **`pm-noop`**: the converged pm-reassign-idempotent spec (writer no-op guard on W1/W2 and `writeFile`,
  `'written'|'noop'`, `unchanged` status) with one correction from R1-F3: the PM never writes a lane permission key —
  `applyLaneChange` throws on any change of `seat`, `executor`, `reviewer_seat` or `paths`, and `decide.ts`
  stale-ready makes no decision when its target would change `seat` (the `claude` target, which keeps the seat,
  remains; the stale lane stays visible on the queue); `AWS-STAGE-DEPLOY-GATEWAY.yml:1225` → `"false"` so a deploy can never turn the PM on), plus
  one guard: `writeFile` (timings.json) skips the PUT when the text is unchanged. Re-enabling the PM stays an owner
  decision (stop 13 reading: it is an autonomy level of a loop).
- **Merge order**: `pm-noop` merges before any other gateway PR in §3 (#4421, #4424, #4445); the driver comments that
  order on those PRs.
- **`ci-activity-guard`**: `scripts/ci/ci-activity.mjs` (read-only GitHub GETs) computes, for the last 60 min: runs per
  workflow and per branch, queued count and p50/p95 queue time (`run_started_at − created_at`), share of
  `action_required`, PRs with > 200 commits or > 20 commits/h by one author whose diffs repeat (identical patch-id
  within 1 h = no-op writes), and core rate-limit headroom; thresholds in `scripts/ci/ci-activity.json` (start: > 400
  runs/h, one branch > 40 runs/h, p95 queue > 10 min, > 20 identical commits/h, headroom < 1,000). Workflow
  `.github/workflows/ALERT-CI-ACTIVITY.yml` (cron `*/30`, `workflow_dispatch`, `permissions: actions: read, contents:
  read, pull-requests: read`, concurrency group, no writes) prints the table to the job summary and fails red above a
  threshold. It also adds superseded-run cancel (`concurrency: <wf>-${{ github.event.pull_request.number ||
  github.ref }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`) to
  `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` and `PHASE-2B-NAMING-ENFORCEMENT.yml` (from ci-push-to-result; push runs on
  `main` are never cancelled).
- Registry and validator spawns: collab-handoff-check-fix (owner keeps).

## 8. Proportional path (ask 5)
`change_class: light` already exists (PLAN-SPAR passes it to the partner). The policy defines eligibility and what is
kept, and `scripts/collab/change-class.mjs --base origin/main --head HEAD` reports the class a diff qualifies for and
why. **Light eligible** only when all hold: one lane, ≤ 3 files outside `docs/validation/**`, no protected or
governance path, no migration, no `AWS-PROD-*`/deploy workflow, no UI route/screen registry, design-contract,
Commerce supplier, i18n catalog or spoken-wording path, no new dependency. **Kept for light**: sparring (CI, the
partner's minimum passes unchanged — CLAUDE.md rule 52), CI-allocated VTID, red→green test, every required check,
reviewer agent accept on the current head, §7b merge, STAGING-VERIFY when it deploys. **Cut for light** (overhead
only): no fan-out, one closing record carrying the whole transition chain (needs #4416), plan PR merge and lane
claim in one driver step, one chain model unless it is unavailable. Any reduction of an existing requirement (for
example fewer sparring passes, or no STAGING-VERIFY for test-only gateway changes) is **not** made here: it is listed
in `operating-policy.md` §9 as an open proposal for the owner and goes through its own sparred plan.

## 9. Lanes (all seat `jtadic`, repo vitana-platform unless noted)
| Lane | Executor / reviewer | Files (paths) | depends_on | Deploys |
|---|---|---|---|---|
| `pm-noop` | kiro, reviewer_seat agent | `services/gateway/src/services/project-manager/{decide,act,writers,types}.ts`, `services/gateway/test/project-manager/**`, `services/gateway/test/kaf-staging-claude-available-wiring.test.ts`, `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`, `docs/validation/VTID-*/**` | — | gateway → staging |
| `ci-activity-guard` | kiro, reviewer_seat agent | `scripts/ci/ci-activity.mjs`, `scripts/ci/ci-activity.json`, `scripts/ci/ci-activity.test.mjs`, `.github/workflows/ALERT-CI-ACTIVITY.yml`, `.github/workflows/ENFORCE-FRONTEND-CANONICAL-SOURCE.yml`, `.github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml`, `docs/ci/ci-activity.md`, `docs/validation/VTID-*/**` | — | none |
| `policy-text` | kiro, reviewer_seat agent; merges only with the §3a review (authority file, R1-F1) | `.claude/rules/operating-policy.md` (new), `.kiro/steering/vitana-operating-policy.md` (new), `.kiro/steering/{vitana-owner-autonomy,vitana-pipeline,vitana-kiro-notes,vitana-load-project-rules}.md`, `.claude/rules/collaboration.md` (§3a note, §7 lists, §8 schedule only), `.kiro/pipeline/{README,lane-review,lane-land,lane-code,planning}.md`, `.kiro/hooks/vitana-pipeline-start.json`, `.kiro/automations/*.md`, `scripts/collab/routine-prompt.md`, `scripts/collab/kiro-web-steering.mjs` (+ its test), `scripts/collab/policy-consistency.test.mjs` (new), `docs/DEPLOYMENT-PIPELINE.md`, `docs/collab/operating-policy-inventory.md` (new), `docs/kiro/unattended-continuation.md` (new), `docs/validation/VTID-*/**` | — (merges after quality-checks/pipeline-quality #4407, which edits the same `.kiro/pipeline/*` files) | none |
| `policy-text-v1` | kiro, reviewer_seat agent; merges only with the §3a review (R1-F1); repo vitana-v1 | `.claude/rules/operating-policy.md`, `.kiro/steering/vitana-operating-policy.md`, `.kiro/steering/{vitana-owner-autonomy,vitana-pipeline,vitana-kiro-notes,vitana-load-project-rules}.md`, `.claude/rules/collaboration.md` (byte-identical copies of the platform files), `docs/validation/VTID-*/**` | `policy-text` | none |
| `policy-claude-md` | claude (protected), reviewer agent + §3a review | `CLAUDE.md`, `.claude/skills/plan-sparring/SKILL.md`, `docs/validation/VTID-*/**` | `policy-text` | none |
| `policy-claude-md-v1` | claude (protected), reviewer agent + §3a review; repo vitana-v1 | `CLAUDE.md`, `docs/validation/VTID-*/**` | `policy-text-v1` | none |
| `review-independence` | claude (protected), reviewer agent + §3a review | `scripts/collab/review-rule.mjs` (new) + test, `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, `scripts/collab/land-guard.mjs`, `scripts/collab/land-guard.test.mjs`, `scripts/collab/store-review.cjs` (+ test), `scripts/collab/protected-gate-files.json`, `services/gateway/src/services/project-manager/{governance,observe-live,decide}.ts`, `services/gateway/test/project-manager/{governance,observe-live,decide,review-rule-parity}.test.ts`, `docs/validation/VTID-*/**` | `pm-noop` (both edit `decide.ts`) | gateway → staging |
| `durable-driver` | kiro, reviewer_seat agent | `scripts/collab/plan-driver.mjs`, `scripts/collab/plan-driver.test.mjs`, `.kiro/pipeline/driver.md`, `.kiro/pipeline/common-rules.md`, `docs/validation/VTID-*/**` | `policy-text` | none |
| `change-class` | kiro, reviewer_seat agent | `scripts/collab/change-class.mjs` (new), `scripts/collab/change-class.test.mjs`, `docs/validation/VTID-*/**` | — | none |
| `workflow-validation` | kiro, reviewer_seat agent | `scripts/collab/workflow-metrics.mjs` (new), `scripts/collab/workflow-metrics.test.mjs`, `docs/validation/VTID-*/**` | `pm-noop`, `ci-activity-guard`, `policy-text`, `durable-driver`, `change-class` (the protected lanes are measured where they stand: built and accepted, waiting for the §3a review) | none |

Shared/hot files: `collaboration.md` only in `policy-text`; `CLAUDE.md` only in `policy-claude-md`; `queue.mjs` only in
`review-independence`, after #4377 and #4416 (other plans) are merged or parked (the driver checks before claiming);
`decide.ts` sequenced `pm-noop` → `review-independence`; `driver.md`/`common-rules.md` only in `durable-driver`. No two
lanes edit the same file.

## 10. Tests and validation (ask "validate … measure")
- Every lane: new tests red on base, green on head, recorded in `docs/validation/<VTID>/commands.log`.
  - `pm-noop`: `reassign-idempotent.test.ts`, `reassign-seat.test.ts`, wiring assertion `PM_AGENT_ENABLED "false"`
    (the converged spec's tests) + `writeFile` unchanged-text test.
  - `ci-activity-guard`: fixture-driven test of thresholds, no-op detection by patch-id, queue-time percentiles; a
    workflow-shape test (cron, read-only permissions, no `secrets.` other than `GITHUB_TOKEN`).
  - `policy-text`: `policy-consistency.test.mjs` fails on base for each §2.1 phrase still present; `kiro-web-steering
    --check` green; v1 and platform copies byte-identical.
  - `review-independence`: requester = reviewer → refused; reviewer session on a `Collab-Lane` commit → refused; review
    commit touching another file → refused; digest mismatch → refused; merge-of-main with unchanged patch-id → still
    current; conflict resolution in lane paths → stale; empty commit → stale; parity test PM ↔ script.
  - `durable-driver`: intent written → crash → resume reconciles from a fake GitHub (pushed / PR open / merged) and
    performs nothing twice; fix-forward count from intents; `status` prints next/pending/blockers.
  - `change-class`: fixtures for each exclusion.
- Staging: `pm-noop` and `review-independence` deploy the gateway: `docs/validation/<VTID>/staging-tests.json`
  (`kind: existing`, the jest suites) and STAGING-VERIFY on the merge commit; read-only post-check that the staging
  task definition keeps `PM_AGENT_ENABLED=false`.
- **Workflow validation (`workflow-validation`)**: `workflow-metrics.mjs --slug <slug>` computes from GitHub and git
  only (GETs): total completion (plan PR opened → STAGING-VERIFY passed on the last merge, or → last merge for
  deploy-nothing), queue time (sum and p95 of `run_started_at − created_at` over the plan's PR runs), retries (runs with
  `run_attempt > 1`, fix-forward intents, review cycles), regressions (failed required checks on `main` within 24 h
  after a lane merge whose failing job touches the lane's paths, and revert commits), owner interventions (owner
  messages recorded as `authority: owner instruction`, five-part stops, owner-authored commits/comments on the plan's
  PRs). Representative real tasks = this plan's own lanes: a gateway code change with staging deploy (`pm-noop`), a
  CI workflow change (`ci-activity-guard`), a cross-repo governance text change (`policy-text`) and a protected-file
  change that must stop at the §3a review (`policy-claude-md`), plus one light task (`change-class`). **Interruption
  drill**: the driver session of this plan ends after an intent is written and before its `done` (a push or a merge);
  a new session (or DRIVER-WAKE/automation) takes over after 45 min and resumes from `plan-driver.mjs resume` without
  a duplicate push, PR, review entry or merge (evidence: git and PR history). Report
  `docs/validation/<plan VTID>/workflow-validation.md` + `timings.json` (§8b) quoted at Gate 2.

## 11. Risks and out of scope
- Risk: an unattended merge (§4 item 6) lands a broken lane → same §7b checks as an interactive merge, serialized
  landing, STAGING-VERIFY fix-forward; governance/protected PRs excluded.
- Risk: the policy file drifts from the mechanics → `policy-consistency.test.mjs` in the Collab tests.
- Risk: the head rule's merge tolerance accepts a semantically different result after a `main` merge with an unchanged
  patch → the PR's required checks re-run on the new head and must be green (§7b), so behaviour is still tested.
- Out of scope: a CI-run reviewer with its own identity; re-enabling the PM; closing or deleting other plans' lanes
  (only recorded); changing sparring passes, STAGING-VERIFY or any stop; secrets and repository settings
  (`KIRO_API_KEY` is an owner setup step).
<!-- plan:end -->
