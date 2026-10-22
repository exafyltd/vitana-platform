# Sparring round 3 — converged

Session: `76c3c99c-cf9a-4e72-aec4-4995d7755ae7` · plan hash `c3023d84d9569cee2297af1615f1b175701df8585840c36e64ad7f6d427cb4ac`

## Summary

The revised plan is substantially improved and correctly incorporates both prior findings. R2-F1 (per-tenant heartbeat clock) is now spelled out as a REQUIRED re-key of `lastHeartbeatRun` at all three sites (:386/:405/:418/:424) with a two-tenant Jest test; I verified the existing code matches the described bug and fix. R2-F2 (actor tenant) is fully specified per-site, with the critical `/log-result` case correctly resolving against the NEW user (`auth_user_id`) rather than a caller identity, and `resolvePrimaryTenant` reuse (tenant-context.ts:43) confirmed. The 'Depends on' section is now correct (VTID-05149 shipped). The tenant_settings.timezone and feature_flags.mt.jobs_tenant_loop premises are now backed by concrete migration references and existing reads. Two new findings remain: a subtle trust-semantics concern on the public /log-result route under flag-on, and an unverified downstream fallback assumption in lane 1's whats-new/daily-feature-tip Lambda change.

## Findings

### R3-F1 [minor]

Lane 3's /log-result change subtly *broadens* the blast radius of an unauthenticated public route. Today (admin-signups.ts:204-213) the route dispatches user.signup.completed to a fixed DEFAULT_TENANT_ID for any body auth_user_id — an attacker can only ever fire events into Maxina. Flag-on, the tenant is resolved from the NEW user's primary tenant via resolvePrimaryTenant(auth_user_id) (tenant-context.ts:43 → fetchPrimaryMembership). An unauthenticated caller who knows/guesses a valid auth_user_id can now inject a user.signup.completed event into that user's ARBITRARY primary tenant (e.g. a second, isolated tenant), where previously the event was confined to Maxina. The plan asserts 'Trust is unchanged', which is not fully accurate: per-event the tenant is no longer bounded to Maxina, even though the user_id is still attacker-controlled in both cases. This is pre-existing in spirit (any user_id already dispatches) but the per-tenant fan-out makes cross-tenant noise injection possible.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-signups.ts:176` — // public-route
router.post('/log-result', ...) { ... const tenantId = process.env.DEFAULT_TENANT_ID; if (tenantId) { ... dispatchEvent(tenantId, 'user.signup.completed', { user_id: auth_user_id, attempt_id })
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:43` — export async function resolvePrimaryTenant(userId, ...) { ... fetchPrimaryMembership(supabase, userId, ...); ... return { status: 'found', tenantId: row.tenant_id, ... } }

Suggestion: Either accept and document this as a known pre-existing trust property (the route already trusts the caller's auth_user_id), or harden /log-result by requiring the signup attempt's own auth flow (e.g. verify attempt_id was created by an authenticated signup session) before dispatching to a resolved tenant. At minimum, reword 'Trust is unchanged' to note the tenant is now chosen server-side from the user's primary tenant, so a non-existent/unresolvable auth_user_id drops the event (logged) rather than landing in Maxina.

### R3-F2 [minor]

Lane 1 removes the ONLY tenant signal from the whats-new.sh and daily-feature-tip.sh Lambdas (drops TENANT_ID from --environment Variables and changes the inline handler body to JSON.stringify({})), yet the plan also claims 'off ⇒ byte-for-byte today's single-tenant behaviour' and 'No code reads change until lane 2 ships'. For that to hold with the flag OFF, the Lambda's downstream target must independently recover the tenant from its own DEFAULT_TENANT_ID. The plan asserts this via 'the gateway's own DEFAULT_TENANT_ID + getTenantId(req) remains the flag-OFF fallback' (scheduled-notifications.ts:104-106), which is true FOR the gateway, but the plan does not actually read/confirm the whats-new and daily-feature-tip Lambda targets invoke that gateway fallback (they are separate AWS Lambdas per Problem 7a). If either target has no DEFAULT_TENANT_ID fallback, dropping the baked TENANT_ID env before lane 2 lands would break the flag-off path for those two jobs.

- `exafyltd/vitana-platform:services/gateway/src/routes/scheduled-notifications.ts:104` — function getTenantId(req: Request): string | null { return req.body?.tenant_id || process.env.DEFAULT_TENANT_ID || null; }

Suggestion: Before lane 1 ships, read the whats-new.sh and daily-feature-tip.sh Lambda handler/target to confirm the downstream endpoint falls back to DEFAULT_TENANT_ID (or the gateway getTenantId) when neither env nor body carries a tenant. If not, sequence the removal so the tenant-less body is only introduced once lane 2's resolveJobTenants is live, or keep the baked TENANT_ID env until the flag flip. Add a staging/lane-1 verification that the tenant-less body still reaches an endpoint with a DEFAULT_TENANT_ID fallback while the flag is OFF.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The revision accepted the per-tenant heartbeat clock and spells out the REQUIRED re-key of lastHeartbeatRun at all three sites with a matching two-tenant Jest test. Verified the described code (:386/:405/:418/:424) matches.
- R2-F2: acknowledged — The revision accepted and fully specified per-site actor resolution, including the critical /log-result case resolving against auth_user_id via resolvePrimaryTenant (tenant-context.ts:43, confirmed shipped).
