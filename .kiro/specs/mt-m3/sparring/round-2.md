# Sparring round 2 — in_progress

Session: `8a83bc72-709d-4234-8481-0e260cd2771f` · plan hash `8465309ee93034fbbd0f8eb5d5cc4cf73781e37efe4ed3a2b0766dcd14555377`

## Summary

Round 2 review. All five prior findings (R1-F1..F5) were accepted by the planner, and the revised plan text addresses each: lane 6 descoped to display-only (F1), hot-path budget with platform-host skip + 60s cache + abortAfter (F2), separate 2-arg overload with no DEFAULTs and pinned legacy output (F3), 'erp' declared a governed key via merge fn re-create (F4), and corrected v1 file:line citations + dedupe-by-tenant_id (F5). I verified the cited code premises (tenant-context.ts TenantSource union and 60s cache, auth-supabase-jwt.ts AUTH_LOOKUP_TIMEOUT_MS=2500 and abortAfter, the 8-column resolve_tenant output, the merge fn's jev-only strip, provision_tenant's ON CONFLICT DO NOTHING, MIGRATION-QUEUE ends at row 8). Three new findings: (1) the "Depends on mt-identity (is_member())" premise does not match the gateway's actual membership-check mechanism (lookupTenantMembership/fetchMembershipForUserTenant) — the host arm's membership re-check must be pinned to that path, and it caches positives 60s / never caches negatives with fail-closed 503 semantics; (2) "no host equal to a reserved slug" cannot be a CHECK constraint (Postgres CHECK cannot reference other tables) and the plan does not pin a trigger/admission mechanism; (3) the host arm is described as inserted "BEFORE the slug/claim arms" but no slug/claim arms exist in the gateway today (resolution is token → primary fallback), so the plan's own framing overstates what exists — substance is fine but the lane task should say the host arm runs before the token/primary arms.

## Findings

### R2-F1 [major]

The plan's 'Depends on mt-identity (is_member(), TenantContext)' premise is wrong about the gateway's membership-check mechanism. The gateway does not call any function named is_member(); it uses lookupTenantMembership() (auth-supabase-jwt.ts:531) which calls repo.fetchMembershipForUserTenant() and returns 'member'|'not_member'|'unavailable' (MembershipLookup, :525, cached positive 60s, negatives never cached, fail-closed 503 on 'unavailable'). The host arm's security posture ('host tenant ≠ member → join posture, never a silent default') depends on re-checking membership against the host-resolved tenant, but the plan names the wrong dependency, so the implementer could wire a net-new is_member() RPC that bypasses the VTID-05043 cache/semantics instead of reusing lookupTenantMembership.

- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt.ts:525` — type MembershipLookup = 'member' | 'not_member' | 'unavailable'; ... async function lookupTenantMembership(userId, tenantId) { ... const { data, error } = await repo.fetchMembershipForUserTenant(...) ... }
- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt.ts:639` — if (identity.tenant_id) { if (!identity.exafy_admin) { const lookup = await lookupTenantMembership(identity.user_id, identity.tenant_id); if (lookup !== 'member') return null; } ... }

Suggestion: Pin the host arm's membership re-check to lookupTenantMembership() (vtid-05043) applied to the host-resolved tenant_id, not to a literal mt-identity is_member(). State the dependency as 'mt-identity for TenantContext, and VTID-05043 lookupTenantMembership for the membership re-check (positive cached 60s, negatives never cached, fail-closed 503)'. Add a contract test proving the host-resolved tenant is passed through lookupTenantMembership (reusing its cache) rather than a new unmemoised membership query.

### R2-F2 [major]

Lane 1 lists 'no host equal to a reserved slug' as a tenant_domains constraint, but a Postgres CHECK constraint cannot reference another table (reserved_tenant_slugs), so a CHECK will not compile. The plan specifies only 'host format check' as a concrete mechanism and leaves the cross-table reserved-slug prohibition unpinned — the invariant would silently be dropped or the migration would fail.

- `exafyltd/vitana-platform:supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:140` — INSERT INTO public.reserved_tenant_slugs (slug, source) VALUES ('admin','platform'), ('ai','spa_route'), ('alive','platform'), ('alkalma','spa_route'), ... (a table, not a scalar/immutable set usable in CHECK)

Suggestion: Specify the reserved-slug-host prohibition as an AFTER/BEFORE INSERT OR UPDATE trigger on tenant_domains (or an admission-time WHERE NOT EXISTS(SELECT 1 FROM reserved_tenant_slugs r WHERE r.slug = lower(btrim(NEW.host)))) rather than a CHECK constraint. Add a pgTAP case that inserting a host equal to a reserved slug is rejected.

### R2-F3 [minor]

The plan's host arm is described as resolving 'BEFORE the slug/claim arms', but the gateway currently has no slug arm or claim arm in tenant resolution: getTenantContext (auth-supabase-jwt.ts:635-649) resolves from identity.tenant_id (with membership check) or falls back to the primary membership — there is no slug resolution and no hostname resolution in the gateway. The 'slug/claim arms' framing overstates what exists; the host arm is a net-new first arm inserted ahead of the token/primary arms. Substance is correct in intent (host first), but the lane wording risks the implementer looking for arms that are not there.

- `exafyltd/vitana-platform:services/gateway/src/middleware/auth-supabase-jwt.ts:635` — export async function getTenantContext(req) { if (req.tenant) return req.tenant; const identity = req.identity; if (!identity) return null; if (identity.tenant_id) { ... } const primary = await resolvePrimaryTenantForRequest(identity.user_id); ... }

Suggestion: Reword lane 2 to say the host arm resolves req.hostname first (via resolve_tenant(host,…)), then the existing token arm (identity.tenant_id + membership check), then the primary-membership fallback. No code change needed; fix the framing so the implementer does not hunt for a slug/claim arm that does not exist.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Lane 6 descoped to display-only on the admin health read; no ERP bridge dispatch; deferred consumer to a separate spec. Consistent with the erp-bridge being execute-only.
- R1-F2: acknowledged — Revision pins platform-host skip, flag gate, 60s cache, and abortAfter(AUTH_LOOKUP_TIMEOUT_MS) with H3 tests. Matches the hot-path code I verified.
- R1-F3: acknowledged — Separate 2-arg overload with no DEFAULTs; 1-arg untouched; legacy output pinned and 8-column whitelist asserted. Name kept in parent's favour.
- R1-F4: acknowledged — 'erp' declared governed; merge fn re-created with - 'jev' - 'erp'; rollback restores jev-only body; pgTAP added.
- R1-F5: acknowledged — v1 citations re-verified and corrected (setTenantBySlug :170/:190/:208, permissions :24, TenantPortal :178-193); S1 dedupes by tenant_id.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
