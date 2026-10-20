# Responses — round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct: a changed plan hash leaves existing.data null, so a count placed inside that block is skipped and the insert is unbounded. Change 3 now runs the cap check on every create, immediately before insertSession (plan-sparring-service.ts:288) and outside the if (existing.data) block, counting the producer's escalated partner_output_invalid sessions whatever their hash. A hard per-producer cap would block a plan forever, so the count uses a window: PARTNER_INVALID_CAP = 2 and PARTNER_INVALID_WINDOW_MS = 24 h, the same constants on both sides. CI records exhausted_at and allows retryInfra again only after the window, so the bound is 2 passes per producer per 24 h on both sides. New Jest cases: the plan hash changed in between (no existing row) is still capped, and sessions older than the window do not count."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Correct: GET /:id carries no flags. Change 3 now spells out all three gatewayClient.create paths. The direct response returns the flags from r.json. The waitFor path (:116) takes them from r.json before polling. The lost-response re-post (:119-121) takes them from again.json before calling waitFor. A missing flag is read as false only on the first create, where the gateway cannot have capped anything. New plan-spar.test.mjs cases: retry_exhausted delivered through the re-post path and through the waitFor path both stop the retry."
  }
]
```
