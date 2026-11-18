# Responses to sparring round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: request() throws badRequest with the raw path before it calls raw() and prepare() when opts.okStatuses is set, and toJSON() serialises that path. The same refusal now runs at the top of request(), before the okStatuses check, and test (e) covers it.",
    "deferred_to": null
  }
]
```
