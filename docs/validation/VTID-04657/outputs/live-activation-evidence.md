# Live evidence (read-only, production Supabase, 2026-09-26)

Every `autopilot.recommendation.activated` event in the last 90 days (6 total)
and the executions of the activated finding:

| Activated | VTID | Finding | Executions created by the Activate click |
|---|---|---|---|
| 2026-09-25 18:37:52 | VTID-04570 | Autopilot route integration test missing | 0 (both rows predate the click, 2026-09-22, autoApproveTick) |
| 2026-09-25 18:37:37 | VTID-04569 | Approvals route integration test missing | 0 (all 5 rows predate the click, 2026-09-22) |
| 2026-09-25 18:37:30 | VTID-04568 | [FB-2026-02-000140] Profile media video upload fails | 0 (no execution row at all; plan v1 exists) |
| 2026-09-25 18:37:28 | VTID-04567 | [FB-2026-03-000139] … | 0 (no execution row; plan v1 exists) |
| 2026-09-25 18:37:26 | VTID-04566 | [FB-2026-05-000095] Stale profile information … | 0 (no execution row; plan v1 exists) |
| 2026-09-22 06:52:17 | VTID-04250 | CVE: package.json | 0 (all 5 rows predate the click, 2026-09-21) |

No `dev_autopilot.execution.bridged` or `dev_autopilot.execution.reaped`
event exists in the last 60 days: neither the Activate route nor the
activation reaper has created an execution in that window.

The activated rows carry `spec_snapshot.scanner = null`: the activate RPC
replaced the producer's snapshot (confirmed against the live function body,
md5 28457bc2eebf3146ae4842a16e872fd3 = the 2026-04-28 migration).
