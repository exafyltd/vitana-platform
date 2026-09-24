# VTID-04454 — The relevance score chooses the voice opening

VTID: VTID-04454
VALIDATION_PROFILE: gateway_backend

## Why

VTID-04422 scored every opening candidate with a weighted formula. VTID-04435 then gave each user their own copy of the weights. Both were only recorded. The fixed provider priority still picked what Vitana opened with.

The owner asked to switch to the scored ranking (2026-09-24).

## Change

- **New module `services/conversation/scored-opening.ts`** (pure):
  - `isScoredOpeningEnabled` turns the switch on only for the exact value `BRAIN_SCORED_OPENING=true`.
  - `scoredOpeningTimeoutMs` reads `BRAIN_SCORED_OPENING_TIMEOUT_MS`: 400 ms by default, clamped to 100–1500 ms.
  - `SCORED_OPENING_PINNED_PROVIDERS` lists the providers that keep the fixed ranking: `first_time_welcome` and `guided_topic_narration`.
  - `applyScoredOpening(decision, ranking)` returns a new decision whose `selectedContinuation` is the scored winner. It never mutates the fixed decision. It returns one of three modes:

    | Mode | When |
    |---|---|
    | `scored` | The score chose the opening. |
    | `fixed_pinned` | A pinned provider returned a candidate. |
    | `fixed_fallback` | No ranking, no candidate, or the scored winner was not returned. |
  - `withinBound(work, ms)` resolves to `null` when the scoring times out or fails. It never rejects.
- **`wake-brief-wiring.ts`**:
  - With the flag on, and when the opening is not an explicit selection, the candidates are scored in front of the choice, inside the time bound. The weights are the user's own when `BRAIN_PERSONAL_WEIGHTS=true` and enough evidence exists; otherwise the shared row.
  - Everything downstream uses the served decision: `wake_brief_selected`, `recent_openers`, the pending offer, and the stored turn candidates.
  - `continuation_shadow_ranked` records:
    - the fixed winner (`live_winner`) and the scored winner (`shadow_winner`);
    - `served_winner` and `ranking_mode`;
    - `ranking_reason`, when the fixed decision was kept.
  - With the flag off, behaviour is byte-for-byte as before: fixed ranking, with shadow scoring after the fact and off the path.
- **Comparison and inspector**:
  - `summarizeShadowComparisons` reports `scored_openings` and `scored_changed_opening`.
  - The brain inspector shows `ranking_mode` and `served_winner`.
- **Replay (VTID-04443)**:
  - A case can set `scored_opening_live`.
  - The transcript carries `ranking_mode`.
  - Two new cases:
    - `scored-opening-serves-relevant`: the journey step outranks the declined briefing.
    - `scored-opening-pinned-welcome`: the welcome keeps the opening although the score prefers the briefing.

  The 9 existing snapshots changed only by `"ranking_mode": "fixed"`; no replayed decision moved.
- **Flag**: `BRAIN_SCORED_OPENING=true` is pinned on `AWS-STAGE-DEPLOY-GATEWAY.yml` only (strip-then-add). It is not on the production workflow; production follows only when the owner decides.

## Acceptance

| AC | Check | Evidence |
|---|---|---|
| AC-1 | Only an exact `true` enables; the time bound is clamped | TEST: services/gateway/test/services/conversation/vtid-04454-scored-opening.test.ts (flag and bound) |
| AC-2 | The scored winner is served without mutating the fixed decision; agreement returns the same decision | TEST: services/gateway/test/services/conversation/vtid-04454-scored-opening.test.ts (applyScoredOpening) |
| AC-3 | A pinned provider, a missing ranking or candidate, or an unreturned scored winner keeps the fixed decision | TEST: services/gateway/test/services/conversation/vtid-04454-scored-opening.test.ts (applyScoredOpening) |
| AC-4 | Wake path: flag off → fixed; flag on → scored winner served and recorded; explicit selection → not scored; pinned → fixed; scoring past its bound → fixed | TEST: services/gateway/test/services/conversation/vtid-04454-scored-opening.test.ts (decideWakeBriefForSession) |
| AC-5 | The comparison counts the openings the score chose and changed | TEST: services/gateway/test/services/conversation/vtid-04454-scored-opening.test.ts (comparison summary) |
| AC-6 | Replay: the new cases meet their expectations; existing snapshots only gain `ranking_mode: "fixed"` | TEST: services/gateway/test/services/conversation/vtid-04443-conversation-replay.test.ts |
| AC-7 | Pinned on staging, absent from production | TEST: services/gateway/test/services/conversation/vtid-04454-scored-opening.test.ts (deploy pins) |
| AC-8 | The flag-off shadow pass is unchanged | TEST: services/gateway/test/services/conversation/vtid-04422-candidate-scoring.test.ts |
| AC-9 | Live: a staging session records `ranking_mode: "scored"` in `continuation_shadow_ranked` | **Not run.** Staging ECS cannot place tasks (AWS account block). |

## Not changed

- The provider priorities.
- The fixed ranker itself (`decideContinuation`).
- The weights row.
- The production deploy workflow.
