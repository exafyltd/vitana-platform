# Plan — native-parity-test-gaps
Author: Kiro, seat `exafyltd`. Repo of the change: `exafyltd/vitana-v1` (native app `apps/mobile/`); this spec lives in
`exafyltd/vitana-platform`. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021). Spec: `handoff.md`,
`tasks.md`, `lanes/route-tests.md` in this folder.

<!-- plan:begin -->
## Goal
Owner instruction, verbatim: "Parity audit: check the parity ledger on main against the screen list. Find mismatches, stale rows, and missing tests. Report them. Do not change ledger status without evidence."

The audit was run read-only (evidence: `PARITY-AUDIT.md`, owner-side file, summarised below). It found no ledger/screen-list mismatch and no stale row, and
two `native` rows whose route file no test touches. This plan closes exactly those two test gaps with new test files and reports the findings. It changes no
ledger status, no source and no existing test.

## Measured state
Pinned: vitana-v1 origin/main e31bf4627ff3c705c20f8e6b718ce4dd03353b7f, vitana-platform origin/main 6dc6e1ba0c18252ec2f3fbf5651d245e200f9835 (2026-11-10T17:55Z).
- `node scripts/native/parity-ledger.mjs --check` passes at that SHA: 435 rows, 121 native routes (audit §1). 0 screen-list entries without a row, 0 stale rows, 0 native rows without a route file (audit §2, §3).
- `vitana-v1:apps/mobile/app/(app)/intents/mine.tsx:7-11` is a redirect-only route: `<Redirect href={'/comm/find-partner?view=posts' as never} />`. Its ledger row is `INTENTS.MINE`, `status: native`, `last_parity_check: 2026-10-21` (`vitana-v1:apps/mobile/parity/ledger.json:1601-1610`). `/intents/mine` is in `NATIVE_ROUTES` (`vitana-v1:apps/mobile/src/navigation/resolve.ts:90`). No file under `apps/mobile/tests` mentions `intents/mine` (audit §4).
- `vitana-v1:apps/mobile/app/(app)/comm/my-groups/[id].tsx:6-12` reads `id` from `useLocalSearchParams` and renders `<GroupDetailScreen id={id} />` (screen at `apps/mobile/src/screens/community/GroupDetailScreen`). Its ledger row is `/comm/my-groups/:id`, `source: exclusion`, `status: native` (`ledger.json:2464-2475`). `GroupDetailScreen` is tested directly (`vitana-v1:apps/mobile/tests/community/groups.test.tsx:110-125`: loaded, not-found, query error), but no test goes through this route file (audit §4).
- `/comm/my-groups/:id` is not in `NATIVE_ROUTES` and `NATIVE_PATTERNS` is only `['/discover/provider/:id']` (`resolve.ts:154`), which `tests/discover-commerce/routes.test.tsx` pins. By the code at `resolve.ts:176-206`, `resolveWebPath('/comm/my-groups/g-1')` therefore falls to the ledger-row match and returns `unported`, not `native`. This is reported as a finding (see Findings); it is not asserted as expected behaviour and not changed.
- Test layout: `apps/mobile/jest.config.js` uses `roots: ['<rootDir>/tests']`, `testMatch: **/*.test.ts(x)`, so a new folder `tests/parity-gaps/` is picked up with no config change. The community test helpers (`tests/community/mocks.ts`, `tests/community/helpers`, `tests/helpers/no-network`) provide the expo-router stub, a Supabase double and a query wrapper; they are imported, not edited.

