# Tasks — native-parity-test-gaps

One PR in `exafyltd/vitana-v1`: branch `kiro/native-parity-test-gaps/route-tests`, title
`VTID-xxxxx (native-parity-test-gaps/route-tests): …`, trailers `Collab-Session` and `Collab-Lane`. The lane changes only its
`paths`. The VTID is assigned by CI after PLAN-SPAR converges; do not start before the lane file has `vtid:`. No existing test,
helper, source file or ledger row is edited. No production host, no live system, fakes only.

## Route tests
<!-- lane: route-tests -->
- [ ] T0 Add `apps/mobile/tests/parity-gaps/mocks.ts` (imported before the code under test): `jest.mock('expo-router', …)` with a `Redirect`
  spy that records its `href`, a `useLocalSearchParams` returning a mutable exported params object, and `router`, `usePathname`,
  `useGlobalSearchParams` stubs; copies of the async-storage, expo-secure-store and safe-area stubs of `tests/community/mocks.ts`.
  Do not import `tests/community/mocks.ts`.
- [ ] T1 Add `apps/mobile/tests/parity-gaps/intents-mine-route.test.tsx`: import `tests/helpers/no-network`; use the T0 mock so `Redirect` records its `href` prop; render the default export of `app/(app)/intents/mine.tsx`; assert the recorded href is
  `/comm/find-partner?view=posts`. Also read `apps/mobile/parity/ledger.json` (read-only) and assert row `INTENTS.MINE` has
  `web_path: /intents/mine`, `status: native`, `lane: home-feed`, and that `NATIVE_ROUTES` contains `/intents/mine`.
- [ ] T2 Add `apps/mobile/tests/parity-gaps/my-groups-route.test.tsx`: use the T0 mock and the Supabase double and wrapper of
  `tests/community/helpers.tsx` by import (not by edit); set the T0 params to `{ id: 'g-1' }`; render the default export of
  `app/(app)/comm/my-groups/[id].tsx`; assert `screen-group-detail` and the group name for a seeded group, and
  `group-detail-not-found` for an id that is not seeded. Assert the ledger row `/comm/my-groups/:id` is `native`,
  `source: exclusion`, `lane: home-feed`. Do not assert `resolveWebPath` for this path (plan Finding 4).
- [ ] T3 Prove each test can fail (mutations are made only in a throwaway second worktree, never the lane worktree) and record red and green runs, the commands and the
  empty source diff in `docs/validation/<VTID>/commands.log`; write `docs/validation/<VTID>/acceptance.md`, `scope.json`
  and a short `docs/validation/<VTID>/findings.md` that lists plan Findings 1-5 and the out-of-scope list.
- [ ] T4 Run `cd apps/mobile && npm ci && npx jest tests/parity-gaps --maxWorkers=2 && npm run typecheck && npx jest --maxWorkers=2`
  and, from the vitana-v1 repository root, `node scripts/native/parity-ledger.mjs --check`; record the results.

Acceptance:
- Change types: Tooling/docs (tests and evidence only)
- Outcome: CI fails if `/intents/mine` stops redirecting to Find a Partner "My Posts", or if `/comm/my-groups/:id` stops showing
  the group detail; a maintainer reading `docs/validation/<VTID>/findings.md` sees the audit result. Members see no change.
- States: group loaded, group not found (missing id); redirect target exact including the query string.
- Surfaces: native route files only; no screen, web or backend change.
- Locales: n/a: no user-visible text added; assertions use test ids, not copy.
- Accessibility: n/a: no UI change.
- Contract: `app/(app)/intents/mine.tsx:7-11` and `app/(app)/comm/my-groups/[id].tsx:6-12` at the pinned SHA; ledger rows
  `INTENTS.MINE` and `/comm/my-groups/:id` read-only. No gateway or Supabase call except the in-memory double.
- Staging proof: not verified on staging: tests only, nothing deploys; the two Jest files are the proof.
- Scope: `git diff --stat origin/main` lists only `apps/mobile/tests/parity-gaps/**` and `docs/validation/**`; `ledger.json`,
  `resolve.ts` and all existing tests are untouched; `parity-ledger.mjs --check` is unchanged (OK, 435 rows).
