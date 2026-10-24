# Sparring round 1 — in_progress

Session: `fca982e6-f8a0-4fc9-8e6e-78d23ba39b48` · plan hash `c0cb897f4cc5dc956202a766dd093e8351be3329e5ba6674a32362e54d3b82a9`

## Summary

I verified the plan's central premises against the pinned code and most hold: the health upsert conflict target is `tenant_id,user_id,date,feature_key` (integrations-repository.ts:85, diary-health-extractor-repository.ts:24); `fetchLiveDeviceTokensForUser` filters by `.eq('tenant_id', tenantId)` (notification-service-repository.ts:41) and is shared by legacy+native paths via `sendPushToUser` (notification-service.ts:409-411; push-routing.ts:177); `/token` upserts `identity.tenant_id` (notifications.ts:107-110); MIGRATION-QUEUE has 8 applied rows and no membership-unification row; `fetchVitanaIndexScoreForDate` reads by date only (health-repository.ts:51). The overall architecture is sound and the self-enforcing backfill guard is a good idea. However I found three substantive defects: (1) the native-push-tenant lane's contract test — "ab_dual gets a push from each tenant with that tenant's copy/link from one device" — is unimplementable by the described change because only a token-fetch variant is added; the payload (copy/deep-link) is built by notifyUser from a single tenantId and is not re-derived per-tenant, so the new cross-tenant fetch would deliver the SAME tenant's copy/link to both tenants' devices; (2) the plan's risk dismissal that a flag flip "changes only which tenant column is authoritative, not which rows a user sees" is false, because the off-state fallback is `user_tenants limit(1).maybeSingle()` (a non-canonical session/arbitrary row) while the accessor resolves the frozen home tenant — these can resolve to different tenants for a dual member; (3) the lineage-guard HEALTH_TABLES local constant is described as the "CROSS-SPEC O1 contract surface" but no file/export location is specified and the guard's inventory is "generated" without pinning the generator's output in-repo, so equivalence with future `isHealthTable()` can silently drift. Several smaller governance/verification gaps are noted as minor.

## Findings

### R1-F1 [major]

The native-push-tenant lane's contract test and stated behavior ('ab_dual gets a push from each tenant with that tenant's copy/link from one device') cannot be satisfied by the change as described. The plan adds only a token-fetch variant `fetchLiveDeviceTokensForUserAcrossTenants` that drops the `.eq('tenant_id', tenantId)` filter, but the payload (title/body copy and deep-link URL) is a single `NotificationPayload` built from ONE tenantId at the caller, not per-tenant. Removing the tenant filter would deliver the same tenant's copy/link to every tenant's device for that user, not each tenant's own copy.

- `exafyltd/vitana-platform:services/gateway/src/services/notification-service.ts:380` — sendPushToUser(userId, tenantId, payload, supabase, opts) { ... const { data: rawTokens } = tokenClass ? await repo.fetchLiveDeviceTokensForUser(supabase, userId, tenantId, { withDeviceType: true }) : await repo.fetchLiveDeviceTokensForUser(supabase, userId, tenantId); ... for (const { fcm_token, device_type } of targets) { ... await sendPushNotification(fcm_token, payload, ...) } }
- `exafyltd/vitana-platform:services/gateway/src/services/notification-service-repository.ts:28` — export async function fetchLiveDeviceTokensForUser(sb, userId, tenantId, opts?) { return sb.from('user_device_tokens').select(...).eq('user_id', userId).eq('tenant_id', tenantId).is('revoked_at', null); }
- `exafyltd/vitana-platform:services/gateway/src/services/push-routing.ts:176` — nativeSent = await sendPushToUser(userId, tenantId, payload, supabase, { tokenClass: 'native', ... });

