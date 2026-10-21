# VTID-04909 — Partner terms: German binding, 11 exact locales, German fallback

Owner decision 2026-10-06 replaces VTID-04895's O-3 (English binding): German (`de`) is the canonical, legally binding text and the only input to the content hash; English is required as the second language; the terms carry de, en, es, sr, fr, pt-BR, ru, pl, ar, zh-CN, tr under their exact BCP-47 codes. Nothing is published, created or accepted by this change; the migration is committed but **not applied** (separate owner approval; it refuses unless 0 versions and 0 acceptances — verified read-only 0/0 on 2026-10-06).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: unchanged — `/api/v1/admin/partner-terms` (admin-partner-terms router) and `GET /:orgId/terms`, `POST /:orgId/terms/accept` on the partner-onboarding router (`/api/v1/partner-onboarding`).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/:orgId/terms

CURL_PROOF: STAGING-VERIFY runs docs/validation/VTID-04909/staging-tests.json — unsigned GETs of both terms routes answer 401 JSON (rejected probes; nothing is read or written).

OASIS_PROOF: unchanged topics; `partner_org.terms_accepted` payload now carries the BCP-47 `shown_locale` (asserted in services/gateway/test/partner-onboarding.test.ts).

## Authority model (exact)

- `BINDING_LOCALE = 'de'`; `SUPPORTED_TERMS_LOCALES = de, en, es, sr, fr, pt-BR, ru, pl, ar, zh-CN, tr` (display order); `REQUIRED_TERMS_LOCALES = de, en`.
- Canonical hash (database, at publish): `sha256(convert_to(content.de.title || E'\n' || content.de.body_md, 'UTF8'))` — the VTID-04895 construction with German substituted. Translations never enter it.
- Translation-only corrections: a new version with `requires_reacceptance=false` (same baseline; same canonical hash while German is unchanged). Published versions stay immutable, so each acceptance's `terms_version_id` + `shown_locale` identify exactly which translation was on screen.
- Locale mapping (`resolveTermsLocale`): exact code first (case-insensitive, `_` = `-`), then the base language only for bare codes. App catalog keys: de-DE→de, en-US→en, es-ES→es, sr-RS→sr, fr-FR→fr, pt-BR→pt-BR, ru-RU→ru, pl-PL→pl, ar-XA→ar, zh-CN→zh-CN, tr-TR→tr. `pt`, `pt-PT`, `zh`, `zh-TW` and anything else unmatched → **German** (`fallback: true`), never English.
- BCP-47 contract change (admin API): content keys must be one of the 11 exact codes (was `^[a-z]{2}$`); `pt`/`zh` are rejected with a message naming `pt-BR`/`zh-CN`. `de` and `en` need title + body. No stored data affected (0 versions).
- Accept: `shown_locale` must be one of the version's available codes (400 `INVALID_SHOWN_LOCALE`); the body's hash must equal the version's German hash whatever language was on screen; assistant (OAuth-delegated) tokens are still refused (403 `TERMS_ACCEPTANCE_REQUIRES_SUPPLIER`); admin writes still need the own session (`REQUIRES_OWN_SESSION`); repeat acceptance stays idempotent; the re-acceptance baseline is unchanged.
- GET terms response adds `locale`, `fallback`, `direction` (`rtl` for `ar`), `text`, `available_locales`; `binding` is the German text; `translation` is kept for older clients.

## Acceptance criteria

AC-1: German is mandatory and binding: a missing German object, title or body is a validation error; English is required; the 11 exact codes (incl. `pt-BR`, `zh-CN`) are accepted, `pt`/`zh`/others rejected without silent mapping.
  TEST: services/gateway/test/admin-partner-terms.test.ts
  TEST: scripts/ci/sql-tests/vtid-04909-partner-terms-german.test.sql
AC-2: The canonical hash is German only: German title/body changes change it, English does not determine it, a translation-only correction leaves it unchanged; acceptance binds it whatever language was shown.
  TEST: scripts/ci/sql-tests/vtid-04909-partner-terms-german.test.sql
  TEST: services/gateway/test/admin-partner-terms.test.ts
  TEST: services/gateway/test/partner-onboarding.test.ts
AC-3: Locale resolution for every app language, exact `pt-BR`/`zh-CN`, German fallback (never English), Arabic `rtl`.
  TEST: services/gateway/test/admin-partner-terms.test.ts
  TEST: services/gateway/test/partner-onboarding.test.ts
AC-4: Acceptance: shown language validated (gateway + DB CHECK), assistant tokens refused, repeat idempotent, switching language never creates a second acceptance.
  TEST: services/gateway/test/partner-onboarding.test.ts
  TEST: scripts/ci/sql-tests/vtid-04909-partner-terms-german.test.sql
AC-5: The migration refuses to run unless both tables are empty and changes nothing when it refuses.
  TEST: scripts/ci/sql-tests/run-partner-terms-test.sh

## Not done here (gates)

Applying the migration (owner approval; until then draft writes are refused by the old `binding_locale = 'en'` CHECK — no terms can be created meanwhile). Creating/publishing v1, any acceptance, any production deploy.
