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
