# VTID-04802 — Jev P2 B5 + B4: self-healing deploy cause (no deploy seen, likely-cause commit), shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 B4, B5 (P2). Sits beside the B1–B3 pre-triage gates (VTID-04759, VTID-04799).

Evidence (read-only, 14 days to 2026-10-01): 299 `staging.deploy.completed` and 33 `prod.deploy.completed` events;
`prod.deploy.completed` carries `git_commit` and the previous commit (`rolled_back_to`), staging carries
`git_commit` only — so the range is taken from this environment's two newest deploy events.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `commit_cause_score` (telemetry, planes internal + system_autopilot, engineering roles): a 4-level score of how likely a deployed commit caused an error, from the error text, the endpoint, the commit subject and its file paths — never a diff.
  TEST: services/gateway/test/vtid-04802-selfheal-deploy-cause.test.ts
AC-2: Gate `selfheal_deploy_cause` (`JEV_SELFHEAL_DEPLOY_CAUSE_MODE`, exact values; anything else off). Off reads, asks and writes nothing.
  TEST: services/gateway/test/vtid-04802-selfheal-deploy-cause.test.ts
AC-3: B5 — no deploy-completed event of this environment's gateway in the 24 h before the incident (or none at all) → a rules row `no_deploy_seen`; no Jev call and no GitHub call.
  TEST: services/gateway/test/vtid-04802-selfheal-deploy-cause.test.ts
AC-4: B4 — a deploy in the window → the commits between the previous deploy's commit and this one (GitHub compare, newest first, at most 5, each with its file paths) are scored; one row with the ranking and the top commit. No previous deploy or no commits → a rules row; Jev unavailable → a fallback row; a throwing dependency → nothing; never throws.
  TEST: services/gateway/test/vtid-04802-selfheal-deploy-cause.test.ts
AC-5: Started before the triage LLM call and never awaited before it; the outcome is written after triage — agreed when the top commit scored "Likely" or higher and triage's affected component appears in its file paths; a weak score, B5 or no report → agreed null. Triage, B1–B3 and the self-heal bridge are unchanged.
  TEST: services/gateway/test/vtid-04802-selfheal-deploy-cause.test.ts
  TEST: services/gateway/test/vtid-04799-selfheal-pretriage.test.ts
  TEST: services/gateway/test/vtid-04759-selfheal-jev-gates.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-6: Both gateways pin `JEV_SELFHEAL_DEPLOY_CAUSE_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04802-selfheal-deploy-cause.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/deploy-cause-gate.ts (new)
- services/gateway/src/services/jev/jev-repository.ts (one read)
- services/gateway/src/services/github-service.ts (getCommitsBetween: compare + per-commit file paths)
- services/gateway/src/services/self-healing-triage-service.ts (start before triage, outcome after)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04802-selfheal-deploy-cause.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04802/**

## OASIS

OASIS_IMPACT: none new. Each commit score emits the existing `jev.decision.*` event (source `jev:gate:selfheal_deploy_cause`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_SELFHEAL_DEPLOY_CAUSE_MODE=shadow`. Triage runs exactly as before.

## Not in this PR

Enforce (proposing a revert of a "almost certainly the cause" commit to the operator) comes after the data.
