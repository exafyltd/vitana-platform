# Kiro instructions: Unified Card System (VTID-05085 / 05086 / 05087)

**Status:** the plan is sparred (CONVERGED, 2 rounds) and the owner approved it at Gate 1 on 2026-10-12.
**Plan of record:** `docs/validation/VTID-05085/plan-sparring.md`, hash `e7abbebb1e777f3aa27eea0356a5ca697328ee180c32a24e04150e2f5a238ab7`.
If anything below conflicts with that plan, the plan wins. If the plan conflicts with the code, stop and see "Stop and ask" at the end.

The VTIDs are already allocated and set to `in_progress` / `approved`. **Do not allocate new ones.**
Before you start each phase, run `scripts/dev/resume-vtid.sh <VTID>` and paste its output into the chat.

| VTID | Phase | Repos |
|---|---|---|
| VTID-05085 | 1: enrichment infrastructure, plus Home and Profile | platform PR, then vitana-v1 PR |
| VTID-05086 | 2: feature cards on all screens | platform PR (feature tips), then vitana-v1 PR |
| VTID-05087 | 3: boost cards G1–G3 | platform PR, then vitana-v1 PR |

Phases run in order. Start a phase only after the previous phase has passed STAGING-VERIFY.
Within a phase, the platform PR merges and is on staging before the vitana-v1 PR merges, because the frontend calls the new endpoint.

---

## 0. Standing rules that apply to every step

1. **Never test against production.** Not `vitanaland.com`, not `gateway.vitanaland.com`, and not the production Supabase project with a write.
   Staging tests are **read-only**: sign in, navigate, `GET`. You will be tempted to call the dismiss `POST` on staging. **Don't** — Jest proves the write path.
2. **Never write as the test user** (`a27552a3-…`) anywhere, including preview and staging. Those hosts write to the production database.
3. **i18n (vitana-v1):**
   - Every visible string goes in `src/i18n/<locale>/**`, German first in du-form, then English.
   - No raw JSX text and no raw `toast()`. Use `t()`, `<Trans>`, `notify()`.
   - Dates and numbers use the `@/lib/locale-format` helpers.
   - All 11 locales: de, en, es, sr, fr, pl, pt, ru, tr, zh, ar.
   - Arabic is RTL: use `ms-*`/`me-*`/`text-start`, never `left`/`right`.
   - Run `npm run i18n:inventory` and commit `docs/SCREEN_INVENTORY.md`.
4. **Gateway i18n:** every new gateway string has all 11 `GATEWAY_LOCALES`, genuinely translated rather than copied from English. The locale-coverage tests enforce this.
5. **Persona/LLM:** this feature calls no LLM and adds no spoken text. Keep it that way.
6. **Test/service accounts (rule 43–45):** the endpoint only ever returns the caller's own state. It never lists other members, so no allowlist exclusion is needed. Do not add any "other members" surface.
7. **No suite, no merge.** Every deploying PR carries `docs/validation/<VTID>/staging-tests.json` and `scope.json` in its own repo.
   Use the formats in `docs/validation/VTID-05078/` (platform) and `vitana-v1/docs/validation/VTID-05081/` (frontend).
8. **PR rules:**
   - The title starts with the VTID, e.g. `VTID-05085: Unified Card System — enrichment endpoint + migration`.
   - The body has a `VTID: VTID-05085` line and a Handoff section (Where it stopped / Open / Next).
   - Copy this phase's `plan-sparring.md` into the vitana-v1 PR too, as `docs/validation/<VTID>/plan-sparring.md`.
   - **Platform PRs must pass `validate-pr` (VALIDATOR-CHECK.yml).** Put these lines at the top of the PR body: `VTID: <VTID>`, `VALIDATION_PROFILE: gateway_backend`, `SCOPE_ALLOWLIST: <paths>`, `ACCEPTANCE: docs/validation/<VTID>/acceptance.md`, `MERGE_PAYLOAD_PREVIEW: <merge title>`, `OASIS_IMPACT: yes|no`.
     - `docs/validation/<VTID>/` needs `acceptance.md` (every `AC-n` followed within 12 lines by a `TEST:`/`CURL:`/`UI:` line), `commands.log` and `outputs/`.
     - A route change also needs `ROUTE_MOUNT:`, `FINAL_URL:` and `CURL_PROOF:` in `acceptance.md`; `OASIS_IMPACT: yes` needs `OASIS_PROOF:`.
     - The migration is outside the `gateway_backend` path allowlist (`node scripts/ci/validator-path-guard.cjs` reports it as "not judged", not rejected). Check locally with `node scripts/ci/validator-path-guard.cjs <changed-files.txt> gateway_backend <body.txt>`.
