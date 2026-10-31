---
change_class: standard
---
# Plan — welcome-finish

Author: Kiro, session `kiro-jtadic-202610291040-a0e6`, seat `jtadic`. Repos: `exafyltd/vitana-platform` (1 lane) and
`exafyltd/vitana-v1` (3 lanes). Premises pinned to platform `origin/main` `cf009eca8f`, vitana-v1 `847a9f686`.
Parent plan: `new-member-welcome` (four lanes, VTID-05205..05208). This plan adds only what that plan's lanes cannot
carry because the files are outside their `paths`.

<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-30: *"Exclude test accounts, service accounts and bots from the new-member feed itself, greeting
suggestions and greeting sends. … Treat this as part of completing the feature, rather than an optional post-release
follow-up."* and *"Fix the underlying causes [of the frontend checks] through the appropriate scoped changes and review
process."*

Owner, 2026-10-30 (final, supersedes D1 = default ON of 2026-10-15): *"change community introductions to explicit
choice … 'Yes, introduce me 👋' / 'Not now', with nobody publicly introduced until they actively choose Yes. I also
authorize the necessary backfill: preserve recorded explicit opt-ins and opt-outs; remove automatic inclusion where no
affirmative choice is recorded. … Keep the three private team welcome messages automatic and separate from this
setting."*

## 2. Today
0. `community_intro_opt_in` is `boolean NOT NULL DEFAULT true`
   (`vitana-v1/supabase/migrations/20261016110000_vtid_05206_community_intro_opt_in.sql:36-37`, applied). Read-only
   check 2026-10-30: 251 rows false (all created before the rollout), 2 rows true, created 14:23Z and 15:12Z with
   `updated_at = created_at`, so never touched after creation: no recorded choice, they are included only by the default.
   The column alone cannot tell a chosen "yes" from the default, so a choice marker is needed.
   Registration (`OnboardingNameForm.tsx:44`) pre-selects the switch on and writes only an explicit "no" (`:167-172`);
   Settings (`CommunityIntroToggle.tsx`, mounted at `Privacy.tsx:76,293` and `MobileSettings.tsx:303`) writes
   `community_intro_opt_in` through `community-intro.ts:27`.
   The two readers already require `= true` and need no change: the feed filter (`useAllNewsFeed.ts`, `useNewsFeed.ts`,
   and the endpoint of this plan) and the greeting guard (`new-member-greeting-guard.ts:92` reads the row per call
   via `:184`, so a withdrawal removes Say Hello eligibility on the next call).
1. Greeting suggestion and greeting send already exclude test/service accounts, fail closed:
   `services/gateway/src/routes/new-member-greeting.ts:108-110` and `services/gateway/src/services/new-member-greeting-guard.ts:240-242`
   (`fetchExcludedTestServiceAccountIdsStrict`, `lib/excluded-test-service-accounts.ts:49`). Not changed here.
2. The new-member **feed listing does not** exclude them: `vitana-v1/src/hooks/useAllNewsFeed.ts:198-207` and
   `src/hooks/useNewsFeed.ts:196-205` read `global_community_profiles` straight from the browser with
   `is_visible=true`, `community_intro_opt_in=true`, last 7 days. NEVER 45 requires that a surface that lists members to
   a real member excludes `service_bot_accounts` and `notification_test_actors`. The browser cannot read those tables
   (they are service-side allowlists); the existing client-side pattern for this is a SECURITY DEFINER database function
   (`search_mention_candidates`, vitana-v1 migration `20261006140000`), which would need a migration applied to the
   shared database (owner stop, `collaboration.md` §7d).
