# Vitana Self-Healing Automation Audit

**Repository:** `exafyltd/vitana-platform`
**Audited revision:** `fd3b42627d1e8b31cdad3ce94b6252400ac9f858` (`origin/main`, 2026-07-12)
**Production observations:** 2026-07-12, approximately 10:03 UTC (see "Observed state")
**Scope:** diagnosis only; no repository, production, database, IAM, or workflow state was changed.

---

## Executive conclusion

Vitana does not currently have one reliable self-healing system. It has several partially
overlapping loops — health collection, failure ingestion, diagnosis, Dev Autopilot
planning/execution, watchers, reconciliation, promotion, and repair-pattern storage — but the
contracts between them are weak and several loops fail before doing useful work.

The detection layer is alive. The repair layer is not reliable, the verification layer is not
authoritative, and the learning loop is not implemented. Production is nevertheless configured
as `FULL_AUTO` (level 4). That combination is unsafe.

**The single most consequential defect is new since June:** the staging-first CI/CD cutover
(2026-06-08) broke the deploy-detection contract that the repair pipeline depends on. Merged
autopilot fix PRs now deploy to **staging** and emit `staging.deploy.completed`, but the
watcher and reconciler still wait for the pre-cutover prod topics (`deploy.gateway.success`
etc.) and re-probe **production**, where the fix never lands. Every live repair therefore
times out in `deploying` after 30 minutes and is marked failed. This alone predicts the
observed 0% Dev Autopilot success rate. No amount of tuning elsewhere fixes self-healing while
this contract is broken.

The immediate recommendation is to place production in **DIAGNOSE_ONLY** (or at most
**SPEC_AND_WAIT**) until the P0 controls below are in place and a staging fault-injection test
passes end-to-end. Do not restore full autonomy by fixing individual cron errors alone. First
make execution durable, evidence complete, mutations authenticated, the deploy/verify contract
consistent with the staging-first pipeline, and verification authoritative.

---

## Observed state (production, 2026-07-12)

- Self-healing service health: `ok: true`.
- Configuration: `enabled: true`, autonomy level 4, `FULL_AUTO`.
- Seven-day self-healing results: 7 total, 1 fixed, 1 failed, 5 escalated; resolved rate `0.143`.
- Seven-day Dev Autopilot results: 4 total, 0 completed, 4 failed; success rate `0`.
- No active repair tasks.
- Latest successful scheduled scan: 1,783 files processed, 1,755 signals emitted, 0 new
  findings, 18 findings updated.

The API being healthy is not evidence that self-healing is healthy: the health endpoint
measures process availability, while the outcome metrics show the repair pipeline is largely
ineffective. Every one of these numbers is explained by a specific code defect below (see
"Why the numbers look like this").

---

## How the system actually works (verified map)

**Detection (external, survives restarts):**
- `DAILY-STATUS-UPDATE.yml` (hourly cron) → `scripts/ci/collect-status.py` probes services →
  `POST /api/v1/self-healing/report` — the primary detection entry.
- `E2E-ORB-MONITOR.yml` (every 15 min) → on Playwright failure posts a synthetic "down" report.
- `DEV-AUTOPILOT.yml` (07:00 + 19:00 UTC) → `dev-autopilot-scan.mjs` → `POST /api/v1/dev-autopilot/scan`.

**Repair (in-process, dies with the gateway instance):**
- `/report` → dedup/circuit-breaker → pre-probe → `beginDiagnosis()` → `generateAndStoreFixSpec()`
  → `injectIntoAutopilotPipeline()` → `dev_autopilot_executions` row → in-process executor tick
  (30 s) runs the LLM → PR → watcher ticks (60 s) watch CI/merge/deploy/verify → reconciler
  (10 min) sweeps stale state.
- All of these loops are `setInterval`/`setTimeout` timers inside the single gateway Cloud Run
  instance (`min-instances=1 --max-instances=1`, `EXEC-DEPLOY.yml:546-549`).

**Verification:** a 5-minute "no unrelated error events" window plus (when the finding has an
HTTP endpoint) one re-probe (`dev-autopilot-watcher.ts:768-798`). The snapshot/blast-radius
verifier exists but is only reachable via a manual route.

**Learning:** `repair_patterns` table + `repair-pattern-store.ts` — write path is manual-only,
feedback path is dead code (details in P1-10).

---

## Confirmed root causes — P0