9. **Regression suites:** do not loosen any existing test to get green. If one fails, fix the change.

---

## 1. Corrections already verified against the code (use these, not the original draft)

| Topic | Use this |
|---|---|
| Instagram/Facebook connected | `social_connections.is_active = true AND disconnected_at IS NULL` (there is **no** `status` column) |
| OAuth start URL for E6/E7 | the social router is mounted at **`/api/v1/social-accounts`** (`services/gateway/src/index.ts:900`), so use `GET /api/v1/social-accounts/connect/:provider`. Reuse the flow in `ConnectAppPopup`. |
| Profile edit deep link | `/me/profile#avatar` / `#about` / `#interests` / `#location` / `#cover` (`/me/edit` does not exist) |
| Create post (E3, F10) | open the existing `CreateContentPopup` (desktop) / `MobileCreatePostSheet` (mobile), with media mode for F10. **There is no `/comm/create-post` route.** |
| Connected apps (E8, E9) | `/connectors` (and `/connectors#contacts`); `/settings/connected-apps` is only a redirect |
| Find a Match | Home keeps its `NewsFeedItemCard` match item unchanged. Create a new `FindAMatchCard` (on `VitanaRecommendationCard`) for the other screens only. |
| G3 streak | reuse `fetchUserDiaryStreak()` in `services/gateway/src/services/diary-streak-celebrator-repository.ts` (table `user_diary_streak`: `current_streak_days`, `last_day`). No new streak logic. |
| G4 Earn VTNA | **out of scope.** Do not build it, do not add `earn-vtna`. |
| `POST /complete` and `completed_at` | **dropped.** Completion is derived from source tables only. |
| Auth middleware | `requireAuth` from `services/gateway/src/middleware/auth-supabase-jwt.ts`; read the user id from `AuthenticatedRequest` |
| Route mounting | `mountRouterSync(app, '/api/v1/enrichment-cards', router, { owner: 'enrichment-cards' })` in `src/index.ts`, next to the social-accounts mount. Add the route file to a domain in `orb/developer/domain-atlas.ts` (the atlas drift guard in `npm run test:roles` fails otherwise). |
| Frontend gateway calls | follow `src/hooks/useDidYouKnowTip.ts`: `GATEWAY_API_URL` from `@/lib/gateway-base`, plus the bearer token from `supabase.auth.getSession()` |
| Screen files | Home `src/pages/Home.tsx`; Profile = the `/me/profile` page (`src/App.tsx:1480`); Vitana Index `src/pages/health/VitanaIndexDetail.tsx`; Autopilot `src/pages/AutopilotDashboard.tsx`; Community `src/pages/community/MediaHub.tsx`; Talk to Vitana `src/pages/community/TalkToVitana.tsx`; Calendar = the `/calendar` page (`src/App.tsx:1183`); Longevity Journey = resolve from `App.tsx`, and if it is a section of `AutopilotDashboard.tsx`, mount the strip there **once** |

---

## 2. Phase 1: VTID-05085

### 2a. Platform PR (`exafyltd/vitana-platform`)

1. **Migration** `supabase/migrations/20261012120000_vtid_05085_unified_card_system.sql`:
   - Create `user_enrichment_cards` exactly as in plan §3.2, **without** `completed_at`.
   - Add `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS interests TEXT[] DEFAULT '{}';`.
   - Make the index `CREATE INDEX IF NOT EXISTS`.
   - Use `DROP POLICY IF EXISTS … ; CREATE POLICY …` so a re-run is safe.
   - Add a table `COMMENT` naming VTID-05085.
