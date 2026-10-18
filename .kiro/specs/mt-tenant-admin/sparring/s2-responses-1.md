# Sparring responses — session 2, round 1 (planner kiro-hotmail-202610151618-b437)

All three findings verified read-only against the pinned branch tip and accepted. Plan and the two affected lanes
(`command-hub-tenant-module`, `tenant-admin-api`) + `tasks.md` updated accordingly; `command-hub-tenant-module` gains
one path (`scripts/ci/command-hub-ownership-guard.js`, confirmed non-governance via `queue.mjs globTouchesGovernance`
= false, so the lane stays `executor: kiro`).

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: scripts/ci/command-hub-ownership-guard.js:15 PROTECTED_PATH = 'services/gateway/src/frontend/command-hub/'; :1051 ALLOWED_VTID_PATTERN is a fixed VTID/marker allowlist; :1115 the guard tests branchName/prTitle against it and exits non-zero on no match. A new PLAN-SPAR VTID is not in the pattern, so the command-hub-tenant-module PR would be blocked (this is the same guard CROSS-SPEC-DECISIONS flags for mt-frontend-brand's command-hub-picker). Fix: added scripts/ci/command-hub-ownership-guard.js to the command-hub-tenant-module lane paths and to the tasks.md Allowed paths; added task C5 and a plan/lane REQUIRED same-PR edit appending the allocated VTID to ALLOWED_VTID_PATTERN (named TODO at :1051 until PLAN-SPAR writes the VTID), mirroring every prior Command Hub VTID (e.g. VTID-05084). The guard path is NOT a governance path (globTouchesGovernance=false; GOVERNANCE_PATHS = .github/.claude/.kiro/steering/.kiro/automations/scripts/collab/CLAUDE.md/areas.yaml), so the lane remains executor: kiro.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: require-tenant-admin.ts:96 `if (req.identity.exafy_admin) { next(); return; }` returns BEFORE :159 where `(req as any).targetTenantId = targetTenantId` is set — so req.targetTenantId is undefined for an exafy-admin. admin-autopilot.ts:23-24 getTenantId = `(req as any).targetTenantId || (req as AuthenticatedRequest).identity?.tenant_id`, which for an exafy-admin falls back to their OWN tenant_id, silently scoping the 'all tenants' view to one tenant. The plan's prior Risk mitigation ('requireTenantAdmin already supports both') was true only for the auth gate, not the data view. Fix: rewrote Problem #2 and the Risks line; the tenant-admin-api Fix bullet + lane body + tasks A2 now REQUIRE an explicit `req.identity.exafy_admin` branch that omits the tenant filter in every scoped read, and tasks A6 adds a Vitest asserting an exafy-admin still sees cross-tenant rows while a tenant-admin sees only its own.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: admin-moderation.ts:25 defines inline `verifyExafyAdmin` and :51 calls it (comment at :1 'All endpoints require Bearer token + exafy_admin'); admin-signups.ts:21 imports requireExafyAdmin and :32,:62,:113,:242,:300,:378 all guard with requireExafyAdmin — i.e. these reads are exafy-admin-only today. The plan did not state whether scoping replaces those guards with requireTenantAdmin (a security widening exposing cross-tenant funnel counts/emails to tenant-admins) or adds parallel endpoints. Fix (conservative, no widening): the tenant-admin-api lane now ADDS new requireTenantAdmin-guarded tenant-scoped endpoints ALONGSIDE the existing exafy-admin-only ones and does NOT replace the guards; any widening of the same endpoint to tenant-admins is listed under plan ## Owner decisions and held for owner approval. Updated plan Fix bullet + Owner decisions, the lane body, and tasks A1.",
    "deferred_to": null
  }
]
```
