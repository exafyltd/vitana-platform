# Live verification — 2026-09-24 (read-only, simulated JWT, rolled back)

Cohort before building: tenant 00000000-…, 66 members with a score in the last
30 days (service/test accounts excluded), 48 of them tied at 50.

| Member | Score | Result |
|---|---|---|
| mariia04 / dragan3 | 200 | show, Top 2% |
| stefan66 | 137 | show, Top 11% |
| jovana2 | 122 | show, Top 16% |
| anna61 | 114 | show, Top 23% |
| bojan28 | 52 | show, Top 28% |
| a member at 50 | 50 | show=false, reason no_one_below |
| unknown user | — | show=false, reason no_recent_score |
| anonymous caller | — | NULL |

Function applied live as migration `vtid_04498_index_standing` (additive,
read-only function).