2. **`DATABASE_SCHEMA.md`:** document the table and the new `profiles.interests` column (slugs, never display text).
3. **`services/gateway/src/services/enrichment/completion-resolver-repository.ts`:** isolated Supabase reads, one function per source. Follow the pattern in `dismissal-tool-repository.ts`.
   It reads:
   - `profiles` (`avatar_url`, `bio`, `location`, `cover_url`, `interests`)
   - whether `profile_posts` has any row
   - `social_connections` for instagram/facebook (correction above)
   - `connected_app_settings` (`app_id IN ('google-calendar','outlook-calendar','apple-calendar') AND enabled = true`)
   - whether `contacts` has any row
   - `user_device_tokens` (`revoked_at IS NULL AND fcm_token IS NOT NULL`)
   - `user_enrichment_cards` for this user

   Run independent reads in parallel with `Promise.all`; that satisfies the "one round-trip" intent without a raw SQL join.
4. **`services/gateway/src/services/enrichment/completion-resolver.ts`:** `resolveCompletions(sb, userId)` returns `Map<CardType, boolean>` for E1–E11. E2 counts as done only when the trimmed bio is longer than 50 characters.
5. **`services/gateway/src/services/enrichment/card-catalog.ts`:** the single source of the screen → card map (plan §4) and the static priority (plan §3.5: E1→E2→E3→E6→E7→E8→E9→E4→E5→E10→E11).
6. **`services/gateway/src/routes/enrichment-cards.ts`** (`requireAuth` on both routes):
   - **`GET /?screen=<screen>`:**
     - Returns 400 JSON on an unknown screen.
     - Returns the incomplete, non-cooled-down enrichment cards for that screen in priority order, each with `{ card_type, category, priority, title, description }`. The localised strings come from `enrichment-card-tips.ts` in the caller's locale (`getUserLocale`).
     - Also returns `profile_completion_pct`.
   - **`POST /dismiss`** with body `{ card_type }`:
     - Validates `card_type` against the catalog (400 otherwise).
     - Upserts `dismissed_at = now()`, `updated_at = now()` for the caller only.
     - Returns `{ ok: true, dismissed_until }`.
   - A card counts as cooled down while `dismissed_at + cooldown_days > now()`.
   - Any DB error returns 500 JSON and is logged. Never return an empty list silently.
7. **Mount** the route in `src/index.ts` and add it to the atlas domain (correction table).
8. **`services/gateway/src/data/enrichment-card-tips.ts`:**
   - Title and description for E1–E11 now, and G1–G3 (added in Phase 3 but defined now), all 11 locales.
   - Translate with the existing LLM translation workflow, then review the German for du-form.
9. **Tests (Jest):**
   - `test/vtid-05085-completion-resolver.test.ts`: each E-check true/false, using a mocked repository.
   - `test/vtid-05085-enrichment-cards-route.test.ts`:
     - 401 without a token, and 400 on a bad screen or bad `card_type`.
     - Screen filtering, priority order, completed cards excluded, and a dismissed card hidden for 7 days and back on day 8 (fake timers).
     - Dismiss only ever writes the caller's own row.
   - `test/data/enrichment-card-tips.locale-coverage.test.ts`: the same pattern as `feature-tips.locale-coverage.test.ts`.
   - Also run `npm run test:roles`, plus the full `npx jest` and `npm run build` in `services/gateway`.
10. **`docs/validation/VTID-05085/`** (this folder): append your ACs to the existing `acceptance.md`, and add to `commands.log` and `outputs/`. Add `scope.json` and `staging-tests.json`. The staging tests are:
    - `GET /alive` returns 200.
    - `GET /api/v1/enrichment-cards?screen=home` without a token returns 401 `application/json`.
    - An `existing` entry for the two Jest files.

    In `acceptance.md`, use `VALIDATION_PROFILE: gateway_backend` and fill `ROUTE_MOUNT`, `MIGRATION` and `CURL_PROOF` like `docs/validation/VTID-05067/acceptance.md`.
