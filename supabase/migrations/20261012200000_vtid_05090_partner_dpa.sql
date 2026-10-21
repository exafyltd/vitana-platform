-- VTID-05090 — partner data processing agreement (AVV, GDPR Art. 28): versions
-- published by Vitanaland, signed by the supplier on Vitanaland itself.
--
-- NOT APPLIED BY MERGING. Applied only via RUN-MIGRATION.yml after the owner's
-- production approval. Until then the gateway reads fail closed: the `dpa`
-- onboarding step shows "not published yet" (dpa_not_published) and nothing
-- can be signed.
--
-- A sibling of the partner terms tables (VTID-04895 / VTID-04909); those are
-- not touched. Nothing existing is altered or dropped. The 'dpa' value in the
-- partner_onboarding_steps CHECK stays (the gateway derives the step from the
-- signatures below and no longer reads that row).
--
-- 1. partner_dpa_versions — every version of the agreement. German (`de`) is
--    binding; English (`en`) is required at publish; other locales are
--    translations. content = { <BCP-47 code>: { title, body_md,
--    signing_declaration? } }. The text and the signing declaration are
--    supplied by the owner/legal through the exafy_admin API — never stored in
--    code. One published version at a time; a published version is immutable.
-- 2. publish_partner_dpa_version() — the publish transaction. The database
--    computes the hash: sha256(UTF-8(de.title || E'\n' || de.body_md || E'\n'
--    || coalesce(de.signing_declaration, ''))). The declaration is part of
--    what is signed, so it is hashed. baseline_version_id works as for the
--    terms: a version that requires re-signing starts a new baseline.
-- 3. partner_dpa_signatures — append-only signature record: who signed (user
--    id + email from the authenticated identity), the typed name and role
--    (supplier-stated, not verified), the ticked declaration, the exact
--    version + hash + language on screen, a snapshot of the contracting
--    organization, time, IP and user agent. Written by the gateway only.
--
-- Fully idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.

-- ---------------------------------------------------------------------------
-- 1. Versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_dpa_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT NOT NULL UNIQUE CHECK (length(btrim(version)) BETWEEN 1 AND 40),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
    requires_resign BOOLEAN NOT NULL DEFAULT TRUE,
    binding_locale TEXT NOT NULL DEFAULT 'de' CHECK (binding_locale = 'de'),
    content JSONB NOT NULL,
    content_sha256 TEXT,
    baseline_version_id UUID REFERENCES public.partner_dpa_versions(id),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_by UUID,
    published_at TIMESTAMPTZ,
    CONSTRAINT partner_dpa_versions_binding_text CHECK (
        jsonb_typeof(content -> 'de') = 'object'
        AND length(btrim(coalesce(content -> 'de' ->> 'title', ''))) > 0
        AND length(btrim(coalesce(content -> 'de' ->> 'body_md', ''))) > 0
    ),
    CONSTRAINT partner_dpa_versions_published_fields CHECK (
        status = 'draft'
        OR (content_sha256 IS NOT NULL AND published_at IS NOT NULL AND baseline_version_id IS NOT NULL)
    )
);

