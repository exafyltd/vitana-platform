# Sparring round 1 — in_progress

Session: `93ffee89-cda7-4e1e-a429-52a5c4dac5a2` · plan hash `87b44c7b62f3a98d47d57fc5b0a3e008f123e1b5f82be3b2ecf2576336070d68`

## Summary

Verified 12+ premises against pinned code. Most file/line references are accurate. The plan's architecture (shared predicate, generated inventory lint, flag-guarded RLS, three reader classes) is solid. One major internal contradiction found in the RLS backstop design for NULL-tenant authenticated sessions, plus one minor line-reference swap.

## Findings

### R1-F1 [major]

The `discover_tenant_gate_enabled()` function as described returns `false` when `current_tenant_id()` is NULL ("false when that is NULL or no row exists"). But the RLS policy `is_active AND (NOT discover_tenant_gate_enabled() OR distribution = 'network' OR EXISTS(...))` then reduces to just `is_active` for any authenticated user whose JWT carries no tenant — the old, unscoped behavior. Meanwhile, the plan's own pgTAP test asserts "gate on + NULL current_tenant_id() → network rows only, no error," which directly contradicts the function definition: the gate can never be "on" for a NULL tenant because the function always returns false for them. Either the function design or the test assertion must change. If the intent is that once any tenant enables the gate, unauthenticated-tenant sessions should see only network rows, the function needs a system-level / any-tenant-enabled check, not a per-tenant one.

- `exafyltd/vitana-platform:supabase/migrations/20260416120000_vtid_02000_marketplace_foundation.sql:729` — CREATE POLICY merchants_select ON public.merchants FOR SELECT TO authenticated USING (is_active = TRUE);
...
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated USING (is_active = TRUE);
- `exafyltd/vitana-platform:supabase/migrations/20260218000000_fix_maxina_signup_tenant_association.sql:33` — CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_tenant_id UUID;
    v_jwt_claims JSONB;
BEGIN
    -- Priority 1: Request context GUC (set by dev_bootstrap or backend middleware)
    BEGIN
        v_tenant_id := current_setting('request.tenant_id', true)::UUID;
        IF v_tenant_id IS NOT NULL THEN

Suggestion: Design `discover_tenant_gate_enabled()` to handle the NULL-tenant case explicitly. Options: (a) make the function return true when `current_tenant_id()` IS NULL but at least one tenant has the gate enabled (`SELECT EXISTS(... WHERE feature_flags->'mt'->>'discover_tenant_gate' = 'true')`), so NULL-tenant sessions get restricted to `distribution = 'network'` rows; (b) accept a separate system-level GUC/flag for whether the platform is in multi-tenant discover mode; (c) if the intent is that NULL-tenant users always get the old behavior, remove the pgTAP assertion "gate on + NULL → network only" and document that the RLS backstop does not cover this edge case (the code-layer predicate must handle it). Option (a) is simplest and keeps the 'REAL backstop' claim honest.

### R1-F2 [minor]

The plan references `products_select/merchants_select` at `:729/:735`, implying products_select is at line 729 and merchants_select at 735. The actual order is reversed: `merchants_select` is created at line 729 and `products_select` at line 735.

- `exafyltd/vitana-platform:supabase/migrations/20260416120000_vtid_02000_marketplace_foundation.sql:728` — DROP POLICY IF EXISTS merchants_select ON public.merchants;
CREATE POLICY merchants_select ON public.merchants FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS merchants_service ON public.merchants;
CREATE POLICY merchants_service ON public.merchants FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated USING (is_active = TRUE);

Suggestion: Swap to `merchants_select (:729) / products_select (:735)` in the plan text to match the actual DDL order.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
