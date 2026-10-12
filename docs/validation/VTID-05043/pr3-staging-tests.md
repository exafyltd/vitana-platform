# VTID-05043 PR3 — entries for `docs/validation/VTID-05043/staging-tests.json`

PR2 adds `staging-tests.json` for this VTID. To avoid an add/add conflict, PR3 lists its entries here;
when PR3 is rebased onto merged PR2, append these two objects to that file's `tests` array.

```json
[
  {
    "kind": "http",
    "target": "gateway",
    "name": "tenant-scoped read route still refuses an invalid caller",
    "method": "GET",
    "path": "/api/v1/memory/garden/entries",
    "rejected_probe": true,
    "expect_status": 401,
    "expect_content_type": "application/json",
    "reason": "GET with an invalid bearer; requireAuthWithTenant rejects before the membership check or any handler"
  },
  {
    "kind": "existing",
    "ref": "npx jest test/middleware/auth-supabase-jwt.test.ts test/routes/orb-livekit.test.ts",
    "cwd": "services/gateway",
    "reason": "the membership check on requireTenant and requireAuthWithTenant: member, non-member 403, exafy bypass, primary fallback, 503 fail-closed, log mode, 60 s positive cache, negatives not cached"
  }
]
```

No authenticated probe: STAGING-VERIFY sends only invalid credentials (rule 48), so "a member's own
tenant passes" is proven by Jest, not by a staging request.
