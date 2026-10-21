# Responses to sparring session 2, round 3 (owner escalation decision)

Session `c48d3889-2318-40ca-bc26-b143274fd7b5`. Round 3 was the terminal escalation verdict (both
sessions escalated, `MAX_SESSIONS=2` and the standard 3-round cap reached), so the spar loop parked the
plan and surfaced R3-F1 and R3-F2 for the owner. The owner reviewed both and **accepted both** on
2026-10-21. This file records the accepted dispositions and the plan revision that implements them; a
fresh PLAN-SPAR pass runs on the revised plan (the round cap on this session is reached, so re-entry is a
new plan PR with a clean sparring chain — this PR's record is left intact).

- **R3-F1 (blocker, accepted).** The partner is right: `PLAN-SPAR.yml` has an explicit workflow-level
  `permissions:` block, and under GitHub Actions semantics an explicit block sets every unlisted scope to
  `none`. `statuses: write` was absent, so lane 5's `POST /repos/{owner}/{repo}/statuses/{sha}` would have
  received HTTP 403 at runtime. The "GITHUB_TOKEN carries statuses:write by default, no owner config"
  claim is true only when no explicit block exists — false here. Fix (in-lane code, not owner config):
  `statuses: write` is added to the `permissions:` block. The lane's proof test now asserts the block
  contains `statuses: write`. Plan lane 5, `tasks.md` T1 and the lane file pin it.

- **R3-F2 (major, accepted — option B).** The partner is right that lane 5 posted the
  `plan-spar/needs-rebase` status but nothing consumed it, and that the consumer the plan described lives
  in the gateway service (`services/gateway/src/services/project-manager/act.ts`), not in `scripts/ci/**`
  — so building it would need a staging deploy and contradict the plan's "deploys nothing" premise.
  Resolution per the owner: **option B.** Lane 5 is narrowed to **producer-only** — it posts the status on
  the bot head and nothing else; the proof test asserts ONLY the producer contract (the `statuses: write`
  permission and the status POST), with no consumer assertion. The lane now states explicitly that until
  the consumer is built the posted status has no effect and today's behaviour is unchanged. The consumer
  (the PM/land read in `act.ts` that calls `gh pr update-branch`) is **deferred to a separate gateway lane
  with its own staging deploy**, outside this plan's scope, and is listed for Gate 2 together with the
  `PLAN_SPAR_PUSH_TOKEN` PAT secret. Plan lane 5, `tasks.md` T2–T3 (+ acceptance), the lane file and the
  out-of-scope section pin this.

Owner also supplied corrected ground-truth test counts that supersede the brief's stale "~7.5k gateway /
4 shards": gateway Jest 1,737 suites / ~22,700 tests; vcaop 45 / ~290; vcaop-mcp 7 / ~58; vitana-v1 web
Vitest 444 / ~2,840; vitana-v1 mobile Jest 61 / ~650 (≈ 2,290 suites / ~26,500 tests total), plus ~50
Playwright/e2e specs and some shell/Python test scripts in vitana-platform that no required check covers
today. These are folded into the Today section (ground-truth counts), the speed lane (shard balance on
real counts), and the ci-health lane (the uncovered-test coverage gap becomes a standing signal).

No finding was rejected or deferred.

```json
[
  {"finding_id": "R3-F1", "disposition": "accepted", "rationale": "PLAN-SPAR.yml has an explicit permissions block, so every unlisted scope is none and statuses:write was missing - the status POST would 403. Added statuses:write to the block (in-lane code, not owner config). The lane-5 proof test asserts the block contains statuses:write. Plan lane 5 + tasks T1 + lane file pin it."},
  {"finding_id": "R3-F2", "disposition": "accepted", "rationale": "Option B (owner decision). Lane 5 narrowed to producer-only: post the plan-spar/needs-rebase status on the bot head; the proof test asserts ONLY the producer contract (statuses:write + the status POST), no consumer assertion. Lane states the status has no effect until the consumer is built; today's behaviour unchanged. The consumer (PM/land read in services/gateway/src/services/project-manager/act.ts calling gh pr update-branch) is a gateway change needing a staging deploy, deferred to a separate gateway lane outside this plan's deploys-nothing scope, listed for Gate 2 with the PAT secret. Plan lane 5 + tasks T2-T3 + lane file + out-of-scope section pin it."}
]
```
