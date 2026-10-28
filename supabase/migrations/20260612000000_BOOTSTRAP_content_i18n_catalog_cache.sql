-- Server-side catalog localization cache (translate-on-view + cache).
--
-- Backs services/gateway/src/i18n/catalog-localizer.ts. A single shared table
-- holds per-locale translations for any finite, English-authored catalog
-- (Did-You-Know tips, product titles/descriptions, …). Keyed by
-- (domain, item_key, locale); `fields` is the translated string map and
-- `source_hash` pins the translation to the exact source copy it was made from,
-- so re-wording the English source automatically invalidates stale rows.
--
-- Adding a new localized surface = a new `domain` value. No new table, no new
-- migration. Source-language text is never stored here (returned as-is).

CREATE TABLE IF NOT EXISTS public.content_i18n (
  domain      text        NOT NULL,
  item_key    text        NOT NULL,
  locale      text        NOT NULL,
  fields      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  source_hash text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, item_key, locale)
);

COMMENT ON TABLE public.content_i18n IS
  'Translate-on-view cache for English-authored catalog content (DYK tips, products, …). Keyed by domain/item_key/locale; source_hash invalidates stale translations.';

-- Lookups are always (domain, locale, item_key IN (...)) — the PK covers it,
-- but a domain+locale index keeps range scans cheap as the table grows.
CREATE INDEX IF NOT EXISTS content_i18n_domain_locale_idx
  ON public.content_i18n (domain, locale);

-- Served exclusively through the gateway (service-role, which bypasses RLS).
-- Enable RLS and grant read-only to authenticated callers; no anon access,
-- no client writes — the gateway is the only writer.
ALTER TABLE public.content_i18n ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_i18n_read ON public.content_i18n;
CREATE POLICY content_i18n_read
  ON public.content_i18n
  FOR SELECT
  TO authenticated
  USING (true);
