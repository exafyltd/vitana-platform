-- Seed Maxina tenant_settings with current hardcoded branding values
-- so the Settings admin screens populate on first load.

INSERT INTO public.tenant_settings (tenant_id, profile, branding, feature_flags, integrations, domains, billing)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    '{"name": "Maxina", "description": "Maxina Longevity Community", "support_email": "support@vitanaland.com", "logo_url": null}'::jsonb,
    '{"brand_accent": "#FF7BAC", "brand_bg": "#FFF5F8", "brand_fg": "#1a1a2e"}'::jsonb,
    '{"enable_voice_widget": true, "enable_autopilot": true, "enable_knowledge_base": true, "enable_navigator": true, "enable_notifications": true}'::jsonb,
    '{}'::jsonb,
    '{"primary_domain": "vitanaland.com"}'::jsonb,
    '{"plan": "enterprise", "usage_limits": {"members": 1000, "kb_documents": 500, "autopilot_actions_per_day": 100}}'::jsonb
)
ON CONFLICT (tenant_id) DO NOTHING;
