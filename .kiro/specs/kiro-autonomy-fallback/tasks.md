# Tasks — kiro-autonomy-fallback
Authoritative plan: `plan.md` (between the plan markers). Lane files: `lanes/`. VTIDs: allocated by CI PLAN-SPAR after
policy approval, one per lane; never by hand. Every lane: branch `kiro/kiro-autonomy-fallback/<lane-id>`, PR title
`VTID-xxxxx (kiro-autonomy-fallback/<lane-id>): …`, trailers `Collab-Session` + `Collab-Lane` on every commit, identity
`kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/` (`commands.log` with every
command and pass/fail counts, red-on-base output for every new test). Acceptance below is what the reviewer agent
`vitana-lane-reviewer` (claude-sonnet-5.5) checks the PR diff against.

<!-- lane: steering-rules -->
## Lane `steering-rules` — rule text first (vitana-platform + vitana-v1 mirror)
- [ ] A1 `.claude/rules/collaboration.md`: intro, §2, §3, §3a, §5, §7, §7a, §7b (PM merge rule), §8 (continuous plan
      driver), new §8a (Parallel execution, plan §7 items 1-7), new §8b (Measurement, plan §4.6), §9 — as plan §5 A.
- [ ] A2 `CLAUDE.md` roles paragraph replaced by the exact sentence in plan §5 A (platform L121-125, v1 L102-106).
- [ ] A3 steering: `vitana-kiro-notes.md` (delete the VTID-05192 bullet, CI sparring, use the v1 wording of L10 in both
      repos), `vitana-load-project-rules.md`, `vitana-standing-rules.md` (:6-7), `vitana-collaboration.md` (title only),
      new `vitana-pipeline.md` (always included, no front matter, owner-addition text of plan §5 A).
- [ ] A4 vitana-v1 mirror PR (same VTID, same files): `collaboration.md` byte-identical to platform; `CLAUDE.md` roles
      paragraph; the same five steering files.
**Acceptance:**
- `collaboration.md` sha256 equal in both repos and stated in both PR bodies.
- The text names exactly: `CLAUDE_AVAILABLE` (only `false` = unavailable) and the 4 h rule of plan §3; exceptions seat
  `exafyltd`; the §4.1 trailers (`Collab-Review` = lane key, `Collab-Verdict`, `Collab-Reviewer: agent:vitana-lane-reviewer
  (claude-sonnet-5.5)`, `Collab-Reviewed-Head`); the §4.3 protected list verbatim; heartbeat ref
  `collab-driver/<slug>`, ≤ 15 min, alive < 45 min; caps 2 (PLAN-SPAR) and 6 (lanes per plan); `timings.json` path
  and fields of §4.6.
- §7a still forbids: hand VTID allocation, production deploys, live-system writes from session tools, accepting one's
  own lane; allows only §7b merges and re-runs of failed PLAN-SPAR / PR-GATE / STAGING-VERIFY (attempt 1).
- No steering file in either repo says "implementer", "Claude merges", "next_actor: claude" as the default hand-off, or
  "ask the owner before" git/push/PR/merge/re-run/VTID.
- `vitana-pipeline.md` has no front matter and no `#[[file:.claude/rules/…]]` link; `guard.test.cjs` and `guard.cjs .`
  green in both repos; `queue.mjs validate --base origin/main --head HEAD` green.
- Nothing outside the lane's paths; no other `CLAUDE.md` line changes; deploys nothing (no staging suite needed).

<!-- lane: plan-spar-allocation -->
## Lane `plan-spar-allocation` — VTID retry in CI
- [ ] B1 Extract `allocateLanes` (bind only while `session.vtid` is null; adopt an orphaned bound VTID; per-lane
      try/catch; idempotent per lane; fix the `:248` comment).
- [ ] B2 `step()` branch `allocate_retry` for a converged, policy-approved session with lanes lacking `vtid`
      (verifies the live session: producer, verdict, `policy_approved_at`, `final_plan_hash`); no-op = zero writes.
