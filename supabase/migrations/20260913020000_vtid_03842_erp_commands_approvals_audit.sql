-- VTID-03842 — BackOffice command orchestrator: commands, approvals, independent audit log, policy
--
-- POST /api/v1/backoffice/commands (gateway) is the single policy path for every ERP mutation
-- from the web UI, the Operator chat and ORB voice. Every attempt is a row in erp_commands
-- (idempotent per tenant × idempotency_key); a High-risk command waits in erp_approvals for a
-- DIFFERENT approver (maker-checker, GOLDEN-WORKFLOWS §1.3/§3.3); every decision is appended to
-- erp_audit_log, which nobody can update or delete — not even the service role.
--
-- Written only by the gateway with the service role. Readable by authenticated users only for
-- their own tenant through the gateway (RLS below is the backstop; the gateway enforces
-- `audit.view` etc. on top).
--
-- NOT APPLIED by the session that wrote it (execution-brief rule 4: DDL on the single Supabase
-- project needs the platform owner's explicit "apply now").

CREATE TABLE IF NOT EXISTS public.erp_commands (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL,
    requester_id     UUID NOT NULL,
    channel          TEXT NOT NULL CHECK (channel IN ('web', 'chat', 'voice', 'system')),
    type             TEXT NOT NULL,
    action           TEXT NOT NULL,
    tier             TEXT NOT NULL CHECK (tier IN ('read', 'draft', 'commit', 'high')),
    status           TEXT NOT NULL CHECK (status IN ('executed', 'failed', 'awaiting_approval', 'rejected')),
    payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved_payload JSONB,
    idempotency_key  TEXT NOT NULL,
    request_hash     TEXT NOT NULL,
    reason           TEXT,
    approval_id      UUID,
    receipt          JSONB,
    escalations      JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    executed_at      TIMESTAMPTZ,
    CONSTRAINT erp_commands_idempotency UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_erp_commands_tenant_created ON public.erp_commands (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erp_commands_tenant_status ON public.erp_commands (tenant_id, status);

CREATE TABLE IF NOT EXISTS public.erp_approvals (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    command_id         UUID NOT NULL REFERENCES public.erp_commands(id),
    tenant_id          UUID NOT NULL,
    requester_id       UUID NOT NULL,
    approve_capability TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reason             TEXT,
    decided_by         UUID,
    decided_at         TIMESTAMPTZ,
    decision_note      TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- maker-checker at the storage layer too: a decided row can never carry the requester as decider
    CONSTRAINT erp_approvals_maker_checker CHECK (decided_by IS NULL OR decided_by <> requester_id)
);
CREATE INDEX IF NOT EXISTS idx_erp_approvals_tenant_status ON public.erp_approvals (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.erp_audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    actor_id    UUID,
    actor_role  TEXT,
    channel     TEXT,
    event       TEXT NOT NULL,
    command_id  UUID,
    approval_id UUID,
    details     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_audit_log_tenant_created ON public.erp_audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erp_audit_log_command ON public.erp_audit_log (command_id);

-- Independent audit log: append-only for everyone, service role included.
CREATE OR REPLACE FUNCTION public.erp_audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'erp_audit_log is append-only (VTID-03842)';
END;
$$;
DROP TRIGGER IF EXISTS trg_erp_audit_log_immutable ON public.erp_audit_log;
CREATE TRIGGER trg_erp_audit_log_immutable
  BEFORE UPDATE OR DELETE ON public.erp_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_log_immutable();

CREATE TABLE IF NOT EXISTS public.erp_policy_settings (
    tenant_id                   UUID PRIMARY KEY,
    high_risk_amount_threshold  NUMERIC(18,2) NOT NULL DEFAULT 25000 CHECK (high_risk_amount_threshold >= 0),
    require_mfa_for_high        BOOLEAN NOT NULL DEFAULT true,
    updated_by                  UUID,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.erp_commands        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_approvals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_policy_settings ENABLE ROW LEVEL SECURITY;

-- Service role: full access (audit log: insert + select only — the trigger blocks the rest anyway)
DROP POLICY IF EXISTS erp_commands_service ON public.erp_commands;
CREATE POLICY erp_commands_service ON public.erp_commands FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS erp_approvals_service ON public.erp_approvals;
CREATE POLICY erp_approvals_service ON public.erp_approvals FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS erp_audit_log_service_insert ON public.erp_audit_log;
CREATE POLICY erp_audit_log_service_insert ON public.erp_audit_log FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS erp_audit_log_service_select ON public.erp_audit_log;
CREATE POLICY erp_audit_log_service_select ON public.erp_audit_log FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS erp_policy_settings_service ON public.erp_policy_settings;
CREATE POLICY erp_policy_settings_service ON public.erp_policy_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated users: read their own command rows only (everything else goes through the gateway)
DROP POLICY IF EXISTS erp_commands_select_own ON public.erp_commands;
CREATE POLICY erp_commands_select_own ON public.erp_commands FOR SELECT TO authenticated USING (requester_id = auth.uid());

GRANT SELECT ON public.erp_commands TO authenticated;
GRANT ALL ON public.erp_commands, public.erp_approvals, public.erp_policy_settings TO service_role;
GRANT SELECT, INSERT ON public.erp_audit_log TO service_role;
REVOKE UPDATE, DELETE ON public.erp_audit_log FROM service_role, authenticated, anon;

COMMENT ON TABLE public.erp_commands IS 'VTID-03842: every BackOffice typed-command attempt; idempotent per tenant × key; written only by the gateway';
COMMENT ON TABLE public.erp_approvals IS 'VTID-03842: High-risk command approval queue; decided_by <> requester_id enforced';
COMMENT ON TABLE public.erp_audit_log IS 'VTID-03842: append-only BackOffice audit log (trigger + revoked UPDATE/DELETE)';
COMMENT ON TABLE public.erp_policy_settings IS 'VTID-03842: per-tenant High-risk amount threshold and MFA requirement (Approvals › Policies)';