### P0-1 — Mutation and operational-detail routes are exposed without route authentication

The self-healing router defines mutation handlers for report ingestion (`POST /report`),
kill-switch changes (`POST /kill-switch`), configuration changes (`PATCH /config`),
approval/rejection (`POST /approve`, `POST /reject`), verification (`POST /verify/:vtid`), and
rollback (`POST /rollback/:vtid`) with **no authentication middleware on the router or any
handler** (`services/gateway/src/routes/self-healing.ts`, entire file). The router is mounted
bare at `/api/v1/self-healing` (`services/gateway/src/index.ts:1226`). A code comment at
`self-healing.ts:733-737` explicitly documents the anonymous-by-design decision for the read
endpoints; the mutation endpoints inherited the same (absent) posture.

Anyone who can reach the gateway URL can: change the autonomy level to FULL_AUTO, disable the
kill switch, approve pending low-confidence repairs, inject fabricated health reports (which
allocate VTIDs, run LLM diagnosis, and can open PRs), and read `/history` — which returns
internal diagnoses, file paths, execution identifiers, and environmental failure reasons.

Note the asymmetry: both legitimate senders already authenticate —
`scripts/ci/collect-status.py:206-213` and `E2E-ORB-MONITOR.yml:60-66` send
`Authorization: Bearer $SERVICE_TOKEN` — the server just never checks it. The fix is
server-side only; no client changes needed.

**Required change**
1. Default-deny authentication/authorization middleware on the entire self-healing router.
2. `/health` unauthenticated only if Cloud Run needs it.
3. Narrowly scoped service identity for `/report` (validate the Bearer token clients already send).
4. Administrator role for config, kill switch, approve, reject, verify, rollback.
5. History and detailed metrics admin-only; a redacted aggregate status if a public status is required.
6. Append-only audit event (actor, token subject, request ID, old state, new state, reason)
   for every mutation.

Existing authenticated routes (`oasis-emit.ts`, `dev-autopilot.ts`, `screen-load-health.ts`)
provide patterns to consolidate into one `requireInternalServiceOrAdmin` middleware.

### P0-2 — Staging-first cutover broke the deploy/verify contract (primary cause of 0% autopilot success)

Since the cutover (2026-06-08), a merged autopilot PR triggers only `STAGE-DEPLOY.yml`, which
emits OASIS topic **`staging.deploy.completed`** (`.github/workflows/STAGE-DEPLOY.yml:307`).
The prod auto-deploy path that used to emit `deploy.gateway.success` is frozen by
`cutover_gate` (`AUTO-DEPLOY.yml:47-50`). But:

- the deploy watcher matches only `deploy.gateway.success` / `cicd.deploy.service.*`
  (`dev-autopilot-watcher.ts:244, 624`);
- the reconciler matches only `deploy.gateway.success, deploy.success, vtid.lifecycle.deployed`
  (`dev-autopilot-execute.ts:1987`).

Every live execution that merges therefore sits in `deploying` until the 30-minute reconciler
timeout and is marked **failed** ("no deploy success event observed after 30m in deploying",
`dev-autopilot-execute.ts:2014-2028`). Even if the topic matched, the post-deploy re-probe
targets **production** (`self-healing-probe.ts:11-12` defaults to
`https://gateway.vitanaland.com`; reconciler fallback hardcodes the prod Cloud Run URL at
`dev-autopilot-execute.ts:2064`), where the staged fix has not been published — so
verification would fail anyway. A 100% failure rate at the deploy stage post-cutover is
exactly what the code predicts.

No test covers the post-cutover event-topic contract, which is how this shipped undetected.

**Required change**
Decide the intended contract and implement both halves consistently:
- Teach the watcher and reconciler to accept `staging.deploy.completed` for the auto path, and
  point the verification re-probe at the **staging** base URL for staged fixes; treat
  production promotion (PUBLISH) as a separate, later verification step; **or**
- Treat "staged, verified on staging, awaiting PUBLISH" as the terminal success state of an
  auto-repair, with an explicit human promotion step.
Add a contract test that fails whenever deploy-event topics emitted by workflows and consumed
by watcher/reconciler diverge.

### P0-3 — Diagnosis uses two incompatible source models and fabricates high-confidence root causes

