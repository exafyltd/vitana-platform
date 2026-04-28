# Routine: dyk-tour-progress

**Schedule:** `30 10 * * *` (daily 10:30 UTC)
**Catalog row:** `routines.name = 'dyk-tour-progress'`
**OASIS VTID for emitted events:** `VTID-02018`

## Autonomy contract

Daily snapshot of `dyk_user_active_days` distribution to track user progress through the 30-day Did You Know tour. Emits an OASIS event when no users have advanced past day 14 — signal that the tour is stuck. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | At least one user past day 14, distribution looks healthy. |
| 🟡 `partial` | No users past day 14 → OASIS event emitted. |
| 🔴 `failure` | Audit endpoint unreachable. |

## Steps

1. `POST $GATEWAY_URL/api/v1/routines/dyk-tour-progress/runs` (X-Routine-Token).
2. `GET $GATEWAY_URL/api/v1/routines/audits/dyk-tour-progress` → `{ feature_pending, total_tracked, day_distribution: { "<n>": <count> }, max_day_seen }`.
3. If `feature_pending === true`: PATCH `success`, summary `"✅ dyk_user_active_days not yet present — feature pending"`. STOP.
4. If `total_tracked === 0`: PATCH `success`, summary `"✅ No DYK tour users yet — nothing to triage"`. STOP.
5. Threshold: `breach = max_day_seen < 14 && total_tracked > 5` (a few real users but nobody past mid-tour).
6. If breach: `POST /api/v1/events/ingest` topic `dyk.tour.coverage_drop`, vtid `VTID-02018`, payload `{ total_tracked, max_day_seen, day_distribution }`.
7. PATCH:
   - No breach: `success`, `"✅ DYK tour healthy: {total_tracked} users tracked, max day {max_day_seen}"`.
   - Breach: `partial`, `"⚠️ DYK tour stuck: {total_tracked} users, max day {max_day_seen}. OASIS event emitted, self-healing notified."`.

## Hard rules
- Plain `curl`. Wall-clock cap 1 minute. No briefs.
