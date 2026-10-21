# VTID-04236 — fix Morning Health Check locale-coverage gap (check 11) and its root-cause tooling debt

## Report

Morning Health Check flagged check 11 (DB-content locale coverage) FAIL:
1 missing My Journey row (tr) and 12 missing Navigator rows (tr/zh/ar).
Investigated the exact rows via the live tables behind
`ci_vital_systems_health()` and found two things: a real, narrow content
gap (new nav_catalog entries and one journey topic were never backfilled
for tr/zh/ar), and a root-caused tooling defect — the only backfill script
for this content (`scripts/journey/generate-checklist-translations.mjs`)
calls Google's Gemini API directly, which this repo's CLAUDE.md forbids
(ALWAYS 10a/10c, IF-THEN 27 — no sanctioned Google dependency for LLM
content generation), and hardcodes its locale allowlist to `en/es/sr`
only, so it could never have produced the missing tr/zh/ar rows even if
run. No backfill script existed for `nav_catalog_i18n` at all.

## Acceptance Criteria

AC-1 — `scripts/journey/generate-checklist-translations.mjs` no longer
calls `generativelanguage.googleapis.com` (Gemini). It now invokes Claude
via `aws bedrock-runtime invoke-model` against `eu.anthropic.claude-sonnet-4-6`
(eu-central-1) — the exact invocation shape CLAUDE.md §2b documents as
verified-invokable, not merely `ACTIVE` in the profile listing. Its locale
allowlist is extended from `['en','es','sr']` to the full GA target set.

TEST: `outputs/node-check-journey.txt` — `node --check` exit 0 on the
rewritten script.

AC-2 — a new `scripts/nav/generate-nav-catalog-translations.mjs` backfills
`nav_catalog_i18n`, the table that previously had no backfill tooling at
all, using the same Bedrock-based approach and `en` as the translation
source (the reference-coverage locale this repo's own RPC already
compares every other GA locale against).

TEST: `outputs/node-check-nav.txt` — `node --check` exit 0 on the new script.

AC-3 — the exact content gap check 11 reported is closed in the live
database: My Journey topic T178 now has a `tr` row, and all 12 missing
`nav_catalog_i18n` rows (ar/tr/zh) are backfilled with real translations,
matching each script's own upsert key (`(topic_id, locale)` /
`(catalog_id, lang)`, `ON CONFLICT ... DO UPDATE`) so a future run of
either script is idempotent against this data.

TEST: `commands.log`'s final `ci_vital_systems_health()` re-check —
`journey_checklist_incomplete_ga_locales` and
`nav_catalog_incomplete_ga_locales` both return `[]`, the same fields
check 11 reads.

## Not yet independently run

This session has no `aws` CLI / AWS credentials available to actually
execute either script end-to-end (confirmed: `aws` is not installed in
this sandbox). The 13 missing rows were therefore translated directly in
this session and applied via the Supabase MCP `execute_sql` connection,
using the identical upsert shape each script would have produced — this
closes the immediate gap, but the scripts' own Bedrock invocation path
(the `aws bedrock-runtime invoke-model` call) has not been exercised
against a real Bedrock response. The next real signal is running either
script for a genuinely new/future locale gap and confirming it invokes
Bedrock successfully and produces a well-formed upsert.

OASIS_PROOF: not applicable — see `OASIS_IMPACT: no` in the PR body. This
change touches only offline content-backfill tooling and directly-applied
DB content rows; it does not touch any gateway route or emit any OASIS
event.
