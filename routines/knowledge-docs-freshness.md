# Routine: knowledge-docs-freshness

**Schedule:** `0 9 * * *` (daily 09:00 UTC)
**Catalog row:** `routines.name = 'knowledge-docs-freshness'`
**OASIS VTID for emitted events:** `VTID-02018`

## Autonomy contract

Daily sweep of `knowledge_docs` for entries older than 180 days. Emits an OASIS event when stale-doc count crosses threshold so the existing docs-curation flow picks them up. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Stale-doc count below threshold OR feature pending. |
| 🟡 `partial` | Stale count above threshold → OASIS event emitted. |
| 🔴 `failure` | Audit endpoint unreachable. |

## Steps

1. `POST $GATEWAY_URL/api/v1/routines/knowledge-docs-freshness/runs` (X-Routine-Token).
2. `GET $GATEWAY_URL/api/v1/routines/audits/knowledge-docs-staleness?stale_after_days=180` → `{ feature_pending, total_docs, stale_count, sample_stalest[] }`.
3. If `feature_pending === true`: PATCH `success`, summary `"✅ knowledge_docs table not yet present — feature pending"`. STOP.
4. Threshold: `breach = stale_count > Math.max(20, total_docs * 0.10)`.
5. If breach: `POST /api/v1/events/ingest` with topic `docs.staleness.detected`, vtid `VTID-02018`, payload `{ total_docs, stale_count, sample_stalest }`.
6. PATCH:
   - No breach: `success`, `"✅ Knowledge docs healthy: {stale_count}/{total_docs} stale"`.
   - Breach: `partial`, `"⚠️ {stale_count} stale knowledge docs (>{threshold}). OASIS event emitted, self-healing notified."`.
   - Audit endpoint down: `failure`.

## Hard rules
- Plain `curl`. Wall-clock cap 1 minute. No briefs.