3. Frontend check `NATIVE-CI` job "Parity ledger, core/tokens generators + native script tests" fails on the Say Hello PR
   (vitana-v1 #1520, run 41066162293) at `node scripts/native/gen-core-extract.mjs --check`: "out of date:
   packages/core/src/extracted/news-feed-ranker.generated.ts, …/feed-compose.generated.ts". **Confirmed pre-existing on
   `main` `847a9f686`**: the same command on a clean checkout of main prints the same message (`--check` exit 1). The
   scheduled NATIVE-CI run on main (41047702166) was green only because that job is skipped on schedule runs. The
   regenerated diff is two header lines (the `sha256` of the source file in the generated header comment).

## 3. Interfaces between lanes
`GET /api/v1/community/new-members?limit=<1..5>` (platform, `requireAuth` + `requireTenant`):
- 200 `{ ok: true, members: [{ user_id, display_name, avatar_url, bio, created_at }] }`, newest first; rows exactly as the
  browser query returns today (`is_visible=true`, `community_intro_opt_in=true`, `created_at >= now-7d`, member's tenant),
  minus every id in `fetchExcludedTestServiceAccountIdsStrict`, minus the caller.
- 503 `{ ok: false, error: 'exclusion_lookup_failed' }` when the exclusion lookup fails (fail closed: a read surface that
  lists people to members must not show a possibly-test account); 401/403 by the existing middleware; JSON content type.
- The v1 hooks call it with the member's bearer token (`VITE_GATEWAY_URL`); on any non-200 or network error they show
  **no** new-member card (never fall back to the direct table query).

## 4. Lanes
- `new-members-feed-api` (vitana-platform, executor kiro): the route, its mount in `index.ts`, the domain-atlas entry,
  tests `services/gateway/test/vtid-<id>-new-members-feed.test.ts` (red on base: route absent): test/service/bot ids
  excluded, caller excluded, non-opted-in excluded, withdrawn member excluded on the next call, lookup failure → 503,
  8-day-old member excluded.
- `new-members-feed-client` (vitana-v1, executor kiro, `depends_on: [new-members-feed-api]`): `useAllNewsFeed.ts` and
  `useNewsFeed.ts` fetch the listing from the endpoint instead of the table; tests red on base (hook still queries
  `global_community_profiles`); failure shows no card; opted-out member never listed.
- `native-extract-regen` (vitana-v1, executor kiro, no dependency): run `node scripts/native/gen-core-extract.mjs` and
  `node scripts/native/core-closure.mjs --write`; commit the two regenerated files. Test: `gen-core-extract.mjs --check`
  exits 0 (red on base, exit 1). Must merge before vitana-v1 #1520 so that PR's required NATIVE-CI check is green on a
  green base.
- `explicit-intro-choice` (vitana-v1, executor kiro, `depends_on: [native-extract-regen]` so its required NATIVE-CI check
  runs on a green base): migration `supabase/migrations/<ts>_vtid_<id>_community_intro_explicit_choice.sql` (+ its
  `apply-vtid-<id>-…-migration.yml`): add `community_intro_choice_at timestamptz NULL`; `community_intro_opt_in`
  DEFAULT false; backfill `UPDATE … SET community_intro_opt_in = false WHERE community_intro_choice_at IS NULL AND
  community_intro_opt_in` (rows with a recorded choice, `choice_at` set, are untouched: explicit yes and explicit no are
  preserved; the 251 pre-rollout rows are already false and unchanged); a self-check inside the migration counts rows
  before/after and raises if a row with a recorded choice changed or any row without one is still true; idempotent,
  one transaction, no change to RLS, policies, grants, triggers, REPLICA IDENTITY or publication (the owner policy
  "Users can manage their own global profile" already lets the member write both columns). App: `community-intro.ts`
  `setCommunityIntroOptIn` writes `{ community_intro_opt_in, community_intro_choice_at: now }`; `OnboardingNameForm`
  replaces the pre-selected switch with two buttons “Yes, introduce me 👋” / “Not now”, **neither selected**; choosing
  one records it, submitting without choosing records nothing (opt-in stays false) and never blocks registration;
  `CommunityIntroToggle` keeps the switch (default off) and records the choice on every change (so withdrawal =
  `false` + `choice_at`). Strings: `onboarding.nameForm.*` in 11 locales (DE first, du-form); the Settings texts in
  `screens.json` stay unchanged (still accurate), so this lane does not touch `screens.json`, which the Say Hello lane
  edits. Feed filter, greeting guard and the endpoint stay `= true` (verified in §2.0).
Hot files: `services/gateway/src/index.ts` and `domain-atlas.ts` are touched by one lane only in this plan; the open Say
Hello PR (#4503) also lists them: whichever merges second merges `main` first (§8a).

## 5. Tests and commands
Platform: `cd services/gateway && npx jest test/vtid-<id>-new-members-feed.test.ts` plus the atlas drift test
(`npm run test:roles`) and `npx tsc --noEmit`. vitana-v1: `npx vitest run src/hooks/…new-members…`, `npm run lint`,
`npm run build`, `node scripts/native/gen-core-extract.mjs --check`. Each lane writes `docs/validation/<VTID>/`
(acceptance, commands.log, outputs, staging-tests.json). Staging proof (read-only): the platform lane's staging test is
an unauthenticated probe expecting 401 JSON on the new route (proves the revision is deployed); the client lane's
Playwright spec signs in and asserts the card list renders no account from the exclusion lists that exist on staging
and that the request goes to the gateway route; real listings of test data are unit-tested. `explicit-intro-choice` staging proof (read-only, signs in as the test
account, never flips a switch): the Privacy screen shows the switch OFF and the registration copy is not reachable on
staging without registering, so the form, the writes and the backfill are proven only by vitest and PGlite. **The new
writes need the migration applied** (staging shares the production database): until the owner approves applying it, the
column does not exist, a save fails with the existing "could not be saved" toast (fail safe, nobody is introduced) and
new signups still take the old default true. Applying the migration is an owner stop (§7d); the file merges with the lane.

## 6. Risks
- Fail-closed makes the card disappear when the allowlist tables error; accepted (rare) and logged.
- The client lane must not merge before the platform lane is deployed to staging; `depends_on` plus §7b enforce order,
  and the client fails safe (no card) if the gateway lags.
- No migration. A migration (SECURITY DEFINER function) was considered and rejected: it needs an owner-approved apply
  against the shared database before any staging proof.

- A stale (cached) old bundle writes `community_intro_opt_in` without the marker: for `true` the member is included
  without a recorded marker. Accepted (rare, short window after deploy, member's own act); the marker is an audit field,
  not a read filter, so no member is hidden because of it.
- The 2 default-true rows lose automatic inclusion; they can choose Yes later (authorized by the owner).

## 7. Unchanged
The greeting suggestion/send routes and guard, the feed filter (`= true`), the three private team welcome DMs (automatic,
separate from this setting), the Settings → Privacy texts, production, every rule file, the `new-member-welcome` lanes and
their paths (they still describe D1; this plan's owner decision below supersedes it, and `new-member-welcome` is updated
only by a later lane that may edit it).

## 8. Decisions taken
0. **Owner decision (final, supersedes D1), 2026-10-30:** community introductions are an explicit choice; nobody is
   introduced (no new-member card, no Say Hello eligibility) until they choose “Yes, introduce me 👋”; backfill authorized
   in principle (preserve recorded opt-ins/opt-outs, clear automatic inclusion), file and target database still need the
   owner's approval before applying (§7d). The Mariia mapping question is closed (Mariia Maksina = @mariia04 =
   `67c971fc-48f3-49ce-aaa8-cddb6fa9e63a`; vitana_id `mariia11` is the same account). Recorded in this plan and copied by the
   lane to `docs/validation/<VTID>/owner-decision.md`.
   Conservative choices inside it: no pre-selected answer; skipping the question never blocks registration and leaves
   opt-in false; the choice marker is a new nullable column rather than inferring from timestamps.
1. Endpoint over migration (no owner stop, uses the existing strict helper).
2. Fail closed on lookup failure, unlike the older fail-open directory helper, because this list shows individuals to
   real members and NEVER 43/45 is absolute.
3. The native regeneration is its own lane so it can land before the Say Hello PR without touching that lane's paths.
<!-- plan:end -->