The diagnosis service fetches route source from GitHub when files are absent from the Cloud
Run image (`self-healing-diagnosis-service.ts:141-180`, sources `github_deployed_sha` /
`github_main`), but `resolveImportPath()` resolves imports **against the local container
filesystem only** (`:1159-1175`). In a source-less container, dependency analysis
(`:728-736`) therefore flags the *first relative import of every GitHub-fetched file* as
missing, and an override then forces `failure_class=IMPORT_ERROR` at **confidence ≥ 0.85**
(`:1024-1030`) — above every auto-approval floor.

This is the exact mechanism behind the observed production false diagnosis ("Import
`../services/orb-tools-shared` in `orb-live.ts` resolves to a missing file" — the file exists
at the audited revision), and it explains why identical incidents diverge into
fixed/failed/escalated outcomes. The env-var check (`:745-748`) has the same
universe-confusion: it tests the *gateway's own* `process.env` for variables used by whatever
service is being diagnosed.

**Required change**
One immutable `SourceSnapshot` abstraction pinned to the deployed Git SHA, implementing
`readFile`, `exists`, `resolveImport(fromPath, specifier, tsconfig)`, `listFiles`,
`getManifest`. All diagnostic rules use it; never mix GitHub content with container filesystem
checks. If the deployed SHA or dependency graph cannot be loaded, return `evidence_incomplete`
and **prohibit auto-repair**. Add a regression fixture for the `orb-live.ts` import, run in a
source-less container test.

### P0-4 — Full autonomy accepts low-confidence repairs (and the interplay is broken both ways)

`autoApproveFloor()` deliberately lowers the FULL_AUTO auto-approval floor to **0.5**;
AUTO_FIX_SIMPLE uses 0.8 (`self-healing-injector-service.ts:414-423`; codified in
`test/self-healing-full-auto-floor.test.ts`). Lowering the evidence threshold as autonomy
increases reverses the safety relationship that should exist. With a confirmed fabricated
diagnosis at confidence 0.85 (P0-3), even 0.8 is insufficient as a standalone gate —
confidence is a model output, not proof.

The 0.5 floor is also self-defeating: the injector assigns `risk_class='high'` to anything
below 0.7 confidence (`self-healing-injector-service.ts:56-60`), and the safety gate
hard-rejects high risk (`dev-autopilot-safety.ts:255-261`) — so every 0.5–0.7 diagnosis is
bridged and then deterministically blocked, then silently snoozed for 7 days (see P1-3).

**Required change**
Remove confidence-only approval. Automatic execution should require **all** of: an allowlisted
failure class and repair type; complete source evidence at the deployed SHA
(`evidence_incomplete` blocks); a deterministic reproduction or failing test contract; a small
computed blast radius; a generated *executable* rollback plan; a verified repair pattern with
prior successful staging outcomes **or** explicit human approval; all mandatory staging checks
green. Until this exists, run `DIAGNOSE_ONLY` or `SPEC_AND_WAIT`.

### P0-5 — Safety configuration fails open, in five separate places

An outage of the control plane must not increase authority. Today it does, repeatedly:

| Control | Fail-open behavior | Evidence |
|---|---|---|
| `isSelfHealingEnabled()` | returns `true` on non-OK response, empty row, or exception | `routes/self-healing.ts:76-82` |
| `getAutonomyLevel()` | returns `AUTO_FIX_SIMPLE` (level 3) on missing creds, error, no row, or parse failure | `routes/self-healing.ts:88-101` |
| Dedup + circuit breaker | `proceed: true` on any query error | `routes/self-healing.ts:154-157` |
| Emergency stop (`autopilot_execution_enabled`) | ARMED when row missing **and** when the DB read fails | `system-controls-service.ts:432-448, 119-141` |
| Dev-autopilot `kill_switch` | treated as not-armed on config query error | `dev-autopilot-watcher.ts:117-119` |
| PR-J self-healing terminal-write gate | on gate-check error, logs "allowing through" and writes success | `autopilot-controller.ts:1013-1015` |

**Required change**
Every autonomy-increasing control defaults **closed**: missing config, failed reads, and parse
errors resolve to OBSERVE/DIAGNOSE-only and emit a loud `self-healing.control_plane.degraded`
event. Kill-switch state should be cached with a bounded TTL so a brief Supabase blip doesn't
flap authority in either direction.

### P0-6 — Verification is not authoritative; "fixed" does not mean fixed

