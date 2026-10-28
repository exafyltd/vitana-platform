# Tasks — operating-workflow
Authoritative plan: `plan.md` (between the plan markers). VTIDs: allocated by CI PLAN-SPAR after policy approval;
never by hand. Branch `kiro/operating-workflow/<lane>`, PR title `VTID-xxxxx (operating-workflow/<lane>): …`,
trailers `Collab-Session` + `Collab-Lane` on every commit, identity `kiro-agent[bot]`, no `Co-Authored-By: Claude`
trailer, evidence in `docs/validation/<VTID>/` (`commands.log` with every command and pass/fail counts,
`red-on-base.txt` for every new test, `scope.json`, `acceptance.md`, `plan-sparring.md`). Squash merge under §7b.
Acceptance below is what the reviewer agent `vitana-lane-reviewer` checks.

<!-- lane: pm-noop -->
## Lane `pm-noop` — vitana-platform (supersedes pm-reassign-idempotent/reassign-noop)
- [ ] P1 Tests first, red on base: `services/gateway/test/project-manager/reassign-idempotent.test.ts`,
      `reassign-seat.test.ts` (as in `.kiro/specs/pm-reassign-idempotent/plan.md` "Tests"), a `writeFile`
      unchanged-text test, and the wiring assertion `{name:"PM_AGENT_ENABLED", value:"false"}` in
      `kaf-staging-claude-available-wiring.test.ts`.
