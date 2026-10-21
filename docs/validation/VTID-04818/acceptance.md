# VTID-04818 — Jev P3 F: lesson novelty check before dev_agent_memory writes, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 F (learning loop, P3) — first slice.

Operator Console turns (VTID-04025) and Dev Autopilot agent runs (VTID-04223) extract up to three lessons each into
`dev_agent_memory` (≈ 230 gotchas / conventions / decisions / incidents in the 30 days to 2026-10-01). Nothing checks
whether a lesson is already stored, corrects a stored one, or is only true for that run.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `lesson_novelty` (telemetry, `pii: 'redact'`, planes internal + system_autopilot, engineering roles): is the candidate new and durable, and new / duplicate / update / too specific / not a lesson — next to the three most similar stored lessons (category, title, content excerpt, similarity, age).
  TEST: services/gateway/test/vtid-04818-lesson-novelty.test.ts
AC-2: Gate `lesson_novelty` (`JEV_LESSON_NOVELTY_MODE`, exact values; anything else off). Off recalls, asks and writes nothing. In shadow, before each extracted lesson is written, the three most similar stored lessons are recalled with the agents' own search and one `jev_shadow_decisions` row is written (`subject_type = dev_memory_candidate`, `system_action = written`); never awaited; the write is unchanged.
  TEST: services/gateway/test/vtid-04818-lesson-novelty.test.ts
AC-3: Agreement is written at once where the similarity rule is certain — best similarity ≥ 0.92 is a duplicate, < 0.75 (or nothing stored) is new — else null; recall failure → nothing; Jev down → fallback row; never throws.
  TEST: services/gateway/test/vtid-04818-lesson-novelty.test.ts
AC-4: Memory extraction and writes behave as before (operator turn memory and agent memory suites green); both gateways pin `JEV_LESSON_NOVELTY_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04818-lesson-novelty.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/lesson-novelty-gate.ts (new)
- services/gateway/src/services/operator-turn-memory.ts (one fire-and-forget check per lesson, one recall helper, imports)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04818-lesson-novelty.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04818/**

## OASIS

OASIS_IMPACT: none new. Each lesson emits the existing `jev.decision.*` event (source `jev:gate:lesson_novelty`), at most three per turn or run.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_LESSON_NOVELTY_MODE=shadow`. Memory extraction and writes behave exactly as before; each lesson costs one extra embedding call for the recall while the gate is on.

## Not in this PR

Enforce (skipping duplicates, superseding updated lessons) and the weekly root-cause roll-up into findings.
