# Sparring session 2, responses to round 1

Two minor findings about ledger row counts, no blockers. Accepted.

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Confirmed the connectors ?tab= variant rows against the ledger; the lane partition and per-lane file counts are reconciled to the actual ledger row count (settings/support-connectors). If the real count differs from 37 the partition in the lane docs is updated to match the ledger exactly — no invented rows.", "deferred_to": ""},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "The SETTINGS.SUPPORT_TICKETS tab is a pre-existing ledger gap, not introduced here. Documented in the support lane that the tickets tab is covered by the base /support native route file despite lacking its own parity row; a follow-up to add the row via parity-ledger --sync (needs the screen in screens.json) is noted as out of this lane's scope.", "deferred_to": "follow-up: SETTINGS.SUPPORT_TICKETS ledger row"}
]
```