11. **After merge:** apply the migration through `RUN-MIGRATION.yml`, then confirm the table exists with a read-only query. Watch the staging deploy and STAGING-VERIFY.

### 2b. vitana-v1 PR (only after 2a is on staging)

1. **`src/components/vitana/VitanaRecommendationHeader.tsx`:**
   - Extend `VitanaFeature` to the 16 values in plan §5.1, with no `earn-vtna`.
   - Add the `FEATURE_CONFIG` entries with Lucide icons and i18n label keys.
2. **`src/components/vitana/VitanaCardActionButton.tsx`:**
   - Three shapes: round, pill, rounded-square.
   - Use `aria-label` from `t()` (it is required, because the round button has no visible label).
   - Every tap target is at least 36px.
3. **`src/hooks/useEnrichmentCards.ts`:**
   - React Query with a 5-minute stale time.
   - Optimistic dismiss with rollback, using `notifyError` on failure.
4. **`src/hooks/useCardDismiss.ts`:**
   - Feature cards use the `localStorage` key `vitana.card.<type>.dismissed_at` with a 7-day TTL. Wrap every access in try/catch, following `EnableRemindersPrompt.tsx`.
   - Enrichment cards call `POST /dismiss` and invalidate the query.
5. **`src/components/vitana/EnrichmentCardStrip.tsx`:**
   - Props: `screen`, `maxCards` (default 3), `layout` (`carousel` via `embla-carousel-react`, or `stacked`).
   - Merges the server cards with the static feature list for the screen.
   - Renders nothing (no empty box) when there are no cards or the request errors.
6. **The 11 enrichment cards** in `src/components/enrichment/` (E1–E11), each on `VitanaRecommendationCard`, using the corrected deep links and actions from §1.
   - E10 reuses `pushNotificationManager` and the Appilix detection from `EnableRemindersPrompt.tsx`.
7. **`src/components/profile/InterestsPicker.tsx`:**
   - About 15 fixed slugs, multi-select up to 10.
   - Labels come from `screens.interests.<slug>` in all 11 locales.
   - Saves the slugs through the existing profile update path. This is a real-user write in the app and is **not** exercised on staging.
8. **Mount:**
   - **`Home.tsx`:** at most **3** new cards (the top 2 enrichment cards and, in Phase 3, the top 1 boost card) are prepended to `vitanaCards`. Enforce the cap in `Home.tsx` before `composeFeed`. The existing card order stays unchanged, and no new feature cards go on Home.
   - **Profile:** `<EnrichmentCardStrip screen="profile" layout="carousel" maxCards={11} />` at the top.
9. **What's New:** add `src/whats-new/entries/profile-enrichment-cards.json` (EN plus DE du-form, deep link `/me/profile`).
10. **Tests (Vitest):**
    - Each enrichment card: renders, the button fires its action, and dismiss works.
    - `VitanaCardActionButton.test.tsx`: shapes, click, and `aria-label`.
    - `EnrichmentCardStrip.test.tsx`: per screen, both layouts, `maxCards`, loading, empty and error states.
    - `useEnrichmentCards.test.ts` and `useCardDismiss.test.ts`.
    - `InterestsPicker.test.tsx`.
    - `src/lib/feed-compose.test.ts`: a new case proving the Home cap of 3 and that the existing order is preserved.
    - `src/components/vitana/card-deeplinks.test.ts`: every card deep link resolves to a real route in `App.tsx` and `screens.json`, and none is a `<Navigate>` redirect.
    - Also run `test:news-card-features`, `test:news-feed-ranker`, `npm run lint`, `npm run build`, `npx vitest run` and `npm run i18n:inventory`.
11. **Visual check (CLAUDE.md IF-THEN 26):**
    - Take Playwright screenshots of Home and Profile on **staging**, at desktop 1400×900 and mobile 390×844, in German and Arabic (RTL).
    - Open the carousel and inspect each image.
    - Save them under `docs/validation/VTID-05085/outputs/` and link them in the PR.