- [ ] B3 Approval block: `verdict.md` lists all lane VTIDs; `handoff.md` `next_actor: kiro` + `reason:
      lanes_missing|allocation_pending`; `claude` only when allocation is off; partial failure exits 0.
- [ ] B4 Tests in `plan-spar.test.mjs` (plan §5 B list).
**Acceptance:**
- `node --test scripts/collab/plan-spar.test.mjs scripts/collab/queue.test.mjs` green; each new test recorded red on
  `origin/main`; existing tests `:83-128` unchanged and green.
- A second PLAN-SPAR run on the same state never allocates twice and writes nothing when every lane has a VTID.
- `sparring_id` + `plan_hash` sent at most once per session; no change to `PLAN-SPAR.yml`, gateway, migrations, round
  count or partner chain.
- Diff limited to `scripts/collab/plan-spar.mjs`, `plan-spar.test.mjs` and the lane's own `docs/validation/<VTID>/`.

<!-- lane: pm-fallback -->
## Lane `pm-fallback` — the PM acts, falls back to Kiro, merges on the agent review, sends Gate 2
- [ ] C1 `governance.ts` (protected) + review types; rewire `decide.ts:78-81` and `act.ts:170-198`.
- [ ] C2 `claudeAvailability`, `ObservedClaude`, `EXCEPTIONS_SEAT`; reassign / park `to_actor`.
- [ ] C3 Speed: no-driver timers 2 h / 4 h, Gate 2 parked-sibling fix and per-lane `gate2_sent`, tick 120000,
      one merge per repo per tick, `update_branch`, `verify` (W1), `merge_plan`, cap-6 reassign guard.
- [ ] C4 `ledger` decision + `LedgerWriter`.
- [ ] C5 Gate 2 evidence extension, `RunViewGate2EvidenceResolver`, `OperatorChatGate2Poster`, `timings.ts`.
- [ ] C6 Live seams: `PgLeaseManager`, `GithubObserver`, `GithubRepoFileWriter` (W1/W2), `loop.ts startPmLoop`;
      `index.ts:1877-1903` calls it.
- [ ] C7 Routes: `/status` fields; public `/mode`.
- [ ] C8 Tests T1-T26 and mutations M1-M7 of plan §5 C.
- [ ] C9 `docs/validation/<VTID>/staging-tests.json` (plan §5 C item 9).
**Acceptance:**
- In `services/gateway`: `npx jest test/project-manager` green (the 77 base tests still pass, updated only where the
  plan changes a value: tick default, reasons), `npm run test:operator` green, `npm run typecheck` clean,
  `npm run build` green; every T/M case present and recorded red on base (guards marked).
- M1 holds for every entry of `scripts/collab/protected-gate-files.json`; `PROTECTED_GATE_GLOBS` is a compiled-in constant (runtime never
  reads the JSON); only the parity test reads that file and fails when it is absent.
- `/mode` answers 200 without a token with exactly `ok, enabled, mode, executor_mode` (no `claude_available` /
  `claude_reason`); `/status` still 401 without a token and carries `claude`, `fallback`, `last_lease`.
- No deploy, dispatch or allocate call reachable from any new decision kind (M7); `pmMode()` default unchanged; no
  workflow, migration or task-definition file changed.
- Diff limited to the lane's paths; `index.ts` change confined to the PM block.

<!-- lane: scope-check -->
## Lane `scope-check` — governance by the reviewer agent, lanes from the open plan( PR, Collab handoff check
- [ ] D1 Constants, `SESSION_RE` agent form, `agentOf`, `sessionId('agent:vitana-lane-reviewer')`,
      `scripts/collab/protected-gate-files.json` (= plan §4.3).
- [ ] D2 `validateLane` / `validateRegistry` agent reviewer + protected rule.
- [ ] D3 `scopeCheck`: `fetchPlanLane` (ci-plan-spar commit of a qualifying plan PR), trusted-source PERM fold-back,
      path rule, review rule, `pm-agent` exemption (also in `validateRange`), `commitsInRange` new trailers.
