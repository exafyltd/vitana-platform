# VTID-04986 — Overview follow-ups: screen-inventory generator fix + retire overview-timeseries

Plan D (follow-ups to Command Hub Overview Phases 2–4, VTID-04885/04886/04887). Sparring record:
`plan-sparring.md` (converged, owner-approved 2026-10-08, plan hash `b76c4464…cc56c8`).

What changed:
- `services/gateway/scripts/regen-screens-catalog.mjs` builds its icon stubs from the source it
  evaluates, so a new lucide icon in vitana-v1 can no longer crash it. It also disambiguates the
  screen ids that newer sections reuse, so the run gets past its second, older failure.
- `GET /api/v1/ops/overview-timeseries` is retired: route file, mount, unit test and the
  `.env.example` mention are deleted, and `route-manifest.json` is regenerated.

What did NOT change, on purpose (see "Stopped and reported"): the regenerated
`dev-screen-inventory-v1.json` and `navigation-config.js` are not committed, and so the Jest guard
that they carry none of the four retired Overview tabs is not committed either.

No live endpoint, database or AWS API was called while building this (`commands.log`).

## Generator

AC-1: `loadAdm()` no longer evaluates `ADMIN_SECTIONS` against a fixed list of 12 icon stubs.
`collectBareIdentifiers()` scans the literal outside strings and comments and every bare identifier
becomes an inert frozen stub (`buildIdentifierStubs()`), so `icon: Inbox`, `icon: Briefcase` and
any future icon parse. A fixture with an icon the generator has never seen parses; words inside
strings and comments are not collected. All four cases fail on the old script.
TEST: services/gateway/test/scripts/vtid-04986-regen-screens-catalog.test.ts

AC-2: The script is importable: the helpers are exported and `main()` runs only when the file is
executed directly, so importing it writes nothing.
TEST: services/gateway/test/scripts/vtid-04986-regen-screens-catalog.test.ts ("does not run the regen (or write files) when imported")

AC-3: With the icon crash fixed, the run reached a second failure, `duplicate screen_ids:
DEV-OVERVIEW, DEV-SESSIONS, DEV-CONFIG, DEV-TOOLS, DEV-RUNS, DEV-CATALOG, DEV-HISTORY,
ADM-ACTIVITY, ADM-EVENTS, ADM-DASHBOARD` (the same failure VTID-04887 recorded as a known gap).
`idOverrides` now disambiguate the colliding tab keys. Ids the inventory already carries stay
(`DEV-TESTING_OVERVIEW/_CATALOG/_RUNS/_RUN_TESTS/_TEST_CONTRACTS`); sections added since get a
prefix (`DEV-COMMERCE_OVERVIEW`, `DEV-VOICE_SESSIONS`, `ADM-BACKOFFICE_DASHBOARD`, …). A full run
with `VITANA_V1_ROOT=/home/user/vitana-v1` completes; `validate-dev-frontend-spec.mjs` accepts its
output (25 modules, 133 screens) and `--check` reports it in sync.
TEST: node services/gateway/scripts/regen-screens-catalog.mjs (outputs/06-regen-drift-summary.txt)

## Route retirement

AC-4: Caller search before deletion, both repos (`/home/user/vitana-platform`,
`/home/user/vitana-v1`), for `overview-timeseries`, `overview_timeseries`, `overviewTimeseries`,
`ops-overview-timeseries` and `DEV-COMHU-03404`: Command Hub app.js and every other frontend,
scripts, workflows, every `staging-tests.json`, operator tools, vitana-v1 `src/`, `supabase/`,
`scripts/`, `.github/`. Hits were only the route file, its mount, its unit test, the
`.env.example` comment, a VTID-04887 test asserting the old `overviewTimeseries:` state is gone,
generated route snapshots (`route-manifest.json`, historical `reports/**/routes.json` and
`baselines/**`), and old evidence packs. No caller exists, so the route is deleted.
TEST: services/gateway/test/vtid-04986-overview-timeseries-retired.test.ts ("the Command Hub never calls it")

AC-5: The route file, its require and mount in `src/index.ts`, `test/ops-overview-timeseries.test.ts`
and the `.env.example` mention are gone. The domain atlas claims ops routes by `/^ops-/`, so it
needs no edit; the atlas drift guard in `npm run test:roles` stays green. The command-hub symbol
index never referenced the route (it indexes app.js functions), so it is not regenerated.
TEST: services/gateway/test/vtid-04986-overview-timeseries-retired.test.ts ("the route file, its mount and its env mention are gone")
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-6: The retired path is unmounted. The real app from `src/index.ts`, in-process, answers
`404 text/html` "Cannot GET /api/v1/ops/overview-timeseries" (Express's default; no root-mounted
router claims it). It answered `401 application/json` before. Restoring the route makes this
case fail. The sibling `ops/pipeline-summary` still answers 401 JSON.
TEST: services/gateway/test/vtid-04986-overview-timeseries-retired.test.ts ("the retired path falls through to the default 404 (text/html), not 401 JSON")
CURL: GET https://preview-aws-gateway.vitanaland.com/api/v1/ops/overview-timeseries (no token) -> 404 text/html, body contains "Cannot GET /api/v1/ops/overview-timeseries" (staging-tests.json, read-only; not run from this session)

