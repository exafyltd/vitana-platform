# VTID-05165 — acceptance (Health Hub Phase 1 / C2)

Scope: the sparred plan's work package C2 (`plan-sparring.md`, Changes 12–13 and C2's side of shared interfaces S4,
S5 and S7). C1 (VTID-05164) and C3 (VTID-05166) are separate VTIDs. Stacked on #4107 (C1), which sits on A2 (#4105),
B1 (#4104), A1 (#4102), D10 WP1 (#4100) and main; merges after C1.

**What deploys:** gateway library code, dark and unreachable. `services/wellness-context` is imported by nothing in
`src` (the boundary test pins an empty importer allowlist), `WELLNESS_CONTEXT_ENABLED` is set on no task definition
and is forced off when `VITANA_ENV=staging`. No route, no consumer, no model call, **no migration, no schema change**
(`DATABASE_SCHEMA.md` unchanged).

AC-1 `buildWellnessContext(sb, identity, {purpose})` returns `{status:'disabled'|'consent_required'|'empty'|'ok',
locale, facts[]}`; `purpose` is the closed union `wellness_chat | wellness_recommendation` with no commerce member; any
other purpose, a missing identity or the flag off → `disabled` with nothing read (no consent, store or locale lookup).
Dark gate: `WELLNESS_CONTEXT_ENABLED === 'true'` and `VITANA_ENV !== 'staging'`.
TEST: test/wellness-context/context.test.ts "dark gate" — outputs/jest-c2.txt

AC-2 Consent, fail closed, nothing cached: `ai_health_analysis` through `hasHealthConsent` (D10) → otherwise
`consent_required` and A's read port is not called; a consent read error is "not granted"; per fact the matching
`sync_<category>` key on at least one Health Sync source (`HEALTH_SYNC_SOURCE_KINDS`: `apple_health`,
`health_connect`); an unconsented category is not read at all; a withdrawn `sync_sleep` removes the sleep fact at the
next call; A's own I5 answer `consent_required` is reported as `consent_required`.
TEST: test/wellness-context/context.test.ts "consent (fail closed, nothing cached)" — outputs/jest-c2.txt

AC-3 The read goes only through A's S4 port `readDailyObservations` with `purpose:'ai_context'`: one read, the codes of
the consented facts, the 30-day window ending on the last complete UTC day. `STORE_PENDING`, `STORE_DISABLED`,
`STORE_UNAVAILABLE`, `INVALID_INPUT`, `PURPOSE_REQUIRED`, empty rows, the fake store with its tables absent, a throwing
port or locale lookup → `empty`, never a throw.
TEST: test/wellness-context/context.test.ts "the read goes only through A's S4 port" — outputs/jest-c2.txt

AC-4 Facts: closed `WellnessFactKind` 1:1 from the §2 catalogue (`sleep_duration_vs_baseline`, `sleep_regularity`,
`activity_volume`, `activity_streak`, `recovery_trend`, `weight_trend`, `logged_habit`); C2 implements
`sleep_duration_vs_baseline` (`sleep_session`) and `activity_volume` (`steps`) as pure functions: 7-day mean against the
member's own 30-day mean, direction `higher|lower|stable` (±5 %), minimum data 4 recent days and 14 baseline days with a
positive baseline. The other kinds are typed and return nothing. End to end over A's S10 fake (the real S3 write and
S4 read logic), only `WellnessFactKind` values appear.
TEST: test/wellness-context/context.test.ts "facts end to end over the fake store", "comparison functions (pure)" — outputs/jest-c2.txt

AC-5 `buildWellnessSystemPrompt(basePrompt, ctx)` renders the facts as a JSON data block (only the closed fact fields,
only catalogue kinds, no facts unless `status:'ok'`) plus the boundary rules as English intent — no condition names, no
risk statements, no alerts, suggest a doctor when unsure; no quoted sentence and no per-language string (NEVER rule 41);
always wrapped with `buildLocalizedSystemPrompt(..., ctx.locale)` — pinned for all 11 locales.
TEST: test/wellness-context/context.test.ts "buildWellnessSystemPrompt" — outputs/jest-c2.txt

