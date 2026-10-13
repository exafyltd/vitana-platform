# VTID-05143 — Unified Card System Phase 1, platform backend (builds VTID-05085)

VTID-05143 builds VTID-05085 Phase 1 (its ledger row was terminalized when only the plan docs merged); the owner reassigned the build to Claude Code on 2026-10-13. Plan of record: `docs/validation/VTID-05085/plan-sparring.md` (copied here as `plan-sparring.md`), hash `e7abbebb1e777f3aa27eea0356a5ca697328ee180c32a24e04150e2f5a238ab7` (outputs/plan-hash.log), Gate 1 approved 2026-10-12. Build steps: `docs/validation/VTID-05085/KIRO-INSTRUCTIONS.md` §0, §1, §2a, plus the owner's step plan (`.agents/tasks/unified-card-system/plan.md`, branch `docs/unified-card-system-plan`, steps 1–4).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `/api/v1/enrichment-cards` — new file `services/gateway/src/routes/enrichment-cards.ts`, mounted with `mountRouterSync(app, '/api/v1/enrichment-cards', enrichmentCardsRouter, { owner: 'enrichment-cards' })` in `src/index.ts`, next to the `/api/v1/social-accounts` mount. `requireAuth` on both routes. Routes: `GET /?screen=<screen>[&locale=<code>]` → `200 { ok, screen, locale, cards: [{ card_type, category, priority, completed, dismissed_until, title, description }], profile_completion_pct }`, 400 on an unknown screen; `POST /dismiss { card_type }` → `200 { ok, card_type, dismissed_until }`, 400 on an unknown card type. Atlas: `/^enrichment-cards$/` in the `community` domain (`orb/developer/domain-atlas.ts`).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/enrichment-cards?screen=home (staging)

CURL_PROOF: unauthenticated `GET /api/v1/enrichment-cards?screen=home` answers 401 `application/json` (auth gate before any handler); `GET /alive` 200 (`staging-tests.json`, read-only). The dismiss `POST` is never called on staging — staging writes to the production Supabase project; the write path is proven in Jest (AC-4).

MIGRATION: `supabase/migrations/20261013200000_vtid_05143_unified_card_system.sql` — `user_enrichment_cards` (plan §3.2 without `completed_at`; `CREATE INDEX IF NOT EXISTS`; `DROP POLICY IF EXISTS` before each `CREATE POLICY`; table COMMENT names VTID-05085 and VTID-05143) and `profiles.interests TEXT[] DEFAULT '{}'`. Documented in `DATABASE_SCHEMA.md`. Checked locally on PGlite (outputs/step1-pglite-migration.log). Apply after merge via `RUN-MIGRATION.yml`, then confirm read-only that the table exists. Until it is applied, `GET` answers 500 JSON (the `profiles.interests` and `user_enrichment_cards` reads fail loudly), so the vitana-v1 PR must not merge before the migration is applied.

OASIS_IMPACT: yes
OASIS_PROOF: `POST /api/v1/enrichment-cards/dismiss` emits `enrichment_card.dismissed` (vtid VTID-05143, actor = the member, payload user_id/card_type/dismissed_until) fire-and-forget after a successful upsert; topic added to services/gateway/src/types/cicd.ts. A failed upsert emits nothing; a failing emit never fails the dismiss. Proven in test/routes/enrichment-cards.test.ts ("POST /dismiss" block). Added after the impact scan's new-mutation-without-oasis-emit warning on #4085.

## Acceptance criteria

AC-1: The migration creates `user_enrichment_cards` exactly as plan §3.2 (no `completed_at`), its user index, RLS with the four policies, and `profiles.interests text[]` defaulting to `{}`; it re-runs without error and without duplicating policies; a member can insert/read/update only their own rows, service_role sees all.
TEST: node docs/validation/VTID-05143/pglite-unified-card-system-check.mjs supabase/migrations/20261013200000_vtid_05143_unified_card_system.sql (outputs/step1-pglite-migration.log, 17/17 PASS)

AC-2: `resolveCompletions(sb, userId)` returns E1–E11 from the source tables only: E1 avatar, E2 trimmed bio > 50 chars, E3 any post, E4 non-empty interests, E5 location, E6/E7 `social_connections` instagram/facebook with `is_active = true AND disconnected_at IS NULL` (no `status`), E8 enabled google/outlook/apple calendar, E9 any contact, E10 non-revoked FCM token, E11 cover; all reads in parallel, for the caller only; any read error throws (never "all incomplete").
TEST: services/gateway/test/services/enrichment/completion-resolver.test.ts
TEST: services/gateway/test/services/enrichment/completion-resolver-repository.test.ts