- `verifyFixWithBlastRadiusCheck` (snapshot diff + blast radius,
  `self-healing-snapshot-service.ts:161`) has **exactly one caller**: the manual
  `POST /verify/:vtid` route (`routes/self-healing.ts:1043`). The automated pipeline never
  invokes it.
- Automated `outcome='fixed'` is written by (a) the worker orchestrator on worker-reported
  success (`routes/worker-orchestrator.ts:44-69`) and (b) the reconciler when the linked
  execution reaches `completed` (`self-healing-reconciler.ts:453-503`). Neither re-probes the
  broken endpoint.
- The autopilot fallback reconciler `reconcileVerifying` completes an execution if **any**
  `verification_passed` / `vtid.lifecycle.completed` event exists platform-wide in the window
  — the query has no execution-id or VTID filter (`dev-autopilot-execute.ts:2038-2055`) — or
  if a bare `GET /alive` on the gateway returns 200 (`:2064-2092`). "The gateway is up" ≠
  "the fix works". This path then triggers `writeAutopilotSuccess` (a fresh `fixed` row at
  confidence 1.0) and the reconciler's success terminalization.
- Even the snapshot verifier, when it runs: if the target endpoint can't be resolved from
  `vtid_ledger` metadata, **any** endpoint that flipped healthy counts as success
  (`targetFixed = newlyFixed.length > 0`, `self-healing-snapshot-service.ts:229-231`), and it
  is a 30-second-later snapshot diff — correlation, not causation.
- Findings without an HTTP endpoint (most code fixes) pass verification on the
  "no unrelated error events for 5 minutes" heuristic alone (`dev-autopilot-watcher.ts:326-329`).

**Required change**
Verification must (1) re-probe the *specific* failing endpoint (or run the failing test
contract) (2) in the environment where the fix actually landed (3) scoped to this execution's
VTID, and (4) be the *only* writer of `outcome='fixed'`. Delete the unscoped event query and
the `/alive` fallback; a verification that cannot run is an escalation, not a success.

### P0-7 — The event loop silently loses dispatch events (cursor reset + disarmed advance)

- If the autopilot event-loop cursor is more than 1 hour old, it auto-resets to `now − 60 s`
  (`autopilot-event-loop.ts:870-881`) — after any gateway outage/deploy gap > 1 h, everything
  emitted in the gap is skipped, including `autopilot.task.spec.created` dispatch events for
  self-healing repairs.
- When execution is DISARMED, the loop skips processing but **advances the cursor past the
  events** (`:900-910`). Re-arming does not replay; the work is permanently dropped.
- The only safety net is the reconciler's 1-hour stale sweep — which runs in the **same
  process** (see P1-13) and whose redispatch path has its own race (P1-1).

The reconciler's own header (`self-healing-reconciler.ts:5-8`) admits this failure mode
("the autopilot event loop's cursor slipped past the spec.created event").

**Required change**
Consume events transactionally: the cursor only advances past an event when it has been
processed or explicitly parked. Disarmed = pause consumption (cursor holds), never skip.
Cursor reset must re-scan for unprocessed dispatch events (query by processed-marker, not by
time).

---

## Confirmed defects — P1

**P1-1 — Reconciler stale-scan races in-flight executions → duplicate parallel dispatch.**
`fetchStaleRows` selects every `outcome='pending'` row older than 60 min with no exclusion for
VTIDs whose `dev_autopilot_executions` row is still non-terminal
(`self-healing-reconciler.ts:79-94`). Normal executions routinely exceed 60 min (the
`verifying` state alone is allowed 60 min, `dev-autopilot-execute.ts:1672`), so the scan
redispatches the spec via `/api/v1/worker/orchestrator/route` (`:112-186`) while the original
execution is still running — violating the one-VTID-one-worker rule and producing the
fixed-and-escalated divergence described in P1-8.

