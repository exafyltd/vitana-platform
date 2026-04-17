-- Migration: 20260418020000_vtid_02300_outbound_actions.sql
-- Purpose: VTID-02300 Phase 3 — outbound action consent system.
--          The assistant can now propose WRITE actions (post to social,
--          add to cart, log a workout, share a milestone). Each action goes
--          through a pending → approved/denied → executed/failed lifecycle.

-- ===========================================================================
-- 1. PENDING_CONNECTOR_ACTIONS — the consent queue
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.pending_connector_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,

  connector_id TEXT,                               -- null for internal actions (cart, share)
  capability TEXT NOT NULL,                        -- 'post.write', 'workout.write', 'cart.add', 'share.milestone'
  action_type TEXT NOT NULL                        -- 'social_post_story', 'wearable_log_workout', 'shopping_add_to_list', 'share_milestone'
    CHECK (action_type IN (
      'social_post_story',
      'wearable_log_workout',
      'shopping_add_to_list',
      'share_milestone',
      'calendar_add_event',
      'custom'
    )),

  -- What the action will do (shown to user in consent card)
  preview_title TEXT NOT NULL,                     -- "Post your milestone to Instagram"
  preview_description TEXT,                        -- "Share your 30-day sleep improvement with your followers"
  preview_data JSONB NOT NULL DEFAULT '{}',        -- action-specific preview (image URL, message draft, product details)

  -- Who/what requested it
  requested_by TEXT NOT NULL                       -- 'orb', 'autopilot', 'operator', 'user_ui'
    CHECK (requested_by IN ('orb','autopilot','operator','user_ui')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Execution args (frozen at request time so approve = execute exactly this)
  args JSONB NOT NULL DEFAULT '{}',

  -- Lifecycle
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','approved','denied','executing','executed','failed','expired','cancelled')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),

  -- Result (filled after execution)
  result JSONB,
  external_id TEXT,                                -- provider receipt (post URL, order ID, workout ID)
  error TEXT,

  -- Reversibility
  reversible BOOLEAN NOT NULL DEFAULT FALSE,
  reversal_handle TEXT,                            -- opaque token for undo (e.g. Instagram post ID to delete)
  reversed_at TIMESTAMPTZ,

  -- Linkage
  vtid TEXT,
  recommendation_id UUID,
  product_id UUID,

  -- Audit
  approved_at TIMESTAMPTZ,
  denied_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_user_state
  ON public.pending_connector_actions (user_id, state)
  WHERE state IN ('pending', 'executing');
CREATE INDEX IF NOT EXISTS idx_pending_actions_expiry
  ON public.pending_connector_actions (expires_at)
  WHERE state = 'pending';

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.pending_actions_bump_updated()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_pending_actions_updated ON public.pending_connector_actions;
CREATE TRIGGER trg_pending_actions_updated
  BEFORE UPDATE ON public.pending_connector_actions
  FOR EACH ROW EXECUTE FUNCTION public.pending_actions_bump_updated();

-- ===========================================================================
-- 2. ACTION_LEDGER — immutable audit trail of every outbound action
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.action_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,

  action_id UUID REFERENCES public.pending_connector_actions(id),
  connector_id TEXT,
  action_type TEXT NOT NULL,
  capability TEXT NOT NULL,

  -- Snapshot of what was executed
  args_hash TEXT NOT NULL,                         -- SHA256 of frozen args
  args_snapshot JSONB NOT NULL,
  preview_title TEXT,

  -- Outcome
  outcome TEXT NOT NULL
    CHECK (outcome IN ('executed','failed','denied','expired','reversed')),
  external_id TEXT,
  error TEXT,

  -- Attribution
  requested_by TEXT,
  vtid TEXT,
  recommendation_id UUID,
  product_id UUID,

  -- Timestamps
  requested_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_action_ledger_user
  ON public.action_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_ledger_action
  ON public.action_ledger (action_id);

-- ===========================================================================
-- 3. USER_ACTION_PERMISSIONS — per-user scope grants for outbound actions
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.user_action_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,

  action_type TEXT NOT NULL,                       -- 'social_post_story', 'shopping_add_to_list', etc.
  connector_id TEXT,                               -- null = applies to all connectors for this type
  granted BOOLEAN NOT NULL DEFAULT TRUE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,

  UNIQUE (tenant_id, user_id, action_type, connector_id)
);

CREATE INDEX IF NOT EXISTS idx_user_action_permissions_user
  ON public.user_action_permissions (user_id, granted);

-- ===========================================================================
-- 4. RLS + GRANTS
-- ===========================================================================

ALTER TABLE public.pending_connector_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pending_actions_select_own ON public.pending_connector_actions;
CREATE POLICY pending_actions_select_own ON public.pending_connector_actions
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS pending_actions_update_own ON public.pending_connector_actions;
CREATE POLICY pending_actions_update_own ON public.pending_connector_actions
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS pending_actions_service ON public.pending_connector_actions;
CREATE POLICY pending_actions_service ON public.pending_connector_actions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.action_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS action_ledger_select_own ON public.action_ledger;
CREATE POLICY action_ledger_select_own ON public.action_ledger
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS action_ledger_service ON public.action_ledger;
CREATE POLICY action_ledger_service ON public.action_ledger
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.user_action_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_action_permissions_select_own ON public.user_action_permissions;
CREATE POLICY user_action_permissions_select_own ON public.user_action_permissions
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS user_action_permissions_update_own ON public.user_action_permissions;
CREATE POLICY user_action_permissions_update_own ON public.user_action_permissions
  FOR UPDATE TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS user_action_permissions_service ON public.user_action_permissions;
CREATE POLICY user_action_permissions_service ON public.user_action_permissions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT, UPDATE ON public.pending_connector_actions TO authenticated;
GRANT SELECT ON public.action_ledger TO authenticated;
GRANT SELECT, UPDATE ON public.user_action_permissions TO authenticated;

-- ===========================================================================
-- 5. VTID LEDGER
-- ===========================================================================

INSERT INTO public.vtid_ledger (
  vtid, layer, module, status, title, description, summary, task_family,
  task_type, assigned_to, metadata, created_at, updated_at
) VALUES (
  'VTID-02300', 'PLATFORM', 'MARKETPLACE', 'in_progress',
  'Phase 3 — Assistant outbound actions + consent cards',
  'Consent-gated outbound actions: pending_connector_actions lifecycle, action_ledger audit, user_action_permissions grants/revokes, consent gate in tool execution path. Launch actions: shopping_add_to_list, share_milestone, social_post_story (Business accounts).',
  'Phase 3: outbound actions with user consent.',
  'PLATFORM', 'MARKETPLACE', 'claude-code',
  jsonb_build_object('source','migration','phase',3),
  NOW(), NOW()
) ON CONFLICT (vtid) DO UPDATE SET updated_at = NOW();

-- ===========================================================================
-- 6. COMMENTS
-- ===========================================================================

COMMENT ON TABLE public.pending_connector_actions IS 'VTID-02300: Consent queue for outbound actions. Write-scope tools create a pending row; user approves/denies via UI or voice; approved actions execute + log to action_ledger.';
COMMENT ON TABLE public.action_ledger IS 'VTID-02300: Immutable audit trail. Every outbound action (executed, failed, denied, expired, reversed) gets one row.';
COMMENT ON TABLE public.user_action_permissions IS 'VTID-02300: Per-user scope grants for outbound action types. Users manage at /ecosystem/permissions.';
