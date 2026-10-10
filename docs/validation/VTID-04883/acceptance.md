# VTID-04883 — Jev community ranking decisions D1–D3, D5–D8 in shadow (staging only)

Owner instruction 2026-10-04: "build 1–3 next, each as its own PR, in shadow on staging only." Item 3 =
docs/JEV-INTEGRATION-PLAN.md §10.4 D. Plan sparred (2 rounds, converged) and owner-approved 2026-10-05 —
`plan-sparring.md`. Required sequencing met: the rule-45 exclusion fix (VTID-04888) merged first (2cc33a17) and its
database part was applied and verified 2026-10-07, so no shadow row ranks test/service accounts.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Seven decisions — six `choice` decisions over the fixed slots `c1`…`c8` (D1 `community_calendar_priority`, D2
`community_next_action`, D3 `community_match_rerank`, D5 `community_suggestion_pick`, D7 `community_feed_pick`, D8
`community_member_tiebreak`) and D6 `community_notification_worth` (`noul`) — all `data: 'member_content'`,
`community_class: 'B'`, `pii: 'redact'`, planes internal + system_autopilot; inputs accept at most 8 flat candidates.
  TEST: services/gateway/test/vtid-04883-community-ranking.test.ts
AC-2: A gate runs only when its `JEV_COMMUNITY_<GATE>_MODE` is shadow (enforce has no path), `JEV_COMMUNITY_ENABLED` is
true, and a tenant and a member are known; otherwise no Jev call and no row.
  TEST: services/gateway/test/vtid-04883-community-ranking.test.ts
AC-3: One Jev call per request, as a system_autopilot caller with `member_id`, so the Class B per-member quota counts
the member (VTID-04872) and the community rate share applies (VTID-04874).
  TEST: services/gateway/test/vtid-04883-community-ranking.test.ts
AC-4: Candidates go in the existing order, cut at 8 (`truncated` recorded); agreement = Jev's slot equals the existing
top-1 (D2: the composer's chosen source; none chosen → not counted); a slot beyond the list is not counted.
  TEST: services/gateway/test/vtid-04883-community-ranking.test.ts
AC-5: State is derived in code: no names, titles or notification text (D3 sends fit components and a title length
band; D8 sends same-city/country flags and tenure; D6 sends type/category/priority/channel/pushed); no health values.
D8 sends the member's own search (≤120 chars, PII-redacted), like the Class A utterance decisions.
  TEST: services/gateway/test/vtid-04883-community-ranking.test.ts
AC-6: D6 and D7 are sampled by `JEV_COMMUNITY_<GATE>_SAMPLE` (default 0.1), deterministically by subject (D6: the
inserted notification id); 0 and 1 are absolute; D7 skips guests.
  TEST: services/gateway/test/vtid-04883-community-ranking.test.ts
AC-7: Every call site is fire-and-forget with its own `.catch`, placed after the existing result is final: D1 after the
PATCHes (tenant looked up only when the gate is on), D2 after `rank()`, D3 after the exact-name short-circuit and
skipped when it chose, D5 after the ranked order is applied, D6 after the insert and push right before the unchanged
`return`, D7 after `rankFeedProducts`, D8 only on the two query-hash fallbacks. A gate never throws. The real
composer returns the identical decision with the D2 shadow resolving, hanging forever or rejecting.
  TEST: services/gateway/test/vtid-04883-community-ranking.test.ts
  TEST: services/gateway/test/services/assistant-continuation/providers/next-action/vtid-04883-decide-next-action-shadow.test.ts
AC-8: Seven modes plus the two sample rates are pinned in `AWS-STAGE-DEPLOY-GATEWAY.yml` only; production sets none;
nothing opens the member plane; the Jev pin step stays under 20,000 characters.
  TEST: services/gateway/test/vtid-04883-community-ranking.test.ts
AC-9: Jev, operator, roles and support suites stay green; the full gateway suite passes.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
  TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/gates/community-ranking-gates.ts (new)
- services/gateway/src/services/jev/jev-decisions.ts (seven decisions)
- services/gateway/src/services/calendar-prioritizer.ts (D1), services/gateway/src/services/assistant-continuation/providers/next-action/composer.ts (D2), services/gateway/src/services/intent-find-match.ts (D3), services/gateway/src/services/recommendation-engine/recommendation-generator.ts (D5), services/gateway/src/services/notification-service.ts (D6), services/gateway/src/routes/discover-feed.ts (D7), services/gateway/src/services/voice-tools/community-member-ranker.ts (D8)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml (staging shadow pins), services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04883-community-ranking.test.ts (new), services/gateway/test/services/assistant-continuation/providers/next-action/vtid-04883-decide-next-action-shadow.test.ts (new, conversation-flow test for the composer)
- DATABASE_SCHEMA.md, docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04883/**

## OASIS

OASIS_IMPACT: no — no new topic. Each gate's Jev call emits the existing `jev.decision.*` event (source
`gate:community_*`), which only happens once the member plane is open on staging.

## Not in this PR

Enforce (Jev reordering a member-visible list) is a later, per-gate plan after shadow data. D4 moved to Bedrock instead
(VTID-04889). All News stays client-side. D1's calendar loop has no leader lock (~18 runs/day instead of 4) — its own
fix; until then D1 volume is ≈72 calls/day, inside the quota.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with the seven shadow pins. `JEV_COMMUNITY_ENABLED` stays unset, so every gate
returns before any Jev call: no member data leaves, no spend, no rows. Production unchanged.
