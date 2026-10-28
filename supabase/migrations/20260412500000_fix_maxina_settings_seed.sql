-- Fix: seed tenant_settings for the ACTUAL Maxina tenant ID.
-- The bootstrap migration used '11111111-...' but the live DB has a different
-- UUID for Maxina (the ON CONFLICT in the original bootstrap may have hit an
-- existing row). This migration seeds for ALL tenants by looking up the real IDs.

INSERT INTO public.tenant_settings (tenant_id, profile, branding, feature_flags, integrations, domains, billing)
SELECT
    t.id,
    '{"name": "Maxina", "description": "Maxina Longevity Community", "support_email": "support@vitanaland.com"}'::jsonb,
    '{"brand_accent": "#FF7BAC", "brand_bg": "#FFF5F8", "brand_fg": "#1a1a2e"}'::jsonb,
    '{"enable_voice_widget": true, "enable_autopilot": true, "enable_knowledge_base": true, "enable_navigator": true, "enable_notifications": true}'::jsonb,
    '{}'::jsonb,
    '{"primary_domain": "vitanaland.com"}'::jsonb,
    '{"plan": "enterprise", "usage_limits": {"members": 1000, "kb_documents": 500, "autopilot_actions_per_day": 100}}'::jsonb
FROM public.tenants t
WHERE t.slug = 'maxina'
ON CONFLICT (tenant_id) DO UPDATE SET
    profile = EXCLUDED.profile,
    branding = EXCLUDED.branding,
    feature_flags = EXCLUDED.feature_flags,
    domains = EXCLUDED.domains,
    billing = EXCLUDED.billing,
    updated_at = now();