AC-3: `GET /api/v1/enrichment-cards?screen=` answers 401 without a token and 400 on an unknown or missing screen; for a known screen it returns the caller's incomplete, non-cooled-down enrichment cards for that screen in static priority E1→E2→E3→E6→E7→E8→E9→E4→E5→E10→E11, each with title/description in the caller's locale (`?locale=` wins over `getUserLocale`), plus `profile_completion_pct`. Screens: home, profile, longevity-journey, calendar (E8), vitana-index, autopilot (E10), community (E3/E6/E7), make-a-post (E3), talk-to-vitana, messenger (E1–E11).
TEST: services/gateway/test/routes/enrichment-cards.test.ts
CURL: staging GET /api/v1/enrichment-cards?screen=home without a token -> 401 application/json

AC-4: `POST /dismiss { card_type }` answers 401 without a token, 400 for anything but E1–E11 and (since Phase 3) G1–G3 (nothing written; G4 stays 400), upserts `dismissed_at = updated_at = now()` for the caller's own `user_id` only (a `user_id` in the body is ignored) and returns `dismissed_until = dismissed_at + cooldown_days`. A dismissed card is hidden for 7 days and back on day 8 (fake clock); a stored `cooldown_days` is honoured.
TEST: services/gateway/test/routes/enrichment-cards.test.ts
TEST: services/gateway/test/services/enrichment/completion-resolver-repository.test.ts

AC-5: Any database error (read or write) or a missing Supabase client answers 500 JSON and is logged — never an empty card list.
TEST: services/gateway/test/routes/enrichment-cards.test.ts

AC-6: `eligibleEnrichmentCards(completions, dismissRows, screen, now)` is exported from `card-catalog.ts` and is the rule the route serves, so the Messenger companion (VTID-05099) and the route share one rule; unknown screens and cards with no known state show nothing.
TEST: services/gateway/test/routes/enrichment-cards.test.ts

AC-7: `data/enrichment-card-tips.ts` has title and description for all 15 cards (E1–E11, G1–G4) in all 11 gateway locales, written per locale (not English copies), German du-form; the type is an exhaustive `Record<GatewayLocale, string>`.
TEST: services/gateway/test/data/enrichment-card-tips.locale-coverage.test.ts

AC-8: The route file is claimed by an atlas domain and every role/atlas guard stays green; the gateway builds.
TEST: npm run test:roles (outputs/test-roles.log)
TEST: npm run build (outputs/gateway-build.log)

