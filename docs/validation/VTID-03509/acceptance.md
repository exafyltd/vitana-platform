# VTID-03509 — Acceptance (gateway: 4 → 8 locale extension)

Scope of this PR (branch `claude/vitanaland-language-expansion-fivoly`): the gateway
half of the 18 Aug 2026 eight-language release (DE, EN, ES, SR, FR, PT, RU, PL).
Companion frontend PR: `exafyltd/vitana-v1#968`.

**Note on branch scope vs. VALIDATION_PROFILE:** this branch also carries three
follow-on VTIDs authored in the same session (VTID-03515 DB-content locale
registry + auto-propagation, VTID-03517 Aurora Postgres target, VTID-03521/03522
CI fixes) rather than being split into per-VTID PRs. Their evidence is folded
into this pack rather than duplicated under separate VTID directories, since
they share one PR. Per the `gateway_backend` profile's allowlist
(`services/gateway/src/**`, `services/gateway/dist/**`,
`services/gateway/openapi/**`, `docs/validation/**`), the **path-ownership gate
will still flag** `.github/workflows/AURORA-I18N-INTEGRATION.yml`,
`.github/workflows/I18N-DB-SEED.yml`, `.github/workflows/VALIDATOR-CHECK.yml`,
`CLAUDE.md`, `docs/DB-CONTENT-I18N.md`, and
`supabase/migrations/20260806090000_VTID_03515_db_i18n_locale_registry.sql` —
none of those paths are covered by either existing profile. **Confirmed by the
actual CI run on this evidence pack's own commit:** the gate rejects earlier
than that, at its universal `deny_common` lockfile check — VTID-03517 added
the `pg`/`@types/pg` dependencies to `services/gateway/package.json`, which
regenerated `package-lock.json` and `pnpm-lock.yaml`, and those two files are
denied for every profile, unconditionally (exit 20, "REJECTED: lockfile/.env
change not allowed"), before the path-ownership step for the other files even
runs. This is the same
limitation `gov/validator-rules.yaml` has always had for data/CI-domain
changes (see VTID-03237's split into a `gateway_backend` PR + a separate data
PR, and VTID-03505/#3050's note that widening the profiles is its own
governance decision, not something to do as a side effect of an unrelated fix).
Splitting this branch after the fact, or widening the profile allowlist, is
left to a human governance call rather than done here to force a green run.

Verification tokens: TEST = jest suite (run against this branch), CURL = HTTP
contract requiring a live deploy.

AC-1 — Locale catalogs moved from inline TS objects to `src/i18n/locales/<code>.json`, all 8 ship
  TEST: services/gateway/test/i18n/catalog-coverage.test.ts ("ships all 8 release locales")

AC-2 — A locale catalog cannot silently be a copy of English (the root cause bug: `const ES = { ...EN }`)
  TEST: services/gateway/test/i18n/catalog-coverage.test.ts ("gateway i18n catalog fidelity" block)

AC-3 — Interpolation placeholders survive translation in every locale
  TEST: services/gateway/test/i18n/catalog-coverage.test.ts ("gateway i18n placeholder integrity" block)

AC-4 — `tt()` fallback order is locale → EN → DE (was DE → EN); unknown locale still resolves via DE, never a raw key
  TEST: services/gateway/test/i18n/catalog-coverage.test.ts ("tt() fallback chain" block)

AC-5 — `normalizeLocale`/`resolveLocaleStrict` disambiguate the new locales (pt/pl "po-" collision, BCP-47 tags, word-form names) instead of silently resolving to German
  TEST: services/gateway/test/i18n/llm-locale.test.ts ("locale resolution" + "buildLocalizedSystemPromptForLang" blocks)

AC-6 — LLM system-prompt localization injects the correct register hint (du/tú/ti/tu/ты/ty) per new locale, never Sie/usted/Vi/Pan
  TEST: services/gateway/test/i18n/llm-locale.test.ts ("buildLocalizedSystemPrompt", "gives every supported locale an informal-register directive")

AC-7 — `ChecklistLocale` accepts all 8 release locales instead of rejecting fr/pt/ru/pl (previously silently downgraded to the caller's profile locale)
  TEST: services/gateway/test/journey-checklist-translations.test.ts ("curriculum locale surface (VTID-03509)" block)

AC-8 — Gateway typecheck is clean
  TEST: npm run typecheck (tsc --noEmit) — 0 errors, see ./commands.log and ./outputs/typecheck.txt

AC-9 — Full gateway suite is green in CI (not re-run locally in full — ~7.5k tests, minutes to run; CI already executed it against this exact commit)
  CURL: n/a — CI evidence. GitHub Actions run 31134466729, job "Gateway (Jest, ~7.5k tests)", commit 00599fc4, conclusion=success. Job "Gateway Validation (Minimal CI)" (run 31134466712) and "integration" (run 31134466725) also green on the same commit.

# ---------------------------------------------------------------------------
# Follow-on VTID-03515/03517 — DB-content locale registry (folded into this PR)
# ---------------------------------------------------------------------------

AC-10 — `supported_locales` registry replaces the hardcoded 3-locale CHECK constraint on `journey_checklist_translations.locale`; inserting a release locale that is NOT registered is rejected by the FK, not silently accepted
  TEST: services/gateway/test/db-i18n/db-i18n.test.ts ("surface registry" block, "rejects an unknown surface by name")
  Evidence of the FK behavior in production: see VTID-03509's frontend companion PR review comment (exafyltd/vitana-platform#3055#issuecomment-5207371888) — verified `fr` inserts, an unregistered locale is still rejected.

AC-11 — `source_sha` staleness stamps on both DB-content tables detect drift even when row *coverage* is 100% (the same class of bug that let es/sr sit two months stale in the frontend catalogs)
  TEST: services/gateway/test/db-i18n/db-i18n.test.ts ("sourceSha" block — stable ordering, changes on any field change, no field-shift collision, empty-vs-missing distinction)

AC-12 — Translator repairs/validates placeholders and rejects a substantive field echoed back verbatim (untranslated) rather than accepting it as a translation
  TEST: services/gateway/test/db-i18n/db-i18n.test.ts ("placeholder handling", "validateUnit", "translateUnits batch splitting" blocks)

AC-13 — Publishing DB content fires `db-i18n-source-changed` so dependent translations are flagged, rather than silently going stale
  TEST: services/gateway/test/db-i18n/notify-source-changed.test.ts (full suite)

AC-14 — Aurora Postgres target defaults to TLS-verified, refuses plaintext to non-loopback hosts, and never silently falls back to Supabase on connection failure
  TEST: services/gateway/test/db-i18n/aurora-integration.test.ts ("aurora TLS resolution", "sslmode=disable is a loopback-only escape hatch", "never silently falls back to supabase" — unit-level assertions; this file's live-DB integration describe block is `.skip`-gated and did not run in this evidence pass, consistent with its filename)

See ./commands.log and ./outputs/ for captured command output (scoped i18n/db-i18n suite + typecheck).
