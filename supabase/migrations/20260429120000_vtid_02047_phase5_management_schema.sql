-- VTID-02047: Phase 5 management schema (plan PR 15 baseline)
--
-- Tables for the persona/tool/KB/connection management surface that the
-- Command Hub editor builds on. Editor UI lands in a follow-up; the schema
-- is shipped here so the data model is in place and the read-only roster
-- (already live) can be extended without another migration.

-- ===========================================================================
-- agent_persona_versions — full snapshot per persona save
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.agent_persona_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id UUID NOT NULL REFERENCES public.agent_personas(id) ON DELETE CASCADE,
  version INT NOT NULL,
  snapshot JSONB NOT NULL,
  change_note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (persona_id, version)
);
CREATE INDEX IF NOT EXISTS idx_agent_persona_versions_persona ON public.agent_persona_versions (persona_id, version DESC);

-- ===========================================================================
-- agent_tools — registry of tools agents can be bound to
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.agent_tools (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  input_schema JSONB,
  blast_radius TEXT NOT NULL DEFAULT 'read'
    CHECK (blast_radius IN ('read','write-low','write-high')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.agent_tools (key, display_name, description, blast_radius) VALUES
  ('codebase-search', 'Codebase search', 'Read-only embedding-based code retrieval', 'read'),
  ('kb-search', 'Knowledge base search', 'Read from unified KB tree', 'read'),
  ('kb-write-draft', 'KB write draft', 'Create draft KB entry pending supervisor review', 'write-low'),
  ('oasis-events-read', 'OASIS events read', 'Query recent OASIS events for user context', 'read'),
  ('refund-stub', 'Refund (stub)', 'Stub adapter — returns "would refund X"', 'write-high'),
  ('role-edit-stub', 'Role edit (stub)', 'Stub adapter — returns "would change role"', 'write-high'),
  ('profile-edit-stub', 'Profile edit (stub)', 'Stub adapter — minor profile field corrections', 'write-low'),
  ('password-reset', 'Password reset', 'Trigger password reset email', 'write-low'),
  ('email-resend', 'Email resend', 'Resend verification or notification email', 'write-low')
ON CONFLICT (key) DO NOTHING;

-- ===========================================================================
-- agent_tool_bindings — M:N persona × tool
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.agent_tool_bindings (
  persona_id UUID NOT NULL REFERENCES public.agent_personas(id) ON DELETE CASCADE,
  tool_key TEXT NOT NULL REFERENCES public.agent_tools(key) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  bound_by UUID,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (persona_id, tool_key)
);

-- Seed sensible defaults: Devon needs codebase search, Sage needs KB,
-- Atlas/Mira get account ops, Vitana stays read-only on KB.
INSERT INTO public.agent_tool_bindings (persona_id, tool_key)
SELECT p.id, t.key
  FROM public.agent_personas p
  CROSS JOIN public.agent_tools t
 WHERE (p.key = 'vitana' AND t.key IN ('kb-search','oasis-events-read'))
    OR (p.key = 'devon'  AND t.key IN ('codebase-search','kb-search','oasis-events-read'))
    OR (p.key = 'sage'   AND t.key IN ('kb-search','kb-write-draft'))
    OR (p.key = 'atlas'  AND t.key IN ('kb-search','refund-stub'))
    OR (p.key = 'mira'   AND t.key IN ('kb-search','password-reset','email-resend','profile-edit-stub'))
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- agent_kb_bindings — M:N persona × KB scope
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.agent_kb_bindings (
  persona_id UUID NOT NULL REFERENCES public.agent_personas(id) ON DELETE CASCADE,
  kb_scope TEXT NOT NULL,                  -- 'system' | 'baseline' | 'tenant' | a topic key
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (persona_id, kb_scope)
);

-- Default: every active persona gets system + baseline scopes.
INSERT INTO public.agent_kb_bindings (persona_id, kb_scope)
SELECT p.id, s
  FROM public.agent_personas p
  CROSS JOIN UNNEST(ARRAY['system','baseline']) AS s
 WHERE p.status = 'active'
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- agent_third_party_connections — encrypted external adapters
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.agent_third_party_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id UUID NOT NULL REFERENCES public.agent_personas(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                  -- 'stripe' | 'auth0' | 'zendesk' | ...
  config_encrypted BYTEA,                  -- KMS-encrypted JSON; NULL until configured
  status TEXT NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('active','disabled','error','draft')),
  last_check_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_connections_persona ON public.agent_third_party_connections (persona_id);

-- ===========================================================================
-- agent_audit_log — every persona/tool/binding/connection change
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.agent_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  persona_id UUID REFERENCES public.agent_personas(id) ON DELETE SET NULL,
  action TEXT NOT NULL                     -- 'persona_edit' | 'voice_change' | ...
    CHECK (action IN (
      'persona_edit','voice_change','prompt_change','status_change',
      'tool_bind','tool_unbind','kb_bind','kb_unbind',
      'connection_add','connection_remove','connection_update',
      'rollback','routing_rule_change'
    )),
  before_state JSONB,
  after_state JSONB,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_audit_persona ON public.agent_audit_log (persona_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_recent ON public.agent_audit_log (ts DESC);

-- ===========================================================================
-- kb_documents.specialist_tags — extend existing table for per-specialist scope
-- ===========================================================================
-- Empty array means "available to all". Any non-empty array means the doc
-- is only retrieved when the matching specialist is doing the lookup.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='kb_documents') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='kb_documents' AND column_name='specialist_tags') THEN
      ALTER TABLE public.kb_documents ADD COLUMN specialist_tags TEXT[] NOT NULL DEFAULT '{}';
      CREATE INDEX IF NOT EXISTS idx_kb_documents_specialist_tags ON public.kb_documents USING GIN (specialist_tags);
    END IF;
  END IF;
END
$$;

-- ===========================================================================
-- RLS for new tables — service-role write, authenticated read
-- ===========================================================================

ALTER TABLE public.agent_persona_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apv_select ON public.agent_persona_versions;
CREATE POLICY apv_select ON public.agent_persona_versions FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS apv_service ON public.agent_persona_versions;
CREATE POLICY apv_service ON public.agent_persona_versions FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.agent_tools ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS at_select ON public.agent_tools;
CREATE POLICY at_select ON public.agent_tools FOR SELECT TO authenticated USING (enabled = TRUE);
DROP POLICY IF EXISTS at_service ON public.agent_tools;
CREATE POLICY at_service ON public.agent_tools FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.agent_tool_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS atb_select ON public.agent_tool_bindings;
CREATE POLICY atb_select ON public.agent_tool_bindings FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS atb_service ON public.agent_tool_bindings;
CREATE POLICY atb_service ON public.agent_tool_bindings FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.agent_kb_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS akb_select ON public.agent_kb_bindings;
CREATE POLICY akb_select ON public.agent_kb_bindings FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS akb_service ON public.agent_kb_bindings;
CREATE POLICY akb_service ON public.agent_kb_bindings FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.agent_third_party_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aconn_service ON public.agent_third_party_connections;
CREATE POLICY aconn_service ON public.agent_third_party_connections FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.agent_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aal_select ON public.agent_audit_log;
CREATE POLICY aal_select ON public.agent_audit_log FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS aal_service ON public.agent_audit_log;
CREATE POLICY aal_service ON public.agent_audit_log FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT ON public.agent_persona_versions, public.agent_tools, public.agent_tool_bindings,
                public.agent_kb_bindings, public.agent_audit_log TO authenticated;
