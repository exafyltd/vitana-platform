# OASIS and VTID traceability: current trace path and design

- **Status:** Discovery and design only. Every statement below carries its own status class. Nothing here is implemented
  by this document; every change is a proposed follow-up (section 7).
- **Owner:** Project owner (approver); OASIS and delivery owners for each follow-up plan.
- **Pinned HEAD:** `exafyltd/vitana-platform` `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835` (origin/main). Every
  `path:line` citation below resolves at this commit (check in `docs/validation/VTID-05692/commands.log`).
- **VTID:** VTID-05692 (lane `strategy-execution-wave1/oasis-traceability`).
- **Plan:** `.kiro/specs/strategy-execution-wave1/plan.md` §4 item 2 (plan PR
  [#4942](https://github.com/exafyltd/vitana-platform/pull/4942), converged and approved by policy `converged-auto-v1`).
- **Reuses:** strategy repo `vitanaland-strategy/19-EXECUTION-PROGRAMME/OASIS-AND-VTID-INTEGRATION.md` (strategy commit
  `fb77090e1f`). Its claims were re-checked against the pinned HEAD; corrections are listed in section 8.

Status classes used: **Verified operational** (only with a run id), **Verified implemented, not operational**,
**Implemented but incomplete**, **Designed but not implemented**, **Deprecated/superseded**, **Unknown**.

## 1. Boundaries

- No new ledger, no new audit history, no new ID scheme. The design uses `vtid_ledger`, `oasis_events`, git trailers
  and refs, the GitLab webhook mappers and the Project Manager (PM) emit seam as they exist.
- The plan-sparring gate stays in its current mode. This document proposes no change to `plan_sparring_config`.
- This lane read code and GitHub metadata only (`gh api` GET). It wrote nothing to any database, gateway or other live
  system.

## 2. The identifier

The canonical identifier is `VTID-XXXXX`: the word `VTID`, a dash, five zero-padded digits.

| Fact | Evidence | Status |
|---|---|---|
| The sequence `global_vtid_seq` starts at 1000 | `supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql:65` | Verified implemented, not operational |
| `allocate_global_vtid(p_source, p_layer, p_module)` takes `nextval`, formats `'VTID-' \|\| LPAD(v_num::TEXT, 5, '0')` and inserts the shell row (status `allocated`, `metadata.source`) in one transaction | `supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql:82-126`; LPAD at `supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql:106`; insert values `supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql:129-149` | Verified implemented, not operational |
| `POST /api/v1/vtid/allocate` behind `requireLedgerWriteAuth`; the handler states it emits no OASIS event | `services/gateway/src/routes/vtid.ts:144-146` | Implemented but incomplete (no allocation event) |
| CI allocation: `allocateLanes` calls the route with `source: 'ci-plan-spar'`, `layer: 'DEV'`, `module` = slug in upper case (40 chars), binds the sparring id and plan hash on the first call only, and writes the VTID into the lane file | `scripts/collab/plan-spar.mjs:231-265`, call at `scripts/collab/plan-spar.mjs:251-252` | **Verified operational**: PLAN-SPAR run [42929814848](https://github.com/exafyltd/vitana-platform/actions/runs/42929814848) (success, 2026-11-11T00:14Z) on plan PR #4942; its commit `37a52d5ec0` (plan-spar[bot], 00:19:20Z) wrote VTID-05686 to VTID-05693, including this lane's VTID-05692 |
| No database constraint enforces the format or links `oasis_events.vtid` to the ledger: `oasis_events.vtid` is free `text`, and no migration declares `REFERENCES vtid_ledger` (0 matches) | `supabase/migrations/20251209000000_add_task_stage.sql:10-36`, column at `supabase/migrations/20251209000000_add_task_stage.sql:14` | Verified implemented, not operational |

Format checks in code disagree with each other:

| Check | Accepts | Evidence |
|---|---|---|
| PM ledger writer, resume pack, autopilot validator, GitLab mapper | exactly 5 digits | `services/gateway/src/services/project-manager/writers.ts:240`, `services/gateway/src/services/dev-memory/resume-pack.ts:22`, `services/gateway/src/services/autopilot-validator.ts:201`, `services/gateway/src/services/gitlab-events/mapper.ts:68` |
| VTID detail route | 4 or 5 digits, optional suffix, or `XXX-YYY-####-####` | `services/gateway/src/routes/vtid.ts:1180` |
| Execute and worker-orchestrator routes | 4 or more digits | `services/gateway/src/routes/execute.ts:143`, `services/gateway/src/routes/worker-orchestrator.ts:161` |
| Ops attention route | 4 or 5 digits | `services/gateway/src/routes/ops-attention.ts:61` |
| STAGING-VERIFY | 4 or 5 digits, padded to 5 | `scripts/ci/staging-verify/lib.cjs:108-114` |

### 2.1 Non-canonical values written as an event VTID (compatibility input)

Counted at the pinned HEAD with `git grep` (commands in `commands.log`):

| Value | Occurrences | Where | Kind |
|---|---|---|---|
| `SH-FALLBACK-<ms timestamp>` | 3 in 2 files: 1 in code, 2 in one test | `services/gateway/src/services/self-healing-diagnosis-service.ts:246-247`; `services/gateway/test/ops-action-required.test.ts` | Fabricated fallback when allocation fails. Never has a ledger row |
| `BOOTSTRAP-PUBLISH` | 5 in 2 files: 3 event writes, 2 in a CI guard (a comment and an allow-list entry) | `services/gateway/src/routes/operator.ts:2179`, `services/gateway/src/routes/operator.ts:2209`, `services/gateway/src/routes/operator.ts:2441`; `scripts/ci/command-hub-ownership-guard.js:305`, `scripts/ci/command-hub-ownership-guard.js:1052` | Fixed carrier for PUBLISH events |
| `BOOTSTRAP-DELIVERY` | constant at `services/gateway/src/services/delivery-host.ts:33`; used at `services/gateway/src/services/delivery-host.ts:124` and `services/gateway/src/services/gitlab-events/delivery-mapper.ts:342`, `:400`, `:586`, `:686` (same file) | GitLab delivery facts with no VTID | Fixed carrier |
| `BOOTSTRAP-STAGING-VERIFY` | 2 in the recorder | `scripts/ci/staging-verify/record-oasis.sh:35`, `scripts/ci/staging-verify/record-oasis.sh:56` | Fallback when the head commit subject has no VTID; the real VTIDs go to `metadata.vtids` |
| `BOOTSTRAP-AWS-STAGE-DEPLOY` | 1 in the workflow | `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1494` | Fixed carrier for staging deploy rows |
| All literal `vtid: '<value>'` properties in non-test `services/**/*.ts` | 698 in 188 files; 479 canonical, 219 not | method in `commands.log` | 219 = 67 `VTID-<suffix>` (for example `VTID-DEV-ASSIST`), 64 `VTID-` with 4 or fewer digits (legacy, for example `VTID-0541`), 42 `BOOTSTRAP-*` (22 distinct values in 15 files), 20 `SYSTEM`, 26 other strings |

A second, legitimate pattern exists: a canonical **carrier VTID** owns the event stream and the subject VTID sits in
`metadata`. Examples: `operator.kiro.branch_pushed` is written under `VTID-05006` with `for_vtid` in the payload
(`services/gateway/src/services/kiro/kiro-mcp-writes.ts:201-203`); production deploys are written under `VTID-03398`
(`.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml:1779`); STAGING-VERIFY writes `metadata.vtids`
(`scripts/ci/staging-verify/record-oasis.sh:44`). Readers already query by `metadata->>for_vtid`
(`services/gateway/src/services/project-manager/gate2.ts:213`) and `metadata->vtids`
(`services/gateway/src/services/project-manager/observe-live.ts:732`).

## 3. Writers of `oasis_events`

| Writer | What it does | Evidence | Status |
|---|---|---|---|
| `emitOasisEvent` | Service-role REST insert; copies `event.vtid` unchanged; adds actor, surface, task stage, env; refuses (loudly, once per topic) an event missing `source`, `status` or `message` | `services/gateway/src/services/oasis-event-service.ts:59`, payload `services/gateway/src/services/oasis-event-service.ts:101-124`, required-field precedent `services/gateway/src/services/oasis-event-service.ts:47-53` and `services/gateway/src/services/oasis-event-service.ts:92-99` | Verified implemented, not operational |
| Event ingest routes | `POST /api/v1/events/ingest`, `POST /events/ingest`, `POST /api/v1/oasis/events`; each inserts through REST itself; `vtid` only needs to be non-empty | `services/gateway/src/routes/events.ts:21`, `services/gateway/src/routes/events.ts:42`, `services/gateway/src/routes/events.ts:197`, `services/gateway/src/routes/events.ts:480` | Verified implemented, not operational |
| Workflows and CI scripts | Direct REST insert with the service role (staging deploy, production deploy, STAGING-VERIFY) | `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1490-1502`, `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml:1775-1787`, `scripts/ci/staging-verify/record-oasis.sh:63-66` | Verified implemented, not operational |
| Other services | 74 non-test files under `services/` reference `rest/v1/oasis_events` (reads and writes together; not split here) | method in `commands.log` | Unknown how many write |

Consequence for the design: a check inside `emitOasisEvent` covers one path. The ingest routes and the workflows
write around it.

Table liveness: the daily ledger-integrity alert reads both tables through the production gateway. Run
[42847789182](https://github.com/exafyltd/vitana-platform/actions/runs/42847789182) (success, 2026-11-10T15:46Z, head
`6dc6e1ba0c`) is **Verified operational** for "both tables exist and the check answers ok". It checks only one
fingerprint (false failures claimed by the worker-runner), not orphan VTIDs:
`supabase/migrations/20260806160000_vtid_03516_ledger_integrity_check.sql:49-90`, route
`services/gateway/src/routes/ops-health-checks.ts:313-320`, workflow `.github/workflows/ALERT-OASIS-LEDGER-INTEGRITY.yml:38-56`.

## 4. Current trace path, item by item

| Item | Where it is recorded today | Evidence | Status | Gap |
|---|---|---|---|---|
| Account and session | Session id `kiro-<seat>-YYYYMMDDHHMM-xxxx` (or Claude `session_…`, reviewer `agent-vitana-lane-reviewer-…`) stated in the first reply and carried as `Collab-Session` on every lane commit. Seat to account map in `docs/programs/areas.yaml`. OASIS has `actor_id`, `actor_email`, `actor_role`, `surface` columns, filled only for user or operator actions | `.claude/rules/collaboration.md:78-87`, `docs/programs/areas.yaml:14-18`, `supabase/migrations/20260214000000_oasis_actor_surface_tracking.sql:26-90` | Verified implemented, not operational | Session and seat are in git only. All Kiro accounts share one GitHub identity (`.claude/rules/collaboration.md:119-120`), so the commit author does not name the account; the trailer does |
| VTID | Ledger shell row from the allocator; lane front matter `vtid:` written by CI; PR title `VTID-xxxxx (<slug>/<lane>): …` | section 2; `.claude/rules/collaboration.md:111-114` | Verified operational for allocation (run 42929814848) | No OASIS event for allocation (`services/gateway/src/routes/vtid.ts:145-146`) |
| Repository and commit | Git: branch `kiro/<slug>/<lane>`, commits with `Collab-Session` and `Collab-Lane`, squash merge on `main`. OASIS gets `git_commit` only on deploy rows and `commit` on STAGING-VERIFY rows; GitLab events carry `head_sha`, `merge_sha` | `.claude/rules/collaboration.md:86-87`, `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1501`, `scripts/ci/staging-verify/record-oasis.sh:43`, `services/gateway/src/services/gitlab-events/delivery-mapper.ts:462-505` | Verified implemented, not operational | GitHub PR open and merge are not OASIS events: no GitHub webhook route exists in `services/gateway/src/routes/` |
| Execution start | Claim ref `refs/heads/collab-claim/<slug>/<lane>` pushed without force; lane `state: executing`; PM ledger writer moves the row from `allocated` or `scheduled` to `in_progress`/`approved` | `.claude/rules/collaboration.md:158-167`, `scripts/collab/queue.mjs:56`, `services/gateway/src/services/project-manager/writers.ts:239-249` | Implemented but incomplete | The PM loop is pinned off on staging (`PM_AGENT_ENABLED` `"false"`, `services/gateway/src/services/conversation/conversation-flag-pins.generated.ts:161`); production value Unknown. No OASIS event for a claim |
| Execution end | Lane `done` in git, claim released after closing records (`land-guard.mjs release`), driver heartbeat ref removed | `.claude/rules/collaboration.md:169-172`, `.claude/rules/collaboration.md:333-337` | Verified implemented, not operational | No OASIS event. No caller in `scripts/collab/**` or the PM terminalizes a lane VTID; `POST /api/v1/oasis/vtid/terminalize` exists (`services/gateway/src/routes/vtid-terminalize.ts:357`) and is called from the Command Hub, autopilot and ORB tools only |
| Lifecycle events | `vtid.lifecycle.*` topics in the closed `CicdEventType` union; terminalize emits them; the autopilot event mapper moves a VTID to `failed` on any `*.failed` or `*.error` event with status `error` | `services/gateway/src/types/cicd.ts:234-236`, `services/gateway/src/routes/vtid-terminalize.ts:604`, `services/gateway/src/services/autopilot-event-mapper.ts:488-497` | Verified implemented, not operational | Lane transitions are not lifecycle events. Any new emitter must keep the GitLab mapper's rule of never writing status `error` on a `.failed` topic (`services/gateway/src/services/gitlab-events/delivery-mapper.ts:37-39`) |
| Decisions | Sparring rounds, responses and verdict in `.kiro/specs/<slug>/sparring/`; Gate 2 "Decisions taken"; driver `decisions.md` in the local RUN folder (never committed); PM decisions as `[pm.decision]` log lines only | `services/gateway/src/services/project-manager/emit.ts:30-33`; `vtid.decision.watcher.*` topics exist for the watcher only (`services/gateway/src/types/cicd.ts:146-147`) | Implemented but incomplete | No PM decision reaches OASIS (section 5.3) |
| Evidence | `docs/validation/<VTID>/` (`acceptance.md`, `commands.log`, `scope.json`, `staging-tests.json`) in git | `scripts/ci/staging-verify/run.mjs:258-259` | Verified implemented, not operational | Not referenced from OASIS |
| Verification | Reviewer verdict as a review entry with `Collab-Verdict` and `Collab-Reviewed-Head` trailers; STAGING-VERIFY writes `staging.verify.passed\|failed\|superseded` with `vtid` = first VTID of the head commit subject (else `BOOTSTRAP-STAGING-VERIFY`) and `metadata.vtids` = VTIDs of every shipping commit | `.claude/rules/collaboration.md:89-105`, `scripts/ci/staging-verify/run.mjs:498-499`, `scripts/ci/staging-verify/record-oasis.sh:33-52` | Verified implemented, not operational (no STAGING-VERIFY run read in this lane) | Review verdicts reach OASIS only through the GitLab push mapper |
| Deployment | Staging: `staging.deploy.completed\|failed` under `BOOTSTRAP-AWS-STAGE-DEPLOY` with `git_commit`. Production: `prod.deploy.*` under `VTID-03398` with `git_commit` and free-text `reason`. PUBLISH: `production.publish.*` under `BOOTSTRAP-PUBLISH` | `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml:1483-1502`, `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml:1767-1787`, `services/gateway/src/routes/operator.ts:2179` | Verified implemented, not operational | Deploy rows link to a commit, not to the VTIDs it ships; the link is derivable from `git log` between commits |
| Outcome | Lane and plan `done` in git; Gate 2 recorded as a `pm_digests` `gate2_batch` row; ledger `is_terminal`/`terminal_outcome` only through the terminalize route | `services/gateway/src/services/project-manager/gate2.ts:240`, `services/gateway/src/routes/vtid-terminalize.ts:357` | Implemented but incomplete | Session VTIDs can stay non-terminal in the ledger while the lane is `done` |

### 4.1 This lane as a worked example

VTID-05692 today: allocated by PLAN-SPAR run 42929814848, which bound it to sparring session
`eb2d098e-9b2e-4f81-b61f-9517f4986e04` only if it was the first allocation of that run (the binding goes to the first
lane lacking a VTID, `scripts/collab/plan-spar.mjs:233-252`); written into the lane file by commit `37a52d5ec0`. Its
build, review, merge and closing records will exist in git. OASIS will hold, at most, a STAGING-VERIFY row naming it in
`metadata.vtids` if a deploying commit ships it; this lane deploys nothing, so OASIS will hold no row for it. The trace
is complete in git and the ledger, and empty in OASIS.

## 5. Design using only the existing systems

### 5.1 Linking `oasis_events.vtid` to `vtid_ledger`

| Option | Mechanism | Compatibility | Risk | Verdict |
|---|---|---|---|---|
| A. Validate on write in the writer | In `emitOasisEvent`, next to the existing required-field check (`services/gateway/src/services/oasis-event-service.ts:92-99`): classify `event.vtid` as canonical, carrier (`BOOTSTRAP-*`, `SYSTEM`, the legacy forms) or fabricated (`SH-FALLBACK-*`). First release only logs once per value and topic and adds `metadata.vtid_kind`; it rejects nothing. A ledger existence check uses one cached read per VTID | Writes stay byte-identical except one metadata key. Covers only `emitOasisEvent`; the ingest routes (`services/gateway/src/routes/events.ts:42`, `:197`, `:480` of the same file) and the workflows bypass it | Low in log mode. Reject mode would drop 219 literal call sites' events, most behind `.catch(() => {})`, so silently | Second step, log mode only |
| B. Foreign key | `oasis_events.vtid REFERENCES vtid_ledger(vtid)`, added `NOT VALID` | Every non-canonical value (section 2.1) and every canonical value without a row fails the insert. Historical rows unknown. A migration file whose name matches `supabase/migrations/*vtid_ledger*.sql` is a protected gate file (`.claude/rules/collaboration.md:139-145`); applying any migration needs owner approval because staging shares the production database | High: turns telemetry writes into failures; conflicts with the planned Aurora move | Not recommended now |
| C. Reconciler report | A read-only check beside `ci_ledger_integrity_check`: per day and per topic, count events whose `vtid` is canonical but has no ledger row, and events whose `vtid` is not canonical, grouped by prefix. Served through the existing ops health route pattern (`services/gateway/src/routes/ops-health-checks.ts:313-320`) and alert workflow pattern (`.github/workflows/ALERT-OASIS-LEDGER-INTEGRITY.yml:38-56`) | No write path changes. Needs one new SECURITY DEFINER read function (a migration file in a PR; applying it is an owner stop) | Low | **Recommended first.** It measures the real size of the problem before A or B is decided |

Pseudo-VTIDs under any option:

- `SH-FALLBACK-*` is the only fabricated value. The fix is in its writer: when allocation fails, emit under the
  canonical VTID that owns self-healing and put the failure in `metadata`, or fail loudly. Tracked in the autonomy risk
  register lane (plan §4 item 3).
- `BOOTSTRAP-*` and the other carriers move, one writer at a time, to the existing carrier pattern: the canonical VTID
  of the feature that owns the stream as `vtid`, the subject VTIDs in `metadata.vtids` or `for_vtid` (section 2.1). This
  uses VTIDs that already exist; it creates no new scheme.
- Legacy 4-digit values (`VTID-0541`) are historical ledger ids. Option C reports whether they have rows before anyone
  decides to keep or re-map them.

The plan-sparring gate is not part of this design. It runs on `vtid_ledger` inserts, not on events, and stays in its
seeded `log` mode (`supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql:117-123`; log mode never
blocks, `supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql:567-600`).

### 5.2 Session start, session end and lane state as OASIS events

The data exists in git. The design adds no store; it writes existing topics through existing writers.

1. **GitLab-hosted delivery: already designed and implemented.** The delivery stage maps a push to an agent branch
   (`kiro/`, `claude/`, `assist/`, `pm-agent/`, `services/gateway/src/services/gitlab-events/delivery-mapper.ts:86`) into
   `scm.gitlab.push` with `session` and `lane_key` from the head commit trailers
   (`services/gateway/src/services/gitlab-events/delivery-mapper.ts:595-610`), `delivery.review.recorded` per
   `Collab-Verdict` commit (`services/gateway/src/services/gitlab-events/delivery-mapper.ts:615-642`) and
   `delivery.lane.updated` per changed lane file with `slug`, `lane`, `change` and `session`
   (`services/gateway/src/services/gitlab-events/delivery-mapper.ts:645-668`). Status: Verified implemented, not
   operational (the mode is `live` only when `DELIVERY_HOST_<REPO>` is `gitlab`,
   `services/gateway/src/services/gitlab-events/delivery-mapper.ts:231-237`,
   `services/gateway/src/services/delivery-host.ts:52-54`; the deployed value is Unknown).
2. **GitHub-hosted delivery: a gap.** No writer records a GitHub push, PR or lane-file change. The PM observer already
   reads lane files, claim refs and driver heartbeats
   (`services/gateway/src/services/project-manager/observe-live.ts:13-14`,
   `services/gateway/src/services/project-manager/observe-live.ts:353-357`,
   `services/gateway/src/services/project-manager/observe-live.ts:418`). Proposed: the PM emits, through `emitOasisEvent`,
   the topic `delivery.lane.updated` (already in the union, `services/gateway/src/types/cicd.ts:1242`) when an observed
   lane `state`, claim holder or heartbeat changes, with the same payload keys as the GitLab mapper plus `host: 'github'`,
   `from_state`, `to_state`, `claim_session`, and a `dedupe_key` built the GitLab way so readers keep the first row per
   key (`services/gateway/src/services/gitlab-events/delivery-mapper.ts:23-25`). Claim appearing = session start for that
   lane; claim released or lane `done` = session end. `vtid` is the lane's canonical VTID, never a carrier. Status:
   Designed but not implemented.
3. Event status stays `info` or `success`, never `error`, so the lifecycle mapper's catch-all cannot move a VTID to
   `failed` (`services/gateway/src/services/autopilot-event-mapper.ts:488-497`).
4. Nothing is emitted while the PM loop is off, which is the pinned staging state today. Turning the PM on is an owner
   decision outside this plan.

### 5.3 What the PM emits today

- **To OASIS: nothing.** The emit seam `PmDecisionEmitter` has one implementation, `LoggingDecisionEmitter`, which
  prints `[pm.decision] …` and makes no network call (`services/gateway/src/services/project-manager/emit.ts:22-34`,
  default `services/gateway/src/services/project-manager/emit.ts:61-63`). The header explains why: the `pm.*` topic is not
  in the closed `CicdEventType` union (`services/gateway/src/services/project-manager/emit.ts:7-16`; union starts at
  `services/gateway/src/types/cicd.ts:139`).
- Decision kinds it would report: `merge`, `reassign`, `park`, `gate2`, `verify`, `update_branch`, `merge_plan`,
  `merge_bookkeeping`, `ledger` (`services/gateway/src/services/project-manager/types.ts:272-364`).
- Other records it writes: a `pm_digests` `gate2_batch` row (`services/gateway/src/services/project-manager/gate2.ts:240`),
  lane-file commits with `Collab-Session: pm-agent` (`services/gateway/src/services/project-manager/writers.ts:4`), and
  the ledger PATCH above.
- It reads OASIS: `staging.verify.passed` (`services/gateway/src/services/project-manager/observe-live.ts:732`) and
  `operator.kiro.*` (`services/gateway/src/services/project-manager/gate2.ts:213`).
- Proposed: register `pm.decision` in the union (outside the PM path, `services/gateway/src/types/cicd.ts`) and swap the
  default emitter for one that calls `emitOasisEvent` with `vtid` = the decision's lane or plan VTID. `merge`, `verify`,
  `merge_plan`, `merge_bookkeeping` and `ledger` carry `vtid`; `gate2` carries `vtids`; `reassign`, `park` and
  `update_branch` carry slug and lane, which resolve to the lane VTID through the observed lane file. Status:
  Designed but not implemented.

### 5.4 What GitLab events add

| Topic | Adds | Evidence |
|---|---|---|
| `scm.gitlab.merge_request.opened\|merged\|closed\|updated` | MR id, head SHA, merge SHA, queue label, lane key from the title | `services/gateway/src/services/gitlab-events/mapper.ts:114-120`, `services/gateway/src/services/gitlab-events/delivery-mapper.ts:270-330` |
| `scm.gitlab.pipeline.*` | CI start and result per commit | `services/gateway/src/services/gitlab-events/delivery-mapper.ts:49-55` |
| `scm.gitlab.push`, `delivery.review.recorded`, `delivery.lane.updated` | Session, review verdict and model, lane transitions (section 5.2) | `services/gateway/src/services/gitlab-events/delivery-mapper.ts:595-668` |
| `delivery.landed` | Merge SHA, reviewed head, verdict, reviewer, accept-to-land seconds from landing trailers | `services/gateway/src/services/gitlab-events/delivery-mapper.ts:93`, `services/gateway/src/services/gitlab-events/delivery-mapper.ts:462-505` |
| `staging.deploy.completed\|failed\|rolled_back` | Deploy result under the MR's VTID instead of a carrier (live mode only) | `services/gateway/src/services/gitlab-events/delivery-mapper.ts:529-531` |

An event whose MR title has no `VTID-\d{5}` is ignored with reason `no_vtid` for MR events
(`services/gateway/src/services/gitlab-events/mapper.ts:115`), but falls back to `BOOTSTRAP-DELIVERY` for pushes,
pipelines and tags (`services/gateway/src/services/gitlab-events/delivery-mapper.ts:400`, `:586` of the same file). Any
writer check (option A) must treat that carrier as known.

## 6. Target trace (after the follow-ups, still only existing systems)

| Item | Source of record | OASIS event (existing writer) |
|---|---|---|
| Account and session | git trailer `Collab-Session` | `delivery.lane.updated` / `scm.gitlab.push` payload `session` |
| VTID | `vtid_ledger` row | allocation event (follow-up F3) |
| Repository and commit | git | `scm.gitlab.*` payloads; PM lane events carry `commit_sha` |
| Start and end | claim ref, lane state | `delivery.lane.updated` with `from_state`/`to_state` |
| Lifecycle | ledger status | existing `vtid.lifecycle.*` via terminalize |
| Decisions | sparring files, Gate 2 | `pm.decision` (F4) |
| Evidence | `docs/validation/<VTID>/` | path in event metadata (no copy) |
| Verification | review entry, STAGING-VERIFY | `delivery.review.recorded`, `staging.verify.*` |
| Deployment | deploy workflows | `staging.deploy.*`, `prod.deploy.*` with `metadata.vtids` (F5) |
| Outcome | lane `done`, ledger terminal | terminalize after closing records (F6) |

## 7. Proposed follow-ups

Each needs its own `plan(` PR, sparring and VTID. None is started by this lane.

| # | Title | Files | Risk | Owner | Gate |
|---|---|---|---|---|---|
| F1 | Orphan and non-canonical VTID report (option C) | new read-only SQL function migration; `services/gateway/src/routes/ops-health-checks.ts`; new alert workflow beside `.github/workflows/ALERT-OASIS-LEDGER-INTEGRITY.yml` | Low; migration apply is an owner stop | OASIS owner | sparred plan; owner approval to apply the migration |
| F2 | VTID classification in `emitOasisEvent`, log mode (option A) | `services/gateway/src/services/oasis-event-service.ts` and its tests | Low | OASIS owner | sparred plan; F1 numbers first |
| F3 | Allocation event from the allocate route | `services/gateway/src/routes/vtid.ts` (`:144` handler), `services/gateway/src/types/cicd.ts` if a new topic is needed (`vtid.created` exists, `services/gateway/src/types/cicd.ts:213`) | Low | OASIS owner | sparred plan |
| F4 | PM decisions to OASIS through the emit seam | `services/gateway/src/types/cicd.ts`, `services/gateway/src/services/project-manager/emit.ts` | Low; `types/cicd.ts` is outside the PM lane paths | Delivery owner | sparred plan |
| F5 | Replace carrier strings with canonical carrier VTIDs plus `metadata.vtids` | `services/gateway/src/routes/operator.ts`, `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`, `scripts/ci/staging-verify/record-oasis.sh`, `services/gateway/src/services/delivery-host.ts`; `AWS-PROD-*` is a protected gate file | Medium: readers that filter on the old strings must move together | Delivery owner | sparred plan; owner instruction for the protected file |
| F6 | GitHub lane and session events from the PM observer (section 5.2) | `services/gateway/src/services/project-manager/` | Medium; PM is off on staging | Delivery owner | sparred plan; PM enablement is an owner decision |
| F7 | `SH-FALLBACK` removal | `services/gateway/src/services/self-healing-diagnosis-service.ts` | Medium (autonomy path) | Self-healing owner | autonomy-risks register first |
| F8 | One shared VTID format check for routes | the route files in section 2 | Medium: legacy 4-digit ids are still accepted on purpose by some routes | OASIS owner | sparred plan; F1 numbers first |
| F9 | Foreign key (option B) | migration on `oasis_events` | High | OASIS owner | only after F1, F5, F7 show zero orphans; protected gate file if named `*vtid_ledger*` |

## 8. Corrections to the strategy document

- The strategy document says the PM reads `operator.kiro.*` topics. Correct, and it also writes none: the emit seam only
  logs (section 5.3).
- The strategy document names one pseudo-VTID (`SH-FALLBACK`). The pinned HEAD has 219 non-canonical literal VTID
  values in service code plus workflow and script carriers (section 2.1).
- The strategy document marks allocation "Verified implemented, not operational". PLAN-SPAR run 42929814848 now
  proves the CI allocation path for this plan.
- The strategy document lists `emitOasisEvent` as the OASIS writer. It is one of several; the ingest routes and the
  workflows write around it (section 3).

## 9. Unchanged

All code, schemas, RLS, grants, flags, workflows, `CLAUDE.md`, the plan-sparring gate mode and PUBLISH behaviour. No
VTID was allocated or used by hand; no event or ledger row was written.
