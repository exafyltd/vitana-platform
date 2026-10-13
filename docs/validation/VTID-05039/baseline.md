# VTID-05039 — onboarding baseline (before the coach does anything)

Plan v3 §3 item 4. Measured read-only on production on 2026-10-10 with `baseline.sql` (in this folder; re-run it later
with a new `as_of` to compare). Cohort: primary members who joined between 2026-08-11 and 2026-10-09, with registered
service/test accounts (`service_bot_accounts`, `notification_test_actors`) excluded.

| Measure | Value | Basis |
|---|---|---|
| Joiners (last 60 days) | **39** | all in tenant `2e7528b8-…` |
| Day-1 return | **5.1 %** (2 of 39) | any login or token refresh 24–48 h after joining |
| Return on days 2–7 | **17.6 %** (6 of 34) | any login or token refresh 48 h–7 days after joining; only members who joined ≥ 7 days ago |
| Cross-check: still active after day 2 | 23.5 % (8 of 34) | `auth.sessions` refreshed/updated ≥ 48 h after joining, no upper bound |
| Had at least one ORB voice session | **17.9 %** (7 of 39) | `oasis_events` `vtid.live.session.start` for the member |
| Median time to first ORB session | **0.0 h** | among those 7: the first session happens in the join session itself |
| Welcome DM reply rate | **2.6 %** (1 of 39) | a recipient of the joiner's automatic welcome DM wrote back within 7 days |

Caveats, recorded so the comparison stays honest:
- `auth.audit_log_entries` (data since 2025-08-30) and `auth.sessions` (since 2025-09-07) are Supabase-managed. Their retention is not ours. A member who keeps a long-lived session open may be under-counted, because a refresh is only logged when it happens.
- **ORB events only reach back to 2026-09-26.** `vtid.live.session.start` rows before that date are gone, so the ORB numbers cover roughly the last 14 days of the window. The ORB share is a lower bound.
- The welcome DM is sent *by the new member* to every other member, and is English-only. A reply means a veteran answered.
- Small numbers (39 people): one member moves a percentage by 2–3 points.