**P1-2 — Rollback is fictional, and it corrupts task metadata.** `executeRollback`
(`self-healing-snapshot-service.ts:361-470`) writes log rows, pings GChat ("Requires
EXEC-DEPLOY workflow or manual Cloud Run traffic shift"), and emits a misleading
`self-healing.rollback.completed` event — but shifts no traffic and reverts no commit. Its
`vtid_ledger` PATCH (`:441-449`) **replaces the whole `metadata` object**, destroying
`metadata.endpoint` / `metadata.source` — which the dedup query
(`routes/self-healing.ts:117`) and target-endpoint resolution
(`self-healing-snapshot-service.ts:213-227`) depend on. Separately, PR auto-revert is
silently stubbed when the GitHub token is missing or DRY_RUN is on: `revertExecutionPR`
returns `ok:true` with a fabricated URL (`dev-autopilot-bridge.ts:293-299`) — the mechanism
behind the documented 530-PR flood (`dev-autopilot-bridge.ts:24-31`).

**P1-3 — Handoff drops repairs silently.** If `bridgeToAutopilotExecution` throws, the only
trace is `console.error` (`self-healing-injector-service.ts:581-583`) — no OASIS event, no log
row; the VTID stays `scheduled` forever. If the safety gate blocks an auto-approved bridge,
the finding is **snoozed for 7 days** with no notification (`dev-autopilot-execute.ts:514-538`),
and the activation reaper cannot recover injector-created recommendations because it only
scans `status='activated'` (`:2882-2886`) while the injector creates them as `'new'`.

**P1-4 — Watcher/executor DRY_RUN defaults diverge.** The watcher defaults to DRY_RUN unless
`DEV_AUTOPILOT_WATCHER_LIVE=true` while the executor defaults to live
(`dev-autopilot-watcher.ts:43-46` vs `dev-autopilot-execute.ts:89`). In that state the
executor opens real PRs and the watcher *synthesizes* CI-pass/merge/deploy/complete after 90
seconds (`watcher.ts:385-410, 646-658, 720-734`) — false "completed" runs with real PRs
stranded open. The file's own header (`:32-42`) admits this stranded every real PR once.

**P1-5 — Blast-radius check fails on any unrelated platform noise.** Verification fails if
*any* `status='error'` OASIS event from an unrelated VTID lands in the 5-minute window (only
`dev_autopilot.*`, `self_healing.*`, `cicd.*` topics are excluded,
`dev-autopilot-watcher.ts:288-330`). On a noisy platform this fails verification near-always
and each failure spawns triage children and retries.

**P1-6 — Execution is not durable.** Execution runs as an in-process fire-and-forget Promise
(`dev-autopilot-execute.ts:2344-2348`). A restart mid-flight leaves the row in `running` until
a 20-minute watchdog marks it failed (`:2158-2194`, hardcoding the wrong
`failure_stage:'ci'`), after which recovery is a full LLM re-run from scratch. The durable
Cloud Run Job runtime exists but defaults off (`DEV_AUTOPILOT_USE_JOB`, `:102`).

**P1-7 — Escalation never terminalizes; paused tasks leak.** `markEscalated` PATCHes
`vtid_ledger.status` but never sets `is_terminal` / `terminal_outcome`
(`self-healing-reconciler.ts:232-241`) — escalated VTIDs keep matching the reconciler scan
forever, and a late execution success flips an already-escalated incident to
`terminal_outcome='success'` (`:463-473`). Kill-switch activation pauses ledger rows
(`routes/self-healing.ts:531-541`) that nothing ever un-pauses, and `paused` is outside the
dedup filter (`:118`), so re-failures allocate duplicates.

**P1-8 — Same incident, divergent outcomes by design.** The injector dedupe key includes the
sha256 of nondeterministic Gemini spec text (`self-healing-injector-service.ts:35-37`), so two
reports of one outage produce different keys; the circuit breaker was raised from 2 to 5
attempts/24 h explicitly to accommodate the triage loop creating extra VTIDs per failure
(`routes/self-healing.ts:142-145`); metrics double-count (reconciler `fixed` on the original
row + a second `VTID-DA-*` `fixed` row at confidence 1.0 from `writeAutopilotSuccess`,
`dev-autopilot-execute.ts:1788-1848`), and `writeAutopilotSuccess` fires for *all* autopilot
executions (code-quality findings included), so `resolved_rate` measures general autopilot
throughput, not healing. `recovered_externally` counts as `escalated` (a failure) in metrics
while the ledger says `completed`.

**P1-9 — Probe semantics are inconsistent and blind.** The reconciler treats HTTP 200 as
recovered (`res.ok`, `self-healing-probe.ts:81` via `self-healing-reconciler.ts:96-104`) —
an SPA catch-all returning HTML 200 counts as recovery — while the pre-probe requires
2xx+JSON. Probes are single-shot unauthenticated GETs: auth-required or POST-only endpoints
can never probe healthy, so healthy endpoints get diagnosed, PR'd, and can never be observed
as recovered.

**P1-10 — The learning loop does not exist.** `recordPattern` is reachable only via a manual
admin route, documented as interim ("the post-success auto-record path lands in PR-L5.1",
`routes/repair-patterns.ts:8-10`); `markPatternOutcome` has **zero production callers**
(tests only); `success_count`/`failure_count` are never updated and quarantine is unreachable.
The one live reader (`routes/test-contracts-scheduled.ts:243`) queries an effectively empty
table; a wrong manually-recorded `fix_diff` would be re-embedded into every future spec for
its signature indefinitely.

**P1-11 — Triage children bypass every gate.** `createFreshVtidFromTriageReport` allocates
VTIDs by read-max-then-insert (race, bypasses the allocator gate) and tags them
`source='self-healing-triage-loop'` (`self-healing-triage-service.ts:388-457`), which matches
neither the dedup filter nor the reconciler scan (`metadata->>source=eq.self-healing`) —
parent and child can run concurrently against the same endpoint and nobody watches the child.

**P1-12 — E2E UI failures masquerade as endpoint outages.** `E2E-ORB-MONITOR.yml:54-82`
reports a Playwright widget failure as `/api/v1/orb/health` down with `http_status: 0`. The
backend endpoint is usually healthy, so this either burns a pre-probe `recovered_externally`
or drives diagnosis of the wrong layer entirely.

**P1-13 — Single-instance, in-process control plane.** Event loop (2 s), executor ticks
(30 s), watchers (60 s), and the reconciler (10 min) are all timers in one Cloud Run instance
pinned to `max-instances=1`. The safety net for an in-process loop is another in-process loop
in the same process. Every deploy/restart interrupts all of them simultaneously (and P0-7
means the gap is then skipped, not replayed).

**P1-14 — The vcaop healing orchestrator is dead code.** A second, well-specified self-healing
orchestrator (`services/vcaop/src/healing/orchestrator.ts`) is invoked only by its own tests;
`VCAOP-HEALTH.yml` runs a jest suite and opens `vcaop-health` GitHub issues that nothing
consumes. Conceptual duplication with zero runtime effect — fold its good invariants
(guardrail failures never auto-healed, bounded attempts, escalate+freeze) into the gateway
pipeline and delete or de-scope the rest.

---

## Defects — P2 (fix opportunistically)

- Spec "quality gate" gates nothing: score computed (default 0.5 on error), stored, ignored;
  `spec_status='validated'` set unconditionally (`self-healing-spec-service.ts:582-596, 525-550`).
- Scanner findings frozen at first insert (severity/message never refreshed on re-see);
  no closure path when a signal disappears; rollup fingerprint collides with pre-existing
  single-file findings (cluster payload silently discarded); line numbers in fingerprints
  cause duplicate findings on code drift (`dev-autopilot-synthesis.ts:142-145, 347-383, 472-495`).
- Reconciler bridges failures with non-canonical `failure_stage` strings
  (`'deploying'`/`'verifying'`/`'merging'`), so per-stage retry thresholds never apply
  (`dev-autopilot-execute.ts:1852, 2028, 2105`; `dev-autopilot-bridge.ts:91-110`).
- Hardcoded prod gateway URLs in scheduled workflows and services (`DEV-AUTOPILOT.yml:32`,
  `DAILY-STATUS-UPDATE.yml:22`, `E2E-ORB-MONITOR.yml:49,57`, `self-healing-reconciler.ts:38-41`,
  `dev-autopilot-execute.ts:2064`) — violates the repo's own "never hardcode URLs" rule and is
  part of why post-cutover verification points at the wrong environment.
- `dev_autopilot_signals` grows unbounded (~3.5k rows/day); `/history/classes` scans up to
  10,000 rows per request in-process (`routes/self-healing.ts:700-716`).
- In-loop 30 s sleep in the watcher merge path serializes the whole tick
  (`dev-autopilot-watcher.ts:498`).

---

## Why the numbers look like this

| Observation | Explanation |
|---|---|
| Dev Autopilot 4/4 failed | P0-2: post-cutover deploy-topic mismatch → every merged fix times out in `deploying` (30 min) → failed. Verification re-probe targets prod where staged fixes never land. |
| Self-healing 5/7 escalated | P1-1/P1-7: 60-min stale sweeps escalate rows whose executions are still in flight or whose endpoints can't probe healthy (P1-9); `recovered_externally` also lands as `escalated` (P1-8). |
| 1 "fixed" | Not trustworthy: `fixed` can be written without the endpoint ever being re-probed (P0-6), and double-counting inflates it (P1-8). |
| Scanner: 1,755 signals, 0 new findings | Undrained queue steady-state: dedup matches findings sitting in `status IN ('new','snoozed')`, so every scan just bumps `seen_count`; nothing closes stale findings and (with empty `auto_approve_scanners`, default) nothing drains the queue. |
| "No active repair tasks" while FULL_AUTO | The pipeline fails before sustained execution: 0.5–0.7-confidence bridges are deterministically blocked+snoozed (P0-4), dispatch events get dropped (P0-7), and everything else dies at the deploy stage (P0-2). |

---

## Remediation plan

### Phase 0 — Today, configuration only (no code)

1. **Drop autonomy to DIAGNOSE_ONLY** (`PATCH /config` → `autonomy_level: 1`). Prefer this
   over the kill switch: kill-switch activation pauses ledger rows into the P1-7 black hole.
2. Confirm `auto_approve_enabled=false` and empty `auto_approve_scanners` in
   `dev_autopilot_config` (defaults are already safe — verify they haven't been changed).
3. Verify `DEV_AUTOPILOT_WATCHER_LIVE` and executor DRY_RUN flags are **consistent** (both
   live or both dry) to close the P1-4 trap.
4. Restrict ingress or add a temporary edge rule for `/api/v1/self-healing/*` mutations until
   P0-1 ships.

### Phase 1 — Make the system safe and truthful (P0s; ~1–2 weeks)

Order matters; each item is independently shippable:

1. **Auth middleware** on the self-healing router (P0-1) — smallest diff, largest exposure cut.
   Validate the Bearer token clients already send.
2. **Fail-closed controls** (P0-5) — invert the five fail-open defaults; add the
   `control_plane.degraded` event.
3. **Deploy/verify contract fix** (P0-2) — accept `staging.deploy.completed`, re-probe on
   staging for staged fixes, define "healed" as *verified on the environment where the fix
   landed*; add the workflow↔consumer topic contract test.
4. **Authoritative verification** (P0-6) — endpoint-scoped, execution-scoped, sole writer of
   `outcome='fixed'`; delete the unscoped event query and `/alive` fallback; wire
   `verifyFixWithBlastRadiusCheck` into the automated path.
5. **Transactional event consumption** (P0-7) — processed-markers instead of time cursor;
   disarm = hold, not skip.
6. **SourceSnapshot** (P0-3) — pinned-SHA source model; `evidence_incomplete` blocks
   auto-repair; regression fixture for the `orb-live.ts` case.
7. **Autonomy gate rework** (P0-4) — monotonic floors (FULL_AUTO ≥ 0.8, never below lower
   levels), allowlisted failure classes, and the multi-condition execution checklist.

### Phase 2 — Make execution durable and single-tracked (P1s; next)

- Exclude VTIDs with non-terminal executions from the stale sweep (P1-1); deterministic dedupe
  keys (endpoint + failure_class + deployed SHA, not spec text) (P1-8).
- Terminalize on escalation; add an un-pause path; include `paused` in dedup (P1-7).
- Real rollback: PR revert + staging redeploy via the existing governed workflows; stop
  emitting `rollback.completed` for a notification; stop clobbering `metadata` (use
  merge-patch) (P1-2).
- Persist bridge failures as escalations, not console lines; notify on safety-gate snooze
  (P1-3).
- Move the executor to the Cloud Run Job runtime by default (`DEV_AUTOPILOT_USE_JOB=true`)
  and/or externalize tick scheduling to Cloud Scheduler → HTTP so restarts don't drop the
  control plane (P1-6, P1-13).
- Probe with correct method/auth per endpoint and require N consecutive healthy probes;
  unify on `isJsonHealthy` everywhere (P1-9).
- Route E2E UI failures to a UI-failure class (or their own pipeline), not synthetic endpoint
  outages (P1-12). Govern triage-child VTIDs through the allocator and tag them
  `source='self-healing'` so dedup/reconciliation see them (P1-11).
- Fix metrics: one incident = one outcome row; `recovered_externally` is its own outcome, not
  `escalated`; scope autopilot outcome rows out of self-healing resolved-rate (P1-8).

### Phase 3 — Close the learning loop, then re-arm autonomy

- Auto-record a repair pattern **only after authoritative verification passes** (the missing
  PR-L5.1); wire `markPatternOutcome` into verification results; enable quarantine on
  failures; make signatures deterministic (normalize error text).
- Add a **staging fault-injection test**: deliberately break a canary route
  (`/api/v1/canary-target` exists for exactly this, `index.ts:1227-1231`), let the full loop
  detect → diagnose → fix → verify on staging with zero human input, and assert every state
  transition. This is the gate for raising autonomy.
- Re-arm ladder: DIAGNOSE_ONLY → SPEC_AND_WAIT (after Phase 1) → AUTO_FIX_SIMPLE for
  allowlisted classes with verified patterns (after Phase 2 + fault-injection pass) →
  FULL_AUTO only with the P0-4 checklist enforced in code.
- Scanner hygiene: closure pass for disappeared signals, refresh-on-reseen, drop line numbers
  from fingerprints, cap/rotate `dev_autopilot_signals` (P2s).

### Acceptance criteria before returning to FULL_AUTO

1. Anonymous request to any self-healing mutation endpoint returns 401/403.
2. All five fail-open controls verified fail-closed (pull Supabase creds in staging; autonomy
   must degrade, not escalate).
3. Staging fault-injection test passes end-to-end ≥ 3 consecutive times, including one run
   with a mid-execution gateway restart.
4. `outcome='fixed'` provably implies the target endpoint (or test contract) was re-verified
   post-deploy in the environment where the fix landed.
5. A deliberately false diagnosis (regression fixture from P0-3) is blocked as
   `evidence_incomplete`, never auto-executed.
6. Metrics dashboard shows one row per incident with a truthful outcome taxonomy.

---

## Finding index

| ID | Severity | One-line summary |
|---|---|---|
| P0-1 | P0 | Self-healing mutation/config/history routes have no authentication |
| P0-2 | P0 | Staging-first cutover broke deploy-event + verification-environment contract (0% autopilot success) |
| P0-3 | P0 | Dual-source diagnosis fabricates IMPORT_ERROR at confidence 0.85 |
| P0-4 | P0 | FULL_AUTO lowers auto-approve floor to 0.5; 0.5–0.7 band also deterministically blocked+snoozed |
| P0-5 | P0 | Five autonomy controls fail open on missing config or DB errors |
| P0-6 | P0 | Verification not authoritative: unscoped events / bare `/alive` can mark repairs "fixed" |
| P0-7 | P0 | Event-loop cursor reset + disarmed advance silently drop dispatch events |
| P1-1 | P1 | Stale sweep redispatches VTIDs with in-flight executions (parallel duplicate repair) |
| P1-2 | P1 | Rollback is notification-only, emits false `rollback.completed`, clobbers ledger metadata; revert stubbed without token |
| P1-3 | P1 | Bridge failures console-only; safety-gate blocks silently snooze findings 7 days |
| P1-4 | P1 | Watcher DRY_RUN default ≠ executor default → synthetic completions, stranded real PRs |
| P1-5 | P1 | Blast-radius verification fails on any unrelated platform error event |
| P1-6 | P1 | Execution is a fire-and-forget in-process Promise; restart = 20-min zombie + full re-run |
| P1-7 | P1 | Escalation never terminalizes; kill-switch-paused VTIDs leak forever |
| P1-8 | P1 | Nondeterministic dedupe keys, double-counted metrics, `recovered_externally` counted as failure |
| P1-9 | P1 | Probe semantics inconsistent (HTML-200 = recovered in reconciler); auth/POST endpoints never probe healthy |
| P1-10 | P1 | Learning loop unimplemented: manual-only writes, dead feedback path, unreachable quarantine |
| P1-11 | P1 | Triage-child VTIDs bypass allocator, dedup, and reconciliation |
| P1-12 | P1 | E2E UI failures reported as synthetic backend endpoint outages |
| P1-13 | P1 | Whole control plane = in-process timers in one Cloud Run instance |
| P1-14 | P1 | Second (vcaop) healing orchestrator is dead code with an unconsumed output |
| P2-* | P2 | Quality gate decorative; scanner freeze/closure/fingerprint defects; non-canonical failure stages; hardcoded URLs; unbounded signals table |
