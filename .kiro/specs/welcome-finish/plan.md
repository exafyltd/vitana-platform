---
change_class: standard
---
# Plan — welcome-finish

Author: Kiro, session `kiro-jtadic-202610291040-a0e6`, seat `jtadic`. Repos: `exafyltd/vitana-platform` (1 lane) and
`exafyltd/vitana-v1` (2 lanes). Premises pinned to platform `origin/main` `a206af8ab9`, vitana-v1 `847a9f686`.
Parent plan: `new-member-welcome` (four lanes, VTID-05205..05208). This plan adds only what that plan's lanes cannot
carry because the files are outside their `paths`.

<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-30: *"Exclude test accounts, service accounts and bots from the new-member feed itself, greeting
suggestions and greeting sends. … Treat this as part of completing the feature, rather than an optional post-release
follow-up."* and *"Fix the underlying causes [of the frontend checks] through the appropriate scoped changes and review
process."*

## 2. Today
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
Hot files: `services/gateway/src/index.ts` and `domain-atlas.ts` are touched by one lane only in this plan; the open Say
Hello PR (#4503) also lists them: whichever merges second merges `main` first (§8a).

## 5. Tests and commands
Platform: `cd services/gateway && npx jest test/vtid-<id>-new-members-feed.test.ts` plus the atlas drift test
(`npm run test:roles`) and `npx tsc --noEmit`. vitana-v1: `npx vitest run src/hooks/…new-members…`, `npm run lint`,
`npm run build`, `node scripts/native/gen-core-extract.mjs --check`. Each lane writes `docs/validation/<VTID>/`
(acceptance, commands.log, outputs, staging-tests.json). Staging proof (read-only): the platform lane's staging test is
an unauthenticated probe expecting 401 JSON on the new route (proves the revision is deployed); the client lane's
Playwright spec signs in and asserts the card list renders no account from the exclusion lists that exist on staging
and that the request goes to the gateway route; real listings of test data are unit-tested.

## 6. Risks
- Fail-closed makes the card disappear when the allowlist tables error; accepted (rare) and logged.
- The client lane must not merge before the platform lane is deployed to staging; `depends_on` plus §7b enforce order,
  and the client fails safe (no card) if the gateway lags.
- No migration. A migration (SECURITY DEFINER function) was considered and rejected: it needs an owner-approved apply
  against the shared database before any staging proof.

## 7. Unchanged
The greeting suggestion/send routes, the opt-in default (owner decision D1, default ON, unchanged pending the owner's
answer), the registration UI, production, every rule file, the `new-member-welcome` lanes and their paths.

## 8. Decisions taken
1. Endpoint over migration (no owner stop, uses the existing strict helper).
2. Fail closed on lookup failure, unlike the older fail-open directory helper, because this list shows individuals to
   real members and NEVER 43/45 is absolute.
3. The native regeneration is its own lane so it can land before the Say Hello PR without touching that lane's paths.
<!-- plan:end -->
