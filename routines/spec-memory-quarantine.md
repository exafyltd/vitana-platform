# Routine: spec-memory-quarantine

**Schedule:** `0 11 * * *` (daily 11:00 UTC)
**Catalog row:** `routines.name = 'spec-memory-quarantine'`
**OASIS VTID for emitted events:** `VTID-02018`

## Autonomy contract

Reads `voice_healing_shadow_log` for `outcome=quarantined` entries via the gateway audit endpoint. Emits an OASIS event when quarantine grows >50% week-over-week or oldest entry exceeds 14 days. **No briefs.**

This complements `self-healing-triage` (which clears the human-approval queue) by making sure the spec-quarantine bucket doesn't silently accumulate.

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Quarantine count stable AND oldest within 14 days. |
| 🟡 `partial` | Growing or stale → OASIS event emitted. |
| 🔴 `failure` | Audit endpoint unreachable. |

## Steps

1. `POST $GATEWAY_URL/api/v1/routines/spec-memory-quarantine/runs` (X-Routine-Token).
2. `GET $GATEWAY_URL/api/v1/routines/audits/spec-memory-quarantine` → `{ feature_pending, total_shadow_log, quarantined_now, quarantined_recent_7d, sample_oldest[] }`.
3. If `feature_pending === true`: PATCH `success`, summary `"✅ voice_healing_shadow_log not yet present — feature pending"`. STOP.
4. Threshold:
   - `breach_kinds = []`
   - `oldest = sample_oldest[0]?.created_at`. If `oldest` exists AND `(now - oldest) > 14 days`: `breach_kinds.push('quarantine_aged')`.
   - If `quarantined_recent_7d > 0 && quarantined_now > quarantined_recent_7d * 1.5`: `breach_kinds.push('quarantine_growing')`.
5. If `breach_kinds.length > 0`: `POST /api/v1/events/ingest` topic `voice_healing.quarantine.degraded`, vtid `VTID-02018`, payload `{ quarantined_now, quarantined_recent_7d, oldest, sample_oldest, breach_kinds }`.
6. PATCH:
   - No breach: `success`, `"✅ Spec memory gate healthy: {quarantined_now} quarantined, oldest within 14d"`.
   - Breach: `partial`, `"⚠️ Spec memory gate: {breach_kinds}. OASIS event emitted, self-healing notified."`.

## Hard rules
- Plain `curl`. Wall-clock cap 1 minute. No briefs.
