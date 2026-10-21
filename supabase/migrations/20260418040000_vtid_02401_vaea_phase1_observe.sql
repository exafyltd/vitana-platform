-- Migration: 20260418040000_vtid_02401_vaea_phase1_observe.sql
-- Purpose: VTID-02401 VAEA Phase 1 — observe-mode foundation.
--          Adds listener channels, detected questions, and reply drafts.
--          Zero posting. Zero mesh. Classifier + matcher run, results land
--          in DB for the Business Hub to surface (wiring comes later).

-- ===========================================================================
-- 1. VAEA_LISTENER_CHANNELS — per-user channel configs
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.vaea_listener_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,

  platform TEXT NOT NULL                             -- 'maxina','slack','discord','telegram','reddit','custom'
    CHECK (platform IN ('maxina','slack','discord','telegram','reddit','custom')),
  channel_key TEXT NOT NULL,                         -- platform-specific channel ID
  display_name TEXT,

  -- Adapter config — polling URL, auth token ref, webhook path, etc.
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Per-channel autonomy override (null = use vaea_config.autonomy_default)
  autonomy TEXT
    CHECK (autonomy IS NULL OR autonomy IN ('silent','draft_to_user','one_tap_approve','auto_post')),

  -- Lifecycle
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_ingested_at TIMESTAMPTZ,
  last_ingest_cursor TEXT,                           -- opaque cursor for resumable polling
  last_error TEXT,

  -- Dry-run shadow mode — classifier runs but drafts are marked shadow=true
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, user_id, platform, channel_key)
);

CREATE INDEX IF NOT EXISTS idx_vaea_channels_user_active
  ON public.vaea_listener_channels (tenant_id, user_id, active)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_vaea_channels_platform
  ON public.vaea_listener_channels (platform, active)
  WHERE active = TRUE;

DROP TRIGGER IF EXISTS trg_vaea_channels_updated ON public.vaea_listener_channels;
CREATE TRIGGER trg_vaea_channels_updated
  BEFORE UPDATE ON public.vaea_listener_channels
  FOR EACH ROW EXECUTE FUNCTION public.vaea_config_bump_updated();

