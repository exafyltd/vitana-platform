-- VTID-04909 — partner terms: German is the binding language.
--
-- Owner decision 2026-10-06 (replaces the English rule of VTID-04895,
-- 2026-10-05): German (`de`) is the canonical, legally binding text; English
-- is required as the second language; the other languages are translations
-- for understanding. Content keys are exact BCP-47 codes:
--   de, en, es, sr, fr, pt-BR, ru, pl, ar, zh-CN, tr
--
-- 1. Precondition: this change is defined only for the empty state. It
--    refuses to run unless partner_terms_versions and
--    partner_terms_acceptances both hold exactly 0 rows (owner requirement;
--    verified read-only 0/0 on 2026-10-06). Nothing is deleted or rewritten.
-- 2. binding_locale: default and CHECK become 'de'.
-- 3. The binding-text constraint requires content.de title + body (was en).
-- 4. publish_partner_terms_version(): the same hash construction with German
--    substituted — sha256(UTF-8(content.de.title || E'\n' || content.de.body_md))
--    — and publishing is refused without an English title + body.
--    Translations never enter the hash.
-- 5. partner_terms_acceptances.shown_locale: must be one of the 11 codes
--    (defence in depth; the gateway validates it against the version).
-- 6. Comments say German.
--
-- NOT APPLIED BY MERGING. Applying it needs the owner's separate approval
-- (RUN-MIGRATION.yml); until then the database keeps the VTID-04895 rules and
-- the gateway's draft writes (binding_locale 'de') are refused by the old
-- CHECK — no terms can be created in the meantime, by design.

DO $$
DECLARE
    n_versions BIGINT;
    n_acceptances BIGINT;
BEGIN
    SELECT count(*) INTO n_versions FROM public.partner_terms_versions;
    SELECT count(*) INTO n_acceptances FROM public.partner_terms_acceptances;
    IF n_versions <> 0 OR n_acceptances <> 0 THEN
        RAISE EXCEPTION 'VTID-04909 refused: partner terms must be empty (versions=%, acceptances=%). Nothing was changed.',
            n_versions, n_acceptances;
    END IF;
END;
$$;

-- 2. Binding language
ALTER TABLE public.partner_terms_versions DROP CONSTRAINT IF EXISTS partner_terms_versions_binding_locale_check;
ALTER TABLE public.partner_terms_versions ALTER COLUMN binding_locale SET DEFAULT 'de';
ALTER TABLE public.partner_terms_versions
    ADD CONSTRAINT partner_terms_versions_binding_locale_check CHECK (binding_locale = 'de');

-- 3. The binding text is German
ALTER TABLE public.partner_terms_versions DROP CONSTRAINT IF EXISTS partner_terms_versions_binding_text;
ALTER TABLE public.partner_terms_versions
    ADD CONSTRAINT partner_terms_versions_binding_text CHECK (
        jsonb_typeof(content -> 'de') = 'object'
        AND length(btrim(coalesce(content -> 'de' ->> 'title', ''))) > 0
        AND length(btrim(coalesce(content -> 'de' ->> 'body_md', ''))) > 0
    );

-- 4. Publish: hash from German; English must be present
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
    -- English is the required second language (VTID-04909).
    IF jsonb_typeof(v.content -> 'en') IS DISTINCT FROM 'object'
       OR length(btrim(coalesce(v.content -> 'en' ->> 'title', ''))) = 0
       OR length(btrim(coalesce(v.content -> 'en' ->> 'body_md', ''))) = 0 THEN
        RAISE EXCEPTION 'PARTNER_TERMS_ENGLISH_MISSING';
    END IF;

    SELECT * INTO prev FROM public.partner_terms_versions WHERE status = 'published' FOR UPDATE;

    -- The first version always starts a baseline.
    v_requires := CASE WHEN prev.id IS NULL THEN TRUE ELSE v.requires_reacceptance END;
    -- Canonical hash: the binding German title + line break + body. Translations are not hashed.
    v_hash := encode(sha256(convert_to((v.content -> 'de' ->> 'title') || E'\n' || (v.content -> 'de' ->> 'body_md'), 'UTF8')), 'hex');
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

-- 5. The language on screen is one of the supported codes
ALTER TABLE public.partner_terms_acceptances DROP CONSTRAINT IF EXISTS partner_terms_acceptances_shown_locale_supported;
ALTER TABLE public.partner_terms_acceptances
    ADD CONSTRAINT partner_terms_acceptances_shown_locale_supported
    CHECK (shown_locale IS NULL OR shown_locale IN ('de', 'en', 'es', 'sr', 'fr', 'pt-BR', 'ru', 'pl', 'ar', 'zh-CN', 'tr'));

-- 6. Comments
COMMENT ON TABLE public.partner_terms_versions IS 'VTID-04895/VTID-04909: versions of the partner terms. content = { <BCP-47 code>: { title, body_md } } for de, en, es, sr, fr, pt-BR, ru, pl, ar, zh-CN, tr. German (binding_locale = de) is binding and the only input to content_sha256; English is required; the others are translations. One published version at a time; published versions are immutable (trigger). Written by the gateway (exafy_admin API) only.';
COMMENT ON COLUMN public.partner_terms_versions.content_sha256 IS 'VTID-04909: sha256 of the binding German title || E''\n'' || body_md, set at publish. Translations are not hashed.';
COMMENT ON COLUMN public.partner_terms_acceptances.content_sha256 IS 'VTID-04909: sha256 of the binding German title + body of the accepted version; must equal the version''s content_sha256, whatever language was on screen.';
COMMENT ON COLUMN public.partner_terms_acceptances.shown_locale IS 'VTID-04909: the BCP-47 code of the language on screen at acceptance (de, en, es, sr, fr, pt-BR, ru, pl, ar, zh-CN, tr). German is binding regardless.';
