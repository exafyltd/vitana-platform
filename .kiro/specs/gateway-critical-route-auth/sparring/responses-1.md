# Responses — round 1

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Plan §4 now states the caller fix exactly. gatewayApiCall (orb-tools/developer-tools.ts:112-117) adds gatewayServiceAuthHeader() when the normalised path starts with /api/v1/worker/ (a caller's own Authorization wins), which covers vtid-lifecycle-tools.ts:364,428 and worker-orchestrator-tools.ts:86,135,174 without editing them; the event loop (:530) and self-healing-reconciler.ts:164 (found by the census; now in paths) add the header to their fetch. It is deliberately not a global default: gatewayApiCall has about 250 call sites and many reach routes behind requireServiceOrAdmin (e.g. self-healing-tools.ts:63), which would silently gain service authority. Tests: a worker path gets the header and reaches a gated route; a non-worker path and ../ or %2e%2e escapes do not.", "deferred_to": ""},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "GET /admin/embeddings/status (semantic-memory.ts:585) now also takes requireAdminAuth, with a test.", "deferred_to": ""},
  {"finding_id": "R1-F3", "disposition": "rejected", "rationale": "requireAdminAuth exists: it is exported by middleware/auth-supabase-jwt.ts:831 (requireAuth plus requireExafyAdmin) and already gates routes/llm.ts:520 (import at :24). Plan §4 now cites that export so no new middleware is written. requireAdminOnly in require-service-or-admin.ts:110 is the equivalent newer gate; the lane uses requireAdminAuth to match the existing admin routes of the memory area.", "deferred_to": ""}
]
```
