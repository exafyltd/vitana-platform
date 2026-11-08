# Responses to sparring round 1

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Verified: authentication is per route, not global. services/gateway/src/middleware/auth-supabase-jwt.ts sets req.identity inside the route-level middleware (lines 422, 453, 775, 859), and the global mount in services/gateway/src/index.ts:640 runs before it, so req.identity is undefined at mount time. The plan now fixes the mechanism: the middleware registers res.on('finish') and reads req.identity there, after the route chain has run, and records one (day, tenant_id, user_id, class) row only when it is set. It decodes no JWT. A request on a route with no auth records nothing, which matches 'records nothing without an identity'. Changed: plan.md decision 2 (Mechanism), tasks.md S1."},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "The response header is set synchronously with res.setHeader before next(), so it is present on every response including errors from downstream handlers; only the recording is deferred to finish. Changed: plan.md decision 2 (Mechanism), tasks.md S1."}
]
```
