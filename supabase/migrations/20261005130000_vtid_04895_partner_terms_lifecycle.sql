-- VTID-04895 — partner terms lifecycle: publish, show, accept, re-accept.
--
-- Until now the "version in force" was the env var PARTNER_TERMS_VERSION,
-- which no deploy sets, so no supplier could ever accept or submit
-- (terms_not_published). The terms text itself was stored nowhere.
--
-- 1. partner_terms_versions — every version of the partner terms. English is
--    the binding language (owner decision 2026-10-05); other locales in
--    `content` are translations shown alongside. Exactly one version is
--    published at a time. A published version is immutable: the trigger below
--    allows only draft edits, draft -> published (publish fields only) and
--    published -> superseded (status only), even for the service role.
-- 2. baseline_version_id — set at publish: the version itself when it
--    requires re-acceptance, else the previous version's baseline. An
--    acceptance of any version with the current baseline counts, so an
--    editorial update keeps acceptances valid and a material one does not.
--    Nothing is ever copied forward: every acceptance row is an act of the
--    user named in it.
-- 3. partner_terms_acceptances gains terms_version_id, content_sha256 and
--    shown_locale, and becomes append-only. Production held 0 rows when this
--    was written (verified read-only 2026-10-05).
-- 4. publish_partner_terms_version() — the publish transaction.
-- 5. auth_session_is_delegated() — whether a session was created for an OAuth
--    client (an AI assistant). Depends on Supabase Auth's internal
--    auth.sessions.oauth_client_id: re-verify after any Supabase Auth upgrade.
--    If the column changes the function errors and the gateway refuses the
--    acceptance (fail closed).

-- ---------------------------------------------------------------------------
-- 1. Versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_terms_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT NOT NULL UNIQUE CHECK (length(btrim(version)) BETWEEN 1 AND 40),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
    requires_reacceptance BOOLEAN NOT NULL DEFAULT TRUE,
    binding_locale TEXT NOT NULL DEFAULT 'en' CHECK (binding_locale = 'en'),
    content JSONB NOT NULL,
    content_sha256 TEXT,
    baseline_version_id UUID REFERENCES public.partner_terms_versions(id),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_by UUID,
    published_at TIMESTAMPTZ,
    CONSTRAINT partner_terms_versions_binding_text CHECK (
        jsonb_typeof(content -> 'en') = 'object'
        AND length(btrim(coalesce(content -> 'en' ->> 'title', ''))) > 0
        AND length(btrim(coalesce(content -> 'en' ->> 'body_md', ''))) > 0
    ),
    CONSTRAINT partner_terms_versions_published_fields CHECK (
        status = 'draft'
        OR (content_sha256 IS NOT NULL AND published_at IS NOT NULL AND baseline_version_id IS NOT NULL)
    )
);

COMMENT ON TABLE public.partner_terms_versions IS 'VTID-04895: versions of the partner terms. content = { <locale>: { title, body_md } }; English (binding_locale) is binding, other locales are translations. One published version at a time; published versions are immutable (trigger). Written by the gateway (exafy_admin API) only.';

CREATE UNIQUE INDEX IF NOT EXISTS partner_terms_versions_one_published
    ON public.partner_terms_versions ((TRUE)) WHERE status = 'published';

CREATE OR REPLACE FUNCTION public.partner_terms_versions_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'PARTNER_TERMS_IMMUTABLE: a % version cannot be deleted', OLD.status;
        END IF;
        RETURN OLD;
    END IF;

    -- Draft edits, while it stays a draft.
    IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
        RETURN NEW;
    END IF;

    -- Publishing: only the publish fields change. The text is final.
    IF OLD.status = 'draft' AND NEW.status = 'published' THEN
        IF NEW.version IS DISTINCT FROM OLD.version
           OR NEW.content IS DISTINCT FROM OLD.content
           OR NEW.binding_locale IS DISTINCT FROM OLD.binding_locale
           OR NEW.created_by IS DISTINCT FROM OLD.created_by
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'PARTNER_TERMS_IMMUTABLE: publishing changes only status, publisher, hash and baseline';
        END IF;
        RETURN NEW;
    END IF;

    -- Superseding: only the status changes.
    IF OLD.status = 'published' AND NEW.status = 'superseded' THEN
        IF (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
            RAISE EXCEPTION 'PARTNER_TERMS_IMMUTABLE: superseding changes only the status';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'PARTNER_TERMS_IMMUTABLE: % -> % is not allowed', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_terms_versions_guard ON public.partner_terms_versions;
CREATE TRIGGER trg_partner_terms_versions_guard
    BEFORE UPDATE OR DELETE ON public.partner_terms_versions
    FOR EACH ROW EXECUTE FUNCTION public.partner_terms_versions_guard();

ALTER TABLE public.partner_terms_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_terms_versions_select ON public.partner_terms_versions;
CREATE POLICY partner_terms_versions_select ON public.partner_terms_versions
    FOR SELECT TO authenticated
    USING (status IN ('published', 'superseded'));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.partner_terms_versions FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Acceptances: the exact version, the text's hash, the language shown
-- ---------------------------------------------------------------------------
ALTER TABLE public.partner_terms_acceptances
    ADD COLUMN IF NOT EXISTS terms_version_id UUID REFERENCES public.partner_terms_versions(id),
    ADD COLUMN IF NOT EXISTS content_sha256 TEXT,
    ADD COLUMN IF NOT EXISTS shown_locale TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'partner_terms_acceptances_version_id_required'
    ) THEN
        -- NOT VALID: binds every new row; rows from before this migration (none
        -- in production) are left as they are.
        ALTER TABLE public.partner_terms_acceptances
            ADD CONSTRAINT partner_terms_acceptances_version_id_required
            CHECK (terms_version_id IS NOT NULL AND content_sha256 IS NOT NULL AND shown_locale IS NOT NULL) NOT VALID;
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS partner_terms_acceptances_org_version_id_uidx
    ON public.partner_terms_acceptances (partner_organization_id, terms_version_id);

