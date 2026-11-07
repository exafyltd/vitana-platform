# VTID-05556 — plan premise 7 / task D1: recall failures in production, last 14 days

Taken read-only by the owner on 2026-11-05 (CloudWatch `filter-log-events`, account 472838866351, eu-central-1,
log group `/vitana/gateway-awsdr`, window 336 h). Nothing was written.

| Count | Filter pattern | Result |
|---|---|---|
| ORB memory reads compared by the shadow (one per read) | `"[VTID-04784] recall-shadow"` | 392 |
| Reads served by the legacy read (recall not ok → fallback) | `"[VTID-04784] recall-shadow" "served=legacy"` | 1 |
| `recall()` broker not ok | `"[VTID-04452] orb recall unavailable"` | 0 |

Rate: at most 1 / 392 = 0.26% of reads fell back to the legacy read; 0 broker failures were logged. This is below the
plan's limit of about 0.5%, so the lane may merge. After this change that one read would have started with no memory
block instead of the legacy read.
