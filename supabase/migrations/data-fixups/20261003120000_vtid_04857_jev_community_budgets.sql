-- VTID-04857: community Jev budgets, approved by the platform owner 2026-10-03.
--   Maxina  $50/month, Alkalma $10/month; 80% pages the owner, 100% falls
--   back to rules. The budget caps community/customer spend only (member,
--   patient, partner_org); internal and system_autopilot stay unlimited.
-- Listing 'member' does NOT open the member plane: that still needs
-- JEV_COMMUNITY_ENABLED='true' on the gateway, which no task definition sets.
-- Apply AFTER the VTID-04857 gateway code is live in production: before it,
-- the budget also capped internal spend.
-- Idempotent: only the jev key of feature_flags is written.

INSERT INTO public.tenant_settings (tenant_id, feature_flags)
SELECT t.tenant_id,
       jsonb_build_object('jev', jsonb_build_object(
         'enabled', true,
         'planes', jsonb_build_array('internal', 'system_autopilot', 'member'),
         'monthly_budget_usd', CASE t.slug WHEN 'maxina' THEN 50 ELSE 10 END))
  FROM public.tenants t
 WHERE t.slug IN ('maxina', 'alkalma')
ON CONFLICT (tenant_id) DO UPDATE
   SET feature_flags = COALESCE(public.tenant_settings.feature_flags, '{}'::jsonb) || jsonb_build_object('jev', EXCLUDED.feature_flags->'jev'),
       updated_at = now();
