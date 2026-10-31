# Tasks — welcome-finish

Plan: `.kiro/specs/welcome-finish/plan.md` (plan block authoritative).

<!-- lane: new-members-feed-api -->
## Lane `new-members-feed-api`
- [ ] A1 Claim the lane; branch `kiro/welcome-finish/new-members-feed-api` from `origin/main`.
- [ ] A2 Write `services/gateway/test/vtid-<id>-new-members-feed.test.ts` first and record it red on `origin/main`.
- [ ] A3 Add `routes/community-new-members.ts` (`GET /community/new-members`, `requireAuth`, `requireTenant`, limit 1..5),
      using `fetchExcludedTestServiceAccountIdsStrict`; mount it in `index.ts` next to `communityMembersRouter`; add its
      domain-atlas entry.
- [ ] A4 `docs/validation/<VTID>/`: scope.json, plan-sparring.md, acceptance.md, commands.log, outputs/, staging-tests.json.

**Acceptance:**
- Change types: Backend.
- Outcome — a member's new-member card never lists a test, service or bot account, nor a member who withdrew the opt-in.
- States — empty list, lookup failure (503, no card), unauthenticated (401).
- Surfaces — callers: the two v1 feed hooks (lane `new-members-feed-client`).
- Locales — n/a: data only, no text.
- Accessibility — n/a: no UI.
- Contract — request `GET /api/v1/community/new-members?limit=5` with bearer; 200 JSON `{ok, members[]}`; 401 JSON; 503 JSON `exclusion_lookup_failed`.
- Staging proof — unauthenticated probe returns 401 JSON on the deployed gateway; listing behaviour is covered by the jest suite (not verified on staging with real data: staging writes are forbidden).

<!-- lane: new-members-feed-client -->
## Lane `new-members-feed-client`
- [ ] B1 Claim the lane after `new-members-feed-api` is `done`; branch `kiro/welcome-finish/new-members-feed-client`.
- [ ] B2 Tests first (red on base): hooks call the gateway route, not `global_community_profiles`; non-200 → no card.
- [ ] B3 Add `useNewMembersFeed.ts` (fetch helper with the member token); use it in `useAllNewsFeed.ts` and `useNewsFeed.ts`.
- [ ] B4 Read-only Playwright staging spec; `docs/validation/<VTID>/`.

**Acceptance:**
- Change types: UI, Integration.
- Outcome — the "new members" card in the News feed and Community tab shows only real, opted-in members from the last 7 days.
- States — loading, empty, gateway error (card hidden, rest of feed unaffected), slow response.
- Surfaces — Home/News feed on phone and desktop (both hooks feed the same card component).
- Locales — n/a: no new strings.
- Accessibility — n/a: card markup unchanged.
- Contract — consumes the platform lane's route (see plan §3); bearer token, JSON.
- Staging proof — Playwright spec: the card request goes to the gateway route and no listed id is in the exclusion lists.

<!-- lane: native-extract-regen -->
## Lane `native-extract-regen`
- [ ] C1 Claim the lane; branch `kiro/welcome-finish/native-extract-regen` from `origin/main`.
- [ ] C2 Run `node scripts/native/gen-core-extract.mjs` then `node scripts/native/core-closure.mjs --write`; commit the two files.
- [ ] C3 Evidence: `gen-core-extract.mjs --check` exit 1 on base, exit 0 on the branch; `docs/validation/<VTID>/`.

**Acceptance:**
- Change types: Tooling/docs.
- Outcome — NATIVE-CI's generators job passes on main and on every later PR.
- States — n/a: generated header comments only.
- Surfaces — `packages/core/src/extracted/*.generated.ts`; no runtime file changes.
- Locales — n/a: developer-facing.
- Accessibility — n/a: no UI.
- Contract — diff is exactly the two `sha256` header lines.
- Staging proof — not verified on staging: no behaviour change; covered by the `--check` run.

<!-- lane: explicit-intro-choice -->
## Lane `explicit-intro-choice`
- [ ] D1 Claim the lane after `native-extract-regen` is `done`; branch `kiro/welcome-finish/explicit-intro-choice` from `origin/main`.
- [ ] D2 Tests first (red on base): registration has no pre-selected answer; “Yes, introduce me 👋” writes opt-in true + `community_intro_choice_at`; “Not now” writes false + marker; submitting without choosing writes nothing; the Settings switch writes both columns and withdrawal writes false + marker; `setCommunityIntroOptIn` payload.
- [ ] D3 Migration `supabase/migrations/<ts>_vtid_<id>_community_intro_explicit_choice.sql` (timestamp after the newest file in `supabase/migrations/`) and its `apply-vtid-<id>-community-intro-explicit-choice-migration.yml` (pattern: the VTID-05206 pair): add `community_intro_choice_at timestamptz NULL`, set `community_intro_opt_in` DEFAULT false, backfill rows without a recorded choice to false, in-migration self-check with before/after counts, one transaction, idempotent, no RLS/policy/trigger/REPLICA IDENTITY/publication change. Do NOT run it.
- [ ] D4 PGlite check (pattern `docs/validation/VTID-05206/pglite-community-intro-check.mjs`) over the current data shape plus synthetic explicit yes/no rows; output to `docs/validation/<VTID>/outputs/`.
- [ ] D5 `OnboardingNameForm.tsx`, `community-intro.ts`, `CommunityIntroToggle.tsx`, `integrations/supabase/types.ts`; strings `onboarding.nameForm.communityIntro*` (DE first, du-form, then en + 9 locales; `Ja, stell mich vor 👋` / `Jetzt nicht` style, final wording in the lane) with the i18n source-stamp update the repo requires.
- [ ] D6 Read-only staging spec; copy this plan's owner decision (§8.0) to `docs/validation/<VTID>/owner-decision.md`; `docs/validation/<VTID>/` evidence; PR body notes the owner stop and the pre-migration behaviour.

**Acceptance:**
- Change types: UI, Database, Integration.
- Outcome — nobody is publicly introduced (new-member card, Say Hello eligibility) until they actively choose “Yes, introduce me 👋”; members can choose later in Settings → Privacy; withdrawing removes the card and Say Hello eligibility.
- States — registration: nothing chosen (default), Yes, Not now, save failure (non-fatal, stays not introduced); Settings: loading hides the row, read error hides it, switch off/on, save failure toast.
- Surfaces — registration step (`OnboardingNameForm`), Settings → Privacy on desktop Spotlight, legacy Settings and phone `MobileSettings` (all three mount `CommunityIntroToggle`).
- Locales — DE first, du-form; en, es, sr, fr, pl, pt, ru, tr, zh, ar; RTL checked for ar (logical properties, the two choices stack on narrow screens); emoji kept in the Yes label in every locale.
- Accessibility — the two choices are a labelled radio group (`role="radiogroup"`, native keyboard behaviour, visible focus), neither checked initially; tap targets at least 44px.
- Contract — column `global_community_profiles.community_intro_choice_at timestamptz NULL`; `community_intro_opt_in boolean NOT NULL DEFAULT false`; member writes both on their own row; readers unchanged (`= true`).
- Data — migration: recorded choices preserved (marker set rows untouched), unmarked rows set to false, before/after counts printed and asserted, second run is a no-op.
- Staging proof — read-only Playwright: Privacy shows the switch off for the test account; the registration form and all writes are proven by vitest and PGlite only (staging writes to the production database are forbidden). **Not verified on staging until the owner approves applying the migration.**