- [ ] D4 CLI: `findPlanPr`, `ghPlanLaneFetcher`, `--plan-repo`.
- [ ] D5 `PR-GATE.yml`: job `Collab handoff` (`node --test scripts/collab/*.test.mjs` + `validate`); `lane-scope` with
      `GH_TOKEN` and the base revision's `queue.mjs`.
- [ ] D6 Tests T1-T17 of plan §5 D.
**Acceptance:**
- `node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs` green (Windows: only the base-known
  "programme registry" failure); each new test recorded red on base; existing `:340-422`, `:492-517` unchanged.
- An `executor: kiro` lane changing `CLAUDE.md`, `queue.mjs`, `plan-spar.mjs`, `PR-GATE.yml`, `PLAN-SPAR.yml` or any
  other §4.3 entry is refused whatever its reviewer; a governance file passes only with `reviewer_seat:
  agent:vitana-lane-reviewer` from a trusted source.
- A gh failure in `ghPlanLaneFetcher` never produces a pass (fail closed).
- PR-GATE has a check run named exactly `Collab handoff`; the YAML parses; vitana-v1 untouched.
- Deploys nothing; diff limited to the lane's paths.

<!-- lane: exceptions-seat -->
## Lane `exceptions-seat` — Claude's jobs to exafyltd; automations as wake-ups; Kiro Web driver
- [ ] E1 `.kiro/automations/exafyltd.md`: exceptions seat intro, order E1, W, E2-E6, A, B, C; sections `### Exceptions`
      and `### Wake a driver (W)`; rerun allowlist; setup cron.
- [ ] E2 `exafy.md`, `jtadic.md`: order W, A, B, C; the same W section; steps 6/9 without `next_actor: claude`.
- [ ] E3 `docs/programs/areas.yaml` `exceptions_seat: exafyltd`; `routine-prompt.md` header.
- [ ] E4 `.kiro/pipeline/driver.md` (Kiro Web continuous driver, plan §5 E).
- [ ] E5 `scripts/collab/automations.test.mjs` (plan §5 E checks).
**Acceptance:**
- `node --test scripts/collab/automations.test.mjs scripts/collab/queue.test.mjs` green; the new test recorded red on
  base; `queue.mjs validate` green (areas.yaml still parses for `validateRegistry`).
- Every automation still does at most one item per run; none merges, deploys, dispatches a workflow (only the
  allowlisted `gh run rerun`), applies a migration or hand-allocates a VTID.
- No automation hands work to `next_actor: claude`; a `done` lane is never reopened (fix-forward = new lane).
- `driver.md` uses the plan §4.7 heartbeat and does not depend on subagents.
- Deploys nothing; diff limited to the lane's paths.

<!-- lane: staging-proof -->
## Lane `staging-proof` — proof run in fallback mode
- [ ] F1 Precondition check (other seven lanes on `main`, `pm-fallback` deployed to staging, `CLAUDE_AVAILABLE=false`,
      staging `/status` read once with the service token shows `mode: live` and `last_lease: acquired`; plan §5 F).
- [ ] F2 `services/gateway/test/kiro-autonomy-fallback-proof.test.ts`.
- [ ] F3 `docs/validation/<VTID>/staging-tests.json` (plan §5 F).
- [ ] F4 After Gate 2: `zero-claude-proof.md` and the plan's `timings.json` (plan §4.6, §4.9) in a docs-only follow-up.
**Acceptance:**
- `npx jest test/kiro-autonomy-fallback-proof.test.ts`, `npm run typecheck`, `npm run build` green in `services/gateway`;
  the test recorded red on base.
- The PR is merged by the PM (`Collab-Session: pm-agent` W1 commit and `[pm.decision] merge` evidence), not by the
  land step; STAGING-VERIFY passes on the merge commit with `/mode` reporting `kiro_fallback`.
- `zero-claude-proof.md` lists every step from the plan PR's first commit to Gate 2 with actor id, evidence link and
  SHA, and shows no `session_…` actor; `timings.json` has every §4.6 field (null where unavailable).