## Findings (reported, no change made)
1. Ledger vs screen list: no mismatch. 11 App.tsx paths have no row whose `web_path` equals them literally by design (`web_path = mobileRoute ?? route`, `scripts/native/parity-ledger.mjs:66-90`).
2. Stale rows: none.
3. Missing tests: `/intents/mine` and `/comm/my-groups/:id` (this plan's lane).
4. Resolver gap: `/comm/my-groups/:id` has a route file and a `native` row but is absent from `NATIVE_ROUTES`/`NATIVE_PATTERNS`, so the resolver (ORB, deep links) calls it unported. Changing that needs a `resolve.ts` edit and the pinned test in `discover-commerce`; both are out of this plan. Recorded for a follow-up plan.
5. Evidence of depth: the other 193 native rows reference a test by textual match only (audit Limits); this plan does not deepen them.

## Decisions
1. **New test files only.** Reason: owner rule of this run (no edits to existing tests or helpers, no source change). Folder `apps/mobile/tests/parity-gaps/`.
2. **Test the route files, not the screens again.** The redirect test renders the real route file with a faked `expo-router` whose `Redirect` records its `href`, and asserts `/comm/find-partner?view=posts`, matching the web redirect named in the file header. The group test renders the real route file with `useLocalSearchParams` returning an id and the existing Supabase double, and asserts `screen-group-detail` with the group name, plus the not-found state for a missing id. Reason: those are the behaviours the ledger row claims.
3. **Ledger and resolver untouched.** Reason: "Do not change ledger status without evidence"; the evidence here supports `native` for both rows (files exist and behave as the rows say), so there is nothing to flip. The tests also assert the two ledger rows are `native` with the lane and key as they are today, read from `ledger.json` read-only, so a later change must update the test knowingly.
4. **Fakes only.** Reason: no network, no live system. Tests import `tests/helpers/no-network` and use `createCommunitySupabaseDouble`.

## Lane
| Lane | Repo | Executor / seat → reviewer | Scope | depends_on | next_actor |
|---|---|---|---|---|---|
| `route-tests` | vitana-v1 | kiro / exafyltd → agent:vitana-lane-reviewer | `apps/mobile/tests/parity-gaps/**`, `docs/validation/**` | — | kiro |

One lane, no shared file, no hot file (no `ledger.json`, `resolve.ts`, `packages/core`, `App.tsx` edit).

## Tests and verification
- New: `apps/mobile/tests/parity-gaps/intents-mine-route.test.tsx`, `apps/mobile/tests/parity-gaps/my-groups-route.test.tsx`. Red-on-base for a tests-only lane: the tests pass on base by design (the behaviour exists; the tests are missing). The builder therefore proves each test can fail by a local, uncommitted mutation in its worktree (change the redirect target; render a different screen in the my-groups route; make the ledger row key differ), records the failing runs in \`docs/validation/<VTID>/commands.log\`, and restores the files before committing (\`git diff\` on \`apps/mobile/app\` and \`apps/mobile/src\` must be empty).
- `cd apps/mobile && npm ci && npx jest tests/parity-gaps --maxWorkers=2 && npm run typecheck`, then the full `npm test --maxWorkers=2`; root `node scripts/native/parity-ledger.mjs --check` (must be unchanged).
- Staging proof: not verified on staging: the lane adds test files only and deploys nothing; the Jest tests are the proof.

## Measurement
Done when both new tests pass, the full mobile suite is unchanged apart from the added tests, and `git diff --stat origin/main` lists only files under the lane `paths`.

## Out of scope / owner-gated (listed, not built)
- The 30 `native` rows with `last_parity_check: null` (audit §5): stamping them needs owner / G1 on-device parity evidence (isolated test backend), not a unit test.
- The 2 `exception` rows without an owner (`/download`, `/maxina/app`): need an owner assignment or the Gate-1 decision reference.
- The resolver gap in Finding 4 (`resolve.ts` and the `discover-commerce` pin): source change, follow-up plan.
- The 25 rows last checked 2026-10-21 and any ledger status change: no evidence of a mismatch, so none is made.
- Deepening query-variant (`?tab=`) assertions of already-covered rows.

## Unchanged
Ledger, `resolve.ts`, every existing test and helper, `scripts/collab/**`, `.kiro/steering/**`, `CLAUDE.md`, lane-scope rules, production and every live system.
<!-- plan:end -->
