# Sparring round 3 — converged

Session: `0de6a378-b304-4d63-b75b-3813dfcfbf75` · plan hash `db803c8cbb42fc4ff05de7fa12fcaa4c2aeb9ebb1defa7271f42f5d6f986b72d`

## Summary

The revised plan is substantially improved: R1-F1 (path), R1-F2 (allowlist enumeration), R1-F3 (DEPENDENCY_NOT_READY guard), R2-F1 (VTID-05267 dependency with acceptance gate), and R2-F2 (resolvePrimaryTenant/service-role client pinned) are all addressed. I verified the key premises against the pinned commit: resolvePrimaryTenant uses getSupabase() (service-role, lib/supabase.ts:9) and reads user_tenants ordered is_primary desc; identity.tenant_id is app_metadata.active_tenant_id; admin-signups.ts:205 hardcodes DEFAULT_TENANT_ID (owned by VTID-05267); community-invites.ts /claim has no tenant in attribution; isFeatureLive is single-arg global; tenant_settings.feature_flags is a JSONB column; tenant_content_overrides does not exist at the pinned commit (only agent_personas_tenant_overrides from VTID-02652, a different table). No new blockers or majors remain. Two minor clarifications: (1) the plan introduces a DB RPC get_tenant_launch_readiness without relating it to the existing gateway gatherReadiness / GET /:id/readiness endpoint (admin-tenants.ts:536), risking two disagreeing readiness signals; (2) the owner-analytics allowlist includes the raw `tenants` table whose og_image/brand content is the support-landing lane's concern, not owner-analytics, needlessly widening the permitted read surface.

## Findings

### R3-F1 [minor]

The plan introduces a new DB RPC get_tenant_launch_readiness (intake completeness) but never states its relationship to the existing gateway-level readiness feature GET /:id/readiness (admin-tenants.ts:536) which calls gatherReadiness over provisioned columns. Two readiness signals will now exist with no defined reconciliation, and the plan never says whether the new RPC supersedes, extends, or coexists with gatherReadiness.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-tenants.ts:536` — router.get('/:id/readiness', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
  ... const { result } = await gatherReadiness(supabase, tenant);
  return res.json({ ok: true, tenant_id: tenant.tenant_id, slug: tenant.slug, ...result });

Suggestion: State explicitly whether get_tenant_launch_readiness (intake checklist) is a distinct, additive readiness axis vs. the provisioned-column gatherReadiness, and whether the admin /:id/readiness endpoint will also surface the intake items or stay column-only. Prevent an implementor from shipping two disagreeing 'ready' signals.

### R3-F2 [minor]

The D18 owner-analytics read allowlist includes the raw `tenants` table, but tenant brand/OG content (og_image, landing) is the support-landing lane's concern per the plan's own Fix section. Allowing owner-analytics to .from('tenants') widens the permitted surface beyond what owner-analytics needs (it needs tenant_id/pack-intake/pipeline/analytics tables), with no stated reason.

- `exafyltd/vitana-platform:services/gateway/src/routes/admin-tenants.ts:471` — // ── PUT /:id/assets/:kind — logo | favicon | og_image ────────
router.put('/:id/assets/:kind', async (req: Request, res: Response) => {
  const auth = await verifyExafyAdmin(req);
- `exafyltd/vitana-platform:supabase/migrations/20260412300000_tenant_settings.sql:8` — CREATE TABLE IF NOT EXISTS public.tenant_settings (
    tenant_id       UUID PRIMARY KEY REFERENCES public.tenants(id),
    profile         JSONB NOT NULL DEFAULT '{}',    -- name, description, support_email, logo_url
    branding        JSONB NOT NULL DEFAULT '{}',    -- brand_accent, brand_bg, brand_fg, favicon_url
    feature_flags   JSONB NOT NULL DEFAULT '{}',    -- enable_voice_widget, enable_autopilot, etc.

Suggestion: Either drop `tenants` from the owner-analytics allowlist (owner-analytics can obtain tenant identity via tenant_pack_intake/tenant_content_pipeline tenant_id and the path segment), or document exactly which `tenants` columns owner-analytics reads and why the raw table (rather than tenant_settings) is needed. Keeps the fail-closed allowlist minimal.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The plan now makes the VTID-05267 dependency checkable with branch, commit, artifact paths, and an acceptance gate in support-landing. The rationale (external lane owns admin-signups.ts:205 to avoid double-editing) is sound; no in-repo action is required beyond the documented gate.
- R2-F2: acknowledged — Corrected premise confirmed: resolvePrimaryTenant runs on the service-role client (lib/supabase.ts:9), not tenant/anon scope, and the fix pins attribution to resolvePrimaryTenant(identity.user_id) with status other than 'found' => tenant_id null. Sound.