COMMENT ON TABLE public.partner_dpa_versions IS 'VTID-05090: versions of the partner data processing agreement (AVV). content = { <BCP-47 code>: { title, body_md, signing_declaration? } } for de, en, es, sr, fr, pt-BR, ru, pl, ar, zh-CN, tr. German (binding_locale = de) is binding and the only input to content_sha256; English is required at publish. One published version at a time; published versions are immutable (trigger). Written by the gateway (exafy_admin API) only; the text is supplied by the owner/legal, never by code.';
COMMENT ON COLUMN public.partner_dpa_versions.content_sha256 IS 'VTID-05090: sha256 of the binding German title || E''\n'' || body_md || E''\n'' || coalesce(signing_declaration, ''''), set at publish. Translations are not hashed.';

CREATE UNIQUE INDEX IF NOT EXISTS partner_dpa_versions_one_published
    ON public.partner_dpa_versions ((TRUE)) WHERE status = 'published';

CREATE OR REPLACE FUNCTION public.partner_dpa_versions_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'PARTNER_DPA_IMMUTABLE: a % version cannot be deleted', OLD.status;
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
            RAISE EXCEPTION 'PARTNER_DPA_IMMUTABLE: publishing changes only status, publisher, hash and baseline';
        END IF;
        RETURN NEW;
    END IF;

    -- Superseding: only the status changes.
    IF OLD.status = 'published' AND NEW.status = 'superseded' THEN
        IF (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
            RAISE EXCEPTION 'PARTNER_DPA_IMMUTABLE: superseding changes only the status';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'PARTNER_DPA_IMMUTABLE: % -> % is not allowed', OLD.status, NEW.status;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_dpa_versions_guard ON public.partner_dpa_versions;
CREATE TRIGGER trg_partner_dpa_versions_guard
    BEFORE UPDATE OR DELETE ON public.partner_dpa_versions
    FOR EACH ROW EXECUTE FUNCTION public.partner_dpa_versions_guard();

ALTER TABLE public.partner_dpa_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_dpa_versions_select ON public.partner_dpa_versions;
CREATE POLICY partner_dpa_versions_select ON public.partner_dpa_versions
    FOR SELECT TO authenticated
    USING (status IN ('published', 'superseded'));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.partner_dpa_versions FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Publish (one transaction)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.publish_partner_dpa_version(p_id UUID, p_actor UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v public.partner_dpa_versions%ROWTYPE;
    prev public.partner_dpa_versions%ROWTYPE;
    v_requires BOOLEAN;
    v_hash TEXT;
    v_baseline UUID;
BEGIN
    SELECT * INTO v FROM public.partner_dpa_versions WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PARTNER_DPA_NOT_FOUND';
    END IF;
    IF v.status <> 'draft' THEN
        RAISE EXCEPTION 'PARTNER_DPA_NOT_DRAFT';
    END IF;
    -- English is the required second language.
    IF jsonb_typeof(v.content -> 'en') IS DISTINCT FROM 'object'
       OR length(btrim(coalesce(v.content -> 'en' ->> 'title', ''))) = 0
       OR length(btrim(coalesce(v.content -> 'en' ->> 'body_md', ''))) = 0 THEN
        RAISE EXCEPTION 'PARTNER_DPA_ENGLISH_MISSING';
    END IF;

    SELECT * INTO prev FROM public.partner_dpa_versions WHERE status = 'published' FOR UPDATE;

    -- The first version always starts a baseline.
    v_requires := CASE WHEN prev.id IS NULL THEN TRUE ELSE v.requires_resign END;
    -- Canonical hash: the binding German title, body and signing declaration. Translations are not hashed.
    v_hash := encode(sha256(convert_to(
        (v.content -> 'de' ->> 'title') || E'\n' || (v.content -> 'de' ->> 'body_md') || E'\n'
        || coalesce(v.content -> 'de' ->> 'signing_declaration', ''),
        'UTF8')), 'hex');
    v_baseline := CASE WHEN v_requires THEN v.id ELSE prev.baseline_version_id END;

    IF prev.id IS NOT NULL THEN
        UPDATE public.partner_dpa_versions SET status = 'superseded', updated_at = NOW() WHERE id = prev.id;
    END IF;

    UPDATE public.partner_dpa_versions
    SET status = 'published',
        requires_resign = v_requires,
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
        'requires_resign', v_requires,
        'baseline_version_id', v_baseline,
        'superseded_id', prev.id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_partner_dpa_version(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_partner_dpa_version(UUID, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Signatures (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_dpa_signatures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_organization_id UUID NOT NULL REFERENCES public.partner_organizations(id) ON DELETE CASCADE,
    dpa_version_id UUID NOT NULL REFERENCES public.partner_dpa_versions(id),
    dpa_version TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    shown_locale TEXT NOT NULL CHECK (shown_locale IN ('de', 'en', 'es', 'sr', 'fr', 'pt-BR', 'ru', 'pl', 'ar', 'zh-CN', 'tr')),
    signed_by UUID NOT NULL,
    signer_email TEXT NOT NULL CHECK (length(btrim(signer_email)) > 0),
    signer_name TEXT NOT NULL CHECK (length(btrim(signer_name)) BETWEEN 1 AND 200),
    signer_role TEXT NOT NULL CHECK (length(btrim(signer_role)) BETWEEN 1 AND 120),
    declaration_confirmed BOOLEAN NOT NULL CHECK (declaration_confirmed = TRUE),
    org_snapshot JSONB NOT NULL CHECK (jsonb_typeof(org_snapshot) = 'object'),
    signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address TEXT,
    user_agent TEXT,
    CONSTRAINT partner_dpa_signatures_org_version_uidx UNIQUE (partner_organization_id, dpa_version_id)
);

COMMENT ON TABLE public.partner_dpa_signatures IS 'VTID-05090: append-only record of a partner organization signing a version of the data processing agreement on Vitanaland: the exact version + hash + language on screen, the signer (user id and email from the authenticated identity; typed name and role as stated by the supplier, not verified), the ticked declaration, the organization as it was (org_snapshot: legal_name, country, vat_id, website), time, IP and user agent. One row per org and version. Written by the gateway only.';
COMMENT ON COLUMN public.partner_dpa_signatures.signer_role IS 'VTID-05090: the role/position the signer typed — a supplier declaration, never verified by Vitanaland.';

-- Insert: the version must be the published one, and the hash must match it.
-- dpa_version is filled from the FK, so the two can never disagree.
CREATE OR REPLACE FUNCTION public.partner_dpa_signatures_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v RECORD;
BEGIN
    SELECT version, status, content_sha256 INTO v
    FROM public.partner_dpa_versions WHERE id = NEW.dpa_version_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PARTNER_DPA_VERSION_UNKNOWN';
    END IF;
    IF v.status <> 'published' THEN
        RAISE EXCEPTION 'PARTNER_DPA_VERSION_NOT_CURRENT';
    END IF;
    IF NEW.content_sha256 IS DISTINCT FROM v.content_sha256 THEN
        RAISE EXCEPTION 'PARTNER_DPA_CONTENT_MISMATCH';
    END IF;
    NEW.dpa_version := v.version;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_dpa_signatures_check ON public.partner_dpa_signatures;
CREATE TRIGGER trg_partner_dpa_signatures_check
    BEFORE INSERT ON public.partner_dpa_signatures
    FOR EACH ROW EXECUTE FUNCTION public.partner_dpa_signatures_check();

-- Append-only. A cascade from deleting the organization itself (the FK's
-- ON DELETE CASCADE, which runs at trigger depth > 1) is still allowed.
CREATE OR REPLACE FUNCTION public.partner_dpa_signatures_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'PARTNER_DPA_SIGNATURE_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_dpa_signatures_append_only ON public.partner_dpa_signatures;
CREATE TRIGGER trg_partner_dpa_signatures_append_only
    BEFORE UPDATE OR DELETE ON public.partner_dpa_signatures
    FOR EACH ROW EXECUTE FUNCTION public.partner_dpa_signatures_append_only();

ALTER TABLE public.partner_dpa_signatures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_dpa_signatures_select ON public.partner_dpa_signatures;
CREATE POLICY partner_dpa_signatures_select ON public.partner_dpa_signatures
    FOR SELECT TO authenticated
    USING (public.is_partner_org_member(partner_organization_id));

-- TRUNCATE included: Supabase's default grants give it to browser roles and
-- RLS does not apply to it.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.partner_dpa_signatures FROM anon, authenticated;
