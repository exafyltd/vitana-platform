# Sparring round 1 — in_progress

Session: `6bae03ec-0d06-4ab2-b19e-c8dd872dae69` · plan hash `7768ea86f48e5aafc7dc10e21a492b796014ad4571228e41e1d242d2c3ff5a65`

## Summary

Five findings, one blocker. The dominant problem is that `exafyltd/vitana-v1` has no pinned ref in this session, so every implementation-bearing premise (parity ledger, `apps/mobile/` structure, `vitanaIndex.ts` IO-freedom, `assertNotProduction()`, `scripts/native/` tooling) cannot be verified directly. The sibling plan `native-wave2-home-feed-news` hit the identical infrastructure gap and required an explicit re-trigger after PR #4201 — this plan must be re-triggered under the same fix. Beyond the infrastructure blocker, four substantive issues are raisable from vitana-platform evidence alone: the load-bearing `vitanaIndex.ts` IO-freedom is unconfirmed (same class of finding the sibling plan corrected in R1-F2); the 4+4+16 row partition is unverified (sibling required three rounds to stabilise an equivalent count); the claim that `health-plans-services` "reads no health data" is unsupported for Plans.tsx (383 lines, 5 tabs) and WellnessServices.tsx (286 lines); and the N5a fallback stub has no defined interface or contract test, while N5a itself is owner-blocked with no near-term timeline. One minor stale STATUS.md entry is also flagged.

## Findings

### R1-F1 [blocker]

