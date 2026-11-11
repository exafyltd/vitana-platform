# Sparring round 1 — in_progress

Session: `89e98eb8-922e-4c04-8de2-6bf56dbcd74b` · plan hash `260a589d0756472d0d39a99b98055c12b871a5aa398902938edf9321a485da16`

## Summary

This is a well-constructed plan. I verified 12+ premises against the codebase and all hold. The plan correctly identifies the key traps (priority-scale inversion, `unavailable` default parameter, `completions.get(t) === false` strict equality, `now` scope issue in `build()`, test breakage paths, `Promise.allSettled` error contract) and prescribes concrete mitigations for each. The architecture reuses the existing companion engine correctly — bulk reads follow the `fetchMemberSignals` pattern, moment selection slots into `pickMoment` cleanly, and the priority band (29–39) is properly below all health/habit moments. I found no blockers, no major issues, and only one minor unverifiable premise about the client rendering layer.

## Findings

### R1-F1 [minor]

The plan claims "vitana-v1 MessageBubble.tsx (renders the card; no vitana-v1 change)" under Reused Unchanged, but the vitana-v1 repo is not pinned in this session and I cannot verify that the MessageBubble component already handles E-series card types. The existing shipped moments send F-series card types (F1–F4, F7, F8). If the MessageBubble has a hardcoded allowlist of F-series types rather than a generic lookup from the Unified Card System catalog, enrichment card DMs would render incorrectly or show no card.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/delivery.ts:68` — export function buildCompanionMetadata(input: Pick<DeliveryInput, 'momentKey' | 'cardType' | 'facts'>): Record<string, unknown> {
  return {
    source: 'companion',
    moment_key: input.momentKey,
    vtid: DELIVERY_VTID,
    ...(input.cardType
      ? { card: { kind: 'vitana_card', v: 1, card_type: input.cardType, params: cardParams(input.facts) } }
      : {}),
  };
}

Suggestion: Before implementation, verify in vitana-v1 that the messenger's card rendering component already supports E-series card types from the Unified Card System catalog. If it uses a static allowlist, a small vitana-v1 change should be added to the scope.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