AC-9 (Phase 3, step 15): `resolveBoostTriggers(sb, userId, now)` computes the boost triggers from three caller-scoped, read-only reads run in parallel with the E-reads: **G1** fires when the weighted profile completion (the eight sections and weights of vitana-v1 `src/hooks/useProfileProgress.ts`: identity 20, avatar 15, about 20, location 10, links 10, cover 15, languages 5, services 5) is below 80 % and returns `completion_pct`; **G2** fires when the caller has ≥ 1 live (`expires_at > now`, `action IS NULL`) and unseen (`viewed_at IS NULL`) `daily_matches` row and returns `unread_match_count`; **G3** fires when there is no `diary_entries` row yesterday or today (UTC days, the `user_diary_streak` view's boundary) and the run of consecutive entry days ending the day before yesterday is longer than 3, and returns `streak_days`. Each trigger's true/false edge is tested; any read error throws EnrichmentDataError.
TEST: services/gateway/test/services/enrichment/boost-triggers.test.ts
TEST: services/gateway/test/services/enrichment/completion-resolver.test.ts
TEST: services/gateway/test/services/enrichment/completion-resolver-repository.test.ts

AC-10 (Phase 3, step 15): `GET /api/v1/enrichment-cards` appends the fired, non-cooled-down boost cards after the enrichment cards, in urgency order G3 → G2 → G1 (`category: 'boost'`, `priority` 1-based within the boost category), each with localized title/description and a `data` object (G1 `{ completion_pct }`, G2 `{ unread_match_count }`, G3 `{ streak_days }`). Screens: G1 → home, profile; G2 → home; G3 → home, longevity-journey, vitana-index; every other screen none. A dismissed boost card is hidden for 7 days through the same `user_enrichment_cards` table; a boost read error answers 500 JSON. No migration.
TEST: services/gateway/test/routes/enrichment-cards.test.ts
TEST: services/gateway/test/services/enrichment/boost-triggers.test.ts

## Decisions taken — Phase 3 boost triggers (step 15)

- **G4 "Earn VTNA" is out of scope** (owner decision). It is not in the catalog, not served and not dismissible (400); its card text stays.
- **G2 reads `daily_matches`, not `match_notifications`.** The plan named `match_notifications`; no such table exists (only a test fixture creates one; `new-day-overview-payload.ts` records the same finding). "Unread match" = a row the Matches page (`/me/matches`, vitana-v1 `useRealMatches`) lists — `expires_at > now`, `action IS NULL` — that the member has not seen yet (`viewed_at IS NULL`, set by `useMarkMatchesViewed` when the cards are on screen). Opening the Matches page therefore clears the card. Head count only, no rows read.
- **G3 = "missed yesterday", literally.** The card text says "You missed your diary yesterday. Log today to keep your streak going.", so G3 fires when there is no entry yesterday and none today, and the streak that ended the day before yesterday is > 3 days. A streak that ended 3+ days ago is already lost and does not fire. `streak_days` is that streak's length.
- **G3 day boundary = UTC**, the boundary of the `user_diary_streak` view and `diary-missing-relevant.ts`. G3 reads `diary_entries.created_at` directly (look-back 120 UTC days, at most 2,000 rows, newest first) instead of the view, because the view only returns streaks ending today or yesterday — exactly the ones G3 must not show.
- **G1 reads the stored row, not the UI state.** Identity needs both `display_name` and `handle` (the editor falls back to the user id for a missing handle; the server counts only a stored one). About uses the trimmed bio > 50, the same rule as E2 (the editor shows a localized placeholder bio for an empty one; a placeholder never counts). Cover counts `cover_url` or `universal_intent_cover_url` (same as E11). Services = at least one entry in `profiles.service_offerings.offers` — the only stored service-offerings list (the frontend's `offerings` array is never loaded from the database, so the client can never reach 100 %).
- **G1 has its own `profiles` read** (`fetchProfileProgressFields`) instead of widening the E-read, so the E-checks and their tests are unchanged; it runs in the same parallel batch.
- **Ordering:** enrichment first, then boost (plan §3.5 and the Home "injected after enrichment cards" note); the response is not capped — the per-screen maximum (2 enrichment + 2 boost on Home) is the frontend's composition rule.
- **Top-level `profile_completion_pct` is unchanged** (share of E1–E11); G1's weighted number travels on the card as `data.completion_pct`.
- **Messenger shows no boost card** (the companion engine picks among enrichment cards, VTID-05099); autopilot's only planned boost is G4 (out of scope), so it shows none.
- **The dismiss OASIS event keeps its type** `enrichment_card.dismissed` for G1–G3 too (one topic for the shared table).
- **No migration.** `user_enrichment_cards.card_type` has no CHECK, so G1–G3 dismissals need none.

## Decisions taken (inside the approved plan)

- **Calendar screen → E8 only.** Plan §4 has an explicit Calendar list ("Enrichment: E8"), matching §2A; that is the most conservative mapping.
- **Messenger screen → E1–E11**, per the owner (2026-10-13) and VTID-05099 (the companion engine picks one).
- **Screen slugs** `home`, `profile`, `longevity-journey`, `calendar`, `vitana-index`, `autopilot`, `community` (Community / Media Hub), `make-a-post`, `talk-to-vitana`, `messenger`. `vitana-index` and `talk-to-vitana` are valid screens with no enrichment cards (the plan lists none there); they answer an empty list.
- **No `completed_at` column and no `POST /complete`.** The sparred plan dropped them (F12): completion is derived from the source tables only. The owner's pre-sparring step plan still mentions them; the sparred plan wins.
- **Card texts cover G4 ("Earn VTNA Tokens")** as the owner's step plan asks (15 cards). G4 is text only: it is not in the catalog, not served and not dismissible; whether it renders is decided in Phase 3 (the sparred plan defers it — no "unclaimed reward" state exists).
- **Dismiss accepts E1–E11 only in Phase 1.** Boost cards are not served yet, so a G dismissal is refused (400) until Phase 3 adds them. The table has no CHECK on `card_type`, so Phase 3 needs no migration.
- **Boost triggers slot in later.** `resolveBoostTriggers()` exists and returns none; the repository has a reserved "Boost trigger sources (Phase 3)" section; `loadEnrichmentCardState` returns `{ completions, boosts, dismissals }`.
- **`profile_completion_pct` = share of E1–E11 complete (rounded %).** The weighted profile progress (useProfileProgress.ts weights) belongs to G1 in Phase 3 and is not duplicated now.
- **A card with no known completion state is not shown** (`completions.get(t) === false` is required), so a partial state never nags about something already done.
- **Empty strings count as not set** for avatar, cover and location (matches the frontend's `!!value`); E2 uses the trimmed bio (KIRO §2a.4).
- **`?locale=` override**, following `user-category-preferences.ts`: the live UI language wins over `getUserLocale`'s 5-minute cache.
- **Test paths follow the owner's step plan** (`test/services/enrichment/…`, `test/routes/enrichment-cards.test.ts`, `test/data/enrichment-card-tips.locale-coverage.test.ts`) instead of `test/vtid-05085-*.test.ts`, so the plan's Verify commands work. A repository test was added.
- **Translations were written in-session** (no LLM translation workflow run; no LLM calls), German du-form, Russian/Serbian phrased without gendered past tense.
- **Migration timestamp `20261013200000`**, newer than every existing migration (latest was `20261013190000`).
