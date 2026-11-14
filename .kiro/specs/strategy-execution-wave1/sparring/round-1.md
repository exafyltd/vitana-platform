# Sparring round 1 — in_progress

Session: `eb2d098e-9b2e-4f81-b61f-9517f4986e04` · plan hash `490f3aeb0747fbfd0226af128cc9685c438ff242adf6fdb5435174fa2e597f32`

## Summary

This is a well-scoped discovery-and-documentation plan with one product text change (Lane 8, mental health label in vitana-v1 i18n). Most premises I verified hold against the pinned code. The plan is careful to separate discovery outputs (Markdown docs) from code changes, and correctly declares what is and isn't authorised. I found one major gap related to the owner's fifth-pillar instruction, one major gap on repo pinning for Lane 8, and one minor finding.

## Findings

### R1-F1 [major]

The owner's instruction says 'The app must explicitly identify the fifth pillar as Mental Health, not merely Mental.' Lane 8 addresses only vitana-v1 i18n JSON files, but the platform's `pillarLabel()` function (`vitana-pillars.ts:30-32`) — self-documented as 'Human-facing label for voice/UI' — returns the raw key 'mental' (not 'mental health'). The search results show this function is referenced from voice-tool and assistant-continuation code paths (`community-member-ranker.ts`, `login-briefing.ts`). The plan does not change `pillarLabel()`, does not document it as a known gap, and no discovery lane is explicitly tasked with flagging it as a proposed follow-up. The owner's instruction may not be fully satisfied.

- `exafyltd/vitana-platform:services/gateway/src/lib/vitana-pillars.ts:29` — /** Human-facing label for voice/UI. Keep lowercase; callers Title-Case. */
export function pillarLabel(p: PillarKey): string {
  return p;
}
- `exafyltd/vitana-platform:services/gateway/src/lib/vitana-pillars.ts:20` — /** Canonical pillar order. Any display/emit should iterate this. */
export const PILLAR_KEYS: readonly PillarKey[] = [
  'nutrition',
  'hydration',
  'exercise',
  'sleep',
  'mental',
] as const;

Suggestion: Either (a) extend Lane 8 to also update `pillarLabel()` in vitana-platform to return 'mental health' for the `mental` key (this is a code change, so it needs its own test and STAGING-VERIFY), or (b) explicitly task one of the discovery lanes (most naturally `ch-discovery` or `autonomy-risks`) with documenting `pillarLabel()` and every call site as a proposed follow-up item, so the owner knows the i18n change alone does not fully satisfy the instruction.

### R1-F2 [major]

The plan pins vitana-platform at commit 6dc6e1ba but does not pin vitana-v1 at any commit. Lane 8 is the only lane that changes code (vitana-v1 i18n files) and the plan cites specific file:line references in vitana-v1 (e.g. `src/i18n/en/health.json:42`, `vitanaIndex.json:15`, `newsCard.json:38`, `healthNative.json:292`, `screens.json:861,3401,4888,9585`, `vcal.json:52`). Without a pinned commit, those line references are unverifiable and may be stale by implementation time. Discovery lanes (Lane 7 destination-identity) also cite vitana-v1 paths. The plan's own test strategy ('every file:line in the doc resolves on origin/main') applies to discovery docs but doesn't protect Lane 8's implementation correctness against a moving HEAD.

- `exafyltd/vitana-platform:services/gateway/src/lib/vitana-pillars.ts:1` — /**
 * Vitana Index — single source of truth for the 5 canonical pillars, the
 * tier ladder, balance labels, and Book-of-the-Index chapter paths.
 *
 * The Index is defined over EXACTLY five pillars:
 *   nutrition, hydration, exercise, sleep, mental

Suggestion: Pin the vitana-v1 repo to a specific commit hash in the plan header (same pattern as vitana-platform). The Lane 8 implementation should verify its file:line citations against that pin before making changes, and the test (`pillar-mental-health-label.test.ts`) should be written against the pinned state.

### R1-F3 [minor]

The plan's §2 self-healing rollback description says 'rollback "completed" without a rollback `:363-472`'. This is accurate — the function emits `self-healing.rollback.completed` (line 462) even though no actual rollback occurs (the message at line 465 says 'Actual revision shift is async via EXEC-DEPLOY'). However, the plan's `autonomy-risks` lane (Lane 3) lists this as a finding to document but doesn't mention that the OASIS event type `self-healing.rollback.completed` is semantically misleading (it's more of a 'rollback_requested' confirmation). If the autonomy-risk register is to be actionable, the event type mismatch should be an explicit entry.

- `exafyltd/vitana-platform:services/gateway/src/services/self-healing-snapshot-service.ts:460` —   await emitOasisEvent({
    vtid,
    type: 'self-healing.rollback.completed',
    source: 'self-healing-snapshot-service',
    status: 'info',
    message: `Rollback request recorded for VTID ${vtid}. Actual revision shift is async via EXEC-DEPLOY.`,
    payload: {
      pre_fix_snapshot_id: preFixSnapshot.id,
      target_revision: preFixSnapshot.cloud_run_revision,
    },
    actor_role: 'system',
    surface: 'system',
  });
}

Suggestion: Ensure the autonomy-risk register (Lane 3 output) explicitly calls out the semantic gap between the event type `self-healing.rollback.completed` and the actual behaviour (no rollback performed), so the follow-up plan can address the event type as well as the missing rollback mechanism.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
