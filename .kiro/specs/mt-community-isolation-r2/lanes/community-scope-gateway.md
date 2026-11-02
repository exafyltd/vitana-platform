---
lane: community-scope-gateway
state: ready
next_actor: kiro
depends_on:
  - community-tenant-db
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/voice-tools/community-member-ranker.ts
  - services/gateway/src/services/voice-tools/community-member-ranker-repository.ts
  - services/gateway/src/services/voice-tools/superlatives.ts
  - services/gateway/src/services/voice-tools/superlatives-repository.ts
  - services/gateway/src/routes/community-members.ts
  - services/gateway/src/routes/community-members-repository.ts
  - services/gateway/src/routes/users-resolve.ts
  - services/gateway/src/routes/users-resolve-repository.ts
  - services/gateway/src/routes/billing.ts
  - services/gateway/src/routes/billing-repository.ts
  - services/gateway/src/services/orb-tools/discovery-tools.ts
  - services/gateway/src/services/social-memory/**
  - services/gateway/src/routes/memory-social.ts
  - services/gateway/src/services/intent-find-match.ts
  - services/gateway/src/services/orb-tools/p0-gap-tools.ts
  - services/gateway/src/services/automation-handlers/connect-people.ts
  - services/gateway/src/services/automation-handlers/connect-people-repository.ts
  - services/gateway/test/mt-community-*.test.ts
updated: 2026-11-01T15:20Z
repos: [exafyltd/vitana-platform]
---
# Community read surfaces — active-tenant scope (CODE, dark) — mt-community-isolation-r2/community-scope-gateway (repo vitana-platform)

The VTID comes from PLAN-SPAR on convergence, never by hand. Plan: `../plan.md`; tasks/paths/acceptance: `../tasks.md`
(`<!-- lane: community-scope-gateway -->`); design: `../design.md`.

Behind `tenant_settings.feature_flags.mt.community_scope` (dark by default), filters every Community
read pool to the viewer's **active** tenant via `TenantContext.tenantId` (WS1), scoping by membership
join since `profiles.tenant_id` is empty until WS2: `community-member-ranker.ts` candidate pool
(:265-281), members directory (`community-members.ts:98-128`), superlatives, ORB `tool_global_search`
(`discovery-tools.ts`), `resolve_recipient_candidates` (already scoped, read-only test only),
`connect-people` automations, and every social-memory reader (plan Fix (e): verify the session tenant is
an active membership, then thread `tenantId` through each reader and every importer, incl.
`routes/memory-social.ts`, `intent-find-match.ts`, `orb-tools/p0-gap-tools.ts`). Per-user tables are
scoped by `fetchActiveTenantMemberIds` member ids, content tables by `tenant_id`. Also makes `countFoundingSeats` /
`/founding-status` report per the viewer's tenant (read-only; the schema is the DB lane). A lint bans
a community read scoped only by visibility. With the flag off, behaviour is byte-identical.

Rules (§7a): no VTID allocation, no `_plan`/`handoff.md` edit, no merge/approve/deploy/dispatch, no
live writes. Network scope, `send_message*` and `network_visible` are the sibling spec — do not add
them here. Depends on `community-tenant-db` (in-spec) and WS1's resolver/`TenantContext` (external —
stated here, not in `depends_on`). This lane adds its own `docs/validation/<vtid>/`.

Branch `kiro/mt-community-isolation-r2/community-scope-gateway`;
PR title `VTID-xxxxx (mt-community-isolation-r2/community-scope-gateway): …`; trailers
`Collab-Session`/`Collab-Lane: mt-community-isolation-r2/community-scope-gateway`. On PR open: `state:
in-review`, `next_actor: kiro`, `pr:`, log entry, release the claim.

## Log
### 2026-11-01T15:20Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-community-isolation/community-scope-gateway`. Answers R3-F1 (resolvePersonByName scopes its own query) and R3-F2 (the `user_matches` other-party predicate). Test paths are narrowed to `test/mt-community-*.test.ts`.