12. **`vitana-v1/docs/validation/VTID-05085/staging-tests.json`:**
    - A Playwright spec `tests/e2e/staging/vtid-05085-enrichment-cards.staging.spec.ts` that signs in as the test user using the existing fixtures and network guard.
    - It opens Home and asserts the enrichment request returns 200 JSON and that zero to three new cards render. It also opens `/me/profile` and asserts the strip renders, or is absent when everything is complete.
    - **No clicks on dismiss, the action buttons or the interests save.**

---

## 3. Phase 2: VTID-05086

**Platform PR:**
- Add `calendar-connect` (deep link `/calendar`) and `upload-media` to `services/gateway/src/data/feature-tips.ts`, all 11 locales.
- `feature-tips.locale-coverage.test.ts` must stay green.
- `staging-tests.json`: `/alive`, plus an `existing` entry for the locale test.

**vitana-v1 PR:**
1. Create the new feature cards in `src/components/feature/`: `DailyDiaryCard`, `TalkToVitanaCard`, `AutopilotCard`, `CalendarCard`, `UploadMediaCard` (opens the create sheet in media mode) and `DiscoverCard`, plus `FindAMatchCard` (for non-Home screens only).
2. Restyle `VitanaIndexCard`, `LongevityJourneyCard`, `InviteFriendCard`, `FeatureAnnouncementCard` and `DidYouKnowCard` to use `VitanaCardActionButton` with the accent border. **Keep their behaviour unchanged.**
3. Mount `EnrichmentCardStrip` on the 7 remaining screens (§1 file list), with the per-screen card lists and layouts from plan §4.
4. **Home gets no new feature cards.**
5. Run the tests, including the deep-link test and both news regression scripts.
6. Visual check: screenshot each of the 7 screens at both viewports, including RTL.
7. `staging-tests.json`: a read-only Playwright spec that visits the 7 screens and asserts the strip renders with no console errors.

## 4. Phase 3: VTID-05087

**Platform PR:**
- Extend the resolver with the boost triggers:
  - **G1:** profile completion below 80%, using the same weights and fields as `src/hooks/useProfileProgress.ts`. Put the weights in a shared constant, and add a test that pins them to the frontend values.
  - **G2:** unread `match_notifications` greater than 0.
  - **G3:** `fetchUserDiaryStreak()` with `current_streak_days > 3` and `last_day` before yesterday (in the user's timezone).
- The GET endpoint returns boost cards in the order G3 → G2 → G1.
- Jest: a true and a false case for each trigger.

**vitana-v1 PR:**
- Add `CompleteProfileCard`, `UnreadMatchesCard` and `StreakAtRiskCard`.
- Wire them into the strip and into Home's single boost slot.
- Run the tests, take the screenshots, and add a read-only staging spec.

---

## 5. Done, per PR

- Local checks are green: gateway `npm run build` and `npx jest`; v1 `npm run lint`, `npm run build`, `npx vitest run` and `npm run i18n:inventory`.
- The PR is open with the VTID title and body. Mark it ready when CI is green, then merge.
- Staging deploy, then STAGING-VERIFY passes on the merge commit.
- **Gate 2:** report to the owner in the Command Hub Operator Chat or a Claude Code session, never in DevOps Chat.
  Include the STAGING-VERIFY link, test counts, the verified commit, every commit between production and it, the migrations in the release, and a "Decisions taken" list (any conservative choice you made inside the plan).
  Then ask *"Staging verified — ready for deployment to production?"* **Do not publish to production without that yes.**
- After Phase 3 publishes, set the three ledger rows to terminal (`is_terminal = true`, `completed`, `success`).

## 6. Stop and ask (only these)

- Something in the plan cannot be done as written and one more sparring round does not converge. For example, the Longevity Journey page doesn't exist, or a source table is missing in the live database.
- Any production write not covered by the two gates.
- A security or data-loss risk, such as a policy that would expose another user's row.
- The same failure survives 3 fix-forward attempts.

Each stop is one message with the evidence and a recommended answer.
