# VTID-04879 — Jev community Class A decisions in shadow (staging only)

Owner instruction 2026-10-04: "build 1–3 next, each as its own PR, in shadow on staging only. start with the Class A
decisions." Plan sparred (2 rounds, converged) and owner-approved (option b) — `plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Four decisions — `community_intent_kind` (8 kinds + none, same labels as intent-classifier.ts), `community_marketplace_intent` (exactly the heuristic's five labels), `community_worth_remembering` (noul), `community_ticket_triage` (answer_inline/file_ticket + the four typed ticket kinds) — all `data: 'member_content'`, `community_class: 'A'`, `pii: 'redact'`, planes internal + system_autopilot.
  TEST: services/gateway/test/vtid-04879-community-class-a.test.ts
AC-2: A gate runs only when its `JEV_COMMUNITY_*_MODE` is shadow (or enforce, which has no enforce path and behaves as shadow), `JEV_COMMUNITY_ENABLED` is true and a tenant is known; otherwise no Jev call and no row.
  TEST: services/gateway/test/vtid-04879-community-class-a.test.ts
AC-3: Each gate calls `decide()` as `{ system: true, system_plane: 'system_autopilot', tenant_id }`; member rules apply (a tenant without the member plane is denied, no spend); spend is counted as member; no per-member quota (Class A).
  TEST: services/gateway/test/vtid-04879-community-class-a.test.ts
AC-4: Each gate records one `jev_shadow_decisions` row with `plane: 'member'`, a hashed `subject_ref`, the Jev class next to the existing logic's class and `agreed`; the row never contains member text or ids. C10 is settled later from the extractor's stored-fact count.
  TEST: services/gateway/test/vtid-04879-community-class-a.test.ts
AC-5: Every call site is fire-and-forget with its own `.catch`; a gate never throws, never delays and never changes the existing result. `executeReportToSpecialist` returns the same result with a shadow that resolves, never settles, or rejects.
  TEST: services/gateway/test/vtid-04879-community-class-a.test.ts
  TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts
AC-6: `extractAndPersistFacts` returns `{ persisted }` (0 on skip/none/error); `deduplicatedExtract` still never throws. Contract change on purpose: two assertions in `test/inline-fact-extractor.test.ts` that expected `undefined` now expect `{ persisted: 0 }`; both still prove the extractor never throws.
  TEST: services/gateway/test/vtid-04879-community-class-a.test.ts
AC-7: The four modes are pinned to shadow in `AWS-STAGE-DEPLOY-GATEWAY.yml` only; production sets none of them; nothing opens the member plane.
  TEST: services/gateway/test/vtid-04879-community-class-a.test.ts
AC-8: Jev, operator, roles and support suites stay green; the full gateway suite passes.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/gates/community-class-a-gates.ts (new)
- services/gateway/src/services/jev/jev-decisions.ts (four decisions)
- services/gateway/src/services/intent-find-match.ts, services/gateway/src/routes/intents.ts, services/gateway/src/routes/orb-live.ts (C1 call sites)
- services/gateway/src/services/orb-tools/marketplace-guide-tools.ts (C3 call site)
- services/gateway/src/services/extraction-dedup-manager.ts, services/gateway/src/services/inline-fact-extractor.ts (C10)
- services/gateway/src/services/report-to-specialist-core.ts (C19 call site)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml (staging shadow pins), services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04879-community-class-a.test.ts (new), services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts (one scenario), services/gateway/test/inline-fact-extractor.test.ts (two return-shape assertions)
- DATABASE_SCHEMA.md, docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04879/**

## OASIS

OASIS_IMPACT: no — no new topic. Each gate's Jev call emits the existing `jev.decision.*` event (source `gate:community_*`), which only happens once the member plane is open on staging.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with the four shadow pins. `JEV_COMMUNITY_ENABLED` stays unset, so every gate
returns before any Jev call: no member text leaves, no spend, no rows. Production unchanged.