AC-7: `scripts/aws-staging-validation/route-manifest.json` is regenerated with
`generate-route-manifest.mjs`, never by hand. The retired prefix leaves (174 → 209 prefixes); the
other 36 additions are prefixes `src/index.ts` already mounts that the stale snapshot (last
regenerated 2026-10-01) was missing — e.g. `/api/v1/ops/attention`, `/api/v1/ops/pipeline-summary`,
`/mcp`, `/.well-known`.
TEST: services/gateway/test/vtid-04986-overview-timeseries-retired.test.ts ("the generated route manifest no longer lists it")

AC-8: Route evidence gate. This change adds no route, so `validator-path-guard.cjs
--route-evidence-required` does not fire and ROUTE_MOUNT/FINAL_URL/CURL_PROOF are not required
for a removal (VALIDATOR-CHECK.yml, VTID-03696). The read-only staging suite proves the removal
after deploy instead.
CURL: GET https://preview-aws-gateway.vitanaland.com/alive -> 200 (staging-tests.json)

## Gates

AC-9: Every served-asset assertion in `docs/validation/*/staging-tests.json` still matches the local
Command Hub files (no frontend file changed): 89 checked, 0 failed.
TEST: offline check (outputs/07-staging-asset-assertions.txt)

AC-10: The standing suites and the type check stay green: `npx tsc --noEmit` exit 0,
`npm run test:roles` 105 passed, Command Hub tests 36 suites / 520 passed, script tests 17 suites /
204 passed. Full gateway suite: 1561 suites passed, 0 "failed to run", 24919 tests passed, 1 failed
(`vtid-04975-kiro-operator-ui`, the pre-existing styles.css ordering artifact under "Stopped and
reported"; 15/15 when run on the restored file) (outputs/09-full-suite.summary.txt).
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
TEST: npx jest --ci (outputs/09-full-suite.summary.txt)

OASIS_PROOF: no new OASIS event types; the removed route only read `oasis_events`.

## Stopped and reported

- **Inventory not regenerated.** A full regen is not a four-tab removal. The inventory was last
  synced 2026-04-27, and `navigation-config.js` lags app.js by five sections. The regen would
  remove 16 rows and add 40 (DEV 117 → 133, ADM 63 → 66). It would change 3 rows and add five
  sidebar sections (commerce, knowledge-base, conversation, voice, routines). Its removals go
  beyond the four Overview tabs: Assistant ORB Live / Awareness Registry / Awareness Test /
  Voice Tools, Diagnostics Voice LAB, and the three ADM Navigator and four Notifications tabs that
  vitana-v1 no longer has (`outputs/06-regen-drift-summary.txt`, full diff
  `outputs/06b-regen-proposed.diff`). Under the plan's rule ("if large unrelated drift appears")
  this is reported for an owner decision, not committed. The Jest guard for the four retired tab
  ids depends on the regenerated files and waits with them.
- **Auto-regen on merge.** `REGEN-SCREENS-CATALOG.yml` runs on every push to main that touches
  `regen-screens-catalog.mjs`. It opens an auto-merging PR with whatever the regen produces.
  Merging the generator fix will therefore land the drift above through that bot PR, unless the
  owner decides otherwise first.
- **Pre-existing, unrelated:** `test/scripts/find-dead-css-classes.test.ts` runs `--fix` against
  the real `styles.css`. On today's main that deletes the `.kiro-approval--*` rules (built
  dynamically by VTID-04975), and `vtid-04975-kiro-operator-ui.test.ts` then fails when it runs
  later in the same process tree. The working tree was restored after each run (`commands.log`).

## Decisions taken (after the build agent stopped on the regen drift)

- **The full regen is committed in this PR** (`dev-screen-inventory-v1.json`, `navigation-config.js`).
  The drift is the inventory catching up with the live Command Hub since 2026-04-27 (16 retired/moved
  rows out, 40 real screens in, 5 new sections; summary `outputs/06-regen-drift-summary.txt`). Leaving it
  out would not prevent it: `REGEN-SCREENS-CATALOG.yml` runs on the generator change after merge and opens
  an auto-merging PR with the same output, unreviewed. Committing it here keeps it in a reviewed PR.
  The validator passes (25 modules, 133 screens) and `--check` reports in sync.
- **Duplicate screen-id overrides** in the generator (outside the plan's text, required for the generator
  to run at all): existing `DEV-TESTING_*` ids stay stable; new sections get a prefix.

AC-6: The committed inventory and `navigation-config.js` list none of the four retired Overview tabs, and
the generator's `--check` reports them in sync.
TEST: services/gateway/test/vtid-04986-screen-inventory-in-sync.test.ts