exafyltd/vitana-v1 has no pinned ref in this session. Every load-bearing implementation premise in the plan — the parity ledger row counts, the 4+4+16 partition, apps/mobile/ directory structure, assertNotProduction(), vitanaIndex.ts IO-freedom, scripts/native/core-closure.mjs and parity-ledger.mjs behaviour, web source file shapes, and all @vitana/core/@vitana/tokens/@vitana/ui presence claims — lives in vitana-v1 and cannot be verified. This is not a minor gap: the sibling plan native-wave2-home-feed-news explicitly documents the same issue (plan.md lines 132-138: 'the vitana-v1 ref fix is merged to main (PR #4201) … This note re-triggers a fresh sparring session on the fixed pipeline') and required an explicit re-trigger. The current plan was almost certainly dispatched before or without that fix applying to this producer. A review that cannot read any of the code it is reviewing cannot catch errors the plan may contain.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:131` — Re-spar note (2026-10-20)
The first sparring session (`759e1c03`) escalated on infrastructure (the pipeline was being fixed — code
access, Bedrock subscription, daily-token cap, and the vitana-v1 ref). Those are all resolved now: the
vitana-v1 ref fix is merged to main (PR #4201, `fa73aabd0`), so `PLAN-SPAR` forwards
`extra_refs: { 'exafyltd/vitana-v1': <sha> }` and a session created from this branch … can read `exafyltd/vitana-v1` to verify this plan's `apps/mobile/**` and web screen premises.
- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/sparring/s2-round-1.md:1` — Session: `d108df80-fd56-498d-a0de-871c4c939a4b`

## Summary

Thirteen premises verified against read_file results. Three hold cleanly and without caveat: shapeOf() at parity-ledger.mjs:60, type-only-import exclusion at extraction-deps.mjs:183-184, and tsconfig @/* alias at line 11.

Suggestion: Re-trigger this sparring session after confirming `extra_refs: { 'exafyltd/vitana-v1': <sha> }` is forwarded by PLAN-SPAR for the `ci-plan-spar.native-wave2-health-biology` producer, exactly as was done for the sibling home-feed-news plan (PR #4201). All code-level premises should then be verified in the fresh session before the plan is allowed to converge.

### R1-F2 [major]

The plan's entire core-extraction argument in Decision 2 rests on src/lib/vitanaIndex.ts (pillarKeys, pillarLabel, getVitanaIndexTier) being IO-free (class A), but no line-level confirmation is provided. The sibling plan's sparring established (s2-round-1.md:37) that reading the unread tail of a source file was 'the only load-bearing case' and was required before the plan could converge. Health-related utility files in vitana-v1 routinely carry transitive runtime imports into @/integrations/supabase/client.ts — the plan itself acknowledges this for useVitanaIndex, useVitanaIndexHistory, and useProfileHealthSummary. If vitanaIndex.ts (or any biology-card helper the plan plans to co-extract) has even one runtime import that reaches supabase/client.ts, core-closure.mjs --check will fail at line 150 ('class ${m.own}') in NATIVE-CI regardless of --write being run. The plan adds no per-file IO-freedom confirmation analogous to the sibling plan's explicit re-read of feed-compose.ts lines 99-110.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/sparring/s2-round-1.md:35` — The unread lines 99–110 of `feed-compose.ts` are the only load-bearing case: the plan's entire core-extraction justification rests on that file being IO-free, and those final lines were never read to confirm no runtime import appears there.
- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/sparring/s2-round-1.md:14` — `exafyltd/vitana-v1:scripts/native/core-closure.mjs:150` —
  if (m.own !== 'A') {
    const sig = m.signals.slice(0, 3)…
    errors.push(`${rel} is class ${m.own} (${sig}) and core reaches it: ${chainTo(rel).join(' -> ')}`);
  }

Suggestion: In the re-triggered session, read src/lib/vitanaIndex.ts in full (every line, not just the exported functions) and trace every runtime import (not type-only) transitively until either a class-B file is reached or the closure is confirmed clean. Record the line-level result in the plan's Measured state block the same way the sibling plan did ('at the pinned commit: ~110 lines, a single import type … no runtime import anywhere including the tail'). Do the same for any additional biology-card helper the health-hub lane proposes to co-extract.

### R1-F3 [major]

The 4+4+16 row partition is asserted but unverifiable. The sibling plan's partition went through three documented corrections across multiple sparring rounds (from '6+2+19' to '8+2+17' to the accepted '9+2+16') because tab-variant ledger rows (each ?tab= value gets its own parity row) are easy to miscount. This plan's 16-row health-plans-services bucket spans: pillars (1), conditions (1), education (1 + podcasts + videos = 3), plans (1 + exercise + hydration + mental + nutrition + sleep = 6), services-hub (1 + insuranceSupport + medicalServices + myServices + wellnessPrograms = 5) — summing to 16 only if every tab variant has exactly one dedicated ledger row and none is shared or missing. The 4-row health-hub and 4-row vitana-index-biology counts are similarly unverified against the actual ledger. A one-row miscount here produces an orphaned or double-owned parity row that parity-ledger.mjs --check will not catch silently once lanes are executing.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:40` — **Partition (R1-F2 / R3-F1, corrected against the ledger): home 9 parity rows**… **news 2 rows, community-hub 16 rows = 27** (9+2+16; the earlier '6+2+19' and '8+2+17' were both wrong).
- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:44` — the three `/home/*` deep-links are ports WITH their own rows, not uncounted sub-routes… `parity-ledger.mjs` matches by exact `shapeOf()` (`:60`), not prefix, so `/home/compose` is never 'covered under `/home`'; if the native files exist but the rows stay `not_started`, `--check` passes silently

Suggestion: In the re-triggered session, read apps/mobile/parity/ledger.json directly, filter on lane === 'health', and enumerate every row by id and screen/overlay type. Confirm the exact partition (health-hub 4, vitana-index-biology 4, health-plans-services 16) against the actual rows, paying particular attention to whether each ?tab= variant appears as a distinct ledger row or is covered by the base path row. Update the Measured state block with the enumeration, exactly as the sibling plan did for its rows.

### R1-F4 [major]

The plan declares that health-plans-services 'reads no health data' and is therefore dependency-free and can run in parallel with health-hub. This characterisation is applied to Plans.tsx (383 lines, 5 tab variants: exercise/hydration/mental/nutrition/sleep) and WellnessServices.tsx (286 lines, 4 tab variants). These are not trivially static or navigational files — at 383 lines with five data-driven tabs, Plans.tsx almost certainly fetches personalised plan content keyed to the signed-in member. If either file calls any hook that reads from vitana_index_scores, supplement data, lab_reports, or any Supabase table requiring auth (even indirectly through useProfileHealthSummary or a plans-specific hook), then health-plans-services silently depends on the native health-data module from health-hub. Launching that lane in parallel with health-hub would leave it consuming a module that does not yet exist, failing the build.

- `exafyltd/vitana-platform:.kiro/specs/native-wave2-home-feed-news/plan.md:53` — **Only the pure IO-free compose/rank modules move into `@vitana/core`; the data-fetching hooks do NOT**… `useNewsFeed`/`useAllNewsFeed` are NOT moved into core — they runtime-import `supabase/client.ts` (`useAllNewsFeed.ts:18`, `useNewsFeed.ts:10`) and would fail the same closure gate; instead the `home` lane **re-implements the fetching natively**
- `exafyltd/vitana-platform:.kiro/specs/health-native/handoff.md:99` — ## Hard rules that bit this program (do not relearn them)
- Never test against production; staging specs are read-only; the staging frontend uses the production Supabase.
- Native code reaches web code only through `@vitana/core`

Suggestion: In the re-triggered session, read src/pages/health/Plans.tsx and src/pages/health/WellnessServices.tsx in full. For each hook import, trace whether it reads from any Supabase table or auth context. If either file calls a health-data hook, health-plans-services must declare depends_on: [health-hub] and its parallel execution claim must be removed. If both are genuinely navigation-only, record the specific hook-free evidence in the plan's Measured state block.

### R1-F5 [major]

The in-screen Health Sync affordance fallback ('typed stub behind the ingest-off flag') has no specified interface and no contract test. N5a-health-sync (the module the stub must conform to) is currently state: executing, next_actor: kiro, depends_on: [phase1-data-core] (n5a-health-sync.md:3-6). phase1-data-core is blocked on d10-consents (open checkbox: 'Owner applies 20261012180000_vtid_05092_health_consent_categories.sql', tasks.md:17), which is itself owner-gated with no timeline. The handoff confirms N5a's PR #1398 cannot land until C1 merges (handoff.md:50). In this situation, the stub will be written and shipped without a stable target interface. The test plan checks that the affordance 'does not itself request an OS permission or ingest' and 'delegates to the n5a-health-sync module' — but those checks use the stub, not N5a's real export. If N5a's public entry changes shape between stub-writing and N5a landing, the health-hub affordance ships with a silently broken delegate call, and there is no contract test to catch the divergence.

- `exafyltd/vitana-platform:.kiro/specs/health-native/lanes/n5a-health-sync.md:1` — lane: n5a-health-sync
state: executing
next_actor: kiro
vtid: VTID-05184
depends_on: [phase1-data-core]
- `exafyltd/vitana-platform:.kiro/specs/health-native/handoff.md:45` — | `n5a-health-sync` | v1 #1398 (05184) | C1 merged; then re-vendor the contract from C1's merge commit and switch the N3/N4 stubs to the real modules |
- `exafyltd/vitana-platform:.kiro/specs/health-native/tasks.md:15` — ## d10-consents
<!-- lane: d10-consents -->
- [ ] Owner applies `20261012180000_vtid_05092_health_consent_categories.sql`
- [ ] Merge platform #4100 → vitana-v1 #1377 → vitana-v1 #1383

Suggestion: Before health-hub is executed, the plan must either: (a) extract the public read-only entry signature from N5a's PR #1398 branch (the branch is green, vitana-v1#1398 is open — the interface can be read even if the PR is not merged) and encode it as a TypeScript interface in the stub, plus add a contract test that imports both the stub and the real export through its module path and asserts structural compatibility; or (b) record in the lane log a concrete `next_actor: kiro` task that re-verifies stub-vs-real compatibility at the time N5a merges, with a CI step that will fail if the types diverge. Option (a) is strongly preferred given the owner-blocked timeline for N5a.

### R1-F6 [minor]

STATUS.md row 8 states 'Wave 0: Expo project, CI, parity ledger script, extraction dependency analysis | Native app | queued | — | macOS build minutes (EAS or GitHub)'. However, handoff.md (written 2026-10-15, the same date as the pinned commit context) explicitly states 'Native Wave 1 + 1b — the whole stack is on vitana-v1 main: N1 @vitana/core + @vitana/tokens (05183), N2 UI kit (05176), N3 shell + i18n keys (05186)'. STATUS.md row 8 was never updated to reflect Wave 0/1 completion. The tasks.md acceptance rule requires 'STATUS.md updated in the same PR as the work.' Each lane in this cluster must update STATUS.md; that update should also close row 8.

- `exafyltd/vitana-platform:docs/programs/health-hub/STATUS.md:23` — | 8 | Wave 0: Expo project, CI, parity ledger script, extraction dependency analysis | Native app | queued | — | macOS build minutes (EAS or GitHub) |
- `exafyltd/vitana-platform:.kiro/specs/health-native/handoff.md:33` — - **Native Wave 1 + 1b** — the whole stack is on vitana-v1 main:
  N1 `@vitana/core` + `@vitana/tokens` (05183, #1396), N2 UI kit (05176, #1395), N3 shell + i18n keys
  (05186, #1397 + #1400), N4-APP push/links/remote config (05178, #1390)…
- `exafyltd/vitana-platform:.kiro/specs/health-native/tasks.md:4` — Acceptance for every lane: its own PR checks green (incl. Lane scope), no writes to staging/production, STATUS.md
updated in the same PR, read-only `docs/validation/<VTID>/staging-tests.json` for anything that deploys.

Suggestion: The first merging lane (health-hub) should update STATUS.md row 8 to 'done' and add a new row covering this Wave 2 health cluster, consistent with the existing row format. This is a required acceptance criterion per tasks.md:5.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
