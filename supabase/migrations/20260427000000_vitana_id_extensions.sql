-- Vitana ID — Release A · 1/9
-- Enable Postgres extensions used by the resolver and generator:
--   pg_trgm       — trigram similarity for fuzzy display_name match
--   fuzzystrmatch — metaphone() phonetic match for foreign-name boost
--   unaccent      — strip diacritics so "Đorđe" / "Müller" normalize to ASCII

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS unaccent;
