-- =============================================================================
-- Content Moderation System
--
-- Every user-submitted content item (video, podcast, music, post, event,
-- group, live room) goes through a moderation pipeline:
--   PENDING → APPROVED / REJECTED / FLAGGED
--
-- Admins review items in the Content and Community admin sections.
-- Only APPROVED items are visible to the community.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.content_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    content_type    TEXT NOT NULL,           -- video, podcast, music, post, event, group, live_room
    title           TEXT NOT NULL,
    description     TEXT,
    external_url    TEXT,                    -- YouTube/Vimeo/Spotify/etc link
    thumbnail_url   TEXT,
    media_url       TEXT,                    -- direct media URL if self-hosted
    tags            TEXT[] DEFAULT '{}',
    category        TEXT,
    duration_seconds INT,

    -- Moderation
    moderation_status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, rejected, flagged
    moderation_note   TEXT,                             -- admin's reason for rejection/flag
    moderated_by      UUID,
    moderated_at      TIMESTAMPTZ,

    -- Submission
    submitted_by    UUID NOT NULL,
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Publishing
    published_at    TIMESTAMPTZ,            -- set when approved
    archived_at     TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_items_tenant ON public.content_items (tenant_id);
CREATE INDEX IF NOT EXISTS idx_content_items_status ON public.content_items (tenant_id, moderation_status);
CREATE INDEX IF NOT EXISTS idx_content_items_type ON public.content_items (tenant_id, content_type);
CREATE INDEX IF NOT EXISTS idx_content_items_submitted ON public.content_items (tenant_id, submitted_at DESC);

ALTER TABLE public.content_items ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "service_all" ON public.content_items FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Users can read their own submissions + approved items in their tenant
DO $$ BEGIN
    CREATE POLICY "tenant_read" ON public.content_items FOR SELECT TO authenticated
    USING (
        tenant_id = (SELECT (raw_app_meta_data->>'active_tenant_id')::uuid FROM auth.users WHERE id = auth.uid())
        AND (moderation_status = 'approved' OR submitted_by = auth.uid())
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Users can submit new content
DO $$ BEGIN
    CREATE POLICY "user_insert" ON public.content_items FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = (SELECT (raw_app_meta_data->>'active_tenant_id')::uuid FROM auth.users WHERE id = auth.uid())
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';

COMMENT ON TABLE public.content_items IS 'Content moderation pipeline: user submissions reviewed by tenant admins before community visibility';