- Staging tests read-only (GET or `rejected_probe`); nothing aimed at production.

<!-- lane: reviewer-agent -->
## Lane `reviewer-agent` — reviewer agent + pipeline recipe
- [ ] G1 `.kiro/agents/vitana-lane-reviewer.md` (plan §5 G).
- [ ] G2 `.kiro/pipeline/README.md`, `common-rules.md`, `planning.md`, `lane-code.md`, `lane-review.md`,
      `lane-land.md` (generalized from this run's runbooks).
- [ ] G3 `.kiro/workflows/vitana-pipeline.workflow.json` (input: owner task text) + `.kiro/hooks/vitana-pipeline-start.json`.
- [ ] G4 `guard.cjs checkAgents` + `guard.test.cjs` fixtures.
**Acceptance:**
- `node --test scripts/ci/kiro-steering/guard.test.cjs` and `node scripts/ci/kiro-steering/guard.cjs .` green; red on
  base recorded; the guard stays green in a repo without `scripts/collab/queue.mjs` (v1 shape).
- Agent: `model: claude-sonnet-5.5`; no write/web/MCP tool; shell allow-list read-only; `model_unavailable` self-check;
  output exactly plan §4.2 and §4.1; protected files are blocking for agent-only acceptance.
- The workflow recipe passes Kiro's workflow schema validation (validation only, no launch) and pins the review steps
  to `vitana-lane-reviewer` / `claude-sonnet-5.5`; parallel lanes capped at 6; merge lock serialized.
- Pipeline runbooks contain no slug-specific text and no instruction to ask the owner outside Gate 2 / an escalated verdict.
- Deploys nothing; diff limited to the lane's paths.

<!-- lane: pipeline-speed -->
## Lane `pipeline-speed` — driver, shards, sparring slots, per-lane attribution, unblock main
- [ ] H0 Fix the stale test pin in `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212` to the
      served `index.html:32` pin (test is stale, plan §5 H0), keeping every assertion; no-op if `main` already has it.
- [ ] H1 `scripts/collab/plan-driver.mjs` + `plan-driver.test.mjs` (heartbeat, heartbeat-age, next, caps, hot files).
- [ ] H2 `TEST-SUITE.yml` 4 shards + union job; `TEST-SUITE-RERUN.yml` + `scripts/ci/test-suite/{shard-union,rerun-policy}.mjs` + tests.
- [ ] H3 `PLAN-SPAR.yml` slot step + `scripts/ci/plan-spar-slot/slot.mjs` + test.
- [ ] H4 `scripts/ci/staging-verify/lib.cjs summarizeByVtid`, `run.mjs record.per_vtid`, `lib.test.cjs`.
- [ ] H5 `CI-SCRIPTS-TEST.yml`; `docs/validation/<VTID>/staging-tests.json`.
**Acceptance:**
- `node --test scripts/collab/plan-driver.test.mjs scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs`,
  `node --test scripts/ci/test-suite/ scripts/ci/plan-spar-slot/ scripts/ci/staging-verify/lib.test.cjs` green; each
  new test recorded red on base.
- On the PR's own TEST-SUITE run the four shards plus `gateway-shard-union` are green and the union equals
  `npx jest --listTests` (1,730+ files, none missing or duplicated); no test skipped that is not skipped on base.
- Rerun policy never reruns a job whose Jest step printed a summary; at most one rerun.
- PLAN-SPAR: `paths`, round count, `MAX_SESSIONS`, partner chain unchanged; slot step before `Spar`, cap 2.
- STAGING-VERIFY outcome logic unchanged (only `per_vtid` added).
- H0 changes no assertion other than the pin literal and adds the `app.js` chip assertion; `index.html` untouched.
- `Test Suite Summary` keeps its name and needs `[gateway, gateway-shard-union, services]`; required checks on `main` unchanged.
- Diff limited to the lane's paths; changed workflow YAML parses.
