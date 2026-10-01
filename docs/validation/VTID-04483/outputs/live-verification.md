# Live verification — 2026-09-24

Applied to the live project with `apply_migration` (function only, no table,
no data written). Checked inside a rolled-back transaction with the test
account's JWT claims:

| Caller → subject | shared | standing | pillars | activity |
|---|---|---|---|---|
| test account → itself | true | Top 15% of 67, community avg 72 | 5 × 25, no 7-day change yet | present, 0 days logged |
| test account → @dragan3 (no consent) | false | Top 2% of 66, avg 70 | null | null |
| no JWT | — | NULL returned | — | — |

Grants: `anon` execute = false, `authenticated` execute = true, no PUBLIC grant.

The cohort already exceeds the 20-member threshold (67 members scored in the
last 30 days), so comparisons appear as soon as the frontend flag is on.