AC-6 Purpose boundary (Change 13): (a) nothing in `src` outside `services/wellness-context` imports it (allowlist empty);
(b) its imports are an explicit allowlist (`consent/health-consent`, `health-store/reader`, `i18n/catalog`,
`i18n/server-locale`, `i18n/llm-locale`, `@supabase/supabase-js`) with no commerce module and no provider SDK or model
router (`@google*`, vertex, gemini, openai, `@anthropic-ai/sdk`, Bedrock client, `llm-router`, `providers/`);
(c) `HEALTH_STORE_TABLES` (S5) are referenced only inside `services/health-store/**`, and `wellness-context` has no
`.from(`/`.rpc(` and imports only `health-store/reader` from the store; (d) the ratchet freezes today's direct importers
of the legacy AI readers (`user-health-context` + repository, `gemini-operator`, `orb-tools/health-depth-tools` +
repository, `wearable-analyzer` + repository) and the files referencing `get_wearable_metrics` — a new importer fails
and a removed one must be dropped from the list (only shrinks); (e) the rendered prompt for fixture facts contains no
disease/condition name from an 11-locale denylist (whole-word for Latin/Cyrillic, substring for zh/ar), with a
detector sanity check.
TEST: test/wellness-context/wellness-context-boundary.test.ts — outputs/jest-c2.txt

AC-7 The VTID-05025 commerce scan additionally bans any import of `wellness-context` (static, `require`, dynamic
`import()`) from every commerce module and from `limitations-filter.ts`; the health store tables were already added by
A2.
TEST: test/vtid-05025-commerce-health-boundary.test.ts — outputs/jest-c2.txt

AC-8 No regression: A's, C1's suites stay green (`test/health-store`, `test/health-sync`,
`test/routes/health-ingest.test.ts`); `tsc --noEmit` shows only the 3 pre-existing environment gaps
(`libphonenumber-js`, `client-pinpoint-sms-voice-v2` absent from the shared node_modules); the full Jest run shows only
the known libphonenumber-js suite gap.
TEST: outputs/jest-c2.txt, outputs/tsc.txt, outputs/jest-full-summary.txt

## Decisions taken (inside the approved plan)

1. "At least one source" for a fact's `sync_<category>` consent = the Health Sync phone sources
   (`HEALTH_SYNC_SOURCE_KINDS`), checked in order, stopping at the first grant. Aggregator ids are not candidates yet
   (vendor chosen in Phase 2); a member whose only source of a category is a device cloud (`wearables` key) gets no
   fact for it. Most conservative reading: fail closed.
2. The 30-day baseline includes the recent 7 days (both windows end on the reference date) — the literal "7-day mean
   against the member's own 30-day mean".
3. Reference date = the last complete UTC day; record codes are attributed with the reader's default UTC zone (the
   member's zone is not resolved in C2).
4. `logged_habit` maps to `self_logged_health` (habits have no `sync_*` key); it is typed only and returns nothing in C2.
5. The dark gate is also forced off on staging (`VITANA_ENV === 'staging'`), the established pattern for a path that
   reads member health data on a database staging shares with production.
6. The locale is resolved after the dark/purpose gates and before the consent check, so a `consent_required` result
   carries the member's locale for a Phase 4 consumer; a locale lookup error falls back to `de` (default).
7. The provider ban in (b) is stricter than the plan's list: it also bans the Bedrock client, `llm-router` and
   `providers/`, because C2 makes no model call at all.

## Not in C2

No consumer, no model call, no output guard or golden sets (Phase 4); the other five fact kinds (Phase 1 feature layer /
Phase 4); rerouting the legacy AI readers (Phase 4 — the ratchet only freezes them).
