# Plan sparring record — VTID-05025 (Health Hub WP1 / D12)

- **Parent program:** VTID-05020 (Health Hub plan r7, §1 D12, §2b, §5 Phase 0).
- **Sparring session:** `plan_sparring_sessions.id = 476c94bc-0cde-47e2-ac22-c2b36352f7f1` (submitted with the round-1 hash; VTID allocated with `p_sparring_id`).
- **Partner:** `plan-sparring-partner` agent (read-only, independent; saw the plan and the code, not the planner's reasoning).
- **Change class:** standard. **Rounds:** 3. **Verdict:** CONVERGED.
- **Plan hashes** (sha256 of the text between the plan markers): round 1 `4d78122ef3d6346e28bb0c8bc01021dadd5e3076a0b31329c349cc51c20fc5fc`, round 2 `a6a2abe31455febe13b5653343ec83375390f3e039173d3abb47542976b68539`, **final `2d331491dcf216dde297f7b40930f2346a6bb3ca383a7b738cd082c06c9a6ba6`**.
- **Approval basis:** the owner's Gate 1 approval of the program plan ("Yes to both plans", 2026-10-10, recorded in `docs/validation/VTID-05020/plan-sparring.md`). This WP implements program item D12 exactly as approved; nothing outside the program plan was added.

## Round 1 — NOT CONVERGED

Premises: all five facts verified TRUE with `file:line`.

| # | Sev | Finding (partner) | Planner answer |
|---|-----|-------------------|----------------|
| F1 | major | `invalidateUserHealthContext()` breaks under a compound cache key (`CACHE.delete(user_id)` no longer matches). | **Accepted.** Two-level `Map<user_id, Map<optsKey, entry>>`; invalidation stays O(1); unit test with two option variants. |
| F2 | major | Boundary scan for `wearable_summary_7d` false-fails on the planned `: null` assignment, or misses regressions if too narrow. | **Accepted (variant).** context-pack-builder omits the field entirely; scan allows only the literal `wearable_summary_7d: null` initialiser (discover-feed guest context) via `/wearable_summary_7d(?!\s*:\s*null\b)/`, with negative fixtures. |
| F3 | minor | Default flip silently affects every non-opting caller; list the blast radius. | **Accepted.** Change 2 lists all nine callers. |
| F4 | minor | Hide-only test for `applyUserLimitations()` looks orthogonal to D12. | **Rejected** — program plan §2b / finding N1 puts the remove-only test inside D12: the boundary test names `limitations-filter.ts` as the single allowed exception, justified only if it provably only hides. Partner accepted in round 2. |
| F5 | minor | `gemini-operator.ts` marketplace search not listed as affected. | **Accepted.** Folded into Change 2. |
| F6 | info | Staging test is read-only — compliant. | No action. |

## Round 2 — CONVERGED

All findings closed; F4 rejection acknowledged as sound. No new findings.

## Round 3 — CONVERGED (planner-raised scope fix during implementation)

| # | Sev | Finding (planner, self-raised) | Partner verification |
|---|-----|-------------------------------|----------------------|
| P1 | major | Scanning all of `recommendation-engine/**` would fail on `analyzers/wearable-analyzer.ts`, which reads `wearable_rollup_7d` for **health-domain** nudges (`convertWearableSignal`: `domain: 'health'`, `source_type: 'wearable'`; not in `DEFAULT_CONFIG.sources`). Scope narrowed to `marketplace-analyzer*.ts`; added pins (no marketplace source type from wearable signals, no commerce import of the analyzer); stale header comment corrected. | **Verified.** No path from wearable recommendations into product picks (`economic-axis.ts` maps `wearable` → `none`; no commerce module reads `autopilot_recommendations`; `condition_product_mappings` read only by marketplace-analyzer and condition-matcher). Only `marketplace-analyzer*` is commerce inside the engine. |

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard (gateway service code + tests; no migration, no route, no auth change).
- **Scope:** `services/gateway/src/services/user-health-context.ts`, `services/gateway/src/services/context-pack-builder.ts`,
  new tests under `services/gateway/test/`.
- **Owner decision this implements (Gate 1, 2026-10-10):** device-derived health data never ranks or personalises
  commerce; the hide-only safety filter (`limitations-filter.ts`) stays; member-stated conditions keep today's behaviour
  (no change in this WP).

## Facts (origin/main 1c2bf0f52)
1. `inferPrimaryCondition()` (`user-health-context.ts` L409-433) returns `'insomnia'` when the 7-day wearable sleep average
   is < 360 min and `'low-hrv'` when HRV < 40 ms, after user-stated/active conditions and before calendar travel.
   Callers: `routes/discover-search.ts` L170, `recommendation-engine/analyzers/marketplace-analyzer.ts` L235,
   `shopping-agent/agent-core.ts` L295, and `gemini-operator.ts` (marketplace search tool, imported at L5968).
2. `GetUserHealthContextOpts.include_wearable` is documented "if false (default), skip wearable source" (L138), but the
   code loads the wearable rollup unless the caller passes `false` (`!== false`, L199 and L352). So every caller that does
   not opt out receives `wearable_summary_7d`: discover-search, discover-feed, marketplace-analyzer, the marketplace ORB
   tools (`marketplace-discovery-tools.ts` L662/L874, `marketplace-guide-tools.ts` L430,
   `marketplace-journey-tools.ts` L446). Only `health-depth-tools.ts` L741 passes `false`.
3. `context-pack-builder.ts` builds the ORB/chat `marketplaceContext` with `include_wearable: true` (L1122), copies
   `wearable_summary_7d` into it (L1150) and renders a "Wearable 7-day: sleep avg…, HRV…, resting HR…" line into the
   marketplace section of the prompt (L1646-1660).
4. The cache in `getUserHealthContext` is keyed by `user_id` only (L147-150), so a context built with wearable data can be
   served to any later caller within the TTL.
5. No caller outside commerce consumes `wearable_summary_7d` from this module (grep over `src/`, tests excluded).

## Changes
1. **Remove the wearable branch of `inferPrimaryCondition()`** and its doc line; precedence otherwise unchanged
   (user-stated → any active condition → calendar travel → null).
2. **Make the code match the documented default:** `include_wearable` becomes opt-in (`=== true`) at both L199 and L352.
   Intended blast radius: every caller that omits the option stops receiving wearable data. These are discover-search
   L166, discover-feed L115, shopping-agent L114/L241, marketplace-analyzer L234 (`{ bypass_cache: true }`),
   marketplace-discovery-tools L662/L874, marketplace-guide-tools L430, marketplace-journey-tools L446, and the
   gemini-operator marketplace search tool (dynamic import L5968). None of them read the field (Fact 5).
   health-depth-tools L741 already passes `false`, so nothing changes for it.
3. **context-pack-builder:** drop `include_wearable: true` (L1122) so the default applies. **Omit** `wearable_summary_7d`
   from the marketplace context instead of copying it (L1150). The field is optional in `types/conversation.ts` L317, so
   no type change is needed. Remove the "Wearable 7-day" prompt block (L1646-1660). After this change the file contains
   no `wearable_summary_7d` token at all.
4. **Cache safety:** make the cache two-level, `Map<user_id, Map<optsKey, CacheEntry>>`. `optsKey` encodes every
   include flag (e.g. `w0|c1|p1`), so a context loaded with different options is never served to another caller.
   `invalidateUserHealthContext(user_id)` stays an O(1) `CACHE.delete(user_id)` and drops every option variant.
   Unit test: populate the cache with two option combinations, invalidate, and assert both are reloaded (the repository
   mock's call count goes up for each). Its single caller, `routes/user-limitations.ts` L133, is unchanged.
5. **CI purpose-boundary test** (`test/vtid-<wp>-commerce-health-boundary.test.ts`):
   - source scan of the commerce modules (`recommendation-engine/analyzers/marketplace-analyzer*.ts`, `feed-ranker.ts`, `routes/discover-*.ts`,
     `shopping-agent/**`, `orb-tools/marketplace-*.ts`, the whole of `context-pack-builder.ts`): no
     `include_wearable: true`. Any `wearable_summary_7d` token is a failure, with one exception: the literal
     initialiser `wearable_summary_7d: null` (regex `/wearable_summary_7d(?!\s*:\s*null\b)/`). That exception exists
     because discover-feed L79 builds a guest `UserHealthContext`, whose field is required and nullable. The test carries
     negative fixtures proving the regex catches `wearable_summary_7d: hc.wearable_summary_7d` and
     `m.wearable_summary_7d`, and that it allows `wearable_summary_7d: null`. It also fails on references to the health tables
     `wearable_daily_metrics`, `wearable_rollup_7d`, `wearable_samples`, `health_features_daily`, `biomarker_results`,
     `lab_reports`; `limitations-filter.ts` named as the single allowed safety exception;
   - the recommendation engine is mixed health + commerce, so it is not scanned as a whole. `analyzers/wearable-analyzer.ts`
     (VTID-02100) legitimately reads `wearable_rollup_7d` for **health-domain** wellness nudges
     (`convertWearableSignal`: `domain: 'health'`, `source_type: 'wearable'`; it is not in `DEFAULT_CONFIG.sources`).
     Its header comment mentions converting the signals to marketplace picks downstream, but that was never built.
     The test pins this: `convertWearableSignal` never emits `source_type: 'marketplace'` or a commerce domain, and no
     commerce module imports `wearable-analyzer`. The stale header comment is corrected so that it no longer describes a
     marketplace conversion;
   - unit: `inferPrimaryCondition()` returns null for a context with only low sleep / low HRV wearable data;
   - unit: `getUserHealthContext()` does not query the wearable rollup unless `include_wearable === true` (repository mocked).
6. **Hide-only test for `applyUserLimitations()`.** This is part of D12 by the approved program plan (§2b, round-2
   finding N1): the boundary test names `limitations-filter.ts` as the single allowed exception, and the exception is
   only justified if the module is remove-only. The test makes that a CI fact: for generated product lists and contexts, the allowed output is a
   subsequence of the input (never adds, never reorders).

## Not in scope
- Member-stated condition personalisation in `feed-ranker.ts`/search (owner decision 2 default: unchanged).
- Any other Phase 0 defect (D1–D11) — own WPs.

## Verification
- `npm run build` (tsc) and the gateway Jest suites for user-health-context, limitations-filter, shopping-agent,
  marketplace-analyzer, discover-search, context-pack-builder, plus the new tests. No runtime test against any
  environment is needed: behaviour is fully determined in unit tests; staging verification is read-only
  (`staging-tests.json`: discover-feed and discover-search return 200 for a signed-in test user; no write).
- Deploys gateway → staging; Gate 2 when STAGING-VERIFY passes.

<!-- plan:end -->
