# Sparring round 2 — converged

Session: `2bb76919-dda6-4159-9ee2-ad79eab9545d` · plan hash `139e2cd7a67db07e655b3d5dabe341c3d2127992dd76ebd613b7195f3f4a4bfc`

## Summary

Round 2 review of the revised mt-tenant-admin plan. All three previously accepted findings (R1-F1 vitana-v1 premises, R1-F2 migration range typo, R1-F3 guard destructured-form coverage) are substantively addressed in the revision. Key premises verified against the pinned commit all hold: the exafy-admin early return at :96, the targetTenantId write at :160, the emit function hardcoding PROVISION_VTID at :301, the two divergent local getTenantId helpers, the unconditional .eq in fetchAdminListingsQueue, the mt-flags.ts isMtResolutionV2Enabled function, and the Command Hub ownership guard mechanics. One minor inaccuracy found regarding emitAdminActivity call-site count. The plan is well-structured and the flag-gated resolver approach is sound.

## Findings

### R2-F1 [minor]

The plan claims `emitAdminActivity` in `admin-community-marketplace.ts` has '12 call sites' (`:37-53`, 12 call sites). The actual file contains exactly 6 call sites: lines 115, 213, 258, 281, 334, and 367. While the implementer will grep for all sites regardless, the inflated count could cause unnecessary confusion when only 6 are found.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:115` — await emitAdminActivity(req, 'community_marketplace.admin.listing_reviewed', 'Admin edited a community listing', {
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:213` — await emitAdminActivity(req, 'community_marketplace.admin.listing_reviewed', `Admin bulk action: ${action}`, {
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:258` — await emitAdminActivity(req, 'community_marketplace.admin.seller_suspended', 'Admin suspended a seller', {
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:281` — await emitAdminActivity(req, 'community_marketplace.admin.seller_unsuspended', 'Admin lifted a seller suspension', {
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:334` — await emitAdminActivity(req, 'community_marketplace.admin.report_resolved', 'Admin updated a listing report', { report_id: id, patch });
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:367` — await emitAdminActivity(req, 'community_marketplace.admin.category_updated', 'Admin updated a listing category', { key, patch });

Suggestion: Fix the count from '12 call sites' to '6 call sites' to avoid implementer confusion.

### R2-F2 [minor]

The plan lists `/categories` `:341` among the handlers that 'keep today's resolution via `resolveSingleTenant`' alongside the writes. However, `GET /categories` (line 341) calls `repo.fetchAllCategoriesAdmin(supabase)` with NO tenantId parameter, and `PATCH /categories/:key` (line 351) calls `repo.updateCategory(supabase, key, patch)` also with NO tenantId. These category operations are tenant-agnostic. The only tenant touch is the indirect `getTenantId(req)` call inside `emitAdminActivity` at line 367 — which is handled by the emitAdminActivity signature change, not by adding a `resolveSingleTenant` call for data access. Listing categories as 'today's resolution via resolveSingleTenant' is misleading.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:341` — router.get('/categories', async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { data, error } = await repo.fetchAllCategoriesAdmin(supabase);
    if (error) return res.status(500).json({ ok: false, error: error.message });

    res.json({ ok: true, categories: data ?? [] });
  });
- `exafyltd/vitana-platform:services/gateway/src/routes/admin-community-marketplace.ts:351` — router.patch('/categories/:key', async (req: Request, res: Response) => {
    ...
    const { data, error } = await repo.updateCategory(supabase, key, patch);

Suggestion: Clarify that categories handlers are tenant-agnostic for data access; they only need the tenantId for the emitAdminActivity payload parameter, which is provided via the emitAdminActivity signature change.
