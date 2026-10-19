# Sparring round 1 — in_progress

Session: `ee011de1-a1ce-4dd8-aaf3-d7e19e0cee14` · plan hash `7ccc7b8b067165b7097fb2b45e705fc54f872a98a9042a01068e32371a917bca`

## Summary

Three substantive findings: one major scope gap (autopilot-prompts.ts migration missing from lane 5 despite an explicit forward-reference promise in pinned code), one minor stale lint carve-out (post lane-5b the second `…0001` intentional site disappears), and one minor unacknowledged UUID collision (VITANA_BOT_USER_ID shares `…0001` with the vitana tenant_id). The four core structural premises checked all hold. One premise — the claimed newest migration timestamp of `20261015180000` — could not be confirmed or denied because the migration directory listing was truncated and no file at or past that timestamp was readable in this review.

## Findings

### R1-F1 [major]

Lane 5 omits the migration of `autopilot-prompts.ts` off `fetchPrimaryTenantForUser` despite an explicit forward-reference promise written into the pinned codebase by VTID-05149, which states that route moves 'in the tenantDb slice' (i.e. this lane). After this plan ships, `fetchPrimaryTenantForUser` remains wired in `autopilot-prompts.ts`, breaking the O1 'all is_primary reads go through tenantDb' contract and leaving the forward-reference unfulfilled.

- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt-repository.ts:17` — `fetchPrimaryTenantForUser` was the primary-tenant query of requireTenant and requireAuthWithTenant. VTID-05149 moved both to the shared resolver (services/tenancy/tenant-context.ts); it stays only for routes/autopilot-prompts.ts, which moves with the other is_primary readers in the tenantDb slice.
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:1` — VTID-05149 (multi-tenant M0, lane A): the one place the gateway resolves a user's tenant and describes a tenant.

Suggestion: Lane 5's scope must explicitly add: (a) migrate `routes/autopilot-prompts.ts` from `fetchPrimaryTenantForUser` to `tenantDb(ctx)`; (b) add a Vitest test covering the autopilot-prompts tenant-resolution path; (c) remove or mark `fetchPrimaryTenantForUser` for deletion once no callers remain. If the migration is intentionally deferred to a later lane, update the forward-reference comment in `auth-supabase-jwt-repository.ts` to name that lane so the promise is not silently dropped.

### R1-F3 [minor]

After lane 5b replaces `DEV_IDENTITY.TENANT_ID: '…0001'` with an env-var-driven value, `orb-memory-bridge.ts` will contain no `…0001` literal. The Vitest lint description says 'exactly two intentional sites' for `…0001` with the second being `DEV_IDENTITY`'s resolved `DEV_TENANT_SLUG` default in `orb-memory-bridge.ts` — but lane 5b removes that literal. A strict 'exactly 2' implementation of the lint would either fail unnecessarily or silently over-whitelist a second site.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-memory-bridge.ts:66` — export const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001',
  TENANT_SLUG: 'vitana',
  ACTIVE_ROLE: 'developer',
  DISPLAY_NAME: 'Dev User (ORB Sandbox)'
};

Suggestion: Post lane-5b, update the Vitest lint to assert exactly one intentional site for `…0001` (`lib/vitana-bot.ts` only). Remove `orb-memory-bridge.ts` from the carve-out list so a future accidental re-introduction of a second `…0001` literal there is caught rather than silently allowed.

### R1-F4 [minor]

`VITANA_BOT_USER_ID = '00000000-0000-0000-0000-000000000001'` in `lib/vitana-bot.ts` shares its UUID with the vitana tenant_id. The plan labels this value 'bot USER id' without noting the collision. Lane 2 (membership-unification) backfills and reconciles `user_tenants`; if the bot's `user_id=…0001` has a `user_tenants` row with `tenant_id=…0001`, `is_member(tenant_id)` for vitana counts the bot as a regular member, which can affect seat-count governance and may trigger the VTID-03990 duplicate-welcome guard.

- `exafyltd/vitana-platform:services/gateway/src/lib/vitana-bot.ts:9` — export const VITANA_BOT_USER_ID = '00000000-0000-0000-0000-000000000001';
- `exafyltd/vitana-platform:services/gateway/src/routes/me.ts:15` — const TENANT_SLUGS: Record<string, string> = {
  '00000000-0000-0000-0000-000000000001': 'vitana',
  '00000000-0000-0000-0000-000000000002': 'maxina',
  '00000000-0000-0000-0000-000000000003': 'alkalma',
  '00000000-0000-0000-0000-000000000004': 'earthlings',
};

Suggestion: Add to the lane 2 risk register that bot user `…0001` must be explicitly excluded from the backfill query (`WHERE user_id != '00000000-0000-0000-0000-000000000001'`). The VTID-03990 suppression guard on the dual-write trigger should also exclude the bot. Add a pgTAP assertion confirming that re-inserting a `memberships` row for the bot user creates zero additional `chat_messages` rows.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
