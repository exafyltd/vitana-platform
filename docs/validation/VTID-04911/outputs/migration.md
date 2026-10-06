# VTID-04909 German-binding migration — applied under VTID-04911

Migration: `supabase/migrations/20261006120000_vtid_04909_partner_terms_german_binding.sql` (on main since 393e3b41).

## Pre-check (read-only, Supabase MCP execute_sql, SELECT only)
- 2026-10-06 10:36:00 UTC: versions 0, acceptances 0; binding_locale CHECK `= 'en'`, default `'en'` (not yet applied)
- 2026-10-06 10:40:42 UTC (immediately before dispatch): versions 0, acceptances 0

## Apply
- `RUN-MIGRATION.yml` workflow_dispatch on `main` (393e3b41), input `migration_file` = the file above
- Run 37451365925, created 10:40:45 UTC — **completed / success** (the workflow fails on any SQL error or rollback,
  VTID-03174/03492). The migration's own guard re-checked 0/0 inside the transaction.

## Post-verification (read-only, 2026-10-06 10:41:12 UTC)
| Check | Result |
|---|---|
| `partner_terms_versions_binding_locale_check` | `CHECK ((binding_locale = 'de'::text))` |
| `binding_locale` default | `'de'::text` |
| `partner_terms_versions_binding_text` | requires `content -> 'de'` object with non-empty `title` and `body_md` |
| `publish_partner_terms_version` English required | raises `PARTNER_TERMS_ENGLISH_MISSING` — present |
| `publish_partner_terms_version` hash | `v_hash := encode(sha256(convert_to((v.content -> 'de' ->> 'title') \|\| E'\n' \|\| (v.content -> 'de' ->> 'body_md'), 'UTF8')), 'hex')`; no English hash left |
| `partner_terms_acceptances_shown_locale_supported` | `shown_locale IS NULL OR shown_locale = ANY ('de','en','es','sr','fr','pt-BR','ru','pl','ar','zh-CN','tr')` |
| EXECUTE on publish fn | anon false, authenticated false, service_role true (unchanged) |
| Rows | versions 0, acceptances 0 — nothing created |
