# Responses to s2-round-1 (mt-track-s)

All three findings describe lanes, routes and auth-middleware changes that do **not** exist anywhere in the
mt-track-s plan or its one lane. mt-track-s has a single OPEN lane, `s-j-route-inventory` (vitana-v1), whose entire
scope is: delete the dead `linkedin-import` edge function and add a node edge-function caller-auth inventory gate
(`plan.md` ## Fix; `lanes/s-j-route-inventory.md` `paths`: `supabase/functions/linkedin-import/**`,
`supabase/config.toml`, `src/lib/edge-functions-caller-identity.s4.test.ts`, `scripts/check-edge-function-auth.mjs`,
`package.json`, `docs/validation/**`). It touches no gateway route, no Command Hub file, and no tenant-admin
middleware. The round's own header session id (`643ff85b-f098-4544-ac74-55fda8d4644c`) and plan hash
(`53ed8eac…`) do not match this session (`7bf15cbe-7042-4a54-9813-7f4efaac2935`, plan_text_sha `b73e525` in
`state.json`), so the round targeted a different spec's plan (its findings are mt-tenant-admin / mt-frontend-brand
material). Each finding is therefore rejected with a code-cited reason, and the plan is unchanged — there is no
legitimate mt-track-s change these findings warrant.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "rejected",
    "rationale": "Not applicable to mt-track-s. No lane named 'command-hub-tenant-module' exists in this spec; the only lane is 's-j-route-inventory' (lanes/s-j-route-inventory.md:1 'lane: s-j-route-inventory'). Its paths (lanes/s-j-route-inventory.md:9-15) are all vitana-v1 paths and include no 'services/gateway/src/frontend/command-hub/**' file, so scripts/ci/command-hub-ownership-guard.js:15 PROTECTED_PATH='services/gateway/src/frontend/command-hub/' never matches this spec's PR. plan.md ## Fix plans only the vitana-v1 edge-function deletion + inventory gate; a grep of plan.md for 'command-hub' returns nothing. The finding reviewed another spec (mt-frontend-brand owns the Command Hub guard per CROSS-SPEC-DECISIONS.md).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "rejected",
    "rationale": "Not applicable to mt-track-s. This spec plans no 'tenant-admin-api' lane and no scoped-read route handler, and never claims 'requireTenantAdmin already supports both' as a mitigation. The sole OPEN lane changes no gateway code (lanes/s-j-route-inventory.md:9-15 are vitana-v1 edge-function/test/config paths). require-tenant-admin.ts, admin-autopilot.ts and admin-signups.ts are not in any mt-track-s path. plan.md's only mention of requireTenantAdmin is in Problem item 6 (S-F), describing already-shipped VTID-05147 behaviour (plan.md ## Problem #6, cited to tenant-admin/overview.ts and VTID-05147 AC-6), which is CLOSED and explicitly Out of scope (plan.md ## Out of scope: 'do not re-touch shipped code'). The targetTenantId fallback regression belongs to the tenant-admin spec, not here.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "rejected",
    "rationale": "Not applicable to mt-track-s. There is no 'tenant-admin-api' lane and no task that tenant-scopes 'moderation / signups / notifications / users / audit admin reads'; admin-moderation.ts and admin-signups.ts are not in any mt-track-s lane path (lanes/s-j-route-inventory.md:9-15). The spec does not change any auth guard: the sole lane deletes supabase/functions/linkedin-import/** and adds scripts/check-edge-function-auth.mjs + the config.toml/s4-test companion edits (plan.md ## Fix, tasks.md T1-T4). Moderation RPC/guard ownership is mt-tenant-admin P2/P3 per CROSS-SPEC-DECISIONS.md (O4), not Track S. No security-model widening occurs in this spec.",
    "deferred_to": ""
  }
]
```
