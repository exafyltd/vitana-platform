-- =============================================================================
-- VTID-03277 — Guided Journey: Checklist curriculum schema (P2)
-- -----------------------------------------------------------------------------
-- The 90-session / 250-topic onboarding curriculum, owned by Admin Pages ->
-- Knowledge Base -> Checklist (P3 UI). My Journey (P5) consumes ONLY the
-- published version. Three tables:
--   1. journey_checklist_topics    — the editable working draft (one row/topic).
--   2. journey_checklist_versions  — immutable publish snapshots (rollback +
--      the single is_current version My Journey reads).
--   3. journey_checklist_audit     — who changed/published/rolled back what.
--
-- SECURITY: these are curriculum/admin tables. The gateway reads/writes via the
-- service-role key (bypasses RLS). RLS is ENABLED with NO permissive policy, so
-- anon/authenticated clients cannot read drafts or unpublished content directly
-- (My Journey gets the published version through the gateway). This matches the
-- platform's anon-exposure lockdown posture.
--
-- DIAGNOSE-BEFORE-EDIT: verified no journey_checklist*/curriculum/journey_topics
-- tables exist in production before authoring this migration (green-field).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. journey_checklist_topics — editable working draft (one row per topic card)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journey_checklist_topics (
  topic_id                 text PRIMARY KEY,                 -- stable id, e.g. 'T001'
  curriculum_version       text NOT NULL DEFAULT 'v2',       -- working curriculum line
  session                  integer NOT NULL CHECK (session BETWEEN 1 AND 90),
  position                 integer NOT NULL CHECK (position >= 1),  -- order within session
  chapter_id               text NOT NULL,                    -- basics|daily_use|community|health|intelligence|discovery
  display_label            text NOT NULL,                    -- 1-4 words, shown in catalog
  title                    text,
  short_description        text,                             -- one-line helper / story purpose
  vitana_voice_script      text,                             -- what Vitana speaks (required to publish)
  -- Topic Explanation summary (community-facing). Internal fields below are
  -- never shown to end users (admin/editor only).
  explanation_what_it_is   text,
  explanation_user_benefit text,
  explanation_when_to_use  text,
  explanation_try_this     text,
  guided_practice_target   text,                             -- feature key/route (required to publish)
  practice_action_type     text,
  completion_event         text,
  unlock_rule              text,
  safety_level             text NOT NULL DEFAULT 'standard',
  -- Business gating (business_interest_level). NULL = not business-gated.
  business_gate            text
    CHECK (business_gate IS NULL OR business_gate IN ('curious','active','builder')),
  source_refs              text[] NOT NULL DEFAULT '{}',
  manual_path              text,
  fallback_topic_id        text,
  status                   text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','disabled')),
  enabled                  boolean NOT NULL DEFAULT true,
  updated_by_admin_id      uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curriculum_version, session, position)
);

CREATE INDEX IF NOT EXISTS idx_journey_checklist_topics_session
  ON journey_checklist_topics (curriculum_version, session, position);
CREATE INDEX IF NOT EXISTS idx_journey_checklist_topics_chapter
  ON journey_checklist_topics (chapter_id);

ALTER TABLE journey_checklist_topics ENABLE ROW LEVEL SECURITY;
-- No permissive policy: only service-role (gateway) may read/write. Drafts and
-- unpublished edits never leak to anon/authenticated clients.

COMMENT ON TABLE journey_checklist_topics IS
  'VTID-03277 — Guided Journey editable curriculum (working draft, one row/topic). Admin-edited via Command Hub Checklist; My Journey consumes the published snapshot, not this table. RLS on, no public policy (gateway service-role only).';

-- -----------------------------------------------------------------------------
-- 2. journey_checklist_versions — immutable publish snapshots
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journey_checklist_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_label      text NOT NULL,                          -- e.g. 'v2-2026-06-08T20:30Z'
  curriculum_version text NOT NULL,
  status             text NOT NULL DEFAULT 'published'
    CHECK (status IN ('published','rolled_back','archived')),
  session_count      integer NOT NULL,
  topic_count        integer NOT NULL,
  snapshot           jsonb NOT NULL,                         -- full topic array at publish time
  validation         jsonb NOT NULL DEFAULT '{}'::jsonb,     -- validator result at publish
  is_current         boolean NOT NULL DEFAULT false,         -- the one My Journey serves
  note               text,
  published_by       uuid,
  published_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Exactly one current version per curriculum line.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_journey_checklist_current
  ON journey_checklist_versions (curriculum_version)
  WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_journey_checklist_versions_published
  ON journey_checklist_versions (curriculum_version, published_at DESC);

ALTER TABLE journey_checklist_versions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE journey_checklist_versions IS
  'VTID-03277 — immutable published snapshots of the Guided Journey curriculum. is_current=true marks the single version My Journey renders; rollback flips the pointer to a prior snapshot. RLS on, gateway service-role only.';

-- -----------------------------------------------------------------------------
-- 3. journey_checklist_audit — change/publish/rollback trail
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journey_checklist_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_admin_id uuid,
  action         text NOT NULL
    CHECK (action IN ('create','update','reorder','disable','enable','publish','rollback','export','seed')),
  topic_id       text,
  version_id     uuid,
  changed_fields jsonb,
  detail         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_journey_checklist_audit_created
  ON journey_checklist_audit (created_at DESC);

ALTER TABLE journey_checklist_audit ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE journey_checklist_audit IS
  'VTID-03277 — audit trail for Guided Journey curriculum edits, publishes, and rollbacks. RLS on, gateway service-role only.';

COMMIT;
