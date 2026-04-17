# Autopilot Earn Spec — Request to Track A1 (Reward Expansion)

**Context:** As of branch `claude/plan-token-economy-architecture-RiQZR`, `vitana-v1/src/pages/AutopilotDashboard.tsx` displays `+10 CREDITS` badges on completed recommendations. The badge was previously `+10 VTN`, which conflicted with the locked doctrine that VTNA is never minted by rewards. The copy change has shipped; the matching emitter has not.

**Ask:** Track A1 adds a REWARD_TABLE entry and emitter so the badge stops being purely aspirational.

---

## Proposed REWARD_TABLE entry

Add to `services/gateway/src/types/automations.ts` (the REWARD_TABLE block near line 168):

| Key | Amount | Trigger / OASIS event | Dedupe key |
|---|---|---|---|
| `autopilot_recommendation_completed` | 10 | `autopilot.recommendation.completed` (emitted when `product_orders`-like completion criteria are verified on a recommendation) | `autopilot_rec_${recommendation_id}` |

### Optional tier — journey-level bonus

If Track A1 wants to reinforce full-journey completion over per-task grinding, add a second entry:

| Key | Amount | Trigger | Dedupe key |
|---|---|---|---|
| `autopilot_journey_completed` | 100 | `autopilot.journey.completed` (emitted when all recommendations in a wave, or the 90-day journey, reach `status='completed'`) | `autopilot_journey_${wave_id}_${user_id}` |

Total ceiling per user for a standard 90-day journey with ~20 recommendations + 5 waves: 10×20 + 100×5 = ~700 CREDITS (~€140 loyalty). Bounded, not farmable.

---

## Verification requirements

`autopilot.recommendation.completed` should emit **only when**:

1. The recommendation record transitions from `status='activated'` → `status='completed'` via an authenticated server path.
2. For `action_type='navigate'` recommendations: completion requires a verifiable target event (e.g. the navigated-to flow emitting its own completion signal — diary entry saved, profile updated, voucher purchased). No self-declared completion.
3. For `action_type='notify'` recommendations: completion occurs only after an anti-abuse cool-down (proposal: minimum 4 hours between activation and completion for this class).
4. Deduplication via `source_event_id = autopilot_rec_${recommendation_id}` — unique constraint on `wallet_transactions.source_event_id` handles the rest.

---

## Proposed handler location

New file or extension in `services/gateway/src/services/automation-handlers/engagement-outcomes.ts` (Track A1 is already creating this file for live-room / message rewards). Add an `autopilot.recommendation.completed` subscriber.

Alternatively, if Track A1 prefers isolation, create `services/gateway/src/services/automation-handlers/autopilot-rewards.ts` (AP-1128 / AP-1129 slot).

---

## Frontend status

- `+10 CREDITS` badge: **shipped** on `claude/plan-token-economy-architecture-RiQZR` branch in vitana-v1.
- No further frontend change needed once the emitter lands — the badge already reflects the amount.
- When Track A1 expands REWARD_TABLE, consider centralising the badge amount (`<RewardBadge reward_key="autopilot_recommendation_completed" />`) so the UI promise stays in sync with the table — matches the `reward-calculator.ts` / `RewardBadge.tsx` approach used for marketplace products.

---

## Anti-abuse notes

- Completion must be verified server-side (no client-set completion).
- Do not reward on `status='activated'` — that would make activating + bouncing a farm path.
- Do not reward multiple times on re-activation of the same recommendation — `source_event_id` handles this.
- If recommendations are ever re-generated with the same `id`, the unique constraint will harmlessly block duplicate rewards.
- Refund/reversal: if a recommendation is marked completed in error and rolled back, emit a compensating debit with `source_event_id='autopilot_rec_${recommendation_id}_refund'` — matches the marketplace refund pattern.

---

## Sign-off

- Owner: Reward Expansion team (Track A1)
- Dependency: Autopilot backend route emitting `autopilot.recommendation.completed` (already exists for status transitions; confirm OASIS event emission is present or add it)
- Blocker-for: honest earn loop on Autopilot — users currently see `+10 CREDITS` but no CREDITS are actually written. Ship window: ideally within Phase 1 (Apr–May 2026).
