# Plan sparring record — VTID-05156 (Health Hub Phase 0 fix-ups, gateway half "PLAT-FIX")

- **VTIDs:** VTID-05156 (vitana-platform, this PR — Defects 2, 3, 5; Defect 4 follows in a separate PR). The plan is shared with **VTID-05155** (vitana-v1, "V1-FIX", Defect 1).
- **Parent program:** VTID-05020 (Health Hub plan v2, Phase 0).
- **Sparring session:** `plan_sparring_sessions.id = 0098b5b2-612d-4b9e-a478-d3e80449692b`.
- **Partner:** `plan-sparring-partner` agent (read-only, independent). **Rounds:** 3. **Verdict:** CONVERGED.
- **Plan hashes:** round 1 `ddb849fc8c25236e63681dd280ba0564e5b57cdc24ae0f0c3d3489009ebca34e`, **final `9453a891f1ee854ffd413e7c61be22b8feca71d4ead4b65d036cecaaed17d125`**.
- **Owner approval:** d.stevanovic@exafy.io in the Claude Code session, 2026-10-13 — "Continue and make the decisions yourself" (Gate 1; planner defaults taken: Index read removed from find_perfect_match now; defect 4 in a follow-up after #4057; lab-report grant left to the Phase 1 consent rework).

## Rounds

| Round | Findings | Answers | Verdict |
|---|---|---|---|
| R1 | F1 (blocker): Change 6 premise. F2–F4 (major). F5–F7 (minor). | F1 rejected — the partner read the local checkout, which is on the #4057 branch; `NOT_PUBLISHED_MISSING` does not exist on origin/main, so Change 6 waits for #4057. F2–F4 accepted (plan changed). F5–F7 accepted. The planner added Defect 5 (wearable-samples RPC grant). | NOT CONVERGED |
| R2 | F8 (major); F9, F10 (minor). | F8 accepted; F9, F10 minor, addressed. | NOT CONVERGED |
| R3 | none | — | CONVERGED |

## Scope of this PR (VTID-05156)

Changes 4, 5, 7 and 8 of the final plan. **Change 6 (Defect 4) is not in this PR** — it depends on `NOT_PUBLISHED_MISSING` from PR #4057 (VTID-05090) and lands in a follow-up after #4057 merges (owner default, Open question 2). Change 7's STATUS row records that.

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard (small fixes). One sparred plan, two VTIDs:
  - **V1-FIX** (vitana-v1): Defect 1.
  - **PLAT-FIX** (vitana-platform): Defects 2, 3, 4 and 5.
- **Program:** Health Hub plan v2 (VTID-05020), Phase 0. Related work:
  - VTID-05089 (D6a). Its sparring record lists Defects 2 and 3 as follow-ups: `docs/validation/VTID-05089/plan-sparring.md:37`.
  - VTID-05090 (D9, PR #4057, open draft). It fixes `nextAction` for unpublished text but not the per-step link.
  - VTID-05025 (commerce boundary suite).
- **Repos / areas:**
  - vitana-v1: `src/pages/admin/marketplace/{PartnerHealthOrders,Overview,Products}.tsx`, `src/pages/settings/Limitations.tsx`, one new Vitest, one staging spec.
  - vitana-platform: `services/gateway/src/services/orb-tools/{discovery-tools,discovery-tools-repository}.ts`, `services/gateway/src/services/orb-tools-shared.ts`, `services/gateway/src/services/commerce-mcp.ts`, `services/gateway/src/services/tool-manifest.json`, tests and snapshots, `docs/programs/health-hub/STATUS.md`.
- **Database:** one migration, for Defect 5 only: `REVOKE`/`GRANT` on `health_ingest_wearable_samples`, no table or column change (applied via `RUN-MIGRATION.yml` after Gate 2). Defects 1–4 need no migration and write nothing new.
- **Regulatory impact:**
  - Defect 2 removes a path where health-derived data (the Vitana Index) shapes a people-match request that can be posted to the community intent board.
  - Defect 3 makes the marketplace tools read the member's own stated goal, which D6a intended. They read no health table.
  - Defects 1 and 4 have no regulatory impact.

## Facts (file:line)
**Defect 1: doubled `/api/v1` (vitana-v1). Real, and it affects four pages, not one.**
- F1 Every build sets `VITE_GATEWAY_URL` to the origin plus `/api/v1`:
  - `.env:10`: `VITE_GATEWAY_URL="https://gateway.vitanaland.com/api/v1"`.
  - `AWS-STAGE-DEPLOY-FRONTEND.yml:131-132`, `AWS-PROD-DEPLOY-FRONTEND.yml:157-158`, `PREVIEW-DEPLOY-FRONTEND.yml:92-93` and `PR-GATE.yml:223` set `VITE_GATEWAY_BASE` to the bare origin and `VITE_GATEWAY_URL` to the origin plus `/api/v1`.
- F2 Four files build `const GATEWAY_URL = (VITE_GATEWAY_URL || VITE_GATEWAY_BASE || "")`, which prefers the value that already ends in `/api/v1`, and then add `/api/v1/...` again:
  - `src/pages/admin/marketplace/PartnerHealthOrders.tsx:41`, used at `:111, :112, :135, :165, :195` (`/api/v1/admin/partner-health/{orders,inbox,…}`).
  - `src/pages/admin/marketplace/Overview.tsx:25`, used at `:86`.
  - `src/pages/admin/marketplace/Products.tsx:27`, used at `:92, :119`.
  - `src/pages/settings/Limitations.tsx:30`, used at `:174, :175, :217, :225` (`/api/v1/user/limitations[/impact]`). This page is for members, not staff. It is where members record allergies and contraindications, the data behind the §2(b) safety-filter carve-out.
- F3 The gateway mounts these routes only once, under a single prefix: `services/gateway/src/index.ts:1208` (`/api/v1/admin/marketplace`), `:1210` (`/api/v1/admin/partner-health`), `:1250` (`/api/v1/user/limitations`). No code rewrites a doubled prefix (grep for `api/v1/api/v1` in `services/gateway/src` finds nothing). So every request from these four pages returns 404, on staging and in production.
- F4 A helper for this already exists: `src/lib/gateway-base.ts:19-30` exports `GATEWAY_BASE` (bare origin) and `GATEWAY_API_URL` (origin plus `/api/v1`), and `src/lib/gateway-base.test.ts:9` tests it. Earlier fixes of the same bug are in `src/hooks/useMarketplace.ts:12-17` and `src/lib/notifDiag.test.ts:37`.
- F5 The unit test `src/pages/__tests__/partner-health-staff.vtid-05056.test.tsx:150, :167` only checks URL suffixes with `endsWith`, so it never noticed the doubled prefix. Line `:217` checks the path through the shared hook `usePartnerHealthOrders.ts:21`, which is correct.

**Defect 2: `find_perfect_match` reads the Vitana Index (vitana-platform). Real.**
- F6 `services/gateway/src/services/orb-tools/discovery-tools.ts:102-131`: `getCompassAndWeakestPillar` reads `life_compass` (`:110`) and then the latest `vitana_index_scores.pillars` (`:118`, through `discovery-tools-repository.ts:29-37`). It takes the lowest pillar as `weakest_pillar`. This is the only caller of that repository function.
- F7 `tool_find_perfect_match` (`discovery-tools.ts:1032-1098`) uses that pillar in three ways:
  - (a) when the member gives no `ask`, it builds the request from `PILLAR_DEFAULT_ASK` (`:1024-1030`, `:1046-1050`), for example "an accountability partner for a better evening and sleep routine";
  - (b) it puts the pillar into the spoken prefix as "their sleep pillar (currently their weakest)" (`:1075-1080`);
  - (c) it returns `weakest_pillar` in the tool result (`:1089`).

  The tool description also says the search is personalised with the weakest pillar (`:1305-1323`, mirrored in `services/gateway/src/services/tool-manifest.json:1932`).
- F8 `runFindMatch` (`services/intent-find-match.ts:258-318`) posts the request to `user_intents` **without asking the member** whenever the catalogue has a match and the extraction is complete (`:314-318`). Only the no-match path asks first (`:388-399`). So an ask built from the Index can become a community-visible request ("looking for a sleep-routine accountability partner") that the member never put into words or confirmed.
- F9 Purpose boundary (`docs/programs/health-hub/HEALTH-HUB-PLAN.md` §2):
  - §2(b) names commerce modules only. People-matching is community, not commerce, so the VTID-05025 suite does not cover `discovery-tools.ts`.
  - §2(a), voice: "only §2-catalogue patterns and consented categories enter the wellness context injected into the prompt".
  - D10 (VTID-05092..05094) gates device and lab reads only. It explicitly leaves the ~20 Index readers to Phase 1/4.
  - D6a removed the Index read from the marketplace tools "unconditionally". The reason: once the D6a bridge is on, the Index can contain device data (`orb-tools-shared.ts:4548-4551`).
  - Today the bridge is off (`WEARABLE_FEATURE_BRIDGE_ENABLED` unset, STATUS row 11), so the Index is not yet device-derived. The problem is the posting side effect in F8, which no other Index reader has.
- F10 Tests that pin the current behaviour: `services/gateway/test/orb-tools/discovery-tools.test.ts:736-810` ("fuses … weakest pillar", "derives a default ask from the weakest pillar"). The snapshots `test/orb/latency/__snapshots__/vtid-04542-voice-payload-identity.test.ts.snap`, `test/orb/live/characterization/__snapshots__/{system-instruction,tool-catalog}.characterization.test.ts.snap` contain the description.

**Defect 3: `life_compass.current_goal` does not exist (vitana-platform). Real. The goal is always null.**
- F11 `life_compass` has `primary_goal TEXT NOT NULL`, `category`, `is_active`, `created_at` and no `current_goal`:
  - created in vitana-v1 `supabase/migrations/20251007074530_f958ba2b-….sql:2-14`;
  - the only later change is `20260526000000_life_compass_goal_target.sql:7-11`, which adds the target columns only;
  - `current_goal` appears in no migration in either repo.
- F12 `orb-tools-shared.ts:4552-4568` `_getCompassGoal` runs `.select('current_goal').eq('user_id', …).maybeSingle()`. It has no `is_active` filter and no ordering. PostgREST answers an unknown column with an error object (42703), not an exception. The code ignores `error`, so `goal` is always `null`. Without the column error, a member with more than one historical row would also make `maybeSingle()` fail.
- F13 Effect:
  - `find_perfect_product` (`:4582, :4618, :4630`) and `find_perfect_practitioner` (`:4648, :4679, :4689`) never include the member's goal in their rationale or result.
  - The VTID-05089 comment (`:4548-4551`) says these tools "read only the member's Life Compass goal". In fact they read nothing.
  - The file's own `get_life_compass` (`:4375-4386`) already uses the correct columns (VTID-03022). The correct query also exists as `orb-tools/discovery-tools-repository.ts:18-27` `fetchLifeCompassGoal`.
  - Nothing breaks and no error is logged. This is the pattern called "silently degrade".

**Defect 4: link attached to a step the supplier cannot do (vitana-platform). Real on main for `terms`, and #4057 extends it to `dpa`.**
- F14 On main, `partner-onboarding-checklist.ts:221-224` sets `terms` to `status:'todo', missing:['terms_not_published']` when no Partner Terms version is published. On the branch, #4057 adds the same case for `dpa` (`missing:['dpa_not_published']`, branch diff in `buildChecklist` `case 'dpa'`).
- F15 `commerce-mcp.ts` `shapeStatus` (main `:373-414`, branch `:416`) adds `done_on_vitanaland: true, link: <portal>` to every step in `ON_SCREEN_STEPS` (`:318`, which includes `terms` and `dpa`) unless the step is `not_required`. It never checks `missing`. So the assistant gets a "go do this on Vitanaland" link for text that does not exist yet.
- F16 #4057 fixed only `nextAction`, adding `NOT_PUBLISHED_MISSING` (branch `commerce-mcp.ts:345-353, :376-379`), so `next_action.link` is `null` for these steps. Its test `vtid-04941-commerce-mcp-automation.test.ts:69-74` checks `next_action` and `steps[0].missing` but not `steps[0].link`. Tests that must stay green:
  - `commerce-mcp.test.ts:202`: a `terms` step with no `missing` keeps its link.
  - `vtid-04941-…:84-86`: `terms` without `missing` stays `done_on_vitanaland`.
  - `commerce-mcp.test.ts:228`: `not_required` steps get no link.

- F17 (defect 5, found while planning Phase 1 package C) `public.health_ingest_wearable_samples(jsonb)` is `SECURITY DEFINER` and granted to `authenticated` (`supabase/migrations/20251231000000_vtid_01078_health_brain_phase_c1.sql:636, :639, :722`). Read-only check on the live database 2026-10-13: `has_function_privilege('authenticated', …, 'EXECUTE') = true`, `anon = false`, `wearable_samples` has 0 rows. So any signed-in member can write wearable samples directly through PostgREST with no consent check. Its only caller, `POST /api/v1/health/wearables/ingest` (`routes/health.ts:251`, `routes/health-repository.ts:30`), is not used by the app (vitana-v1 has only the generated type, `src/integrations/supabase/types.ts:13696`).
- F18 The sibling `health_ingest_lab_report(jsonb)` has the same grant (`…_phase_c1.sql:617`, live check: `authenticated = true`), but it has live callers (`routes/health.ts:156`, `routes/patient-health-results.ts`, `services/orb-tools/health-depth-tools.ts`), so it cannot be revoked without reworking those paths (Out of scope, Open question 4).

## Changes (numbered)
**V1-FIX (vitana-v1)**
1. In the four files from F2, replace the local `GATEWAY_URL` with `GATEWAY_BASE` imported from `@/lib/gateway-base` (F4), and keep the existing `/api/v1/...` paths. The other way round would be to import `GATEWAY_API_URL` and remove `/api/v1` from 13 call sites. That is a bigger diff. Changing only the import keeps every path string greppable. This works because `GATEWAY_BASE` is the bare origin (`https://gateway.vitanaland.com`) and every call site already spells out `/api/v1/...`, so the result has exactly one prefix (round-1 F2).
   - `PartnerHealthOrders.tsx:41`, `Overview.tsx:25`, `Products.tsx:27`, `Limitations.tsx:30`: one line each, plus the import.
   - Fix the doc comments that say "same GATEWAY_URL resolution" (`PartnerHealthOrders.tsx:14-15`).
2. A new Vitest `src/pages/__tests__/gateway-prefix.vtid-<V1-FIX>.test.ts` with two parts:
   - (a) A source scan of `src/**/*.{ts,tsx}` that fails on any module-level constant built from `VITE_GATEWAY_URL` and then used with `` `${X}/api/v1 `` in the same file. Each match is reported with file and line. Files already known to have the bug but outside this fix are listed as exceptions with a reason (Out of scope).
   - (b) Render `PartnerHealthOrders` and `Limitations` with `VITE_GATEWAY_URL=https://gw.example/api/v1` and a mocked `fetch`. Assert that every requested URL starts with `https://gw.example/api/v1/` and contains no `/api/v1/api/v1`.

   Also tighten `partner-health-staff.vtid-05056.test.tsx:150, :167` from `endsWith` to the full path.
3. Staging spec `tests/e2e/staging/vtid-<V1-FIX>-gateway-prefix.staging.spec.ts`, read-only, written in the existing `staging-guard` style.

No What's New entry and no screen-registry change, because these are fixes and no route changes. No new user-visible strings.

**PLAT-FIX (vitana-platform)**

4. **Defect 2.** In `discovery-tools.ts`:
   - Replace `getCompassAndWeakestPillar` with a goal-only helper that calls `repo.fetchLifeCompassGoal` (`:110`).
   - Remove `PILLAR_DEFAULT_ASK` and the derived ask. With no `ask`, the tool always returns the existing `needs_ask` stage (`:1051-1056`).
   - Remove the pillar from the prefix and from `result`: the `personalBits` prefix (`:1074-1080`) keeps only the `compass_goal` branch; the `weakest_pillar` branch and the `derivedFromPillar` suffix are removed (round-1 F3). Keep `ask_derived_from_pillar` in the result, always `false`, so consumers of the result shape keep working.
   - Update the tool description (`:1305-1323`), the `ask` parameter text ("May be omitted — then the weakest pillar suggests one" becomes "May be omitted — the tool then asks the member") and the header comment (`:29-33, :96-101`).
   - Delete `fetchLatestVitanaIndexScore` from `discovery-tools-repository.ts:29-37`. It has no other caller.
   - Regenerate `tool-manifest.json` and the three snapshots for the description change only. The diff is checked to show only description lines, the same way D6a did it.
5. **Defect 3.** `orb-tools-shared.ts:4552-4568` `_getCompassGoal` reads `life_compass` with the same corrected query `tool_get_life_compass` in the same file already uses (`:4384-4390`: `primary_goal`, `is_active=true`, newest first, `limit(1)`), and uses `primary_goal`. It stays local to `orb-tools-shared.ts`, so the shared module does not import from one tool family's repository (round-1 F4; `tool_get_life_compass` itself returns an ORB tool result, so it is not called directly). On a returned `error`, it logs `console.warn('[find_perfect_*] life_compass read failed: <code>')` and returns `null`, so the problem is no longer silent. No other change: the rationale wording at `:4618/:4679` already handles a goal.
6. **Defect 4.** (The commerce-MCP tool description gains one sentence: a step with `waiting_on_vitanaland` has nothing the supplier can do yet; round-1 F7.) In `commerce-mcp.ts` `shapeStatus`, a step whose `missing` contains its `NOT_PUBLISHED_MISSING[st.key].code` gets:
   - no `done_on_vitanaland` and no `link`;
   - `waiting_on_vitanaland: true` and `how: <the waiting action text>`, reusing the existing `how` field from the mapping step (`:418`).

   This uses the `NOT_PUBLISHED_MISSING` map that #4057 adds, so PLAT-FIX goes on the same designated branch after #4057 merges (Rollout 2). For `terms` alone, the change also fixes the main-only case (F14).
7. Add one row to `docs/programs/health-hub/STATUS.md` (PLAT-FIX, plus the V1-FIX reference), in the same PR.

8. **Defect 5.** (PLAT-FIX) New migration `supabase/migrations/<ts>_vtid_<PLAT-FIX>_revoke_wearable_samples_rpc.sql`: `REVOKE EXECUTE ON FUNCTION public.health_ingest_wearable_samples(jsonb) FROM PUBLIC, anon, authenticated;` and `GRANT EXECUTE … TO service_role;`. No table is created, so the `drift` check is unaffected. `POST /api/v1/health/wearables/ingest` answers `410 {ok:false, error:'ENDPOINT_RETIRED'}` before any database call (the Health Sync contract replaces it in Phase 1). Applied only via `RUN-MIGRATION.yml` after Gate 2, with a read-only before/after privilege check recorded in Gate 2.

## Tests
**vitana-v1 (Vitest, V1-FIX)**
- Change 2(a) source scan and 2(b) render test. They fail on current main (verified by running them before the fix) and pass after it.
- The tightened `partner-health-staff.vtid-05056` assertions.
- `npm test`, `npm run lint`, `npm run build`.

**vitana-platform (Jest, PLAT-FIX)**
- `discovery-tools.test.ts`:
  - replace the two pillar tests with: no `ask` returns `needs_ask` and `runFindMatch` is never called;
  - the mocked client gets **no** `.from('vitana_index_scores')` call (assert the table list);
  - `result` has no `weakest_pillar`, and the prefix names only the Life Compass goal.
- A source scan in the VTID-05025 boundary-suite style, `test/vtid-<PLAT-FIX>-people-match-health-boundary.test.ts`: `discovery-tools.ts` and `discovery-tools-repository.ts` contain none of the `HEALTH_TABLES` names. It does not change the commerce list in the VTID-05025 suite.
- `orb-tools-shared` tests for `find_perfect_product` and `find_perfect_practitioner`:
  - the query selects `primary_goal` with `is_active=true` and never `current_goal`;
  - an active goal appears in `rationale` and `compass_goal`;
  - a returned PostgREST error gives `compass_goal:null` plus one warning, and products are still returned.
- `vtid-04941-commerce-mcp-automation.test.ts`: for `terms_not_published` and `dpa_not_published`, `steps[i]` has no `link`, no `done_on_vitanaland`, `waiting_on_vitanaland:true` and a `how` that matches "nothing to do yet". `commerce-mcp.test.ts:202` and `vtid-04941:84-86` (published `terms` keeps its link) and `:228` stay green unchanged.
- Snapshot regeneration (description only), plus `npm run test:support`, `npm run test:operator` and `npm run test:roles`. The tool catalog is part of the ORB profile. `tsc`, lint.
- No test writes to the shared database. Every database read is mocked.

**Staging verification (read-only, `docs/validation/<VTID>/staging-tests.json` per VTID)**
- **V1-FIX (Playwright on preview-aws, staging guard on, every non-GET aborted except sign-in):**
  - Sign in as the test user and open `/settings/limitations` at 1400×900 and 390×844.
  - Assert the page sends `GET https://preview-aws-gateway.vitanaland.com/api/v1/user/limitations` and `/impact`, and both answer 200 JSON.
  - Assert no request in the session contains `/api/v1/api/v1`.
  - Inspect the screenshots. Nothing is clicked and nothing is saved.
  - Also a direct GET of `${GATEWAY}/api/v1/admin/partner-health/orders` with the test user's token. It must answer JSON (401/403, because the test user is not an admin), not an HTML 404. That shows the single-prefix route is the one the page now calls.
  - The three admin pages need an admin role. The staging test user is not one, so those pages are covered by the Change 2(b) Vitest (`kind: existing`, with that reason).
- **PLAT-FIX:**
  - `GET /api/v1/admin/build-info` on preview-aws-gateway reports the verified commit, and `GET /alive` returns 200.
  - Every other check is `kind: existing` Jest with a reason:
    - `find_perfect_match` can post to `user_intents` (F8), which is a write to the shared database;
    - `find_perfect_product`/`practitioner` run only inside an authenticated ORB session;
    - commerce-MCP `get_onboarding_status` needs a supplier OAuth token and an org the test user does not have.
  - None of these can be probed read-only.

- Defect 5: a Jest test that the route answers 410 without touching Supabase, and a CI SQL test on a throwaway Postgres (the existing grants-test pattern) asserting that after the migration `authenticated`/`anon` have no EXECUTE and `service_role` has it. This is not a staging probe: on staging only the 410 is checked; the live privilege state is checked read-only before and after the migration is applied, after Gate 2.

## Rollout
1. Spar this plan, then Gate 1. Allocate V1-FIX (vitana-v1) and PLAT-FIX (vitana-platform), each citing the sparring record.
2. **V1-FIX** depends on nothing. PR, then merge, staging deploy, STAGING-VERIFY, Gate 2, then the production frontend deploy pinned to the verified commit. The commit range between production and that commit is listed in Gate 2.
3. **PLAT-FIX** Changes 4, 5, 7 and 8 do not depend on #4057. Change 6 does: `NOT_PUBLISHED_MISSING` exists only on #4057's branch (`git grep NOT_PUBLISHED_MISSING origin/main` finds nothing on main e1ad8a0fd), so Change 6 lands after #4057 merges (round-1 F1 rejected: the partner read the local checkout, which is on the #4057 branch). If #4057 is still blocked on its migration when this is ready, see Open question 2.
   - It ships no migration, so the `drift` check is not affected.
   - Then merge, staging, STAGING-VERIFY, Gate 2, then the gateway production deploy pinned to the verified commit.
   - Gate 2 lists every commit between production and that commit. The D9 and D10 commits on the same branch need their own approvals.
4. Rollback: redeploy the previous commit. Defect 5's revoke is reversed by `GRANT EXECUTE … TO authenticated` (one statement; the original migration never granted `PUBLIC` or `anon`, so those revokes are idempotent); no data changes.

## Out of scope
- `health_ingest_lab_report` grant (F18): it has live callers; the consent-gated rework belongs to D10 WP3 / Phase 1 (Open question 4).
- The same doubled prefix in files that no route uses or whose gateway routes are not mounted. The Change 2(a) scan lists each of these as an exception with its reason:
  - `src/hooks/useRelease{Backlog,History}.ts` and `useReleasesOverview.ts` (`/api/v1/releases/*`). No `releases` mount was found in `services/gateway/src/index.ts`, so fixing the prefix would still 404.
  - `src/pages/Changelog.tsx` and `src/pages/dev/DevDocsBacklog.tsx` are not in `App.tsx`.
  - These need their own check: is the backend route dead, or mounted elsewhere?
- Other readers of the Vitana Index (`orb-livekit.ts:1306`, `index-pillar-weighter.ts:201`, `user-model-synthesis.ts:134`, `health-wellness.ts:196`, …). They are covered by the Phase 1/4 wellness-context module (D10 Out of scope). Only `find_perfect_match` turns the Index into a community-visible post.
- Asking for confirmation before posting on the matched path in `runFindMatch` (F8). That behaviour is older than Health Hub. Once Defect 2 is fixed, every posted request comes from the member's own words.
- Top-level `portal_link` in `shapeStatus`. It is the link to the business page in general and stays.
- Publishing Partner Terms or DPA text (owner/legal).

<!-- plan:end -->