Suggestion: Either (a) scope the cross-tenant fetch so the copy/link is genuinely per-tenant (fan out one payload per tenant the user belongs to, deriving copy from each tenant's row), or (b) narrow the contract test to what the change actually does — e.g. 'a dual member receives the notification on both tenants' devices (same copy/link)' — and state explicitly that per-tenant copy is out of scope. As written the acceptance criterion is unmet by the diff.

### R1-F2 [major]

The plan's risk dismissal ('a flip changes only which tenant column is authoritative, not which rows a user sees') is false for the fallback path. When MT_RESOLUTION_V2 is off, or health_home_tenant_id is NULL, the code resolves the tenant via `user_tenants .limit(1).maybeSingle()` — an arbitrary/non-canonical row, not the frozen home tenant. The accessor resolves the frozen home tenant. For a dual member these can be different tenants, so flipping the flag mid-session CAN change which rows the user sees/writes, contradicting the stated determinism.

- `exafyltd/vitana-platform:services/gateway/src/routes/integrations-repository.ts:66` — export async function fetchUserTenantId(sb, userId) { return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle(); }
- `exafyltd/vitana-platform:services/gateway/src/routes/health-repository.ts:68` — export async function fetchTenantIdForUser(sb, userId) { return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle(); }

Suggestion: Correct the risk statement: the off-state fallback is `limit(1).maybeSingle()`, which is non-deterministic across sessions for a dual member, so a flag flip is a genuine read/write-behavior change, not a no-op swap of 'which column is authoritative'. Mitigate by having the fallback also resolve the primary membership (order by is_primary desc) rather than an arbitrary first row, or gate the flag flip behind a deploy that completes the DB backfill first.

### R1-F3 [minor]

The lineage-guard lane introduces a local `HEALTH_TABLES` constant as the 'CROSS-SPEC O1 contract surface' but does not pin where it lives (module/export path) or the generator's output, and does not commit the generated inventory anywhere in-repo. This means equivalence with mt-identity's future `isHealthTable()` is asserted only by a comment and can silently drift (e.g. a table name added to the local list but not the predicate, or vice versa).

- `exafyltd/vitana-platform:docs/multitenancy/MIGRATION-QUEUE.md:8` — (A CI check that enforces this file is the WS0 lint slice; until then it is a review rule.)

Suggestion: Specify the exact module path and export name of `HEALTH_TABLES`, require the generated inventory to be committed as a fixture (e.g. docs/validation/<VTID>/health-table-inventory.json), and add a cheap test asserting the constant and the inventory agree, so a future `isHealthTable()` swap is checkable rather than trust-based.

### R1-F4 [minor]

The plan claims the healthDb accessor conversion is 'dark behind MT_RESOLUTION_V2 where a runtime read path changes'. But the five converted sites include WRITE paths (upsertHealthFeatureDaily in integrations-repository.ts and diary-health-extractor-repository.ts). A write behind a flag that resolves tenant differently on/off creates the split-write hazard the plan's own risk paragraph only half-addresses (it discusses reads, and dismisses via a determinism claim that R1-F2 refutes). The write conflict target `tenant_id,user_id,date,feature_key` means an off-state write to the session tenant and an on-state write to the home tenant produce two distinct rows.

- `exafyltd/vitana-platform:services/gateway/src/routes/integrations-repository.ts:72` — export async function upsertHealthFeatureDaily(sb, row: { tenant_id, user_id, date, feature_key, ... }) { return sb.from('health_features_daily').upsert(row, { onConflict: 'tenant_id,user_id,date,feature_key' }); }
- `exafyltd/vitana-platform:services/gateway/src/services/diary-health-extractor-repository.ts:23` — export async function upsertHealthFeatureDaily(sb, row) { return sb.from('health_features_daily').upsert(row, { onConflict: 'tenant_id,user_id,date,feature_key' }); }

Suggestion: Treat the write-path conversion as a distinct, explicitly-called-out migration step: do not flip the write tenant until the same canonical resolution (accessor) is used for both write and read, and document that a partial flip leaves duplicate health rows under two tenant_id values for the same (user,date,feature).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
