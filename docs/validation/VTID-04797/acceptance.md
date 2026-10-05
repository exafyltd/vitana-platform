# VTID-04797 — Jev P2 A8: Dev Autopilot finding near-duplicate check, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 A8 (P2). Builds on VTID-04754 (shadow framework). Uses the existing
`finding_duplicate` decision (VTID-04473) unchanged.

Evidence (read-only, 60 days to 2026-10-01): 57 auto-archived `dev_autopilot` findings sat on only 13 files;
the scanner's exact-fingerprint merge cannot see the same problem reported twice in different words.

P2 note: the P1 gates have no production data yet (production has not been deployed since they merged), so
no P1 gate is switched to enforce in this phase; P2 adds the new gates in shadow first.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Gate `finding_dedupe` (`JEV_FINDING_DEDUPE_MODE`, exact values; anything else off). Off loads, asks and writes nothing.
  TEST: services/gateway/test/vtid-04797-finding-dedupe-gate.test.ts
AC-2: In shadow, after a new `dev_autopilot` finding is inserted, up to 3 live findings (new/snoozed/activated) on the same file — never the new row itself — are compared with it via `finding_duplicate`. Jev sees title, signal type, file path and summary (capped), never code. No candidate, no file path or no new row → nothing asked.
  TEST: services/gateway/test/vtid-04797-finding-dedupe-gate.test.ts
AC-3: One `jev_shadow_decisions` row per new finding (subject = its id): the closest candidate, its probability, duplicate at ≥ 0.75, how many compared; `system_action = inserted_as_new`. Jev unavailable → a fallback row; a throwing loader → nothing; never throws.
  TEST: services/gateway/test/vtid-04797-finding-dedupe-gate.test.ts
AC-4: The check runs only after the insert succeeded, never awaited; the scan, the insert, seen_count merge and rejected-fingerprint suppression are unchanged.
  TEST: services/gateway/test/vtid-04797-finding-dedupe-gate.test.ts
  TEST: services/gateway/test/dev-autopilot-synthesis.test.ts
AC-5: Both gateways pin `JEV_FINDING_DEDUPE_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04797-finding-dedupe-gate.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/gates/finding-dedupe-gate.ts (new)
- services/gateway/src/services/dev-autopilot-synthesis.ts (post-insert hook + two reads)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04797-finding-dedupe-gate.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04797/**

## OASIS

OASIS_IMPACT: none new. Each comparison emits the existing `jev.decision.*` event (source `jev:gate:finding_dedupe`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_FINDING_DEDUPE_MODE=shadow`. Scans behave exactly as before.

## Not in this PR

Agreement is read later by joining the row's subject id with how that finding ended (completed vs
rejected/auto-archived). Enforce (merging a near-duplicate into the live finding) comes after that data.