-- ===========================================================================
-- 2. VAEA_DETECTED_QUESTIONS — audit trail of every message the classifier scored
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.vaea_detected_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,                             -- the user whose VAEA observed this
  channel_id UUID NOT NULL REFERENCES public.vaea_listener_channels(id) ON DELETE CASCADE,

  -- Source message
  external_message_id TEXT NOT NULL,                 -- platform-native id (dedup key)
  platform TEXT NOT NULL,
  author_handle TEXT,
  author_external_id TEXT,
  message_body TEXT NOT NULL,
  message_url TEXT,
  posted_at TIMESTAMPTZ,

  -- Classifier output (0.0 - 1.0 per axis)
  is_purchase_intent NUMERIC(3,2),
  topic_match NUMERIC(3,2),
  urgency NUMERIC(3,2),
  already_answered NUMERIC(3,2),
  poster_fit NUMERIC(3,2),
  combined_score NUMERIC(3,2),
  classifier_version TEXT NOT NULL DEFAULT 'v0-heuristic',

  -- Disposition
  disposition TEXT NOT NULL DEFAULT 'scored'
    CHECK (disposition IN ('scored','below_threshold','excluded','skipped','drafted','rejected_by_user')),
  disposition_reason TEXT,

  -- Keywords / topic extracted from message
  extracted_topics TEXT[] NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (channel_id, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_vaea_detected_user_recent
  ON public.vaea_detected_questions (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vaea_detected_disposition
  ON public.vaea_detected_questions (user_id, disposition, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vaea_detected_score
  ON public.vaea_detected_questions (user_id, combined_score DESC)
  WHERE disposition = 'drafted';

-- ===========================================================================
-- 3. VAEA_REPLY_DRAFTS — proposed replies awaiting approval (observe mode: never sent)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.vaea_reply_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,

  detected_question_id UUID NOT NULL REFERENCES public.vaea_detected_questions(id) ON DELETE CASCADE,
  catalog_item_id UUID REFERENCES public.vaea_referral_catalog(id) ON DELETE SET NULL,

  -- Drafted reply (not sent — observe only)
  reply_body TEXT NOT NULL,
  reply_includes_disclosure BOOLEAN NOT NULL DEFAULT TRUE,
  reply_includes_non_affiliate_alt BOOLEAN NOT NULL DEFAULT FALSE,

  -- Match rationale
  match_reason TEXT,                                 -- human-readable explanation
  match_score NUMERIC(3,2),
  match_tier TEXT                                    -- 'own' / 'vetted_partner' / 'affiliate_network'
    CHECK (match_tier IS NULL OR match_tier IN ('own','vetted_partner','affiliate_network')),

  -- Status — drafts in Phase 1 stay `shadow` (visible but un-actionable) until
  -- Phase 2 introduces one-tap approval. `dismissed` means user rejected the draft.
  status TEXT NOT NULL DEFAULT 'shadow'
    CHECK (status IN ('shadow','pending_approval','approved','dismissed','expired')),

  composer_version TEXT NOT NULL DEFAULT 'v0-template',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours')
);

CREATE INDEX IF NOT EXISTS idx_vaea_drafts_user_status
  ON public.vaea_reply_drafts (tenant_id, user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vaea_drafts_expiry
  ON public.vaea_reply_drafts (expires_at)
  WHERE status IN ('shadow','pending_approval');

DROP TRIGGER IF EXISTS trg_vaea_drafts_updated ON public.vaea_reply_drafts;
CREATE TRIGGER trg_vaea_drafts_updated
  BEFORE UPDATE ON public.vaea_reply_drafts
  FOR EACH ROW EXECUTE FUNCTION public.vaea_config_bump_updated();

-- ===========================================================================
-- 4. RLS + GRANTS
-- ===========================================================================

ALTER TABLE public.vaea_listener_channels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vaea_channels_own ON public.vaea_listener_channels;
CREATE POLICY vaea_channels_own ON public.vaea_listener_channels
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS vaea_channels_service ON public.vaea_listener_channels;
CREATE POLICY vaea_channels_service ON public.vaea_listener_channels
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.vaea_detected_questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vaea_detected_select_own ON public.vaea_detected_questions;
CREATE POLICY vaea_detected_select_own ON public.vaea_detected_questions
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS vaea_detected_service ON public.vaea_detected_questions;
CREATE POLICY vaea_detected_service ON public.vaea_detected_questions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.vaea_reply_drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vaea_drafts_select_own ON public.vaea_reply_drafts;
CREATE POLICY vaea_drafts_select_own ON public.vaea_reply_drafts
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS vaea_drafts_update_own ON public.vaea_reply_drafts;
CREATE POLICY vaea_drafts_update_own ON public.vaea_reply_drafts
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS vaea_drafts_service ON public.vaea_reply_drafts;
CREATE POLICY vaea_drafts_service ON public.vaea_reply_drafts
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vaea_listener_channels TO authenticated;
GRANT SELECT ON public.vaea_detected_questions TO authenticated;
GRANT SELECT, UPDATE ON public.vaea_reply_drafts TO authenticated;

-- ===========================================================================
-- 5. VTID LEDGER
-- ===========================================================================

INSERT INTO public.vtid_ledger (
  vtid, layer, module, status, title, description, summary, task_family,
  task_type, assigned_to, metadata, created_at, updated_at
) VALUES (
  'VTID-02401', 'PLATFORM', 'VAEA', 'in_progress',
  'VAEA Phase 1 — observe-mode listener + classifier + matcher',
  'Ingests messages from listener channels, scores buying intent, matches against vaea_referral_catalog, writes drafts to DB. ZERO posting. ZERO mesh. Drafts stay in shadow status until Phase 2 introduces one-tap approval.',
  'Observe-mode detection loop. Gated behind VAEA_PHASE_1_OBSERVE_ENABLED. Maxina adapter is the first concrete listener; framework is generic so other platforms plug in via vaea_listener_channels.config.',
  'ECONOMIC_ACTOR',
  'observe_mode',
  'platform',
  jsonb_build_object(
    'phase', 1,
    'mode', 'observe_only',
    'posting', false,
    'mesh', false,
    'tables', jsonb_build_array(
      'vaea_listener_channels',
      'vaea_detected_questions',
      'vaea_reply_drafts'
    ),
    'classifier', 'v0-heuristic',
    'composer', 'v0-template',
    'feature_flags', jsonb_build_array(
      'VAEA_ENABLED',
      'VAEA_PHASE_1_OBSERVE_ENABLED'
    )
  ),
  NOW(), NOW()
)
ON CONFLICT (vtid) DO UPDATE SET
  status = EXCLUDED.status,
  description = EXCLUDED.description,
  summary = EXCLUDED.summary,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
