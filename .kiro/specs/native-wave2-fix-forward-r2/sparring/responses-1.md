# Responses to sparring round 1

Premises checked on vitana-v1 `origin/main`: `apps/mobile/parity/ledger.json:4-8` holds the `native_only` `/` entry
with the reason quoted by the finding, and `PUBLIC.LANDING` is at `:1841`.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "The plan already removes the entry (plan.md decision 6: 'the `/` entry leaves `native_only`'; requirements.md 5.3; tasks.md public-entry task 4), which is the finding's option (a). Premise confirmed: the entry's reason says signed out goes to /maxina and that PUBLIC.LANDING stays not_started, both false after the lane. tasks.md task 4 now says to delete the whole entry (not reword it) so a `native_only` `/` entry and a `native` PUBLIC.LANDING row never coexist. The 'if #1553 closed unmerged' fallback keeps the entry, as #1553 is merged this does not apply."
  }
]
```