COMMENT ON COLUMN public.partner_terms_acceptances.content_sha256 IS 'VTID-04895: sha256 of the binding English title + body the supplier was shown; must equal the version''s content_sha256.';
COMMENT ON COLUMN public.partner_terms_acceptances.shown_locale IS 'VTID-04895: the languages on screen at acceptance: en, or en+<locale> when a translation was shown alongside.';

-- Insert: the version must be the published one, and the hash must match it.
-- terms_version is filled from the FK, so the two can never disagree.
CREATE OR REPLACE FUNCTION public.partner_terms_acceptances_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v RECORD;
BEGIN
    SELECT version, status, content_sha256 INTO v
    FROM public.partner_terms_versions WHERE id = NEW.terms_version_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PARTNER_TERMS_VERSION_UNKNOWN';
    END IF;
    IF v.status <> 'published' THEN
        RAISE EXCEPTION 'PARTNER_TERMS_VERSION_NOT_CURRENT';
    END IF;
    IF NEW.content_sha256 IS DISTINCT FROM v.content_sha256 THEN
        RAISE EXCEPTION 'PARTNER_TERMS_CONTENT_MISMATCH';
    END IF;
    NEW.terms_version := v.version;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_terms_acceptances_check ON public.partner_terms_acceptances;
CREATE TRIGGER trg_partner_terms_acceptances_check
    BEFORE INSERT ON public.partner_terms_acceptances
    FOR EACH ROW EXECUTE FUNCTION public.partner_terms_acceptances_check();

-- Append-only. A cascade from deleting the organization itself (the FK's
-- ON DELETE CASCADE, which runs at trigger depth > 1) is still allowed.
CREATE OR REPLACE FUNCTION public.partner_terms_acceptances_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'PARTNER_TERMS_ACCEPTANCE_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_terms_acceptances_append_only ON public.partner_terms_acceptances;
CREATE TRIGGER trg_partner_terms_acceptances_append_only
    BEFORE UPDATE OR DELETE ON public.partner_terms_acceptances
    FOR EACH ROW EXECUTE FUNCTION public.partner_terms_acceptances_append_only();

-- ---------------------------------------------------------------------------
-- 3. Publish (one transaction)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.publish_partner_terms_version(p_id UUID, p_actor UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v public.partner_terms_versions%ROWTYPE;
    prev public.partner_terms_versions%ROWTYPE;
    v_requires BOOLEAN;
    v_hash TEXT;
    v_baseline UUID;
BEGIN
    SELECT * INTO v FROM public.partner_terms_versions WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PARTNER_TERMS_NOT_FOUND';
    END IF;
    IF v.status <> 'draft' THEN
        RAISE EXCEPTION 'PARTNER_TERMS_NOT_DRAFT';
    END IF;

    SELECT * INTO prev FROM public.partner_terms_versions WHERE status = 'published' FOR UPDATE;

    -- The first version always starts a baseline.
    v_requires := CASE WHEN prev.id IS NULL THEN TRUE ELSE v.requires_reacceptance END;
    v_hash := encode(sha256(convert_to((v.content -> 'en' ->> 'title') || E'\n' || (v.content -> 'en' ->> 'body_md'), 'UTF8')), 'hex');
    v_baseline := CASE WHEN v_requires THEN v.id ELSE prev.baseline_version_id END;

    IF prev.id IS NOT NULL THEN
        UPDATE public.partner_terms_versions SET status = 'superseded', updated_at = NOW() WHERE id = prev.id;
    END IF;

    UPDATE public.partner_terms_versions
    SET status = 'published',
        requires_reacceptance = v_requires,
        content_sha256 = v_hash,
        baseline_version_id = v_baseline,
        published_by = p_actor,
        published_at = NOW(),
        updated_at = NOW()
    WHERE id = p_id;

    RETURN jsonb_build_object(
        'id', v.id,
        'version', v.version,
        'content_sha256', v_hash,
        'requires_reacceptance', v_requires,
        'baseline_version_id', v_baseline,
        'superseded_id', prev.id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_partner_terms_version(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_partner_terms_version(UUID, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Was this session created for an OAuth client (an AI assistant)?
-- ---------------------------------------------------------------------------
-- 'direct' | 'delegated' | 'unknown' (no such session). The gateway accepts
-- terms only on 'direct'.
CREATE OR REPLACE FUNCTION public.auth_session_is_delegated(p_session_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = auth, public
AS $$
    SELECT CASE
        WHEN s.id IS NULL THEN 'unknown'
        WHEN s.oauth_client_id IS NOT NULL THEN 'delegated'
        ELSE 'direct'
    END
    FROM (SELECT 1) AS one
    LEFT JOIN auth.sessions s ON s.id = p_session_id;
$$;

REVOKE ALL ON FUNCTION public.auth_session_is_delegated(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_session_is_delegated(UUID) TO service_role;
