# VTID-04435 — Conversation rebuild WS-4.3: outcomes feed per-user scoring weights

This is Plan v1 (Conversation Intelligence Rebuild), Phase 4, workstream WS-4.3. It ships in PR #3614 as a companion to VTID-04339.

## Why

The relevance score (WS-2.2, VTID-04422) uses one set of weights for everyone. Its outcome feature reads each user's acceptance rate per provider, but how much that feature *counts* was the same for every user:
- A user whose history clearly separates the suggestions they take from the ones they don't got the same weight as a user whose history is flat.
- A user who ignores most suggestions (repetition fatigue) got no extra push toward fresh ones.

## Change (`services/conversation/personal-weights.ts`)

`personalizeWeights(shared, outcomes)` returns this user's copy of the shared weights. It changes two weights only, each within a fixed band.

| Weight | Band | Rule |
|---|---|---|
| outcome | ×0.5 to ×2.0 | `1 + confidence × (2 × spread − 0.5)`. `spread` is the gap between the user's best and worst smoothed per-provider acceptance rate (providers with at least 2 settled offers). A spread of 0.25 is neutral: wider raises the weight, flatter lowers it. With only one measurable provider, the weight is unchanged. |
| freshness | ×1.0 to ×1.5 | Rises linearly as the user's ignored share goes from 30% to 80%. |

- **Evidence:** nothing changes below 5 settled offers. `confidence` grows linearly to 1 at 30 settled offers.
- **Everything else stays:** the other weights, the version and the time-of-day table are unchanged. The shared weights object is never mutated.
- **Input:** `loadUserOutcomes` now keeps the declined and ignored counts next to accepted and settled.

### Where it is used

- **Shadow ranking (every non-explicit opening):** always uses the personal copy. `continuation_shadow_ranked` records the `personal` adjustment and `shadow_winner_shared_weights`, so the effect is visible per session. It is still shadow mode, so nothing spoken changes.
- **Live `get_next_best_action` re-ranking (WS-2.3):** uses the personal copy only with `BRAIN_PERSONAL_WEIGHTS=true`. That is pinned on `AWS-STAGE-DEPLOY-GATEWAY.yml` only; production keeps the shared weights.

### Command Hub

- **Monitor → Ranking:** a Personal weights tile shows how many openings were scored with personal weights and how often that changed the shadow pick.
- **Brain inspector:** shows the session's adjustment (evidence, multipliers) and which provider the shared weights would have picked.
- `?v=` is bumped, and the guard allowlist and symbol index are updated.

## Acceptance

AC-1: The live re-ranking uses personal weights only with the exact flag. The flag is pinned on staging only.
TEST: services/gateway/test/services/conversation/vtid-04435-personal-weights.test.ts

AC-2: Nothing changes below the minimum evidence. The adjustment grows with evidence and never leaves its bands (checked on 200 seeded random histories).
TEST: services/gateway/test/services/conversation/vtid-04435-personal-weights.test.ts

AC-3: The outcome weight rises for a separated history, falls for a flat one, and is unchanged with one measurable provider. Freshness rises for a user who ignores most offers.
TEST: services/gateway/test/services/conversation/vtid-04435-personal-weights.test.ts

AC-4: Only the outcome and freshness weights change, and the shared weights are never mutated. A user whose history favours a lower-priority provider gets a different shadow pick.
TEST: services/gateway/test/services/conversation/vtid-04435-personal-weights.test.ts

AC-5: The shadow ranking records the adjustment and the shared-weights winner. The live re-ranking uses the personal copy only behind the flag. `loadUserOutcomes` keeps declined and ignored counts.
TEST: services/gateway/test/services/conversation/vtid-04435-personal-weights.test.ts

AC-6: Monitor counts personalised openings and changed picks, and the inspector shows the session's adjustment. Both were verified at 1400×900 and 390×844 (`outputs/`).
TEST: services/gateway/test/services/conversation/vtid-04435-personal-weights.test.ts

AC-7 (post-deploy, staging): shadow events carry `personal` for users with 5 or more settled offers, and the Monitor tile counts them.
BLOCKED: staging ECS cannot place tasks (AWS account block). Also, few users have 5 or more settled offers yet, since `conversation_offer_outcomes` has been live since 2026-09-23.
