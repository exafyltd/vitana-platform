# Responses to sparring round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Checked against a local prototype of the change on 29b639da. test/services/orb-memory-bridge.test.ts has two fetchMemoryContextWithIdentity tests that assert legacy memory_items queries (tenant scoping and the all-empty case); both fail under the change. They are converted, not dropped: tenant scoping is asserted on the identity passed to recall() (exactly the given tenant_id/user_id, never DEV_IDENTITY's) plus 'no direct memory_items query', and the all-empty case on an empty recall. test/vtid-05147-effective-role-permitted.test.ts mocks fetchMemoryContextWithIdentity entirely (line 34) and passes unchanged. Both files are added to the lane paths; the test plan says how each is handled. Prototype: 73/73 across the three bridge test files.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Premise 4 and the Change section now say that only the five legacy-read fetchers are removed from orb-memory-bridge-repository.ts, and name the functions that stay (fetchOrbConversationItems, fetchRecentOrbUserTurnsRaw, insertMemoryItem, the *ByImportance/*ByOccurredAt fetchers, the rpc* helpers).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "The premises are re-pinned to 29b639da4bfcacce3200e2d1d08881c260c4e990. The cited line numbers were re-checked there (fetchMemoryContextWithIdentity :831, readMemoryContext :855, useRecall :887, read_path 'legacy' :1147, classifyDevCategory :1175) and are unchanged from bf5e0c12.",
    "deferred_to": ""
  }
]
```

Other plan changes in this round, found while prototyping:
- Premise 7: this session has no AWS credentials, so the 14-day production count is taken by the owner or a session with read-only AWS access. The lane is built and reviewed meanwhile; only its merge waits on the count.
- The dev-sandbox no-identity path (dev-sandbox only) reads `DEV_IDENTITY` through `recall()` instead of the legacy read.
- Staging tests: `/alive` plus the changed suites as `kind: existing`. The log-line check was dropped because STAGING-VERIFY has no CloudWatch reader.