- [ ] P2 `writers.ts`: `laneChangeIsNoop` (compares `state`, mapped `next_actor`, `seat`, `claimed_by`, newest log
      body; never `updated:` or the heading time) before `applyLaneChange`, skip `put` on W1/W2, `writeFile` skips an
      unchanged text, `applyLaneChange` throws on any change of `seat`, `executor`, `reviewer_seat` or `paths`
      (R1-F3: Lane scope's PERM rule rejects such a pm-agent commit, `queue.mjs:678-684`); `act.ts` `write` → `'written'|'noop'`,
      `unchanged` status; `types.ts` `ActStatus` gains `'unchanged'`; `decide.ts` stale-ready target never
      `reviewer_seat` and never changes `seat` (no decision unless the target is `claude`, which keeps the seat).
- [ ] P3 `AWS-STAGE-DEPLOY-GATEWAY.yml:1225` → `"false"`.
- [ ] P4 `staging-tests.json` (`kind: existing`, the jest suites), `commands.log`.

**Acceptance**
- Change types: Backend, Infrastructure/CI
- Outcome: two PM ticks over the same lane write once, then nothing; no PM write changes a lane permission key (so
  none is rejected by Lane scope); a staging gateway deploy leaves `PM_AGENT_ENABLED=false`.
- Evidence includes a `queue.mjs scope-check` run over a fixture pm-agent commit that changes `seat` (error), showing
  the rejection path the guard avoids.
- `npx jest test/project-manager test/kaf-staging-claude-available-wiring.test.ts` green on head, new tests red on base.
- Only the lane paths change; the PM is not re-enabled anywhere; no test weakened.
<!-- lane: pm-noop -->

<!-- lane: ci-activity-guard -->
## Lane `ci-activity-guard` — vitana-platform
- [ ] A1 Tests first: `scripts/ci/ci-activity.test.mjs` with recorded API fixtures (thresholds, per-branch counts,
      p50/p95 queue time, identical-patch no-op detection, rate-limit headroom, workflow shape: cron, read-only
      permissions, no secret except `GITHUB_TOKEN`, no write call).
- [ ] A2 `scripts/ci/ci-activity.mjs` + `scripts/ci/ci-activity.json` (plan §7 thresholds), `ALERT-CI-ACTIVITY.yml`
      (cron `*/30`, `workflow_dispatch`, job summary, red above threshold), `docs/ci/ci-activity.md` (what each
      signal means; names ci-github-modernization `ci-health` as the report it complements).
- [ ] A3 Superseded-run cancel on `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` and `PHASE-2B-NAMING-ENFORCEMENT.yml`
      (`cancel-in-progress` only for `pull_request`; push runs on `main` never cancelled); a test asserts both blocks.
- [ ] A4 One dispatch of `ALERT-CI-ACTIVITY.yml` on the PR head (§7d) and its summary linked in `commands.log`.

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs
- Outcome: excessive CI activity or repeated no-op commits turn a scheduled run red with the table that explains why;
  superseded PR runs of the two biggest uncancelled emitters are cancelled.
- The workflow makes no write call and uses no secret but `GITHUB_TOKEN`; required check `validate` still reports on
  every PR head.
<!-- lane: ci-activity-guard -->

<!-- lane: policy-text -->
## Lane `policy-text` — vitana-platform
- [ ] T1 Test first: `scripts/collab/policy-consistency.test.mjs` fails on base for every §2.1 contradiction phrase it
      checks (e.g. "Production only by the owner's PUBLISH" outside §7c context, "never dispatches a workflow",
      "review: approve" as an acceptance in automations, "weekdays hourly", "the only owner stop is Gate 2", "exactly
      one question per plan") and requires every runbook stop list to point to `operating-policy.md`.
- [ ] T2 `.claude/rules/operating-policy.md` (plan §4 items 1-10, ≤ 9 KB, no `paths:`), `.kiro/steering/vitana-operating-policy.md`
      (`inclusion: always`, links it); `vitana-owner-autonomy.md` becomes a pointer; pipeline/kiro-notes/load-project-rules
      point to it for roles, stops and end points.
- [ ] T3 Replace the restated rules (C1-C17) in `collaboration.md` §3a/§7/§8, `.kiro/pipeline/{README,lane-review,lane-land,lane-code,planning}.md`,
      `hooks/vitana-pipeline-start.json`, `.kiro/automations/*.md` (reviewer B → request the reviewer agent; §7d
      dispatch; unattended merge per plan §4 item 6), `routine-prompt.md` (retired header + pointer),
      `docs/DEPLOYMENT-PIPELINE.md` (channels, change owner, "PR reviewed + approved" = reviewer-agent accept).
- [ ] T4 `kiro-web-steering.mjs` DRIVER_LINKS adds `lane-review.md` and `lane-land.md` (+ test); always-included
      total does not exceed today's (`--check` prints it; record before/after in `commands.log`).
- [ ] T5 `docs/collab/operating-policy-inventory.md` (plan §3 table, kept current by drivers), `docs/kiro/unattended-continuation.md`
      (plan §6 limitations).

**Acceptance**
- Change types: Tooling/docs
- Outcome: every session (Kiro Web, Kiro IDE, automations, Claude Code) loads one policy that answers who may do
  what, when to stop and the end point; each contradiction C1-C17 is resolved to the newer owner decision, with a
  file:line note per item in `acceptance.md`.
- Merges only after a Claude review on the current head or an owner instruction naming `operating-workflow` (R1-F1).
- No stop removed or weakened: the 13 stops, §7c, §7d migration rule, §3a protected files and every prohibition read
  as before; the unattended-merge change is named in the PR body as a governance decision.
- `node --test scripts/collab/*.test.mjs`, `node scripts/collab/kiro-web-steering.mjs --check`, preflight green.
<!-- lane: policy-text -->

<!-- lane: policy-text-v1 -->
## Lane `policy-text-v1` — vitana-v1
- [ ] V1 Byte-identical copies of the platform's `operating-policy.md`, `vitana-operating-policy.md`, the four steering
      files and `collaboration.md` from the merged `policy-text`.
- [ ] V2 `cmp` against the platform files recorded in `commands.log`.

**Acceptance**
- Change types: Tooling/docs
- Outcome: both repos load the same policy text.
- Every copied file is byte-identical to the platform file at `policy-text`'s merge commit.
- Merges only after a Claude review on the current head or an owner instruction naming `operating-workflow` (R1-F1).
<!-- lane: policy-text-v1 -->

<!-- lane: policy-claude-md -->
## Lane `policy-claude-md` — vitana-platform (protected gate file)
- [ ] M1 `CLAUDE.md`: Autonomy Contract, collaboration paragraph, rule 49 and the `send_later` paragraph become pointers
      to `operating-policy.md`; every absolute kept verbatim (no production testing, production safety, IF-THEN 26,
      rules 46-48, 50-55 unchanged); `.claude/skills/plan-sparring/SKILL.md` §6 the same.
- [ ] M2 `policy-consistency.test.mjs` (from `policy-text`) checks `CLAUDE.md` only when it no longer contains the
      marker `send_later` self check-in (so `policy-text` merges green while CLAUDE.md is unchanged); this lane removes
      the marker, so the test then covers CLAUDE.md; red/green recorded in `commands.log`.
- [ ] M3 Stop 3 message to the owner (five parts) with the diff, naming this plan.

**Acceptance**
- Change types: Tooling/docs
- Outcome: CLAUDE.md no longer contradicts the policy; nothing in Part 1 that protects production, data or the VTID
  gate changes meaning.
- Merges only after a Claude review on the current head or an owner instruction naming `operating-workflow`.
<!-- lane: policy-claude-md -->

<!-- lane: policy-claude-md-v1 -->
## Lane `policy-claude-md-v1` — vitana-v1 (protected gate file)
- [ ] N1 v1 `CLAUDE.md`: Autonomy Contract and collaboration paragraph → pointers; Gate 1 text names policy approval
      (`converged-auto-v1`); "when in any doubt" sentence kept, scoped to live writes as the policy reads it.
- [ ] N2 Same stop-3 message (one message covers both CLAUDE.md lanes).

**Acceptance**
- Change types: Tooling/docs
- Outcome: v1 CLAUDE.md agrees with the policy; the absolute rule against testing on production is unchanged verbatim.
- Merges only after a Claude review on the current head or an owner instruction naming `operating-workflow`.
<!-- lane: policy-claude-md-v1 -->

<!-- lane: review-independence -->
## Lane `review-independence` — vitana-platform (protected gate files)
- [ ] R1 Tests first: `scripts/collab/review-rule.test.mjs` (plan §10 cases), new cases in `queue.test.mjs`,
      `land-guard.test.mjs`, `store-review.test.cjs`, and gateway `review-rule-parity.test.ts`, `governance`,
      `observe-live`, `decide` tests.
- [ ] R2 `scripts/collab/review-rule.mjs` (requester, reviewer identity, lane-only review commit + verbatim review
      record, digest, current-head rule with merge-of-main patch-id tolerance); used by `queue.mjs` scope-check and
      `land-guard.mjs` (reads the entry itself); `store-review.cjs` writes the record and digest;
      `protected-gate-files.json` and both compiled-in copies (queue.mjs fallback, governance.ts) gain
      `scripts/collab/review-rule.mjs`, `scripts/collab/land-guard.mjs`, `.claude/rules/operating-policy.md`,
      `.kiro/steering/vitana-operating-policy.md` (R1-F1, R1-F2), parity test green.
- [ ] R3 PM: `governance.ts` + `observe-live.ts` mirror the rule (executing log includes `Collab-Lane` commit sessions;
      `Collab-Review-Requested-By` parsed); `decide.ts` self-review guard uses it.
- [ ] R4 Fallback: one retry cycle after ≥ 30 min, then park (driver record `Collab-Blocker: review_unavailable`).
- [ ] R5 `staging-tests.json` (`kind: existing`, the PM jest suites).

**Acceptance**
- Change types: Tooling/docs, Backend
- Outcome: a review counts only when an independent reviewer session, distinct from the requester and every builder
  session of the PR, accepted the PR's current change; a builder cannot produce a counting accept under its own id;
  a `main` merge that leaves the PR's own change identical keeps the accept, any other change voids it.
- Script and PM agree (parity test); no existing passing review entry on `main` becomes invalid retroactively for
  already-merged lanes (the rule applies to unmerged PRs).
- Merges only after a Claude review on the current head or an owner instruction naming `operating-workflow`.
<!-- lane: review-independence -->

<!-- lane: durable-driver -->
## Lane `durable-driver` — vitana-platform
- [ ] D1 Tests first in `plan-driver.test.mjs`: record trailers round-trip; `status`; `resume` reconciles push / PR /
      merge / dispatch / review intents against a fake GitHub and performs none twice; `planNext` skips a lane with an
      open intent; fix-forward count from intents.
- [ ] D2 `plan-driver.mjs` `heartbeat --next/--pending/--blocker/--intent/--done`, `status`, `resume`.
- [ ] D3 `driver.md` (Resume reads `status`/`resume`; Loop writes intents; Wait writes the record before ending; stop
      list points to `operating-policy.md`), `common-rules.md` rule 3 (RUN folder is a cache; blockers live in the
      record), rule 5 and 10 pointers.

**Acceptance**
- Change types: Tooling/docs
- Outcome: after any interruption the next session (interactive, DRIVER-WAKE or automation) knows the next action,
  pending checks and blockers from git alone and never repeats a push, PR, review entry, merge or dispatch.
- The heartbeat commit's tree still equals `origin/main^{tree}`; fast-forward only.
<!-- lane: durable-driver -->

<!-- lane: change-class -->
## Lane `change-class` — vitana-platform
- [ ] K1 Tests first: `change-class.test.mjs` fixtures for each exclusion of plan §8 and a light-eligible diff.
- [ ] K2 `scripts/collab/change-class.mjs --base --head [--json]` prints `light|standard` and the reasons.

**Acceptance**
- Change types: Tooling/docs
- Outcome: a planner can tell in one command whether a change may use the light path and which rule keeps it standard.
- It reads git only and changes no requirement; protected, governance, migration, deploy, UI-contract, Commerce,
  i18n and spoken-wording paths are never light.
<!-- lane: change-class -->

<!-- lane: workflow-validation -->
## Lane `workflow-validation` — vitana-platform
- [ ] W1 Tests first: `workflow-metrics.test.mjs` on recorded fixtures (completion, queue time, retries, regressions,
      owner interventions; `null` when a source is missing, never 0).
- [ ] W2 `scripts/collab/workflow-metrics.mjs --slug <slug> [--json]` (GitHub GETs and git only).
- [ ] W3 The interruption drill of plan §10 on this plan's own driver, with git/PR evidence.
- [ ] W4 `docs/validation/<plan VTID>/workflow-validation.md` + `timings.json` for this plan, with every metric per
      representative task and the owner interventions it needed (expected: the §3a stop for the protected lanes and
      the `KIRO_API_KEY` setup, nothing else).

**Acceptance**
- Change types: Tooling/docs
- Outcome: the owner can read, per real task, how long it took end to end, how long it queued, how often it retried,
  whether it regressed `main`, and every time the owner had to act.
- No live write; GitHub GETs only.
<!-- lane: workflow-validation -->
