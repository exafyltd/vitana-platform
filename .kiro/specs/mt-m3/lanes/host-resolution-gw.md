---
lane: host-resolution-gw
state: ready
next_actor: owner
depends_on: [tenant-domains-db]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/services/tenancy/tenant-context.ts
  - services/gateway/src/middleware/auth-supabase-jwt.ts
  - services/gateway/test/mt-m3-host-resolution*.test.ts
updated: 2026-10-15T16:40Z
---
# Gateway host arm in TenantContext — mt-m3 (repo vitana-platform)

Plan: `.kiro/specs/mt-m3/plan.md`; tasks H1–H4 in `tasks.md`; design in `design.md`. Adds a host arm that resolves
`req.hostname` through `resolve_tenant(host,…)` as the new first arm of `getTenantContext()`, ahead of the existing
token and primary arms (there is no slug/claim arm). Context only; data still needs VTID-05043
`lookupTenantMembership()` on the host tenant (`not_member` → the existing join posture, `unavailable` → 503). Adds `'host'` to the `TenantSource` union (`tenant-context.ts:22`)
and updates every consumer (`auth-supabase-jwt.ts:35,579,607,617`) so TypeScript still compiles. Dark behind
`MT_RESOLUTION_V2`. Hot path (task H1b): no lookup for platform hosts or with the flag off, a 60s bounded host cache,
`abortAfter(AUTH_LOOKUP_TIMEOUT_MS)`, timeout → next arm. Depends on `tenant-domains-db` (the table + the 2-arg
`resolve_tenant(p_host, p_slug)` overload must exist first). The lane adds its own
`docs/validation/<vtid>/`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch,
no Supabase/AWS writes. Work only inside the allowed paths. Branch `kiro/mt-m3/host-resolution-gw`; PR title
`VTID-xxxxx (mt-m3/host-resolution-gw): …`; trailers `Collab-Session` / `Collab-Lane: mt-m3/host-resolution-gw`. When the
PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

HELD: `next_actor: owner` until PLAN-SPAR allocates this lane's VTID.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-m3 plan. Held for PLAN-SPAR. Gateway lane, seat `jtadic`, reviewer `hotmail`; depends on
`tenant-domains-db`.
