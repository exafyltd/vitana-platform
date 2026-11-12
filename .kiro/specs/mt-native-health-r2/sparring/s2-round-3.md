# Sparring round 3 — converged

Session: `5e927bc9-b53f-44fe-8949-d8aee8d1a817` · plan hash `9e9908b2fe84b8c805f6a0cabe4a8fe72c3856e5cd89f58f352b7e8ce7afe418`

## Summary

Round 3 review. The planner's acceptance of R2-F1 is properly implemented: a new `health-writers-voice-orb` lane covers both `voice-tools/health-log-repository.ts` and `orb-tools/health-depth-tools-repository.ts` with explicit function listings, the zero-UUID fallback is removed behind `MT_RESOLUTION_V2`, and additional writers are tracked in the deferred `health-writers-long-tail` inventory. Premises about the deferred writers (`wearable-features-bridge-repository.ts:51`, `connector-webhooks-repository.ts:38`, `action-executors-repository.ts:23`, `partner-health/ingestion.ts`) and the push/notification premises all verified. One minor new finding regarding an unclassified health-table writer function in both repositories.

## Findings

### R3-F1 [minor]

Both `voice-tools/health-log-repository.ts:61-74` and `orb-tools/health-depth-tools-repository.ts:62-75` export `computeVitanaIndexForUser` which delegates to `recordIndexRecompute` from `../vitana-index/record-recompute`. This function likely writes to `vitana_index_scores` (a health table matching the `vitana_index_*` forbidden-set pattern). The plan's `health-writers-voice-orb` lane explicitly lists 3 functions from the voice repo and 8 from the orb repo, but omits `computeVitanaIndexForUser` from both. The function takes an admin `SupabaseClient` and `userId`/`date` (no tenant parameter), so it may resolve tenant internally or be user-keyed, but it is not classified in the inventory.

- `exafyltd/vitana-platform:services/gateway/src/services/voice-tools/health-log-repository.ts:60` — /** VTID-05168: locked + recorded recompute (see services/vitana-index/record-recompute.ts). */
export async function computeVitanaIndexForUser(
  sb: SupabaseClient,
  userId: string,
  date: string,
  source: { trigger?: IndexRecomputeTrigger; sourceKind?: string | null; sourceRef?: string | null } = {},
) {
  return recordIndexRecompute(sb, {
    userId,
    date: date,
    trigger: source.trigger ?? 'voice_log',
    sourceKind: source.sourceKind ?? null,
    sourceRef: source.sourceRef ?? null,
  });
}
- `exafyltd/vitana-platform:services/gateway/src/services/orb-tools/health-depth-tools-repository.ts:61` — /** VTID-05168: locked + recorded recompute (see services/vitana-index/record-recompute.ts). */
export async function computeVitanaIndexForUser(
  sb: SupabaseClient,
  userId: string,
  date: string,
  source: { trigger?: IndexRecomputeTrigger; sourceKind?: string | null; sourceRef?: string | null } = {},
) {
  return recordIndexRecompute(sb, {
    userId,
    date: date,
    trigger: source.trigger ?? 'voice_log',
    sourceKind: source.sourceKind ?? null,
    sourceRef: source.sourceRef ?? null,
  });
}

Suggestion: Add `computeVitanaIndexForUser` from both repositories to the health-writers-voice-orb inventory with an explicit (a), (b) or (c) classification. If `recordIndexRecompute`'s underlying write to `vitana_index_scores` resolves tenant internally (e.g. via an SQL SECURITY DEFINER function that doesn't use a session tenant), classify it (b) or (c) with the justification. If it inherits the admin client's context or resolves tenant via user_tenants, it needs the same healthDb conversion as the other listed functions.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Properly addressed. The new health-writers-voice-orb lane covers both repositories with explicit function listings, removes the zero-UUID fallback behind MT_RESOLUTION_V2, ensures the flag flips only after both lanes merge, and defers the remaining writers to health-writers-long-tail with a pinned inventory list that can only shrink. The separation into a distinct lane is sensible for keeping PRs small.
