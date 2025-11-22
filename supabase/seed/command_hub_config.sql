-- Command Hub configuration
CREATE TABLE IF NOT EXISTS public.command_hub_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_base_url TEXT NOT NULL,
    sse_url TEXT NOT NULL,
    default_history_hours INTEGER DEFAULT 72,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert config
INSERT INTO public.command_hub_config (operator_base_url, sse_url, enabled)
VALUES (
    'https://oasis-operator-86804897789.us-central1.run.app',
    'https://oasis-operator-86804897789.us-central1.run.app/api/v1/events/stream',
    true
)
ON CONFLICT DO NOTHING;
