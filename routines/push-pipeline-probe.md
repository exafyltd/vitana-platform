# Routine: push-pipeline-probe

**Schedule:** `30 9 * * *` (daily 09:30 UTC)
**Catalog row:** `routines.name = 'push-pipeline-probe'`
**OASIS VTID for emitted events:** `VTID-02018`

## Autonomy contract

Daily probe of the push notification stack: external Appilix API reachability + token counts via the gateway audit endpoint. Emits an OASIS event on any breach. **No briefs.**

Background: Appilix push API has been down (522) since March 2026 per memory. This routine watches for recovery and for FCM regressions.

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Appilix reachable AND mobile-token count steady or growing. |
| 🟡 `partial` | Appilix down OR mobile tokens collapsing → OASIS event emitted. |
| 🔴 `failure` | Audit endpoint unreachable. |

## Steps

1. `POST $GATEWAY_URL/api/v1/routines/push-pipeline-probe/runs` (X-Routine-Token).
2. **Appilix reachability** — `curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://appilix.com/api/push-notification`. Capture `appilix_http_code`. If non-2xx (anything not 200/201/202), Appilix is still down.
3. **Token counts** — `GET $GATEWAY_URL/api/v1/routines/audits/push-pipeline` → `{ feature_pending, total_tokens, web_tokens, mobile_tokens, new_tokens_last_24h }`.
4. If `feature_pending === true`: PATCH `success`, summary `"✅ user_device_tokens not yet present — feature pending"`. STOP.
5. Threshold:
   - `breach_kinds = []`
   - if `appilix_http_code` not in {200,201,202}: `breach_kinds.push('appilix_down_' + appilix_http_code)`
   - if `total_tokens > 0 && new_tokens_last_24h === 0 && total_tokens > 100`: `breach_kinds.push('no_new_tokens_24h')`
6. If `breach_kinds.length > 0`: `POST /api/v1/events/ingest` topic `push.pipeline.degraded`, vtid `VTID-02018`, payload `{ appilix_http_code, web_tokens, mobile_tokens, new_tokens_last_24h, breach_kinds }`.
7. PATCH:
   - No breach: `success`, `"✅ Push pipeline healthy: Appilix {appilix_http_code}, {mobile_tokens} mobile + {web_tokens} web tokens"`.
   - Breach: `partial`, `"⚠️ Push breach: {breach_kinds}. OASIS event emitted, self-healing notified."`.

## Hard rules
- Plain `curl`. Wall-clock cap 1 minute. No briefs.
- Treat the Appilix HTTP probe as best-effort; if `curl` itself times out, treat as 0 (unreachable) and mark `appilix_down_timeout`.
