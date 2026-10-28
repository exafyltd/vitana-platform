# Summary: Command Hub Wiring Documentation

> Summary of the Command Hub wiring doc and related reports covering SSE connection management, operator chat, build governance, and reconnection failures.

## Content

### Documents Summarized

1. `raw/command-hub/COMMAND_HUB_WIRING.md` -- full wiring documentation
2. `raw/command-hub/COMMAND_HUB_RECONNECTION_FAILURE_REPORT.md` -- reconnection failure analysis
3. `raw/command-hub/BUILD.md` -- canonical source and build governance

### Wiring Documentation

The Command Hub connects to a single backend at `https://oasis-operator-86804897789.us-central1.run.app` serving both the Events API and Operator Chat API.

**Events API:**
- `GET /api/v1/events` -- paginated history (cursor, limit=50, hours=72) with filters for layer (CICDL/AICOR/AGENT/GATEWAY/OASIS), status, module, VTID
- `GET /api/v1/events/stream` -- SSE stream with JSON event payloads (id, ts, vtid, layer, module, kind, status, title, data, links)

**Operator Chat API:**
- `POST /api/v1/chat` -- send message with urgency, get reply with follow-ups
- `GET /api/v1/chat/thread?vtid=<vtid>` -- thread history by VTID

**State:** Zustand store with events, filters, streaming/paused status, active VTID, and chat threads. Filters and VTID selection persist in sessionStorage.

**SSE Hook (`useSSE.ts`):** Exponential backoff (1s -> 30s), polling fallback after 3 failures, connection registration/unregistration.

### Reconnection Failure Report

**Date:** 2025-11-01, Severity: Critical

The Command Hub could connect initially but failed to automatically reconnect, resulting in permanent OFFLINE state.

**Seven root causes identified:**

| # | Cause | Severity |
|---|-------|----------|
| 1 | React Strict Mode double mounting creates 60-80 duplicate connections | Critical |
| 2 | UI shows OFFLINE when reconnection succeeds (state desync) | High |
| 3 | Infinite retry without circuit breaker wastes resources | High |
| 4 | No backend health check before reconnection | Medium |
| 5 | EventSource API provides no error details | Medium |
| 6 | No automatic fallback to polling after repeated failures | High |
| 7 | No management UI for diagnosing 60-80 leaked connections | Critical |

**Failure sequence:** Connection opens -> backend/network interruption -> onerror fires -> backoff retries (1s, 2s, 4s, 8s, 16s) -> all fail -> backoff caps at 30s -> retries indefinitely with no user feedback -> user sees permanent OFFLINE.

**Implemented (Priority 1):** Connection Manager, React Strict Mode protection (`mountedRef`), SSE Connection Monitor UI.

**Required (Priority 2):** Circuit breaker pattern, pre-flight health check, Force Reconnect button, automatic polling fallback.

### Build Governance

Per `GOV-FRONTEND-CANONICAL-SOURCE-0001`:
- Canonical source: `services/gateway/src/frontend/command-hub/`
- Build output: `services/gateway/dist/frontend/command-hub/`
- Deploy: `npm run build` then `deploy-service.sh gateway`
- Forbidden: creating sibling directories, moving source, modifying Express static mounts

### QA Test Script

The wiring doc includes a 12-step QA script covering: initial load, real-time updates, chat, VTID threads, pause/resume, filters, smoke test, network resilience, SSE fallback, session persistence, accessibility, and event detail drawer.

## Related Pages

- [[command-hub-architecture]]
- [[command-hub]]
- [[sse-event-streaming]]
- [[summary-sse-diagnostic]]

## Sources

- `raw/command-hub/COMMAND_HUB_WIRING.md`
- `raw/command-hub/COMMAND_HUB_RECONNECTION_FAILURE_REPORT.md`
- `raw/command-hub/BUILD.md`

## Last Updated

2026-04-12
