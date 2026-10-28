---
change_class: standard
---
# plan(kiro-autonomy-fallback): Claude Code optional; Kiro runs the pipeline end to end; the waits removed
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610201618-c018`. Spans `exafyltd/vitana-platform` (all code)
and `exafyltd/vitana-v1` (lane `steering-rules` mirrors the rule text only). Premises are pinned to
`exafyltd/vitana-platform@e6ed415a9` (no diff to `origin/main` `1acb6b92d` in any file named below) and
`exafyltd/vitana-v1@996bfaf1d`. Detail per lane: `tasks.md`; lane files: `lanes/*.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-20 (Kiro IDE session): *"the process must be built so that Claude is optional, but if Claude is not
available like the last couple of days, the process must be automated with Kiro executing the full pipeline without
Claude"*; *"no more approvals, you run it end to end"*. Final scope approved by the owner with "execute".
1. **Claude optional.** When Claude Code is unavailable (§3) Kiro runs every step: `plan(` PR → CI PLAN-SPAR (partner
   chain unchanged: Bedrock Opus 4.6 → Sonnet 4.6 → DeepSeek) → **CI allocates fresh VTIDs** (never Kiro by hand) →
   Kiro builds → the reviewer agent `vitana-lane-reviewer` (Kiro custom agent, model `claude-sonnet-5.5`, read-only)
   accepts → the Project Manager (or Kiro under the same rule while the PM is not `live`) merges to `main` (staging
   only) → staging auto-deploy → STAGING-VERIFY → Gate 2 *"Staging verified — ready for deployment to production?"*.
   Production stays the owner's PUBLISH.
2. **The waits removed.** One continuous driver per approved plan (24/7), parallel lanes by default, PM ticks every
   2 min, no 24 h/48 h idle timers while nobody drives, plan( PR auto-merge, VTID retry, Jest sharding.
3. **Default for every future session.** Any fresh Kiro IDE or Kiro Web session given an owner task runs this pipeline
   with no approval stops (committed runbooks, IDE workflow recipe, Kiro Web driver, always-included steering).
4. **Measured.** Every plan writes `docs/validation/<VTID>/timings.json` (§4.6) and Gate 2 quotes it.

## 2. Today (verified, file:line)
1. The PM never acts. `services/gateway/src/index.ts:1877-1897` runs only `pm.runDecideTick()` ("dry_run — no act")
   although staging pins `PM_MODE=live` (`.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1220-1221`);
   `project-manager/observe.ts:35-44` `StubObserver` returns `{lanes: [], rotations: []}`; `lease.ts:43-52`
   `NoLeaseManager`; `act.ts:79-111` `LaneFileWriter`/`Gate2Poster`/`Gate2EvidenceResolver` have no implementation;
   `runActTick` (`project-manager/index.ts:115-143`) has no caller.
2. The PM merge rule waits for a check that does not exist: `types.ts:216`
   `REQUIRED_MERGE_CHECKS = ['Lane scope', 'Collab handoff']`, but "Collab handoff" is a `continue-on-error` step inside
   job `pr-gate` (`.github/workflows/PR-GATE.yml:65-72`), not a check run.
3. Every end of rotation goes to Claude: `decide.ts:133-141` returns `'claude'` (no rotation, last seat, seat not found);
   `act.ts:287` parks with `next_actor: 'claude'`; timers `types.ts:210-212` (24 h reassign, 48 h stale claim, 4 h
   Gate 2 batch); governance merges need `reviewer_seat === 'claude'` (`act.ts:170-173`, `types.ts:230-241`);
   `decide.ts:78-81` needs `review.reviewer_seat === lane.reviewer_seat`.
4. VTIDs only in the converging run: `scripts/collab/plan-spar.mjs:218-219` returns `nothing_to_do` for a converged
   session before any lane is looked at; allocation only inside `:236` (`verdict === 'converged' &&
   policy_approved_at`), loop `:242-256`; a thrown `allocate` (`:136-138`) exits 1 so PLAN-SPAR's "Commit the round"
   (`PLAN-SPAR.yml:91-105`) never commits VTIDs already minted; zero lanes → `next_actor: 'claude'` with the false text
   "VTID allocation is off" (`:257`, `:262-268`). `plan-spar.test.mjs` runs in no workflow (`PR-GATE.yml:71` runs only
   `queue.test.mjs`).
5. Governance paths are Claude-only: `scripts/collab/queue.mjs:67-70` `GOVERNANCE_PATHS`; `validateLane:180` refuses
   `executor: kiro` on them; `scopeCheck:471` refuses them from a non-`claude` lane; `:174-177`/`:556` reject any
   `reviewer_seat` that is not a seat or `claude`; `:479` review identity; `:57` `SESSION_RE` has no agent form.
   `scopeCheck:442-445` reads the lane file only at the lane PR head or the other repo's `main` (`ghFetcher :490-497`),
   never from an open `plan(` PR, so a lane cut from `main` before its plan merges fails "not found". Platform PR-GATE
   runs the PR head's own checker (`PR-GATE.yml:124-144`); vitana-v1 already runs platform-main's (`v1:PR-GATE.yml:296-326`).
6. Automations: cron `0 7-19 * * 1-5`, one item per run (`.kiro/automations/exafyltd.md:24`, `exafy.md:25`,
   `jtadic.md:24`), nothing on weekends; Claude Routine (`scripts/collab/routine-prompt.md:5,20-35`) holds stale-claim
   cleanup, `executor: claude` lanes, merges, `review: changes` hand-backs, VTID fallback, parked items; 77 queue rows
   have `next_actor: claude` today and no Kiro path.
7. STAGING-VERIFY needs a deploy: stage deploy runs only on `services/gateway/**` (`AWS-STAGE-DEPLOY-GATEWAY.yml:34-39`),
   STAGING-VERIFY after it (`STAGING-VERIFY.yml:43-48`); http tests send no valid credential (`scripts/ci/staging-verify/
   lib.cjs:351-362`), so the auth-gated `GET /api/v1/project-manager/status` (`routes/project-manager.ts:25`,
   `requireServiceOrAdmin`) can only be probed for 401. `CLAUDE_AVAILABLE` exists nowhere (repo-wide grep).
8. Steering still says implementer-only: `.kiro/steering/vitana-kiro-notes.md:13-19` (VTID-05192 role),
   `vitana-load-project-rules.md:13-17`; `collaboration.md` §7a forbids merges except §7b per-PR instruction;
   `CLAUDE.md` roles paragraph (platform L121-125, v1 L102-106) "Kiro never merges". v1 `collaboration.md` lacks §7b
   (188 vs 207 lines) although the file claims to be identical.
9. Other facts: `TEST-SUITE.yml` gateway Jest is 28,514 tests / 1,730 suites, 3.8-4.6 min per job (the `~7.5k`/`25`
   in `:37,:39` are stale); Jest `^29.7.0` supports `--shard`; only `validate` is a required status check on `main`.
   `main` is red on TEST-SUITE since 2026-10-20 07:52Z (runs 39389473751 … 39421080981): one test,
   `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212` expects
   `app.js?v=20261120-vtid-05148`, `services/gateway/src/frontend/command-hub/index.html:32` serves
   `app.js?v=20261121-vtid-05082` (stale pin, real failure, not a flake). safe-merge refuses any PR touching
   `.github/workflows/` (`services/github-service.ts:709-748`, `types/cicd.ts:1339-1343`). Kiro commits carry
   `Co-Authored-By: Claude …` trailers (model credit), so "zero Claude actions" is defined on session ids (§4.9).

## 3. Fallback trigger — `CLAUDE_AVAILABLE` semantics (one definition, used by C, E, F, A)
- **Input 1:** GitHub repository variable `CLAUDE_AVAILABLE` on `exafyltd/vitana-platform`. Only the literal `false`
  means unavailable (reason `flag_false`). `true`, unset or unreadable = no override.
- **Input 2 (4 h rule):** unavailable (reason `no_action_4h`) when the oldest open item with `next_actor: claude`
  (lane or `handoff.md`, state not `done`) has `updated` older than 4 h **and** no commit with a `Collab-Session:
  session_…` trailer newer than that item exists on `main` or an open PR head of either repo. `true` does not override
  the 4 h rule. When Claude acts again, the next evaluation flips back (a level, not an edge; reassigned work stays).
- **Readers:** the PM observer each tick (variable via GitHub REST `GET /repos/exafyltd/vitana-platform/actions/
  variables/CLAUDE_AVAILABLE`, read-only; on any error the env var `CLAUDE_AVAILABLE` of the task, else no flag);
  Kiro drivers/automations (`gh variable get CLAUDE_AVAILABLE` when `gh` works, plus the same 4 h rule over the queue).
  No workflow and no ECS task-definition change: setting the variable takes effect at the next PM tick.
- **Effect when unavailable:** every job that goes to Claude today goes to the **exceptions seat `exafyltd`**
  (`EXCEPTIONS_SEAT`): end-of-rotation reassigns, parks, stale claims, `executor: claude` items reassigned, STAGING-VERIFY
  fix-forward (max 3, then park). Only protected gate files (§4.3) still wait for owner/Claude review. Available →
  today's routing, unchanged.
- **Exposed:** `/status` (auth-gated, unchanged gate) carries the detail: `claude: {available, reason}` with `reason ∈
  {flag_false, no_action_4h, null}`, `fallback`, `last_lease`. A new public `GET /api/v1/project-manager/mode` returns
  only `{ok, enabled, mode, executor_mode}` with `executor_mode ∈ {claude_primary, kiro_fallback}` — no
  `claude_available`, no `claude_reason`, no lane, PR, user or decision data. **Security note (deliberate decision,
  R1-F3):** `/mode` is unauthenticated on purpose so the read-only STAGING-VERIFY runner (no credential,
  `lib.cjs:351-362`) can prove the mode. Disclosed persistently: which executor routing is active (one enum), nothing
  about why or about Claude's availability; the reason and the 4 h evidence stay behind `requireServiceOrAdmin`.
  Accepted residual: an anonymous caller can see that the pipeline runs in `kiro_fallback`; it grants no capability
  (every merge still needs the §4.1 review on the current head, green checks and §4.3).

## 4. Interfaces between lanes (defined here; agents do not invent them)
### 4.1 Review entry (written for the reviewer agent; parsed by PM and scope-check)
Commit that appends one entry to `.kiro/specs/<slug>/lanes/<lane>.md`, front matter unchanged, trailers:
```
Collab-Session: <reviewer session>
Collab-Review: <slug>/<lane-id>
Collab-Verdict: accept | changes
Collab-Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
Collab-Reviewed-Head: <40-hex PR head the agent reviewed>
```
- `Collab-Review` keeps today's meaning (the lane key; `queue.mjs:317,389,436,479` depend on it). The verdict is the new
  `Collab-Verdict` trailer — `Collab-Review: accept|changes` would break those four call sites, so it is not used.
- `<reviewer session>`: `agent-vitana-lane-reviewer-YYYYMMDDHHMM-xxxx` (`queue.mjs session-id --agent
  agent:vitana-lane-reviewer`, added by scope-check) on a lane with `reviewer_seat: agent:vitana-lane-reviewer`; on a
  lane with a legacy seat `reviewer_seat`, `kiro-<reviewer_seat>-YYYYMMDDHHMM-xxxx`. Never a session in the lane's
  executing log (self-review guard `decide.ts:107-108` unchanged).
- Body: `### <ISO time> · <session> · review` then `review: accept|changes`, `head: <sha>`,
  `reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)`, PR link, findings summary, next actor.
- **Current head:** an entry counts when `Collab-Reviewed-Head` equals the PR head, or every commit after it only
  appends review entries to this lane file (front matter unchanged) or is a `pm-agent` lane-state commit (§4.5).
### 4.2 Reviewer agent verdict (G; consumed by the caller, which writes §4.1)
`{"verdict":"accept"|"changes","head_sha":"<40-hex>","findings":[{"severity":"blocking"|"non-blocking","file":"<path>",
"line":<n>|null,"issue":"<text>"}],"model":"claude-sonnet-5.5","agent":"vitana-lane-reviewer"}`. `accept` only with zero
blocking findings. Model not `claude-sonnet-5.5` or unknown → `{"error":"model_unavailable","required":
"claude-sonnet-5.5","agent":"vitana-lane-reviewer"}`; the caller treats it as no review (lane stays `in-review`), never
substitutes a model. A verdict whose `model`/`agent` differ is ignored and logged.
### 4.3 Protected gate files (D owns the list; C mirrors it; A documents it)
`scripts/collab/protected-gate-files.json` (globs, `queue.mjs` glob semantics):
`CLAUDE.md`, `scripts/collab/plan-spar.mjs`, `scripts/collab/queue.mjs`, `scripts/collab/protected-gate-files.json`,
`services/gateway/src/services/plan-sparring/**`, `services/gateway/src/services/project-manager/governance.ts`,
`.github/workflows/PLAN-SPAR.yml`, `.github/workflows/PR-GATE.yml`, `.github/workflows/AWS-PROD-*.yml`,
`.kiro/agents/vitana-lane-reviewer.md`, `supabase/migrations/*vtid_ledger*.sql`, `supabase/migrations/*plan_sparring*.sql`.
A change to one of them never merges on a reviewer-agent accept alone: it needs a legacy `claude` review on the
current head or the owner's instruction. Everything else on a governance path merges on agent accept + all checks green.
### 4.4 Lane fields
`executor: kiro|claude`, `seat`, `reviewer_seat` (legacy, optional; a seat, `claude`, or — once scope-check is on main —
`agent:vitana-lane-reviewer`), new informational keys `reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)` and
`repos: [...]`. Unknown keys are already ignored by `validateLane` (`queue.mjs:159-187`). Shared files are declared in
`plan.md` (§7), not in a new front-matter key.
### 4.5 PM writes (all `Collab-Session: pm-agent`)
- W1 on the lane PR branch before merge: lane `state: in-review → verified` + one log line, trailer
  `Collab-Lane: <slug>/<lane>`.
- W2 bookkeeping PR `pm-agent/<slug>` (spec + `docs/validation/<plan VTID>/timings.json` only), title
  `VTID-<plan VTID> (<slug>/_plan): PM bookkeeping`, trailer `Collab-Lane: <slug>/_plan`: lanes `verified → done`,
  reassign (`seat`, `next_actor`), park (`state`, `parked_from`, `next_actor`), `claimed_by` cleared; merged by the PM on
  green. scope-check adds the exemption: a `pm-agent` commit may change only `state`, `parked_from`, `next_actor`,
  `seat`, `claimed_by`, `updated` and append a log entry, and does not count for one-session-per-lane or `claimed_by`.
### 4.6 `timings.json` (C computes; F writes it for this plan; A documents it)
Path `docs/validation/<plan VTID>/timings.json`, plan VTID = the VTID bound to the sparring session (the lane that
carried `sparring_id`). Every field `null` when its source is missing (never 0); `sources_unavailable` names them.
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
### 4.7 Driver heartbeat (H implements; C, E, A read)
Ref `refs/heads/collab-driver/<slug>`: a commit whose tree equals `origin/main^{tree}` (no workflow triggers), parent the
previous tip (fast-forward only, never forced), trailers `Collab-Session: <driver session>`, `Collab-Driver: <slug>`.
Interval ≤ 15 min. **Alive** = committer date < 45 min old. A second driver refuses a foreign tip younger than 45 min
(exit 3); older → take over. The PM reads the committer date of that ref (GitHub REST, read-only) into
`ObservedLane.driver_heartbeat_at`; a missing ref = no driver.
### 4.8 Staging deploy and suites
Deploying lanes (touch `services/gateway/**`): `pm-fallback`, `pipeline-speed`, `staging-proof`; each ships
`docs/validation/<VTID>/staging-tests.json` (read-only: GET or `rejected_probe`). The others deploy nothing and are
done at merge with green checks.
### 4.9 "Zero Claude actions"
Measured window: from this plan PR's first commit `70d6af4010251d7f08bfba395bccde0c0f5e5a4e` (2026-10-20T17:30:55Z) to
the Gate 2 message. In that window: no commit, review entry, claim, merge, VTID allocation or Gate 2 message from a
**Claude Code session** (`Collab-Session: session_…`, or a `mergedBy` Claude identity). The Claude model inside Kiro is
not a Claude action. **Trailer cutover = that same commit:** every Kiro commit of this run (author/committer
`kiro-agent[bot]`, env-var identity) carries no `Co-Authored-By: Claude` trailer — already true for `70d6af401` and
`ba3d3ee98` (verified with `git log --format=%(trailers)`). F's `zero-claude-proof.md` asserts both over the window:
(a) actor ids per step and (b) `git log <window> --format=%(trailers)` on `main` and every lane branch of this plan
shows zero `Co-Authored-By: Claude` lines; a hit is listed and the proof marked incomplete, never rewritten (no
history rewrite, no force-push).

## 5. Lanes (eight; ids exact; no two lanes edit the same file)
### A. `steering-rules` — rule text first (both repos), no depends_on, lands first
Files (platform and v1 mirror, same relative paths): `.claude/rules/collaboration.md` (byte-identical in both repos;
sha256 of both in each PR body), `CLAUDE.md` roles paragraph only, `.kiro/steering/vitana-kiro-notes.md`,
`vitana-load-project-rules.md`, `vitana-standing-rules.md` (:6-7 wording), `vitana-collaboration.md` (title only;
`fileMatchPattern` stays = `collaboration.md` `paths:`), new `.kiro/steering/vitana-pipeline.md` (no front matter =
always included; plain backtick paths, no `#[[file:.claude/rules/…]]` link, because `scripts/ci/kiro-steering/guard.cjs`
requires a file linking a rules file to be `fileMatch`).
- `collaboration.md`: intro "Claude Code is optional (§7)"; §2 handoff writer = the plan driver; `reviewer_seat` legacy;
  §3 review entry = §4.1 of this plan; §3a governance rule = agent accept + all checks green except §4.3 protected files;
  §5 drop "allocating VTIDs" from `_plan` steps; **§7** pipeline of §1 item 1, no per-PR owner approvals, owner asked
  Gate 2 only (Gate 1 only for a plan Claude Code spars locally) plus the stop cases (security/data-loss, 3 failed
  fixes, escalated sparring verdict, production); Claude-unavailable mode = §3 with exceptions seat `exafyltd`; Claude
  Code "when available"; **§7a** keeps every prohibition (never allocate a VTID — CI does; never deploy to production;
  never write a live system from session tools; never accept own lane) and allows only: merge under §7b, re-runs of
  failed PLAN-SPAR / PR-GATE / STAGING-VERIFY runs (by workflow path, attempt 1 only); "Blocked → fix forward, after 3
  park with the five-part stop message; `next_actor: claude` only when Claude is available"; **§7b** replaced by the
  PM merge rule: the PM merges — and the plan driver applies the same rule while the PM is not `live` — when the review
  of §4.1 is `accept` on the current head, every required check is green incl. Lane scope and Collab handoff, the PR is
  up to date with latest `main` and re-checked on that head, no conflict, every `depends_on` lane done, target `main`
  with a staging-only deploy path, no §4.3 file without owner/Claude review; record `merge: <sha>` and
  `authority: §7b PM rule`; `--admin` only for a governance-artifact false positive, never a real red; **§8** continuous
  plan driver (one per approved plan, 24/7 incl. weekends, from `plan(` PR to Gate 2, heartbeat §4.7, many plans in
  parallel; automations are fallback wake-ups; the Claude Routine only when Claude is available); **new §8a Parallel
  execution** (seven rules of §7 below); **new §8b Measurement** (§4.6, quoted in Gate 2); §9 adds the Collab handoff job.
  One line: "each mechanism takes effect when its lane is on `main`".
- `CLAUDE.md` (protected, hot): replace "Claude Code handles exceptions only … Kiro never merges, deploys or writes to a
  live system. See §7–§7a." with "Claude Code is optional; when it is unavailable Kiro and the exceptions seat run the
  pipeline (§7). Kiro merges to `main`/staging only under the PM merge rule §7b, never deploys to production and never
  writes a live system from session tools. See §7–§8b." (Without it, IF-THEN 9 "prefer the stricter rule" keeps the old
  sentence winning.) Nothing else in `CLAUDE.md` changes.
- Steering: delete the VTID-05192 implementer bullet (`vitana-kiro-notes.md:13-19`), point at §7/§7a; L7-8 sparring =
  CI PLAN-SPAR; `vitana-load-project-rules.md:13-17` rewritten to §7/§7a/§7b, keep :18-21, add "repo file governs where
  an account-level copy differs"; `vitana-pipeline.md` = the owner addition text: every owner task that results in a
  commit runs the pipeline end to end; Kiro IDE launches `.kiro/workflows/vitana-pipeline.workflow.json`; Kiro Web
  follows `.kiro/pipeline/driver.md` in one continuous session; no owner approval for git, push, PR, merge, re-runs,
  sparring rounds or VTIDs; the only owner stops are Gate 2 and an escalated sparring verdict (plus §7 stop cases);
  VTIDs only from CI PLAN-SPAR. Every stale "implementer only / Claude merges / ask before …" sentence in both repos'
  steering goes.
- Supersedes (text only, no edit of those specs): `retire-claude-code` lanes `rules-platform`/`rules-v1` and
  `kiro-primary-executor` lanes `rules-platform-autonomy`/`rules-v1-autonomy` edit the same paragraphs; what still
  applies is carried over (production after Gate 2 = PUBLISH, or an explicit owner "yes, deploy" pinned to the verified
  commit; the five-part stop message; migrations need owner approval naming file and database). Those lanes are left to
  their plans' author seats (never edited here).
- Tests: none new (docs); `node --test scripts/ci/kiro-steering/guard.test.cjs`, `node scripts/ci/kiro-steering/guard.cjs .`
  and `node scripts/collab/queue.mjs validate` green in both repos; sha256 equality of both `collaboration.md`.
### B. `plan-spar-allocation` — VTID retry (CI only)
`scripts/collab/plan-spar.mjs`, `scripts/collab/plan-spar.test.mjs`.
- New exported `allocateLanes({spec, slug, session, client, write, log, t})` (the loop `:240-256`): bind the sparring id
  only while the live session is unbound (`!session.vtid`), to the first lane without `vtid` in today's order; adopt an
  orphaned bound VTID (`session.vtid` set, no lane/handoff carries it) without calling allocate; per-lane try/catch —
  first error stops, keeps what was written, returns `{vtids, failed: {lane, error}}`; idempotent per lane
  (`parseFrontMatter(lt)?.vtid` skip, `:247`); fix the comment at `:248`.
- `step()`: new branch before `:218`: converged + `policy_approved_at` + `allocate` + a lane without `vtid` →
  `action: 'allocate_retry'`: `client.get(cur.id)` must return producer `ci-plan-spar.<slug>`, `converged`,
  `policy_approved_at`, same `final_plan_hash`, else throw (as `:206-212`); no new round; nothing to allocate →
  unchanged `nothing_to_do` with zero writes (no commit loop; `PLAN-SPAR.yml:66-70` skips its own commits).
- Approval block: `verdict.md` lists all lane VTIDs; "allocation is off" text only when `allocate` is false;
  `handoff.md` `next_actor: kiro` in every allocate-on outcome with front-matter `reason: lanes_missing |
  allocation_pending` when not all lanes have VTIDs (`validatePlan` ignores unknown keys, `queue.mjs:141-157`); only
  `allocate === false` keeps `next_actor: claude`. A failed allocation exits 0 so "Commit the round" commits what was
  allocated; the next PLAN-SPAR run on the PR retries. Usage/partner errors still exit 1/2 (`:323-326`).
- Not changed: `PLAN-SPAR.yml`, gateway, migrations, the gate (`_plan_sparring_gate_eval`), round count, partner chain.
  Lanes added in a later PR that touches neither `plan.md` nor a responses file still do not trigger PLAN-SPAR
  (protected workflow; documented workaround: a `plan(<slug>)` PR touching `plan.md` front matter only).
- Tests (all red on base): late lane allocated after convergence; retry never re-sends `sparring_id` once bound; no
  lanes at convergence → `next_actor: kiro`, `reason: lanes_missing`; lanes added later to a lane-less plan → first gets
  the bound VTID; allocation failure keeps earlier VTIDs, resolves, `reason: allocation_pending`, next run allocates the
  rest unbound; orphaned bound VTID adopted with zero allocate calls; foreign session in `state.json` refused. Guards
  (green on base): all lanes allocated → `nothing_to_do`, `wrote: []`; allocation off → `claude`; existing `:83-128`.
### C. `pm-fallback` — the PM really acts, falls back to Kiro, merges by the agent review, sends Gate 2
`services/gateway/src/services/project-manager/**`, `services/gateway/src/routes/project-manager.ts`,
`services/gateway/src/index.ts` (the PM block `:1877-1903` only), `services/gateway/test/project-manager/**`.
depends_on: `scope-check` (parity with `protected-gate-files.json`, the `Collab handoff` check run, the `pm-agent` exemption).
1. `governance.ts` (new; protected): `REVIEWER_AGENT`, `PROTECTED_GATE_GLOBS` (= §4.3 as a compiled-in constant
   literal; the runtime never reads the JSON, so a missing or empty JSON can never empty the list; only the parity test
   T25 reads `scripts/collab/protected-gate-files.json` and fails when it is absent or differs; an empty constant fails
   M1),
   `isAgentReview`, `reviewOnCurrentHead` (via `ObservedPr.review_only_since`), `touchesProtectedGate(files)`,
   `reviewSatisfiesLane`, `governanceMergeAllowed(lane, pr, review) → {ok} | {ok:false, reason: 'protected_gate_file' |
   'no_agent_accept' | 'stale_head'}`; `GOVERNANCE_PATHS`/`GOVERNANCE_REVIEWER` move here, re-exported from `types.ts`.
   Agent accept on the current head satisfies any lane; legacy seat `approve` keeps today's rule; protected files need a
   legacy `claude` review on the current head. `ReviewVerdict` gains `'accept'`; `ReviewEntry` gains `reviewer`;
   `ObservedPr` gains `review_only_since: string[]`, `files: string[]`, `behind_by: number`.
2. `claudeAvailability(c: ObservedClaude, nowMs)` (§3) and `EXCEPTIONS_SEAT = 'exafyltd'`; `reassignDecision` end of
   rotation → `exafyltd` when unavailable (same seat → `null`, no self loop), `fallback: boolean` in the decision;
   `ParkDecision.to_actor` used by `actPark` instead of the literal `'claude'` (`act.ts:287`). Missing `state.claude` =
   available (today's behaviour).
3. Speed: `REASSIGN_NO_DRIVER_AFTER_MS = 2h` and `STALE_CLAIM_NO_DRIVER_AFTER_MS = 4h` when the plan's driver is not
   alive (§4.7), 24 h/48 h when alive; reasons `stale_ready|stale_review|stale_claim` + `window_ms`; Gate 2: parked
   deploying lanes do not block `all_verified`, the 4 h batch applies only while a non-parked sibling is in flight,
   `gate2_sent` per lane+commit, `vtids` = verified and not yet sent; `pmTickIntervalMs` default 600000 → 120000 (lease
   TTL = tick − 30 s); at most one `merge` per repo per tick (oldest `state_since`); a PR behind `main` gets
   `update_branch` (`PUT /pulls/{n}/update-branch` with `expected_head_sha`) instead; `verify` decision (W1) for an
   `in-review` lane with an agent accept on the current head; `merge_plan` decision for a `plan(<slug>)` PR whose files
   are all under `.kiro/specs/<slug>/`, handoff `approved` with `vtids`, the sparring session (read-only) converged +
   policy-approved + `final_plan_hash` = canonical hash of the head `plan.md`, head commit PLAN-SPAR's, checks green;
   no reassign into a plan with 6 lanes `executing|in-review`; status reports `build_lanes_in_flight` per plan.
   GitHub webhooks: deferred (no receiver exists; a 2-min tick gives ~1 min latency).
4. Ledger: `ledger` decision → `LedgerWriter.patch(vtid, {status: 'in_progress', spec_status: 'approved'})` through the
   governed `PATCH /api/v1/oasis/tasks/:id` path (`routes/oasis-tasks.ts:332`) when a lane with a VTID is
   `executing|in-review` and its row is `allocated|scheduled`; idempotent. Terminal stays `VTID-AUTO-CLOSE.yml`.
5. Gate 2: `Gate2Evidence` gains `services[]`, `staging_verify[]` (run URL, passed/failed/total; fields read from the
   STAGING-VERIFY record, unknown → `unavailable[]`), `migrations[]`, `decisions_taken[]`, `timings` (§4.6),
   `unavailable[]`; `RunViewGate2EvidenceResolver` reuses `services/operator-runs/run-view.ts:487-613,768-800`;
   `OperatorChatGate2Poster` posts one message with `GATE2_QUESTION` to the Operator Chat thread of the plan's VTIDs
   (else a PM thread) and records `pm.gate2.posted` + a `pm_digests` row (observable as `gate2_sent`). Posting only; no
   deploy capability is injected. `timings.ts` `planTimings(...)` → W2 bookkeeping PR writes `timings.json`.
6. Live seams: `PgLeaseManager` on `pm_lease` — the table is created by
   `supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql:222-240` (VTID-05214, on `main`;
   one seeded row `:227`, asserted by `supabase/tests/vtid_05214_policy_approval.test.sql:13`); `lease.ts:12-19,38-52`
   predates that merge and still says "P1 not merged". No new migration. `PgLeaseManager` keeps the fail-safe: missing
   relation → `table_absent`, any error → `error`, both a no-op tick; the last outcome is exposed as `/status`
   `last_lease` and logged once per change, so a silently non-acting PM is visible. `GithubObserver`
   (lane files from `main` + open `plan(` PR heads, lane PRs by branch `<kiro|claude>/<slug>/<lane>` or `pr:`, head,
   check runs, files, mergeable, `behind_by`, commits + §4.1 trailers after the review, repo variable, driver refs,
   `session_…` commits, OASIS verify events, ledger status), `GithubRepoFileWriter` (W1/W2), `startPmLoop({pm, deps})` in
   `loop.ts` calling `runActTick` in `live` and `runDecideTick` otherwise; `index.ts:1877-1903` calls it. `pmMode()`
   default unchanged (`dry_run`); staging stays pinned `live`.
7. Routes: `/status` gains `claude: {available, reason}`, `fallback`, `build_lanes_in_flight`, `last_lease`
   (`acquired|held_by_other|table_absent|error|null`); new public `/mode` returning only `{ok, enabled, mode,
   executor_mode}` (§3, mounted before the auth middleware with a `// public-route` comment).
8. Tests (each red on base unless marked guard): new `test/project-manager/fallback.test.ts`, `governance.test.ts`,
   `loop.test.ts`, `timings.test.ts`, `observe-live.test.ts`, plus `decide.test.ts`, `act.test.ts`, `route.test.ts`,
   `tick-and-config.test.ts` updates — the table T1-T25 and mutations M1-M7 below. `npm run test:operator` green.
   T1-T4 availability (flag false; 5 h no action; 3 h; acted 1 h ago); T5 end of rotation → `exafyltd`; T6 guard → `claude`
   when available; T7 same-seat → null; T8 `actPark` → `exafyltd`; T9 governance lane + agent accept on head → merge;
   T10 non-governance lane, seat reviewer mismatch, agent accept → merge; T11 review-only commits after accept → merge;
   T12 guard legacy `claude` review; T13 ready 3 h, no driver → reassign `window_ms` 2 h; T14 guard heartbeat fresh → none;
   T15 claim 5 h, no driver → park; T16 two eligible → one merge; T17 behind → `update_branch`; T18 spec-only plan PR →
   `merge_plan`, and none for a file outside the spec / hash mismatch / non-bot head / non-converged; T19 parked sibling →
   `all_verified`; T20 tick default 120000; T21 `planTimings` fixture exact, missing source → null; T22 ledger decision
   once; T23 Gate 2 evidence fields present; T24 `/status` + `/mode` shape, `/mode` without token → 200 with exactly
   the keys `ok, enabled, mode, executor_mode` (no `claude_available`/`claude_reason`), `/status` without token → 401;
   T25 parity with `scripts/collab/protected-gate-files.json` (absent file → test fails); T26 `PgLeaseManager` against
   an injected pg client: row free → `acquired`, held → `held_by_other`, `42P01` → `table_absent`, other error →
   `error`, and `last_lease` reflects each.
   M1 protected file (each §4.3 entry) + agent accept only → `governance_blocked: protected_gate_file`, `safeMerge` never
   called; M2 stale-head review → no merge; M3 `reviewer: agent:someone-else` / null / `…-fake` → no merge; M4 `changes`
   → no merge; M5 agent review from an executing session → no merge; M6 Claude available → `claude`; M7 the act layer never
   calls deploy/dispatch/allocate for any new decision kind.
9. `docs/validation/<VTID>/staging-tests.json`: GET `/alive` 200; GET `/api/v1/project-manager/mode` 200 with
   `expect_json {"ok": true, "mode": "live"}` and `expect_body_contains "executor_mode"`; GET `/status` with
   `rejected_probe` → 401; `existing` `npx jest test/project-manager` (cwd `services/gateway`).
### D. `scope-check` — governance by the reviewer agent, lanes from the open plan( PR, Collab handoff check
`scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, `scripts/collab/protected-gate-files.json` (new),
`.github/workflows/PR-GATE.yml` (protected; the only lane editing it).
- Constants: `REVIEWER_AGENTS = ['agent:vitana-lane-reviewer']`, `isReviewerAgent`, `PROTECTED_GATE_PATHS` loaded from
  the JSON; `SESSION_RE` gains `agent-[a-z][a-z0-9-]{0,40}-\d{12}-[0-9a-f]{4}`; `agentOf(session)`;
  `sessionId('agent:<name>')` for a listed agent (other non-kiro agents still throw, `:622-628`).
- `validateLane`: accept `reviewer_seat: agent:vitana-lane-reviewer` only with `executor: kiro`; `executor: kiro` +
  protected glob → error "protected gate file … needs executor: claude"; + governance glob → error only when the
  reviewer is not the agent. `validateRegistry:556` skips the agent value.
- `scopeCheck`: new option `fetchPlanLane(slug, lanePath)`: open same-repo PR titled `plan(<slug>)` (exactly one;
  else null), handoff at its head `approved|executing` with `sparring_record`, lane `vtid` in `vtids`; the lane file is
  read at the newest commit on that PR with `Collab-Session: ci-plan-spar` that touched it (later edits ignored). Order:
  lane PR head → plan PR → other repo `main`. Permissions (`PERM`) fold back from the trusted source (merge-base, else
  plan PR, else other repo main) whatever the source; a lane file only in the lane PR head is untrusted (no exemption).
  Path rule: governance file on a `kiro` lane passes only with the agent reviewer and a trusted source; a protected file
  never passes for `kiro`. Review rule `:479`: agent reviewer → `agentOf(session) === reviewer_seat`.
- `pm-agent` exemption (§4.5) in `validateRange` and `scopeCheck`.
- CLI: `findPlanPr(prs, slug)` (pure), `ghPlanLaneFetcher(repo)` (`gh pr list` + `gh api` contents/commits; any failure
  → null, fail closed), `--plan-repo` (default `GITHUB_REPOSITORY`, then `--lane-repo`). `commitsInRange` also reads
  `Collab-Verdict`, `Collab-Reviewer`, `Collab-Reviewed-Head`.
- `PR-GATE.yml`: move "Collab handoff" into its own job named exactly `Collab handoff` (the name `types.ts:216` requires)
  running `node --test scripts/collab/*.test.mjs` (so `plan-spar.test.mjs`, `automations.test.mjs`,
  `plan-driver.test.mjs` run in CI the moment they exist) and `queue.mjs validate`; `lane-scope` job gets
  `GH_TOKEN: ${{ github.token }}` and runs the **base** revision's `queue.mjs` copied to `$RUNNER_TEMP` (as v1 and
  PLAN-SPAR do) so a PR never grades itself. vitana-v1 needs no change (it already runs platform-main `queue.mjs`).
- Supersedes (no edit of their specs): `retire-claude-code/scope-rules` (#4210) and `collab-kiro-governance` Change A
  (`governance: owner`); left open/parked by their own plans.
- Tests (`queue.test.mjs`, red on base): T1 kiro + agent reviewer + steering paths → valid; T2 + `CLAUDE.md` → protected
  error; T3 agent reviewer with `executor: claude` → error; T4 scope pass for governance file with agent + trusted lane;
  T5 `paths: ['**']` + `CLAUDE.md`/`queue.mjs` → protected errors; T6 self-granted agent reviewer → PERM error; T7 agent
  review entry passes, the same from `kiro-exafyltd-…` fails; T8 session-id/agentOf; T9 lane only on a qualifying plan
  PR → `source: 'plan-pr'`, no errors; T10 plan-PR permissions win over a widened head; T11 unqualified plan PR (drafted,
  not ci-plan-spar, vtid not in handoff) → governance error; T12 head-only lane → no exemption; T13 `findPlanPr` picks one,
  two matches → null; T14 registry accepts the agent; T15 `pm-agent` lane-state commit accepted, a `pm-agent` commit
  changing `paths` refused; T16 the JSON parses and every entry is under `GOVERNANCE_PATHS` or a gate path; T17 a static
  PR-GATE check: job `Collab handoff` exists and runs `scripts/collab/*.test.mjs`, `lane-scope` runs a base copy.
  Existing `:340-422`, `:492-517` stay green.
### E. `exceptions-seat` — Claude's jobs to `exafyltd`; automations become wake-ups; Kiro Web driver
`.kiro/automations/exafy.md`, `exafyltd.md`, `jtadic.md`, `scripts/collab/routine-prompt.md`,
`docs/programs/areas.yaml` (top-level `exceptions_seat: exafyltd`), `scripts/collab/automations.test.mjs` (new),
`.kiro/pipeline/driver.md` (new).
- Every automation run does one item, in this order; `exafyltd`: E1, W, E2, E3, E4, E5, E6, A, B, C; others: W, A, B, C.
  - **W** wake a driver: an `approved|executing` plan of this seat (exafyltd also plans whose author seat has no
    automation) whose driver is not alive (§4.7) → become its driver per `.kiro/pipeline/driver.md` (resume from git
    state). A lane of a plan with an alive driver is never taken by an automation.
  - **E1** STAGING-VERIFY failed on a merge commit of an `executing` plan: one `gh run rerun <id> --failed` when the
    failure is infra and `run_attempt` is 1; else `fix-forward: <n>/3 <run url> <cause>` in the lane log and wake the
    driver (a fix-forward is a new lane via the plan's `_plan`, never a reopened `done` lane); 4th failure → park with the
    five-part stop message.
  - **E2** stale claims (spec `done`, or > 24 h with no lane-branch commit, `queue.mjs:54`) → `release --stale`, one log
    entry per lane, one PR. **E3** infra-escalated plan (reason in `RETRYABLE_REASONS`, `plan-spar.mjs:35`) → rerun
    the last failed PLAN-SPAR run, at most once per 24 h per plan. **E4** `review: changes` → `executing`,
    `next_actor: kiro`. **E5** unclaimed `executor: kiro` lane with `next_actor: claude` → claim, classify, hand back,
    or route a §7 stop item to the owner with the five-part message. **E6** parked items: CI × 3 → as E5; a plan parked
    after 2 sparring sessions → log "needs successor plan" once (no re-plan exists; `plan-spar.mjs:31,189`).
  - E items for `next_actor: claude` items only while Claude is unavailable (§3); stale claims and STAGING-VERIFY
    fix-forward always.
- `gh run rerun` allowlist by workflow path: `PLAN-SPAR.yml`, `PR-GATE.yml`, `STAGING-VERIFY.yml` (platform),
  `PR-GATE.yml` (v1); conclusion `failure`, `run_attempt` 1. Never `gh workflow run`, never `AWS-PROD-*`, deploy,
  migration, PUBLISH or `publish-to-prod.sh`. No `gh` in Kiro Web → log "rerun unavailable", fall back to a push of the
  next responses file (PLAN-SPAR) or leave it for the driver.
- `steps 6/9` of every automation: `next_actor: kiro` (exceptions seat picks it up) or `owner` for a §7 stop item, never
  `claude`. Setup text: cron `0 * * * *` every day (owner sets it once in app.kiro.dev; not in git).
- `.kiro/pipeline/driver.md`: the sequential Kiro Web version of the pipeline for one continuous session: heartbeat
  (`plan-driver.mjs heartbeat`), `next` actions (§H), answer rounds, build lanes in their own branches, reviewer agent,
  serialized landing under §7b, watch staging, Gate 2; no dependence on subagents.
- `routine-prompt.md`: header "Retired as primary 2026-10-20 (kiro-autonomy-fallback): runs only while Claude is
  available; the jobs moved to `.kiro/automations/exafyltd.md` E1–E6".
- Test `automations.test.mjs` (red on base: no `exceptions_seat`, `next_actor: claude` present): every seat automation
  exists and is referenced; `exceptions_seat` names a kiro-web seat and only its file has `### Exceptions`; "Do at most
  ONE item" once per file and the order line; `gh run rerun` only beside the allowlist; `gh workflow run`, `gh pr merge`,
  `--admin`, `AWS-PROD`, `publish-to-prod`, `apply_migration` only in "never" sentences; no `next_actor: claude` outside
  the legacy `executor: claude` sentence; shared sections W/A/B/C byte-identical after seat normalisation (allowlist
  `exafy.md:18`); cron line 5 fields; `routine-prompt.md` header; `driver.md` exists and names the heartbeat command.
### F. `staging-proof` — proof run in fallback mode (depends on all other lanes)
`services/gateway/test/kiro-autonomy-fallback-proof.test.ts` (new), `docs/validation/VTID-*/**`
(`staging-tests.json`, `zero-claude-proof.md`, and this plan's `timings.json` at the plan VTID).
- Precondition: the other seven lanes on `main`, `pm-fallback` deployed to staging (successful
  `AWS-STAGE-DEPLOY-GATEWAY.yml` run on a `main` commit containing it), repo variable `CLAUDE_AVAILABLE=false` set
  (reversible repo config under the owner instruction; it stays `false` afterwards, Gate 2 says so), and **the PM
  really holds its lease on staging**: the driver (not the STAGING-VERIFY runner) reads the staging gateway's auth-gated
  `GET /api/v1/project-manager/status` once, read-only, with `Authorization: Bearer $env:GATEWAY_SERVICE_TOKEN`
  (presence check only, never printed) and requires `mode: "live"` and `last_lease: "acquired"` on a tick after the
  deploy. `table_absent`/`error` → the proof is blocked: logged in the lane and Gate 2 as "PM not acting on staging:
  <last_lease>", no merge-by-PM claimed (the §5 F 60-min fallback applies). Token unset → no gateway call; the PM-merge
  evidence (`mergedBy` + `pm-agent` W1 commit) decides instead.
- The lane is the proof: its VTID came from CI, a Kiro seat builds it, the reviewer agent accepts, **the PM merges it**
  (W1 verify then merge; the land step does not self-merge), staging deploys, STAGING-VERIFY passes, the PM posts Gate 2.
- Jest test: `claudeAvailability` cases, `/mode` and `/status` bodies via `createProjectManagerRouter` with an injected
  snapshot, end-of-rotation never `claude` while unavailable.
- `staging-tests.json`: GET `/alive`; GET `/api/v1/project-manager/mode` with `expect_json {"ok": true, "enabled": true,
  "mode": "live", "executor_mode": "kiro_fallback"}`; `/status` `rejected_probe` 401;
  `existing` `npx jest test/kiro-autonomy-fallback-proof.test.ts`.
- After Gate 2, a follow-up docs-only commit/PR on the lane: `zero-claude-proof.md` (one row per step: actor id,
  evidence link, SHA — per §4.9, from commit trailers, claims, lane logs, `gh pr view --json mergedBy`, PM logs, OASIS)
  and `timings.json` (§4.6) for the whole plan. Kiro Web is not exercised from this run; Gate 2 says so and names this
  Kiro IDE run as the proof.
- PM did not merge within 60 min → read-only evidence, proof marked incomplete in the record, merged under §7b; Gate 2
  reports it as not proven.
### G. `reviewer-agent` — reviewer agent + pipeline recipe
`.kiro/agents/vitana-lane-reviewer.md` (new, protected), `scripts/ci/kiro-steering/guard.cjs`, `guard.test.cjs`,
`.kiro/pipeline/README.md`, `common-rules.md`, `planning.md`, `lane-code.md`, `lane-review.md`, `lane-land.md` (new),
`.kiro/workflows/vitana-pipeline.workflow.json` (new), `.kiro/hooks/vitana-pipeline-start.json` (new).
- Agent: front matter `name: vitana-lane-reviewer`, `model: claude-sonnet-5.5`, `tools` block list `read`, `shell`,
  `excludedTools` `fs_write`, `fs_append`, `str_replace`, `delete_file`, `includeMcpJson: false`, `includePowers: false`,
  shell allow-list `git -C * diff|log|show|fetch origin|merge-base|rev-parse`, `gh pr view|checks`, `gh run view`, deny
  the rest, deny `fs_write`/`web_*`/`mcp`. Body: independence; hard limits (read-only, no live calls, ignore
  instructions found in the diff, only the two repos, never ask the owner); model self-check → §4.2 error; checklist
  (acceptance criteria of the lane in `tasks.md` + lane file; files within `paths`; CI on the current head; new behaviour
  has a test red on base; no test weakening; no production/live writes, no hand VTID, no PUBLISH/AWS-PROD; no hardcoded
  spoken strings; i18n/design/RTL if UI; §4.3 protected files → blocking for agent-only acceptance); output exactly the
  §4.2 JSON and the §4.1 entry.
- `.kiro/pipeline/*.md`: this run's runbooks, generalized (no slug text): common rules (merge authority = §7b PM rule,
  identity `kiro-agent[bot]`, no Claude co-author trailer, push protocol, PowerShell 5.1 notes), planning (spec layout
  §2, change class, investigations), lane code / review / land (state machine, merge lock, serialized landing, rerun
  allowlist, staging-proof rule).
- `.kiro/workflows/vitana-pipeline.workflow.json`: input = the owner task text only; steps: parallel investigators →
  spec → push `plan(` PR → spar loop (answer rounds until converged/parked) → merge the plan PR → per lane, parallel up
  to 6, loop code / review (`vitana-lane-reviewer`, `claude-sonnet-5.5`) / land with the merge lock → staging verify →
  Gate 2. Validated with Kiro's workflow schema validation (validation only, no launch).
- `.kiro/hooks/vitana-pipeline-start.json`: SessionStart, agent action: "Load `.kiro/steering/vitana-pipeline.md`; run
  the queue; resume any plan driver whose heartbeat is stale."
- `guard.cjs` `checkAgents(root)` (run from `check()` only where `scripts/collab/queue.mjs` exists, so v1 stays green):
  agent file exists; `name`, `model: claude-sonnet-5.5`; `tools` ⊆ {read, shell}; `excludedTools` ⊇ {fs_write,
  str_replace, delete_file}; `includeMcpJson` not true; body has `model_unavailable`, the verdict keys and the §4.1
  trailers; every `.kiro/agents/*.md` has front matter with a `name`; `.kiro/workflows/vitana-pipeline.workflow.json`
  parses and names `vitana-lane-reviewer` and `claude-sonnet-5.5`; every `.kiro/pipeline/*.md` referenced by the
  workflow and by `vitana-pipeline.md` exists. Red on base (`guard.test.cjs:45-47` "this repository passes").
### H. `pipeline-speed` — driver, shards, sparring slots, per-lane attribution, unblock main
`scripts/collab/plan-driver.mjs`, `plan-driver.test.mjs` (new), `.github/workflows/TEST-SUITE.yml`,
`.github/workflows/TEST-SUITE-RERUN.yml` (new), `.github/workflows/CI-SCRIPTS-TEST.yml` (new), `scripts/ci/test-suite/**`
(new), `.github/workflows/PLAN-SPAR.yml` (protected; one step), `scripts/ci/plan-spar-slot/**` (new),
`scripts/ci/staging-verify/run.mjs`, `lib.cjs`, `lib.test.cjs`,
`services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts`.
- H0 unblock main (deterministic; H is the only lane owning
  `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts`). **The test is stale, the served pin is
  correct:** `index.html:32` was bumped to `app.js?v=20261121-vtid-05082` by VTID-05082 (`80e2b3553`, 2026-10-20) after
  the test was last edited by VTID-05148 (`e7a4c90fb`, 2026-10-13); four other suites already expect the served pin
  (`test/command-hub/vtid-05067-kiro-console.test.ts:567`, `vtid-05069-pipeline-tree.test.ts:184`,
  `vtid-05071-kiro-approval-visibility.test.ts:182`, `vtid-05084-loops-screen.test.ts:148`). So `:212` changes its
  literal to the served pin and gains one assertion that `app.js` contains the chip markup the test exists for;
  `index.html` is not touched; no assertion is dropped or loosened. If `main` already carries the identical fix when
  the lane starts, H0 is a recorded no-op. Needed because every gateway lane is red while `main` is.
- `plan-driver.mjs` (deterministic Node, no LLM; imports `collect`, `buildQueue`, `parseFrontMatter`, `listClaims` from
  `queue.mjs`, which it does not edit): `heartbeat --slug --session` (§4.7, exit 3 on a live foreign driver),
  `heartbeat-age --slug` (ms or `none`), `next --slug --repo … [--cap 6] --json` → ordered actions: answer an open
  round, review `in-review` lanes, fix forward a lane whose head has a failed check (max 3, then park), build `ready`
  lanes whose `depends_on` are `done` up to the cap, else `wait`/`done`. Parallel rule enforcement: cap 6 lanes
  `executing|in-review` per plan; two candidates whose `paths` match the same hot pattern (`supabase/migrations/**`,
  `DATABASE_SCHEMA.md`, `src/App.tsx`, `**/screens.json`, `**/exclusions.json`, `apps/mobile/parity/ledger.json`,
  `src/i18n/*/<ns>.json`, `CLAUDE.md`) → only the lower lane id starts; a plan of 1 lane with ≤ 3 files → no fan-out.
- `TEST-SUITE.yml`: gateway as matrix `shard: [1,2,3,4]`, `fail-fast: false`, `npx jest --silent --maxWorkers=100%
  --shard=${{ matrix.shard }}/4 --json --outputFile=…`, job name `Gateway (Jest, shard N/4)` (consumers of the old name
  found by grep keep working); `gateway-shard-union` job (`if: always()`): `npx jest --listTests` vs the union of the 4
  JSON results — any missing or duplicate file fails; the existing rollup job keeps its name `Test Suite Summary`
  (`TEST-SUITE.yml:97-99`), its `needs` becomes `[gateway, gateway-shard-union, services]` and it fails when any of
  them is not `success` (a skipped/cancelled shard or union counts as failure). Branch protection: the only required
  status check on `main` is `validate` (read via `GET /repos/…/branches/main/protection/required_status_checks`,
  2026-10-20) — unchanged, no TEST-SUITE job name is in it, so the rename cannot open a required-check gap. The merge
  rule (§7b, C, the land step) treats "checks green" as **every** check run on the head (all four shards, the union and
  the summary), not only required ones. Nothing new skipped.
- `TEST-SUITE-RERUN.yml`: on `workflow_run` failure, attempt 1: `scripts/ci/test-suite/rerun-policy.mjs` reruns failed
  jobs once only when every failed job died before its test step or that step printed no Jest summary
  (`docs/DEPLOYMENT-PIPELINE.md:192`); a real red is never rerun.
- `PLAN-SPAR.yml`: one step "Wait for a sparring slot" before `Spar`: `scripts/ci/plan-spar-slot/slot.mjs --cap 2`
  (read-only `actions: read`; FIFO by run id; poll 20 s; give up after 90 min); skipped runs skip it. `paths`, round
  count, `MAX_SESSIONS`, partner chain unchanged.
- STAGING-VERIFY: `lib.cjs summarizeByVtid(results)` → `{VTID: passed|failed|not_attributed}` + smoke; `run.mjs` writes
  `record.per_vtid`. The run's outcome and rule 50 are unchanged.
- `CI-SCRIPTS-TEST.yml`: `node --test scripts/ci/test-suite/ scripts/ci/plan-spar-slot/` on PRs touching them.
- `docs/validation/<VTID>/staging-tests.json`: GET `/alive`; `existing` `npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts`.
- Tests (red on base): `plan-driver.test.mjs` (heartbeat create/fast-forward/same tree; foreign fresh tip exit 3, stale
  tip taken over; `heartbeat-age none`; `next` order; dependency not done → not built; 8 ready → 6; 6 active → 0; two
  migration lanes → one; small task → no fan-out; `done` after Gate 2); `shard-union.test.mjs` (missing, duplicate,
  exact; static TEST-SUITE checks); `rerun-policy.test.mjs` (install fail → rerun; Jest fail → no; attempt 2 → no;
  cancelled → no); `slot.test.mjs` (0/1 older → start; 2 older → wait; younger ignored; skipped holds no slot; static
  PLAN-SPAR check); `lib.test.cjs` `summarizeByVtid` (one suite fails → that VTID failed; smoke fails → all failed;
  unattributed); H0 test green against current `index.html`.

## 6. Bootstrap (this plan only)
These lanes touch governance paths that today's Lane scope and PM guard allow only for `executor: claude` and a
`claude` review (`queue.mjs:180,471,479`; `act.ts:170-173`). For THIS plan the lane fields are set as today's validators
require: lanes on a governance path today (`steering-rules`, `plan-spar-allocation`, `scope-check`, `exceptions-seat`,
`pipeline-speed`) carry `executor: claude`; every lane carries a Kiro `seat` and a different Kiro `reviewer_seat`
(legacy) plus `reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)`. **Kiro builds all eight** under the owner's
instruction of 2026-10-20 ("no more approvals, you run it end to end"), recorded as a collaboration.md §7b
owner-directed merge instruction for the named set: this plan's `plan(` PR and every lane PR of this plan (both repos,
fix-forward PRs included): merge to `main` + staging auto-deploy only; the PM merges if it acts first. Acceptance comes
from the reviewer agent (§4.1/§4.2), never from another Kiro seat; the review entry is committed by the calling Kiro
session under the legacy `reviewer_seat` id.
**Merge authority, one table (R1-F2):**
| Who merges | Path | When |
|---|---|---|
| PM (C, once live) | gateway safe-merge | non-workflow lanes only; safe-merge's `BLOCKED_FILE_PATTERNS` refusal of `.github/workflows/` (`github-service.ts:709-748`) is final for the PM and is never worked around by the PM |
| Kiro land step | `gh pr merge` (no `--admin`) | any lane of this plan incl. the workflow-file lanes D/H, under the §7b owner instruction above, when every check run on the current head is green |
| Kiro land step | `gh pr merge --admin` | only when the one red check is **Lane scope** and its log shows solely the executor/governance/reviewer rule (`queue.mjs:180,471,479`) or "lane file not found" because the spec is not on `main`; the run log is linked in `merges.md` |
`--admin` is a GitHub branch-protection override; it does not call safe-merge and is not used to get past safe-merge's
workflow refusal (the PM simply never merges D/H). It is never used for any other red: a failing test, build,
typecheck, PR-GATE verdict, TEST-SUITE shard/union, STAGING-VERIFY, or a Lane scope error naming a path outside the
lane's `paths` or a §4.3 protected file without this owner instruction. Each merge is logged (lane log + `merges.md`:
owner-instruction reference, which row, reason, merge SHA). Protected gate
files changed by this plan (`CLAUDE.md`; `plan-spar.mjs`; `queue.mjs`, `protected-gate-files.json`, `PR-GATE.yml`;
`project-manager/governance.ts`; `.kiro/agents/vitana-lane-reviewer.md`; `PLAN-SPAR.yml`) are covered by the owner's
explicit instruction for this plan only, each logged. The `plan(` PR is merged to `main` right after convergence (lanes
then read their files from `main`). Lane `steering-rules` lands first; the others build in parallel and land after it,
one merge at a time (merge lock), each updated to latest `main` and green on that head. `staging-proof` is merged by the
PM in fallback mode (§5 F). Production stays forbidden.
Pre-existing red: while `main` itself fails a check on the same test (the `vtid-05077` pin, until H0 lands), a lane
whose only red is that identical failure waits (stays accepted, rechecks after `main` changes) instead of spending fix
attempts; it never merges over it.

## 7. Parallel execution rule (text in A §8a; enforcement in C and H)
1. Lanes run in parallel by default; the plan declares the real `depends_on` and the shared files. 2. Caps: PLAN-SPAR at
most 2 sessions in flight repo-wide (H slot step; Bedrock quota is shared with production, 6 at once all failed
`deadline_exceeded`); build lanes at most 6 per plan (H driver; C never reassigns into a plan at the cap). 3. Serialized
landing: before merge a lane is brought up to date with latest `main` and its required checks re-run on that head; one
merge per repo at a time (C one merge per tick + `update_branch`; the driver/land step merge lock). 4. Hot files are
sequenced, never parallel: migrations (timestamp order), `DATABASE_SCHEMA.md`, `src/App.tsx`, `screens.json` /
`exclusions.json`, the parity ledger, i18n shards of the same namespace, `CLAUDE.md` (H driver). 5. One staging deploy at
a time (already: `AWS-STAGE-DEPLOY-GATEWAY.yml:103-105`); a STAGING-VERIFY failure is attributed per lane via
`per_vtid` (H). 6. A small task (1 lane, ≤ 3 files) runs as a single agent, no fan-out. 7. Interfaces between lanes are
defined in the plan (as §4 here), not by the agents.
Shared files in this plan: none (each file has exactly one owning lane). Text-only cross references (no merge order):
A names the tokens of §3/§4; E's `driver.md` names H's CLI; G's workflow names E's `driver.md` and A's
`vitana-pipeline.md`. Real dependencies: `pm-fallback → scope-check` (so `protected-gate-files.json`, the `Collab
handoff` check and the `pm-agent` exemption are on `main` before C's `governanceMergeAllowed` can merge; until C is on
`main` the old claude-only guard `act.ts:170-173` stays in force); `staging-proof → all`.

## 8. Tests, commands and test plan
Every lane runs its checks locally before each push and records commands + counts in its evidence:
- gateway lanes (C, F, H0) in `services/gateway`: `npx jest <changed test files>`, `npm run typecheck`, `npm run build`;
  plus `npm run test:operator` for PM changes (C).
- collab lanes (B, D, E, H): `node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs` plus the
  lane's own new test file(s) (`automations.test.mjs`, `plan-driver.test.mjs`); D also `queue.mjs scope-check` and
  `validate` on its branch. On Windows the base already fails `queue.test.mjs` "programme registry" (`C:\C:\` path);
  compare against base.
- G and A: `node --test scripts/ci/kiro-steering/guard.test.cjs`, `node scripts/ci/kiro-steering/guard.cjs .` (both
  repos for A); A also `node scripts/collab/queue.mjs validate --base origin/main --head HEAD`.
- H CI scripts: `node --test scripts/ci/test-suite/ scripts/ci/plan-spar-slot/ scripts/ci/staging-verify/lib.test.cjs`;
  shard sanity `npx jest --listTests` count = sum of the 4 `--shard` lists; changed workflow YAML parsed with the repo's
  YAML parser.
- New behaviour has a test that fails on base: each lane runs its new tests against an `origin/main` checkout first and
  records the red output, then green (the PR-GATE red→green proof). Every speed change has its tests (§5 C3, H).
- Deploying lanes ship read-only `staging-tests.json`; STAGING-VERIFY must pass on the exact deployed commit before Gate 2.

## 9. Measurement
Per plan, `docs/validation/<plan VTID>/timings.json` (§4.6), quoted in Gate 2: convergence time, VTID time, per-lane
build / review / merge, staging-verify time, approved → verified total, merge-conflict count, STAGING-VERIFY failure
count. For THIS plan: lane F writes it from GitHub timestamps and the run's timing events; Gate 2 reports the measured
numbers and the projected time for a typical 8-lane plan after the change (estimate from H's investigation: ≈ 4-5 h any
day, from ≥ 9-10 h on a weekday and days over a weekend or with Claude down).

## 10. Risks
1. **The PM acts for real for the first time** once C is deployed to staging: it merges, reassigns, parks, PATCHes ledger
   rows and posts Gate 2 for every plan in the repo, not only this one. Mitigation: strict rules (accept on current head,
   checks green, one merge per tick, protected files blocked, safe-merge refuses `.github/workflows/`), staging only,
   M7 asserts no deploy/dispatch; the owner can stop it with `PM_MODE` in the task definition (Kiro cannot).
2. `main` is red (vtid-05077 pin) — every gateway lane waits until H0 lands (§6).
3. The gateway's GitHub token may lack permission to read repository variables (unverified) → the flag reads `null` and
   the 4 h rule decides; Claude has been absent for days, so the proof still runs in fallback.
4. The Operator Chat insert path for the Gate 2 poster is unverified (`operator_messages`); fail-open into `unavailable`
   and the `pm_digests` row; Gate 2 is also sent by the driver in the IDE.
5. Reviewer identity is self-asserted (all seats share the `exafyltd` GitHub identity); protected files, checks on head,
   base-revision permissions and the base checker bound it; a signed verdict is a follow-up.
6. Public `/mode` route (unauthenticated by design, §3).
7. Overlapping open work on the same files: `retire-claude-code` (#4210 `scope-rules`, rule lanes), `kiro-primary-executor`
   rule lanes, `collab-kiro-governance` `owner-governance`, #4215 (`plan-spar.mjs` other hunks), #4191, #4189. Whatever
   merges first, the later PR merges `main` and reconciles; nothing of theirs is edited or deleted here.
8. `claude-sonnet-5.5` model id not confirmed locally; the agent fails loudly, never substitutes.
9. Kiro Web: `gh` availability and the app.kiro.dev cron are not in git (owner setup facts; reported in Gate 2).
10. safe-merge refuses workflow-file PRs, so D and H are never PM-merged; in this plan they are merged by the Kiro land
    step with plain `gh pr merge` under the §7b owner instruction (§6 table; `--admin` only for the Lane-scope false
    positive, never for a workflow refusal); later workflow-file lanes need a §7b owner instruction or Claude.
11. Driver refs `collab-driver/<slug>` accumulate; pruned when a plan is `done` (driver's last action).
12. PLAN-SPAR on a large plan: standard class, cap 3 rounds; if it escalates, the owner is asked (the one allowed stop).

## 11. Unchanged
Sparring, the partner chain (Opus 4.6 → Sonnet 4.6 → DeepSeek), the standard round count and `MAX_SESSIONS`; the
`vtid_ledger` trigger and `_plan_sparring_gate_eval`; VTIDs only from CI PLAN-SPAR; STAGING-VERIFY outcome rules and
read-only staging tests; never test or write against production; production only by the owner's PUBLISH (or an explicit
"yes, deploy" pinned to the verified commit); `pmMode()` default; `/status` stays auth-gated; no ECS task-definition,
migration or `AWS-*` workflow change; no code before convergence and VTIDs.
<!-- plan:end -->
